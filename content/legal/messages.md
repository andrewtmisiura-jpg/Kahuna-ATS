<!--
DRAFT for the owner's approval.
File: content/legal/messages.md
Seeds message_template rows (Phase 1) and the Phase 2 templates for the
template editor. Also holds the status page strings and the other short
applicant-facing strings, so every sentence an applicant reads is in one place.
Written Wed Oct 14, 2026 from docs/PLAN.md and docs/DATA_MODEL.md.

OWNER INPUT placeholders in this file:
- [OWNER INPUT: hiring email]   (HELP reply only; everywhere else the
                                 {help_contact} variable carries it)

Builder notes:
- Variables use the data model's syntax: {first_name}, {link}, {role_title},
  {employer_name}, {help_contact}; Phase 2 adds {session_date}, {booking_link}.
- One variable is NEW and not in the data model: {interview_time}, used by the
  one-on-one reminder. Render interview.scheduled_at in Central time as
  "Tue Nov 10 at 2:00pm". Add it with the Phase 2 template editor.
- {help_contact} is expected to render as "763-292-2259 (call or text) or
  <hiring email>".
- Character counts below are measured with first name "Marcus" (6) and
  "Christopher" (11), a 66-character application link, a 50-character booking
  link and a 20-character interview time. GSM-7 only: every text uses straight
  apostrophes, no curly quotes, no emoji, no characters outside the basic set.
- Send rule 4: the first text to a number since its latest opt-in replaces the
  short closing with the full one, whatever the template says.
-->

> **Draft for owner approval.** Written Oct 14, 2026. The owner approves this wording before the seed runs. Delete this box before use.

# Applicant messages

## Rules every message follows

1. **Brand first.** Every text starts with "Kahuna Window Cleaning:" so the applicant knows who it is before they read on. Emails come from "Kahuna Window Cleaning Hiring" with Reply-To set to the hiring inbox.
2. **STOP line on every text.** Short closing: `Reply STOP to opt out.` Full closing, used automatically on the first text to a number since it opted in: `Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`
3. **160 characters where possible.** Texts without a link fit in one segment even with an 11-letter first name. Texts that carry an application link cannot: the link alone is about 66 characters, so those run to two segments (about 2 cents). That is expected and accepted in the plan.
4. **No emoji, no curly quotes, no special characters.** Plain GSM-7 text only, so nothing is silently converted to a 70-character Unicode segment.
5. **Only about this application.** No marketing, no other openings, no small talk. Consent covers this application only.
6. **A person triggers every message except three.** The resume link, the one reminder and the HELP reply go out on their own. Everything else is sent by a staff member from Tidepool, as a template, so it is logged.
7. **Quiet hours.** Texts the applicant did not just ask for wait until 9am Central if they fall outside 9am to 8pm.
8. **Links never appear in stored copies.** The stored message keeps `{link:<token id>}`; staff see "[application link]".

## Variables

| Variable | Renders as | Available |
|---|---|---|
| `{first_name}` | The applicant's first name as typed | Phase 1 |
| `{link}` | The personal application link, minted at send | Phase 1 |
| `{role_title}` | For example "Snow Removal Technician (on-call)" | Phase 1 |
| `{employer_name}` | Kahuna Window Cleaning | Phase 1 |
| `{help_contact}` | 763-292-2259 (call or text) or the hiring email | Phase 1 |
| `{booking_link}` | The one-on-one scheduling link | Phase 2 |
| `{session_date}` | A group session's date and time | Phase 2 (reserved; no template uses it yet) |
| `{interview_time}` | The booked one-on-one time in Central, "Tue Nov 10 at 2:00pm" | Phase 2, new (see builder notes) |

`{role_title}` is long, so it is used in emails and kept out of texts.

## Phase 1 templates

### resume_link

Sent at once when the applicant finishes the landing form. Text if they checked the box, email always.

**SMS** (184 characters as a template; 238 to 243 rendered; 2 segments because of the link; already carries the full closing, since it is nearly always the first text)

```
Kahuna Window Cleaning: Hi {first_name}, here's your link to finish your job application: {link} Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.
```

**Email**

Subject: `Your Kahuna Window Cleaning application link`

