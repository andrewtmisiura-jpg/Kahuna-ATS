import type { QuestionValidation } from "@/db/schema/config";

// Pure helper shared by the editor service and its dialog. jsonb stores object
// keys in its own order, so two sets of limits are compared key by key.
export function sameValidation(a: QuestionValidation | null | undefined, b: QuestionValidation | null | undefined): boolean {
  const keys = ["min", "max", "integer", "maxLength"] as const;
  return keys.every((key) => (a?.[key] ?? null) === (b?.[key] ?? null));
}
