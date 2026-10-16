"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { SCORING_MODES } from "@/db/schema";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import { staffActor, type Actor } from "@/server/services/actor";
import { ConfigError } from "@/server/services/config/errors";
import { publishAiDisclosure } from "@/server/services/scoring/disclosure";
import {
  discardRubricDraft,
  ensureRubricDraft,
  publishRubricVersion,
  RubricError,
  saveRubricDraft,
  setScoringMode,
  updateScoringDailyCap,
} from "@/server/services/scoring/rubrics";
import { addTestCase, archiveTestCase, TEST_CASE_VARIANTS, tryRubricVersion, updateTestCase, type TryItResult } from "@/server/services/scoring/test-cases";

// Server actions for Settings > AI scoring: the rubric draft and its publish, Try it and
// its samples, the scoring mode, the daily limit and the AI disclosure. Admin only, like
// the screen. Each one checks the role first, parses its input, calls a scoring service
// and refreshes the pages; a known error comes back as a sentence the screen shows.
// Re-scoring a role is rescoreRoleAction in ./scoring.ts.

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

const uuid = z.uuid({ message: "Something is missing from this form. Reload and try again." });

function refresh(roleId?: string) {
  revalidatePath("/admin/settings/scoring");
  if (roleId) revalidatePath(`/admin/settings/scoring/${roleId}`);
}

function isImmutableViolation(error: unknown) {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e?.cause?.code ?? e?.code) === "TP002";
}

// Admin check first, then the input, then the service, then a refresh of the pages.
async function run<S extends z.ZodType, T>(
  schema: S,
  input: unknown,
  fn: (parsed: z.output<S>, actor: Actor) => Promise<T>,
  roleIdOf: (parsed: z.output<S>) => string | undefined = () => undefined,
): Promise<ActionResult<T>> {
  try {
    const user = await requireRole("admin");
    const parsed = schema.safeParse(input);
    if (!parsed.success) return { ok: false, code: "invalid_input", message: parsed.error.issues[0]?.message ?? "Check the form and try again." };
    const data = await fn(parsed.data, staffActor(user.id));
    refresh(roleIdOf(parsed.data));
    return { ok: true, data };
  } catch (error) {
    if (error instanceof RubricError) return { ok: false, code: error.code, message: error.message, details: error.details };
    if (error instanceof ConfigError) return { ok: false, code: error.code, message: error.message };
    if (error instanceof NotSignedInError) return { ok: false, code: "not_signed_in", message: "You are signed out. Sign in again." };
    if (error instanceof AccessDeniedError) return { ok: false, code: "access_denied", message: "Only an Admin can change AI scoring." };
    if (isImmutableViolation(error)) {
      refresh();
      return { ok: false, code: "published", message: "That version was published and cannot change. Reload the page." };
    }
    console.error("[rubric action]", error);
    return { ok: false, code: "unexpected", message: "Something went wrong. Try again." };
  }
}

const withRole = z.object({ roleId: uuid });
const withVersion = withRole.extend({ rubricVersionId: uuid });
const byRole = (parsed: { roleId: string }) => parsed.roleId;

// ---------------------------------------------------------------------------
// Scoring mode and the daily limit

export async function setScoringModeAction(input: { roleId: string; mode: string }): Promise<ActionResult<{ mode: string }>> {
  return run(
    withRole.extend({ mode: z.enum(SCORING_MODES, { message: "Pick off, hidden or visible" }) }),
    input,
    async (p, actor) => ({ mode: (await setScoringMode(db, { roleId: p.roleId, mode: p.mode, actor })).mode }),
    byRole,
  );
}

export async function updateScoringCapAction(input: { cap: number }): Promise<ActionResult<{ cap: number }>> {
  return run(z.object({ cap: z.number({ message: "The daily limit must be a number" }) }), input, async (p, actor) => ({
    cap: await updateScoringDailyCap(db, { cap: p.cap, actor }),
  }));
}

// ---------------------------------------------------------------------------
// The draft and publishing

export async function startRubricDraftAction(input: { roleId: string }): Promise<ActionResult<{ rubricVersionId: string; version: number }>> {
  return run(
    withRole,
    input,
    async (p, actor) => {
      const draft = await ensureRubricDraft(db, { roleId: p.roleId, actor });
      return { rubricVersionId: draft.id, version: draft.version };
    },
    byRole,
  );
}