```
Hi {first_name},

Thanks for starting your application for the {role_title} job at Kahuna Window Cleaning.

Here is your personal link to finish it:
{link}

It works on any phone or computer, and your answers are saved as you go, so you can stop and come back. The link stays active as long as you use it at least once every 30 days.

Please don't forward this link. Anyone who has it can open your application.

Questions? Reach us at {help_contact}, or just reply to this email.

Kahuna Window Cleaning Hiring
```

### link_recovery

Sent when someone asks for their link again on the "lost my link" page, or when a staff member resends it. Same channels as resume_link.

**SMS** (171 as a template; 225 to 230 rendered; 2 segments; full closing, since a recovered link may be the first text to this number)

```
Kahuna Window Cleaning: Hi {first_name}, here's your application link again: {link} Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.
```

**Email**

Subject: `Your Kahuna Window Cleaning application link, again`

```
Hi {first_name},

Here is your application link again:
{link}

If you've already submitted, the same link shows where your application stands.

If you didn't ask for this, you can ignore it. Nothing changes unless you open the link.

Questions? Reach us at {help_contact}, or reply to this email.

Kahuna Window Cleaning Hiring
```

### reminder_24h

Sent once, the day after someone starts and does not submit, between 9am and 8pm Central. Text if opted in, otherwise email. Never a second one.

**SMS** (130 as a template; 184 to 189 rendered; 2 segments because of the link)

```
Kahuna Window Cleaning: Hi {first_name}, your application is saved but not sent yet. Finish it here: {link} Reply STOP to opt out.
```

**Email**

Subject: `Your application isn't finished yet`

```
Hi {first_name},

Your application for the {role_title} job at Kahuna Window Cleaning is saved, but you haven't sent it yet.

Finish it here:
{link}

Your answers so far are still there. It usually takes a few more minutes.

If you've decided not to apply, you don't need to do anything. This is the only reminder we'll send.

Questions? Reach us at {help_contact}.

Kahuna Window Cleaning Hiring
```

### submit_confirmation

Email only, sent at submit. The screen says "We got it" at the same moment.

Subject: `We got your application`

```
Hi {first_name},

We received your application for the {role_title} job at Kahuna Window Cleaning. Thank you.

A person on our team reviews every application within 3 business days. We'll contact you about next steps by email, or by text if you asked for texts.

You can check where your application stands any time here:
{link}

Questions? Call or text 763-292-2259, or reply to this email.

Kahuna Window Cleaning Hiring
```

### help_reply

Text only. Sent automatically when someone texts HELP to 763-292-2259, even without an opt-in (unless the number is suppressed). Only used if the Oct 15 real-phone test shows Quo does not answer HELP on its own.

**SMS** (about 131 characters rendered with a 31-character hiring email; 1 segment)

```
Kahuna Window Cleaning Hiring: for help, call or text 763-292-2259 or email [OWNER INPUT: hiring email]. Reply STOP to opt out.
```

## Phase 2 templates

Staff send these from the profile or from a stage move. The text goes if the number has a current opt-in; otherwise the email goes.

### one_on_one_invite

Sent on the move to "One-on-one invited". Carries the booking link; the status page shows the same link while the invite is out.

**SMS** (124 as a template; 154 to 159 rendered with a 50-character booking link; 1 segment)

```
Kahuna Window Cleaning: Hi {first_name}, we'd like to interview you. Pick a time here: {booking_link} Reply STOP to opt out.
```

**Email**

Subject: `Interview invitation from Kahuna Window Cleaning`

```
Hi {first_name},

We read your application for the {role_title} job and we'd like to meet you.

Pick an interview time that works for you here:
{booking_link}

The interview takes about 30 minutes. The booking confirmation will have the location and anything you need to bring.

If none of the times work, reply to this email or call or text 763-292-2259 and we'll find one.

We look forward to meeting you.

Kahuna Window Cleaning Hiring
```

### one_on_one_reminder

Sent the day before a booked one-on-one. Location is left to the booking confirmation on purpose, so the template works for every role and site.

**SMS** (148 to 153 rendered; 1 segment)

