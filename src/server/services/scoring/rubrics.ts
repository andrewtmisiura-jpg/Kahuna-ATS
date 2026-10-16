import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import {
  aiScore,
  application,
  appUser,
  employer,
  formItem,
  formVersion,
  person,
  picklistOption,
  pipelineStage,
  question,
  questionVersion,
  reviewDecision,
  role,
  rubric,
  rubricCriterion,
  rubricVersion,
  rubricVersionCriterion,
  type AiScoreStatus,
  type QuestionType,
  type ReviewDecisionValue,
  type RubricFlag,
  type ScoringMode,
} from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "../actor";
import { diffChanges, writeAudit } from "../audit";
import { getEmployer } from "../config/employer";
import { ConfigError } from "../config/errors";
import { isValidKey, slugKey } from "../forms/keys";
import { centralDate } from "../time";
import { scoringCallsOn } from "./jobs";

// The rubric editor (DATA_MODEL.md: rubric, rubric_criterion, rubric_version,
// rubric_version_criterion; PLAN.md, Phase 2). Admin only at the action layer;
// everything here is audited.
//
// One rubric per role, holding its scoring mode. One draft version at a time, started
// from the published version (same instructions, flags and criteria) and saved in place
// as a whole. Publishing needs a written reason, never a passing Try it run, and retires
// the previous version in the same transaction; after that the triggers lock the version
// and its criteria. A criterion keeps its key across versions through rubric_criterion,
// so its grades compare over seasons. A criterion reads question lineages of the role
// only, never one marked ai_never_send. Scoring can be turned on (hidden or visible)
// only while a version is published.

export type RubricErrorCode =
  | "role_not_found"
  | "version_not_found"
  | "version_not_draft"
  | "instructions_required"
  | "text_too_long"
  | "too_many_flags"
  | "flag_label_required"
  | "invalid_flag_key"
  | "duplicate_flag"
  | "too_many_criteria"
  | "criteria_required"
  | "criterion_not_found"
  | "criterion_name_required"
  | "invalid_criterion_key"
  | "duplicate_criterion"
  | "invalid_weight"
  | "guidance_required"
  | "questions_required"
  | "question_not_found"
  | "question_never_send"
  | "change_reason_required"
  | "mode_needs_published"
  | "test_case_not_found"
  | "group_required"
  | "invalid_variant"
  | "answers_required"
  | "answer_not_on_role";

export class RubricError extends Error {
  constructor(
    readonly code: RubricErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RubricError";
  }
}

// numeric(5,2): above zero, at most 999.99, whole hundredths.
export const MAX_WEIGHT = 999.99;
export const MAX_CRITERIA = 20;
export const MAX_FLAGS = 20;
export const SCORING_DAILY_CAP_MAX = 1000;

const MAX_INSTRUCTIONS = 4000;
const MAX_NAME = 120;
const MAX_GUIDANCE = 2000;
const MAX_LABEL = 200;
const MAX_REASON = 2000;

// The first draft of a role with no rubric yet. The scorer adds its own fairness rules
// (ignore spelling, grammar, length and language; never consider protected traits).
export const DEFAULT_INSTRUCTIONS =
  "Grade each criterion only from the answers listed under it. Reward specific, real examples over general statements. A short answer that shows the behavior is as good as a long one.";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RubricVersionRow = typeof rubricVersion.$inferSelect;
type Status = RubricVersionRow["status"];

export type RubricCriterionView = {
  criterionId: string;
  // rubric_criterion.key: stable across versions.
  key: string;
  name: string;
  weight: number;
  guidanceStrong: string;
  guidanceAcceptable: string;
  guidanceWeak: string;
  // Question lineages (question.id) it reads.
  questionIds: string[];
  meaningChanged: boolean;
};

export type RubricVersionView = {
  id: string;
  rubricId: string;
  version: number;
  status: Status;
  instructions: string;
  allowedFlags: RubricFlag[];
  changeReason: string | null;
  publishedAt: Date | null;
  publishedBy: { id: string; name: string | null; email: string } | null;
  createdAt: Date;
  // In sort order.
  criteria: RubricCriterionView[];
};

export type RubricHistoryEntry = {
  id: string;
  version: number;
  status: Status;
  publishedAt: Date | null;
  publishedBy: string | null;
  changeReason: string | null;
};

// A question lineage of the role, as the criterion picker offers it.
export type RubricQuestionOption = {
  questionId: string;
  key: string;
  // The newest published wording, else the newest draft wording.
  prompt: string;
  type: QuestionType;
  aiNeverSend: boolean;
  // On the role's published form, so new applications answer it.
  onLiveForm: boolean;
};

export type RoleRubric = {
  role: { id: string; key: string; internalName: string; title: string };
  rubricId: string | null;
  mode: ScoringMode;
  published: RubricVersionView | null;
  draft: RubricVersionView | null;
  history: RubricHistoryEntry[];
  // Submitted applications of the role, the ones a re-score covers.
  submittedCount: number;
};

