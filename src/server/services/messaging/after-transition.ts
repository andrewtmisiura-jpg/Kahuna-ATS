import { and, eq, inArray } from "drizzle-orm";
import { message } from "@/db/schema";
import type { AfterTransitionContext, Tx } from "../applications/after-transition";
import type { TransitionInput } from "../applications/transition";
import { queueTemplateMessage } from "./staff-sends";
import { TemplateError } from "./templates";

// Messaging's part of every transition: the template a staff move or close asks to send
// with it. The Move dialog's "Also send the one-on-one invite" queues one invite (with
// {booking_link}) when the move enters an interview_invited stage, and the Close dialog's
// "Send the decline message" queues one decline on a disqualified or not-selected close.
// Both go through queueMessage inside the transition's transaction, so a move that rolls
// back sends nothing; the cron sends them, and the send rules apply then. Undoing that
// move or close cancels its message if it has not gone yet.
//
// TransitionInput has no field for this, so those dialogs' actions add `messages` to the
// same input object, which transition() hands to afterTransition unchanged (withMessages).
// Board drags, row moves and bulk moves never set it, so they send nothing.

export type TransitionMessages = { sendInvite?: boolean; sendDecline?: boolean };

export function withMessages<T extends TransitionInput>(input: T, messages: TransitionMessages): T & { messages: TransitionMessages } {
  return { ...input, messages };
}

function requested(input: TransitionInput): TransitionMessages {
  return (input as TransitionInput & { messages?: TransitionMessages }).messages ?? {};
}

// The invite or decline a move or close queued, and the email standing in for its text
// (send.ts gives the fallback the same key plus ":email").
export function messageKeysFor(eventId: string): string[] {
  return [`invite:${eventId}`, `decline:${eventId}`].flatMap((key) => [key, `${key}:email`]);
}

// Undo last change voids the move or close; whatever it queued that is still waiting is
// canceled in the same transaction, so the applicant never gets an invite or a decline
// for a change that no longer counts. One already sent stays as it is.
async function cancelUndoneMessages(tx: Tx, { event, now }: AfterTransitionContext): Promise<void> {
  if (!event.voidsEventId) return;
  await tx
    .update(message)
    .set({ status: "canceled", errorCode: "change_undone", updatedAt: now })
    .where(and(eq(message.applicationId, event.applicationId), inArray(message.dedupeKey, messageKeysFor(event.voidsEventId)), eq(message.status, "queued")));
}

export async function messagesAfterTransition(tx: Tx, context: AfterTransitionContext): Promise<void> {
  if (context.event.kind === "event_voided") return cancelUndoneMessages(tx, context);
  const asked = requested(context.input);
  if (!asked.sendInvite && !asked.sendDecline) return;
  const { input, event, toStage } = context;
  if (input.actor.type !== "staff") throw new TemplateError("not_sendable", "Only staff send templates");

  if (asked.sendInvite) {
    if (event.kind !== "stage_changed" || toStage?.milestone !== "interview_invited") {
      throw new TemplateError("not_sendable", "The invite goes with a move into a one-on-one invited stage.");
    }
    await queueTemplateMessage(tx, {
      applicationId: event.applicationId,
      purpose: "one_on_one_invite",
      actor: input.actor,
      dedupeKey: `invite:${event.id}`,
      via: "move",
      eventId: event.id,
      now: context.now,
    });
  }

  if (asked.sendDecline) {
    if (event.kind !== "closed" || (event.closedOutcome !== "disqualified" && event.closedOutcome !== "not_selected")) {
      throw new TemplateError("not_sendable", "The decline goes with closing someone as Disqualified or Not selected.");
    }
    await queueTemplateMessage(tx, {
      applicationId: event.applicationId,
      purpose: "decline",
      actor: input.actor,
      dedupeKey: `decline:${event.id}`,
      via: "close",
      eventId: event.id,
      now: context.now,
    });
  }
}
