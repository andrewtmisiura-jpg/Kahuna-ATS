import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { aiScore, application, applicationEvent, auditLog, interview, message, person, reviewDecision } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { saveAnswer } from "@/server/services/applications/answers";
import { moveBoardCard } from "@/server/services/applications/board";
import { createApplication, transition, type TransitionInput } from "@/server/services/applications/transition";
import { cancelInterview, centralDateTime, rescheduleInterview, scheduleInterview } from "@/server/services/interviews/interviews";
import { runDueJobs } from "@/server/services/jobs/run";
import { withMessages } from "@/server/services/messaging/after-transition";
import { queueInterviewReminders } from "@/server/services/messaging/interview-reminders";
import { createSinkProviders } from "@/server/services/messaging/providers";
import type { MessagePurpose } from "@/server/services/messaging/send";
import { formatCentralMoment, interviewReminderKey } from "@/server/services/messaging/template-text";
import { TemplateError } from "@/server/services/messaging/templates";
import { fakeScorer } from "@/server/services/scoring/fake";
import { enqueueRescore } from "@/server/services/scoring/rescore";
import { ensureRubricDraft, publishRubricVersion, saveRubricDraft, setScoringMode } from "@/server/services/scoring/rubrics";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadEmployer, loadOption, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { createAiScore } from "./helpers/phase2";
import { createRubricRole, criterionInput, type RubricRoleFixture } from "./helpers/rubrics";
import { createScoringRole, submitScoringApplication, type ScoringRoleFixture } from "./helpers/scoring";
import { ensurePhase2Templates, readyEmployer, submittedApplicant } from "./helpers/templates";

// The Phase 2 areas were built apart and meet here: a staff move or close on a scored
// application writes the screening decision and queues its template message in one
// transaction, an interview booked on the profile gets its reminder from the cron, and
// a rubric published in Settings scores the role's applications on the next pass. Every
// case runs on its own rows inside a rolled-back transaction.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

let adminId: string;
let employerId: string;
let snow: SnowFixture;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
  employerId = (await loadEmployer(db)).id;
  snow = await loadSnow(db);
});

afterAll(async () => {
  await sql.end();
});

// A submitted application on the scoring role with a current, visible score.
async function scored(tx: Tx, role: ScoringRoleFixture) {
  const { applicationId } = await submitScoringApplication(tx, role, { commitment: "Called ahead.", mistake: "Told them." });
  const aiScoreId = await createAiScore(tx, { applicationId, rubricVersionId: role.published.rubricVersionId, isCurrent: true, hiddenFromReviewers: false });
  return { applicationId, aiScoreId };
}

async function act(tx: Tx, applicationId: string, input: Record<string, unknown>, messages?: Parameters<typeof withMessages>[1]) {
  const [app] = await tx.select({ eventSeq: application.eventSeq }).from(application).where(eq(application.id, applicationId));
  const base = { applicationId, actor: staffActor(adminId), expectedSeq: app!.eventSeq, ...input } as TransitionInput;
  return transition(tx, messages ? withMessages(base, messages) : base);
}

async function decisions(tx: Tx, applicationId: string) {
  return tx.select().from(reviewDecision).where(eq(reviewDecision.applicationId, applicationId)).orderBy(asc(reviewDecision.createdAt), asc(reviewDecision.id));
}

async function messagesFor(tx: Tx, applicationId: string, purpose: MessagePurpose) {
  return tx
    .select()
    .from(message)
    .where(and(eq(message.applicationId, applicationId), eq(message.purpose, purpose)))
    .orderBy(asc(message.createdAt), asc(message.id));
}

