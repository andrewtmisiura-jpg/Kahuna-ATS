import type { AfterTransitionContext, Tx } from "../applications/after-transition";

// The interviews part of every transition. It writes nothing: interviews are recorded
// from the profile only. A move into a one-on-one stage does not schedule one, because
// the move dialog never asks the time, and closing or hiring an application leaves its
// interviews as they are; the profile's interviews panel points out one still
// scheduled on a closed application, so a person cancels it or records how it went.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- every area's hook takes the same arguments
export async function interviewsAfterTransition(tx: Tx, context: AfterTransitionContext): Promise<void> {}
