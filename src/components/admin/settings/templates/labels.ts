import type { TemplateVariable } from "@/server/services/messaging/template-text";

// Plain-words copy for Settings > Message templates: what each message is for and when
// it goes out, and what each placeholder turns into.

export const PURPOSE_COPY: Record<string, { title: string; when: string }> = {
  one_on_one_invite: {
    title: "One-on-one invite",
    when: "Sent when you move someone to One-on-one invited and leave the invite ticked, or from Send a message on their profile.",
  },
  one_on_one_reminder: {
    title: "One-on-one reminder",
    when: "Sent on its own for a booked interview: at 5pm the day before, or right away when the interview is less than 20 hours off.",
  },
  status_update: {
    title: "Status update",
    when: "Sent from Send a message on the profile. It points to their status page, so it never names a stage.",
  },
  decline: {
    title: "Decline",
    when: "Sent when you close someone as Disqualified or Not selected and tick Send the decline message, or from Send a message. Goes by email when they have one.",
  },
  resume_link: { title: "Application link", when: "Sent at once when someone starts an application." },
  link_recovery: { title: "Application link again", when: "Sent when someone asks for their link again, or staff resend it." },
  reminder_24h: { title: "Unfinished application reminder", when: "The one reminder the day after someone starts and does not finish." },
  submit_confirmation: { title: "Application received", when: "Sent when someone sends their application." },
  help_reply: { title: "HELP reply", when: "Sent when someone texts HELP to the hiring number." },
};

export const CHANNEL_LABELS: Record<"sms" | "email", string> = { sms: "Text", email: "Email" };

export const VARIABLE_HELP: Record<TemplateVariable, string> = {
  first_name: "Their first name as they typed it",
  link: "Their own application link, made when the message goes out (staff see [application link])",
  role_title: "The job title, for example Snow Removal Technician (on-call)",
  employer_name: "The company name",
  help_contact: "The help contact from Settings, Texting",
  booking_link: "The one-on-one booking link at the top of this page",
  session_date: "The date and time of their group session",
  interview_time: "The booked interview time, like Tue, Nov 3 at 2:30 PM (reminder only)",
};