describe("a staff move or close on a scored application", () => {
  it("writes advance and queues the one-on-one invite with the move, both tied to its event", async () => {
    await withRollback(db, async (tx) => {
      await ensurePhase2Templates(tx, adminId);
      await readyEmployer(tx, employerId);
      const role = await createScoringRole(tx, { adminId });
      const { applicationId, aiScoreId } = await scored(tx, role);

      const result = await act(tx, applicationId, { action: "move", toStageId: role.stages.one_on_one_invited }, { sendInvite: true });

      expect(await decisions(tx, applicationId)).toEqual([
        expect.objectContaining({ decision: "advance", aiScoreId, aiScoreVisible: true, applicationEventId: result.event.id, decidedBy: adminId }),
      ]);
      const [invite, ...more] = await messagesFor(tx, applicationId, "one_on_one_invite");
      expect(more).toHaveLength(0);
      expect(invite).toMatchObject({ status: "queued", dedupeKey: `invite:${result.event.id}`, triggeredByType: "staff", triggeredByUserId: adminId });
      const [audit] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "application.message_send"), eq(auditLog.applicationId, applicationId)));
      expect(audit!.changes).toMatchObject({ purpose: "one_on_one_invite", via: "move", application_event_id: result.event.id });
    });
  });

  it("writes decline with the reason and queues the decline message with the close", async () => {
    await withRollback(db, async (tx) => {
      await ensurePhase2Templates(tx, adminId);
      await readyEmployer(tx, employerId);
      const role = await createScoringRole(tx, { adminId });
      const { applicationId, aiScoreId } = await scored(tx, role);
      const reasonOptionId = await loadOption(tx, "disqualify_reason", "availability_conflict");

      const result = await act(tx, applicationId, { action: "close", outcome: "disqualified", reasonOptionId }, { sendDecline: true });

      expect(await decisions(tx, applicationId)).toEqual([
        expect.objectContaining({ decision: "decline", reasonOptionId, aiScoreId, applicationEventId: result.event.id }),
      ]);
      expect(await messagesFor(tx, applicationId, "decline")).toEqual([expect.objectContaining({ status: "queued", dedupeKey: `decline:${result.event.id}` })]);
    });
  });

  it("rolls the move and its decision back together when the invite cannot go", async () => {
    await withRollback(db, async (tx) => {
      await ensurePhase2Templates(tx, adminId);
      // No booking link, so the invite has nothing to send.
      await readyEmployer(tx, employerId, { bookingLinkUrl: null });
      const role = await createScoringRole(tx, { adminId });
      const { applicationId } = await scored(tx, role);
      const [before] = await tx.select().from(application).where(eq(application.id, applicationId));

      await expect(act(tx, applicationId, { action: "move", toStageId: role.stages.one_on_one_invited }, { sendInvite: true })).rejects.toBeInstanceOf(TemplateError);

      const [after] = await tx.select().from(application).where(eq(application.id, applicationId));
      expect(after).toMatchObject({ currentStageId: before!.currentStageId, eventSeq: before!.eventSeq });
      expect(await tx.select().from(applicationEvent).where(eq(applicationEvent.applicationId, applicationId))).toHaveLength(before!.eventSeq);
      expect(await decisions(tx, applicationId)).toEqual([]);
      expect(await messagesFor(tx, applicationId, "one_on_one_invite")).toEqual([]);
    });
  });

  it("records the screening decision from every staff path: list and bulk moves, board drags, Hire now, holds and closes", async () => {
    await withRollback(db, async (tx) => {
      const role = await createScoringRole(tx, { adminId });
      const listed = await scored(tx, role);
      await act(tx, listed.applicationId, { action: "move", toStageId: role.stages.one_on_one_invited });

      // A bulk move is one transition per row, sharing a batch id.
      const batchId = uuidv7();
      const bulk = [await scored(tx, role), await scored(tx, role)];
      for (const row of bulk) await act(tx, row.applicationId, { action: "move", toStageId: role.stages.one_on_one_invited, batchId });

      const dragged = await scored(tx, role);
      const [card] = await tx.select({ eventSeq: application.eventSeq }).from(application).where(eq(application.id, dragged.applicationId));
      await moveBoardCard(tx, { applicationId: dragged.applicationId, expectedSeq: card!.eventSeq, toStageId: role.stages.one_on_one_invited!, actor: staffActor(adminId) });

      const hired = await scored(tx, role);
      await act(tx, hired.applicationId, { action: "move", toStageId: role.stages.hired });

      const held = await scored(tx, role);
      await act(tx, held.applicationId, { action: "hold" });

      const closed = await scored(tx, role);
      await act(tx, closed.applicationId, { action: "close", outcome: "disqualified", reasonOptionId: await loadOption(tx, "disqualify_reason", "other"), note: "Not a fit" });

      const expected = [
        [listed, "advance"],
        [bulk[0]!, "advance"],
        [bulk[1]!, "advance"],
        [dragged, "advance"],
        [hired, "advance"],
        [held, "hold"],
        [closed, "decline"],
      ] as const;
      for (const [row, decision] of expected) {
        expect(await decisions(tx, row.applicationId), decision).toEqual([expect.objectContaining({ decision, aiScoreId: row.aiScoreId, decidedBy: adminId })]);
      }
    });
  });
});

