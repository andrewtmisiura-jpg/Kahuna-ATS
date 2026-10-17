import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import {
  aiScore,
  attendee,
  groupSession,
  rubric,
  rubricCriterion,
  rubricVersion,
  rubricVersionCriterion,
  type ScoringInputSnapshot,
} from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";

// Phase 2 rows for tests, written straight to the tables the way the services will.
// Test files share one database within a run, so everything here tolerates rows an
// earlier file left behind: one rubric per role is reused, version numbers continue,
// and publishing retires whatever version was live.

// The role's one rubric, created on first use.
export async function ensureRubric(db: Db, roleId: string): Promise<string> {
  await db.insert(rubric).values({ id: uuidv7(), roleId }).onConflictDoNothing({ target: rubric.roleId });
  const [row] = await db.select({ id: rubric.id }).from(rubric).where(eq(rubric.roleId, roleId));
  return row!.id;
}

// A criterion identity by key, created on first use.
export async function ensureCriterion(db: Db, rubricId: string, key: string): Promise<string> {
  await db.insert(rubricCriterion).values({ id: uuidv7(), rubricId, key }).onConflictDoNothing();
  const [row] = await db
    .select({ id: rubricCriterion.id })
    .from(rubricCriterion)
    .where(and(eq(rubricCriterion.rubricId, rubricId), eq(rubricCriterion.key, key)));
  return row!.id;
}

export type CriterionFixture = { key: string; weight?: number; questionIds?: string[] };

export type RubricVersionFixture = {
  rubricVersionId: string;
  version: number;
  criteria: { criterionId: string; key: string; weight: number }[];
};

// A rubric version with its criteria. The criteria go in while the version is a draft
// (a published version's criteria are locked); published: true then retires the live
// version and publishes this one, as the publish service will, in one transaction.
export async function createRubricVersion(
  db: Db,
  rubricId: string,
  options: { published?: boolean; publishedBy?: string; criteria?: CriterionFixture[] } = {},
): Promise<RubricVersionFixture> {
  const criteria = options.criteria ?? [
    { key: "reliability", weight: 2 },
    { key: "work_ethic", weight: 1 },
  ];
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ version: rubricVersion.version })
      .from(rubricVersion)
      .where(eq(rubricVersion.rubricId, rubricId))
      .orderBy(desc(rubricVersion.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const rubricVersionId = uuidv7();
    await tx.insert(rubricVersion).values({
      id: rubricVersionId,
      rubricId,
      version,
      status: "draft",
      instructions: "Ignore spelling, grammar, length and language. Never consider protected traits or criminal history.",
      allowedFlags: [{ key: "no_answer", label: "Did not answer the question" }],
    });
    const rows: RubricVersionFixture["criteria"] = [];
    for (const [i, criterion] of criteria.entries()) {
      const criterionId = await ensureCriterion(tx, rubricId, criterion.key);
      const weight = criterion.weight ?? 1;
      await tx.insert(rubricVersionCriterion).values({
        rubricVersionId,
        criterionId,
        name: criterion.key.replaceAll("_", " "),
        guidanceStrong: "A specific example.",
        guidanceAcceptable: "A general answer.",
        guidanceWeak: "No example.",
        weight,
        questionIds: criterion.questionIds ?? [],
        sortOrder: (i + 1) * 10,
      });
      rows.push({ criterionId, key: criterion.key, weight });
    }
    if (options.published) {
      await tx
        .update(rubricVersion)
        .set({ status: "retired" })
        .where(and(eq(rubricVersion.rubricId, rubricId), eq(rubricVersion.status, "published")));
      await tx
        .update(rubricVersion)
        .set({
          status: "published",
          publishedAt: new Date(),
          publishedBy: options.publishedBy ?? null,
          changeReason: "Test rubric for the Phase 2 schema tests.",
        })
        .where(eq(rubricVersion.id, rubricVersionId));
    }
    return { rubricVersionId, version, criteria: rows };
  });
}

export const ANONYMOUS_SNAPSHOT: ScoringInputSnapshot = {
  anonymousId: "00000000-0000-4000-8000-000000000000",
  answers: [{ criterionKey: "reliability", questionKey: "missed_commitment", prompt: "Tell us about it.", answer: "I called ahead." }],
};

// One ai_score row. A succeeded score needs an overall score; the others must not have one.
export async function createAiScore(
  db: Db,
  values: Partial<typeof aiScore.$inferInsert> & { applicationId: string; rubricVersionId: string },
): Promise<string> {
  const id = uuidv7();
  const status = values.status ?? "succeeded";
  await db.insert(aiScore).values({
    id,
    modelId: "fake-scorer",
    promptVersion: "fake-1/overall-1",
    status,
    inputSnapshot: ANONYMOUS_SNAPSHOT,
    overallScore: status === "succeeded" ? 51 : null,
    isCurrent: false,
    hiddenFromReviewers: true,
    scoredAfterDecision: false,
    requestedByType: "system",
    completedAt: status === "queued" ? null : new Date(),
    ...values,
  });
  return id;
}

// A group session on an opening, held now.
export async function createGroupSession(db: Db, openingId: string, createdBy: string): Promise<string> {
  const id = uuidv7();
  await db.insert(groupSession).values({ id, openingId, startsAt: new Date(), locationName: "Golden Valley shop", status: "held", createdBy });
  return id;
}

export async function createAttendee(
  db: Db,
  groupSessionId: string,
  values: Partial<typeof attendee.$inferInsert> = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(attendee).values({ id, groupSessionId, nameAsWritten: "Pat Sample", source: "paper_sheet", ...values });
  return id;
}
