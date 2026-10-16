import { snowBehavioralQuestions } from "./snow-behavioral-questions";
import type { Change } from "./types";

// Every one-time content change, oldest first. `pnpm db:changes` runs the ones
// not yet in applied_change, in this order. Never remove or rename an entry once
// it has shipped: the id is how production knows it already ran.

export const CHANGES: readonly Change[] = [snowBehavioralQuestions];

export type { Change, ChangeContext } from "./types";
export { ChangeError, runChanges, type ChangeReport } from "./runner";
