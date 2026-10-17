import { centralParts } from "../time";
import type { Channel, MessagePurpose } from "./send";

// What a message template may say and how it reads (content/legal/messages.md, "Rules
// every message follows" and "Variables"): the placeholders, which ones each purpose
// needs, the checks a template passes before it is saved, rendering for previews and a
// text's length in segments. No database or Node-only imports, so the template editor's
// live preview in the browser runs the same checks the server runs when it saves.

export const TEMPLATE_VARIABLES = [
  "first_name",
  "link",
  "role_title",
  "employer_name",
  "help_contact",
  "booking_link",
  "session_date",
  "interview_time",
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export function isTemplateVariable(value: string): value is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(value);
}

// The Phase 1 templates go out on their own (the link, the one reminder, the HELP reply)
// or at submit. Settings shows them read-only.
export const SYSTEM_PURPOSES = [
  "resume_link",
  "link_recovery",
  "reminder_24h",
  "submit_confirmation",
  "help_reply",
] as const satisfies readonly MessagePurpose[];

// The Phase 2 templates: the three staff send, and the reminder the cron sends for a booked interview.
export const EDITABLE_PURPOSES = ["one_on_one_invite", "one_on_one_reminder", "status_update", "decline"] as const satisfies readonly MessagePurpose[];
export type EditablePurpose = (typeof EDITABLE_PURPOSES)[number];

// What "Send a message" on the profile offers.
export const STAFF_SEND_PURPOSES = ["one_on_one_invite", "status_update", "decline"] as const satisfies readonly MessagePurpose[];
export type StaffSendPurpose = (typeof STAFF_SEND_PURPOSES)[number];

export function isEditablePurpose(purpose: string): purpose is EditablePurpose {
  return (EDITABLE_PURPOSES as readonly string[]).includes(purpose);
}

export function isStaffSendPurpose(purpose: string): purpose is StaffSendPurpose {
  return (STAFF_SEND_PURPOSES as readonly string[]).includes(purpose);
}

type StagePlace = { milestone: string | null; sortOrder: number };

// The Move dialog's one-on-one invite goes with a move into an interview_invited stage from
// an earlier one. Live stages follow the order of the milestones (the stage editor keeps
// them so), so earlier means earlier in the pipeline, which places custom stages too; a
// move back from One-on-one done, an offer or Hired brings no invite.
export function moveSendsInvite(from: StagePlace | undefined, to: StagePlace | undefined): boolean {
  if (to?.milestone !== "interview_invited" || from?.milestone === "interview_invited") return false;
  return !from || from.sortOrder < to.sortOrder;
}

// The placeholder a purpose is pointless without, in the message itself.
export const REQUIRED_VARIABLES: Record<EditablePurpose, readonly TemplateVariable[]> = {
  one_on_one_invite: ["booking_link"],
  one_on_one_reminder: ["interview_time"],
  status_update: ["link"],
  decline: [],
};

const REQUIRED_MESSAGES: Partial<Record<TemplateVariable, string>> = {
  booking_link: "The invite needs {booking_link}, so they can pick a time.",
  interview_time: "The reminder needs {interview_time}, so they know when to come.",
  link: "The status update needs {link}, so they can see where their application stands.",
};

// Only the one-on-one reminder knows an interview, so only it may say when.
export function variableAllowed(purpose: EditablePurpose, variable: TemplateVariable): boolean {
  return variable !== "interview_time" || purpose === "one_on_one_reminder";
}

// The two closings of send rule 4. send.ts swaps the short one for the full one on the
// first text after an opt-in (its FULL_DISCLOSURE is this same string).
export const SHORT_CLOSING = "Reply STOP to opt out.";
export const FULL_CLOSING = "Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";

// The first text after an opt-in, as the send function rewrites it.
export function withFullClosing(text: string): string {
  if (text.includes(FULL_CLOSING)) return text;
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(SHORT_CLOSING)) return `${trimmed.slice(0, -SHORT_CLOSING.length).trimEnd()} ${FULL_CLOSING}`;
  return `${trimmed} ${FULL_CLOSING}`;
}

// ---------------------------------------------------------------------------
// Placeholders and rendering

const PLACEHOLDER = /\{([^{}]*)\}/g;

// Every {name} in the text, as typed.
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

// The known placeholders the text uses, once each.
export function variablesIn(text: string): TemplateVariable[] {
  return [...new Set(placeholdersIn(text).filter(isTemplateVariable))];
}

function withoutPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER, "");
}

// Fills known placeholders from values; anything else stays as typed, so a preview shows it.
export function fillPlaceholders(text: string, values: Partial<Record<TemplateVariable, string>>): string {
  return text.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
    const value = isTemplateVariable(key) ? values[key] : undefined;
    return value ?? match;
  });
}

// ---------------------------------------------------------------------------
// Characters and segments

