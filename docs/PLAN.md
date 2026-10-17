# Tidepool: Build plan

Tidepool is Kahuna's hiring system, the third app beside REEF (recurring customers, reef.kahunawindowcleaning.com) and Typhoon (snow removal, typhoon.kahunawindowcleaning.com). It lives at tidepool.kahunawindowcleaning.com; every QR code, link, email and sign-in uses that address. Written Tue Oct 13, 2026, rewritten the same day after your feedback. Updated Fri Oct 16, 2026: Phase 2 shipped that day, instead of the Oct 26 to Nov 6 plan (see Phase 2). The data model is in [DATA_MODEL.md](DATA_MODEL.md).

## What changed from the last draft

- One release, on your timeline. Everything in the brief's Phase 1 plus the kanban board, the question editor and five small Settings screens ship together. Target Fri Oct 23, hard backstop Fri Oct 30. The Oct 30 / Nov 10 split, the cut order and the "collected now, screens later" table are gone.
- Texting is in the launch build, from 763-292-2259. Your registration answers (Business, EIN, legal name, applicant texts fit) remove the "ask Quo support" gate. The only gate left is a real-phone test.
- Phases 2 and 3 follow at once: Phase 2 live Fri Nov 6, Phase 3 live Fri Nov 20. Nothing waits for the first window group interview except the window rubric and wording, which are your work.
- Temporary hires get a tag on the hire form and are left out of retention numbers.
- Predictiveness is built in Phase 3 with your numbers (40 to 50 hires a year, 5 to 10 kept); the "three seasons of noise" claim is dropped.
- The AI shows a 1 to 100 score, computed from per-criterion grades, with the anchoring safeguards kept.
- Sign-in is Google sign-in against a list of staff emails with a role each. No Google Workspace domain requirement.
- No Sentry. Railway logs, email alerts and a daily digest instead. Railway, Resend and Cloudflare are already yours, so the account list is short.
- Configuration moves out of the command line: a one-time seed, then screens. The reviewed change-file command is gone.
- About a third of the engineering safeguards sized for a bigger team were cut (details under "Decisions"). What stays protects data that cannot be backfilled or a legal position.

## Glossary

- **Opening:** one role in one season (Snow Removal 2026-27). The unit every report uses.
- **Milestone:** the fixed step a stage counts as, so renaming a stage never breaks a report.
- **Entry code:** the short code inside every QR or link, so a printed code can be closed without reprinting.
- **Hire record (stint):** one person in one role in one season.
- **Suppression list:** numbers and emails Tidepool will never message.
- **Pre-adverse notice:** the letter the background check law requires before a rejection based on a report.

## What a snow applicant experiences

They get an Indeed message with a tidepool.kahunawindowcleaning.com link, or scan a QR. The page shows the job, pay and two sentences: any background check comes after a conditional offer, and we may use software, including AI tools, to help organize applications while a person makes every decision. They type first name, last name, mobile and email, optionally how they heard about us, and may tick an unchecked box, "Text me my application link and updates about this application", with the full disclosure under it. The application opens at once: three short sections, every answer saved as they go with a "Saved" mark. Within a minute a text from 763-292-2259 (if they ticked the box) and an email carry their personal link, which reopens their saved answers on any device for 30 days. If they stop, one reminder arrives the next day between 9am and 8pm, never a second. Submit shows "We got it" and sends an email; the link then shows a status page ("Received", "Under review", and so on; never a closed reason). A reply to the text reaches a person in Quo. STOP stops texts from every Kahuna number until they text START.

## What staff experience

Sign in with Google on a phone. The snow list opens with counts at the top (started, in progress, submitted) and a strip of things needing attention (unhandled texts, contact conflicts). Tap an applicant to see answers, source, stage history, notes, the text thread, and a "Returning" strip if they applied or worked here before (red if they were marked not eligible for rehire). Move is one small dialog (stage, time, optional note; backdate if you are catching up). Close is another (outcome, reason, note). Hold, Reopen, Contacted and Hire now are one-tap buttons. Moving to Conditional offer records the offer date from the move's time (backdate it if needed) and asks for the planned start date; moving to Background check asks the check type; both get a panel on the profile. Moving to Hired opens the hire form: crew, start date, Temporary yes or no, and later the leave date, reason and ratings. Replies to texts land in the Quo app and on the profile and are emailed to hiring@; "they asked me to stop" is one click. The kanban board, question editor, entry codes and Settings are desktop screens for Admins. Admins export CSV. Three one-page guides live at /help inside the app.

## Decisions

Each line ends with where the detail lives in DATA_MODEL.md.

