# Kahuna ATS: Plan

Draft for your approval, written Tue Oct 13, 2026. The data model is in [DATA_MODEL.md](DATA_MODEL.md).

## Decisions so far

**Your answers**

- **Employer:** Kahuna employs both roles under Kahuna's EIN and brand. One 10DLC brand and one campaign get registered now. Midwest Access can be added later as an Employer row; if its hiring texts name Midwest Access, plan on a second brand registration, because a brand carries one name.
- **Hiring number:** a new dedicated local Twilio number (763 or 612), with calls forwarded to the office. No toll-free backup.
- **Timing:** go live Fri Oct 30 with the applicant flow (QR landing, resume link, autosave, consent, source) plus the admin list view, applicant profile, stage changes with history, notes, Google sign-in and CSV. Kanban drag-and-drop and the question editor follow by about Tue Nov 10.

**Design decisions**

- Email-first launch. SMS is built, tested and behind a switch that flips the day the campaign is approved. Nothing in the applicant flow depends on SMS.
- Person (contact details) is separate from Application. One application per person per opening. Matching uses the mobile number, then email, never names.
- A Role is the permanent job definition. An Opening is one role in one season ("Snow Removal 2026-27") and is the cohort for every report.
- Every pipeline stage maps to a fixed milestone (or none). Reports read milestones, never stage names.
- Disqualified, Withdrew and Not selected are closed outcomes with a required reason, not stages. Hold is a flag.
- Stage history is an append-only event log with a backdatable "when it happened" time and a fixed "when it was entered" time.
- Questions are versioned. Publishing creates an immutable form snapshot, and each application pins the version it started on.
- "How did you hear about us?" is a fixed system field. The entry channel (which QR code or link) is captured automatically.
- Printed QR codes carry a short opaque code on Kahuna's hiring subdomain, looked up in a table.
- The applicant goes straight into the application on the same screen. The text or email link is only the way back in.
- Resume links use a reusable, hashed token that expires after 30 days without use.
- An app-level suppression list is checked before every text and email.
- Applicant messages are templated and human-triggered, plus one automatic 24-hour reminder. No AI-written messages.
- Background jobs run from a Railway cron service against a Postgres job table. No Redis.
- One hire row per person per season. Retention is measured to the earlier of N days or season end.
- AI scoring (Phase 2) is for window cleaning only, labels results Strong, Mixed or Weak, and never moves or rejects anyone.
- Admin access needs an allowlist entry and a role, not just a company Google account.
- Review screens (list, profile, stage moves, notes) are phone-first. Kanban, configuration and reports are desktop-first.
- Retention is set per record type with a 1-year floor and a legal hold. Expiry strips personal details and keeps the anonymous data reports need.

## Where I'm pushing back on the brief

1. **SMS will probably not be live on Oct 30, so email carries the launch.** The Twilio profile, brand and campaign reviews run in sequence, so a realistic campaign filing is Oct 16 to 21 and approval lands between late October and mid-November; each rejection restarts the clock, and with no toll-free backup one rejection likely means no texts until late November. We launch email-first with SMS behind a switch, and the real critical path becomes the public privacy policy (including the "mobile numbers are not shared for marketing" clause), the SMS terms and the opt-in page.

2. **The text consent box has to be optional, and "honor STOP" covers less than the rules require.** Carriers reject campaigns where consent is pre-checked or required to apply, so the box is unchecked and optional with the full disclosure beside it. Since April 2025 the FCC requires honoring an opt-out made by any reasonable means ("please stop texting me") within 10 business days, which keyword handling won't catch, so every incoming text is logged on the profile and emailed to hiring@, staff get a one-click opt-out, and the suppression list is checked before every send.

3. **The applicant flow can't depend on a message arriving, and the reminder belongs in Phase 1.** Venue cell service is unreliable and a mistyped email loses the applicant, so people go straight into the application, email gets typo suggestions and a confirm step, and the link is a reusable hashed token rather than a single-use magic link (Android previews and email link scanners open links before the person does). The brief lists the 24-hour reminder in both the core flow and Phase 2; it ships Oct 30 by email, only between 9am and 8pm Central, from a scheduled job that survives redeploys.

4. **Printed QR codes are permanent, and a public form that sends messages is a fraud target.** Codes encode a short opaque code on your hiring subdomain (for example `/q/7KX2QF`), so a code can be closed or redirected without reprinting, and Phase 1 role codes and Phase 2 session codes share one table. The landing form gets per-IP and per-phone rate limits, a bot check, US-only Twilio geo permissions, a daily send cap with an alert, and duplicate detection that resends the existing link instead of creating a second application.