// ---------------------------------------------------------------------------
// Reads

async function versionViews(db: Db, rows: RubricVersionRow[]): Promise<RubricVersionView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const criteria = await db
    .select({
      rubricVersionId: rubricVersionCriterion.rubricVersionId,
      criterionId: rubricVersionCriterion.criterionId,
      key: rubricCriterion.key,
      name: rubricVersionCriterion.name,
      weight: rubricVersionCriterion.weight,
      guidanceStrong: rubricVersionCriterion.guidanceStrong,
      guidanceAcceptable: rubricVersionCriterion.guidanceAcceptable,
      guidanceWeak: rubricVersionCriterion.guidanceWeak,
      questionIds: rubricVersionCriterion.questionIds,
      meaningChanged: rubricVersionCriterion.meaningChanged,
    })
    .from(rubricVersionCriterion)
    .innerJoin(rubricCriterion, eq(rubricCriterion.id, rubricVersionCriterion.criterionId))
    .where(inArray(rubricVersionCriterion.rubricVersionId, ids))
    .orderBy(asc(rubricVersionCriterion.sortOrder), asc(rubricCriterion.key));
  const publisherIds = [...new Set(rows.map((row) => row.publishedBy).filter((id): id is string => Boolean(id)))];
  const publishers =
    publisherIds.length > 0
      ? await db.select({ id: appUser.id, name: appUser.name, email: appUser.email }).from(appUser).where(inArray(appUser.id, publisherIds))
      : [];
  const publisherById = new Map(publishers.map((user) => [user.id, user]));
  const byVersion = new Map<string, RubricCriterionView[]>();
  for (const { rubricVersionId, ...criterion } of criteria) {
    const list = byVersion.get(rubricVersionId) ?? [];
    list.push(criterion);
    byVersion.set(rubricVersionId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    rubricId: row.rubricId,
    version: row.version,
    status: row.status,
    instructions: row.instructions,
    allowedFlags: row.allowedFlags,
    changeReason: row.changeReason,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy ? (publisherById.get(row.publishedBy) ?? null) : null,
    createdAt: row.createdAt,
    criteria: byVersion.get(row.id) ?? [],
  }));
}

export async function loadRubricVersion(db: Db, rubricVersionId: string): Promise<RubricVersionView | null> {
  const rows = await db.select().from(rubricVersion).where(eq(rubricVersion.id, rubricVersionId));
  return (await versionViews(db, rows))[0] ?? null;
}

// Every version of a rubric with its criteria, newest first, for the version history.
export async function loadRubricVersions(db: Db, rubricId: string): Promise<RubricVersionView[]> {
  const rows = await db.select().from(rubricVersion).where(eq(rubricVersion.rubricId, rubricId)).orderBy(desc(rubricVersion.version));
  return versionViews(db, rows);
}

async function submittedCount(db: Db, roleId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(application)
    .where(and(eq(application.roleId, roleId), isNotNull(application.submittedAt), isNull(application.deletedAt)));
  return Number(row?.n ?? 0);
}

// One role's rubric for Settings > AI scoring: mode, the published version, the open
// draft (the newest, should there ever be two) and every version. Null for a role that
// does not exist or is archived.
export async function loadRoleRubric(db: Db, roleId: string): Promise<RoleRubric | null> {
  const [roleRow] = await db
    .select({ id: role.id, key: role.key, internalName: role.internalName, title: role.title })
    .from(role)
    .where(and(eq(role.id, roleId), isNull(role.archivedAt)));
  if (!roleRow) return null;
  const [rubricRow] = await db.select().from(rubric).where(eq(rubric.roleId, roleId));
  const versions = rubricRow
    ? await db.select().from(rubricVersion).where(eq(rubricVersion.rubricId, rubricRow.id)).orderBy(desc(rubricVersion.version))
    : [];
  const live = versions.filter((row) => row.status !== "retired");
  const publishedRow = live.find((row) => row.status === "published");
  const draftRow = live.find((row) => row.status === "draft");
  const views = await versionViews(db, [publishedRow, draftRow].filter((row): row is RubricVersionRow => Boolean(row)));
  const publisherIds = [...new Set(versions.map((row) => row.publishedBy).filter((id): id is string => Boolean(id)))];
  const publishers =
    publisherIds.length > 0
      ? await db.select({ id: appUser.id, name: appUser.name, email: appUser.email }).from(appUser).where(inArray(appUser.id, publisherIds))
      : [];
  const publisherName = new Map(publishers.map((user) => [user.id, user.name ?? user.email]));

  return {
    role: roleRow,
    rubricId: rubricRow?.id ?? null,
    mode: rubricRow?.scoringMode ?? "off",
    published: views.find((view) => view.status === "published") ?? null,
    draft: views.find((view) => view.status === "draft") ?? null,
    history: versions.map((row) => ({
      id: row.id,
      version: row.version,
      status: row.status,
      publishedAt: row.publishedAt,
      publishedBy: row.publishedBy ? (publisherName.get(row.publishedBy) ?? null) : null,
      changeReason: row.changeReason,
    })),
    submittedCount: await submittedCount(db, roleId),
  };
}

