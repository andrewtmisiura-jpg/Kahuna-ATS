// Report keys and option keys (DATA_MODEL.md, "Report keys never change once
// used"). Pure helpers with no database imports, so the editor dialog can show
// the key a prompt would get.

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function isValidKey(value: string) {
  return KEY_PATTERN.test(value);
}

// "What is the highest you have worked on a ladder?" -> "what_is_the_highest_you_have_worked_on"
export function slugKey(text: string, maxLength = 40): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!slug) return "";
  if (slug.length <= maxLength) return slug.replace(/^[0-9]+/, (digits) => `n${digits}`);
  const cut = slug.slice(0, maxLength);
  const atWord = cut.lastIndexOf("_");
  return (atWord > 8 ? cut.slice(0, atWord) : cut).replace(/^[0-9]+/, (digits) => `n${digits}`);
}

// A key that is not in `taken`: the base, else base_2, base_3 and so on.
export function uniqueKey(base: string, taken: ReadonlySet<string>, fallback = "item"): string {
  const root = base || fallback;
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
