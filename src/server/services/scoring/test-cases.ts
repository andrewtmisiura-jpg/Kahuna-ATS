import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { question, rubric, rubricTestCase, rubricVersion, type RubricTestAnswers } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "../actor";
import { writeAudit } from "../audit";
import { slugKey } from "../forms/keys";
import { buildScoringInputFromAnswers, scoreWithRubric } from "./engine";
import { ScorerError } from "./errors";
import { findProtectedTraitWords } from "./keywords";
import { anthropicKeyConfigured, getScorer, scoringProvider, type ScoringProvider } from "./provider";
import { loadRubricForScoring } from "./rubric-loader";
import { RubricError } from "./rubrics";
import { REFUSAL_ERROR, type RubricForScoring, type ScoredResult, type Scorer } from "./types";

// The rubric editor's sample answers and "Try it" (DATA_MODEL.md, rubric_test_case).
// Cases in one group say the same thing in different forms (standard, broken English,
// very short). Try it scores a rubric version, usually the draft, against every active
// case with the same scorer and engine as the scoring job, at most three calls at a
// time, and shows the results side by side with each group's spread. Nothing is stored,
// nothing counts toward the daily cap, and nothing here blocks publishing.

export const TEST_CASE_VARIANTS = ["standard", "broken_english", "short", "other"] as const;
export type TestCaseVariant = (typeof TEST_CASE_VARIANTS)[number];

export const TRY_IT_CONCURRENCY = 3;
// Variants of one answer should land within a few points; past this the group is flagged.
export const SPREAD_WARNING_POINTS = 10;

const MAX_ANSWER = 4000;
const MAX_ANSWERS = 50;

export type TestCaseView = {
  id: string;
  rubricId: string;
  groupKey: string;
  variant: TestCaseVariant;
  // Answers by question key.
  answers: RubricTestAnswers;
  createdAt: Date;
};

function isVariant(value: string): value is TestCaseVariant {
  return (TEST_CASE_VARIANTS as readonly string[]).includes(value);
}

function toView(row: typeof rubricTestCase.$inferSelect): TestCaseView {
  return {
    id: row.id,
    rubricId: row.rubricId,
    groupKey: row.groupKey,
    variant: isVariant(row.variant) ? row.variant : "other",
    answers: row.answers,
    createdAt: row.createdAt,
  };
}

// Active cases, by group and then in variant order.
export async function listTestCases(db: Db, rubricId: string): Promise<TestCaseView[]> {
  const rows = await db
    .select()
    .from(rubricTestCase)
    .where(and(eq(rubricTestCase.rubricId, rubricId), isNull(rubricTestCase.archivedAt)))
    .orderBy(asc(rubricTestCase.groupKey), asc(rubricTestCase.createdAt));
  return rows.map(toView).sort((a, b) => a.groupKey.localeCompare(b.groupKey) || TEST_CASE_VARIANTS.indexOf(a.variant) - TEST_CASE_VARIANTS.indexOf(b.variant));
}

export type TestCaseInput = {
  // A short name for the group, such as "Solid answers"; stored as a key.
  groupKey: string;
  variant: string;
  answers: Record<string, string>;
};

// The group as a key, the variant, and the non-blank answers, each to a question of the
// role that may be sent to the AI.
async function cleanTestCase(db: Db, roleId: string, input: TestCaseInput): Promise<{ groupKey: string; variant: TestCaseVariant; answers: RubricTestAnswers }> {
  const groupKey = slugKey(input.groupKey.trim());
  if (!groupKey) throw new RubricError("group_required", "Give the sample a group name, such as Solid answers");
  if (!isVariant(input.variant)) throw new RubricError("invalid_variant", "Pick standard, broken English, short or other");
  const answers: RubricTestAnswers = {};
  for (const [key, value] of Object.entries(input.answers)) {
    const text = value.trim();
    if (!text) continue;
    if (text.length > MAX_ANSWER) throw new RubricError("text_too_long", `The answer to ${key} is longer than ${MAX_ANSWER} characters`);
    answers[key] = text;
  }
  const keys = Object.keys(answers);
  if (keys.length === 0) throw new RubricError("answers_required", "Write at least one sample answer");
  if (keys.length > MAX_ANSWERS) throw new RubricError("text_too_long", `A sample has at most ${MAX_ANSWERS} answers`);
  const lineages = await db
    .select({ key: question.key, aiNeverSend: question.aiNeverSend })
    .from(question)
    .where(and(eq(question.roleId, roleId), isNull(question.archivedAt)));
  const byKey = new Map(lineages.map((row) => [row.key, row]));
  for (const key of keys) {
    const lineage = byKey.get(key);
    if (!lineage) throw new RubricError("answer_not_on_role", `${key} is not one of this role's questions`, { key });
    if (lineage.aiNeverSend) {
      throw new RubricError("question_never_send", `${key} is never sent to the AI, so a sample answer to it would never be scored`, { key });
    }
  }
  return { groupKey, variant: input.variant, answers };
}

