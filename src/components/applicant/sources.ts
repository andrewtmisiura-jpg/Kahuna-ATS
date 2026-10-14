// "How did you hear about us?" (DATA_MODEL.md, "Source field"): the fixed list
// behind application.source, asked on the landing form and, when left blank
// there, once at the end of the application.

export const SOURCES = [
  { key: "indeed", label: "Indeed" },
  { key: "referral", label: "Someone referred me" },
  { key: "current_employee", label: "I work for Kahuna now" },
  { key: "former_employee", label: "I worked for Kahuna before" },
  { key: "social_media", label: "Social media" },
  { key: "sign_or_walk_in", label: "Saw a sign or walked in" },
  { key: "other", label: "Other" },
] as const;

export type SourceKey = (typeof SOURCES)[number]["key"];

export function sourceKey(value: unknown): SourceKey | null {
  return SOURCES.find((s) => s.key === value)?.key ?? null;
}

// Referrals and "Other" carry a short detail (the referrer's name or the other text).
export function sourceTakesDetail(key: SourceKey | null): boolean {
  return key === "referral" || key === "other";
}
