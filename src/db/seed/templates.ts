export type SeedTemplate = {
  purpose: "resume_link" | "link_recovery" | "reminder_24h" | "submit_confirmation" | "help_reply";
  channel: "sms" | "email";
  name: string;
  subject?: string;
  body: string;
};

// Phase 1 templates (DATA_MODEL.md, "Templates", with the full email bodies from
// content/legal/messages.md). Variables: {first_name}, {link}, {role_title},
// {employer_name}, {help_contact}. Texts carrying a link already end with the full
// disclosure; the send function swaps it in anyway on the first text after an opt-in.
export const seedTemplates: SeedTemplate[] = [
  {
    purpose: "resume_link",
    channel: "sms",
    name: "Application link (text)",
    body: "Kahuna Window Cleaning: Hi {first_name}, here's your link to finish your job application: {link} Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
  },
  {
    purpose: "resume_link",
    channel: "email",
    name: "Application link (email)",
    subject: "Your Kahuna Window Cleaning application link",
    body: `Hi {first_name},

Thanks for starting your application for the {role_title} job at Kahuna Window Cleaning.

Here is your personal link to finish it:
{link}

It works on any phone or computer, and your answers are saved as you go, so you can stop and come back. The link stays active as long as you use it at least once every 30 days.

Please don't forward this link. Anyone who has it can open your application.

Questions? Reach us at {help_contact}, or just reply to this email.

Kahuna Window Cleaning Hiring`,
  },
  {
    purpose: "link_recovery",
    channel: "sms",
    name: "Application link again (text)",
    body: "Kahuna Window Cleaning: Hi {first_name}, here's your application link again: {link} Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
  },
  {
    purpose: "link_recovery",
    channel: "email",
    name: "Application link again (email)",
    subject: "Your Kahuna Window Cleaning application link, again",
    body: `Hi {first_name},

Here is your application link again:
{link}

If you've already submitted, the same link shows where your application stands.

If you didn't ask for this, you can ignore it. Nothing changes unless you open the link.

Questions? Reach us at {help_contact}, or reply to this email.

Kahuna Window Cleaning Hiring`,
  },
  {
    purpose: "reminder_24h",
    channel: "sms",
    name: "Unfinished application reminder (text)",
    body: "Kahuna Window Cleaning: Hi {first_name}, your application is saved but not sent yet. Finish it here: {link} Reply STOP to opt out.",
  },
  {
    purpose: "reminder_24h",
    channel: "email",
    name: "Unfinished application reminder (email)",
    subject: "Your application isn't finished yet",
    body: `Hi {first_name},

Your application for the {role_title} job at Kahuna Window Cleaning is saved, but you haven't sent it yet.

Finish it here:
{link}

Your answers so far are still there. It usually takes a few more minutes.

If you've decided not to apply, you don't need to do anything. This is the only reminder we'll send.

Questions? Reach us at {help_contact}.

Kahuna Window Cleaning Hiring`,
  },
  {
    purpose: "submit_confirmation",
    channel: "email",
    name: "Application received (email)",
    subject: "We got your application",
    body: `Hi {first_name},

We received your application for the {role_title} job at Kahuna Window Cleaning. Thank you.

A person on our team reviews every application within 3 business days. We'll contact you about next steps by email, or by text if you asked for texts.

You can check where your application stands any time here:
{link}

Questions? Call or text 763-292-2259, or reply to this email.

Kahuna Window Cleaning Hiring`,
  },
  {
    // Only sent if the real-phone test shows Quo does not answer HELP itself.
    // {help_contact} comes from Settings > Texting, so no email is hard-coded here.
    purpose: "help_reply",
    channel: "sms",
    name: "HELP reply (text)",
    body: "Kahuna Window Cleaning Hiring: for help, reach us at {help_contact}. Reply STOP to opt out.",
  },
];
