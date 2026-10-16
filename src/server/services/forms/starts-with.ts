// The "Answer must start with this word" check (question_version.starts_with_check).
// It tests whether the applicant read the instruction, so it is deliberately
// forgiving about everything except the word itself. Pure helpers with no
// database imports, so the profile, the exports and the editor dialog share them.
//
// An answer passes when, after trimming whitespace and stripping any leading
// quote or punctuation characters, it starts with the word, ignoring case, and
// the word is followed by a non-letter or the end of the answer:
//   "Blue."  "blue, my boss..."  "BLUE"  "'Blue' was..."  pass
//   "Bluebird"  "My answer: Blue"                          fail

export type StartsWithResult = "pass" | "fail";

const LEADING_PUNCTUATION = /^[\s\p{P}]+/u;
const LETTER = /\p{L}/u;
// One word: letters, digits, an apostrophe or a hyphen inside, up to 40 characters.
const WORD = /^[\p{L}\p{N}][\p{L}\p{N}'’-]{0,39}$/u;

export const STARTS_WITH_MAX_LENGTH = 40;

// Null when there is nothing to check: no word set, or the question is unanswered.
export function checkStartsWith(answer: string | null | undefined, word: string | null | undefined): StartsWithResult | null {
  const target = word?.trim().normalize("NFKC") ?? "";
  if (!target) return null;
  const text = (answer ?? "").normalize("NFKC").trim();
  if (!text) return null;
  const rest = text.replace(LEADING_PUNCTUATION, "");
  const head = rest.slice(0, target.length);
  if (head.toLocaleLowerCase("en-US") !== target.toLocaleLowerCase("en-US")) return "fail";
  const next = rest.charAt(target.length);
  return next === "" || !LETTER.test(next) ? "pass" : "fail";
}

// Editor input: trimmed, a single word, or null when blank. Returns undefined when
// the value is not a single word, so the caller can refuse it.
export function cleanStartsWithWord(value: string | null | undefined): string | null | undefined {
  const trimmed = value?.trim().normalize("NFKC") ?? "";
  if (!trimmed) return null;
  return WORD.test(trimmed) ? trimmed : undefined;
}

// Staff-facing labels for the profile badge.
export const STARTS_WITH_LABELS: Record<StartsWithResult, string> = {
  pass: "Followed the instruction",
  fail: "Did not follow the instruction",
};
