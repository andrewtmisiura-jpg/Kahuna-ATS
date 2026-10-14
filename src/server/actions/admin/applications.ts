"use server";

import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { application, pipelineStage, sourceEnum } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { requireRole } from "@/server/auth/require-role";
import type { UserRole } from "@/server/auth/roles";
import type { SessionUser } from "@/server/auth/session";
import { staffActor } from "@/server/services/actor";
import { rescindHire, undoLastChange } from "@/server/services/applications/corrections";
import { setAttributedSession, updateSource } from "@/server/services/applications/details";
import { addNote, deleteNote, editNote } from "@/server/services/applications/notes";
import { updateBackgroundCheck, updateHireStint, updateOffer } from "@/server/services/applications/records";
import { transition, TransitionError, type TransitionInput } from "@/server/services/applications/transition";
import { markHandled } from "@/server/services/messaging/inbox";
import {
  deleteTestApplication,
  recordStopRequest,
  resendApplicationLink,
  resolveLandingConflict,
  setDoNotContact,
  updateContact,
  updateIndeedAppliedOn,
} from "@/server/services/people";
import { toActionFailure, type ActionResult } from "./application-errors";

// Every staff action on an application. Each one starts with requireRole, hands
// the work to a service and maps any error to an ActionResult; the client
// refreshes the page on success. Viewers can read but never reach these.

const ACTORS: readonly UserRole[] = ["admin", "hiring_manager"];

async function run<T>(roles: UserRole | readonly UserRole[], fn: (user: SessionUser) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole(roles);
    return { ok: true, data: await fn(user) };
  } catch (error) {
    return toActionFailure(error);
  }
}

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
const instant = z.iso.datetime({ offset: true });
const optionalDate = isoDate.nullable().optional();
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();
const seq = z.number().int().nonnegative();

const baseSchema = z.object({
  applicationId: uuid,
  expectedSeq: seq,
  occurredAt: instant.optional(),
  note: optionalText(2000),
});

const offerSchema = z
  .object({
    isConditional: z.boolean().optional(),
    plannedStartOn: optionalDate,
    payAmount: z.string().regex(/^\d{1,6}(\.\d{1,2})?$/, "Enter an amount like 22.50").nullable().optional(),
    payUnit: z.enum(["hourly", "daily", "salary"]).nullable().optional(),
    note: optionalText(2000),
  })
  .optional();

const checkSchema = z
  .object({
    checkType: z.enum(["criminal", "driving_record", "drug_screen", "other"]),
    vendor: optionalText(200),
    requestedOn: optionalDate,
  })
  .optional();

const hireSchema = z
  .object({
    isTemporary: z.boolean().optional(),
    plannedEndOn: optionalDate,
    crewOptionId: uuid.nullable().optional(),
    plannedStartOn: optionalDate,
    startOn: optionalDate,
  })
  .optional();

const moveSchema = baseSchema.extend({ toStageId: uuid, offer: offerSchema, check: checkSchema, hire: hireSchema });

export type MoveInput = z.input<typeof moveSchema>;

export type TransitionOutcome = {
  applicationId: string;
  eventSeq: number;
  status: "open" | "hired" | "closed";
  stageId: string;
  created: { offerId?: string; backgroundCheckId?: string; hireStintId?: string };
};

function outcome(result: Awaited<ReturnType<typeof transition>>): TransitionOutcome {
  return {
    applicationId: result.application.id,
    eventSeq: result.application.eventSeq,
    status: result.application.status,
    stageId: result.application.currentStageId,
    created: result.created,
  };
}

function common(user: SessionUser, input: z.infer<typeof baseSchema>) {
  return {
    applicationId: input.applicationId,
    actor: staffActor(user.id),
    expectedSeq: input.expectedSeq,
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
    note: input.note ?? null,
  };
}