describe("an interview booked on the profile", () => {
  // Fri Oct 30, 2026 at noon CDT, two days before the clocks change.
  const NOW = new Date("2026-10-30T17:00:00Z");

  async function reminders(tx: Tx, applicationId: string) {
    return messagesFor(tx, applicationId, "one_on_one_reminder");
  }

  it("gets its reminder on the next pass, a new one when it moves, and none once the application closes", async () => {
    await withRollback(db, async (tx) => {
      await ensurePhase2Templates(tx, adminId);
      await readyEmployer(tx, employerId);
      const a = await submittedApplicant(tx, snow, employerId);

      // Mon Nov 2 at 9:00am, entered as Central time on the profile.
      const firstTime = centralDateTime("2026-11-02", "09:00");
      const { interviewId } = await scheduleInterview(tx, {
        applicationId: a.applicationId,
        userId: adminId,
        role: "admin",
        kind: "one_on_one",
        scheduledAt: firstTime,
        bookedVia: "booking_link",
        now: NOW,
      });
      await queueInterviewReminders(tx, NOW);
      const [first, ...extra] = await reminders(tx, a.applicationId);
      expect(extra).toHaveLength(0);
      expect(first).toMatchObject({
        status: "queued",
        channel: "sms",
        dedupeKey: interviewReminderKey(interviewId, firstTime),
        // 5pm the day before, Sun Nov 1, already standard time.
        sendAfter: new Date("2026-11-01T23:00:00Z"),
      });
      expect(first!.body).toContain(formatCentralMoment(firstTime));

      // Moved to Tue Nov 3 at 2:30pm: the old reminder is canceled and the new time gets one.
      const secondTime = centralDateTime("2026-11-03", "14:30");
      await rescheduleInterview(tx, { interviewId, userId: adminId, role: "admin", scheduledAt: secondTime, now: NOW });
      await queueInterviewReminders(tx, NOW);
      const moved = await reminders(tx, a.applicationId);
      expect(moved.map((m) => [m.dedupeKey, m.status, m.errorCode])).toEqual([
        [interviewReminderKey(interviewId, firstTime), "canceled", "interview_rescheduled"],
        [interviewReminderKey(interviewId, secondTime), "queued", null],
      ]);
      expect(moved[1]!.body).toContain("Tue, Nov 3 at 2:30 PM");

      // Closing the application cancels the reminder of the interview still on the books.
      await act(tx, a.applicationId, { action: "close", outcome: "withdrew", reasonOptionId: await loadOption(tx, "withdraw_reason", "took_another_job") });
      await queueInterviewReminders(tx, NOW);
      expect((await reminders(tx, a.applicationId)).map((m) => m.status)).toEqual(["canceled", "canceled"]);
      const [row] = await tx.select({ status: interview.status }).from(interview).where(eq(interview.id, interviewId));
      expect(row!.status).toBe("scheduled");
    });
  });

  it("cancels the reminder when staff cancel the interview", async () => {
    await withRollback(db, async (tx) => {
      await ensurePhase2Templates(tx, adminId);
      await readyEmployer(tx, employerId);
      const a = await submittedApplicant(tx, snow, employerId, { consent: "none" });
      const { interviewId } = await scheduleInterview(tx, {
        applicationId: a.applicationId,
        userId: adminId,
        role: "hiring_manager",
        kind: "phone_screen",
        scheduledAt: centralDateTime("2026-11-04", "10:00"),
        now: NOW,
      });
      await queueInterviewReminders(tx, NOW);
      expect(await reminders(tx, a.applicationId)).toEqual([expect.objectContaining({ status: "queued", channel: "email", toAddress: a.email })]);

      await cancelInterview(tx, { interviewId, userId: adminId, role: "admin", now: NOW });
      await queueInterviewReminders(tx, NOW);
      expect(await reminders(tx, a.applicationId)).toEqual([expect.objectContaining({ status: "canceled", errorCode: "interview_canceled" })]);
    });
  });
});