async function roleOfRubric(db: Db, rubricId: string): Promise<string> {
  const [row] = await db.select({ roleId: rubric.roleId }).from(rubric).where(eq(rubric.id, rubricId));
  if (!row) throw new RubricError("version_not_found", "That rubric no longer exists");
  return row.roleId;
}

// Audited with the questions answered, not the text, which can run long.
export async function addTestCase(db: Db, input: TestCaseInput & { rubricId: string; actor: Actor }): Promise<TestCaseView> {
  return db.transaction(async (tx) => {
    const clean = await cleanTestCase(tx, await roleOfRubric(tx, input.rubricId), input);
    const [row] = await tx
      .insert(rubricTestCase)
      .values({ id: uuidv7(), rubricId: input.rubricId, ...clean })
      .returning();
    await writeAudit(tx, {
      actor: input.actor,
      action: "rubric_test_case.create",
      entityType: "rubric_test_case",
      entityId: row!.id,
      changes: { rubricId: input.rubricId, groupKey: clean.groupKey, variant: clean.variant, answered: Object.keys(clean.answers) },
    });
    return toView(row!);
  });
}

async function lockTestCase(db: Db, testCaseId: string) {
  const [row] = await db.select().from(rubricTestCase).where(eq(rubricTestCase.id, testCaseId)).for("update");
  if (!row || row.archivedAt) throw new RubricError("test_case_not_found", "That sample was archived or no longer exists. Reload the page.");
  return row;
}

export async function updateTestCase(db: Db, input: TestCaseInput & { testCaseId: string; actor: Actor }): Promise<TestCaseView> {
  return db.transaction(async (tx) => {
    const before = await lockTestCase(tx, input.testCaseId);
    const clean = await cleanTestCase(tx, await roleOfRubric(tx, before.rubricId), input);
    const [row] = await tx.update(rubricTestCase).set(clean).where(eq(rubricTestCase.id, before.id)).returning();
    const changes: Record<string, unknown> = {};
    if (before.groupKey !== clean.groupKey) changes.groupKey = { from: before.groupKey, to: clean.groupKey };
    if (before.variant !== clean.variant) changes.variant = { from: before.variant, to: clean.variant };
    if (JSON.stringify(before.answers) !== JSON.stringify(clean.answers)) changes.answered = Object.keys(clean.answers);
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, { actor: input.actor, action: "rubric_test_case.update", entityType: "rubric_test_case", entityId: before.id, changes });
    }
    return toView(row!);
  });
}

// Archived samples drop out of Try it; nothing is deleted.
export async function archiveTestCase(db: Db, input: { testCaseId: string; actor: Actor }): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockTestCase(tx, input.testCaseId);
    await tx.update(rubricTestCase).set({ archivedAt: new Date() }).where(eq(rubricTestCase.id, row.id));
    await writeAudit(tx, {
      actor: input.actor,
      action: "rubric_test_case.archive",
      entityType: "rubric_test_case",
      entityId: row.id,
      changes: { rubricId: row.rubricId, groupKey: row.groupKey, variant: row.variant },
    });
  });
}

// ---------------------------------------------------------------------------
// Try it

export type TryItCaseResult = {
  testCaseId: string;
  groupKey: string;
  variant: TestCaseVariant;
  // scored: a 1 to 100 number. not_scored: the scorer failed or its reply broke the
  // rubric, stored by the real job as "not scored". missing_answers: the sample leaves a
  // criterion with nothing to read, so the real job would send nothing. error: the call
  // could not be made (no key, a timeout).
  outcome: "scored" | "not_scored" | "missing_answers" | "error";
  overallScore: number | null;
  criteria: { key: string; name: string; score: number; rationale: string }[];
  overallRationale: string | null;
  flags: { key: string; label: string }[];
  // Protected-trait words in the rationales, the same chips the profile shows Admins.
  keywordHits: string[];
  // Criterion names with no answer in this sample.
  missingCriteria: string[];
  // A plain sentence, safe to show.
  message: string | null;
};

export type TryItGroup = {
  groupKey: string;
  results: TryItCaseResult[];
  // Highest minus lowest score in the group, once two or more were scored.
  spread: number | null;
  wide: boolean;
};

export type TryItResult =
  | { ok: true; rubricVersionId: string; version: number; status: "draft" | "published" | "retired"; provider: ScoringProvider; groups: TryItGroup[] }
  | { ok: false; reason: "no_key" | "no_cases" | "version_not_found" | "unavailable"; message: string };

export const NO_KEY_MESSAGE =
  "The Anthropic API key (ANTHROPIC_API_KEY) is not set, so Try it cannot call the AI and nothing is scored. Paste the key into Railway, then try again.";

