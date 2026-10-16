import { snowBehavioralQuestions } from "./snow-behavioral-questions";
import type { Change } from "./types";

// Every one-time content change, oldest first. `pnpm db:changes` runs the ones
// not yet in applied_change, in this order. Never remove or rename an entry once
// it has shipped: the id is how production knows it already ran.
//
// Two Phase 2 changes follow snowBehavioralQuestions, each built in its own file
// and added here when the builds are merged, in this order:
//   1. phase2Templates     id 2026-10-16-phase2-templates      (./phase2-templates.ts)
//   2. snowStarterRubric   id 2026-10-16-snow-starter-rubric   (./snow-starter-rubric.ts)

export const CHANGES: readonly Change[] = [snowBehavioralQuestions];

export type { Change, ChangeContext } from "./types";
export { ChangeError, runChanges, type ChangeReport } from "./runner";
