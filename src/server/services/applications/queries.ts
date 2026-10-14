import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import {
  answer,
  application,
  applicationEvent,
  appUser,
  backgroundCheck,
  consentEvent,
  entryCode,
  formItem,
  formVersion,
  groupSession,
  hireStint,
  landingConflict,
  message,
  note,
  offer,
  opening,
  person,
  picklistOption,
  pipelineStage,
  questionVersion,
  role,
  sourceEnum,
  suppression,
  type Milestone,
  type QuestionOption,
} from "@/db/schema";
import type { UserRole } from "@/server/auth/roles";
import { countUnhandledInbound, unhandledInboundCountSql } from "../messaging/inbox";
import { addDays, centralInstant } from "../time";
import { stageBeforeHire, undoPreview, type UndoPreview } from "./corrections";
import { isOpenCheck } from "./transition";

// Read side of the staff review screens (PLAN.md, "What staff experience"):
// the list view with its counts, filters and search, and the profile loader.
// A Viewer gets a projection without contact details, message bodies, consent
// records, background checks or restricted notes (DATA_MODEL.md, Key invariants).

export const LIST_STATUSES = ["open", "hired", "closed", "started", "all"] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];
export const SOURCES = sourceEnum.enumValues;
export type Source = (typeof SOURCES)[number];

export const PAGE_SIZE = 50;