// GSM-7, the plain character set a text can carry in 160-character segments, and its
// extension table, whose characters count twice.
const GSM_BASIC = new Set(
  Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"),
);
const GSM_EXTENDED = new Set(Array.from("^{}\\[~]|€"));

// Names for the characters people paste in by accident, so the message says what to replace.
const CHARACTER_NAMES: Record<string, string> = {
  "\u2018": "curly apostrophe",
  "\u2019": "curly apostrophe",
  "\u201C": "curly quote",
  "\u201D": "curly quote",
  "\u2013": "dash",
  "\u2014": "long dash",
  "\u2026": "three-dot character",
  "\u00A0": "non-breaking space",
  "\u202F": "narrow space",
  "\u200D": "emoji",
  "\uFE0F": "emoji",
  "\t": "tab",
  "`": "backtick",
};

// The characters outside GSM-7, named for the person fixing them.
export function unplainCharacters(text: string): string[] {
  const names = new Set<string>();
  for (const char of text) {
    if (GSM_BASIC.has(char) || GSM_EXTENDED.has(char)) continue;
    names.add(CHARACTER_NAMES[char] ?? (/\p{Extended_Pictographic}/u.test(char) ? "emoji" : `"${char}"`));
  }
  return [...names];
}

export type TextLength = { characters: number; segments: number; plain: boolean };

// A GSM-7 text carries 160 characters in one segment and 153 per segment after that,
// the extension characters counting twice. Any other character turns the whole text into
// 70 and 67 (UTF-16 units, so an emoji counts twice). Each segment costs about a cent.
export function textLength(text: string): TextLength {
  let septets = 0;
  for (const char of text) {
    if (GSM_BASIC.has(char)) septets += 1;
    else if (GSM_EXTENDED.has(char)) septets += 2;
    else return { characters: text.length, segments: text.length <= 70 ? 1 : Math.ceil(text.length / 67), plain: false };
  }
  return { characters: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153), plain: true };
}

// ---------------------------------------------------------------------------
// The checks

export type TemplateDraft = { purpose: EditablePurpose; channel: Channel; name: string; subject: string | null; body: string };
export type TemplateIssue = { field: "name" | "subject" | "body"; message: string };
export type TemplateCheck = { errors: TemplateIssue[]; warnings: TemplateIssue[] };

export const TEMPLATE_LIMITS = { name: 100, subject: 150, smsBody: 1600, emailBody: 10_000 } as const;

// Errors block a save; warnings are shown beside the preview. `brand` is the employer's
// display name every text starts with; `sample` fills the placeholders for the length check.
export function checkTemplate(draft: TemplateDraft, context: { brand: string; sample: Record<TemplateVariable, string> }): TemplateCheck {
  const errors: TemplateIssue[] = [];
  const warnings: TemplateIssue[] = [];
  const sms = draft.channel === "sms";

  const name = draft.name.trim();
  if (!name) errors.push({ field: "name", message: "Give the template a name." });
  else if (name.length > TEMPLATE_LIMITS.name) errors.push({ field: "name", message: `Keep the name under ${TEMPLATE_LIMITS.name} characters.` });

  if (!sms) {
    const subject = draft.subject ?? "";
    if (!subject.trim()) errors.push({ field: "subject", message: "Emails need a subject." });
    else if (subject.trim().length > TEMPLATE_LIMITS.subject) {
      errors.push({ field: "subject", message: `Keep the subject under ${TEMPLATE_LIMITS.subject} characters.` });
    }
    if (/[\r\n]/.test(subject)) errors.push({ field: "subject", message: "The subject must be one line." });
    errors.push(...placeholderIssues("subject", subject, draft.purpose));
    if (variablesIn(subject).includes("link")) {
      errors.push({ field: "subject", message: "The application link can only go in the message, not the subject." });
    }
  }

  const body = draft.body;
  if (!body.trim()) {
    errors.push({ field: "body", message: "The message is empty." });
    return { errors, warnings };
  }
  const limit = sms ? TEMPLATE_LIMITS.smsBody : TEMPLATE_LIMITS.emailBody;
  if (body.length > limit) {
    errors.push({ field: "body", message: `This ${sms ? "text" : "email"} is too long. Keep it under ${limit.toLocaleString("en-US")} characters.` });
  }
  errors.push(...placeholderIssues("body", body, draft.purpose));
  const used = variablesIn(body);
  for (const required of REQUIRED_VARIABLES[draft.purpose]) {
    if (!used.includes(required)) errors.push({ field: "body", message: REQUIRED_MESSAGES[required] ?? `This template needs {${required}}.` });
  }

  const typed = withoutPlaceholders(body);
  if (/https?:\/\/|www\./i.test(typed)) {
    warnings.push({ field: "body", message: "Type {booking_link} or {link} instead of a web address, so the link stays right if it changes." });
  }
  const odd = unplainCharacters(sms ? typed : `${typed}${withoutPlaceholders(draft.subject ?? "")}`);

  if (sms) {
    const start = body.trimStart();
    if (!start.startsWith(`${context.brand}:`) && !start.startsWith("{employer_name}:")) {
      errors.push({ field: "body", message: `Texts start with "${context.brand}:" so people know who is texting.` });
    }
    const end = body.trimEnd();
    if (!end.endsWith(SHORT_CLOSING) && !end.endsWith(FULL_CLOSING)) {
      errors.push({ field: "body", message: `Texts end with "${SHORT_CLOSING}" (or the longer closing with HELP and STOP).` });
    }
    if (odd.length > 0) errors.push({ field: "body", message: `Texts can only use plain characters. Replace: ${odd.join(", ")}.` });
    // A stray brace is already an error above.
    if ([...typed].some((char) => GSM_EXTENDED.has(char) && char !== "{" && char !== "}")) {
      warnings.push({ field: "body", message: "^ [ ] ~ | \\ and the euro sign each count as two characters in a text." });
    }
    if (used.includes("role_title")) {
      warnings.push({ field: "body", message: "The job title is long. It reads better in emails than in texts." });
    }
    const length = textLength(fillPlaceholders(body, context.sample));
    const fits = used.includes("link") ? 2 : 1;
    if (length.segments > fits) {
      warnings.push({
        field: "body",
        message:
          `With sample values this text is ${length.segments} segments (${length.characters} characters). ` +
          (fits === 1 ? "Texts without the application link should fit in one (160 characters)." : "Texts with the application link should fit in two."),
      });
    }
  } else if (odd.length > 0) {
    warnings.push({ field: "body", message: `Plain characters keep the email and the text alike. Consider replacing: ${odd.join(", ")}.` });
  }
  return { errors, warnings };
}