- Kahuna employs both roles under its EIN; Midwest Access is a later Employer row. (employer)
- The hiring number is 763-292-2259 in your Quo workspace, with its own API key and its own webhook scoped to that number, so Typhoon's connection is untouched. The hiring number is the contact applicants see; the office number appears only in the privacy policy. (send rules)
- Sign-in is Google against an allowlist: an Admin adds an email and a role in Settings > Users; any other email is refused and no row is created. Personal Gmail is fine. Disabling someone in Settings > Users is the only offboarding, so do it the day they leave; their sessions end at once. (app_user)
- Person is separate from Application; one application per person per opening; matching by mobile, then email, never names. The public form never changes contact details on file. (person)
- Role is the permanent job; Opening is the cohort. Stages map to fixed milestones; closed outcomes (Disqualified, Withdrew, Not selected) carry a required reason; Hold is a flag. (pipeline_stage, application)
- Stage history is an append-only log written by one function, with a backdatable "happened" time. (application_event)
- Any stage can move straight to Hired, or to any later stage, in one step; a "Hire now" button on the profile does it from the group interview the same day. Skipped steps count as passed in reports. The only hard blocks are the FCRA ones: no Background check stage without a conditional offer, and no background-based disqualification before the waiting period. (application_event, send rules)
- Questions are versioned; publishing creates a locked form version; each application pins the version it started on and keeps it to the end. (form_version)
- Snow form v2 (Oct 16) adds your five behavioral questions (reliability, integrity, work ethic, following directions, problem solving) in a "How you work" section, each with staff-only "What to look for" notes that applicants and the AI never see, and a pass or fail check that the direction-following answer starts with "Blue"; staff also record group interview arrival and Tidepool measures text reply speed, two signals likely to predict retention better than any answer, and the hypothetical equipment question counts as the weakest signal. (question_version, application, How each report is computed)
- "How did you hear about us?" is a fixed landing field; the entry code is captured for everyone. (application)
- Links carry a hashed, reusable token that expires 30 days after last use, never stored or logged readable. (resume_token)
- Text and email both send at launch. Texting is on from the Oct 15 real-phone test and stays on only if it passes; Settings > Texting turns it off or on afterward. A text goes only to a number with a current opt-in; the suppression list is checked before every send; a global daily cap (default 200) stops runaway sends. (send rules)
- Consent covers this application only; returning applicants opt in again next season. Staff may answer an applicant's text by hand in Quo; invites, declines and status news go out as templates so they are logged. (consent_event, message)
- Temporary hires are tagged on the hire form and left out of retention numbers, because their leaving is the plan, not a signal. Set the tag when you hire, not the day someone quits; the record shows when it was set. (hire_stint)
- AI scoring (Phase 2) shows a 1 to 100 score computed from per-criterion grades, never moves or rejects anyone, and never sees the never-send questions. The first window batch is scored hidden and every decision records whether the score was visible. The AI disclosure is on every landing page from day one; at your request snow is scored visibly from Oct 16 with a starter rubric, and window stays off until its rubric is published. (ai_score, rubric)
- Review screens are phone-first; kanban, configuration and reports are desktop-first.
- Retention is per record type with a 1-year floor and a legal hold; expiry strips personal details and keeps anonymous data. (retention_policy)
- No staging environment: local development with a message sink, then production. Pre-launch, production is the test environment; after launch, Phase 2 is built on a branch with a Railway PR environment and merged on its own date.
- Cut on purpose, because they protected against risks a 1 to 4 user tool does not carry: the non-superuser database role, the PII column registry and its CI test, the CASCADE schema test, the nightly event-replay check, the DST test matrix, composite foreign keys, language-keyed text, the offline autosave queue, the email confirm step, the rate-limit table, note editing with revisions, reopening answers after submit, versioned message templates, the data-request table, Message Batches, the rubric publish gate, the Quo retry endpoint, the federal-holiday table and per-IP limits.

**Never cut:** consent capture with text versions; the opt-in, suppression and daily-cap checks in the single send function; links never stored readable; the stage event log with milestones and reasons; versioned answers pinned to a form version; source and entry code; privacy policy, SMS terms and opt-in page; allowlist sign-in with server-side role checks; the FCRA gate; backups with a tested restore; CSV formula escaping.

## Where I am still pushing back