// Highest minus lowest of the scores given, or null with fewer than two.
export function scoreSpread(scores: readonly (number | null)[]): number | null {
  const scored = scores.filter((score): score is number => score !== null);
  if (scored.length < 2) return null;
  return Math.max(...scored) - Math.min(...scored);
}

// Runs fn over the items with at most `limit` running at once; results keep the items' order.
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type TryItInput = {
  rubricVersionId: string;
  // Tests pass the fake scorer or one that fails; otherwise the running process's scorer.
  scorer?: Scorer;
  provider?: ScoringProvider;
};

export async function tryRubricVersion(db: Db, input: TryItInput): Promise<TryItResult> {
  const [version] = await db
    .select({ id: rubricVersion.id, version: rubricVersion.version, status: rubricVersion.status, rubricId: rubricVersion.rubricId })
    .from(rubricVersion)
    .where(eq(rubricVersion.id, input.rubricVersionId));
  const scoringRubric = version ? await loadRubricForScoring(db, version.id) : null;
  if (!version || !scoringRubric) return { ok: false, reason: "version_not_found", message: "That rubric version no longer exists. Reload the page." };
  const cases = await listTestCases(db, version.rubricId);
  if (cases.length === 0) return { ok: false, reason: "no_cases", message: "Add a sample answer first: Try it scores the samples below." };

  const provider = input.provider ?? scoringProvider();
  let scorer = input.scorer ?? null;
  if (!scorer) {
    if (provider === "live" && !anthropicKeyConfigured()) return { ok: false, reason: "no_key", message: NO_KEY_MESSAGE };
    try {
      scorer = getScorer(provider);
    } catch (error) {
      if (error instanceof ScorerError) return { ok: false, reason: "unavailable", message: error.message };
      throw error;
    }
  }
  const active: Scorer = scorer;

  const results = await mapWithConcurrency(cases, TRY_IT_CONCURRENCY, (testCase) => tryCase(scoringRubric, testCase, active));
  const groups: TryItGroup[] = [];
  for (const result of results) {
    let group = groups.find((g) => g.groupKey === result.groupKey);
    if (!group) {
      group = { groupKey: result.groupKey, results: [], spread: null, wide: false };
      groups.push(group);
    }
    group.results.push(result);
  }
  for (const group of groups) {
    group.spread = scoreSpread(group.results.map((result) => result.overallScore));
    group.wide = group.spread !== null && group.spread > SPREAD_WARNING_POINTS;
  }
  return { ok: true, rubricVersionId: version.id, version: version.version, status: version.status, provider, groups };
}

async function tryCase(scoringRubric: RubricForScoring, testCase: TestCaseView, scorer: Scorer): Promise<TryItCaseResult> {
  const base: TryItCaseResult = {
    testCaseId: testCase.id,
    groupKey: testCase.groupKey,
    variant: testCase.variant,
    outcome: "error",
    overallScore: null,
    criteria: [],
    overallRationale: null,
    flags: [],
    keywordHits: [],
    missingCriteria: [],
    message: null,
  };
  // The rubric's own wording of each question, as no applicant is involved.
  const input = buildScoringInputFromAnswers(scoringRubric, testCase.answers);
  const answered = new Set(input.answers.map((answer) => answer.criterionKey));
  const missing = scoringRubric.criteria.filter((criterion) => !answered.has(criterion.key)).map((criterion) => criterion.name);
  if (missing.length > 0) {
    return { ...base, outcome: "missing_answers", missingCriteria: missing, message: `No answer for ${missing.join(", ")}, so a real application like this would not be scored.` };
  }

  let result: ScoredResult;
  try {
    result = await scoreWithRubric(scoringRubric, input, scorer);
  } catch (error) {
    // ScorerError messages carry status codes and plain words, never the answers or the key.
    return { ...base, message: error instanceof ScorerError ? error.message : "The scoring call failed. Try again in a few minutes." };
  }
  if (result.status !== "succeeded") {
    const message =
      result.status === "invalid_output"
        ? "Not scored: the AI's reply didn't fit the rubric."
        : result.error === REFUSAL_ERROR
          ? "Not scored: the AI declined to score these answers."
          : "Not scored: the scoring call failed.";
    return { ...base, outcome: "not_scored", message };
  }
  const names = new Map(scoringRubric.criteria.map((criterion) => [criterion.key, criterion.name]));
  const labels = new Map(scoringRubric.allowedFlags.map((flag) => [flag.key, flag.label]));
  return {
    ...base,
    outcome: "scored",
    overallScore: result.overallScore,
    criteria: result.criteria.map((criterion) => ({
      key: criterion.criterionKey,
      name: names.get(criterion.criterionKey) ?? criterion.criterionKey,
      score: criterion.score,
      rationale: criterion.rationale,
    })),
    overallRationale: result.overallRationale,
    flags: result.flags.map((key) => ({ key, label: labels.get(key) ?? key })),
    keywordHits: findProtectedTraitWords([result.overallRationale, ...result.criteria.map((criterion) => criterion.rationale)]),
  };
}
