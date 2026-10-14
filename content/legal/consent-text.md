<!--
DRAFT for the owner's approval. Optional attorney review.
File: content/legal/consent-text.md
Seeds three legal_text_version rows, each version 1:
  - sms_consent     = the checkbox label plus the disclosure paragraph, together
  - ai_disclosure   = the one-sentence AI notice
  - landing_notice  = the one-sentence background check notice
Written Wed Oct 14, 2026 from docs/PLAN.md and docs/DATA_MODEL.md.

OWNER INPUT placeholders in this file: none.
(The consent wording names no email, phone, pay or entity, on purpose, so it
never needs a new version when those change.)

Builder notes: the checkbox must render unchecked and must not be required.
The hidden form field carries the sms_consent legal_text_version id that was
actually shown, and the consent_event row points at it. The public
/text-messages page quotes this same wording and is updated whenever
sms_consent gets a new version. "SMS Terms" links to /sms-terms and
"Privacy Policy" links to /privacy (open in a new tab so the form is not lost).
-->

> **Draft for owner approval.** Written Oct 14, 2026. This wording needs the owner's approval before it goes live, and the owner may want an attorney to read it first. Delete this box before publishing.

# Landing page consent and notices

Everything on this page is shown on the role landing page at tidepool.kahunawindowcleaning.com before the applicant enters the application. Order on the page: job title, pay, benefits, the two one-sentence notices, then the form.

## 1. Text message consent (sms_consent v1)

Where it sits: directly under the mobile number field on the landing form. One checkbox, **unchecked by default, optional**. The form submits whether or not it is checked.

### Checkbox label (exact)

> Text me my application link and updates about this application (optional)

### Disclosure paragraph shown under the checkbox (exact)

> By checking this box, you agree that Kahuna Window Cleaning may send you text messages at the mobile number above about your job application: your application link, one reminder if you don't finish, interview scheduling and reminders, status updates, and our decision. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out at any time. Checking this box is not a condition of applying; if you leave it unchecked, we will email you instead. See our [SMS Terms](/sms-terms) and [Privacy Policy](/privacy).

### What is stored as sms_consent v1

The label and the disclosure paragraph together, in that order, as one Markdown body. The consent record for every applicant points at this exact version, whether they checked the box or not.

### Notes for the owner

- "Updates about this application" is the whole scope. Texts about future openings would need a new version of this text and a new message type, as decided in the data model.
- The wording says "one reminder" because the system sends exactly one. If that ever changes, this text needs a new version.
- The checkbox cannot be pre-checked or required. Carriers reject both, and the data model records a "declined" consent event when it is left unchecked.
- If the applicant's number has already texted STOP to a Kahuna number, the form still records their choice, but the page tells them: "This number has opted out of texts from Kahuna Window Cleaning. To get texts again, text START to 763-292-2259. Until then we will email you." (See messages.md, "Other applicant-facing strings".)

## 2. AI notice (ai_disclosure v1), one sentence

Shown on every landing page from launch, under the pay and benefits text, whether or not scoring is on for that role.

> We may use software, including AI tools, to help organize and summarize applications, and a person makes every hiring decision.

Notes: this is the same meaning as the two-sentence form in the data model ("We may use software, including AI tools, to help organize and summarize applications. A person makes every hiring decision."). Either form is fine; use one and keep it the same everywhere. The privacy policy repeats it and explains what the tool does and does not see.

## 3. Background check notice (landing_notice v1), one sentence

Shown next to the AI notice on every landing page.

> Any background check happens only after a conditional job offer.

Notes: this line, plus not asking about criminal history anywhere on the form or in the Indeed screener, is how the site follows Minnesota's ban-the-box law.