// Every live role's rubric, in the roles' order.
export async function listRoleRubrics(db: Db): Promise<RoleRubric[]> {
  const roles = await db.select({ id: role.id }).from(role).where(isNull(role.archivedAt)).orderBy(asc(role.sortOrder), asc(role.internalName));
  const result: RoleRubric[] = [];
  for (const row of roles) {
    const loaded = await loadRoleRubric(db, row.id);
    if (loaded) result.push(loaded);
  }
  return result;
}

// The role's question lineages a criterion may read, with their wording, the never-send
// flag (shown, never selectable) and whether the live form asks them.
export async function loadRubricQuestions(db: Db, roleId: string): Promise<RubricQuestionOption[]> {
  const rows = await db
    .select({
      questionId: question.id,
      key: question.key,
      aiNeverSend: question.aiNeverSend,
      prompt: questionVersion.prompt,
      type: questionVersion.type,
      publishedAt: questionVersion.publishedAt,
    })
    .from(question)
    .innerJoin(questionVersion, eq(questionVersion.questionId, question.id))
    .where(and(eq(question.roleId, roleId), isNull(question.archivedAt)))
    .orderBy(asc(question.key), desc(questionVersion.version));
  const live = await db
    .select({ questionId: questionVersion.questionId })
    .from(formItem)
    .innerJoin(formVersion, eq(formVersion.id, formItem.formVersionId))
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .where(and(eq(formVersion.roleId, roleId), eq(formVersion.status, "published")));
  const onLiveForm = new Set(live.map((row) => row.questionId));

  const options = new Map<string, RubricQuestionOption>();
  // Newest published wording first, then the newest draft wording for a lineage never published.
  for (const row of rows) {
    if (row.publishedAt && !options.has(row.questionId)) options.set(row.questionId, toOption(row, onLiveForm));
  }
  for (const row of rows) {
    if (!options.has(row.questionId)) options.set(row.questionId, toOption(row, onLiveForm));
  }
  // Live-form questions first, then the rest, each by key.
  return [...options.values()].sort((a, b) => Number(b.onLiveForm) - Number(a.onLiveForm) || a.key.localeCompare(b.key));
}

function toOption(
  row: { questionId: string; key: string; aiNeverSend: boolean; prompt: string; type: QuestionType },
  onLiveForm: Set<string>,
): RubricQuestionOption {
  return { questionId: row.questionId, key: row.key, prompt: row.prompt, type: row.type, aiNeverSend: row.aiNeverSend, onLiveForm: onLiveForm.has(row.questionId) };
}

// ---------------------------------------------------------------------------
// Calibration: hidden mode's check of the rubric against what people decided

export type CalibrationRow = {
  applicationId: string;
  name: string;
  status: AiScoreStatus;
  overallScore: number | null;
  rubricVersion: number;
  completedAt: Date | null;
  stage: string;
  closed: boolean;
  // The latest screening decision, if a person has made one.
  decision: { value: ReviewDecisionValue; reason: string | null; decidedAt: Date } | null;
};

