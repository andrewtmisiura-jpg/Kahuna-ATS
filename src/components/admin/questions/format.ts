import type { QuestionType } from "@/db/schema";
import { CENTRAL_TZ } from "@/server/services/time";

// Display helpers for the question editor. Times are shown in Central time, the
// way every staff page reports them.

const dateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatCentral(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return dateTime.format(date);
}

export const TYPE_LABELS: Record<QuestionType, string> = {
  short_text: "Short answer",
  long_text: "Long answer",
  single_choice: "Pick one",
  multi_choice: "Pick all that apply",
  yes_no: "Yes or no",
  date: "Date",
  number: "Number",
};

export const TYPE_ORDER: QuestionType[] = ["short_text", "long_text", "single_choice", "multi_choice", "yes_no", "date", "number"];

export function isChoiceType(type: QuestionType) {
  return type === "single_choice" || type === "multi_choice";
}

export function isTextType(type: QuestionType) {
  return type === "short_text" || type === "long_text";
}

// "true" and "false" are how yes/no attention values are stored.
export function attentionLabel(type: QuestionType, value: string, options: { key: string; label: string }[] | null): string {
  if (type === "yes_no") return value === "true" ? "Yes" : value === "false" ? "No" : value;
  return options?.find((option) => option.key === value)?.label ?? value;
}
