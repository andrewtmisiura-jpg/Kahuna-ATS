import { readFileSync } from "node:fs";
import path from "node:path";

export type LegalTextKind = "sms_consent" | "privacy_policy" | "sms_terms" | "landing_notice" | "ai_disclosure";

export type SeedLegalText = { kind: LegalTextKind; body: string; changeNote: string };

// Wording from DATA_MODEL.md ("Legal text and templates"), verbatim.
const SMS_CONSENT_V1 =
  "Text me my application link and updates about this application (optional). I agree that Kahuna Window Cleaning may text me at the number above about my job application: my application link, reminders, interview scheduling, status updates and decisions. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Consent is not a condition of applying. See our SMS Terms and Privacy Policy.";

const LANDING_NOTICE_V1 = "Any background check happens only after a conditional job offer.";

const AI_DISCLOSURE_V1 =
  "We may use software, including AI tools, to help organize and summarize applications. A person makes every hiring decision.";

// The privacy policy and SMS terms are not written in the data model; the drafts in
// content/legal carry their own "Draft for owner approval" box and OWNER INPUT
// placeholders, which is the DRAFT marker. Replace the files before the production seed.
function loadDraft(file: string): string {
  const fullPath = path.join(process.cwd(), "content", "legal", file);
  const raw = readFileSync(fullPath, "utf8");
  // Drop the builder's HTML comment at the top; the draft box in the body stays.
  const body = raw.replace(/^<!--[\s\S]*?-->\s*/, "").trim();
  if (!body.includes("Draft for owner approval")) {
    throw new Error(`content/legal/${file} has lost its draft box; confirm it is the approved text, then update the seed`);
  }
  return body;
}

export function seedLegalTexts(): SeedLegalText[] {
  return [
    { kind: "sms_consent", body: SMS_CONSENT_V1, changeNote: "v1 from DATA_MODEL.md: consent covers this application only" },
    { kind: "landing_notice", body: LANDING_NOTICE_V1, changeNote: "v1 from DATA_MODEL.md" },
    { kind: "ai_disclosure", body: AI_DISCLOSURE_V1, changeNote: "v1 from DATA_MODEL.md, shown on every landing page from launch" },
    {
      kind: "privacy_policy",
      body: loadDraft("privacy-policy.md"),
      changeNote: "DRAFT v1 seeded from content/legal/privacy-policy.md; needs the owner's approval and the OWNER INPUT values",
    },
    {
      kind: "sms_terms",
      body: loadDraft("sms-terms.md"),
      changeNote: "DRAFT v1 seeded from content/legal/sms-terms.md; needs the owner's approval and the OWNER INPUT values",
    },
  ];
}
