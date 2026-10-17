import type { ScoringAnswer, ScoringInput } from "./types";

// What the model is sent for one application (DATA_MODEL.md, ai_score.input_snapshot;
// Key invariants: "Nothing sent to the AI identifies the person or comes from a
// never-send question"). Pure: the scoring job loads the rows, this decides what goes.
// Only the answers to the lineages the rubric version's criteria read are taken, under
// a fresh random id; nothing about the person, the application or staff notes is, and
// email addresses, phone numbers and the person's own name typed into an answer are
// replaced with [redacted]. Nothing here reads the database or Node-only modules.

export const REDACTED = "[redacted]";

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
// US numbers as people type them: (612) 555-0123, 612-555-0123, 612.555.0123,
// 612 555 0123, 612 - 555 - 0123, 6125550123, +1 612 555 0123, 1-612-555-0123, and
// 555-0123 without the area code. Never part of a longer run of letters or digits.
const SEP = String.raw`(?:\s?[.-]\s?|\s)?`;
const PHONE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(?:\+?1${SEP})?(?:\(\d{3}\)${SEP}|\d{3}${SEP})\d{3}${SEP}\d{4}|\d{3}\s?[.-]\s?\d{4})(?![\p{L}\p{N}])`,
  "gu",
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Everyday words that are also people's names (Will, Long, Her, Van, Snow). A name made
// only of these is redacted where it is written capitalized, as a name is, so "I will
// tell the customer" or "as long as the job lasted" reaches the scorer whole for
// someone named Will or Long; a two-letter one (To, Do, Ho) goes only inside the full name.
const EVERYDAY_WORDS = new Set([
  // Two letters
  "an", "as", "at", "be", "by", "de", "do", "go", "ha", "he", "hi", "ho", "if", "in", "is", "it",
  "la", "ma", "me", "my", "no", "of", "oh", "ok", "on", "or", "so", "to", "up", "us", "we",
  // Longer
  "amber", "april", "art", "august", "baker", "banks", "bell", "bill", "bird", "black", "bob", "brown",
  "buck", "bud", "cash", "chase", "chin", "chip", "cook", "crystal", "daisy", "dawn", "day", "dean",
  "drew", "faith", "fox", "frank", "frost", "gene", "gold", "grace", "grant", "gray", "green", "grey",
  "guy", "hall", "hang", "hazel", "her", "hill", "holly", "honey", "hope", "hung", "hunt", "hunter",
  "iris", "ivy", "jack", "joy", "june", "king", "lam", "lane", "lily", "little", "long", "love",
  "mark", "may", "moon", "page", "pat", "penny", "price", "ray", "rice", "rich", "rob", "rose",
  "ruby", "rusty", "sandy", "sharp", "short", "sky", "snow", "son", "song", "stone", "strong", "sue",
  "summer", "sun", "sunny", "tan", "van", "white", "will", "wing", "winter", "wise", "wolf", "wood",
  "woods", "young",
]);

// The words of a name: Mary Ann, Van Dyke and Smith-Jones have two each.
function wordsOf(name: string): string[] {
  return name.split(/[\s-]+/);
}

// Every word starts with a capital letter, the way a name is written.
function capitalized(text: string): boolean {
  return wordsOf(text).every((word) => /^\p{Lu}/u.test(word));
}

type NamePattern = { pattern: RegExp; capitalizedOnly: boolean };

// A name as whole words, ignoring case: the name as given, the full name (first and
// last together) and, for a name of more than one word (Mary Ann, Van Dyke,
// Smith-Jones), each word of two letters or more. A name made only of everyday words
// counts only where it is capitalized.
function namePatterns(names: readonly (string | null | undefined)[]): NamePattern[] {
  const given = names.map((name) => name?.trim()).filter((name): name is string => Boolean(name));
  const candidates = new Set(given);
  if (given.length > 1) candidates.add(given.join(" "));
  for (const name of given) for (const part of wordsOf(name)) if (part.length >= 2) candidates.add(part);
  const patterns: NamePattern[] = [];
  // Longest first, so "Mary Ann" goes before "Mary" leaves "Ann" behind.
  for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
    const everyday = wordsOf(candidate).every((word) => EVERYDAY_WORDS.has(word.toLowerCase()));
    if (everyday && candidate.length <= 2) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(candidate).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "giu");
    patterns.push({ pattern, capitalizedOnly: everyday });
  }
  return patterns;
}

// The answer text with emails, US phone numbers and the given names replaced.
export function redactAnswerText(text: string, names: readonly (string | null | undefined)[] = []): string {
  let redacted = text.replace(EMAIL, REDACTED).replace(PHONE, REDACTED);
  for (const { pattern, capitalizedOnly } of namePatterns(names)) {
    redacted = redacted.replace(pattern, (match) => (capitalizedOnly && !capitalized(match) ? match : REDACTED));
  }
  return redacted;
}

// One question lineage a criterion reads, with the never-send flag from the question editor.
export type SnapshotLineage = { questionId: string; key: string; aiNeverSend: boolean };

// The application's answer to one lineage: the wording of the version the applicant saw
// and the answer as text (choices as their labels), null when it was left blank.
export type SnapshotAnswer = { questionId: string; prompt: string; text: string | null };

export type SnapshotSource = {
  // The rubric version's criteria in sort order, each with the lineages it reads.
  criteria: { criterionKey: string; questionIds: readonly string[] }[];
  lineages: readonly SnapshotLineage[];
  // Answers on the application's pinned form to those lineages; a lineage the form
  // does not carry has none.
  answers: readonly SnapshotAnswer[];
  // The person's first and last name, redacted wherever an answer repeats them.
  names: readonly (string | null | undefined)[];
};

export type ApplicationSnapshot = {
  input: ScoringInput;
  // Criteria with no answer at all. The job sends nothing when there is one: snow
  // applications on form v1 have no answers to the questions a v2 rubric reads.
  missingCriteria: string[];
};

export class NeverSendLineageError extends Error {
  constructor(readonly questionKeys: string[]) {
    super(`The rubric reads ${questionKeys.join(", ")}, marked never to send to the AI; publish a rubric version without it`);
    this.name = "NeverSendLineageError";
  }
}

export function buildApplicationSnapshot(source: SnapshotSource, anonymousId: string = crypto.randomUUID()): ApplicationSnapshot {
  const lineages = new Map(source.lineages.map((lineage) => [lineage.questionId, lineage]));
  const neverSend = source.criteria
    .flatMap((criterion) => criterion.questionIds)
    .map((questionId) => lineages.get(questionId))
    .filter((lineage) => lineage?.aiNeverSend)
    .map((lineage) => lineage!.key);
  if (neverSend.length > 0) throw new NeverSendLineageError([...new Set(neverSend)]);

  const answered = new Map(source.answers.map((answer) => [answer.questionId, answer]));
  const answers: ScoringAnswer[] = [];
  const missingCriteria: string[] = [];
  for (const criterion of source.criteria) {
    let any = false;
    for (const questionId of criterion.questionIds) {
      const lineage = lineages.get(questionId);
      const given = answered.get(questionId);
      const text = given?.text?.trim();
      if (!lineage || !given || !text) continue;
      answers.push({ criterionKey: criterion.criterionKey, questionKey: lineage.key, prompt: given.prompt, answer: redactAnswerText(text, source.names) });
      any = true;
    }
    if (!any) missingCriteria.push(criterion.criterionKey);
  }
  return { input: { anonymousId, answers }, missingCriteria };
}