export async function moveApplication(raw: MoveInput): Promise<ActionResult<TransitionOutcome>> {
  return run(ACTORS, async (user) => {
    const input = moveSchema.parse(raw);
    const result = await transition(db, {
      action: "move",
      ...common(user, input),
      toStageId: input.toStageId,
      offer: input.offer,
      check: input.check,
      hire: input.hire,
    });
    return outcome(result);
  });
}

const hireNowSchema = z.object({ applicationId: uuid, expectedSeq: seq, hire: hireSchema });

// One tap from any stage: jump to the role's Hired stage; the hire form opens after.
export async function hireNow(raw: z.input<typeof hireNowSchema>): Promise<ActionResult<TransitionOutcome>> {
  return run(ACTORS, async (user) => {
    const input = hireNowSchema.parse(raw);
    const [app] = await db.select({ roleId: application.roleId }).from(application).where(eq(application.id, input.applicationId));
    if (!app) throw new TransitionError("application_not_found", "No such application");
    const [hired] = await db
      .select({ id: pipelineStage.id })
      .from(pipelineStage)
      .where(and(eq(pipelineStage.roleId, app.roleId), eq(pipelineStage.milestone, "hired"), isNull(pipelineStage.archivedAt)))
      .orderBy(asc(pipelineStage.sortOrder))
      .limit(1);
    if (!hired) throw new TransitionError("stage_not_found", "This role has no Hired stage");
    const result = await transition(db, {
      action: "move",
      applicationId: input.applicationId,
      actor: staffActor(user.id),
      expectedSeq: input.expectedSeq,
      toStageId: hired.id,
      hire: input.hire,
    });
    return outcome(result);
  });
}

const bulkSchema = z.object({
  items: z.array(z.object({ applicationId: uuid, expectedSeq: seq })).min(1).max(200),
  toStageId: uuid,
  occurredAt: instant.optional(),
  note: optionalText(2000),
});

export type BulkMoveOutcome = { moved: string[]; skipped: { applicationId: string; message: string }[] };

// A bulk move checks each row and lists the rows it skipped (DATA_MODEL.md).
// Stages that need an offer, a check or a hire record are moved one at a time.
export async function bulkMoveApplications(raw: z.input<typeof bulkSchema>): Promise<ActionResult<BulkMoveOutcome>> {
  return run(ACTORS, async (user) => {
    const input = bulkSchema.parse(raw);
    const [stage] = await db.select({ milestone: pipelineStage.milestone }).from(pipelineStage).where(eq(pipelineStage.id, input.toStageId));
    if (!stage) throw new TransitionError("stage_not_found", "No such stage");
    if (stage.milestone === "offered" || stage.milestone === "background_check" || stage.milestone === "hired") {
      throw new TransitionError("stage_not_allowed", "Move people into offers, checks and Hired one at a time, so each record is complete");
    }
    const batchId = uuidv7();
    const moved: string[] = [];
    const skipped: BulkMoveOutcome["skipped"] = [];
    for (const item of input.items) {
      try {
        await transition(db, {
          action: "move",
          applicationId: item.applicationId,
          actor: staffActor(user.id),
          expectedSeq: item.expectedSeq,
          toStageId: input.toStageId,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
          note: input.note ?? null,
          batchId,
        });
        moved.push(item.applicationId);
      } catch (error) {
        skipped.push({ applicationId: item.applicationId, message: toActionFailure(error).message });
      }
    }
    return { moved, skipped };
  });
}

const closeSchema = baseSchema.extend({
  outcome: z.enum(["disqualified", "withdrew", "not_selected"]),
  reasonOptionId: uuid,
  fcra: z.object({ backgroundCheckIds: z.array(uuid).optional(), notReportBased: z.boolean().optional() }).optional(),
});

export type CloseInput = z.input<typeof closeSchema>;

export async function closeApplication(raw: CloseInput): Promise<ActionResult<TransitionOutcome>> {
  return run(ACTORS, async (user) => {
    const input = closeSchema.parse(raw);
    const result = await transition(db, {
      action: "close",
      ...common(user, input),
      outcome: input.outcome,
      reasonOptionId: input.reasonOptionId,
      fcra: input.fcra,
    });
    return outcome(result);
  });
}