function placeholderIssues(field: TemplateIssue["field"], text: string, purpose: EditablePurpose): TemplateIssue[] {
  const messages = new Set<string>();
  for (const name of placeholdersIn(text)) {
    if (!isTemplateVariable(name)) messages.add(`{${name}} is not a placeholder Tidepool fills in. Pick one from the list, like {first_name}.`);
    else if (!variableAllowed(purpose, name)) messages.add("{interview_time} only works in the one-on-one reminder, which knows the interview time.");
  }
  if (/[{}]/.test(withoutPlaceholders(text))) messages.add("A { or } is missing its partner. Placeholders look like {first_name}.");
  return [...messages].map((message) => ({ field, message }));
}

// ---------------------------------------------------------------------------
// Sample values

// Stand-ins for the preview and the length check, as long as the real thing: the link is
// the length the send mints for this host (a 22-character token) and the booking link
// sample is 50 characters, the length messages.md measures with.
export function sampleValues(input: {
  brand: string;
  hiringHost: string;
  helpContact: string | null;
  bookingLinkUrl: string | null;
  roleTitle: string | null;
}): Record<TemplateVariable, string> {
  return {
    first_name: "Marcus",
    link: `https://${input.hiringHost}/r#Xq3v9TzR2mLp8sKw4bNc1A`,
    role_title: input.roleTitle ?? "Snow Removal Technician (on-call)",
    employer_name: input.brand,
    help_contact: input.helpContact ?? "763-292-2259 (call or text)",
    booking_link: input.bookingLinkUrl ?? "https://book.example.com/kahuna-hiring/interview30",
    session_date: "Tue, Nov 3 at 6:00 PM",
    interview_time: "Tue, Nov 3 at 2:30 PM",
  };
}

// ---------------------------------------------------------------------------
// Time placeholders

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Tue, Nov 3 at 2:30 PM" in Central time, for {interview_time} and {session_date}. Built
// from the parts, because Intl's time format puts a narrow no-break space before PM and
// that character is not plain GSM-7.
export function formatCentralMoment(instant: Date): string {
  const p = centralParts(instant);
  const hour = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${WEEKDAYS[p.weekday]}, ${MONTHS[p.month - 1]} ${p.day} at ${hour}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "AM" : "PM"}`;
}

// The one-on-one reminder's dedupe key: one reminder per interview per booked time. The
// key is also where a reminder keeps its time, so the email that replaces a text that
// cannot go (send rule 2) says the same {interview_time}; the fallback adds ":email".
export function interviewReminderKey(interviewId: string, scheduledAt: Date): string {
  return `interview:${interviewId}:${scheduledAt.toISOString()}`;
}

export function parseInterviewReminderKey(key: string | null): { interviewId: string; scheduledAt: Date } | null {
  const match = key ? /^interview:([0-9a-f-]{36}):(.+?)(?::email)?$/.exec(key) : null;
  if (!match) return null;
  const scheduledAt = new Date(match[2]!);
  return Number.isNaN(scheduledAt.getTime()) ? null : { interviewId: match[1]!, scheduledAt };
}
