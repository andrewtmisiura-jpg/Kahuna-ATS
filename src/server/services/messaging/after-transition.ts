import type { AfterTransitionContext, Tx } from "../applications/after-transition";

// Messaging's part of every transition: the template a move sends, starting with the
// one-on-one invite (with {booking_link}) when an application enters a one-on-one
// invited stage. It queues through queueMessage inside the transition's transaction, so
// a move that rolls back sends nothing; the send rules still apply at send time. Queues
// nothing until the templates build fills it in.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a slot the templates build fills in
export async function messagesAfterTransition(tx: Tx, context: AfterTransitionContext): Promise<void> {}
