// The one-on-one scorecard (DATA_MODEL.md, interview_grade): the categories an
// interviewer grades from A+ to F. Keys are configuration, not an enum, so the owner
// can swap in their own scorecard here. A grade stored under a key that is later
// dropped stays on its interview, still shows on the profile and is never cleared by
// an edit made with the new scorecard.

export type InterviewCategory = { key: string; label: string };

export const INTERVIEW_CATEGORIES: readonly InterviewCategory[] = [
  { key: "reliability", label: "Reliability" },
  { key: "work_ethic", label: "Work ethic" },
  { key: "communication", label: "Communication" },
  { key: "coachability", label: "Coachability" },
  { key: "safety", label: "Safety awareness" },
  { key: "customer_presence", label: "Customer presence" },
];

export const INTERVIEW_CATEGORY_KEYS: readonly string[] = INTERVIEW_CATEGORIES.map((category) => category.key);
