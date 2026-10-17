// The staff guides shown at /help, copied from content/legal/help-guides.md. Each
// body is a small subset of Markdown that src/components/admin/settings/help-article.tsx
// renders: "### " headings, paragraphs, "- " bullets, "1. " numbered items, **bold**
// and *italic*. Phase 2 shipped Oct 16, 2026: its "Coming Nov 6" lines are folded
// into guides 1 to 3, and guides 4 to 7 cover its screens.

export type HelpGuide = {
  slug: string;
  title: string;
  summary: string;
  body: string;
};

export const HELP_GUIDES: HelpGuide[] = [
  {
    slug: "group-interviews",
    title: "Running a group interview with Tidepool",
    summary: "Create the session, print its QR code, check people in, star them from your phone, and see who applied from the room.",
    body: `Tidepool does four things for a group interview: it makes the QR code for the room, it keeps the list of who came (typed from the sign-up sheet or checked in at the door), it lets you star people from your phone during the session, and it tells you which applicants came from that session. It also sends every applicant their link and one reminder so you don't have to.

### Before the day

1. **Create the session.** Open the opening (for example Snow Removal 2026-27), go to Group sessions, tap New session. Enter the date and time, the location, and how many people Indeed says are coming. Save.
2. **Download the session QR.** On the session, tap Download QR and pick PNG for a slide or SVG for print. The code points at tidepool.kahunawindowcleaning.com/q/ plus a short code, so it keeps working even if we change the form later.
3. **Test it before you print.** Scan the code on an iPhone and on an Android. Start a test application, then open it in Tidepool and check that the session name shows on the profile. An Admin deletes test applications with the "Delete test application" button.
4. **Print it big.** One sheet of letter paper per table or one slide. Print the short link under the code for people whose camera won't scan.
5. **Bring the paper sign-up sheet** as always. We keep it for a year.
6. **Door check-in (optional).** On a tablet, sign in with an Admin or Hiring Manager Google account, open the session and tap **Door check-in**. Hand the tablet to people as they arrive: they type their name and mobile and see a thank-you that clears after 5 seconds. It works only on the day of the session, never shows anyone else's name, and does not sign anyone up for texts.

### In the room

- Run the presentation as usual. Pass the sign-up sheet.
- On your phone, open the session and tap **Floor view**. Tap **Star** or **Concern** next to a name. A star can have a reason; a concern needs a reason or a short note (140 characters at most). Tap your own mark again to take it back. **Refresh** picks up new check-ins.
- At the end, show the QR and say this: "Scan this, type your name, mobile and email, and the application opens right away. It takes about five minutes. You can finish here or at home. If you check the text box, we'll text you your link; otherwise we'll email it. It saves as you go."
- If someone's phone won't scan, have them type the short link printed under the code.
- Do not fill the form in for anyone and do not text anyone from your own phone. Tidepool sends the link and one reminder tomorrow by itself.

### Same day, if someone stands out

Open Tidepool on your phone, filter the list by the session, tap the person, tap **Hire now**. The hire form opens: crew, start date, Temporary yes or no. Any stage can go straight to Hired. If you forgot, do it later and backdate the time in the Move dialog.

### After the day

1. On the session, type the names from the sign-up sheet under **Who came**: the name as it is written, and the mobile if there is one. On a phone, Next moves to the mobile and Done adds the row. Pick **Not on the sheet** for someone you add yourself. Enter your stars and concerns while you still remember faces.
2. A mobile that matches an applicant on this opening links them right away. Most people apply after the session; they are matched the next time anyone opens the session page or the floor view, or the moment they apply. **Match now** does it on demand.
3. **Might be** lists applicants with the same last name and the same first name or first initial. Tap **It's them** to link, or **Not them** to hide that suggestion for good. **Link to an applicant** searches the opening's applicants for nicknames or misspellings, and **Unmatch** undoes a wrong match.
4. A door check-in fills in the applicant's group interview arrival when it is blank: on time if they checked in no more than 5 minutes after the start, otherwise late. Sign-up sheet rows never set arrival; you can still change it on the profile.
5. Watch the list over the next two days. Submitted applications from the session show up with the session name; people who started but didn't finish get one reminder the next day and then nothing.
6. Keep the paper sheet for a year. Attended on the session list counts the names under Who came; if you don't type them in, enter the headcount in the session's Edit dialog instead.

### If something goes wrong

- "I never got the text." Open their profile, look at the messages panel. If the text failed or the number opted out, tap Resend link; it goes by email too. If they texted STOP once to any Kahuna number, texts stay blocked until they text START to 763-292-2259.
- "I scanned the wrong code." No harm. The application still exists, and the session is attached once they are matched under Who came, by phone or by you confirming it.
- Nothing loads. Check that the opening is still open under Settings > Openings, then call the builder.`,
  },
  {
    slug: "reviewing",
    title: "Reviewing applicants on your phone",
    summary: "The list, the profile, and every move, close and note.",
    body: `Everything you need to decide on an applicant works on a phone. Settings, the board and exports are desktop screens.

### Sign in

Go to tidepool.kahunawindowcleaning.com and sign in with the Google account an Admin added for you. If it says "Ask an admin to add you," you are using a different Google account than the one on the list.

### The list

- Counts at the top: started, in progress, submitted.
- A strip of things needing attention: unhandled texts, contact conflicts. Clear these first.
- Filter to **Submitted** to see what's waiting. Search by name or phone.
- A **Returning** badge means they applied or worked here before. Red means they were marked not eligible for rehire. Tap in and read the history before you decide.

### Our promise

The confirmation email tells every applicant that a person reviews their application within 3 business days. Keep to it. Someone should look at the Submitted filter every working day during a hiring push.

### The profile

Answers (with the form version they answered), how they heard about us and which code they came in on, the stage history, notes, the text thread, their consent status, and any offer or check panel. It also shows the AI score when the role shows scores (Guide 6), the group interview they came to with any stars and concerns (Guide 1), and their interviews and ladder test (Guide 5). Nothing is hidden on a phone except restricted notes, which only Admins and Hiring Managers see.

### Making a move

- **Move:** pick the stage, set the time (backdate it if you're catching up from paper), add a note if you want. You can move to any later stage, or straight to Hired. Skipped steps count as passed in the reports.
- **Close:** pick the outcome and a reason from the list. Three outcomes:
- *Disqualified*: something about this person doesn't fit the job. The reason matters for our reports, so pick the real one.
- *Not selected (roles filled)*: a fine applicant we didn't have room for. Use this, not Disqualified, when we simply filled up.
- *Withdrew*: they pulled out, stopped responding or declined an offer.
- **Hold**, **Reopen** and **Contacted** are one-tap buttons. Tap Contacted when you've called or spoken to someone so the time-to-first-contact report is honest.
- **Conditional offer:** the move records the offer date from the time you set and asks for a planned start date. Backdate the time if the offer was made earlier.
- **Background check:** only possible after a conditional offer, and the dialog asks the check type. If a check comes back with a problem, do not disqualify on it until the pre-adverse notice has been out for 5 weekdays; the dialog will stop you, and that is the law, not a bug. If you close for some other reason while a check is open, the dialog asks you to say so.
- **Hired:** the hire form opens. Crew, start date, Temporary yes or no (set it now if the plan is a short stint; it can't be changed later without an Admin and a reason).
- Made a mistake? The last move can be voided from the history. Ask an Admin.

### Notes

- Notes can't be edited, only added, so write facts. "No-show 11/3, didn't call" is a good note.
- Never write anything about health, disability, age, family, religion, national origin, or anything else off the do-not-ask list. If an applicant tells you they need an accommodation, write only what's needed and tick **Restricted** so only managers see it.
- Notes are never sent to any AI tool, and restricted notes are never exported.

### Messages from the profile

Templates (the one-on-one invite, a status update, the decline) go out from **Send a message** on the profile and are logged; the Move and Close dialogs can send the invite and the decline too. See Guide 4. Replies to texts show in the thread and are handled in the Quo app; see Guide 3. Resend link sends a fresh link by text and email. Editing a phone or email is allowed and is recorded with your name.`,
  },
  {
    slug: "texting",
    title: "Texting rules: STOP, HELP and replies",
    summary: "What goes out on its own, what STOP does, and how to answer a reply.",
    body: `Tidepool texts from one number, **763-292-2259**, and only to people who checked the text box on their application. Everyone else gets email. These rules keep us inside the carrier and consumer protection rules, and they are short.

### What goes out on its own

- The application link, right after someone finishes the landing form.
- One reminder the next day if they didn't submit. Never a second.
- A reply to HELP.
- A one-on-one reminder the day before a booked interview (see Guide 4).

Everything else is sent by a staff member as a template from Tidepool.

### STOP

- When someone texts STOP (or Unsubscribe, Cancel, End, Quit), Tidepool records the opt-out at once and our texting provider sends them one confirmation. Nothing more goes out by text; messages fall back to email.
- **STOP covers every Kahuna number**, including the customer line and whatever number crews are texted from. Staff cannot undo it. Only the person can, by texting **START** to 763-292-2259.
- The profile and the hire form show a warning when a person's number has a live opt-out. If you hire someone with that warning, tell them: "Text START to 763-292-2259 so dispatch texts reach you."
- If someone says "stop texting me" in their own words, by text, phone or email, tap **They asked me to stop** on the profile the same day. The law gives 10 business days to honor a request made any reasonable way; we do it immediately.

### HELP

A HELP text gets an automatic reply with our number and email. Nothing for you to do, but the reply is shown on the profile.

### Every other reply

- Every inbound text lands on the person's profile, is emailed to [OWNER INPUT: hiring email], and adds to the **Unhandled texts** badge at the top of the list until someone marks it handled.
- [OWNER INPUT: who answers 763-292-2259 and reads hiring@] owns that badge. Aim to clear it within one business day.
- To answer, open the thread in the **Quo app** on the hiring number and type a reply. It appears on the Tidepool profile automatically. Keep it short and about this application only.
- Then mark the text handled in Tidepool.

### Do and don't

- Do send invites, declines and status updates from Tidepool as templates, so they are logged with the exact wording.
- Do keep hand-typed replies to answering a question or fixing a time.
- Don't text applicants from your own phone. It isn't logged, it isn't from the number they agreed to, and it has no STOP line.
- Don't text about anything other than their application: no openings next season, no promotions, no photos.
- Don't write anything in a text you wouldn't want read back in a hearing. Everything is kept for four years.
- Don't have an AI write a message to an applicant. All applicant messages are our templates or a person's own words.

### Timing and limits

- Texts the applicant didn't just ask for wait until 9am Central and never go after 8pm. You'll see "will send at 9:00am" on the profile.
- There is a daily cap on all messages (default 200). If it's hit, you'll see "waiting: daily cap" and the message goes out tomorrow. Tell the owner if that happens on an ordinary day.
- A text marked **failed** or **undelivered** is not retried. Send the email version or call.

### If a text is wrong or late

Say so in a short follow-up by hand in Quo, or call. Don't resend the same template twice.`,
  },
  {
    slug: "messages",
    title: "Invites, reminders and declines",
    summary: "Send a message from the profile, the invite with a move, the decline with a close, and the automatic one-on-one reminder.",
    body: `Every message to an applicant is one of our templates, filled in with their details and logged with the exact wording. Nothing can be typed into a template, and no AI writes any of it. Admins and Hiring Managers send them.

### Send a message

- On the profile, open **Send a message** and pick the one-on-one invite, a status update or the decline. The decline goes only to someone already closed as Disqualified or Not selected; for anyone still open, close them with the Close dialog and tick Send the decline message there.
- Tidepool picks text or email: a text when they ticked the text box, have not opted out and texting is on, otherwise email. A decline goes by email when they have one, because it reads better in an inbox.
- You see the exact message with their name before you send. If nothing can be sent, it says why (for example: no opt-in and no email, or marked do not contact).
- Send puts it in Messages as Queued. It goes out within 5 minutes; texts wait for 9am to 8pm Central.

### The invite with a move

- Moving someone into One-on-one invited with the **Move** button offers **Also send the one-on-one invite**, with a preview. It is ticked when the booking link is set and the person can be reached.
- Untick it if you already invited them another way. The dialog reminds you when the move is backdated.
- Dragging on the board, moving from a list row or moving several at once never sends an invite. Use Send a message afterwards.
- While the invite is out and nothing is booked, the applicant's status page shows a **Book your interview** button with the same booking link.

### The decline with a close

When the outcome is Disqualified or Not selected, the Close dialog offers **Send the decline message**. It is unticked by default, and your note is never sent.

### One-on-one reminders

- An interview booked in the Interviews card on the profile (Guide 5) gets one reminder at 5pm the day before, or right away if it was booked less than 20 hours ahead.
- None goes when the interview is less than an hour away.
- Moving the interview sends a fresh reminder and cancels the old one. Canceling the interview, or closing the application, cancels its reminder. Reminders show in Messages as Queued or Canceled, with the reason.

### Changing the wording

An Admin edits the templates and the booking link in Settings > Message templates; see Guide 7.`,
  },
  {
    slug: "interviews",
    title: "One-on-ones and the ladder test",
    summary: "Book an interview, record how it went with the scorecard, and record the ladder test.",
    body: `Interviews and test results live on the applicant's profile, in the **Interviews** card. It works on a phone. Viewers can read it but not change it.

### Booking an interview

1. Tap **Schedule an interview**. Pick one-on-one or phone screen, the date and the time (always Central time), how it was booked (booking link, phone or in person) and the interviewer.
2. Once it is booked you can **Reschedule** or **Cancel interview**. The applicant gets a reminder the day before (Guide 4).

### After the interview

- Tap **Record result**. Pick Held and confirm when it happened, or pick No-show.
- For a held interview, give each scorecard category a grade from A+ to F, and leave one blank if it did not come up: Reliability, Work ethic, Communication, Coachability, Safety awareness, Customer presence. Then add an overall grade, a recommendation (hire, maybe, no hire), notes and, if you keep a write-up in Notion, the page's link (notion.so or notion.site).
- Notes are about the work only. Never write anything about health or medical observations.
- **Edit result** fixes a mistake later. A held interview or a no-show is final, so another try means scheduling a new interview.
- A no-show never closes the application. If they are not coming back, tap Close at the top, pick Withdrew and the reason "No-show to one-on-one".

### Ladder test (window applicants only)

- Pick Pass, Fail or Did not attempt and the date of the test (today by default). The result is saved as given by you.
- The note is optional and restricted: only Admins and Hiring Managers see it, and it never holds medical observations.
- To fix a mistake, tap **Void this result**. It stays in the history crossed out, and you record the test again.
- A fail never closes anyone. To close, tap Close, pick Disqualified and "Did not pass the ladder test".`,
  },
  {
    slug: "ai-scores",
    title: "AI scores: what the number means",
    summary: "A sorting aid from the role's rubric. It never moves, rejects or messages anyone.",
    body: `The AI score is a number from 1 to 100. It sums up how an applicant's answers to the role's behavioral questions fit the role's scoring rubric. Each part of the rubric gets a grade from 1 to 5 with a short reason, and Tidepool combines the grades into the number. It is a sorting aid only. It never moves, rejects or messages anyone. You make every decision.

### Where you see it

- Only when the role's AI scoring is set to Visible. Snow removal is Visible; window cleaning stays Off until its rubric is written.
- On the profile, the **AI score** card shows the number, each part's grade and reason, a short overall reason, any flags, and which rubric version and time it came from.
- On the list and the board, a small "AI score N" badge sits on each row or card.
- In Hidden mode scores are made in the background, but no one sees them on the profile, list or board. A score made while scores were hidden stays hidden after the role switches to Visible; an Admin re-scores to get one that shows.

### Sorting

- On the list, set **Sort** to **AI score, high to low**. Applicants without a score come last. Previous and Next on a profile follow the same order.
- On the board, the same sort orders each column.
- Pick **Newest first** (list) or **Longest in stage first** (board) to go back.

### When there is no number

The card says why, and a failed score never shows as a low number:

- "Scoring soon." The score is on its way. It usually arrives within a few minutes of submitting.
- "Not scored: this application doesn't have answers to the questions the rubric reads." This usually means an older application form without those questions.
- "Not scored: the AI declined to score these answers," "the scoring call failed" or "the AI's reply didn't fit the rubric." An Admin can tap Re-score.
- "Not scored: the rubric reads a question that is never sent to the AI." An Admin fixes the rubric.

### Who can do what

- Everyone who can open a profile sees the score.
- Only Admins see "Check the rationale, it mentions:" chips. They appear when the AI's reasons use a word tied to a protected trait (age, family, religion and so on), so a person can check it. The owner also gets an alert email when this happens.
- Only Admins have **Re-score**. It asks for a fresh score against the current rubric. The button then reads "Re-score queued", and the new score replaces the old one within about five minutes.

### Privacy and limits

- The AI never sees the applicant's name, phone number or email; they are removed from the answers before anything is sent. Questions marked never to send to the AI are never sent.
- Each business has a daily scoring limit (100 a day unless an Admin changes it). Past it, scoring waits until midnight Central and the owner gets one alert email that day.

### Records kept

When you disqualify, put on hold, or move a scored applicant up to an interview stage, Tidepool quietly records that decision next to the score, with whether you could see the score. This supports later fairness checks; nothing is needed from you.`,
  },
  {
    slug: "admin-settings",
    title: "Settings for Admins: roles, templates and AI scoring",
    summary: "New roles and their stages, the message wording and booking link, rubrics, Try it and the AI notice.",
    body: `These Settings screens are for Admins, on a desktop. Hiring Managers can read Message templates but not change them.

### Roles and stages

- Each role's page lists its stages in order, with what applicants see on their status page and the hiring step each stage counts as. You can add a stage (a custom one like Phone screen needs no hiring step), rename it, change what applicants see, move it up or down, show or hide it on the board, and archive or unarchive it.
- Started and Submitted always stay first and cannot be archived, and every role keeps a Hired stage.
- Once applications have been through a stage, the hiring step it counts as cannot change. Archive it and add a new one instead.
- Stages must follow the order of the hiring steps. A stage with open applications in it cannot be archived until they move.

### New role

1. Tap **New role**. Pick the role most like the new one, then enter the title applicants see, the name staff see and a key (it never changes).
2. The copy brings the stages, any picklist options only that role uses (for example the ladder test) and, unless you untick it, the questions as a draft.
3. Then edit and publish the questions in Questions, check the stages, and add an opening on the role's page; set its pay and dates and open it in Settings > Openings. Scoring stays off until a rubric is written.

### Message templates

- The one-on-one booking link sits at the top. Paste the link from your scheduling tool; it must start with https://. Invites cannot go out until it is set.
- Below it are the messages staff send: one-on-one invite, one-on-one reminder, status update and decline, each as a text and an email. Tap **Edit** to change the name, the subject (emails) and the message. Placeholder buttons drop in values such as the first name, and the preview shows sample values and how many text segments it uses.
- Red notes must be fixed before Save works: texts start with "Kahuna Window Cleaning:", end with "Reply STOP to opt out.", use plain characters only (no curly quotes, long dashes or emoji) and only known placeholders. The invite needs {booking_link}, the reminder {interview_time} and the status update {link}. Amber notes are advice.
- The messages that go out on their own (application link, link again, the unfinished-application reminder, application received, the HELP reply) are listed at the bottom, read-only.

### AI scoring

- Each role has a card with its scoring mode. Off: nothing is scored. Hidden: scored to check the rubric, shown only here, in a table of recent scores beside what a person decided. Visible: staff see the score on the list, board and profile. Hidden and Visible need a published rubric.
- **Edit rubric** opens the role's rubric page. Start a draft from the published version; nothing changes for scoring until you publish. A rubric has plain instructions, a short fixed list of job-related flags, and criteria. Each criterion has a weight, what a strong (5), acceptable (3) and weak (1) answer looks like, and the questions it reads. Questions marked never sent to the AI can't be picked.
- Tick "Asks for something different from version N" when you change what a good answer means, so reports stop comparing old and new grades.
- **Save draft** saves everything at once. **Publish version N** asks why the rubric is changing; that reason is all it needs. If scoring is on, every submitted application is scored again within a few minutes, up to the daily limit.
- **Try it** scores the draft (or the published version when no draft is open) against made-up sample answers and shows the scores side by side. Each group of samples says the same thing three ways (standard, broken English, short). A spread over 10 points gets a warning: the AI may be grading the writing instead of the behavior. Nothing from Try it is saved or counted against the limit.
- **Re-score all submitted applications for this role** queues a fresh score for each one. The confirmation says how many and how long the daily limit makes it take.
- The daily scoring limit covers all roles, 100 unless you change it. Past it, scoring waits until midnight Central.
- Snow's starter rubric was published Oct 16 as version 1 with scoring Visible: Reliability 30, Integrity 25, Work ethic 30, Problem solving 15. The Blue question is not scored; its pass or fail shows as a badge on the profile.

### AI notice on the landing page

The card shows the sentence every applicant reads before starting, its version, and how many applications started under it. To change it, write the new wording and a short note on what changed and why, then Publish. Applicants see it from their next page load, and each application stays tied to the version that was live when it started.`,
  },
];

export function findHelpGuide(slug: string): HelpGuide | undefined {
  return HELP_GUIDES.find((guide) => guide.slug === slug);
}
