# Kahuna ATS: Plan

Draft for your approval, written Tue Oct 13, 2026 and revised the same day after five independent reviews. The data model is in [DATA_MODEL.md](DATA_MODEL.md).

## Decisions so far

**Your answers**

- **Employer:** Kahuna employs both roles under Kahuna's EIN and brand. Midwest Access can be added later as an Employer row; if its hiring texts name Midwest Access, expect it to need its own carrier registration, because a registration carries one business name.
- **Hiring number:** a new dedicated local number (763 or 612) added to your existing **Quo** workspace (you asked for Quo over Twilio; it works, see pushback 1). Only hiring staff get access to it, so applicant threads stay out of the customer inbox. No Twilio account and no toll-free backup.
- **Timing:** go live Fri Oct 30 with the applicant flow (QR landing, resume link, autosave, consent, source) plus the admin list view, applicant profile, stage changes with history, notes, Google sign-in and CSV. Kanban drag-and-drop and the question editor follow by about Tue Nov 10.

**Design decisions**

- Email-first launch. Texting through Quo is wired up in early November and turns on behind a switch once Quo confirms hiring texts are covered and the live tests pass. Nothing in the applicant flow depends on texting.
- Person is separate from Application. One application per person per opening. Matching uses the mobile number, then email, never names, and the public form never changes the contact details on file.
- A Role is the permanent job definition. An Opening is one role in one season ("Snow Removal 2026-27") and is the cohort for every report.
- Every pipeline stage maps to a fixed milestone (or none). Reports read milestones, never stage names, and a stage's milestone can't change once applications have passed through it.
- Disqualified, Withdrew and Not selected are closed outcomes with a required reason, not stages. Hold is a flag.
- Stage history is an append-only event log with a backdatable "when it happened" time and a fixed "when it was entered" time. One function writes every change, so the current stage always matches the log.
- Questions are versioned. Publishing creates an immutable form snapshot, and each application pins the version it started on.
- "How did you hear about us?" is a fixed, optional field on the landing form, so drop-off can be reported by source. The entry channel (which QR code or link) is captured automatically for everyone.
- Printed QR codes carry a short opaque code on Kahuna's hiring subdomain, looked up in a table.
- The applicant goes straight into the application on the same screen. The text or email link is only the way back in.
- Resume links use a reusable, hashed token that expires after 30 days without use. The link never appears in server logs or in the stored message log.
- A text goes only to a number with a current opt-in, and an app-level suppression list is checked before every text and email.
- Applicant messages are templated and human-triggered, plus one automatic 24-hour reminder. No AI-written messages. Texts the applicant didn't just ask for wait for the 9am to 8pm Central window.
- Background work runs from a Railway cron service every 5 minutes over the message table. No Redis.
- One hire row per person per season. Retention is measured to the earlier of N days or season end, and an on-call tech who never worked a shift is counted separately.
- AI scoring (Phase 2) is for window cleaning only, labels results Strong, Mixed or Weak, never moves or rejects anyone, and never sees the questions on an Admin-only, audited never-send list.
- Access needs all three: a Google account on your Workspace domain, an allowlist entry and a role. Any other Workspace sign-in waits as Pending until an Admin approves it. Personal Gmail is allowed only for named exceptions you approve, because those accounts sit outside your 2-step verification and offboarding. The default is no exceptions.
- Review screens (list, profile, stage moves, notes) are phone-first. Kanban, configuration and reports are desktop-first.
- Retention is set per record type with a 1-year floor and a legal hold. Expiry strips personal details and keeps the anonymous data reports need.

## Where I'm pushing back on the brief

1. **Quo works for texting, with conditions, and email still carries the launch.** Quo's API sends texts from a Quo number and notifies the ATS of replies and of delivered or failed texts, at about $0.01 a text from a prepaid balance. Applicant replies land in the Quo inbox your team already uses. The catch: Quo registered your one carrier campaign automatically from the message types picked at setup (probably customer service), and carriers can filter texts that don't match it. Only Quo support can say whether hiring texts fit or need a registration update (1 day to about 3 weeks, $15 if resubmitted), so ask them in writing this week. Texting turns on only after Quo confirms in writing, the live tests pass, and the opt-in page and privacy policy (with the "mobile numbers are not shared for marketing" clause) are live on your domain, which the registration needs. Other Quo limits we design around: the API that reports failed texts is still labeled beta, the API has no opt-out list (the ATS keeps its own), and API texts fail outright if the prepaid balance runs out (turn on auto-recharge).