5. **The data the reports need has to be collected from day one.** Every Phase 3 report depends on facts recorded when they happen (closed-outcome reasons, source, session, stage-to-milestone mapping, backdated times, form versions, consent, the message log, hire dates), and snow techs hired in November will quit or be let go over the winter. Your Oct 30 list doesn't name reasons, the reminder, hire rows or the background check guard; I'm keeping them in at an honest cost of 2 to 3 of the roughly 12 working days, which is why there is a cut order below.

6. **Stages need fixed milestones, and "Disqualified" is really two outcomes.** Every stage maps to a fixed milestone so renaming "One-on-One Done" or adding "Phone screen" can't break reports, and staff can backdate a move so end-of-week catch-up doesn't distort time in stage; "Applied (started)" becomes a drop-off count, not a board column full of people who never finished. A "Not selected (roles filled)" outcome and a Hold flag are added, because with deliberate over-hiring "we filled the roles" is not a judgment on the person and would corrupt the AI-vs-human report.

7. **Active / Left is the wrong model for seasonal jobs.** Both roles end by design, so every hire eventually becomes "Left", and 90-day retention for a late hire measures the calendar, not fit. We keep one hire row per person per season, count "Completed season" as success, measure retention to the earlier of N days or season end (shown as "pending" until then), and treat "returned next season" as the long-term signal; for on-call snow the default is a season-end rating plus storms worked.

8. **Question predictiveness will be mostly noise for about three seasons.** With 15 hires and 5 leavers, 60% versus 20% on a yes/no question gives p of about 0.25, and across roughly 18 comparisons you should expect one or two false "predictors" a season; knockout questions never show up because every hire answered them the same way. Phase 3 builds count tables with sample-size warnings and a per-leaver review page, changes nothing automatically, and won't be used to tune screening toward "too physical" or "heights" leave reasons, which can stand in for disability.

