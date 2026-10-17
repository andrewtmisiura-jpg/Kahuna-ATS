import { and, asc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { application, backgroundCheck, entryCode, groupSession, hireStint, opening, person, pipelineStage, type Milestone } from "@/db/schema";
import type { UserRole } from "@/server/auth/roles";
import type { Actor } from "../actor";
import { centralDate, daysBetween } from "../time";
import { LIST_SORTS, listStages, sessionLabel, visibleAiScore, type ListSort, type ProfileCheck, type ProfileStint, type StageOption } from "./queries";
import { isOpenCheck, transition, TransitionError } from "./transition";

// The kanban board (PLAN.md, Admin list: "Kanban: every drag carries the row's
// version; a conflicting move says who changed it and reloads; drags into Offer,
// Check, Hired or a closed outcome open the same dialogs as the list").
// Columns are the role's stages marked show_on_board and not archived, in sort
// order. Cards are submitted applications that are open or hired; started and
// closed applications are counts in the header, never cards.

export type BoardFilters = {
  openingId: string;
  onHold?: boolean;
  sessionId?: string | "none";
  entryCodeId?: string | "none";
  // Matched against first and last name only.
  search?: string;
  // "AI score, high to low" within each column, offered while the role shows scores.
  sort?: ListSort;
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const one = Array.isArray(value) ? value[0] : value;
  return one && one.trim() ? one.trim() : undefined;
}

// The board's URL is the filter, the same way the list's is: /admin/board?opening=...&hold=1&session=...&code=...&q=...&sort=...
export function parseBoardFilters(params: SearchParams, openingId: string): BoardFilters {
  const sort = first(params, "sort");
  return {
    openingId,
    onHold: first(params, "hold") === "1",
    sessionId: first(params, "session"),
    entryCodeId: first(params, "code"),
    search: first(params, "q"),
    sort: sort && (LIST_SORTS as readonly string[]).includes(sort) ? (sort as ListSort) : undefined,
  };
}

export function boardFilterParams(filters: BoardFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set("opening", filters.openingId);
  if (filters.onHold) params.set("hold", "1");
  if (filters.sessionId) params.set("session", filters.sessionId);
  if (filters.entryCodeId) params.set("code", filters.entryCodeId);
  if (filters.search) params.set("q", filters.search);
  if (filters.sort) params.set("sort", filters.sort);
  return params;
}

export function boardFiltersActive(filters: BoardFilters): boolean {
  return Boolean(filters.onHold || filters.sessionId || filters.entryCodeId || filters.search);
}

export type BoardStage = { id: string; key: string; name: string; milestone: Milestone | null; sortOrder: number };

export type BoardCard = {
  id: string;
  personId: string;
  firstName: string;
  lastName: string;
  stageId: string;
  status: "open" | "hired";
  // The version a drag sends back; a mismatch means someone else changed it first.
  eventSeq: number;
  submittedAt: Date;
  stageEnteredAt: Date;
  // Central calendar days since the card entered its stage; 0 on the day it moved.
  daysInStage: number;
  entryCode: string | null;
  entryCodeLabel: string | null;
  sessionLabel: string | null;
  onHold: boolean;
  unhandledTexts: number;
  // "returning" when the person has other applications or hire records; "not_rehire_eligible" when any other stint says so.
  returning: "none" | "returning" | "not_rehire_eligible";
  // Hired with a live hire record tagged Temporary.
  temporary: boolean;
  // The 1 to 100 AI score staff may see; null when there is none to show.
  aiScore: number | null;
};

export type BoardColumn = { stage: BoardStage; cards: BoardCard[] };

export type Board = {
  columns: BoardColumn[];
  // Every non-archived stage of the role, for the Move dialog.
  stages: StageOption[];
  counts: {
    // Started, not submitted, not closed: the drop-off count.
    started: number;
    closed: number;
    // Submitted and open or hired, but sitting in a stage the board does not show.
    offBoard: number;
  };
  // Background checks per card, for the Close dialog's FCRA panel. Empty for a Viewer.
  checks: Record<string, ProfileCheck[]>;
};

function nameSearch(search: string | undefined): SQL | undefined {
  const term = search?.trim();
  if (!term) return undefined;
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return or(
    ilike(person.firstName, pattern),
    ilike(person.lastName, pattern),
    ilike(sql`${person.firstName} || ' ' || ${person.lastName}`, pattern),
  );
}

// The filters shared by the cards and the header counts.
function filterWhere(filters: BoardFilters): SQL {
  const parts: (SQL | undefined)[] = [eq(application.openingId, filters.openingId), isNull(application.deletedAt)];
  if (filters.onHold) parts.push(eq(application.onHold, true));
  if (filters.sessionId) {
    parts.push(filters.sessionId === "none" ? isNull(application.attributedSessionId) : eq(application.attributedSessionId, filters.sessionId));
  }
  if (filters.entryCodeId) {
    parts.push(filters.entryCodeId === "none" ? isNull(application.entryCodeId) : eq(application.entryCodeId, filters.entryCodeId));
  }
  parts.push(nameSearch(filters.search));
  return and(...parts)!;
}

const notRehireEligible = sql<boolean>`exists (select 1 from hire_stint hs where hs.person_id = ${application.personId} and hs.voided_at is null and hs.rehire_eligible = false and (hs.application_id is null or hs.application_id <> ${application.id}))`;
const otherApplications = sql<boolean>`exists (select 1 from application a2 where a2.person_id = ${application.personId} and a2.id <> ${application.id} and a2.deleted_at is null)`;
const priorStints = sql<boolean>`exists (select 1 from hire_stint hs where hs.person_id = ${application.personId} and hs.voided_at is null and (hs.application_id is null or hs.application_id <> ${application.id}))`;
const unhandledTexts = sql<number>`(select count(*)::int from message m where m.application_id = ${application.id} and m.direction = 'inbound' and m.handled_at is null)`;
const temporaryHire = sql<boolean>`exists (select 1 from hire_stint hs where hs.application_id = ${application.id} and hs.voided_at is null and hs.is_temporary)`;

export async function loadBoard(db: Db, filters: BoardFilters, viewer: UserRole, now: Date = new Date()): Promise<Board> {
  const [openingRow] = await db.select({ roleId: opening.roleId }).from(opening).where(eq(opening.id, filters.openingId));
  const roleId = openingRow?.roleId ?? null;
  const where = filterWhere(filters);

  const [stages, boardStages, rows, [counts]] = await Promise.all([
    roleId ? listStages(db, roleId) : Promise.resolve([] as StageOption[]),
    roleId
      ? db
          .select({
            id: pipelineStage.id,
            key: pipelineStage.key,
            name: pipelineStage.name,
            milestone: pipelineStage.milestone,
            sortOrder: pipelineStage.sortOrder,
          })
          .from(pipelineStage)
          .where(and(eq(pipelineStage.roleId, roleId), eq(pipelineStage.showOnBoard, true), isNull(pipelineStage.archivedAt)))
          .orderBy(asc(pipelineStage.sortOrder))
      : Promise.resolve([] as BoardStage[]),
    db
      .select({
        id: application.id,
        personId: application.personId,
        firstName: person.firstName,
        lastName: person.lastName,
        stageId: application.currentStageId,
        status: application.status,
        eventSeq: application.eventSeq,
        submittedAt: application.submittedAt,
        stageEnteredAt: application.stageEnteredAt,
        entryCode: entryCode.code,
        entryCodeLabel: entryCode.label,
        sessionStartsAt: groupSession.startsAt,
        sessionLocation: groupSession.locationName,
        onHold: application.onHold,
        unhandledTexts,
        otherApplications,
        priorStints,
        notRehireEligible,
        temporary: temporaryHire,
        aiScore: visibleAiScore,
      })
      .from(application)
      .innerJoin(person, eq(person.id, application.personId))
      .leftJoin(entryCode, eq(entryCode.id, application.entryCodeId))
      .leftJoin(groupSession, eq(groupSession.id, application.attributedSessionId))
      .where(and(where, isNotNull(application.submittedAt), ne(application.status, "closed")))
      // Longest in the stage first; sorted by AI score, the highest first, then the cards
      // without a score to show, each by submitted date.
      .orderBy(
        ...(filters.sort === "ai_score"
          ? [sql`${visibleAiScore} desc nulls last`, asc(application.submittedAt), asc(application.id)]
          : [asc(application.stageEnteredAt), asc(application.submittedAt), asc(application.id)]),
      ),
    db
      .select({
        started: sql<number>`count(*) filter (where ${application.submittedAt} is null and ${application.status} <> 'closed')::int`,
        closed: sql<number>`count(*) filter (where ${application.status} = 'closed')::int`,
      })
      .from(application)
      .innerJoin(person, eq(person.id, application.personId))
      .where(where),
  ]);

  const today = centralDate(now);
  const columns: BoardColumn[] = boardStages.map((stage) => ({ stage, cards: [] }));
  const byStage = new Map(columns.map((column) => [column.stage.id, column]));
  let offBoard = 0;
  for (const row of rows) {
    const column = byStage.get(row.stageId);
    if (!column) {
      offBoard += 1;
      continue;
    }
    column.cards.push({
      id: row.id,
      personId: row.personId,
      firstName: row.firstName ?? "",
      lastName: row.lastName ?? "",
      stageId: row.stageId,
      status: row.status === "hired" ? "hired" : "open",
      eventSeq: row.eventSeq,
      submittedAt: row.submittedAt!,
      stageEnteredAt: row.stageEnteredAt,
      daysInStage: Math.max(0, daysBetween(centralDate(row.stageEnteredAt), today)),
      entryCode: row.entryCode,
      entryCodeLabel: row.entryCodeLabel,
      sessionLabel: row.sessionStartsAt && row.sessionLocation ? sessionLabel({ startsAt: row.sessionStartsAt, locationName: row.sessionLocation }) : null,
      onHold: row.onHold,
      unhandledTexts: row.unhandledTexts,
      returning: row.notRehireEligible ? "not_rehire_eligible" : row.otherApplications || row.priorStints ? "returning" : "none",
      temporary: row.status === "hired" && row.temporary,
      aiScore: row.aiScore,
    });
  }

  const cardIds = columns.flatMap((column) => column.cards.map((card) => card.id));
  const checks = viewer === "viewer" ? {} : await loadChecks(db, cardIds);

  return {
    columns,
    stages,
    counts: { started: counts?.started ?? 0, closed: counts?.closed ?? 0, offBoard },
    checks,
  };
}

async function loadChecks(db: Db, applicationIds: string[]): Promise<Record<string, ProfileCheck[]>> {
  if (applicationIds.length === 0) return {};
  const rows = await db
    .select()
    .from(backgroundCheck)
    .where(inArray(backgroundCheck.applicationId, applicationIds))
    .orderBy(asc(backgroundCheck.createdAt));
  const checks: Record<string, ProfileCheck[]> = {};
  for (const row of rows) (checks[row.applicationId] ??= []).push({ ...row, open: isOpenCheck(row) });
  return checks;
}

// ---------------------------------------------------------------------------
// Moves

// Stages a drop cannot move into directly: they need the Move dialog's details
// (offer, check type, hire record), the same rule the list's bulk move follows.
const DIALOG_MILESTONES: readonly Milestone[] = ["offered", "background_check", "hired"];

export type BoardMoveInput = {
  applicationId: string;
  expectedSeq: number;
  toStageId: string;
  actor: Actor;
  now?: Date;
};

export type BoardMoveResult = { applicationId: string; eventSeq: number; stageId: string; status: "open" | "hired" | "closed" };

// A drop into a plain stage. The card's version goes to transition(), which
// refuses it with StaleVersionError when someone else changed the application.
export async function moveBoardCard(db: Db, input: BoardMoveInput): Promise<BoardMoveResult> {
  const [stage] = await db.select({ milestone: pipelineStage.milestone }).from(pipelineStage).where(eq(pipelineStage.id, input.toStageId));
  if (!stage) throw new TransitionError("stage_not_found", "No such stage");
  if (stage.milestone && DIALOG_MILESTONES.includes(stage.milestone)) {
    throw new TransitionError("stage_not_allowed", "Offers, checks and Hired need the Move dialog, so each record is complete");
  }
  const result = await transition(db, {
    action: "move",
    applicationId: input.applicationId,
    actor: input.actor,
    expectedSeq: input.expectedSeq,
    toStageId: input.toStageId,
    now: input.now,
  });
  return {
    applicationId: result.application.id,
    eventSeq: result.application.eventSeq,
    stageId: result.application.currentStageId,
    status: result.application.status,
  };
}

// The hire record a drop into Hired just created, for the hire form.
export async function loadBoardStint(db: Db, stintId: string): Promise<ProfileStint | null> {
  const crewLabel = sql<string | null>`(select p.label from picklist_option p where p.id = ${hireStint.crewOptionId})`;
  const leaveReasonLabel = sql<string | null>`(select p.label from picklist_option p where p.id = ${hireStint.leaveReasonOptionId})`;
  const [row] = await db.select({ s: hireStint, crewLabel, leaveReasonLabel }).from(hireStint).where(eq(hireStint.id, stintId));
  if (!row) return null;
  return { ...row.s, crewLabel: row.crewLabel, leaveReasonLabel: row.leaveReasonLabel };
}
