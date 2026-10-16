// The protected-trait keyword scan of a score's rationales (DATA_MODEL.md, ai_score.keyword_hits).
// The model is told never to consider these traits; a rationale that names one anyway
// gets a chip on the profile for Admins and one alert, so a person reads it. A hit is a
// prompt to look, not proof of bias: "old" also turns up in "my old job". Whole words,
// any case. Pure, so the rubric editor's Try it can show the same chips.

export const PROTECTED_TRAIT_KEYWORDS: readonly string[] = [
  // Age
  "age",
  "aged",
  "old",
  "older",
  "young",
  "younger",
  "elderly",
  "retired",
  "retiree",
  // Pregnancy
  "pregnant",
  "pregnancy",
  // Religion
  "church",
  "mosque",
  "synagogue",
  "temple",
  "religious",
  "religion",
  "faith",
  // Disability and health
  "disabled",
  "disability",
  "disabilities",
  "handicap",
  "handicapped",
  "injury",
  "injuries",
  "injured",
  // National origin and language
  "accent",
  "english",
  "immigrant",
  "immigrants",
  "immigration",
  "citizen",
  "citizens",
  "citizenship",
  "foreign",
  "foreigner",
  "native",
  "nationality",
  // Race and ethnicity ("black" and "white" are left out: black ice and white-outs are snow work)
  "race",
  "racial",
  "ethnic",
  "ethnicity",
  "hispanic",
  "latino",
  "latina",
  "asian",
  "african",
  "caucasian",
  // Sex, gender and orientation
  "male",
  "female",
  "woman",
  "women",
  "man",
  "men",
  "gender",
  "transgender",
  "gay",
  "lesbian",
  // Marital and family status
  "married",
  "marriage",
  "divorced",
  "wife",
  "husband",
  "kids",
  "children",
  "family",
  // Public assistance and veteran status
  "welfare",
  "veteran",
  "veterans",
  // Criminal history
  "arrest",
  "arrested",
  "conviction",
  "convicted",
  "felony",
  "felon",
  "criminal",
  "jail",
  "prison",
  "probation",
  "parole",
  // Genetic information
  "genetic",
];

const KEYWORDS = new Set(PROTECTED_TRAIT_KEYWORDS);

// The keywords that appear as whole words in any of the texts, lowercased, in list order.
export function findProtectedTraitWords(texts: readonly (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const word of text?.toLowerCase().match(/[\p{L}]+/gu) ?? []) if (KEYWORDS.has(word)) found.add(word);
  }
  return PROTECTED_TRAIT_KEYWORDS.filter((keyword) => found.has(keyword));
}
