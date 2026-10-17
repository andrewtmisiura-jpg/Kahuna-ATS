import { describe, expect, it } from "vitest";
import { PHASE2_TEMPLATES } from "@/db/changes/phase2-templates";
import { FULL_DISCLOSURE, renderTemplate, withFullDisclosure } from "@/server/services/messaging/send";
import {
  checkTemplate,
  fillPlaceholders,
  formatCentralMoment,
  FULL_CLOSING,
  interviewReminderKey,
  moveSendsInvite,
  parseInterviewReminderKey,
  placeholdersIn,
  sampleValues,
  textLength,
  unplainCharacters,
  variablesIn,
  withFullClosing,
  type TemplateDraft,
} from "@/server/services/messaging/template-text";

// The template rules from content/legal/messages.md as the editor and the server both
// run them: placeholders, the checks a template passes before it is saved, rendering,
// a text's length in segments and the Central time format of {interview_time}.

const BRAND = "Kahuna Window Cleaning";
const SAMPLE = sampleValues({ brand: BRAND, hiringHost: "tidepool.kahunawindowcleaning.com", helpContact: null, bookingLinkUrl: null, roleTitle: null });
const INVITE_TEXT = "Kahuna Window Cleaning: Hi {first_name}, we'd like to interview you. Pick a time here: {booking_link} Reply STOP to opt out.";

function check(draft: Partial<TemplateDraft>) {
  return checkTemplate({ purpose: "one_on_one_invite", channel: "sms", name: "Invite", subject: null, body: INVITE_TEXT, ...draft }, { brand: BRAND, sample: SAMPLE });
}

function errors(draft: Partial<TemplateDraft>) {
  return check(draft).errors.map((e) => e.message);
}

function warnings(draft: Partial<TemplateDraft>) {
  return check(draft).warnings.map((e) => e.message);
}

describe("the Phase 2 templates as messages.md has them", () => {
  it("pass every check with no warnings", () => {
    for (const t of PHASE2_TEMPLATES) {
      const result = checkTemplate({ purpose: t.purpose, channel: t.channel, name: t.name, subject: t.subject ?? null, body: t.body }, { brand: BRAND, sample: SAMPLE });
      expect(result, `${t.purpose} ${t.channel}`).toEqual({ errors: [], warnings: [] });
    }
  });

  it("fit the segments messages.md counts, with an 11-letter first name", () => {
    const long = { ...SAMPLE, first_name: "Christopher" };
    const text = (purpose: string) => PHASE2_TEMPLATES.find((t) => t.purpose === purpose && t.channel === "sms")!.body;
    expect(textLength(fillPlaceholders(text("one_on_one_invite"), long))).toEqual({ characters: 159, segments: 1, plain: true });
    expect(textLength(fillPlaceholders(text("one_on_one_reminder"), long)).segments).toBe(1);
    expect(textLength(fillPlaceholders(text("decline"), long)).segments).toBe(1);
    expect(textLength(fillPlaceholders(text("status_update"), long)).segments).toBe(2);
  });
});

describe("placeholders", () => {
  it("finds what was typed and fills only the ones it knows", () => {
    expect(placeholdersIn("Hi {first_name}, {First Name} and {first_name}")).toEqual(["first_name", "First Name", "first_name"]);
    expect(variablesIn("Hi {first_name}, {First Name} and {first_name} {link}")).toEqual(["first_name", "link"]);
    expect(fillPlaceholders("Hi {first_name}, see {link} {nope}", { first_name: "Ana", link: "[application link]" })).toBe(
      "Hi Ana, see [application link] {nope}",
    );
  });

  it("rejects one Tidepool does not fill, and a lone brace", () => {
    expect(errors({ body: INVITE_TEXT.replace("{first_name}", "{First Name}") })).toContain(
      "{First Name} is not a placeholder Tidepool fills in. Pick one from the list, like {first_name}.",
    );
    expect(errors({ body: INVITE_TEXT.replace("{first_name}", "{firstname}") })[0]).toMatch(/\{firstname\} is not a placeholder/);
    expect(errors({ body: INVITE_TEXT.replace("{first_name}", "first_name}") })).toContain(
      "A { or } is missing its partner. Placeholders look like {first_name}.",
    );
  });

  it("requires the placeholder each purpose needs, in the message", () => {
    expect(errors({ body: INVITE_TEXT.replace(" {booking_link}", "") })).toContain("The invite needs {booking_link}, so they can pick a time.");
    expect(
      errors({ purpose: "one_on_one_reminder", body: "Kahuna Window Cleaning: Hi {first_name}, see you soon. Reply STOP to opt out." }),
    ).toContain("The reminder needs {interview_time}, so they know when to come.");
    expect(errors({ purpose: "status_update", body: "Kahuna Window Cleaning: Hi {first_name}, news. Reply STOP to opt out." })).toContain(
      "The status update needs {link}, so they can see where their application stands.",
    );
    expect(errors({ purpose: "decline", body: "Kahuna Window Cleaning: Hi {first_name}, thanks. Reply STOP to opt out." })).toEqual([]);
  });

  it("keeps {interview_time} to the reminder and the application link out of a subject", () => {
    expect(errors({ body: INVITE_TEXT.replace("Pick a time", "Your interview is {interview_time}. Pick a time") })).toContain(
      "{interview_time} only works in the one-on-one reminder, which knows the interview time.",
    );
    const email = { channel: "email" as const, purpose: "status_update" as const, body: "Hi {first_name},\n\nSee {link}\n" };
    expect(errors({ ...email, subject: "Your link {link}" })).toContain("The application link can only go in the message, not the subject.");
    expect(errors({ ...email, subject: "" })).toContain("Emails need a subject.");
    expect(errors({ ...email, subject: "Hi {first_name}" })).toEqual([]);
  });
});