1. **The schedule can be fast, and here is what your availability does and does not buy.** It speeds up everything that used to wait days: legal text, pay text and question wording approved within an hour; snow pipeline, check and vendor decisions no longer blocking screens; real-phone tests the same hour a build lands; Settings screens so you enter crews, users and openings without a builder round trip. That is roughly a week of the old calendar, which is why Oct 23 is possible. It does not change the amount of code: about 30 tables, 25 screens, two message providers with webhooks, a cron, sign-in, versioned forms and CSV; the builder's throughput sets the floor. It does not speed up debugging with real carriers and Quo's beta webhooks, where each cycle is deploy, text, wait, read logs, and one bad afternoon costs a day. It does not speed up DNS or Resend verification (done today to take it off the path), or your own homework (reading the legal text properly, the window rubric, the Anthropic account). REEF and Typhoon were weekend projects partly because they had no applicant-facing compliance surface; this one does, and that is where the dry run earns its day. Residual risk: if the Oct 20 dry run turns up something fundamental, the whole launch moves, at most to Fri Oct 30; nothing is split off.

2. **Quo, the facts that still matter.** Quo's newer signed webhooks (the only ones that report failed and undelivered) are labeled beta, so a text whose delivery event never arrives stays "sent", and that is fine. The API has no opt-out list, so Tidepool's suppression table is the record. A STOP to 763-292-2259 blocks that phone from every Kahuna Quo number, including the customer line and whatever Typhoon uses, until the person texts START or UNSTOP, and staff cannot undo it. So hiring texts stay minimal and transactional, and the profile header and hire form warn when a person's number has a live opt-out: "Ask them to text START to 763-292-2259 before dispatch texts will reach them." The balance is prepaid at about $0.01 a segment and sends fail when it is empty, so auto-recharge goes on and the send function treats an empty-balance error as an alert plus email fallback. You confirmed the registration covers applicant texts; if carriers filter them anyway, delivery receipts in the live test and the first week's digest will show it, and email carries until it is fixed.

3. **The consent box stays optional and unchecked, and "honor STOP" covers less than the rules require.** Carriers reject pre-checked or required consent. Since April 2025 an opt-out made by any reasonable means must be honored within 10 business days, which keyword handling will not catch, so every inbound text is logged on the profile and emailed to hiring@, an "Unhandled texts (N)" badge sits at the top of the list until each is marked handled, and staff record an opt-out with one click.

4. **Printed QR codes are permanent, and a public form that sends messages is a fraud target.** Codes are short opaque codes on tidepool.kahunawindowcleaning.com (for example /q/7KX2QF), so a code can be closed without reprinting. The landing and lost-link pages get Cloudflare Turnstile, no more than 3 link sends to one number or email in an hour, and the daily cap.

5. **Everything ships in one release.** The data the reports need (reasons, source, entry code, backdated times, form versions, consent, message log, offer and check dates, hire rows) is captured by the same screens staff use from day one, so there is nothing to collect without a screen.

6. **Stages need fixed milestones, and "Disqualified" is really two outcomes.** A "Not selected (roles filled)" outcome and a Hold flag are added, because with deliberate over-hiring "we filled the roles" is not a judgment on the person and would corrupt the AI-vs-human report. "Applied (started)" becomes a drop-off count, not a board column.

7. **Active / Left is the wrong model for seasonal jobs.** One hire row per person per season; "Completed season or term" counts as success; retention is measured to the earlier of N days or season end (shown as pending until then); "returned next season" is the long-term signal. For on-call snow the default is a season-end rating plus storms worked, and a tech who never worked a storm shows as "never worked". Temporary hires are tagged and left out of retention numbers, because their leaving is the plan, not a signal.

8. **Predictiveness is built in Phase 3, and here is what to expect.** With 40 to 50 hires a year, roles kept separate (as the brief asks), the limit is the small group that stays or is rated well, 5 to 10 a year, not the total. The report compares answers for "keepers" (your pick per role: completed the season and rehire eligible by default for window; rated Reliable at season end for snow; also retained 90 days, rated 4 or 5 at 90 days, or returned next season) against everyone else, pooled across all openings of a role. It shows a rate only when the answer group has at least 10 hires, warns under 20, ranks nothing and changes nothing. At your volume an evenly split yes/no question clears the 10 mark in season one and the 20 mark in season two; lopsided splits take longer. That is what "a year or two" means. Knockout questions never show up because every hire answered them the same way. Heights and too-physical leave reasons are never used to tune screening. Tell me roughly how the 40 to 50 splits between snow and window.

9. **Make the questions measurable.** "Last two jobs, how long, why you left" becomes employer, months and a how-it-ended choice; new questions map to your leave reasons (another job, ladder experience, need for a steady 40), plus "18 or older?", ADA-safe "with or without reasonable accommodation" wording, and prior pay on the do-not-ask list (banned in Minnesota since 2024). Your wording changes are in. One-on-one grades, the ladder test and group interview stars become data fields in Phase 2.