9. **Make the questions measurable and record your strongest signals.** "Last two jobs, how long, why you left" as long text throws away tenure, so it becomes employer, months (a new number type) and a how-it-ended choice, and new questions map to your leave reasons (another job you're keeping, ladder experience, need for a steady 40 hours), plus "18 or older?", ADA-safe "with or without reasonable accommodation" wording, and prior pay on the do-not-ask list (banned in Minnesota since 2024). The one-on-one grades, ladder test and group interview stars become data fields in Phase 2, because they will predict better than anything typed on a phone.

10. **AI scoring needs guardrails the brief doesn't have.** Reviewers anchor on a visible recommendation, so scores are labeled Strong / Mixed / Weak, we record whether the score was visible when the human decided, and the first window batch is scored hidden. The rubric tells the model to ignore spelling, grammar, length and language and must score a fixed test set (the same answer in broken English and in short form) the same before it goes live; flags come from a fixed job-related list instead of free-form "red flags" (which would name kids, health, gaps or "just got out"), answers that invite those disclosures are not sent, and snow gets no visible scoring.

11. **Google domain sign-in is not access control, and "CSV of everything" is the easiest data leak.** Any employee with a company Google account could get in, so sign-in also requires an allowlist entry and a role, and new sign-ins wait as Pending. CSV becomes a set of exports (questions differ by role and version) that only Admins can run, every export is logged, restricted notes are left out, and cells starting with =, +, - or @ are escaped so spreadsheets don't run applicant text as formulas.

12. **"Keep one year" is a floor, and some hiring records live outside the ATS.** Retention is per record type with a 1-year minimum and a legal hold (FCRA claims can come up to 5 years later, TCPA 4), and expiry strips personal details instead of deleting the anonymous data. The ATS blocks a background check before a conditional offer and blocks a background-based disqualification until 5 business days after the pre-adverse notice; outside the ATS, you need to export Indeed's full candidate list (screened-out people included) when each posting closes, keep the paper sign-up sheets for a year, and remove any Indeed screener about background checks (Minnesota ban-the-box).

## Stack

- **Next.js App Router, strict TypeScript, current Node LTS.** One app serves applicant pages, admin and webhooks. Business logic lives in a service layer separate from routes, so a CRM API can be added later without rework.
- **Drizzle ORM with drizzle-kit generated SQL migrations.** Migrations are committed, reviewed and applied as a Railway pre-deploy step; `drizzle-kit push` never touches production. Chosen over Prisma because it stays close to SQL, which this model leans on (partial unique indexes, composite foreign keys, triggers, report queries).
- **Postgres on Railway (Pro plan, US region), production and staging.** Private networking only. Railway Postgres is a container on a volume, not a managed database with point-in-time recovery, so we add scheduled volume backups, a nightly `pg_dump` stored outside Railway, and one tested restore before go-live.
- **Better Auth with the Google provider and database sessions.** It has a Drizzle adapter; the Workspace domain check, allowlist, Pending status and roles sit on top. Auth.js is the fallback if the adapter misbehaves.
- **Twilio Messaging Service** holding the new local number: Advanced Opt-Out for STOP, HELP and START, US-only geo permissions, signed webhooks, delivery callbacks into the message log.
- **Resend** on a sending subdomain, paid plan from launch (the free tier caps daily volume). From "Kahuna Window Cleaning Hiring", Reply-To the hiring@ Google Group, DKIM/SPF/DMARC set, signed webhooks for bounces and complaints.
- **Jobs: a Railway cron service every 5 minutes plus a Postgres job table**, claimed with `SELECT ... FOR UPDATE SKIP LOCKED`. Survives redeploys, no Redis. Resume links send immediately in the request; cron retries failures and sends reminders.
- **UI:** Tailwind and shadcn/ui; react-hook-form with zod schemas shared by client and server; TanStack Table for the list; dnd-kit for the kanban; libphonenumber-js; a QR library with SVG output for print.
- **Cloudflare Turnstile** bot check on the landing and lost-link forms.
- **Sentry** for errors, with request bodies and personal data scrubbed.
- **Vitest** for the service layer against real Postgres (versioning, event log, tokens, milestone math, CSV escaping). **Playwright** on iPhone and Android viewports: landing, autosave, resume on a second device, submit, an admin stage change.
- **GitHub Actions** runs typecheck, lint and tests against a Postgres service container; Railway deploys `main` only after checks pass. Staging has seed data and a message sink that never sends real texts or emails.
- **Phase 2:** Anthropic SDK with structured JSON output, the model id in config, no tools, Message Batches for re-scoring.
- **Versions:** none are pinned in this plan. The builder pins exact versions when scaffolding, checked against current docs rather than memory.

## Phase 1 scope (go live Fri Oct 30)

### Must ship Oct 30

Applicant side:
- `/q/<code>` resolver with daily scan counts. Closed codes fall back to the role page.
- Role landing page: summary, pay range, benefits, "any background check comes after a conditional offer."
- Landing form: first and last name, mobile (validated), email (typo suggestions and confirm), optional unchecked text consent with full disclosure, bot check, rate limits.
- Straight into the application: 3 to 5 sections, progress bar, per-field autosave with retry and an offline copy, "Saved" indicator, required checks only on submit.
- Resume link by email at once (and by text once SMS is on). "Lost your link?" page that never reveals whether a match exists. Same mobile plus same opening resends the existing link.
- Source field and automatic entry channel.
- Submit: on-screen confirmation and email. Afterward the link opens a status page, not the answers.
- One 24-hour reminder (email now, text once approved), 9am to 8pm Central, never twice, skipped for submitted, closed or opted-out applicants.
- Privacy policy and SMS terms pages. Applicant pages are noindex, load no third-party scripts, send no referrer.

Admin side:
- Google sign-in with allowlist, Pending state and roles (Admin, Hiring Manager, Viewer).
- List view per opening: filters (stage, status, source, entry code, dates, hold, attention flags), search, stage dropdown, bulk move. Works on a phone.
- Applicant profile with next/previous: answers with question version, stage history, notes (with a restricted flag), messages in and out, consent records, resend or revoke link, Indeed apply date.
- Stage change dialog: backdatable time, closed outcomes with reason and note, Hold, Reopen, "Contacted" marker.
- Guards: Background check needs a recorded conditional offer (date and planned start); a background-based disqualification needs a pre-adverse notice date at least 5 business days earlier.
- Hire row created automatically when an application reaches Hired.
- Entry code screen: create a role code, download the QR as SVG or PNG.
- Suppression list, one-click opt-out, inbound text webhook (tested on staging; live when SMS is on).
- CSV export set: Admin-only, logged, formula-escaped.

Platform:
- Railway production and staging, migrations on pre-deploy, backups plus off-site dump, a tested restore, Sentry, CI, Playwright.
- Seed data from DATA_MODEL.md: Kahuna, two roles, pipelines, both question sets (loaded from a reviewed seed file that creates real version records), picklists, legal text, templates.

### Ships by ~Nov 10 (in this order)

1. Hire form on the profile (start date, crew, end date, outcome, reason, rehire eligible), plus the offer and background check panel. Needed before the first snow hire leaves or reaches a check.
2. Group session record with per-session QR code. If snow runs a session before Nov 10, tell me by Oct 23 and it moves up; it reuses the entry code table.
3. Kanban drag-and-drop board (desktop-first).
4. Question editor: draft, publish a new locked version, "reworded or new question?" prompt, do-not-ask list, required change reason. Until then question changes go through the reviewed seed file, which still creates versions.
5. Stage editor (rename, add, archive, milestone mapping) and picklist editor.

SMS switches on whenever the campaign is approved, after an end-to-end test to staff phones. It is not tied to either date.

### Collected in Phase 1, screens come later

These are captured from the first applicant because they can't be reconstructed afterward.

| Data | Feeds | Screen arrives |
|---|---|---|
| Stage events with "happened" and "entered" times, milestone mapping | Time to hire, time in stage, funnel | Phase 3 |
| Closed-outcome reasons and notes | Reason breakdowns, defending a decision | Phase 3 |
| Source, entry code, scanned session, Indeed apply date | Source and session reports | Phase 3 |
| Pinned form version, answers stored by option key | Predictiveness across versions | Phase 3 |
| Daily QR scan counts | Scans to starts | Phase 3 |
| Consent events with the exact text version shown | Proof of opt-in | Profile now, report Phase 3 |
| Message log with delivery status | Time to first contact, deliverability | Phase 3 |
| Hire rows with dates and outcomes | Retention | Hires page, Phase 3 |
| Audit and export logs | Audit viewer | Phase 3 |
| Retention settings and legal holds | Purge job | Phase 3 |

### Cut order if the schedule slips

Oct 30 items, first cut to last:
1. Bulk move in the list view (single moves remain).
2. Long-format CSV files (keep the per-opening export and stage events).
3. Viewer role (Admins and Hiring Managers only at launch).
4. Inbound text screen (SMS is off anyway; the webhook and opt-out sync must exist before the switch flips).
5. "Lost your link?" page (staff resend from the profile; applicants call the office).
6. Entry code screen (codes created by script).

Nov 10 items, first cut to last: stage editor, question editor, kanban, session QR. The hire form and background check panel are not cut.

**Never cut:** consent capture with text versions; suppression check before every send; the stage event log with milestones and reasons; versioned answers pinned to a form version; source and entry code; privacy policy and SMS terms; allowlist sign-in; the FCRA guard; backups with a tested restore.

## Phase 1 calendar

| Date | Builder | You |
|---|---|---|
| Tue Oct 13 | Plan and data model delivered | Blocking answers (done). Send the domain and Workspace domain(s) today if you can |
| Wed Oct 14 | Repo, CI, Railway staging, schema and migrations, seed loader | Twilio account and Trust Hub profile, buy the number, Railway, Resend, Sentry, Google OAuth client, confirm DNS access |
| Thu Oct 15 | Draft privacy policy, SMS terms, consent text, campaign description and samples; QR resolver and landing page on staging | Approve this plan and the data model; add DNS records |
| Fri Oct 16 | Application form and autosave on staging; legal pages live on the hiring subdomain | Approve legal text, samples and consent scope; snow wording, pay, logo, HELP contact; hiring@ group; file the brand once the profile is approved |
| Mon Oct 19 to Wed Oct 21 | Submit, resume tokens, email, lost-link page, reminder job and cron, bot check, rate limits, consent and suppression; Playwright for the applicant flow | File the campaign as soon as the brand is approved, Wed Oct 21 at the latest |
| Thu Oct 22 to Fri Oct 23 | Sign-in, allowlist, roles, list, profile, notes, stage changes with reasons, backdating, Hold, FCRA guard, hire rows | Staff list (Thu). Background check vendor, snow season dates, snow pipeline, in-flight candidates (Fri) |
| Mon Oct 26 | CSV exports, QR generation, inbound webhook and opt-out sync on staging, backups and off-site dump | Approve QR artwork; print one test sheet |
| Tue Oct 27 | Production deploy with the snow opening closed; restore test; Playwright against production | Scan the test sheet on iPhone and Android; print in bulk only after it passes |
| Wed Oct 28 | Support the dry run, triage the fix list | Staff dry run at the real venue, 5 to 10 people, mixed phones |
| Thu Oct 29 | Fixes, code freeze at 3pm, open the snow opening | Sign off on the fixes |
| Fri Oct 30 | Go live; watch Sentry, email delivery and first submissions | Available all day |
| Nov 2 to Nov 10 | The Nov 10 list in order; SMS on whenever approved | Crew list by Fri Nov 6 |

Weekends are builder buffer. Nothing on them needs you.

## Phase 2

**Deadline anchor:** D = the date of the first 2027 window cleaning group interview, which you confirm by early December. Phase 2 is in production by **D minus 3 weeks**, so the rubric can be run against sample answers and the test set before real applicants arrive. Your rubric draft is due **D minus 6 weeks**. If D is in early March, production is about Feb 12 and the rubric is due about Jan 22.

Scope:
- Rubrics: versioned, criteria with stable ids, a fixed job-related flag list, and a test set that must pass before a version can be published.
- AI scoring on submit for window cleaning: scores stored with rubric version, model id, prompt version and the exact data sent. Re-scoring through batches. Rationale keyword scan with Admin alerts.
- Review decisions (Advance, Hold, Decline) recording whether the AI score was visible. The first window batch is scored hidden.
- AI disclosure on the application, reviewed by counsel.
- Group interview tools: sign-in entry (paper with a phone column, or a door check-in), automatic matching by phone, staff-confirmed name matches, stars with a job-related reason picklist and a concern mark.
- One-on-one record: booked time (Google booking link in the invite), interviewer, A+ to F category grades, recommendation, Notion link. Ladder test as Pass, Fail or Did not attempt.
- Template editor and the Phase 2 templates (one-on-one invite, decline, status update). A group invite template only if you decide the ATS sends invites.
- A hidden scoring test on late snow applications, flagged "scored after decision", to exercise the pipeline.

## Phase 3

Deadlines are tied to the same date D:
- **By D:** Hires page (list, edit, 30 and 90 day ratings, season-end outcome, crew, rehire), so window hires are recorded from the first one. Single-person record export for Minnesota personnel-record requests, which need a response within 7 working days (handled by a manual query until then).
- **By D plus 4 weeks:** time to hire, time in stage, funnel, session attendance, drop-off and time to first contact reports.
- **By D plus 8 weeks:** retention, question predictiveness and AI-vs-human-vs-retention screens. They will show "pending" and small-sample warnings until the season ends, and that is expected.
- **Before Sep 2027:** the retention purge job and audit log viewer, ahead of the first records passing the 1-year floor in Nov 2027. Historical hire import if you have the data.
- **When the CRM exists:** a hires-only API. Applicant contact details never flow to the CRM.

## What I need from you

Unknown inputs (I will not guess these):

| # | What | By | Notes |
|---|---|---|---|
| 1 | Kahuna's web domain for the hiring subdomain (for example `jobs.<domain>`), and who controls its DNS | Wed Oct 14 | DNS records go in Thu Oct 15. If an agency or old vendor holds DNS, tell me today; the fallback is the privacy policy on your existing site and screenshots in the campaign |
| 2 | Google Workspace domain(s) staff sign in with | Wed Oct 14 | Sets the sign-in check and whether the OAuth consent screen is Internal or External |
| 3 | Staff user list: name, Google email, role (Admin, Hiring Manager, Viewer). Flag any personal Gmail accounts | Thu Oct 22 | Everyone signs in before the Oct 28 dry run. Personal Gmail forces an External consent screen (openid, email, profile only) |

Accounts and filings:

| # | What | By | Lead time |
|---|---|---|---|
| 4 | Twilio account in Kahuna's legal name, upgraded from trial; Trust Hub profile with the legal name exactly as on the IRS EIN letter, EIN, address, website, authorized representative | Wed Oct 14 | Profile review 1 to 3 business days |
| 5 | Buy the 763 or 612 number; forward calls to the office | Wed Oct 14 | Minutes |
| 6 | File the A2P brand once the profile is approved | Oct 14 to 16 | Minutes to days; longer if name, EIN or address don't match IRS records |
| 7 | File the campaign: description and 2 to 5 sample messages covering resume links, the reminder, interview scheduling, status updates and declines; HELP contact; privacy policy URL; opt-in page or screenshot. You sign the attestations; the builder can't | Oct 16 to 21 | Review 1 to 3 weeks; a rejection restarts it |
| 8 | Google Cloud OAuth client by a Workspace super admin, with production and staging redirect URLs | Wed Oct 14 | 30 minutes |
| 9 | Business-owned Railway workspace (Pro, billing), GitHub access for Railway and the builder; Resend paid plan and API key; Sentry account | Wed Oct 14 | Same day |
| 10 | hiring@ Google Group to receive replies | Fri Oct 16 | Minutes |

Decisions and content:

| # | What | By | Notes |
|---|---|---|---|
| 11 | Approve PLAN.md and DATA_MODEL.md; same-day answers through Oct 30 | Thu Oct 15 | One 3-day wait uses the whole buffer |
| 12 | Approve consent text, privacy policy, SMS terms, campaign description and samples (drafts arrive Thu Oct 15). Decide consent scope: default is this application plus future openings at Kahuna | Fri Oct 16 | Any attorney review must finish by this date or the campaign slips |
| 13 | Snow: sign off on the question wording in DATA_MODEL.md, pay rate or range, benefits summary, logo, HELP phone or email | Fri Oct 16 | Pay appears on the landing page |
| 14 | Snow season start and expected end, target headcount; whether snow uses one-on-ones; which checks apply | Fri Oct 23 | Sets the snow pipeline and retention windows |
| 15 | Background check vendor; checks per role (criminal, driving record, drug screen); confirm the vendor sends pre-adverse and adverse notices and offers Minnesota's copy checkbox | Fri Oct 23 | Vendor setup can take days |
| 16 | Indeed: remove any screener about background checks, add pay range; export the full candidate list when each posting closes and keep it a year; keep paper sign-up sheets a year | This week | Minutes per posting |
| 17 | Dry run at the venue, 5 to 10 people on iPhones and Androids, scanning the printed QR | Wed Oct 28 | Book the people now |
| 18 | Be available on go-live day | Fri Oct 30 | |
| 19 | Crew list for the hire form | Fri Nov 6 | |
| 20 | Date D (first 2027 window group interview); past hire records if you want them imported | Early Dec | D sets the Phase 2 and 3 deadlines |
| 21 | Window rubric: criteria, strong / acceptable / weak examples, weights | D minus 6 weeks | Your work, not the builder's |
| 22 | Window: final question wording (including any physical requirement figures from the written job description), pay range, season dates | D minus 6 weeks | |
| 23 | Anthropic Console account with billing and a monthly cap; federal contractor or Minnesota workforce certificate status; counsel review of the AI disclosure | Early Jan | |

## Open questions that can wait

| Question | Default until answered | Needed by |
|---|---|---|
| Should the ATS send group interview invites (people exist before they scan)? | No. Indeed sends invites; records start at the QR scan | Dec 1 |
| Will snow run group interview sessions this fall? | No. Role QR only; session QR ships by Nov 10 | Oct 23 |
| Import snow candidates already in progress? | No. They finish the old way | Oct 23 |
| Is a returning seasonal worker a new hire each season? | Yes. One hire row per season, linked to the same person | Nov 6 |
| What makes a good on-call snow hire? | Season-end rating (Reliable, Mixed, Unreliable, Never worked) plus storms worked | Mar 2027 |
| Can the sign-in sheet capture mobile numbers? | Paper sheet with a phone column, matched by phone | Jan 2027 |
| Where does the interview scorecard live? | The ATS, with a Notion link | Jan 2027 |
| Languages besides English? | English only; all applicant text stored by language | Jan 2027 |
| Who reads replies to the hiring number? | Logged in the ATS and emailed to hiring@ | When SMS goes live |
| Can staff type free-form replies to texts? | No. Staff call the applicant; texts are templates only | Phase 2 |
| Import past seasons' hire outcomes? | Yes, hire outcomes only, flagged historical, in Phase 3 | Early Dec |
| Collect voluntary self-identification? | No | Jan 2027 |
| Midwest Access roles in the ATS? | Not now. Needs an Employer row and likely its own 10DLC brand | 6 weeks before the first Midwest Access hire |
| Retention periods | Defaults in DATA_MODEL.md: 2 years for non-hired contact details, 3 years after a hire ends, 4 years for consent and messages, 5 years for check status | Sep 2027 |
| Two applicants sharing one phone? | One person per mobile number; staff handle the exception by phone | When it first happens |
| Quiet hours for automatic sends | 9am to 8pm Central | Any time |