describe("the rules every text follows", () => {
  it("starts with the brand and ends with a STOP closing", () => {
    expect(errors({ body: INVITE_TEXT.replace("Kahuna Window Cleaning: ", "") })).toContain(
      'Texts start with "Kahuna Window Cleaning:" so people know who is texting.',
    );
    expect(errors({ body: INVITE_TEXT.replace("Kahuna Window Cleaning:", "{employer_name}:") })).toEqual([]);
    expect(errors({ body: INVITE_TEXT.replace(" Reply STOP to opt out.", "") })).toContain(
      'Texts end with "Reply STOP to opt out." (or the longer closing with HELP and STOP).',
    );
    expect(errors({ body: INVITE_TEXT.replace("Reply STOP to opt out.", FULL_CLOSING) })).toEqual([]);
  });

  it("uses plain characters only, and names the ones to replace", () => {
    const curly = INVITE_TEXT.replace("we'd", "we\u2019d").replace("you.", "you \u2014 soon \u{1F600}.");
    expect(errors({ body: curly })).toContain("Texts can only use plain characters. Replace: curly apostrophe, long dash, emoji.");
    expect(unplainCharacters("caf\u00E9 \u0142")).toEqual(['"\u0142"']);
    // An email may carry them, with a nudge.
    const email = { channel: "email" as const, purpose: "decline" as const, subject: "Thanks", body: "Hi {first_name}, we\u2019re grateful." };
    expect(errors(email)).toEqual([]);
    expect(warnings(email)).toEqual(["Plain characters keep the email and the text alike. Consider replacing: curly apostrophe."]);
  });

  it("warns about long texts, the job title, a typed web address and two-character symbols", () => {
    const long = INVITE_TEXT.replace("Pick a time here:", "We would really like to meet you in person soon to talk about the job. Pick a time here:");
    expect(warnings({ body: long })).toContain(
      "With sample values this text is 2 segments (225 characters). Texts without the application link should fit in one (160 characters).",
    );
    expect(warnings({ body: INVITE_TEXT.replace("interview you", "interview you for {role_title}") })).toContain(
      "The job title is long. It reads better in emails than in texts.",
    );
    expect(warnings({ body: INVITE_TEXT.replace("{booking_link}", "https://cal.example.com/x {booking_link}") })).toContain(
      "Type {booking_link} or {link} instead of a web address, so the link stays right if it changes.",
    );
    expect(warnings({ body: INVITE_TEXT.replace("you.", "you [soon].") })).toContain(
      "^ [ ] ~ | \\ and the euro sign each count as two characters in a text.",
    );
  });

  it("needs a name, and holds name and length limits", () => {
    expect(errors({ name: "  " })).toContain("Give the template a name.");
    expect(errors({ name: "x".repeat(101) })).toContain("Keep the name under 100 characters.");
    expect(errors({ body: INVITE_TEXT.replace("Pick", "x".repeat(1600)) })).toContain("This text is too long. Keep it under 1,600 characters.");
    expect(errors({ body: "  " })).toEqual(["The message is empty."]);
  });
});

