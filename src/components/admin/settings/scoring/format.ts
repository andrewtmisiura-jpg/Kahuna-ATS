import type { ReviewDecisionValue, ScoringMode } from "@/db/schema";
import type { TestCaseVariant } from "@/server/services/scoring/test-cases";

// Labels and small helpers for Settings > AI scoring. Type imports only, so the client
// components share them without pulling server code into the browser.

export const MODES: readonly ScoringMode[] = ["off", "hidden", "visible"];

export const MODE_LABELS: Record<ScoringMode, string> = {
  off: "Off",
  hidden: "Hidden",
  visible: "Visible",
};

export const MODE_EXPLANATIONS: Record<ScoringMode, string> = {
  off: "Nothing is scored.",
  hidden: "Scored to check the rubric, shown only on this page.",
  visible: "Staff see the score on the list, board and profile.",
};

export const VARIANT_LABELS: Record<TestCaseVariant, string> = {
  standard: "Standard",
  broken_english: "Broken English",
  short: "Short",
  other: "Other",
};

export const VARIANTS: readonly TestCaseVariant[] = ["standard", "broken_english", "short", "other"];

export const DECISION_LABELS: Record<ReviewDecisionValue, string> = {
  advance: "Advanced",
  hold: "On hold",
  decline: "Declined",
};

// "solid_answers" to "Solid answers".
export function groupLabel(key: string): string {
  const words = key.replaceAll("_", " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

// Each weight as a whole-number share of the total, for "30 (30% of the score)".
export function weightShare(weight: number, total: number): number | null {
  if (!Number.isFinite(weight) || weight <= 0 || !(total > 0)) return null;
  return Math.round((weight / total) * 100);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