const criterionSchema = z.object({
  criterionId: z.uuid().nullish(),
  key: z.string().trim().max(64).nullish(),
  name: z.string().max(400),
  weight: z.number({ message: "Each weight must be a number" }),
  guidanceStrong: z.string().max(4000),
  guidanceAcceptable: z.string().max(4000),
  guidanceWeak: z.string().max(4000),
  questionIds: z.array(z.uuid()).max(50),
  meaningChanged: z.boolean().optional(),
});

const saveDraftSchema = withVersion.extend({
  instructions: z.string().max(8000),
  allowedFlags: z.array(z.object({ key: z.string().trim().max(64).nullish(), label: z.string().max(400) })).max(50),
  criteria: z.array(criterionSchema).max(50),
});

export type SaveRubricDraftActionInput = z.input<typeof saveDraftSchema>;

export async function saveRubricDraftAction(input: SaveRubricDraftActionInput): Promise<ActionResult<{ version: number }>> {
  return run(
    saveDraftSchema,
    input,
    async (p, actor) => {
      const saved = await saveRubricDraft(db, {
        rubricVersionId: p.rubricVersionId,
        instructions: p.instructions,
        allowedFlags: p.allowedFlags,
        criteria: p.criteria,
        actor,
      });
      return { version: saved.version };
    },
    byRole,
  );
}

export async function discardRubricDraftAction(input: { roleId: string; rubricVersionId: string }): Promise<ActionResult> {
  return run(
    withVersion,
    input,
    async (p, actor) => {
      await discardRubricDraft(db, { rubricVersionId: p.rubricVersionId, actor });
      return undefined;
    },
    byRole,
  );
}

export async function publishRubricAction(input: {
  roleId: string;
  rubricVersionId: string;
  changeReason: string;
}): Promise<ActionResult<{ version: number; previousVersion: number | null }>> {
  return run(
    withVersion.extend({ changeReason: z.string().max(4000) }),
    input,
    async (p, actor) => {
      const result = await publishRubricVersion(db, { rubricVersionId: p.rubricVersionId, changeReason: p.changeReason, actor });
      return { version: result.version, previousVersion: result.previous?.version ?? null };
    },
    byRole,
  );
}

// ---------------------------------------------------------------------------
// Try it and its samples

// Scores a version against every active sample. Nothing is saved, so nothing to refresh.
export async function tryRubricAction(input: { roleId: string; rubricVersionId: string }): Promise<ActionResult<TryItResult>> {
  return run(withVersion, input, (p) => tryRubricVersion(db, { rubricVersionId: p.rubricVersionId }));
}

const testCaseFields = {
  groupKey: z.string().max(200),
  variant: z.enum(TEST_CASE_VARIANTS, { message: "Pick standard, broken English, short or other" }),
  answers: z.record(z.string().max(64), z.string().max(8000)),
};

export async function addTestCaseAction(input: {
  roleId: string;
  rubricId: string;
  groupKey: string;
  variant: string;
  answers: Record<string, string>;
}): Promise<ActionResult<{ id: string }>> {
  return run(
    withRole.extend({ rubricId: uuid, ...testCaseFields }),
    input,
    async (p, actor) => ({ id: (await addTestCase(db, { rubricId: p.rubricId, groupKey: p.groupKey, variant: p.variant, answers: p.answers, actor })).id }),
    byRole,
  );
}

export async function updateTestCaseAction(input: {
  roleId: string;
  testCaseId: string;
  groupKey: string;
  variant: string;
  answers: Record<string, string>;
}): Promise<ActionResult> {
  return run(
    withRole.extend({ testCaseId: uuid, ...testCaseFields }),
    input,
    async (p, actor) => {
      await updateTestCase(db, { testCaseId: p.testCaseId, groupKey: p.groupKey, variant: p.variant, answers: p.answers, actor });
      return undefined;
    },
    byRole,
  );
}

export async function archiveTestCaseAction(input: { roleId: string; testCaseId: string }): Promise<ActionResult> {
  return run(
    withRole.extend({ testCaseId: uuid }),
    input,
    async (p, actor) => {
      await archiveTestCase(db, { testCaseId: p.testCaseId, actor });
      return undefined;
    },
    byRole,
  );
}

// ---------------------------------------------------------------------------
// The AI disclosure on the landing page

export async function publishAiDisclosureAction(input: { body: string; changeNote: string }): Promise<ActionResult<{ version: number }>> {
  return run(z.object({ body: z.string().max(4000), changeNote: z.string().max(2000) }), input, async (p, actor) => ({
    version: (await publishAiDisclosure(db, { body: p.body, changeNote: p.changeNote, actor })).version,
  }));
}