async function simple(raw: unknown, action: "hold" | "unhold" | "contacted"): Promise<ActionResult<TransitionOutcome>> {
  return run(ACTORS, async (user) => {
    const input = baseSchema.parse(raw);
    const result = await transition(db, { action, ...common(user, input) } as TransitionInput);
    return outcome(result);
  });
}

export async function holdApplication(raw: z.input<typeof baseSchema>) {
  return simple(raw, "hold");
}

export async function unholdApplication(raw: z.input<typeof baseSchema>) {
  return simple(raw, "unhold");
}

export async function markContacted(raw: z.input<typeof baseSchema>) {
  return simple(raw, "contacted");
}

const reopenSchema = baseSchema.extend({ toStageId: uuid.optional() });

export async function reopenApplication(raw: z.input<typeof reopenSchema>): Promise<ActionResult<TransitionOutcome>> {
  return run(ACTORS, async (user) => {
    const input = reopenSchema.parse(raw);
    const result = await transition(db, { action: "reopen", ...common(user, input), toStageId: input.toStageId });
    return outcome(result);
  });
}

// ---------------------------------------------------------------------------
// Corrections: rescind a hire, undo the latest change

const fcraSchema = z.object({ backgroundCheckIds: z.array(uuid).optional(), notReportBased: z.boolean().optional() }).optional();

const rescindSchema = baseSchema.extend({
  to: z.discriminatedUnion("status", [
    z.object({ status: z.literal("open"), toStageId: uuid }),
    z.object({
      status: z.literal("closed"),
      outcome: z.enum(["disqualified", "withdrew", "not_selected"]),
      reasonOptionId: uuid,
      fcra: fcraSchema,
    }),
  ]),
});

export type RescindInput = z.input<typeof rescindSchema>;

// "Rescind hire" on a Hired application: close it with an outcome and reason, or
// put it back in a stage. The service asks for a reason or a note.
export async function rescindApplicationHire(raw: RescindInput): Promise<ActionResult<TransitionOutcome>> {
  return run(ACTORS, async (user) => {
    const input = rescindSchema.parse(raw);
    const result = await rescindHire(db, { ...common(user, input), to: input.to });
    return outcome(result);
  });
}

const undoSchema = z.object({ applicationId: uuid, expectedSeq: seq, eventId: uuid });

// "Undo last change": voids the change the confirmation named. Hiring Managers and Admins only.
export async function undoApplicationChange(raw: z.input<typeof undoSchema>): Promise<ActionResult<TransitionOutcome>> {
  return run(ACTORS, async (user) => {
    const input = undoSchema.parse(raw);
    const result = await undoLastChange(db, { applicationId: input.applicationId, actor: staffActor(user.id), expectedSeq: input.expectedSeq, eventId: input.eventId });
    return outcome(result);
  });
}

// ---------------------------------------------------------------------------
// Details: source and group session

const sourceSchema = z.object({
  applicationId: uuid,
  source: z.enum(sourceEnum.enumValues).nullable(),
  sourceDetail: optionalText(200),
});

export async function updateApplicationSource(raw: z.input<typeof sourceSchema>): Promise<ActionResult<{ changed: string[] }>> {
  return run(ACTORS, async (user) => {
    const input = sourceSchema.parse(raw);
    return updateSource(db, { applicationId: input.applicationId, userId: user.id, source: input.source, sourceDetail: input.sourceDetail ?? null });
  });
}

const sessionSchema = z.object({ applicationId: uuid, sessionId: uuid.nullable() });

export async function setApplicationSession(raw: z.input<typeof sessionSchema>): Promise<ActionResult<{ changed: boolean }>> {
  return run(ACTORS, async (user) => {
    const input = sessionSchema.parse(raw);
    return setAttributedSession(db, { applicationId: input.applicationId, userId: user.id, sessionId: input.sessionId });
  });
}