// The role's most recent current scores, newest first, with the human decision beside each.
export async function loadCalibration(db: Db, roleId: string, limit = 25): Promise<CalibrationRow[]> {
  const rows = await db
    .select({
      applicationId: application.id,
      firstName: person.firstName,
      lastName: person.lastName,
      status: aiScore.status,
      overallScore: aiScore.overallScore,
      rubricVersion: rubricVersion.version,
      completedAt: aiScore.completedAt,
      stage: pipelineStage.name,
      applicationStatus: application.status,
    })
    .from(aiScore)
    .innerJoin(application, eq(application.id, aiScore.applicationId))
    .innerJoin(person, eq(person.id, application.personId))
    .innerJoin(rubricVersion, eq(rubricVersion.id, aiScore.rubricVersionId))
    .innerJoin(pipelineStage, eq(pipelineStage.id, application.currentStageId))
    .where(and(eq(application.roleId, roleId), isNull(application.deletedAt), eq(aiScore.isCurrent, true)))
    .orderBy(desc(aiScore.completedAt), desc(aiScore.id))
    .limit(limit);
  if (rows.length === 0) return [];

  const decisions = await db
    .select({
      applicationId: reviewDecision.applicationId,
      value: reviewDecision.decision,
      reason: picklistOption.label,
      decidedAt: reviewDecision.decidedAt,
    })
    .from(reviewDecision)
    .leftJoin(picklistOption, eq(picklistOption.id, reviewDecision.reasonOptionId))
    .where(
      inArray(
        reviewDecision.applicationId,
        rows.map((row) => row.applicationId),
      ),
    )
    .orderBy(desc(reviewDecision.decidedAt), desc(reviewDecision.createdAt));
  const latest = new Map<string, CalibrationRow["decision"]>();
  for (const decision of decisions) {
    if (!latest.has(decision.applicationId)) latest.set(decision.applicationId, { value: decision.value, reason: decision.reason, decidedAt: decision.decidedAt });
  }

  return rows.map((row) => ({
    applicationId: row.applicationId,
    name: [row.firstName, row.lastName].filter(Boolean).join(" ") || "(name removed)",
    status: row.status,
    overallScore: row.overallScore,
    rubricVersion: row.rubricVersion,
    completedAt: row.completedAt,
    stage: row.stage,
    closed: row.applicationStatus === "closed",
    decision: latest.get(row.applicationId) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// The daily cap (DATA_MODEL.md, employer.scoring_daily_cap), edited on this page

export type ScoringCapSettings = { employerId: string; cap: number; usedToday: number; date: string };

export async function getScoringCap(db: Db, now: Date = new Date()): Promise<ScoringCapSettings> {
  const row = await getEmployer(db);
  const date = centralDate(now);
  return { employerId: row.id, cap: row.scoringDailyCap, usedToday: await scoringCallsOn(db, row.id, date), date };
}

export async function updateScoringDailyCap(db: Db, input: { cap: number; actor: Actor }): Promise<number> {
  if (!Number.isInteger(input.cap) || input.cap < 1 || input.cap > SCORING_DAILY_CAP_MAX) {
    throw new ConfigError("invalid_input", `The daily scoring limit must be a whole number from 1 to ${SCORING_DAILY_CAP_MAX}`);
  }
  return db.transaction(async (tx) => {
    const before = await getEmployer(tx);
    const [after] = await tx.update(employer).set({ scoringDailyCap: input.cap }).where(eq(employer.id, before.id)).returning();
    const changes = diffChanges(before, after!, ["scoringDailyCap"]);
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, { actor: input.actor, action: "employer.scoring_cap_update", entityType: "employer", entityId: before.id, changes });
    }
    return after!.scoringDailyCap;
  });
}

// ---------------------------------------------------------------------------
// The rubric and its draft

// The role's rubric, created with scoring off on first use. Audited when created.
export async function getOrCreateRubric(db: Db, input: { roleId: string; actor: Actor }): Promise<string> {
  return db.transaction(async (tx) => {
    const [roleRow] = await tx.select({ id: role.id }).from(role).where(and(eq(role.id, input.roleId), isNull(role.archivedAt)));
    if (!roleRow) throw new RubricError("role_not_found", "That role no longer exists");
    const id = uuidv7();
    const inserted = await tx.insert(rubric).values({ id, roleId: roleRow.id }).onConflictDoNothing({ target: rubric.roleId }).returning({ id: rubric.id });
    if (inserted[0]) {
      await writeAudit(tx, { actor: input.actor, action: "rubric.create", entityType: "rubric", entityId: id, changes: { roleId: roleRow.id, scoringMode: "off" } });
      return id;
    }
    const [existing] = await tx.select({ id: rubric.id }).from(rubric).where(eq(rubric.roleId, roleRow.id));
    return existing!.id;
  });
}

// Returns the role's draft, starting one from the published version when none is open
// (same instructions, flags and criteria, nothing marked as a change of meaning). A role
// with nothing published gets an empty draft with starter instructions.
export async function ensureRubricDraft(db: Db, input: { roleId: string; actor: Actor }): Promise<RubricVersionView> {
  const id = await db.transaction(async (tx) => {
    const rubricId = await getOrCreateRubric(tx, input);
    // One draft at a time: two Admins starting a draft at once get the same one.
    await tx.select({ id: rubric.id }).from(rubric).where(eq(rubric.id, rubricId)).for("update");
    const versions = await tx.select().from(rubricVersion).where(eq(rubricVersion.rubricId, rubricId)).orderBy(desc(rubricVersion.version));
    const existing = versions.find((row) => row.status === "draft");
    if (existing) return existing.id;

    const published = versions.find((row) => row.status === "published") ?? null;
    const version = (versions[0]?.version ?? 0) + 1;
    const draftId = uuidv7();
    await tx.insert(rubricVersion).values({
      id: draftId,
      rubricId,
      version,
      status: "draft",
      instructions: published?.instructions ?? DEFAULT_INSTRUCTIONS,
      allowedFlags: published?.allowedFlags ?? [],
    });
    let copied = 0;
    if (published) {
      const criteria = await tx.select().from(rubricVersionCriterion).where(eq(rubricVersionCriterion.rubricVersionId, published.id));
      if (criteria.length > 0) {
        await tx.insert(rubricVersionCriterion).values(criteria.map((criterion) => ({ ...criterion, rubricVersionId: draftId, meaningChanged: false })));
        copied = criteria.length;
      }
    }
    await writeAudit(tx, {
      actor: input.actor,
      action: "rubric.draft_create",
      entityType: "rubric_version",
      entityId: draftId,
      changes: { rubricId, version, fromVersion: published?.version ?? null, criteria: copied },
    });
    return draftId;
  });
  const view = await loadRubricVersion(db, id);
  if (!view) throw new RubricError("version_not_found", "The draft could not be read back");
  return view;
}

async function lockDraft(tx: Tx, rubricVersionId: string): Promise<RubricVersionRow & { roleId: string }> {
  const [row] = await tx.select().from(rubricVersion).where(eq(rubricVersion.id, rubricVersionId)).for("update");
  if (!row) throw new RubricError("version_not_found", "That rubric version no longer exists");
  if (row.status !== "draft") {
    throw new RubricError("version_not_draft", `Rubric version ${row.version} is ${row.status} and cannot change. Start a new draft to change it.`, {
      status: row.status,
    });
  }
  const [owner] = await tx.select({ roleId: rubric.roleId }).from(rubric).where(eq(rubric.id, row.rubricId));
  return { ...row, roleId: owner!.roleId };
}

export type RubricFlagInput = { key?: string | null; label: string };

export type RubricCriterionInput = {
  // An existing criterion of this rubric, which keeps its key.
  criterionId?: string | null;
  // A new criterion's key; derived from the name when blank.
  key?: string | null;
  name: string;
  weight: number;
  guidanceStrong: string;
  guidanceAcceptable: string;
  guidanceWeak: string;
  questionIds: string[];
  meaningChanged?: boolean;
};

export type SaveRubricDraftInput = {
  rubricVersionId: string;
  instructions: string;
  allowedFlags: RubricFlagInput[];
  // In the order they are graded and shown.
  criteria: RubricCriterionInput[];
  actor: Actor;
};

function cleanText(value: string, max: number, code: RubricErrorCode, emptyMessage: string, tooLongWhat: string): string {
  const text = value.trim();
  if (!text) throw new RubricError(code, emptyMessage);
  if (text.length > max) throw new RubricError("text_too_long", `${tooLongWhat} is longer than ${max} characters`);
  return text;
}

// Whole hundredths above zero, at most 999.99, so it fits numeric(5,2) exactly.
export function validWeight(weight: number): boolean {
  if (!Number.isFinite(weight) || weight <= 0 || weight > MAX_WEIGHT) return false;
  return Math.abs(Math.round(weight * 100) - weight * 100) < 1e-6;
}

export function cleanFlags(flags: readonly RubricFlagInput[]): RubricFlag[] {
  if (flags.length > MAX_FLAGS) throw new RubricError("too_many_flags", `A rubric has at most ${MAX_FLAGS} flags`);
  const result: RubricFlag[] = [];
  for (const flag of flags) {
    const label = cleanText(flag.label, MAX_LABEL, "flag_label_required", "Every flag needs a label", "A flag label");
    const key = flag.key?.trim() || slugKey(label);
    if (!isValidKey(key)) {
      throw new RubricError("invalid_flag_key", `"${key}" is not a usable flag key: lowercase letters, numbers and underscores, starting with a letter`, { key });
    }
    if (result.some((other) => other.key === key)) throw new RubricError("duplicate_flag", `Two flags share the key "${key}"`, { key });
    result.push({ key, label });
  }
  return result;
}

type CleanCriterion = Omit<RubricCriterionInput, "criterionId" | "key" | "meaningChanged"> & {
  criterionId: string | null;
  key: string;
  meaningChanged: boolean;
};

// Checks one criterion's own fields. The key and the questions are checked against the
// rubric in saveRubricDraft.
function cleanCriterion(input: RubricCriterionInput): CleanCriterion {
  const name = cleanText(input.name, MAX_NAME, "criterion_name_required", "Every criterion needs a name", "A criterion name");
  const what = `"${name}"`;
  if (!validWeight(input.weight)) {
    throw new RubricError("invalid_weight", `${what} needs a weight above 0 and at most ${MAX_WEIGHT}, in whole hundredths`, { name });
  }
  const guidance = (value: string, level: string) =>
    cleanText(value, MAX_GUIDANCE, "guidance_required", `Write what ${level} answer looks like for ${what}`, `The guidance for ${what}`);
  const questionIds = [...new Set(input.questionIds)];
  if (questionIds.length === 0) throw new RubricError("questions_required", `Pick at least one question for ${what} to read`, { name });
  return {
    criterionId: input.criterionId ?? null,
    key: input.key?.trim() ?? "",
    name,
    weight: Math.round(input.weight * 100) / 100,
    guidanceStrong: guidance(input.guidanceStrong, "a strong"),
    guidanceAcceptable: guidance(input.guidanceAcceptable, "an acceptable"),
    guidanceWeak: guidance(input.guidanceWeak, "a weak"),
    questionIds,
    meaningChanged: Boolean(input.meaningChanged),
  };
}

// Every question id must be a live lineage of the role and never one marked never to send.
async function checkQuestions(db: Db, roleId: string, criteria: readonly { name: string; questionIds: readonly string[] }[]): Promise<void> {
  const ids = [...new Set(criteria.flatMap((criterion) => criterion.questionIds))];
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: question.id, key: question.key, roleId: question.roleId, aiNeverSend: question.aiNeverSend, archivedAt: question.archivedAt })
    .from(question)
    .where(inArray(question.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const criterion of criteria) {
    for (const id of criterion.questionIds) {
      const row = byId.get(id);
      if (!row || row.roleId !== roleId || row.archivedAt) {
        throw new RubricError("question_not_found", `"${criterion.name}" reads a question that is not one of this role's questions`, { questionId: id });
      }
      if (row.aiNeverSend) {
        throw new RubricError(
          "question_never_send",
          `"${criterion.name}" reads ${row.key}, which is marked never to send to the AI. Pick another question, or change the flag in the question editor.`,
          { questionId: id, key: row.key },
        );
      }
    }
  }
}

// Saves the whole draft: instructions, flags and criteria in order. Replaces the draft's
// criteria rows (allowed while it is a draft); an existing criterion keeps its key, a new
// one reuses this rubric's criterion with the same key or gets a new one. Audited with
// what changed.
export async function saveRubricDraft(db: Db, input: SaveRubricDraftInput): Promise<RubricVersionView> {
  const instructions = cleanText(input.instructions, MAX_INSTRUCTIONS, "instructions_required", "Write the instructions for the AI", "The instructions");
  const allowedFlags = cleanFlags(input.allowedFlags);
  if (input.criteria.length > MAX_CRITERIA) throw new RubricError("too_many_criteria", `A rubric has at most ${MAX_CRITERIA} criteria`);
  const cleaned = input.criteria.map(cleanCriterion);

  await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.rubricVersionId);
    await checkQuestions(tx, draft.roleId, cleaned);

    const identities = await tx.select().from(rubricCriterion).where(eq(rubricCriterion.rubricId, draft.rubricId));
    const byId = new Map(identities.map((row) => [row.id, row]));
    const byKey = new Map(identities.map((row) => [row.key, row]));
    const before = await tx.select().from(rubricVersionCriterion).where(eq(rubricVersionCriterion.rubricVersionId, draft.id));
    const [published] = await tx
      .select({ id: rubricVersion.id })
      .from(rubricVersion)
      .where(and(eq(rubricVersion.rubricId, draft.rubricId), eq(rubricVersion.status, "published")));
    const inPublished = new Set(
      published
        ? (await tx.select({ criterionId: rubricVersionCriterion.criterionId }).from(rubricVersionCriterion).where(eq(rubricVersionCriterion.rubricVersionId, published.id))).map(
            (row) => row.criterionId,
          )
        : [],
    );

    const rows: (typeof rubricVersionCriterion.$inferInsert)[] = [];
    const used = new Set<string>();
    for (const [index, criterion] of cleaned.entries()) {
      let criterionId: string;
      if (criterion.criterionId) {
        const identity = byId.get(criterion.criterionId);
        if (!identity) throw new RubricError("criterion_not_found", `"${criterion.name}" is not a criterion of this rubric. Reload the page.`);
        criterionId = identity.id;
      } else {
        const key = criterion.key || slugKey(criterion.name);
        if (!isValidKey(key)) {
          throw new RubricError("invalid_criterion_key", `"${key}" is not a usable key: lowercase letters, numbers and underscores, starting with a letter`, { key });
        }
        const existing = byKey.get(key);
        if (existing) {
          criterionId = existing.id;
        } else {
          criterionId = uuidv7();
          await tx.insert(rubricCriterion).values({ id: criterionId, rubricId: draft.rubricId, key });
          const created = { id: criterionId, rubricId: draft.rubricId, key, createdAt: new Date(), archivedAt: null };
          byId.set(criterionId, created);
          byKey.set(key, created);
        }
      }
      if (used.has(criterionId)) {
        throw new RubricError("duplicate_criterion", `Two criteria share the key "${byId.get(criterionId)!.key}"`, { key: byId.get(criterionId)!.key });
      }
      used.add(criterionId);
      rows.push({
        rubricVersionId: draft.id,
        criterionId,
        name: criterion.name,
        guidanceStrong: criterion.guidanceStrong,
        guidanceAcceptable: criterion.guidanceAcceptable,
        guidanceWeak: criterion.guidanceWeak,
        weight: criterion.weight,
        questionIds: criterion.questionIds,
        // Only a criterion the published version has can change meaning.
        meaningChanged: criterion.meaningChanged && inPublished.has(criterionId),
        sortOrder: (index + 1) * 10,
      });
    }

    await tx.delete(rubricVersionCriterion).where(eq(rubricVersionCriterion.rubricVersionId, draft.id));
    if (rows.length > 0) await tx.insert(rubricVersionCriterion).values(rows);
    await tx.update(rubricVersion).set({ instructions, allowedFlags }).where(eq(rubricVersion.id, draft.id));

    const changes = draftChanges(draft, before, { instructions, allowedFlags }, rows, byId);
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, { actor: input.actor, action: "rubric.draft_update", entityType: "rubric_version", entityId: draft.id, changes });
    }
  });

  const view = await loadRubricVersion(db, input.rubricVersionId);
  if (!view) throw new RubricError("version_not_found", "The draft could not be read back");
  return view;
}