describe("a rubric published in Settings > AI scoring", () => {
  const actor = () => staffActor(adminId);
  const run = (tx: Tx) => runDueJobs(tx, { now: new Date(), providers: createSinkProviders(), timeBudgetMs: 60_000, scorer: fakeScorer });

  // A submitted application on the rubric role, answering by question key.
  async function submitOn(tx: Tx, role: RubricRoleFixture, answers: Partial<Record<keyof RubricRoleFixture["versions"], string>>) {
    const personId = uuidv7();
    const email = `flows-${personId}@example.test`;
    await tx.insert(person).values({ id: personId, firstName: "Robin", lastName: "Flows", mobileE164: nextMobile(), email, emailNormalized: email });
    const { applicationId } = await createApplication(tx, { personId, openingId: role.openingId, origin: "landing", entryChannel: "role_qr", actor: { type: "applicant" } });
    for (const [key, value] of Object.entries(answers)) {
      await saveAnswer(tx, { applicationId, questionVersionId: role.versions[key as keyof RubricRoleFixture["versions"]], revision: 0, value: value! });
    }
    await transition(tx, { action: "submit", applicationId, actor: { type: "applicant" } });
    return applicationId;
  }

  async function publish(tx: Tx, role: RubricRoleFixture, weights: [number, number], changeReason: string) {
    const draft = await ensureRubricDraft(tx, { roleId: role.roleId, actor: actor() });
    await saveRubricDraft(tx, {
      rubricVersionId: draft.id,
      instructions: "Grade what each answer shows about how they work. Ignore spelling, grammar, length and language.",
      allowedFlags: [{ label: "Blames others" }],
      criteria: [
        criterionInput("Reliability", [role.questions.commitment], { weight: weights[0], criterionId: draft.criteria[0]?.criterionId }),
        criterionInput("Integrity", [role.questions.mistake], { weight: weights[1], criterionId: draft.criteria[1]?.criterionId }),
      ],
      actor: actor(),
    });
    return publishRubricVersion(tx, { rubricVersionId: draft.id, changeReason, actor: actor() });
  }

  async function scoresOf(tx: Tx, applicationId: string) {
    return tx.select().from(aiScore).where(eq(aiScore.applicationId, applicationId)).orderBy(asc(aiScore.createdAt), asc(aiScore.id));
  }

  it("scores the role's submitted applications on the next pass, re-scores all on request and follows the mode", async () => {
    await withRollback(db, async (tx) => {
      const role = await createRubricRole(tx, adminId);
      // Submitted before the role has a rubric, so nothing is queued at submit.
      const strong = await submitOn(tx, role, { commitment: "Called my lead the night before [score:5]", mistake: "Told the owner and fixed it [score:5]" });
      const middling = await submitOn(tx, role, { commitment: "I texted when I could.", mistake: "I fixed the streak." });
      const unanswered = await submitOn(tx, role, { equipment: "Called the customer." });
      expect(await tx.select().from(aiScore).where(inArray(aiScore.applicationId, [strong, middling, unanswered]))).toEqual([]);

      const first = await publish(tx, role, [2, 1], "First rubric for this role");
      await setScoringMode(tx, { roleId: role.roleId, mode: "visible", actor: actor() });
      await run(tx);

      const [strongScore] = await scoresOf(tx, strong);
      expect(strongScore).toMatchObject({ rubricVersionId: first.rubricVersionId, status: "succeeded", overallScore: 100, isCurrent: true, hiddenFromReviewers: false });
      expect((await scoresOf(tx, middling))[0]).toMatchObject({ overallScore: 51, isCurrent: true });
      // No answer to anything the rubric reads: no call and no row.
      expect(await scoresOf(tx, unanswered)).toEqual([]);

      // Re-score all: a fresh score against the same version replaces the current one.
      expect(await enqueueRescore(tx, { roleId: role.roleId, actorUserId: adminId })).toEqual({ queued: 3 });
      await run(tx);
      const rescored = await scoresOf(tx, strong);
      expect(rescored.map((s) => [s.rubricVersionId, s.isCurrent])).toEqual([
        [first.rubricVersionId, false],
        [first.rubricVersionId, true],
      ]);

      // Hidden mode with a new version: the sweep scores again and the new score stays hidden.
      await setScoringMode(tx, { roleId: role.roleId, mode: "hidden", actor: actor() });
      const second = await publish(tx, role, [1, 1], "Equal weights");
      await run(tx);
      const latest = (await scoresOf(tx, middling)).at(-1)!;
      expect(latest).toMatchObject({ rubricVersionId: second.rubricVersionId, isCurrent: true, hiddenFromReviewers: true, overallScore: 51 });
    });
  });
});
