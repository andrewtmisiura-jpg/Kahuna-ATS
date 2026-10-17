import { phase2Templates } from "./phase2-templates";
import { snowBehavioralQuestions } from "./snow-behavioral-questions";
import { snowStarterRubric } from "./snow-starter-rubric";
import type { Change } from "./types";

// Every one-time content change, oldest first. `pnpm db:changes` runs the ones
// not yet in applied_change, in this order. Never remove or rename an entry once
// it has shipped: the id is how production knows it already ran.
//
// snowStarterRubric reads the questions snowBehavioralQuestions publishes, so it
// stays after it; a new change goes at the end.

export const CHANGES: readonly Change[] = [snowBehavioralQuestions, phase2Templates, snowStarterRubric];

export type { Change, ChangeContext } from "./types";
export { ChangeError, runChanges, type ChangeReport } from "./runner";