type CriterionRow = typeof rubricVersionCriterion.$inferSelect | typeof rubricVersionCriterion.$inferInsert;

// What a save changed, for the audit row: the instructions and flags as from and to,
// and the criteria by key.
function draftChanges(
  before: RubricVersionRow,
  beforeCriteria: readonly CriterionRow[],
  after: { instructions: string; allowedFlags: RubricFlag[] },
  afterCriteria: readonly CriterionRow[],
  identities: Map<string, { key: string }>,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (before.instructions !== after.instructions) changes.instructions = { from: before.instructions, to: after.instructions };
  if (JSON.stringify(before.allowedFlags) !== JSON.stringify(after.allowedFlags)) changes.allowedFlags = { from: before.allowedFlags, to: after.allowedFlags };
  const keyOf = (id: string) => identities.get(id)?.key ?? id;
  const shape = (row: CriterionRow) =>
    JSON.stringify([row.name, row.guidanceStrong, row.guidanceAcceptable, row.guidanceWeak, Number(row.weight), [...row.questionIds].sort(), Boolean(row.meaningChanged)]);
  const beforeById = new Map(beforeCriteria.map((row) => [row.criterionId, row]));
  const afterIds = new Set(afterCriteria.map((row) => row.criterionId));
  const added = afterCriteria.filter((row) => !beforeById.has(row.criterionId)).map((row) => keyOf(row.criterionId));
  const removed = beforeCriteria.filter((row) => !afterIds.has(row.criterionId)).map((row) => keyOf(row.criterionId));
  const edited = afterCriteria
    .filter((row) => beforeById.has(row.criterionId) && shape(beforeById.get(row.criterionId)!) !== shape(row))
    .map((row) => keyOf(row.criterionId));
  const order = (rows: readonly CriterionRow[]) =>
    [...rows]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((row) => row.criterionId)
      .filter((id) => beforeById.has(id) && afterIds.has(id))
      .join(",");
  if (added.length > 0) changes.criteriaAdded = added;
  if (removed.length > 0) changes.criteriaRemoved = removed;
  if (edited.length > 0) changes.criteriaEdited = edited;
  if (order(beforeCriteria) !== order(afterCriteria)) changes.criteriaReordered = true;
  return changes;
}