// ---------------------------------------------------------------------------
// Notes

const noteSchema = z.object({ applicationId: uuid, body: z.string().max(4000), isRestricted: z.boolean() });

export async function addApplicationNote(raw: z.input<typeof noteSchema>): Promise<ActionResult<{ noteId: string }>> {
  return run(ACTORS, async (user) => {
    const input = noteSchema.parse(raw);
    return addNote(db, { ...input, userId: user.id });
  });
}

const editNoteSchema = z.object({ noteId: uuid, body: z.string().max(4000), isRestricted: z.boolean() });

export async function editApplicationNote(raw: z.input<typeof editNoteSchema>): Promise<ActionResult<{ noteId: string }>> {
  return run(ACTORS, async (user) => {
    const input = editNoteSchema.parse(raw);
    return editNote(db, { ...input, userId: user.id, role: user.role });
  });
}

export async function deleteApplicationNote(raw: { noteId: string }): Promise<ActionResult<null>> {
  return run(ACTORS, async (user) => {
    const input = z.object({ noteId: uuid }).parse(raw);
    await deleteNote(db, { noteId: input.noteId, userId: user.id, role: user.role });
    return null;
  });
}

// ---------------------------------------------------------------------------
// Contact details, texting and links

const contactSchema = z.object({
  personId: uuid,
  firstName: text(100),
  lastName: text(100),
  mobile: text(30).nullable(),
  email: text(254).nullable(),
  sharedMobile: z.boolean(),
});

export async function updatePersonContact(raw: z.input<typeof contactSchema>): Promise<ActionResult<{ changed: string[] }>> {
  return run(ACTORS, async (user) => {
    const input = contactSchema.parse(raw);
    return updateContact(db, { ...input, userId: user.id });
  });
}

export async function setPersonDoNotContact(raw: { personId: string; value: boolean }): Promise<ActionResult<null>> {
  return run(ACTORS, async (user) => {
    const input = z.object({ personId: uuid, value: z.boolean() }).parse(raw);
    await setDoNotContact(db, { ...input, userId: user.id });
    return null;
  });
}

export async function recordTheyAskedToStop(raw: { applicationId: string }): Promise<ActionResult<null>> {
  return run(ACTORS, async (user) => {
    const input = z.object({ applicationId: uuid }).parse(raw);
    await recordStopRequest(db, { applicationId: input.applicationId, userId: user.id });
    return null;
  });
}

// The same markHandled the inbox uses. False when someone already handled it.
export async function markInboundTextHandled(raw: { messageId: string }): Promise<ActionResult<{ handled: boolean }>> {
  return run(ACTORS, async (user) => {
    const input = z.object({ messageId: uuid }).parse(raw);
    return { handled: await markHandled(db, input.messageId, user.id) };
  });
}

export type LinkOutcome = { sent: number; suppressed: number; revoked: number };

export async function resendLink(raw: { applicationId: string; revokeFirst?: boolean }): Promise<ActionResult<LinkOutcome>> {
  return run(ACTORS, async (user) => {
    const input = z.object({ applicationId: uuid, revokeFirst: z.boolean().optional() }).parse(raw);
    const result = await resendApplicationLink(db, { applicationId: input.applicationId, userId: user.id, revokeFirst: input.revokeFirst });
    return { sent: result.sent.length, suppressed: result.suppressed.length, revoked: result.revoked };
  });
}

export async function setIndeedAppliedOn(raw: { applicationId: string; date: string | null }): Promise<ActionResult<null>> {
  return run(ACTORS, async (user) => {
    const input = z.object({ applicationId: uuid, date: isoDate.nullable() }).parse(raw);
    await updateIndeedAppliedOn(db, { ...input, userId: user.id });
    return null;
  });
}

const conflictSchema = z.object({ conflictId: uuid, personId: uuid, resolution: z.enum(["update_email", "mark_shared"]) });

