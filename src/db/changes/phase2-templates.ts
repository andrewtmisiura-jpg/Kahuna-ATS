import { addMissingTemplates, type NewTemplate } from "@/server/services/messaging/templates";
import type { Change } from "./types";

// The Phase 2 templates (content/legal/messages.md, "Phase 2 templates"): the one-on-one
// invite and reminder, the status update and the decline, each as a text and an email,
// exactly as written there. group_invite has no wording yet (Indeed sends those invites),
// so it gets no row. A template already on file for a purpose and channel is never
// touched, so wording someone edited in Settings stays as they left it.

export const PHASE2_TEMPLATES: readonly NewTemplate[] = [
  {
    purpose: "one_on_one_invite",
    channel: "sms",
    name: "One-on-one invite (text)",
    body: "Kahuna Window Cleaning: Hi {first_name}, we'd like to interview you. Pick a time here: {booking_link} Reply STOP to opt out.",
  },
  {
    purpose: "one_on_one_invite",
    channel: "email",
    name: "One-on-one invite (email)",
    subject: "Interview invitation from Kahuna Window Cleaning",
    body: `Hi {first_name},

We read your application for the {role_title} job and we'd like to meet you.

Pick an interview time that works for you here:
{booking_link}

The interview takes about 30 minutes. The booking confirmation will have the location and anything you need to bring.

If none of the times work, reply to this email or call or text 763-292-2259 and we'll find one.

We look forward to meeting you.

Kahuna Window Cleaning Hiring`,
  },
  {
    purpose: "one_on_one_reminder",
    channel: "sms",
    name: "One-on-one reminder (text)",
    body: "Kahuna Window Cleaning: Hi {first_name}, reminder: your interview is {interview_time}. To change it, call or text 763-292-2259. Reply STOP to opt out.",
  },
  {
    purpose: "one_on_one_reminder",
    channel: "email",
    name: "One-on-one reminder (email)",
    subject: "Reminder: your interview with Kahuna Window Cleaning",
    body: `Hi {first_name},

A quick reminder that your interview with Kahuna Window Cleaning is {interview_time}.

The location and any details are in your booking confirmation. If you need to change the time, reply to this email or call or text 763-292-2259 as soon as you can.

See you then.

Kahuna Window Cleaning Hiring`,
  },
  {
    purpose: "status_update",
    channel: "sms",
    name: "Status update (text)",
    body: "Kahuna Window Cleaning: Hi {first_name}, there's an update on your job application. See it here: {link} Reply STOP to opt out.",
  },
  {
    purpose: "status_update",
    channel: "email",
    name: "Status update (email)",
    subject: "An update on your Kahuna Window Cleaning application",
    body: `Hi {first_name},

There's an update on your application for the {role_title} job. You can see where it stands here:
{link}

A person on our team reviews every application. If you have a question, reach us at {help_contact}.

Kahuna Window Cleaning Hiring`,
  },
  {
    purpose: "decline",
    channel: "sms",
    name: "Decline (text)",
    body: "Kahuna Window Cleaning: Hi {first_name}, thank you for applying with us. We won't be moving forward this time. We wish you well. Reply STOP to opt out.",
  },
  {
    purpose: "decline",
    channel: "email",
    name: "Decline (email)",
    subject: "Your application with Kahuna Window Cleaning",
    body: `Hi {first_name},

Thank you for applying for the {role_title} job at Kahuna Window Cleaning, and for the time you put into your application.

We won't be moving forward with your application this time.

We wish you the best in your search.

Kahuna Window Cleaning Hiring`,
  },
];

export const phase2Templates: Change = {
  id: "2026-10-16-phase2-templates",
  description: "Message templates: add the one-on-one invite and reminder, the status update and the decline, as texts and emails, where none is on file",
  async run(tx, ctx) {
    const { added, kept } = await addMissingTemplates(tx, { actor: ctx.actor, templates: PHASE2_TEMPLATES });
    const list = (items: readonly NewTemplate[]) => items.map((t) => `${t.purpose} ${t.channel}`).join(", ");
    ctx.log(added.length > 0 ? `added ${list(added)}` : "every Phase 2 template was already on file");
    if (kept.length > 0 && added.length > 0) ctx.log(`kept as they are: ${list(kept)}`);
  },
};