// Deletes the draft and its criteria rows. The published version is untouched.
export async function discardRubricDraft(db: Db, input: { rubricVersionId: string; actor: Actor }): Promise<void> {
  await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.rubricVersionId);
    await tx.delete(rubricVersionCriterion).where(eq(rubricVersionCriterion.rubricVersionId, draft.id));
    await tx.delete(rubricVersion).where(eq(rubricVersion.id, draft.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: "rubric.draft_discard",
      entityType: "rubric_version",
      entityId: draft.id,
      changes: { rubricId: draft.rubricId, version: draft.version },
    });
  });
}

// ---------------------------------------------------------------------------
// Publishing

export type RubricProblem = { code: RubricErrorCode; message: string };

// What stops a draft from being published, in the order to fix it. Empty when it can go.
// The questions are checked again here: one may have been marked never to send since the
// draft was saved.
export async function checkRubricDraft(db: Db, rubricVersionId: string): Promise<RubricProblem[]> {
  const view = await loadRubricVersion(db, rubricVersionId);
  if (!view) throw new RubricError("version_not_found", "That rubric version no longer exists");
  const [owner] = await db.select({ roleId: rubric.roleId }).from(rubric).where(eq(rubric.id, view.rubricId));
  const problems: RubricProblem[] = [];
  if (!view.instructions.trim()) problems.push({ code: "instructions_required", message: "Write the instructions for the AI" });
  if (view.criteria.length === 0) problems.push({ code: "criteria_required", message: "Add at least one criterion" });
  for (const criterion of view.criteria) {
    try {
      cleanCriterion(criterion);
      await checkQuestions(db, owner!.roleId, [criterion]);
    } catch (error) {
      if (!(error instanceof RubricError)) throw error;
      problems.push({ code: error.code, message: error.message });
    }
  }
  return problems;
}