```
Kahuna Window Cleaning: Hi {first_name}, reminder: your interview is {interview_time}. To change it, call or text 763-292-2259. Reply STOP to opt out.
```

**Email**

Subject: `Reminder: your interview with Kahuna Window Cleaning`

```
Hi {first_name},

A quick reminder that your interview with Kahuna Window Cleaning is {interview_time}.

The location and any details are in your booking confirmation. If you need to change the time, reply to this email or call or text 763-292-2259 as soon as you can.

See you then.

Kahuna Window Cleaning Hiring
```

### status_update

Sent by staff when something changes that the applicant should see. It points at the status page rather than naming the stage, so the wording never has to change when stages do.

**SMS** (126 as a template; 180 to 185 rendered; 2 segments because of the link)

```
Kahuna Window Cleaning: Hi {first_name}, there's an update on your job application. See it here: {link} Reply STOP to opt out.
```

**Email**

Subject: `An update on your Kahuna Window Cleaning application`

```
Hi {first_name},

There's an update on your application for the {role_title} job. You can see where it stands here:
{link}

A person on our team reviews every application. If you have a question, reach us at {help_contact}.

Kahuna Window Cleaning Hiring
```

### decline

Kind, brief, no reasons. Sent by staff on a close. Recommended default channel: email, even when the applicant opted in to texts, because a decline reads better in an inbox than in a notification. The text version exists for applicants with no working email.

**SMS** (145 to 150 rendered; 1 segment)

```
Kahuna Window Cleaning: Hi {first_name}, thank you for applying with us. We won't be moving forward this time. We wish you well. Reply STOP to opt out.
```

**Email**

Subject: `Your application with Kahuna Window Cleaning`

```
Hi {first_name},

Thank you for applying for the {role_title} job at Kahuna Window Cleaning, and for the time you put into your application.

We won't be moving forward with your application this time.

We wish you the best in your search.

Kahuna Window Cleaning Hiring
```

### group_invite

Reserved purpose, no template. Indeed sends group interview invites; a record starts when the applicant scans the QR. Revisit by Dec 1 if that changes.

## Status page

Shown at the applicant's link after they submit. Never shows a closed reason.

- Heading: `Your application`
- Line 1: `{role_title} at Kahuna Window Cleaning`
- Line 2: `Submitted {submitted date}`
- Status, from the stage's public label, with one plain sentence under it:
  - **Received**: `We have your application.`
  - **Under review**: `A person on our team is reading it.`
  - **Interview**: `We'd like to meet you. Check your email or texts for scheduling.` (Phase 2: a `Book your interview` button with `{booking_link}` while an invite is out.)
  - **Offer**: `We've made you an offer. Check your email or texts for details.`
  - **Background check**: `Your offer is conditional on a background check. The background check company will contact you directly.`
  - **Hired**: `Welcome aboard. Your start details will come from your manager.`
- Closed (any stage): `This application is closed. Thank you for applying.`
- Always: `A person on our team reviews every application.`
- Always: `Questions? Call or text 763-292-2259.`

## Other applicant-facing strings

- Autosave: `Saved` / `Not saved, check your connection`
- Submit screen: `We got it. A person on our team reviews every application within 3 business days. We sent a confirmation to your email.`
- Duplicate or mismatched details on the landing form (the neutral screen): `Check your messages. If you already have an application with us, we just sent your link to the phone number or email on file. Questions? Call or text 763-292-2259.`
- Lost-link page heading and help: `Lost your link?` / `Enter the mobile number or email you applied with and we'll send your link again.` After submit: `If we have an application for you, your link is on its way.`
- Expired or revoked link: `This link has expired. Ask for a new one here.` (links to the lost-link page)
- Landing page when the number has a live opt-out: `This number has opted out of texts from Kahuna Window Cleaning. To get texts again, text START to 763-292-2259. Until then we will email you.`
- Closed entry code (QR on an old flyer): the page simply shows the role's current opening, with no error.
- Opening not open: `We're not taking applications for this job right now. Check back soon, or call or text 763-292-2259.`
- Too many link requests: `We've sent a few links to this number or email in the last hour. Check your messages, and try again in an hour if you still can't find it.`