2. **The text consent box has to be optional, and "honor STOP" covers less than the rules require.** Carriers reject registrations where consent is pre-checked or required to apply, so the box is unchecked and optional with the full disclosure beside it. A text goes only to a number whose latest consent record is an opt-in: leaving the box unchecked, or staff editing in a new number, means no texts to that number. Since April 2025 the FCC requires honoring an opt-out made by any reasonable means ("please stop texting me") within 10 business days, which keyword handling won't catch, so every incoming text is logged on the profile and emailed to hiring@, staff record opt-outs with one click, an unhandled text re-alerts after 2 business days, and the suppression list is checked before every send. Quo only acts on one-word opt-outs (STOP, UNSUBSCRIBE and similar), and an applicant's STOP blocks that phone from every Kahuna Quo number, including your customer line, until the person texts START. Staff can't undo it, so the ATS never treats a web form as lifting a text opt-out either.

3. **The applicant flow can't depend on a message arriving, and the reminder belongs in Phase 1.** Venue cell service is unreliable and a mistyped email loses the applicant, so people go straight into the application, email gets typo suggestions and a confirm step, and the link is a reusable hashed token rather than a single-use magic link (Android previews and email link scanners open links before the person does). The brief lists the 24-hour reminder in both the core flow and Phase 2; it ships Oct 30, by text if that number opted in and SMS is on, otherwise by email, only between 9am and 8pm Central, from a scheduled job that survives redeploys.

4. **Printed QR codes are permanent, and a public form that sends messages is a fraud target.** Codes encode a short opaque code on your hiring subdomain (for example `/q/7KX2QF`), so a code can be closed or redirected without reprinting, and role codes and session codes share one table. The landing form gets a bot check, rate limits stored in the database (per phone, email and code, plus a loose per-IP limit because a whole room can share one Wi-Fi address), a daily send cap with an alert, and duplicate detection that resends the existing link to the contact details on file instead of creating a second application.

5. **The data the reports need has to be collected from day one.** Every Phase 3 report depends on facts recorded when they happen (closed-outcome reasons, source, session, stage-to-milestone mapping, backdated times, form versions, consent, the message log, offer and check dates, hire dates), and snow techs hired in November will quit or be let go over the winter. Your Oct 30 list doesn't name reasons, the reminder, hire rows, offer and check dates or the background check guard; I'm keeping them in. After review that is an honest 3 to 4 of the roughly 12 working days, so the admin side starts Wed Oct 21 and the cut order below includes read-only screens that can land Nov 2 to 4 without losing any data.

6. **Stages need fixed milestones, and "Disqualified" is really two outcomes.** Every stage maps to a fixed milestone so renaming "One-on-One Done" or adding "Phone screen" can't break reports, and staff can backdate a move so end-of-week catch-up doesn't distort time in stage; "Applied (started)" becomes a drop-off count, not a board column full of people who never finished. A "Not selected (roles filled)" outcome and a Hold flag are added, because with deliberate over-hiring "we filled the roles" is not a judgment on the person and would corrupt the AI-vs-human report.

7. **Active / Left is the wrong model for seasonal jobs.** Both roles end by design, so every hire eventually becomes "Left", and 90-day retention for a late hire measures the calendar, not fit. We keep one hire row per person per season, count "Completed season" as success, measure retention to the earlier of N days or season end (shown as "pending" until then), and treat "returned next season" as the long-term signal. For on-call snow the default is a season-end rating plus storms worked, and a tech who never worked a storm shows as "never worked", not as retained or pending.

8. **Question predictiveness will be mostly noise for about three seasons.** With 15 hires and 5 leavers, 60% versus 20% on a yes/no question gives p of about 0.25, and across roughly 18 comparisons you should expect one or two false "predictors" a season; knockout questions never show up because every hire answered them the same way. Phase 3 builds count tables with sample-size warnings and a per-leaver review page, changes nothing automatically, and won't be used to tune screening toward "too physical" or "heights" leave reasons, which can stand in for disability.

