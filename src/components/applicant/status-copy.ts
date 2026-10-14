// The status page strings (content/legal/messages.md, "Status page"). The public
// label comes from the stage; a closed application shows one fixed line whatever
// the stage, and never a reason.

export const HIRING_NUMBER = "763-292-2259";

export const STATUS_SENTENCES: Record<string, string> = {
  Received: "We have your application.",
  "Under review": "A person on our team is reading it.",
  Interview: "We'd like to meet you. Check your email or texts for scheduling.",
  Offer: "We've made you an offer. Check your email or texts for details.",
  "Background check": "Your offer is conditional on a background check. The background check company will contact you directly.",
  Hired: "Welcome aboard. Your start details will come from your manager.",
};

export const CLOSED_LINE = "This application is closed. Thank you for applying.";
export const REVIEWS_LINE = "A person on our team reviews every application.";
export const QUESTIONS_LINE = `Questions? Call or text ${HIRING_NUMBER}.`;

export type PublicStatus = {
  // The headline: the stage's public label, or "Closed".
  label: string;
  sentence: string;
  closed: boolean;
};

export function publicStatus(input: { status: "open" | "hired" | "closed"; stagePublicLabel: string }): PublicStatus {
  if (input.status === "closed") return { label: "Closed", sentence: CLOSED_LINE, closed: true };
  const label = input.stagePublicLabel.trim() || "Received";
  return { label, sentence: STATUS_SENTENCES[label] ?? REVIEWS_LINE, closed: false };
}

export const APPLICANT_COPY = {
  saved: "Saved",
  saving: "Saving",
  notSaved: "Not saved, check your connection",
  submitted: "We got it. A person on our team reviews every application within 3 business days. We sent a confirmation to your email.",
  checkMessages: `Check your messages. If you already have an application with us, we just sent your link to the phone number or email on file. Questions? Call or text ${HIRING_NUMBER}.`,
  lostLinkHeading: "Lost your link?",
  lostLinkHelp: "Enter the mobile number or email you applied with and we'll send your link again.",
  lostLinkSent: "If we have an application for you, your link is on its way.",
  expiredLink: "This link has expired. Ask for a new one here.",
  textsBlocked: `This number has opted out of texts from Kahuna Window Cleaning. To get texts again, text START to ${HIRING_NUMBER}. Until then we will email you.`,
  notOpen: `We're not taking applications for this job right now. Check back soon, or call or text ${HIRING_NUMBER}.`,
  tooManyLinks:
    "We've sent a few links to this number or email in the last hour. Check your messages, and try again in an hour if you still can't find it.",
  linkNotActive: "This link is not active.",
} as const;
