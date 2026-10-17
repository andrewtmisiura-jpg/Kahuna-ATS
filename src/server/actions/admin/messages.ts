"use server";

import { z } from "zod";
import { db } from "@/db";
import { requireRole } from "@/server/auth/require-role";
import type { UserRole } from "@/server/auth/roles";
import type { SessionUser } from "@/server/auth/session";
import { staffActor } from "@/server/services/actor";
import { transition, type TransitionInput } from "@/server/services/applications/transition";
import { withMessages } from "@/server/services/messaging/after-transition";
import { previewTemplateMessage, sendTemplateMessage, type SendPreview } from "@/server/services/messaging/staff-sends";
import { STAFF_SEND_PURPOSES } from "@/server/services/messaging/template-text";
import { TemplateError } from "@/server/services/messaging/templates";
import { toActionFailure, type ActionResult } from "./application-errors";
import type { TransitionOutcome } from "./applications";

// Template messages staff send from the profile: "Send a message", the Move dialog's
// one-on-one invite and the Close dialog's decline. Each action starts with requireRole;
// Viewers never reach them. Staff pick a template and see it filled in; nothing is typed
// into a message, so no AI and no free text ever goes out from here.

const ACTORS: readonly UserRole[] = ["admin", "hiring_manager"];

async function run<T>(fn: (user: SessionUser) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole(ACTORS);
    return { ok: true, data: await fn(user) };
  } catch (error) {
    if (error instanceof TemplateError) {
      return { ok: false, status: error.code === "not_found" ? 404 : 400, code: error.code, message: error.message };
    }
    return toActionFailure(error);
  }
}

const uuid = z.uuid();
const purposeSchema = z.enum(STAFF_SEND_PURPOSES);

// The message as it would go now, for the dialogs' previews.
export async function previewMessageAction(raw: { applicationId: string; purpose: string }): Promise<ActionResult<SendPreview>> {
  return run(async () => {
    const input = z.object({ applicationId: uuid, purpose: purposeSchema }).parse(raw);
    return previewTemplateMessage(db, input.applicationId, input.purpose);
  });
}

// requestId comes from the dialog, once per opening, so a retried click queues one message.
const sendSchema = z.object({ applicationId: uuid, purpose: purposeSchema, requestId: uuid });

export async function sendMessageAction(raw: z.input<typeof sendSchema>): Promise<ActionResult<{ messageId: string; channel: "sms" | "email" }>> {
  return run(async (user) => {
    const input = sendSchema.parse(raw);
    const sent = await sendTemplateMessage(db, {
      applicationId: input.applicationId,
      purpose: input.purpose,
      actor: staffActor(user.id),
      dedupeKey: `staff_send:${input.purpose}:${input.requestId}`,
    });
    return { messageId: sent.messageId, channel: sent.channel };
  });
}

const baseSchema = z.object({
  applicationId: uuid,
  expectedSeq: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

function common(user: SessionUser, input: z.infer<typeof baseSchema>) {
  return {
    applicationId: input.applicationId,
    actor: staffActor(user.id),
    expectedSeq: input.expectedSeq,
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
    note: input.note ?? null,
  };
}

function outcome(result: Awaited<ReturnType<typeof transition>>): TransitionOutcome {
  return {
    applicationId: result.application.id,
    eventSeq: result.application.eventSeq,
    status: result.application.status,
    stageId: result.application.currentStageId,
    created: result.created,
  };
}

const moveSchema = baseSchema.extend({ toStageId: uuid });

// The Move dialog with "Also send the one-on-one invite" ticked: the move and exactly
// one invite, queued in the same transaction (messaging/after-transition.ts).
export async function moveWithInviteAction(raw: z.input<typeof moveSchema>): Promise<ActionResult<TransitionOutcome>> {
  return run(async (user) => {
    const input = moveSchema.parse(raw);
    const move: TransitionInput = { action: "move", ...common(user, input), toStageId: input.toStageId };
    return outcome(await transition(db, withMessages(move, { sendInvite: true })));
  });
}

const closeSchema = baseSchema.extend({
  outcome: z.enum(["disqualified", "not_selected"]),
  reasonOptionId: uuid,
  fcra: z.object({ backgroundCheckIds: z.array(uuid).optional(), notReportBased: z.boolean().optional() }).optional(),
});

// The Close dialog with "Send the decline message" ticked: the close and one decline.
export async function closeWithDeclineAction(raw: z.input<typeof closeSchema>): Promise<ActionResult<TransitionOutcome>> {
  return run(async (user) => {
    const input = closeSchema.parse(raw);
    const close: TransitionInput = {
      action: "close",
      ...common(user, input),
      outcome: input.outcome,
      reasonOptionId: input.reasonOptionId,
      fcra: input.fcra,
    };
    return outcome(await transition(db, withMessages(close, { sendDecline: true })));
  });
}