10. **The 1 to 100 score, with the safeguards kept.** Reviewers anchor on a visible number at least as hard as on a word, so the first window batch is scored hidden and every decision records whether the score was visible. The number is computed by the app from per-criterion grades and the rubric's weights (so it is reproducible and a weight change can re-score without a model call), shown with the per-criterion grades and rationale and the rubric version beside it. The agreement report treats 70 and above as advance and under 40 as decline (both editable report settings) and shows the score distribution per human decision, so bands can change later without losing anything. Flags come from a fixed job-related list; answers that invite protected disclosures are never sent; a failed or invalid model result shows "not scored", never a low number.

11. **Google sign-in is not access control, and "CSV of everything" is the easiest data leak.** Every server action and route handler runs through one requireRole wrapper that reloads the user's status and role. CSV is a set of Admin-only, logged, formula-escaped exports; restricted notes are left out.

12. **"Keep one year" is a floor, and some hiring records live outside the ATS.** Retention is per record type with a 1-year minimum and a legal hold (FCRA claims up to 5 years, TCPA 4). The ATS blocks a background check before a conditional offer; while a check is open, any rejection is either background-based (naming the check, waiting 5 weekdays after its pre-adverse notice) or carries a recorded statement that it does not rely on the report. See "Things you do outside Tidepool".

## Stack