export async function resolveContactConflict(raw: z.input<typeof conflictSchema>): Promise<ActionResult<null>> {
  return run(ACTORS, async (user) => {
    const input = conflictSchema.parse(raw);
    await resolveLandingConflict(db, { ...input, userId: user.id });
    return null;
  });
}

// ---------------------------------------------------------------------------
// Offer, check and hire record panels

const offerPatchSchema = z.object({
  offerId: uuid,
  patch: z.object({
    isConditional: z.boolean().optional(),
    payAmount: z.string().regex(/^\d{1,6}(\.\d{1,2})?$/, "Enter an amount like 22.50").nullable().optional(),
    payUnit: z.enum(["hourly", "daily", "salary"]).nullable().optional(),
    plannedStartOn: optionalDate,
    response: z.enum(["pending", "accepted", "declined", "rescinded", "expired"]).optional(),
    respondedOn: optionalDate,
    note: optionalText(2000),
    notReportBased: z.boolean().optional(),
  }),
});

export async function saveOffer(raw: z.input<typeof offerPatchSchema>): Promise<ActionResult<null>> {
  return run(ACTORS, async (user) => {
    const input = offerPatchSchema.parse(raw);
    await updateOffer(db, { offerId: input.offerId, userId: user.id, patch: input.patch });
    return null;
  });
}

const checkPatchSchema = z.object({
  checkId: uuid,
  patch: z.object({
    status: z.enum(["requested", "in_progress", "clear", "needs_review", "pre_adverse_sent", "final_adverse_sent", "canceled"]).optional(),
    vendor: optionalText(200),
    vendorReference: optionalText(200),
    requestedOn: optionalDate,
    completedOn: optionalDate,
    preAdverseNoticeOn: optionalDate,
    finalAdverseOn: optionalDate,
    note: optionalText(2000),
  }),
});

export async function saveBackgroundCheck(raw: z.input<typeof checkPatchSchema>): Promise<ActionResult<null>> {
  return run(ACTORS, async (user) => {
    const input = checkPatchSchema.parse(raw);
    await updateBackgroundCheck(db, { checkId: input.checkId, userId: user.id, role: user.role, patch: input.patch });
    return null;
  });
}

const rating = z.number().int().min(1).max(5).nullable().optional();

const stintPatchSchema = z.object({
  stintId: uuid,
  patch: z.object({
    isTemporary: z.boolean().optional(),
    plannedEndOn: optionalDate,
    crewOptionId: uuid.nullable().optional(),
    plannedStartOn: optionalDate,
    startOn: optionalDate,
    lastWorkedOn: optionalDate,
    endOn: optionalDate,
    outcome: z.enum(["active", "completed_season", "separated", "never_started"]).optional(),
    separationType: z.enum(["voluntary", "involuntary"]).nullable().optional(),
    leaveReasonOptionId: uuid.nullable().optional(),
    leaveNote: optionalText(2000),
    rehireEligible: z.boolean().nullable().optional(),
    rating30: rating,
    rating90: rating,
    seasonEndRating: z.enum(["reliable", "mixed", "unreliable", "never_worked"]).nullable().optional(),
    stormsWorked: z.number().int().min(0).max(500).nullable().optional(),
    temporaryChangeReason: optionalText(500),
  }),
});

export type StintPatchInput = z.input<typeof stintPatchSchema>;

export async function saveHireStint(raw: StintPatchInput): Promise<ActionResult<null>> {
  return run(ACTORS, async (user) => {
    const input = stintPatchSchema.parse(raw);
    await updateHireStint(db, { stintId: input.stintId, userId: user.id, role: user.role, patch: input.patch });
    return null;
  });
}

// ---------------------------------------------------------------------------
// Admin only

export async function deleteTestApplicationAction(raw: { applicationId: string }): Promise<ActionResult<null>> {
  return run("admin", async (user) => {
    const input = z.object({ applicationId: uuid }).parse(raw);
    await deleteTestApplication(db, { applicationId: input.applicationId, userId: user.id });
    return null;
  });
}
