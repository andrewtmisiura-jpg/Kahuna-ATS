import type { Db } from "@/db";
import type { pipelineStage } from "@/db/schema";
import { interviewsAfterTransition } from "../interviews/after-transition";
import { messagesAfterTransition } from "../messaging/after-transition";
import { scoringAfterTransition } from "../scoring/after-transition";
import type { EventRow } from "./replay";
import type { ApplicationRow, TransitionInput } from "./transition";

// Phase 2 work that belongs to a transition and commits or rolls back with it
// (DATA_MODEL.md, review_decision: a decision is written "in the same transaction").
// transition() calls afterTransition once per event, inside its transaction, after the
// event is written and the cached columns are re-derived. Each area owns its function,
// so none of them edits transition.ts; they run in this order:
//   scoring     the screening review decision, and a score job when an application is submitted
//   messaging   the message a move sends, such as the one-on-one invite
//   interviews  the interview record a move implies
// A throw rolls the whole transition back, the event included.

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type StageRow = typeof pipelineStage.$inferSelect;

export type AfterTransitionContext = {
  input: TransitionInput;
  // The application as locked before this event, and after the cache update.
  before: ApplicationRow;
  after: ApplicationRow;
  // The event just written, and every earlier event of the application in seq order,
  // voided ones included (replay.ts reads them).
  event: EventRow;
  earlierEvents: EventRow[];
  // The stage before the event, and the stage it names as its target (null when it names none).
  fromStage: StageRow;
  toStage: StageRow | null;
  now: Date;
};

export async function afterTransition(tx: Tx, context: AfterTransitionContext): Promise<void> {
  await scoringAfterTransition(tx, context);
  await messagesAfterTransition(tx, context);
  await interviewsAfterTransition(tx, context);
}