describe("segments", () => {
  it("counts GSM-7 at 160 and 153, the extension characters twice, and anything else at 70 and 67", () => {
    expect(textLength("a".repeat(160))).toEqual({ characters: 160, segments: 1, plain: true });
    expect(textLength("a".repeat(161))).toEqual({ characters: 161, segments: 2, plain: true });
    expect(textLength("a".repeat(306))).toEqual({ characters: 306, segments: 2, plain: true });
    expect(textLength("a".repeat(307)).segments).toBe(3);
    expect(textLength("[]").characters).toBe(4);
    expect(textLength("\u2019".repeat(70))).toEqual({ characters: 70, segments: 1, plain: false });
    expect(textLength("\u2019".repeat(71))).toEqual({ characters: 71, segments: 2, plain: false });
  });

  it("swaps in the full closing the way the send function does", () => {
    expect(FULL_CLOSING).toBe(FULL_DISCLOSURE);
    for (const body of [INVITE_TEXT, "No closing", `Already ${FULL_CLOSING}`]) expect(withFullClosing(body)).toBe(withFullDisclosure(body));
  });

  it("renders the same way the send function does for the placeholders both know", () => {
    const values = { first_name: "Ana", booking_link: "https://book.example.com/x" };
    expect(fillPlaceholders(INVITE_TEXT, values)).toBe(renderTemplate(INVITE_TEXT, values));
  });
});

describe("interview times", () => {
  it('read like "Tue, Nov 3 at 2:30 PM" in Central time, across the Nov 1 change', () => {
    expect(formatCentralMoment(new Date("2026-11-03T20:30:00Z"))).toBe("Tue, Nov 3 at 2:30 PM"); // CST
    expect(formatCentralMoment(new Date("2026-10-30T19:00:00Z"))).toBe("Fri, Oct 30 at 2:00 PM"); // CDT
    expect(formatCentralMoment(new Date("2026-11-01T06:30:00Z"))).toBe("Sun, Nov 1 at 1:30 AM"); // the first 1:30, CDT
    expect(formatCentralMoment(new Date("2026-11-01T07:30:00Z"))).toBe("Sun, Nov 1 at 1:30 AM"); // the second, CST
    expect(formatCentralMoment(new Date("2026-11-02T06:00:00Z"))).toBe("Mon, Nov 2 at 12:00 AM");
    expect(formatCentralMoment(new Date("2026-11-02T18:05:00Z"))).toBe("Mon, Nov 2 at 12:05 PM");
    expect(unplainCharacters(formatCentralMoment(new Date("2026-11-02T18:05:00Z")))).toEqual([]);
  });

  it("travel in the reminder's key, with or without the email fallback's suffix", () => {
    const at = new Date("2026-11-03T20:30:00Z");
    const id = "0199f000-0000-7000-8000-000000000001";
    const key = interviewReminderKey(id, at);
    expect(key).toBe(`interview:${id}:2026-11-03T20:30:00.000Z`);
    expect(parseInterviewReminderKey(key)).toEqual({ interviewId: id, scheduledAt: at });
    expect(parseInterviewReminderKey(`${key}:email`)).toEqual({ interviewId: id, scheduledAt: at });
    expect(parseInterviewReminderKey("reminder_24h:abc")).toBeNull();
    expect(parseInterviewReminderKey(null)).toBeNull();
  });
});

describe("the invite a move sends", () => {
  it("goes only with a move into an interview_invited stage from an earlier one", () => {
    const stage = (milestone: string | null, sortOrder: number) => ({ milestone, sortOrder });
    const invited = stage("interview_invited", 40);
    expect(moveSendsInvite(stage("submitted", 20), invited)).toBe(true);
    expect(moveSendsInvite(stage("reviewed", 30), invited)).toBe(true);
    // A custom stage counts by its place in the pipeline.
    expect(moveSendsInvite(stage(null, 35), invited)).toBe(true);
    expect(moveSendsInvite(stage(null, 65), invited)).toBe(false);
    // Moves back, and moves within the invited stages, bring no invite.
    for (const from of [stage("interviewed", 60), stage("offered", 70), stage("hired", 90), stage("interview_invited", 50)]) {
      expect(moveSendsInvite(from, invited)).toBe(false);
    }
    expect(moveSendsInvite(stage("submitted", 20), stage("reviewed", 30))).toBe(false);
    expect(moveSendsInvite(undefined, invited)).toBe(true);
  });
});
