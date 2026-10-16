import type { AfterTransitionContext, Tx } from "../applications/after-transition";

// The interviews part of every transition: the interview record a move implies, for
// example a scheduled one-on-one when an application enters a one-on-one scheduled
// stage. Writes nothing until the interviews build fills it in; if interviews are only
// ever recorded from the profile, it stays empty.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a slot the interviews build fills in
export async function interviewsAfterTransition(tx: Tx, context: AfterTransitionContext): Promise<void> {}