9. **Make the questions measurable and record your strongest signals.** "Last two jobs, how long, why you left" as long text throws away tenure, so it becomes employer, months (a new number type) and a how-it-ended choice, and new questions map to your leave reasons (another job you're keeping, ladder experience, need for a steady 40 hours), plus "18 or older?", ADA-safe "with or without reasonable accommodation" wording, and prior pay on the do-not-ask list (banned in Minnesota since 2024). The one-on-one grades, ladder test and group interview stars become data fields in Phase 2, because they will predict better than anything typed on a phone.

10. **AI scoring needs guardrails the brief doesn't have.** Reviewers anchor on a visible recommendation, so scores are labeled Strong / Mixed / Weak, we record whether the score was visible when the human decided, and the first window batch is scored hidden. The rubric tells the model to ignore spelling, grammar, length and language and must score a fixed test set (the same answer in broken English and in short form) the same before it goes live. Flags come from a fixed job-related list instead of free-form "red flags" (which would name kids, health, gaps or "just got out"). Answers that invite those disclosures (two-year plans, slow stretches, employer names, age, essential functions) are never sent, and snow gets no scoring at all, because snow applicants never saw an AI disclosure.

11. **Google domain sign-in is not access control, and "CSV of everything" is the easiest data leak.** Any employee with a company Google account could get in, so sign-in also requires an allowlist entry and a role, new sign-ins wait as Pending, and every action checks the user's live role on the server. CSV becomes a set of exports (questions differ by role and version) that only Admins can run, every export is logged, restricted notes are left out, and cells starting with =, +, -, @, a tab or a carriage return are escaped so spreadsheets don't run applicant text as formulas.

12. **"Keep one year" is a floor, and some hiring records live outside the ATS.** Retention is per record type with a 1-year minimum and a legal hold (FCRA claims can come up to 5 years later, TCPA 4), and expiry strips personal details instead of deleting the anonymous data. The ATS blocks a background check before a conditional offer. While a check is open, any rejection must either be marked background-based (naming the check, and waiting 5 business days after its pre-adverse notice) or carry a recorded statement that it doesn't rely on the report. Outside the ATS, you need to export Indeed's full candidate list (screened-out people included) when each posting closes, keep the paper sign-up sheets for a year, and remove any Indeed screener about background checks (Minnesota ban-the-box).

13. **Some configuration stays in a reviewed seed file until Phase 2.** The brief wants new roles without code changes. That holds from Phase 2, when a settings screen creates roles from a template and edits openings (pay, dates, headcount, open or close), and a stage and picklist editor follows. Until then new content (questions, forms, roles) goes through the reviewed seed file, and edits to live settings (opening dates, pay, headcount, opening or closing an opening, archiving a stage or option, closing a QR code) go through a second reviewed command, `config:apply`. It runs the same service-layer checks as the future screens and writes an audit entry per change, so nobody edits production with ad hoc SQL. The builder runs both, so the Oct 30 and Nov 10 dates hold; snow's pipeline and reasons are fixed by Oct 23 anyway. Retention settings and legal holds arrive with the Phase 3 purge job; nothing is purged before then, so until that screen a legal hold is a note plus an audit entry.

14. **Phase 3 reports land after D, not "before spring".** D is the first 2027 window group interview. There is no window data before D, and snow data alone is too thin to tune anything, so the Hires page lands by D, the time and funnel reports by D plus 4 weeks, and retention and predictiveness by D plus 8 weeks.

## Stack

- **Next.js App Router, strict TypeScript, current Node LTS.** One app serves applicant pages, admin and webhooks. Business logic lives in a service layer separate from routes, so a CRM API can be added later without rework.
- **Drizzle ORM with drizzle-kit generated SQL migrations.** Migrations are committed, reviewed and applied as a Railway pre-deploy step; `drizzle-kit push` never touches production. Triggers go in hand-written migration files. Chosen over Prisma because it stays close to SQL, which this model leans on (partial unique indexes, composite foreign keys, triggers, report queries).
- **Postgres on Railway (Pro plan, US region), production and staging.** Private networking only. The app connects as a role without superuser rights, because Railway's default user is a superuser that could switch off the safety triggers; migrations run as the owner. Railway Postgres is a container on a volume, not a managed database with point-in-time recovery, so we add scheduled volume backups, a nightly `pg_dump` encrypted with a key only you hold and uploaded to a separate bucket with write-only credentials (deleted after 35 days), and one tested restore before go-live.
- **Better Auth with the Google provider and database sessions.** It has a Drizzle adapter; the Workspace domain check, allowlist, Pending status and roles sit on top. Every server action and route checks the user's live status and role in the service layer, not just in middleware. Sessions have a fixed lifetime, and disabling a user or changing a role ends their sessions. Auth.js is the fallback if the adapter misbehaves.
- **Quo API** for texts, from the new hiring number: send through Quo's v1 messages endpoint; Quo's newer signed webhooks (Standard Webhooks format, checked against the raw body, deduplicated by webhook id) for incoming texts and for delivered, failed and undelivered status. The ATS keeps its own opt-out list because Quo exposes none, and replies to HELP itself if Quo doesn't. All Quo calls sit behind one small provider module, so switching to Twilio later is a contained change if Quo ever falls short. The API key (Owner or Admin creates it) lives in a Railway environment variable.
- **Resend** on a sending subdomain, paid plan from launch (the free tier caps daily volume). From "Kahuna Window Cleaning Hiring", Reply-To the hiring@ Google Group, DKIM/SPF/DMARC set, signed webhooks for bounces and complaints, each message's id sent as the idempotency key.
- **Jobs: a Railway cron service every 5 minutes** (Quo's API has no scheduled send, so the reminder is ours anyway). It sends due messages from the message table (claimed with `SELECT ... FOR UPDATE SKIP LOCKED`), queues reminders, prunes rate-limit rows and runs a nightly consistency check. Survives redeploys; no Redis, and no separate job table until Phase 2 scoring. Resume links send immediately in the request; cron retries failures.
- **UI:** Tailwind and shadcn/ui; react-hook-form with zod schemas shared by client and server; TanStack Table for the list; dnd-kit for the kanban; libphonenumber-js; a QR library with SVG output for print.
- **Cloudflare Turnstile** bot check on the landing and lost-link pages only. The application opens with a full page load, so the script doesn't follow the applicant into their answers.
- **Sentry** for errors, with request bodies, personal data and application links scrubbed.
- **Time:** all Central-time math goes through one helper and servers run on UTC. Daylight saving time ends Sun Nov 1, two days after launch, and tests cover it.
- **Vitest** for the service layer against real Postgres (versioning, event log and voiding, tokens, consent and send rules, milestone math, concurrent saves and moves, CSV escaping). **Playwright** on iPhone and Android viewports: landing, autosave, resume on a second device, a phone that saves offline and reconnects after another device edited the same answers, submit, an admin stage change.
- **GitHub Actions** runs typecheck, lint and tests against a Postgres service container; Railway deploys `main` only after checks pass. Staging has seed data and a message sink that never sends real texts or emails.
- **Phase 2:** Anthropic SDK with structured JSON output, the model id in config, no tools, Message Batches for re-scoring.
- **Versions:** none are pinned in this plan. The builder pins exact versions when scaffolding, checked against current docs rather than memory.

## Phase 1 scope (go live Fri Oct 30)

### Must ship Oct 30

Applicant side:
- `/q/<code>` resolver with daily scan counts. Closed codes fall back to the role page. The launch codes (snow role QR and the snow Indeed-message link) are created by script.
- Role landing page: summary, pay range, benefits, "any background check comes after a conditional offer."
- Landing form: first and last name, mobile (validated), email (typo suggestions and confirm), optional "How did you hear about us?", optional unchecked text consent with full disclosure, bot check, rate limits. A retried submit on weak signal returns the same application.
- Straight into the application: 3 to 5 sections, progress bar, per-field autosave with retry and an offline copy that never overwrites newer answers saved from another device, "Saved" indicator, required checks only on submit.
- Resume link by email at once (and by text once SMS is on and the number opted in). "Lost your link?" page that never reveals whether a match exists. A known mobile and email resend the link to the details on file; a mobile and email that point at different people go to staff instead of creating an application.
- Submit: on-screen confirmation and email, plus a stored snapshot of the submitted answers. Afterward the link opens a status page, not the answers.
- One 24-hour reminder, 9am to 8pm Central, never twice, skipped for submitted, closed or do-not-contact applicants.
- Privacy policy, SMS terms and the public opt-in page. Applicant pages are noindex, send no referrer, and load no third-party scripts except the bot check on the landing and lost-link pages.

Admin side:
- Google sign-in with allowlist, Pending state and roles (Admin, Hiring Manager; Viewer only if your staff list names one).
- List view per opening: counts at the top (started, in progress, submitted, submit rate, and the same per entry code), filters (stage, status, source, entry code, dates, hold, attention flags, contact conflicts), search, stage dropdown, bulk move. Works on a phone.
- Applicant profile with next/previous: answers with question version, stage history, notes (with a restricted flag; edits keep the old text), messages in and out, consent records, resend or revoke link, contact edits (audited), shared-phone flag, text opt-out and do-not-contact buttons, Indeed apply date.
- Stage change dialog: backdatable time, closed outcomes with reason and note, Hold, Reopen, "Contacted" marker. If someone else changed the application first, it says who and reloads.
- Offer and check capture in the same dialog: moving to Conditional offer records the offer date (and planned start if known); moving to Background check records the check type and requested date. The profile shows each check, where staff update its status and record its pre-adverse notice date (write-once except for Admins).
- FCRA guard: no background check without a live conditional offer; a background-based disqualification names the check it relies on and waits 5 business days after that check's pre-adverse notice; while a check is open, any other rejection needs a recorded statement that it doesn't rely on the report.
- Hire row created automatically when an application reaches Hired; undoing that move voids it.
- Suppression list with email bounce and complaint handling.
- CSV export set: Admin-only, logged, formula-escaped, with a dictionary file so codes can be read outside the app.

Platform:
- Railway production (a shell on the hiring subdomain from Oct 15, serving the legal and opt-in pages from Oct 16) and staging, migrations on pre-deploy, a non-superuser app role, backups plus the encrypted off-site dump, a tested restore, Sentry, CI, Playwright.
- Seed data from DATA_MODEL.md: Kahuna, two roles, pipelines, both question sets, picklists, legal text, templates, the launch codes and a "Snow dry run" opening for Oct 27 to 28. Loaded from a reviewed seed file by a manual, insert-only loader that creates real version records and never edits a published one. Changes to live settings go through `config:apply` (pushback 13), which is how the dry run gets closed and the snow opening opened on Oct 29.

### Ships by ~Nov 10 (in this order)

1. Quo wiring: send path, the signed webhook for incoming texts and delivery status, the inbound text screen, opt-out handling, HELP replies, the first-text disclosure, and live tests on staff phones: a normal send, STOP, START, HELP, a send to an opted-out number, an empty prepaid balance, and whether API-sent threads show for every hiring staff member in Quo. This is the gate for turning texting on.
2. Hire form and offer and check panel on the profile: start date, crew, last day worked, end date, outcome, reason, rehire eligible, 30 and 90 day ratings, season-end rating and storms worked (snow), offer pay and response, check vendor, status and dates, with edit history. Needed before the first snow hire starts or leaves.
3. Kanban drag-and-drop board (desktop-first).
4. Question editor: draft, publish a new locked version, "reworded or new question?" prompt, do-not-ask list, required change reason. Until then question changes go through the reviewed seed file, which still creates versions.
5. Entry code screen: create a code, download the QR as SVG or PNG. Group session records with a per-session QR join it only if you confirm by Oct 23 that snow will run sessions; otherwise they ship with the Phase 2 group interview tools.

Texting switches on once item 1 passes and Quo has confirmed in writing that hiring texts are covered (after any registration update), whichever comes later.

### Collected in Phase 1, screens come later

These are captured from the first applicant because they can't be reconstructed afterward.

| Data | Feeds | Screen arrives |
|---|---|---|
| Stage events with "happened" and "entered" times, milestone mapping | Time to hire, time in stage, funnel | Phase 3 |
| Closed-outcome reasons and notes | Reason breakdowns, defending a decision | Phase 3 |
| Source (from the landing form), entry code, scanned session, Indeed apply date | Source, drop-off and session reports | Phase 3 |
| Pinned form version, answers stored by option key, submitted-answer snapshots | Predictiveness across versions, defending a decision | Phase 3 |
| Daily QR scan counts | Scans to starts | Phase 3 |
| Consent events with the exact text version shown | Proof of opt-in | Profile now, report Phase 3 |
| Message log with delivery status | Time to first contact, deliverability | Phase 3 |
| Offer and background check dates | Time to offer, FCRA proof | Panel by Nov 10 |
| Hire rows with dates and outcomes | Retention | Hire form Nov 10, Hires page Phase 3 |
| Audit log (edits, exports, note revisions) | Audit viewer | Phase 3 |

### Cut order if the schedule slips

Oct 30 items, first cut to last. Items 1 to 5 are read-only or convenience screens over data that is still captured from day one, so they can land Nov 2 to 4 with nothing lost:
1. Messages and consent panels on the profile (the data is still logged).
2. List counts per entry code (overall counts stay).
3. CSV long files other than answers, stage events and the dictionary.
4. The nightly consistency-check email (the check itself can wait a week; tests cover the same rules).
5. The offline queue in autosave (saves still retry and never overwrite newer answers; snow mostly applies from home through the Indeed link).
6. Bulk move in the list view (single moves remain).
7. Milestone-date columns in the wide export (the stage events file carries the same facts).
8. "Lost your link?" page (staff resend from the profile; applicants call the office).
9. The offer and check fields in the stage dialog. Even then, the move into Conditional offer still creates the offer row automatically with its date (that part costs almost nothing), moves into Hired stay open so early snow hires are recorded, and only moves into Background check are blocked (with background-based reasons hidden) until the November panel ships.

Nov 10 items: session QR is cut first (unless snow sessions are confirmed), then the entry code screen. Quo wiring and the hire form are not cut. Kanban and the question editor are not cut either: if either slips, it lands by Tue Nov 17.

**Never cut:** consent capture with text versions; the opt-in and suppression checks in the single send function; links never stored readable; the stage event log with milestones and reasons; versioned answers pinned to a form version; source and entry code; privacy policy, SMS terms and opt-in page; allowlist sign-in with server-side checks; the FCRA guard; backups with a tested restore.

## Phase 1 calendar

| Date | Builder | You |
|---|---|---|
| Tue Oct 13 | Plan and data model delivered | Blocking answers (done). Send the domain and Workspace domain(s) today if you can; book counsel for Oct 15 to 16 if you want legal review |
| Wed Oct 14 | Repo, CI, Railway staging and production shells, draft legal text (no schema until you approve the data model) | Quo: check the registration in Trust center, email Quo support about hiring texts, add the hiring number, create the API key, turn on auto-recharge. Railway, Resend, Sentry, Cloudflare, Google OAuth client, personal Gmail exceptions (if any), confirm DNS access |
| Thu Oct 15 | Schema, migrations and seed loader once approved; privacy policy, SMS terms and consent text ready for you; production shell on the hiring subdomain | Approve this plan and the data model; add DNS records; forward Quo support's answer when it arrives |
| Fri Oct 16 | QR resolver, landing page and application form on staging; legal pages and opt-in page live in production | Approve legal text, consent scope and the three launch emails; snow wording, pay, logo, HELP contact; hiring@ group set up and tested. DNS decision: if records aren't verified today, buy a hiring domain today |
| Mon Oct 19 to Tue Oct 20 | Autosave, submit, resume tokens, email, lost-link page, reminder and cron, bot check, rate limits, consent and suppression, contact conflicts; Playwright for the applicant flow | If Quo says the registration needs an update, submit it now that the opt-in page is live |
| Wed Oct 21 to Fri Oct 23 | Sign-in, allowlist, roles, list, profile, notes, stage changes with reasons, backdating, Hold, offer and check capture, FCRA guard, hire rows | Staff list (Thu). Background check vendor, snow season dates, snow pipeline, first expected snow offer date, flyers or not, in-flight candidates, backup bucket (Fri) |
| Mon Oct 26 | CSV exports, QR generation, backups and the encrypted off-site dump | 30-minute admin walkthrough on staging; if flyers: approve QR artwork, print one test sheet |
| Tue Oct 27 | Production deploy with the "Snow dry run" opening open; restore test from the off-site dump; Playwright against production | If flyers: scan the test sheet on iPhone and Android; print in bulk only after it passes |
| Wed Oct 28 | Support the dry run, triage the fix list | Staff dry run of the snow path (#18) |
| Thu Oct 29 | Fixes, code freeze at 3pm, close the dry run, open the snow opening | Sign off on the fixes; paste the snow link into Indeed's message template and auto-reply |
| Fri Oct 30 | Go live; watch Sentry, email delivery and first submissions | Available all day |
| Nov 2 to Nov 10 | Anything cut from Oct 30 (Nov 2 to 4), then the Nov 10 list in order; texting on once the Quo wiring passes and Quo has confirmed coverage | Crew list by Fri Nov 6; a staff phone for the Quo live tests |

Weekends are builder buffer. Nothing on them needs you.

## Phase 2

**Deadline anchor:** D = the date of the first 2027 window cleaning group interview, which you confirm by early December. Phase 2 is in production by **D minus 3 weeks**, so the rubric can be run against sample answers and the test set before real applicants arrive. Your rubric draft is due **D minus 6 weeks**. If D is in early March, production is about Feb 12 and the rubric is due about Jan 22.

Scope:
- Rubric editor (Admin only): draft criteria with stable ids, strong, acceptable and weak guidance, weights, the question lineages each criterion reads, and a fixed job-related flag list; run the test set, which must pass; publish with a written reason. A criterion whose guidance changes meaning is marked, so reports stop pooling across it.
- AI scoring on submit for window cleaning: only the questions the rubric reads are sent, never the never-send list. Scores stored with rubric version, model id, prompt version and the exact data sent. Re-scoring through batches. Rationale keyword scan with Admin alerts.
- Review decisions (Advance, Hold, Decline) recording whether the AI score was visible. The decision compared with the AI is the **screening** decision: for a scored application, a close, a move to One-on-One Invited or later, or a Hold writes it automatically (a later screening action supersedes a Hold), and anything after the applicant reaches One-on-One Invited writes nothing. So quick declines can't drop out of the agreement report, and a later ladder-test failure isn't counted as the reviewer disagreeing with a Strong score. The first window batch is scored hidden.
- AI disclosure on the application, reviewed by counsel. Snow is never sent to the AI; the pipeline is tested with the rubric's fixed test set and sample window answers instead.
- Group interview tools: session records and per-session QR (if not shipped in November), sign-in entry (paper with a phone column, or a door check-in), automatic matching by phone, staff-confirmed name matches, stars with a job-related reason picklist and a concern mark.
- One-on-one record: booked time (Google booking link in the invite), interviewer, A+ to F category grades, recommendation, Notion link. Ladder test as Pass, Fail or Did not attempt.
- Template editor and the Phase 2 templates (one-on-one invite, one-on-one reminder, decline, status update). A group invite template only if you decide the ATS sends invites.
- Settings, before the window opening opens: role and opening screen (create a role from a template, edit pay, benefits, dates and headcount, open or close an opening) and the stage and picklist editor. A used stage is archived and replaced, never remapped.
- Person merge tool (Admin only), for returning workers who come back with a new phone and email.

## Phase 3

Deadlines are tied to the same date D:
- **By D:** Hires page (list, edit, season-end outcome, crew, rehire; reuses the November hire form), so window hires are recorded from the first one. Single-person record export for Minnesota personnel-record requests, which need a response within 7 working days (handled by a manual query until then).
- **By D plus 4 weeks:** time to hire, time in stage, funnel, session attendance, drop-off and time to first contact reports.
- **By D plus 8 weeks:** retention, question predictiveness and AI-vs-human-vs-retention screens. They will show "pending" and small-sample warnings until the season ends, and that is expected.
- **Before Sep 2027:** retention settings screen (1-year floor enforced, audited) and legal hold place and release, then the retention purge job (which also deletes the matching texts in Quo if its API allows it, otherwise a documented manual cleanup) and the audit log viewer, ahead of the first records passing the 1-year floor in Nov 2027. Historical hire import if you have the data.
- **When the CRM exists:** a hires-only API. Applicant contact details never flow to the CRM.

## What I need from you

Unknown inputs (I will not guess these):

| # | What | By | Notes |
|---|---|---|---|
| 1 | Kahuna's web domain for the hiring subdomain (for example `jobs.<domain>`), and who controls its DNS | Wed Oct 14 | Records go in Thu Oct 15: the app CNAME and Railway verification, Resend's DKIM, SPF and return-path, DMARC. QR codes, launch email and sign-in all depend on them. Hard decision Fri Oct 16: if they aren't verified, you buy a dedicated hiring domain that day at a registrar with built-in DNS (no email reputation yet, so the dry run checks inbox placement, and your main site links the privacy policy). Codes are never printed on Railway's default domain |
| 2 | Google Workspace domain(s) staff sign in with, and any personal Gmail exceptions (default none) | Wed Oct 14 | Sets the sign-in check and whether the OAuth consent screen is Internal or External |
| 3 | Staff user list: name, Google email, role (Admin, Hiring Manager, Viewer) | Thu Oct 22 | Everyone signs in before the Oct 28 dry run. Viewer is built for launch only if someone on the list needs it |

Accounts and filings:

| # | What | By | Lead time |
|---|---|---|---|
| 4 | Quo: in Settings, Trust center, confirm the carrier registration is an approved **Business (EIN)** registration in Kahuna's legal name, not Sole Proprietor, and note the message types it lists | Wed Oct 14 | Minutes |
| 5 | Email Quo support (keep it in writing): "We will text job applicants who opted in on our web form: their application link, one reminder, interview scheduling and reminders, status updates and declines, through the API from a new number in our workspace. Does our current registration cover this, or does it need an update? Does our texting keep working during any re-review?" | Wed Oct 14 | Answer in days; an update takes 1 day to about 3 weeks and needs the opt-in page live (Oct 16) |
| 6 | Quo: add a local 763 or 612 number for hiring ($5 a month) and give only hiring staff access; Owner or Admin creates an API key and sends it to me privately (never in chat or email); turn on auto-recharge for the messaging balance | Wed Oct 14 | Minutes |
| 7 | If Quo needs a registration update: submit it with the wording I draft (texts go only to people who applied and opted in, no pay amounts or "earn" wording, sample messages, the opt-in page and privacy policy URLs). You make the attestations; I can't | As soon as Quo answers, after Oct 16 | 1 day to about 3 weeks |
| 8 | Google Cloud OAuth client by a Workspace super admin, with production and staging redirect URLs | Wed Oct 14 | 30 minutes |
| 9 | Business-owned Railway workspace (Pro, billing), GitHub access for Railway and the builder; Resend paid plan and API key; Sentry account; Cloudflare account with a Turnstile site for the hiring host | Wed Oct 14 | Same day |
| 10 | Off-site backup bucket (S3, R2 or B2) with a write-only key; you keep the private key that decrypts the dumps offline | Fri Oct 23 | An hour |
| 11 | hiring@ Google Group: anyone outside the organization can post, no moderation, every member gets each message by email; tested with an outside Gmail address and an app alert. Name the person who reads it | Fri Oct 16 | That person records any "stop texting me" (by text, call, email or in person) with the one-click opt-out the same day |

Decisions and content:

| # | What | By | Notes |
|---|---|---|---|
| 12 | Approve PLAN.md and DATA_MODEL.md; same-day answers through Oct 30 | Thu Oct 15 | One 3-day wait uses the whole buffer |
| 13 | Approve consent text, privacy policy, SMS terms and the three launch emails (resume link, reminder, submit confirmation); drafts arrive Thu Oct 15. Consent scope: default is this application only. If you want texts about future openings, decide by this date so any Quo registration update covers them | Fri Oct 16 | Counsel either finishes by this date, or you approve v1 now and counsel reviews before Phase 2 (a new text version later is cheap) |
| 14 | Snow: sign off on the question wording in DATA_MODEL.md, pay rate or range, benefits summary, logo, HELP phone and email | Fri Oct 16 | Pay appears on the landing page |
| 15 | Snow season start and expected end, target headcount; whether snow uses one-on-ones; which checks apply; date of the first expected snow offer; whether snow flyers get printed | Fri Oct 23 | Sets the snow pipeline, retention windows and the November order |
| 16 | Background check vendor and checks per role (criminal, driving record, drug screen). Confirm the vendor collects a standalone FCRA disclosure and authorization before ordering, sends pre-adverse and adverse notices, and offers Minnesota's copy checkbox. If you drug test: a written policy under Minnesota's drug testing law (DATWA) before any test, and which roles may be tested for cannabis | Fri Oct 23 | Vendor setup can take days |
| 17 | Indeed: remove any screener about background checks, add pay range; export the full candidate list when each posting closes and keep it a year; keep paper sign-up sheets a year. On Oct 29, paste the snow Indeed-message link into the message template and any auto-reply | This week, and Oct 29 | Minutes per posting |
| 18 | Dry run of the snow path, 5 to 10 people on iPhones and Androids: get an Indeed message with the link, open it in the Indeed app, start, leave, resume from the email, submit. Check where the emails land (Gmail, Outlook, Yahoo, iCloud) | Wed Oct 28 | Book the people now. Venue QR scanning waits until a group session is scheduled |
| 19 | Be available on go-live day | Fri Oct 30 | |
| 20 | Crew list for the hire form | Fri Nov 6 | |
| 21 | Date D (first 2027 window group interview); past hire records if you want them imported | Early Dec | D sets the Phase 2 and 3 deadlines |
| 22 | Window rubric: criteria, strong / acceptable / weak examples, weights | D minus 6 weeks | Your work, not the builder's |
| 23 | Window: final question wording (including any physical requirement figures from the written job description), pay range, season dates | D minus 6 weeks | |
| 24 | Anthropic Console account with billing and a monthly cap; federal contractor or Minnesota workforce certificate status; counsel review of the AI disclosure | Early Jan | |

## Open questions that can wait

| Question | Default until answered | Needed by |
|---|---|---|
| Should the ATS send group interview invites (people exist before they scan)? | No. Indeed sends invites; records start at the QR scan | Dec 1 |
| Will snow run group interview sessions this fall? | No. Snow applicants arrive through the Indeed message link; session QR ships in Phase 2 | Oct 23 |
| Import snow candidates already in progress? | No. They finish the old way | Oct 23 |
| Is a returning seasonal worker a new hire each season? | Yes. One hire row per season, linked to the same person | Nov 6 |
| What makes a good on-call snow hire? | Season-end rating (Reliable, Mixed, Unreliable, Never worked) plus storms worked; predictiveness compares Reliable with Mixed or Unreliable and shows Never worked separately | Mar 2027 |
| Can the sign-in sheet capture mobile numbers? | Paper sheet with a phone column, matched by phone | Jan 2027 |
| Where does the interview scorecard live? | The ATS, with a Notion link | Jan 2027 |
| Languages besides English? | English only; all applicant text stored by language | Jan 2027 |
| Who reads replies to the hiring number? | The person named in #11; every text is logged in the ATS and emailed to hiring@ | Oct 16 |
| Can staff reply to applicant texts by hand in Quo? | Yes, to answer a question an applicant texted, typed by a person (never AI), as they would on a phone call. Invites, declines and status news always go out as ATS templates so they're logged. Whether hand replies typed in Quo also appear in the ATS gets checked in the live tests | Oct 30 |
| Import past seasons' hire outcomes? | Yes, hire outcomes only, flagged historical, in Phase 3 | Early Dec |
| Collect voluntary self-identification? | No | Jan 2027 |
| Midwest Access roles in the ATS? | Not now. Needs an Employer row and likely its own carrier registration if texts name Midwest Access | 6 weeks before the first Midwest Access hire |
| Retention periods | Defaults in DATA_MODEL.md: 2 years for non-hired contact details, 3 years after a hire ends, 4 years for consent and messages, 5 years for check status, 35 days for backups and off-site dumps | Sep 2027 |
| Two applicants sharing one phone? | Staff mark the number as shared on the profile; the second person then matches by email | When it first happens |
| Quiet hours for texts | 9am to 8pm Central for every text the applicant didn't just request | Any time |