export type PublishRubricResult = {
  rubricVersionId: string;
  version: number;
  previous: { rubricVersionId: string; version: number } | null;
};

// Publishes a draft with a written reason (a passing Try it run is never required): one
// transaction that retires the published version, if any, and makes the draft the one
// the role is scored with. When scoring is on, the cron's sweep queues a new score for
// every submitted application on its next pass.
export async function publishRubricVersion(
  db: Db,
  input: { rubricVersionId: string; changeReason: string; actor: Actor; now?: Date },
): Promise<PublishRubricResult> {
  const changeReason = input.changeReason.trim();
  if (!changeReason) throw new RubricError("change_reason_required", "Write the reason for this change before publishing");
  if (changeReason.length > MAX_REASON) throw new RubricError("text_too_long", `The reason is longer than ${MAX_REASON} characters`);
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.rubricVersionId);
    // Serialises two publishes of one rubric.
    await tx.select({ id: rubric.id }).from(rubric).where(eq(rubric.id, draft.rubricId)).for("update");
    const problems = await checkRubricDraft(tx, draft.id);
    if (problems.length > 0) {
      const first = problems[0]!;
      throw new RubricError(first.code, first.message, { problems });
    }

    const [previous] = await tx
      .select({ id: rubricVersion.id, version: rubricVersion.version })
      .from(rubricVersion)
      .where(and(eq(rubricVersion.rubricId, draft.rubricId), eq(rubricVersion.status, "published")));
    if (previous) await tx.update(rubricVersion).set({ status: "retired" }).where(eq(rubricVersion.id, previous.id));
    await tx
      .update(rubricVersion)
      .set({ status: "published", changeReason, publishedAt: now, publishedBy: input.actor.type === "staff" ? input.actor.userId : null })
      .where(eq(rubricVersion.id, draft.id));

    const criteria = await tx
      .select({ key: rubricCriterion.key, weight: rubricVersionCriterion.weight })
      .from(rubricVersionCriterion)
      .innerJoin(rubricCriterion, eq(rubricCriterion.id, rubricVersionCriterion.criterionId))
      .where(eq(rubricVersionCriterion.rubricVersionId, draft.id))
      .orderBy(asc(rubricVersionCriterion.sortOrder));
    await writeAudit(tx, {
      actor: input.actor,
      action: "config.publish",
      entityType: "rubric_version",
      entityId: draft.id,
      occurredAt: now,
      changes: {
        roleId: draft.roleId,
        rubricId: draft.rubricId,
        version: draft.version,
        previousVersion: previous?.version ?? null,
        previousRubricVersionId: previous?.id ?? null,
        changeReason,
        criteria: criteria.map((c) => ({ key: c.key, weight: c.weight })),
      },
    });
    return {
      rubricVersionId: draft.id,
      version: draft.version,
      previous: previous ? { rubricVersionId: previous.id, version: previous.version } : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Scoring mode

// Off: nothing is scored. Hidden: scored, shown only in Settings > AI scoring. Visible:
// staff see the score on the list, board and profile. Turning scoring on needs a
// published version. Audited.
export async function setScoringMode(
  db: Db,
  input: { roleId: string; mode: ScoringMode; actor: Actor },
): Promise<{ mode: ScoringMode; previous: ScoringMode }> {
  return db.transaction(async (tx) => {
    const [roleRow] = await tx.select({ id: role.id }).from(role).where(and(eq(role.id, input.roleId), isNull(role.archivedAt)));
    if (!roleRow) throw new RubricError("role_not_found", "That role no longer exists");
    const [existing] = await tx.select().from(rubric).where(eq(rubric.roleId, roleRow.id)).for("update");
    if (!existing && input.mode === "off") return { mode: "off", previous: "off" };
    if (input.mode !== "off") {
      const [published] = existing
        ? await tx
            .select({ id: rubricVersion.id })
            .from(rubricVersion)
            .where(and(eq(rubricVersion.rubricId, existing.id), eq(rubricVersion.status, "published")))
        : [];
      if (!published) throw new RubricError("mode_needs_published", "Publish a rubric version before turning scoring on");
    }
    const previous = existing!.scoringMode;
    if (previous === input.mode) return { mode: previous, previous };
    await tx.update(rubric).set({ scoringMode: input.mode }).where(eq(rubric.id, existing!.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: "rubric.mode_change",
      entityType: "rubric",
      entityId: existing!.id,
      changes: { roleId: roleRow.id, scoringMode: { from: previous, to: input.mode } },
    });
    return { mode: input.mode, previous };
  });
}
