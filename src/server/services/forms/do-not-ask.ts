// The do-not-ask list (DATA_MODEL.md, "Do-not-ask list"): topics an application
// form must not ask about, shown in the question editor for every role, and a
// keyword matcher that gives a soft warning while someone types new wording.
// The warning never blocks a save or a publish; the editor decides.

export type DoNotAskTopic = {
  key: string;
  // Staff-facing name of the topic.
  topic: string;
  // Why, or the one allowed exception, in plain words.
  note: string;
  // Lowercase phrases matched on word boundaries. Keep them to words that only
  // appear when the topic is really being asked about: the seeded questions
  // ("18 or older", "valid driver's license", "with or without reasonable
  // accommodation") must not trip them.
  keywords: readonly string[];
};

export const DO_NOT_ASK_LIST: readonly DoNotAskTopic[] = [
  {
    key: "criminal_history",
    topic: "Criminal history",
    note: "Only after a conditional offer, and then through the background check, never on the form.",
    keywords: ["criminal", "conviction", "convicted", "arrest", "arrested", "felony", "misdemeanor", "jail", "prison", "parole", "probation"],
  },
  {
    key: "age",
    topic: "Date of birth or age",
    note: "The one allowed question is \"Are you 18 or older?\".",
    keywords: ["date of birth", "birth date", "birthday", "how old", "your age", "age", "year were you born", "graduation year", "retire", "retired"],
  },
  {
    key: "ssn",
    topic: "Social Security number",
    note: "Collected at hire on the tax forms, never on the application.",
    keywords: ["social security", "ssn", "social security number"],
  },
  {
    key: "license_number",
    topic: "Driver's license number",
    note: "Asking whether they have a valid license is fine; the number is collected at hire.",
    keywords: ["license number", "licence number", "driver's license number", "dl number"],
  },
  {
    key: "home_address",
    topic: "Home address",
    note: "Ask whether they can get to the shop or job sites instead.",
    keywords: ["home address", "street address", "mailing address", "your address", "where do you live", "zip code", "postal code"],
  },
  {
    key: "photo",
    topic: "Photo",
    note: "No photos, selfies or video on the application.",
    keywords: ["photo", "photograph", "picture of yourself", "selfie", "headshot", "video of yourself"],
  },
  {
    key: "pay_history",
    topic: "Prior pay or pay history",
    note: "Banned in Minnesota since 2024. Pay expectations for this job are fine.",
    keywords: ["salary history", "pay history", "prior pay", "previous pay", "previous salary", "current salary", "current pay", "last salary", "how much did you make", "how much do you make", "wage history", "hourly rate at", "what were you paid", "what are you paid"],
  },
  {
    key: "family_status",
    topic: "Marital or familial status",
    note: "Includes children, pregnancy and childcare. Ask about availability instead.",
    keywords: ["marital", "married", "single or married", "spouse", "husband", "wife", "children", "kids", "pregnant", "pregnancy", "childcare", "child care", "family status", "dependents"],
  },
  {
    key: "public_assistance",
    topic: "Status with regard to public assistance",
    note: "Protected under the Minnesota Human Rights Act.",
    keywords: ["public assistance", "welfare", "food stamps", "snap benefits", "unemployment benefits", "government assistance", "section 8"],
  },
  {
    key: "health",
    topic: "Health or disability",
    note: "The one allowed form is the essential-functions question, \"Can you do this work, with or without reasonable accommodation?\".",
    keywords: ["disability", "disabled", "medical", "health condition", "illness", "injury", "injuries", "medication", "workers' comp", "workers comp", "surgery", "mental health", "how tall", "your weight", "how much do you weigh", "physical condition", "sick days"],
  },
  {
    key: "protected_traits",
    topic: "Race, color, creed, religion, national origin, sex, sexual orientation, gender identity",
    note: "Never asked. Work authorization is confirmed at hire on the I-9.",
    keywords: ["race", "racial", "ethnic", "ethnicity", "religion", "religious", "church", "creed", "national origin", "nationality", "where were you born", "country of origin", "citizen", "citizenship", "native language", "first language", "accent", "sex", "gender", "sexual orientation", "gender identity", "transgender"],
  },
  {
    key: "human_rights_commission",
    topic: "Membership or activity in a local human rights commission",
    note: "Protected under the Minnesota Human Rights Act.",
    keywords: ["human rights commission"],
  },
];

export type DoNotAskMatch = {
  topic: DoNotAskTopic;
  // The phrases from the topic's list that appeared in the text.
  matched: string[];
};

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const patterns = DO_NOT_ASK_LIST.map((topic) => ({
  topic,
  keywords: topic.keywords.map((keyword) => ({
    keyword,
    // Word boundaries on both sides so "age" never matches "manage" or "page";
    // a plural is allowed ("arrests", "kids"). Straight and curly apostrophes
    // count as the same character.
    regex: new RegExp(`(?<![a-z0-9])${escapeRegex(keyword).replace(/'/g, "['’]")}(?:e?s)?(?![a-z0-9])`, "i"),
  })),
}));

// Returns the do-not-ask topics whose keywords appear in the text, in list order.
// Prompt, help text and option labels are usually passed together.
export function matchDoNotAsk(text: string): DoNotAskMatch[] {
  const normalized = text.normalize("NFKC");
  if (!normalized.trim()) return [];
  const matches: DoNotAskMatch[] = [];
  for (const entry of patterns) {
    const matched = entry.keywords.filter(({ regex }) => regex.test(normalized)).map(({ keyword }) => keyword);
    if (matched.length > 0) matches.push({ topic: entry.topic, matched });
  }
  return matches;
}

// The text a question puts in front of an applicant, joined for one matcher pass.
export function questionTextForMatching(input: { prompt: string; help?: string | null; options?: { label: string }[] | null }) {
  return [input.prompt, input.help ?? "", ...(input.options ?? []).map((option) => option.label)].join("\n");
}
