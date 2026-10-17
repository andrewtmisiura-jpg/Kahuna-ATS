// Name matching for group interview attendees (DATA_MODEL.md, attendee): a name
// match is only ever a suggestion a staff member confirms or dismisses; only an
// exact mobile links on its own. Two names match when the last names are the same
// and either the first names are the same or only the first initials agree, so
// "J. Smith" and "Jonathan Smith" on a sign-up sheet still find Jon Smith's
// application. Case, accents, punctuation, middle names and a Jr. or Sr. are ignored.

export type NameMatch = "same_name" | "initial_and_last";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function withoutSuffix(list: string[]): string[] {
  return list.length > 1 && SUFFIXES.has(list[list.length - 1]!) ? list.slice(0, -1) : list;
}

// The words of a name as written, in first-to-last order: "Smith, Jon" is read as
// "Jon Smith", and "Jon Smith, Jr." keeps its order.
export function nameWords(name: string): string[] {
  const parts = name.split(",");
  if (parts.length === 2) {
    const [before, after] = [words(parts[0]!), words(parts[1]!)];
    if (after.length > 0 && after.every((word) => SUFFIXES.has(word))) return withoutSuffix([...before, ...after]);
    if (before.length > 0 && after.length > 0) return withoutSuffix([...after, ...before]);
  }
  return withoutSuffix(words(name));
}

// How a name as written matches a person's first and last name, if at all.
export function matchName(nameAsWritten: string, firstName: string | null, lastName: string | null): NameMatch | null {
  const written = nameWords(nameAsWritten);
  const first = nameWords(firstName ?? "");
  const last = nameWords(lastName ?? "");
  if (written.length < 2 || first.length === 0 || last.length === 0 || written.length <= last.length) return null;
  const tail = written.slice(written.length - last.length);
  if (tail.join(" ") !== last.join(" ")) return null;
  if (written[0] === first[0]) return "same_name";
  return written[0]![0] === first[0]![0] ? "initial_and_last" : null;
}