export type ListFilters = {
  openingId: string;
  stageId?: string;
  // Omitted: submitted applications of any status. Started rows appear only for "started" and "all".
  status?: ListStatus;
  source?: Source | "none";
  entryCodeId?: string | "none";
  sessionId?: string | "none";
  // Central calendar dates applied to started_at.
  from?: string;
  to?: string;
  onHold?: boolean;
  attention?: boolean;
  conflicts?: boolean;
  search?: string;
  page?: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const one = Array.isArray(value) ? value[0] : value;
  return one && one.trim() ? one.trim() : undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The list's URL is the filter: /admin?stage=...&status=... Unknown values are dropped.
export function parseListFilters(params: SearchParams, openingId: string): ListFilters {
  const status = first(params, "status");
  const source = first(params, "source");
  const from = first(params, "from");
  const to = first(params, "to");
  const page = Number(first(params, "page") ?? "1");
  return {
    openingId,
    stageId: first(params, "stage"),
    status: status && (LIST_STATUSES as readonly string[]).includes(status) ? (status as ListStatus) : undefined,
    source: source && (source === "none" || (SOURCES as readonly string[]).includes(source)) ? (source as Source | "none") : undefined,
    entryCodeId: first(params, "code"),
    sessionId: first(params, "session"),
    from: from && DATE.test(from) ? from : undefined,
    to: to && DATE.test(to) ? to : undefined,
    onHold: first(params, "hold") === "1",
    attention: first(params, "attention") === "1",
    conflicts: first(params, "conflicts") === "1",
    search: first(params, "q"),
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

// The same filters back into a query string, so profile links can carry the list.
export function listFilterParams(filters: ListFilters, extra: Record<string, string | undefined> = {}): URLSearchParams {
  const params = new URLSearchParams();
  params.set("opening", filters.openingId);
  if (filters.stageId) params.set("stage", filters.stageId);
  if (filters.status) params.set("status", filters.status);
  if (filters.source) params.set("source", filters.source);
  if (filters.entryCodeId) params.set("code", filters.entryCodeId);
  if (filters.sessionId) params.set("session", filters.sessionId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.onHold) params.set("hold", "1");
  if (filters.attention) params.set("attention", "1");
  if (filters.conflicts) params.set("conflicts", "1");
  if (filters.search) params.set("q", filters.search);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  return params;
}

// ---------------------------------------------------------------------------
// Openings and filter options

export type OpeningOption = {
  id: string;
  name: string;
  status: "draft" | "open" | "closed";
  roleId: string;
  roleName: string;
  roleKey: string;
  employerId: string;
};

export async function listOpenings(db: Db): Promise<OpeningOption[]> {
  const rows = await db
    .select({
      id: opening.id,
      name: opening.name,
      status: opening.status,
      roleId: opening.roleId,
      roleName: role.internalName,
      roleKey: role.key,
      employerId: role.employerId,
    })
    .from(opening)
    .innerJoin(role, eq(role.id, opening.roleId))
    .orderBy(asc(role.sortOrder), desc(opening.createdAt));
  return rows;
}

// The opening the list opens on: the requested one, else the first open one, else the newest.
export function defaultOpening(openings: OpeningOption[], requested?: string): OpeningOption | null {
  return openings.find((o) => o.id === requested) ?? openings.find((o) => o.status === "open") ?? openings[0] ?? null;
}

export type StageOption = { id: string; key: string; name: string; milestone: Milestone | null; sortOrder: number; isSystem: boolean };

export async function listStages(db: Db, roleId: string, options: { includeArchived?: boolean } = {}): Promise<StageOption[]> {
  return db
    .select({
      id: pipelineStage.id,
      key: pipelineStage.key,
      name: pipelineStage.name,
      milestone: pipelineStage.milestone,
      sortOrder: pipelineStage.sortOrder,
      isSystem: pipelineStage.isSystem,
    })
    .from(pipelineStage)
    .where(and(eq(pipelineStage.roleId, roleId), options.includeArchived ? undefined : isNull(pipelineStage.archivedAt)))
    .orderBy(asc(pipelineStage.sortOrder));
}

export type ListFilterOptions = {
  stages: StageOption[];
  entryCodes: { id: string; code: string; label: string }[];
  sessions: { id: string; label: string }[];
};

export async function listFilterOptions(db: Db, open: OpeningOption): Promise<ListFilterOptions> {
  const [stages, codes, sessions] = await Promise.all([
    listStages(db, open.roleId),
    db
      .select({ id: entryCode.id, code: entryCode.code, label: entryCode.label })
      .from(entryCode)
      .where(and(eq(entryCode.roleId, open.roleId), or(isNull(entryCode.openingId), eq(entryCode.openingId, open.id))))
      .orderBy(asc(entryCode.createdAt)),
    db
      .select({ id: groupSession.id, startsAt: groupSession.startsAt, locationName: groupSession.locationName })
      .from(groupSession)
      .where(and(eq(groupSession.openingId, open.id), isNull(groupSession.deletedAt)))
      .orderBy(desc(groupSession.startsAt)),
  ]);
  return {
    stages,
    entryCodes: codes,
    sessions: sessions.map((s) => ({ id: s.id, label: sessionLabel(s) })),
  };
}

export function sessionLabel(session: { startsAt: Date; locationName: string }): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" }).format(session.startsAt);
  return `${day} ${session.locationName}`;
}

// ---------------------------------------------------------------------------
// Counts and the attention strip

export type CountRow = { started: number; inProgress: number; submitted: number; submitRate: number | null };
export type CountsByCode = CountRow & { entryCodeId: string | null; code: string | null; label: string };
export type ListCounts = { total: CountRow; byEntryCode: CountsByCode[] };

const IN_PROGRESS_DAYS = 7;

// Started, in progress (not submitted, active in the last 7 days), submitted and
// the rate, for the opening within the date range; the other filters do not
// change the counts because they describe the cohort, not the rows on screen.
export async function listCounts(db: Db, filters: ListFilters, now: Date = new Date()): Promise<ListCounts> {
  const activeSince = new Date(now.getTime() - IN_PROGRESS_DAYS * 86_400_000);
  const rows = await db
    .select({
      entryCodeId: application.entryCodeId,
      code: entryCode.code,
      label: entryCode.label,
      started: sql<number>`count(*)::int`,
      submitted: sql<number>`count(*) filter (where ${application.submittedAt} is not null)::int`,
      inProgress: sql<number>`count(*) filter (where ${application.submittedAt} is null and ${application.lastActivityAt} >= ${activeSince.toISOString()}::timestamptz)::int`,
    })
    .from(application)
    .leftJoin(entryCode, eq(entryCode.id, application.entryCodeId))
    .where(and(eq(application.openingId, filters.openingId), isNull(application.deletedAt), dateRange(filters)))
    .groupBy(application.entryCodeId, entryCode.code, entryCode.label)
    .orderBy(desc(sql`count(*)`));

  const rate = (started: number, submitted: number) => (started > 0 ? submitted / started : null);
  const total = rows.reduce(
    (acc, row) => ({ started: acc.started + row.started, inProgress: acc.inProgress + row.inProgress, submitted: acc.submitted + row.submitted }),
    { started: 0, inProgress: 0, submitted: 0 },
  );
  return {
    total: { ...total, submitRate: rate(total.started, total.submitted) },
    byEntryCode: rows.map((row) => ({
      entryCodeId: row.entryCodeId,
      code: row.code,
      label: row.label ?? "No entry code",
      started: row.started,
      inProgress: row.inProgress,
      submitted: row.submitted,
      submitRate: rate(row.started, row.submitted),
    })),
  };
}

export type AttentionCounts = { unhandledTexts: number; openConflicts: number; notRehireEligible: number };

export async function attentionCounts(db: Db, openingId: string): Promise<AttentionCounts> {
  const [texts, [conflicts], [returning]] = await Promise.all([
    // Inbound texts wait for a person wherever they came from, so the badge counts
    // them all, with the inbox's own count (the same number the digest reports).
    countUnhandledInbound(db),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(landingConflict)
      .where(and(eq(landingConflict.openingId, openingId), isNull(landingConflict.resolvedAt))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(application)
      .where(and(eq(application.openingId, openingId), isNull(application.deletedAt), eq(application.status, "open"), notRehireEligibleSql())),
  ]);
  return { unhandledTexts: texts, openConflicts: conflicts?.count ?? 0, notRehireEligible: returning?.count ?? 0 };
}

// ---------------------------------------------------------------------------
// Rows

export type AttentionFlag = { prompt: string; value: string };

export type ListRow = {
  id: string;
  personId: string;
  firstName: string;
  lastName: string;
  // Null for a Viewer.
  mobile: string | null;
  email: string | null;
  stageId: string;
  stageName: string;
  milestone: Milestone | null;
  status: "open" | "hired" | "closed";
  closedOutcome: "disqualified" | "withdrew" | "not_selected" | null;
  closedReasonLabel: string | null;
  onHold: boolean;
  source: Source | null;
  entryCode: string | null;
  entryCodeLabel: string | null;
  sessionLabel: string | null;
  startedAt: Date;
  submittedAt: Date | null;
  stageEnteredAt: Date;
  eventSeq: number;
  // "returning" when the person has other applications or stints; "not_rehire_eligible" when a stint says so.
  returning: "none" | "returning" | "not_rehire_eligible";
  attention: AttentionFlag[];
  unhandledTexts: number;
  textsBlocked: boolean;
};

export type ListPage = { rows: ListRow[]; total: number; page: number; pageSize: number; pageCount: number };

function dateRange(filters: ListFilters): SQL | undefined {
  const parts: SQL[] = [];
  if (filters.from) parts.push(gte(application.startedAt, centralInstant(filters.from)));
  if (filters.to) parts.push(lt(application.startedAt, centralInstant(addDays(filters.to, 1))));
  return parts.length ? and(...parts) : undefined;
}

function notRehireEligibleSql(): SQL {
  return sql`exists (select 1 from hire_stint hs where hs.person_id = ${application.personId} and hs.voided_at is null and hs.rehire_eligible = false and (hs.application_id is null or hs.application_id <> ${application.id}))`;
}

// An answer whose value is in its form item's attention_values (DATA_MODEL.md, form_item).
const ATTENTION_MATCH = sql`exists (
  select 1 from answer a
  join form_item fi on fi.question_version_id = a.question_version_id and fi.form_version_id = ${application.formVersionId}
  where a.application_id = ${application.id} and fi.attention_values is not null and (
    (a.value_bool is not null and a.value_bool::text = any(fi.attention_values))
    or (a.value_options is not null and a.value_options && fi.attention_values)
    or (a.value_text is not null and a.value_text = any(fi.attention_values))
  )
)`;

const CONFLICT_MATCH = sql`exists (select 1 from landing_conflict lc where lc.resolved_at is null and ${application.personId} = any(lc.matched_person_ids))`;

function searchSql(search: string, role: UserRole): SQL | undefined {
  const term = search.trim();
  if (!term) return undefined;
  const pattern = `%${term.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const parts: SQL[] = [
    ilike(person.firstName, pattern),
    ilike(person.lastName, pattern),
    ilike(sql`${person.firstName} || ' ' || ${person.lastName}`, pattern),
  ];
  // Viewers see no contact details, so they search names only.
  if (role !== "viewer") {
    parts.push(ilike(person.email, pattern));
    const digits = term.replace(/\D/g, "");
    if (digits.length >= 3) parts.push(ilike(person.mobileE164, `%${digits}%`));
  }
  return or(...parts);
}

function listWhere(filters: ListFilters, role: UserRole): SQL {
  const parts: (SQL | undefined)[] = [eq(application.openingId, filters.openingId), isNull(application.deletedAt), dateRange(filters)];
  switch (filters.status) {
    case "started":
      parts.push(isNull(application.submittedAt));
      break;
    case "all":
      break;
    case "open":
      parts.push(eq(application.status, "open"), isNotNull(application.submittedAt));
      break;
    case "hired":
    case "closed":
      parts.push(eq(application.status, filters.status));
      break;
    default:
      parts.push(isNotNull(application.submittedAt));
  }
  if (filters.stageId) parts.push(eq(application.currentStageId, filters.stageId));
  if (filters.source) parts.push(filters.source === "none" ? isNull(application.source) : eq(application.source, filters.source));
  if (filters.entryCodeId) {
    parts.push(filters.entryCodeId === "none" ? isNull(application.entryCodeId) : eq(application.entryCodeId, filters.entryCodeId));
  }
  if (filters.sessionId) {
    parts.push(filters.sessionId === "none" ? isNull(application.attributedSessionId) : eq(application.attributedSessionId, filters.sessionId));
  }
  if (filters.onHold) parts.push(eq(application.onHold, true));
  if (filters.attention) parts.push(ATTENTION_MATCH);
  if (filters.conflicts) parts.push(CONFLICT_MATCH);
  if (filters.search) parts.push(searchSql(filters.search, role));
  return and(...parts)!;
}

// Newest first: by submitted time, then by start time for the unsubmitted.
const LIST_ORDER = [sql`${application.submittedAt} desc nulls last`, desc(application.startedAt), desc(application.id)];

export async function listApplications(db: Db, filters: ListFilters, role: UserRole): Promise<ListPage> {
  const where = listWhere(filters, role);
  const page = filters.page ?? 1;
  const [[counted], rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(application).innerJoin(person, eq(person.id, application.personId)).where(where),
    db
      .select({
        id: application.id,
        personId: application.personId,
        firstName: person.firstName,
        lastName: person.lastName,
        mobile: person.mobileE164,
        email: person.email,
        stageId: application.currentStageId,
        stageName: pipelineStage.name,
        milestone: pipelineStage.milestone,
        status: application.status,
        closedOutcome: application.closedOutcome,
        closedReasonLabel: picklistOption.label,
        onHold: application.onHold,
        source: application.source,
        entryCode: entryCode.code,
        entryCodeLabel: entryCode.label,
        sessionStartsAt: groupSession.startsAt,
        sessionLocation: groupSession.locationName,
        startedAt: application.startedAt,
        submittedAt: application.submittedAt,
        stageEnteredAt: application.stageEnteredAt,
        eventSeq: application.eventSeq,
        otherApplications: sql<boolean>`exists (select 1 from application a2 where a2.person_id = ${application.personId} and a2.id <> ${application.id} and a2.deleted_at is null)`,
        priorStints: sql<boolean>`exists (select 1 from hire_stint hs where hs.person_id = ${application.personId} and hs.voided_at is null and (hs.application_id is null or hs.application_id <> ${application.id}))`,
        notRehireEligible: notRehireEligibleSql(),
        // The texts the profile shows, counted with the inbox's rule.
        unhandledTexts: unhandledInboundCountSql(application.id, application.personId),
        textsBlocked: sql<boolean>`exists (select 1 from suppression s where s.channel = 'sms' and s.lifted_at is null and s.address = ${person.mobileE164})`,
      })
      .from(application)
      .innerJoin(person, eq(person.id, application.personId))
      .innerJoin(pipelineStage, eq(pipelineStage.id, application.currentStageId))
      .leftJoin(picklistOption, eq(picklistOption.id, application.closedReasonOptionId))
      .leftJoin(entryCode, eq(entryCode.id, application.entryCodeId))
      .leftJoin(groupSession, eq(groupSession.id, application.attributedSessionId))
      .where(where)
      .orderBy(...LIST_ORDER)
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
  ]);

  const attention = await attentionFlags(
    db,
    rows.map((row) => row.id),
  );
  const total = counted?.count ?? 0;
  return {
    rows: rows.map((row) => ({
      id: row.id,
      personId: row.personId,
      firstName: row.firstName ?? "",
      lastName: row.lastName ?? "",
      mobile: role === "viewer" ? null : row.mobile,
      email: role === "viewer" ? null : row.email,
      stageId: row.stageId,
      stageName: row.stageName,
      milestone: row.milestone,
      status: row.status,
      closedOutcome: row.closedOutcome,
      closedReasonLabel: row.closedReasonLabel,
      onHold: row.onHold,
      source: row.source,
      entryCode: row.entryCode,
      entryCodeLabel: row.entryCodeLabel,
      sessionLabel: row.sessionStartsAt && row.sessionLocation ? sessionLabel({ startsAt: row.sessionStartsAt, locationName: row.sessionLocation }) : null,
      startedAt: row.startedAt,
      submittedAt: row.submittedAt,
      stageEnteredAt: row.stageEnteredAt,
      eventSeq: row.eventSeq,
      returning: row.notRehireEligible ? "not_rehire_eligible" : row.otherApplications || row.priorStints ? "returning" : "none",
      attention: attention.get(row.id) ?? [],
      unhandledTexts: row.unhandledTexts,
      textsBlocked: role === "viewer" ? false : row.textsBlocked,
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

// Every id the filter matches, in list order, for next and previous on the profile.
export async function listApplicationIds(db: Db, filters: ListFilters, role: UserRole): Promise<string[]> {
  const rows = await db
    .select({ id: application.id })
    .from(application)
    .innerJoin(person, eq(person.id, application.personId))
    .where(listWhere(filters, role))
    .orderBy(...LIST_ORDER);
  return rows.map((row) => row.id);
}

export function neighbors(ids: string[], current: string): { previous: string | null; next: string | null } {
  const index = ids.indexOf(current);
  if (index < 0) return { previous: null, next: null };
  return { previous: ids[index - 1] ?? null, next: ids[index + 1] ?? null };
}

// ---------------------------------------------------------------------------
// Answers

type AnswerRow = typeof answer.$inferSelect;
type QuestionVersionRow = Pick<typeof questionVersion.$inferSelect, "type" | "options">;

// The answer as text: option labels for choices, Yes or No, the raw text or number.
export function formatAnswer(row: AnswerRow | null, version: QuestionVersionRow): string | null {
  if (!row) return null;
  switch (version.type) {
    case "yes_no":
      return row.valueBool === null ? null : row.valueBool ? "Yes" : "No";
    case "single_choice":
    case "multi_choice": {
      if (!row.valueOptions?.length) return null;
      const options = version.options ?? [];
      return row.valueOptions.map((key) => options.find((o: QuestionOption) => o.key === key)?.label ?? key).join(", ");
    }
    case "number":
      return row.valueNumber ?? null;
    case "date":
      return row.valueDate ?? null;
    default:
      return row.valueText ?? null;
  }
}

function answerMatchesAttention(row: AnswerRow, attentionValues: string[] | null): boolean {
  if (!attentionValues?.length) return false;
  if (row.valueBool !== null && attentionValues.includes(String(row.valueBool))) return true;
  if (row.valueOptions?.some((key) => attentionValues.includes(key))) return true;
  if (row.valueText !== null && attentionValues.includes(row.valueText)) return true;
  return false;
}

async function attentionFlags(db: Db, applicationIds: string[]): Promise<Map<string, AttentionFlag[]>> {
  const flags = new Map<string, AttentionFlag[]>();
  if (applicationIds.length === 0) return flags;
  const rows = await db
    .select({ answer, prompt: questionVersion.prompt, type: questionVersion.type, options: questionVersion.options, attentionValues: formItem.attentionValues })
    .from(answer)
    .innerJoin(application, eq(application.id, answer.applicationId))
    .innerJoin(formItem, and(eq(formItem.questionVersionId, answer.questionVersionId), eq(formItem.formVersionId, application.formVersionId)))
    .innerJoin(questionVersion, eq(questionVersion.id, answer.questionVersionId))
    .where(and(inArray(answer.applicationId, applicationIds), isNotNull(formItem.attentionValues)));
  for (const row of rows) {
    if (!answerMatchesAttention(row.answer, row.attentionValues)) continue;
    const list = flags.get(row.answer.applicationId) ?? [];
    list.push({ prompt: row.prompt, value: formatAnswer(row.answer, row) ?? "" });
    flags.set(row.answer.applicationId, list);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Profile

export type ProfileAnswer = {
  questionKey: string;
  prompt: string;
  version: number;
  sectionKey: string;
  value: string | null;
  attention: boolean;
};

export type ProfileEvent = {
  id: string;
  seq: number;
  kind: typeof applicationEvent.$inferSelect.kind;
  fromStage: string | null;
  toStage: string | null;
  toStatus: "open" | "hired" | "closed" | null;
  closedOutcome: "disqualified" | "withdrew" | "not_selected" | null;
  reasonLabel: string | null;
  note: string | null;
  actorType: "staff" | "applicant" | "system";
  actorName: string | null;
  occurredAt: Date;
  recordedAt: Date;
  voided: boolean;
  voidsEventId: string | null;
  notReportBased: boolean;
};

export type ProfileNote = {
  id: string;
  body: string | null;
  isRestricted: boolean;
  authorId: string;
  authorName: string;
  createdAt: Date;
  // Set when this note replaced an earlier one through an edit (audit row note.edit).
  replacesNoteId: string | null;
  replacedBody: string | null;
};

export type ProfileMessage = {
  id: string;
  direction: "outbound" | "inbound";
  channel: "sms" | "email";
  status: typeof message.$inferSelect.status;
  purpose: typeof message.$inferSelect.purpose;
  subject: string | null;
  // Null for a Viewer; application links show as "[application link]".
  body: string | null;
  address: string | null;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  sendAfter: Date | null;
  errorCode: string | null;
  handledAt: Date | null;
  handledByName: string | null;
  triggeredByType: "staff" | "applicant" | "system";
  triggeredByName: string | null;
};

export type ProfileConsent = {
  id: string;
  action: typeof consentEvent.$inferSelect.action;
  method: typeof consentEvent.$inferSelect.method;
  address: string;
  checkboxValue: boolean | null;
  occurredAt: Date;
  recordedByName: string | null;
};

export type ProfileOffer = typeof offer.$inferSelect & { offeredByName: string | null };
export type ProfileCheck = typeof backgroundCheck.$inferSelect & { open: boolean };
export type ProfileStint = typeof hireStint.$inferSelect & { crewLabel: string | null; leaveReasonLabel: string | null };

export type ReturningApplication = {
  id: string;
  openingName: string;
  stageName: string;
  status: "open" | "hired" | "closed";
  closedOutcome: "disqualified" | "withdrew" | "not_selected" | null;
  startedAt: Date;
};

export type ReturningStint = {
  id: string;
  applicationId: string | null;
  openingName: string | null;
  roleName: string;
  outcome: typeof hireStint.$inferSelect.outcome;
  isTemporary: boolean;
  leaveReasonLabel: string | null;
  rehireEligible: boolean | null;
  rating30: number | null;
  rating90: number | null;
  seasonEndRating: typeof hireStint.$inferSelect.seasonEndRating;
  startOn: string | null;
  endOn: string | null;
};

export type PicklistItem = { id: string; key: string; label: string; requiresNote: boolean; fcraAdverse: boolean; defaultSeparation: "voluntary" | "involuntary" | null };

// A group session of the application's opening, for the profile's session picker.
export type SessionChoice = {
  id: string;
  label: string;
  startsAt: Date;
  locationName: string;
  status: "scheduled" | "held" | "canceled";
};

export type ProfileConflict = {
  id: string;
  typedName: string;
  typedMobile: string | null;
  typedEmail: string | null;
  createdAt: Date;
};

export type Profile = {
  role: UserRole;
  application: {
    id: string;
    personId: string;
    openingId: string;
    openingName: string;
    roleId: string;
    roleKey: string;
    roleTitle: string;
    employerId: string;
    status: "open" | "hired" | "closed";
    closedOutcome: "disqualified" | "withdrew" | "not_selected" | null;
    closedReasonLabel: string | null;
    stageId: string;
    stageName: string;
    milestone: Milestone | null;
    stageEnteredAt: Date;
    onHold: boolean;
    eventSeq: number;
    origin: "landing" | "staff_created" | "imported";
    startedAt: Date;
    submittedAt: Date | null;
    lastActivityAt: Date;
    source: Source | null;
    sourceDetail: string | null;
    entryCode: string | null;
    entryCodeLabel: string | null;
    entryChannel: typeof application.$inferSelect.entryChannel;
    sessionLabel: string | null;
    // The attributed group session, linked from the profile.
    session: { id: string; startsAt: Date; locationName: string; status: "scheduled" | "held" | "canceled" } | null;
    scannedSessionId: string | null;
    attributionMethod: typeof application.$inferSelect.attributionMethod;
    indeedAppliedOn: string | null;
    formVersion: number;
    excludeFromAnalysis: boolean;
  };
  person: {
    id: string;
    firstName: string;
    lastName: string;
    mobile: string | null;
    email: string | null;
    sharedMobile: boolean;
    doNotContact: boolean;
  };
  // Null for a Viewer.
  texting: { optedIn: boolean; suppression: { reason: typeof suppression.$inferSelect.reason; createdAt: Date } | null } | null;
  conflicts: ProfileConflict[];
  returning: { applications: ReturningApplication[]; stints: ReturningStint[]; notRehireEligible: boolean };
  sections: { key: string; title: string }[];
  answers: ProfileAnswer[];
  events: ProfileEvent[];
  notes: ProfileNote[];
  messages: ProfileMessage[];
  consents: ProfileConsent[];
  offers: ProfileOffer[];
  checks: ProfileCheck[];
  stint: ProfileStint | null;
  voidedStints: ProfileStint[];
  stages: StageOption[];
  // Unhandled inbound texts among the messages shown (the inbox's rule).
  unhandledTexts: number;
  // The change "Undo last change" would void, named in its confirmation.
  undo: UndoPreview | null;
  // Where "Rescind hire" puts the application back by default; null unless hired.
  rescindStageId: string | null;
  // The opening's group sessions, for setting the attributed session. Empty for a Viewer.
  sessions: SessionChoice[];
  picklists: {
    disqualify: PicklistItem[];
    withdraw: PicklistItem[];
    notSelected: PicklistItem[];
    crews: PicklistItem[];
    leaveReasons: PicklistItem[];
  };
};

export async function loadProfile(db: Db, applicationId: string, viewer: UserRole): Promise<Profile | null> {
  const [head] = await db
    .select({
      app: application,
      who: person,
      openingName: opening.name,
      roleKey: role.key,
      roleTitle: role.title,
      employerId: role.employerId,
      stageName: pipelineStage.name,
      milestone: pipelineStage.milestone,
      closedReasonLabel: picklistOption.label,
      entryCode: entryCode.code,
      entryCodeLabel: entryCode.label,
      sessionId: groupSession.id,
      sessionStartsAt: groupSession.startsAt,
      sessionLocation: groupSession.locationName,
      sessionStatus: groupSession.status,
      formVersionNumber: formVersion.version,
      sections: formVersion.sections,
    })
    .from(application)
    .innerJoin(person, eq(person.id, application.personId))
    .innerJoin(opening, eq(opening.id, application.openingId))
    .innerJoin(role, eq(role.id, application.roleId))
    .innerJoin(pipelineStage, eq(pipelineStage.id, application.currentStageId))
    .innerJoin(formVersion, eq(formVersion.id, application.formVersionId))
    .leftJoin(picklistOption, eq(picklistOption.id, application.closedReasonOptionId))
    .leftJoin(entryCode, eq(entryCode.id, application.entryCodeId))
    .leftJoin(groupSession, eq(groupSession.id, application.attributedSessionId))
    .where(and(eq(application.id, applicationId), isNull(application.deletedAt)));
  if (!head) return null;
  const { app, who } = head;
  const staff = viewer !== "viewer";

  const [answers, eventLog, notes, messages, consents, offers, checks, stints, returningApps, returningStints, texting, conflicts, stages, picklists, unhandledTexts, sessions] =
    await Promise.all([
      loadAnswers(db, app.id, app.formVersionId),
      loadEvents(db, app.id),
      loadNotes(db, app.id, viewer),
      loadMessages(db, app.id, who.id, staff),
      staff ? loadConsents(db, who.id) : Promise.resolve([]),
      loadOffers(db, app.id),
      staff ? loadChecks(db, app.id) : Promise.resolve([]),
      loadStints(db, app.id),
      loadReturningApplications(db, who.id, app.id),
      loadReturningStints(db, who.id, app.id),
      staff ? loadTexting(db, who.mobileE164, head.employerId) : Promise.resolve(null),
      staff ? loadConflicts(db, who.id) : Promise.resolve([]),
      listStages(db, app.roleId),
      loadPicklists(db, head.employerId, app.roleId),
      countUnhandledInbound(db, { applicationId: app.id, personId: who.id }),
      staff ? loadSessionChoices(db, app.openingId) : Promise.resolve([]),
    ]);

  return {
    role: viewer,
    application: {
      id: app.id,
      personId: app.personId,
      openingId: app.openingId,
      openingName: head.openingName,
      roleId: app.roleId,
      roleKey: head.roleKey,
      roleTitle: head.roleTitle,
      employerId: head.employerId,
      status: app.status,
      closedOutcome: app.closedOutcome,
      closedReasonLabel: head.closedReasonLabel,
      stageId: app.currentStageId,
      stageName: head.stageName,
      milestone: head.milestone,
      stageEnteredAt: app.stageEnteredAt,
      onHold: app.onHold,
      eventSeq: app.eventSeq,
      origin: app.origin,
      startedAt: app.startedAt,
      submittedAt: app.submittedAt,
      lastActivityAt: app.lastActivityAt,
      source: app.source,
      sourceDetail: app.sourceDetail,
      entryCode: head.entryCode,
      entryCodeLabel: head.entryCodeLabel,
      entryChannel: app.entryChannel,
      sessionLabel:
        head.sessionStartsAt && head.sessionLocation ? sessionLabel({ startsAt: head.sessionStartsAt, locationName: head.sessionLocation }) : null,
      session:
        head.sessionId && head.sessionStartsAt && head.sessionLocation && head.sessionStatus
          ? { id: head.sessionId, startsAt: head.sessionStartsAt, locationName: head.sessionLocation, status: head.sessionStatus }
          : null,
      scannedSessionId: app.scannedSessionId,
      attributionMethod: app.attributionMethod,
      indeedAppliedOn: app.indeedAppliedOn,
      formVersion: head.formVersionNumber,
      excludeFromAnalysis: app.excludeFromAnalysis,
    },
    person: {
      id: who.id,
      firstName: who.firstName ?? "",
      lastName: who.lastName ?? "",
      mobile: staff ? who.mobileE164 : null,
      email: staff ? who.email : null,
      sharedMobile: who.sharedMobile,
      doNotContact: who.doNotContact,
    },
    texting,
    conflicts,
    returning: {
      applications: returningApps,
      stints: returningStints,
      notRehireEligible: returningStints.some((s) => s.rehireEligible === false),
    },
    sections: head.sections.map((s) => ({ key: s.key, title: s.title })),
    answers,
    events: eventLog.events,
    notes,
    messages,
    consents,
    offers,
    checks,
    stint: stints.find((s) => !s.voidedAt) ?? null,
    voidedStints: stints.filter((s) => Boolean(s.voidedAt)),
    stages,
    unhandledTexts,
    undo: eventLog.undo,
    rescindStageId: app.status === "hired" ? stageBeforeHire(eventLog.rows, stages) : null,
    sessions,
    picklists,
  };
}

async function loadSessionChoices(db: Db, openingId: string): Promise<SessionChoice[]> {
  const rows = await db
    .select({ id: groupSession.id, startsAt: groupSession.startsAt, locationName: groupSession.locationName, status: groupSession.status })
    .from(groupSession)
    .where(and(eq(groupSession.openingId, openingId), isNull(groupSession.deletedAt)))
    .orderBy(desc(groupSession.startsAt));
  return rows.map((row) => ({ ...row, label: sessionLabel(row) }));
}

async function loadAnswers(db: Db, applicationId: string, formVersionId: string): Promise<ProfileAnswer[]> {
  const rows = await db
    .select({
      item: formItem,
      version: questionVersion,
      questionKey: sql<string>`(select q.key from question q where q.id = ${questionVersion.questionId})`,
      answer,
    })
    .from(formItem)
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .leftJoin(answer, and(eq(answer.questionVersionId, formItem.questionVersionId), eq(answer.applicationId, applicationId)))
    .where(eq(formItem.formVersionId, formVersionId))
    .orderBy(asc(formItem.sortOrder));
  return rows.map((row) => ({
    questionKey: row.questionKey,
    prompt: row.version.prompt,
    version: row.version.version,
    sectionKey: row.item.sectionKey,
    value: formatAnswer(row.answer, row.version),
    attention: row.answer ? answerMatchesAttention(row.answer, row.item.attentionValues) : false,
  }));
}

async function loadEvents(
  db: Db,
  applicationId: string,
): Promise<{ events: ProfileEvent[]; undo: UndoPreview | null; rows: (typeof applicationEvent.$inferSelect)[] }> {
  const fromStage = sql<string | null>`(select s.name from pipeline_stage s where s.id = ${applicationEvent.fromStageId})`;
  const toStage = sql<string | null>`(select s.name from pipeline_stage s where s.id = ${applicationEvent.toStageId})`;
  const rows = await db
    .select({
      event: applicationEvent,
      fromStage,
      toStage,
      reasonLabel: picklistOption.label,
      actorName: appUser.name,
      actorEmail: appUser.email,
    })
    .from(applicationEvent)
    .leftJoin(picklistOption, eq(picklistOption.id, applicationEvent.reasonOptionId))
    .leftJoin(appUser, eq(appUser.id, applicationEvent.actorUserId))
    .where(eq(applicationEvent.applicationId, applicationId))
    .orderBy(asc(applicationEvent.seq));
  const voided = new Set(rows.filter((r) => r.event.kind === "event_voided" && r.event.voidsEventId).map((r) => r.event.voidsEventId!));
  const undo = undoPreview(
    rows.map((row) => ({
      ...row.event,
      fromStage: row.fromStage,
      toStage: row.toStage,
      reasonLabel: row.reasonLabel,
      actorName: row.actorName ?? row.actorEmail ?? null,
    })),
  );
  const events = rows.map((row) => ({
    id: row.event.id,
    seq: row.event.seq,
    kind: row.event.kind,
    fromStage: row.fromStage,
    toStage: row.toStage,
    toStatus: row.event.toStatus,
    closedOutcome: row.event.closedOutcome,
    reasonLabel: row.reasonLabel,
    note: row.event.note,
    actorType: row.event.actorType,
    actorName: row.actorName ?? row.actorEmail ?? null,
    occurredAt: row.event.occurredAt,
    recordedAt: row.event.recordedAt,
    voided: voided.has(row.event.id),
    voidsEventId: row.event.voidsEventId,
    notReportBased: Boolean(row.event.metadata?.not_report_based),
  }));
  return { events, undo, rows: rows.map((row) => row.event) };
}

// Notes an edit replaced are soft-deleted and linked to their replacement by a
// note.edit audit row (DATA_MODEL.md: no revision table). Deleted notes stay out
// of the list; the replacement shows the earlier wording.
async function loadNotes(db: Db, applicationId: string, viewer: UserRole): Promise<ProfileNote[]> {
  const rows = await db
    .select({ note, authorName: appUser.name, authorEmail: appUser.email })
    .from(note)
    .innerJoin(appUser, eq(appUser.id, note.authorUserId))
    .where(and(eq(note.applicationId, applicationId), viewer === "viewer" ? eq(note.isRestricted, false) : undefined))
    .orderBy(desc(note.createdAt));
  const byId = new Map(rows.map((row) => [row.note.id, row.note]));
  const links = await db.execute<{ entity_id: string; replaces: string }>(sql`
    select entity_id, changes->>'replaces_note_id' as replaces
    from audit_log where action = 'note.edit' and application_id = ${applicationId}`);
  const replaces = new Map(links.map((row) => [row.entity_id, row.replaces]));
  return rows
    .filter((row) => !row.note.deletedAt)
    .map((row) => {
      const replacedId = replaces.get(row.note.id) ?? null;
      return {
        id: row.note.id,
        body: row.note.body,
        isRestricted: row.note.isRestricted,
        authorId: row.note.authorUserId,
        authorName: row.authorName ?? row.authorEmail,
        createdAt: row.note.createdAt,
        replacesNoteId: replacedId,
        replacedBody: replacedId ? (byId.get(replacedId)?.body ?? null) : null,
      };
    });
}

const LINK_PLACEHOLDER = /\{link(?::[0-9a-f-]{36})?\}/g;

async function loadMessages(db: Db, applicationId: string, personId: string, staff: boolean): Promise<ProfileMessage[]> {
  const handledBy = sql<string | null>`(select coalesce(u.name, u.email) from app_user u where u.id = ${message.handledBy})`;
  const triggeredBy = sql<string | null>`(select coalesce(u.name, u.email) from app_user u where u.id = ${message.triggeredByUserId})`;
  const rows = await db
    .select({ m: message, handledByName: handledBy, triggeredByName: triggeredBy })
    .from(message)
    .where(or(eq(message.applicationId, applicationId), and(eq(message.personId, personId), isNull(message.applicationId))))
    .orderBy(asc(message.createdAt));
  return rows.map(({ m, handledByName, triggeredByName }) => ({
    id: m.id,
    direction: m.direction,
    channel: m.channel,
    status: m.status,
    purpose: m.purpose,
    subject: staff ? m.subject : null,
    body: staff ? (m.body ?? "").replace(LINK_PLACEHOLDER, "[application link]") : null,
    address: staff ? (m.direction === "inbound" ? m.fromAddress : m.toAddress) : null,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    failedAt: m.failedAt,
    sendAfter: m.sendAfter,
    errorCode: m.errorCode,
    handledAt: m.handledAt,
    handledByName,
    triggeredByType: m.triggeredByType,
    triggeredByName,
  }));
}

async function loadConsents(db: Db, personId: string): Promise<ProfileConsent[]> {
  const rows = await db
    .select({ c: consentEvent, recordedByName: appUser.name, recordedByEmail: appUser.email })
    .from(consentEvent)
    .leftJoin(appUser, eq(appUser.id, consentEvent.recordedBy))
    .where(eq(consentEvent.personId, personId))
    .orderBy(desc(consentEvent.occurredAt));
  return rows.map(({ c, recordedByName, recordedByEmail }) => ({
    id: c.id,
    action: c.action,
    method: c.method,
    address: c.address,
    checkboxValue: c.checkboxValue,
    occurredAt: c.occurredAt,
    recordedByName: recordedByName ?? recordedByEmail ?? null,
  }));
}

async function loadOffers(db: Db, applicationId: string): Promise<ProfileOffer[]> {
  const rows = await db
    .select({ o: offer, offeredByName: appUser.name, offeredByEmail: appUser.email })
    .from(offer)
    .leftJoin(appUser, eq(appUser.id, offer.offeredBy))
    .where(and(eq(offer.applicationId, applicationId), isNull(offer.deletedAt)))
    .orderBy(desc(offer.offeredOn), desc(offer.createdAt));
  return rows.map(({ o, offeredByName, offeredByEmail }) => ({ ...o, offeredByName: offeredByName ?? offeredByEmail ?? null }));
}

async function loadChecks(db: Db, applicationId: string): Promise<ProfileCheck[]> {
  const rows = await db.select().from(backgroundCheck).where(eq(backgroundCheck.applicationId, applicationId)).orderBy(desc(backgroundCheck.createdAt));
  return rows.map((row) => ({ ...row, open: isOpenCheck(row) }));
}

async function loadStints(db: Db, applicationId: string): Promise<ProfileStint[]> {
  const crewLabel = sql<string | null>`(select p.label from picklist_option p where p.id = ${hireStint.crewOptionId})`;
  const leaveReasonLabel = sql<string | null>`(select p.label from picklist_option p where p.id = ${hireStint.leaveReasonOptionId})`;
  const rows = await db
    .select({ s: hireStint, crewLabel, leaveReasonLabel })
    .from(hireStint)
    .where(eq(hireStint.applicationId, applicationId))
    .orderBy(desc(hireStint.createdAt));
  return rows.map(({ s, crewLabel: crew, leaveReasonLabel: leave }) => ({ ...s, crewLabel: crew, leaveReasonLabel: leave }));
}

async function loadReturningApplications(db: Db, personId: string, applicationId: string): Promise<ReturningApplication[]> {
  const rows = await db
    .select({
      id: application.id,
      openingName: opening.name,
      stageName: pipelineStage.name,
      status: application.status,
      closedOutcome: application.closedOutcome,
      startedAt: application.startedAt,
    })
    .from(application)
    .innerJoin(opening, eq(opening.id, application.openingId))
    .innerJoin(pipelineStage, eq(pipelineStage.id, application.currentStageId))
    .where(and(eq(application.personId, personId), isNull(application.deletedAt), sql`${application.id} <> ${applicationId}`))
    .orderBy(desc(application.startedAt));
  return rows;
}

async function loadReturningStints(db: Db, personId: string, applicationId: string): Promise<ReturningStint[]> {
  const leaveReasonLabel = sql<string | null>`(select p.label from picklist_option p where p.id = ${hireStint.leaveReasonOptionId})`;
  const rows = await db
    .select({ s: hireStint, openingName: opening.name, roleName: role.internalName, leaveReasonLabel })
    .from(hireStint)
    .innerJoin(role, eq(role.id, hireStint.roleId))
    .leftJoin(opening, eq(opening.id, hireStint.openingId))
    .where(
      and(
        eq(hireStint.personId, personId),
        isNull(hireStint.voidedAt),
        or(isNull(hireStint.applicationId), sql`${hireStint.applicationId} <> ${applicationId}`),
      ),
    )
    .orderBy(desc(hireStint.createdAt));
  return rows.map(({ s, openingName, roleName, leaveReasonLabel: leave }) => ({
    id: s.id,
    applicationId: s.applicationId,
    openingName,
    roleName,
    outcome: s.outcome,
    isTemporary: s.isTemporary,
    leaveReasonLabel: leave,
    rehireEligible: s.rehireEligible,
    rating30: s.rating30,
    rating90: s.rating90,
    seasonEndRating: s.seasonEndRating,
    startOn: s.startOn,
    endOn: s.endOn,
  }));
}

async function loadTexting(db: Db, mobile: string | null, employerId: string): Promise<Profile["texting"]> {
  if (!mobile) return { optedIn: false, suppression: null };
  const [[consent], [live]] = await Promise.all([
    db
      .select({ action: consentEvent.action })
      .from(consentEvent)
      .where(and(eq(consentEvent.address, mobile), eq(consentEvent.employerId, employerId), eq(consentEvent.channel, "sms")))
      .orderBy(desc(consentEvent.occurredAt), desc(consentEvent.createdAt))
      .limit(1),
    db
      .select({ reason: suppression.reason, createdAt: suppression.createdAt })
      .from(suppression)
      .where(and(eq(suppression.channel, "sms"), eq(suppression.address, mobile), isNull(suppression.liftedAt)))
      .limit(1),
  ]);
  return {
    optedIn: consent?.action === "opt_in" || consent?.action === "opt_in_keyword",
    suppression: live ?? null,
  };
}

async function loadConflicts(db: Db, personId: string): Promise<ProfileConflict[]> {
  const rows = await db
    .select()
    .from(landingConflict)
    .where(and(isNull(landingConflict.resolvedAt), sql`${personId}::uuid = any(${landingConflict.matchedPersonIds})`))
    .orderBy(desc(landingConflict.createdAt));
  return rows.map((row) => ({
    id: row.id,
    typedName: [row.typedFirstName, row.typedLastName].filter(Boolean).join(" "),
    typedMobile: row.typedMobileE164,
    typedEmail: row.typedEmail,
    createdAt: row.createdAt,
  }));
}

// Options for a role: rows matching the role, or the employer with null role, or null employer, not archived.
export async function loadPicklists(db: Db, employerId: string, roleId: string): Promise<Profile["picklists"]> {
  const rows = await db
    .select()
    .from(picklistOption)
    .where(
      and(
        isNull(picklistOption.archivedAt),
        or(isNull(picklistOption.employerId), eq(picklistOption.employerId, employerId)),
        or(isNull(picklistOption.roleId), eq(picklistOption.roleId, roleId)),
      ),
    )
    .orderBy(asc(picklistOption.sortOrder));
  const items = (listKey: (typeof picklistOption.$inferSelect)["listKey"]): PicklistItem[] =>
    rows
      .filter((row) => row.listKey === listKey)
      .map((row) => ({
        id: row.id,
        key: row.key,
        label: row.label,
        requiresNote: row.requiresNote,
        fcraAdverse: row.fcraAdverse,
        defaultSeparation: row.defaultSeparation,
      }));
  return {
    disqualify: items("disqualify_reason"),
    withdraw: items("withdraw_reason"),
    notSelected: items("not_selected_reason"),
    crews: items("crew"),
    leaveReasons: items("leave_reason"),
  };
}