- Next.js (TypeScript) on Railway with Postgres: one project, a web service, a cron service and Postgres. Drizzle with generated SQL migrations run on pre-deploy. Business logic in a service layer, so a hires API can be added later without rework.
- Google sign-in through Better Auth, email allowlist and roles on top. Reuse the OAuth client Typhoon or REEF already has if it is External (add Tidepool's redirect URL); if it is Internal and anyone uses a personal Gmail, create a new External client with only email and profile scopes (no Google verification needed).
- Quo for texts from 763-292-2259: its own API key labeled Tidepool, send through the v1 messages endpoint, the newer signed webhooks scoped to the hiring number's id, which the builder looks up from +17632922259 through the phone-numbers endpoint. The builder reads Typhoon's Quo code and existing webhooks first and never changes a webhook it did not create. Hand-typed replies from the Quo app appear on the profile.
- Resend for email, reusing the sending domain already verified for REEF or Typhoon; From "Kahuna Window Cleaning Hiring", Reply-To hiring@; click and open tracking off; bounce and complaint webhooks. Confirm the plan has headroom (the free tier is 100 emails a day, and an Indeed launch day can exceed it).
- Cloudflare Turnstile on the landing and lost-link pages only. DNS: one CNAME to Railway set up the same way typhoon. is; if proxied, SSL mode Full (strict).
- Cron every 5 minutes: sends due messages, queues the 24-hour reminder, writes a heartbeat, runs the nightly pg_dump to a Cloudflare R2 bucket at 3am Central (35-day lifecycle rule, no app-level encryption; R2 encrypts at rest). Railway's scheduled Postgres backups on as well. One restore test before go-live.
- Errors: Railway logs plus one notifyAdmin helper that emails your alert address (at most one email per error kind per hour) on a failed send, a webhook signature failure, a job exception, an empty Quo balance or the daily cap. /health returns 200 only when the database answers and the cron heartbeat is under 15 minutes old; a free uptime monitor pings it. A 7am Central digest: started, submitted, texts sent, delivered, undelivered and failed, emails bounced, unhandled texts, errors, backup age.
- Secrets: you paste every key (Quo, Resend, Turnstile, Google, R2) straight into Railway variables. The builder never receives a secret in chat and never prints one.
- A read-only database user for your own questions, so you can point Claude Code at the data before and after the report screens exist.
- Tests: Vitest against real Postgres for the protective set (transition function, FCRA gate, send rules, STOP/START/HELP handling, tokens, form versioning and locking, landing matching, CSV escaping, send-once under two cron passes, two concurrent moves of one application, the Central-time helper across Nov 1). Playwright on one phone viewport: landing to submit with a resume in between, and admin sign-in to stage change. CI runs typecheck, lint and tests on every push; the builder runs them before pushing; Railway deploys main on push.
- Phase 2: Anthropic SDK with structured output (a strict schema the model must follow), model id in config (`SCORING_MODEL`, default claude-opus-5-5), no tools, re-scoring sequentially through the job table.
- Running cost, roughly: Railway (your plan plus usage), Resend's paid plan if the free tier is too tight, the Quo number at $5 a month plus about a cent per segment (a link text with the full disclosure is usually two segments, so about 2 cents), Cloudflare free, R2 under a dollar, and in Phase 2 the Claude API at a few cents per application with a monthly cap you set. Check current prices when you approve.

## Phase 1: one release (target Fri Oct 23, slip Tue Oct 27, hard backstop Fri Oct 30)

Nov 1 is a Sunday, so Fri Oct 30 is the last date.

**Applicant:** /q/<code> resolver with daily scan counts (closed codes fall back to the role page); role landing page with pay, benefits, the background-check and AI notices; landing form (name, mobile, email with typo hint, optional source, optional unchecked text consent with the full disclosure, Turnstile); straight into the application; per-field autosave (retry three times, "Saved" or "Not saved, check your connection", a stale device never overwrites a newer answer); resume link by text (if opted in) and email at once; lost-link page; submit with confirmation email and a status page; one 24-hour reminder (text if opted in, else email, 9am to 8pm Central); privacy policy, SMS terms, opt-in page.

**Admin:**
- Google sign-in with allowlist and role.
- List view: counts, filters, search, single and bulk stage move, attention strip.
- Kanban: every drag carries the row's version; a conflicting move says who changed it and reloads; drags into Offer, Check, Hired or a closed outcome open the same dialogs as the list.
- Profile: answers with version, stage history, notes with a restricted flag, messages in and out, consent, resend or revoke link, audited contact edits, opt-out and do-not-contact, inbound text handling, returning-applicant strip, contact-conflict banner, Admin-only "Delete test application".
- Move and Close dialogs: backdate, closed outcomes with reason, hold, reopen, contacted.
- Offer and check panels with the FCRA gate; hire form with the temporary flag.
- Question editor: draft, publish a locked version, reworded-or-new prompt, do-not-ask list, change reason; applications already started keep their version.
- Settings:
  - Openings: status, dates, season dates, pay, benefits, headcount; cannot open without pay text and an opens-on date.
  - Users: email, role, disable.
  - Texting: on or off, help contact, daily cap, hiring number read-only.
  - Entry codes: create with label and channel, close, download QR as SVG and PNG, daily scan counts.
  - Picklists: add, relabel, archive; this is how you enter crews.
- CSV export set with dictionary files.
- Suppression with bounce and complaint handling; Quo send and webhooks with STOP, START and HELP handling.
- /help guides.

**Platform:** Railway web, cron and Postgres; migrations on pre-deploy; db:seed (one script, run once against an empty database and locally: employer, your Admin user, both roles, both pipelines, picklists, legal text v1, templates v1, snow form v1 published and window form v1 as a draft, both openings (snow open with the pay text you approve Oct 14, window a draft), the two launch entry codes; re-running is a no-op by key); nightly dump with one tested restore; CI; alerts, digest and /health; read-only database user.

Snow runs group interviews this fall, so group sessions are in this release: the session record (date, location, role, invited count), a per-session QR, and the session shown on each applicant and as a list filter. Attendee entry from the sign-up sheet, stars and the door check-in page followed in Phase 2 (Oct 16).

**Slip rules.** If the Oct 20 dry run fails on something fundamental, go-live moves to Tue Oct 27 with everything. If Oct 27 fails, Fri Oct 30 is the last date, with everything. If even that is at risk, I will ask you at the Oct 27 go/no-go whether kanban (the list makes the same moves), the question editor (snow form v1 is seeded), the wide CSV export or bulk move may trail by a week; nothing trails without your say-so. Nov 1 is the daylight saving change; the Central-time helper and its test cover it, and the builder checks the first reminders sent on Nov 2.

### Schedule

Assumes the builder works every day including both weekends, you answer within hours, and gates decide go-live, not the calendar.

| Day | Builder | You |
|---|---|---|
| Tue Oct 13 | Rewrite PLAN.md and DATA_MODEL.md; scaffold the repo; read Typhoon and REEF for sign-in, Resend, Railway and Quo patterns | Approve both documents; DNS CNAME for tidepool.kahunawindowcleaning.com; GitHub access to the Typhoon and REEF repos (or a short note on how they do sign-in, Resend and Quo); Tidepool's redirect URL on the existing Google OAuth client, or say there is none; which Resend sending domain is verified; your own email for the first Admin account (the rest, with roles, before the Oct 20 dry run) |
| Wed Oct 14 | Railway project (web, cron, Postgres); schema, migrations, db:seed; Google sign-in with allowlist; shell live on the domain; consent text, privacy policy and SMS terms drafts by noon | Approve the drafts, snow pay and benefits text, help contact; name who reads hiring@ and answers 763-292-2259 |
| Thu Oct 15 | Applicant flow end to end in production: resolver, landing, application, autosave, tokens, submit, status page; Resend; Quo send and webhooks; `quo:connect` (looks up the hiring number's id and turns texting on); cron sender and reminder | Morning: create the Quo API key (labeled Tidepool) when asked, paste it into Railway, turn on auto-recharge. Evening: first real text test on one staff phone (link arrives, STOP, START, HELP, a hand reply typed in Quo shows in Tidepool, nothing from the hiring number appears in Typhoon) |
| Gate A (end of Oct 15, latest end of Oct 16) | A real round trip works in production: start on a phone, text and email arrive, resume from the text link, submit, confirmation email. Missed by Oct 16: target moves to Oct 27 at once | |
| Fri Oct 16 | Admin core: list, profile, Move and Close, offer and check panels, FCRA gate, notes, inbound text handling with one-click opt-out, suppression plus Resend bounce and complaint webhook | Snow season dates, headcount, whether snow uses one-on-ones, which checks apply and the vendor; recruit 3 to 5 dry-run testers (iPhone and Android, at least three carriers) for Oct 20 |
| Sat Oct 17 to Sun Oct 18 | Kanban; question editor; the five Settings screens; hire form with the temporary flag; CSV export set; returning-applicant strip | Optional: try the screens Sunday evening |
| Mon Oct 19 | Vitest protective set, two Playwright flows, nightly pg_dump to R2 and the restore test into a scratch Postgres, alerts, digest, /health, /help guides, fixes | 30-minute production walkthrough with test applications |
| Tue Oct 20 | Dry run 1 (script below); fix the list the same day | Dry run with your testers |
| Wed Oct 21 | Remaining fixes; dry run 2 on failed items only; go/no-go at 5pm against Gate B | Run the acceptance checklist and sign off |
| Thu Oct 22 | Code freeze at noon; delete test applications; QR test sheet | Indeed cleanup (remove any background-check screener, add the pay range); scan the test sheet on an iPhone and an Android |
| Fri Oct 23 | Go-live; watch logs, Quo delivery and first submissions all day | Paste the Indeed-message link into Indeed's message template and auto-reply in the morning; available all day |

### Dry run and gates

**Dry run (Tue Oct 20, 3 to 5 testers on iPhone and Android across at least three carriers):** receive an Indeed-style message with the link, open it inside the Indeed app browser, start, leave, resume from the text link, resume from the email on a second device, submit. Staff: see it in the list and on the board, move a stage, backdate a move, close with a reason, add a note, resend a link, run a CSV. Texting: one tester texts STOP then START and the profile shows both; one texts HELP and a question; a staff member answers by hand in Quo and the reply appears in Tidepool. Email lands in Gmail, Outlook and iCloud inboxes, not spam.

**Gate B (go-live):** every staff member has signed in; the dry run passed or its fixes were re-tested on a phone; texts delivered on three carriers; the restore test done; privacy policy, SMS terms and opt-in page live; you approved consent text, snow questions and pay text; sms_enabled on; test applications deleted; your acceptance checklist signed.

**QR gate:** no printing before Gate B. Print one test sheet, scan it on an iPhone and an Android, confirm the entry code shows on the resulting profile, then print in bulk. Earliest Oct 22.

### Before you say "live" (about 45 minutes, Wed Oct 21)

1. From your phone, open the Indeed-message link, start, close the browser, open the email link on another device, see your answers, submit, get the confirmation email.
2. Tick the text box, get the link by text from 763-292-2259, reply STOP, see the profile show opted out and the next message go by email, reply START.
3. Leave an application unfinished and get exactly one reminder the next day inside 9am to 8pm.
4. Every staff account signs in; a Gmail not on the list is refused.
5. On a phone: filter the list to Submitted, open a profile, move to Reviewed with a backdated time, add a note, disqualify with a reason, reopen.
6. On desktop: drag a card on the kanban and see the move in the history with your name.
7. Edit a question, publish v2, confirm a new application shows the new wording and an old one keeps the old.
8. Create an entry code in Settings, download the QR, scan it, see the code on the resulting profile.
9. Move someone to Hired, mark them Temporary with a leave date, confirm the hire record.
10. Export CSV, open it in Google Sheets; a cell starting with = shows as text.
11. The builder shows you: last night's dump restored into a scratch database with the list view open; a failed-send alert email; the daily digest; an UPDATE on the event log rejected; an anonymous call to a server action refused.

## Phase 2 (shipped Fri Oct 16, 2026)

Planned for Mon Oct 26 to Fri Nov 6 on a branch with its own Railway environment. It was built instead in five parallel areas (group sessions, interviews and roles, message templates, scoring, the rubric editor) and merged on Oct 16, and it deploys from main like Phase 1. Its tables come from the Phase 2 schema migrations (0007 and 0008), which production (main at ed080a8, migrations through 0006) does not have yet, so this deploy's web pre-deploy runs both. They are additive (new tables, plus two employer columns: the booking link, left empty, and the daily scoring limit, 100), so Phase 1 data is untouched. Take a backup first, and deploy web before cron (or pause the cron service until the pre-deploy finishes), because the new cron code reads those tables and columns and its send, reminder and jobs steps fail until they exist. Its content (the Phase 2 templates and the snow starter rubric) arrives through `pnpm db:changes` in the same pre-deploy step.

What shipped, against the plan:
- Group sessions, continued: attendee entry from the paper sheet ("Who came") and a tablet door check-in page at /check-in/<session id>, exact-phone matching, staff-confirmed name matches, and a phone floor view with stars and concerns using the star reason picklist. A match fills in the applicant's session and, for a door check-in, their arrival.
- Interview records: schedule, reschedule, cancel and record a one-on-one or phone screen with A+ to F grades on a six-category scorecard, an overall grade, a recommendation and a Notion link; the ladder-test assessment, voided and re-recorded to fix a mistake.
- The template editor in Settings > Message templates with the Phase 2 templates (one-on-one invite with the booking link, one-on-one reminder, decline, status update) and the booking link. Staff send them from the profile, the Move dialog (the invite) and the Close dialog (the decline); the one-on-one reminder goes by itself the day before; the applicant's status page shows "Book your interview" while an invite is out.
- The stage editor and "New role from template" in Settings > Roles and stages, plus a draft opening on the role's page. From this point you add a role yourself: Settings, New role, edit the questions and stages, open an opening with pay and dates.
- The rubric editor with Try it (sample answers scored on demand; publishing needs a written reason, not a passing run) in Settings > AI scoring.
- The scoring job: a 1 to 100 computed score from per-criterion 1 to 5 grades, hidden or visible mode, the stored anonymous input snapshot, re-score per application or per role, a daily limit, and the score on the profile, list and board with a sort.
- Review decisions written automatically inside every staff move, close and hold.
- The AI disclosure editable as a legal text version in Settings > AI scoring; the landing page shows the newest version, and each application is tied to the one it saw.
- Seven staff guides at /help (four new, and the "Coming Nov 6" lines folded into the first three).

Changed from the plan:
- Snow is scored now, in visible mode, at your request: the `2026-10-16-snow-starter-rubric` change publishes a starter rubric written from your staff notes (Reliability 30, Integrity 25, Work ethic 30, Problem solving 15) with two groups of Try it samples. Window stays off until your window rubric is published, and its first batch can still be scored hidden.
- The live scorer calls claude-opus-5-5 by default with effort medium and the API's server-side fallbacks; `SCORING_MODEL` overrides the model.

Deferred, not in this release:
- The Phase 2 CSV files: scores, criterion scores, review decisions, attendees, stars, interviews with grades, and assessments (leaving out the restricted note), and the attendee count in the sessions file. Until they land, the read-only database user answers those questions.
- Attendance and star chips on the list and the board.
- The Nov 4 to 6 run against sample window answers, which waits for the window rubric.

**Gate:** the input-snapshot test (no name, phone or email) passes; scoring runs end to end with the stand-in scorer in the tests and in the deploy rehearsal (a fresh copy of production's database taken through migrate, seed and db:changes, then one cron pass); nothing calls the model until `ANTHROPIC_API_KEY` is in Railway. Because snow is visible, the key is what makes snow scores appear; without it scoring pauses, jobs wait without losing attempts and an alert email goes out each hour.

**Your acceptance:** create a test role from a template without the builder; run a group session from creation to a star on a phone in five minutes; the same sample answer in standard, short and broken-English form scores within a few points (Try it on the snow starter rubric's samples, once the key is in); a one-on-one invite goes out as a text from a real stage move.

The window rubric, the window question wording and pay, and your approval of the AI disclosure (counsel optional) are owner work and gate the spring window opening, not this release; scoring stays off for window until the rubric is published.

## Phase 3 (Mon Nov 9 to Fri Nov 20, then one trailing item)

- Nov 9 to 11: Hires page first, so November snow hires are visible on a screen (the Phase 1 hire form records them until then): temporary flag, season-end outcome, crew, rehire, ratings, a Temporary filter; single-person record export for Minnesota personnel-record requests.
- Nov 12 to 16: drop-off, time to hire, time in stage, funnel, session attendance, time to first contact, retention (temporary and never-worked as their own buckets).
- Nov 17 to 19: predictiveness (keeper outcome options above), AI versus human versus retention, audit log viewer, a Today page (unhandled texts, stale Submitted, hired people with a live text opt-out, returning applicants marked not eligible).
- Fri Nov 20: live; snow data fills the reports from day one, showing "pending" and small-sample warnings as expected.
- Nov 23 to 25: retention settings, legal hold and the purge job. Nothing reaches the one-year floor before late October 2027, and with the default periods nothing is purgeable before late 2028, so this trails without risk; until then nothing is purged and a legal hold is a note plus an audit row. Quo text cleanup stays a documented manual step unless its API supports deletion.
- When needed: person merge (the first time a returning worker shows up with a new number); historical hire import if you have the data; a hires-only handoff to Typhoon (see open questions).

**Your acceptance:** the snow opening's funnel and time to hire match a hand count of five applications; a test hire shows pending, then retained, and a Temporary one is excluded with its count shown; predictiveness shows count tables with small-sample warnings; one person's record exports.

## Things you do outside Tidepool

- Indeed: remove any screener about background checks (Minnesota ban-the-box); add the pay range (by Oct 22). Export the full candidate list when each posting closes and keep it a year.
- Keep paper sign-up sheets a year.
- Background check vendor: confirm it collects a standalone FCRA disclosure and authorization before ordering, sends pre-adverse and adverse notices, and offers Minnesota's copy checkbox (before the first offer).
- If you drug test: a written policy under Minnesota's drug testing law (DATWA) before any test, and which roles may be tested for cannabis.
- Quo: restrict the hiring number to hiring staff; set who it rings.

## What I need from you

- **Tue Oct 13:** approve the rewritten plan and data model; DNS CNAME for tidepool.kahunawindowcleaning.com the same way typhoon. is set up; GitHub access to the Typhoon and REEF repos, or a short note on how they do sign-in, Resend and Quo; add Tidepool's redirect URL to the existing Google OAuth client, or say there is none; which sending domain Resend already has verified for REEF or Typhoon; your own email for the first Admin account. The rest of the staff emails with roles (Admin or Hiring Manager; Viewer is built only when someone needs it) before the Oct 20 dry run.
- **Wed Oct 14:** approve consent text, privacy policy, SMS terms, the AI disclosure sentence, snow pay and benefits text, help contact; name who reads hiring@ and answers 763-292-2259; does Typhoon text the snow technicians?
- **Thu Oct 15:** create the Quo API key when asked (morning), paste it into Railway, turn on auto-recharge; lend one staff phone for the first text test that evening.
- **Fri Oct 16:** snow season dates, headcount, whether snow uses one-on-ones, which checks apply and the vendor; recruit 3 to 5 dry-run testers for Tue Oct 20; roughly how the 40 to 50 hires split between snow and window.
- **Mon Oct 19:** 30-minute production walkthrough. **Tue Oct 20:** dry run. **Wed Oct 21:** acceptance checklist. **Thu Oct 22:** Indeed cleanup and the QR test sheet. **Fri Oct 23:** paste the Indeed link; available all day.
- **Before the Phase 2 deploy:** an Anthropic Console key with a monthly cap, pasted into Railway as `ANTHROPIC_API_KEY` on the cron service (where scoring runs) and on web (for Try it), since the deploy turns snow scoring on; confirm the account can use claude-opus-5-5 and the server-side fallback beta. Then, in the app: the one-on-one booking link in Settings > Message templates; a read of the snow starter rubric and its samples in Settings > AI scoring; approval of the Phase 2 message wording in content/legal/messages.md (still a draft) and of the AI notice; the daily scoring limit (100 unless you change it).
- **By Fri Nov 6:** enter crews in Settings > Picklists.
- **Before the window opening opens:** window rubric (criteria, strong, acceptable and weak examples, weights), final window question wording and pay, season dates, approval of the AI disclosure.

## Open questions with defaults

| Question | Default until answered | Needed by |
|---|---|---|
| Should hired snow techs flow into Typhoon (crew list), and window techs into REEF? | Not built. If yes, a hires-only handoff (name, mobile, email, role, crew, start date, texts-blocked flag) lands after Phase 3; applicant answers never leave Tidepool | Nov 20 |
| Import snow candidates already in progress? | No; they finish the old way | Oct 16 |
| Should the ATS send group interview invites? | No; Indeed sends invites, records start at the QR scan | Dec 1 |
| Where does the interview scorecard live? | Tidepool, with a Notion link | Jan 2027 |
| Languages besides English? | English only; a second language would be a later migration | Jan 2027 |
| Collect voluntary self-identification? | No | Jan 2027 |
| Midwest Access roles in Tidepool? | Not now; needs an Employer row and likely its own carrier registration | 6 weeks before the first Midwest Access hire |
| Retention periods | Defaults in DATA_MODEL.md: 2 years non-hired contact details, 3 years after a hire ends, 4 years consent and messages, 5 years check status, 35 days backups | Nov 25 |
| Two applicants sharing one phone? | Staff mark the number as shared; the second person matches by email | When it first happens |
| Quiet hours for texts | 9am to 8pm Central for every text the applicant did not just request | Any time |
