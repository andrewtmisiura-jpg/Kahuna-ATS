import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { appUser, auditLog, interview, interviewGrade } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { CHANGED } from "@/server/services/audit";
import { transition } from "@/server/services/applications/transition";
import { INTERVIEW_CATEGORIES } from "@/server/services/interviews/categories";
import {
  cancelInterview,
  centralDateTime,
  cleanNotionUrl,
  InterviewError,
  listInterviewers,
  listInterviews,
  recordInterviewResult,
  rescheduleInterview,
  scheduleInterview,
} from "@/server/services/interviews/interviews";
import { loadInterviewsPanel } from "@/server/services/interviews/panel";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadOption, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { newApplication } from "./helpers/interviews";

let snow: SnowFixture;
let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

async function expectInterviewError(run: Promise<unknown>, code: InterviewError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof InterviewError && error.code === code);
}

async function audits(entityId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "interview"), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.occurredAt), asc(auditLog.id));
}

// The seeded Admin stands in for a Hiring Manager: the services take the role as an
// argument, and the seed test counts app_user rows exactly.
function asManager() {
  return { userId: adminId, role: "hiring_manager" as const };
}

async function scheduled(applicationId: string, at = "2026-11-02T16:00:00.000Z") {
  return scheduleInterview(db, {
    applicationId,
    ...asManager(),
    kind: "one_on_one",
    scheduledAt: new Date(at),
    bookedVia: "booking_link",
    interviewerUserId: adminId,
    now: new Date("2026-10-28T15:00:00Z"),
  });
}

describe("Central time on the interview form", () => {
  it("reads the date and time as Central wall-clock time on both sides of Nov 1", () => {
    expect(centralDateTime("2026-10-30", "10:00").toISOString()).toBe("2026-10-30T15:00:00.000Z");
    expect(centralDateTime("2026-11-02", "10:00").toISOString()).toBe("2026-11-02T16:00:00.000Z");
    expect(centralDateTime(" 2026-11-01 ", "09:30").toISOString()).toBe("2026-11-01T15:30:00.000Z");
  });

  it("refuses a date or time that does not exist", () => {
    for (const [date, time] of [
      ["2026-02-30", "10:00"],
      ["2026-11-02", "25:00"],
      ["11/02/2026", "10:00"],
      ["2026-11-02", "10am"],
      ["", ""],
    ] as const) {
      expect(() => centralDateTime(date, time)).toThrow(InterviewError);
    }
  });
});

describe("scheduling", () => {
  it("schedules a one-on-one with the interviewer and how it was booked, audited", async () => {
    const { applicationId, personId } = await newApplication(db, snow);
    const { interviewId } = await scheduled(applicationId);
    const [row] = await db.select().from(interview).where(eq(interview.id, interviewId));
    expect(row).toMatchObject({
      applicationId,
      kind: "one_on_one",
      status: "scheduled",
      bookedVia: "booking_link",
      interviewerUserId: adminId,
      heldAt: null,
      overallGrade: null,
    });
    expect(row!.scheduledAt!.toISOString()).toBe("2026-11-02T16:00:00.000Z");

    const [entry] = await audits(interviewId);
    expect(entry).toMatchObject({ action: "interview.schedule", actorUserId: adminId, applicationId, personId });
    expect(entry!.changes).toMatchObject({ kind: { from: null, to: "one_on_one" }, bookedVia: { from: null, to: "booking_link" } });

    const [view] = await listInterviews(db, applicationId);
    expect(view).toMatchObject({ id: interviewId, status: "scheduled", interviewer: { id: adminId, email: TEST_ADMIN_EMAIL }, grades: {} });
  });

  it("reschedules a scheduled interview and records only what changed", async () => {
    const { applicationId } = await newApplication(db, snow);
    const { interviewId } = await scheduled(applicationId);
    const same = await rescheduleInterview(db, { interviewId, ...asManager(), scheduledAt: new Date("2026-11-02T16:00:00.000Z"), now: new Date("2026-10-28T16:00:00Z") });
    expect(same.changed).toBe(false);

    const moved = await rescheduleInterview(db, {
      interviewId,
      ...asManager(),
      kind: "phone_screen",
      scheduledAt: centralDateTime("2026-11-03", "14:30"),
      bookedVia: "phone",
      interviewerUserId: null,
      now: new Date("2026-10-28T16:30:00Z"),
    });
    expect(moved.changed).toBe(true);
    const [row] = await db.select().from(interview).where(eq(interview.id, interviewId));
    expect(row).toMatchObject({ kind: "phone_screen", bookedVia: "phone", interviewerUserId: null, status: "scheduled" });
    expect(row!.scheduledAt!.toISOString()).toBe("2026-11-03T20:30:00.000Z");

    const entries = await audits(interviewId);
    expect(entries.map((e) => e.action)).toEqual(["interview.schedule", "interview.reschedule"]);
    expect(entries[1]!.changes).toEqual({
      kind: { from: "one_on_one", to: "phone_screen" },
      scheduledAt: { from: "2026-11-02T16:00:00.000Z", to: "2026-11-03T20:30:00.000Z" },
      bookedVia: { from: "booking_link", to: "phone" },
      interviewerUserId: { from: adminId, to: null },
    });
  });

  it("cancels an interview still to come; a canceled one takes no new time or result", async () => {
    const { applicationId } = await newApplication(db, snow);
    const { interviewId } = await scheduled(applicationId);
    await cancelInterview(db, { interviewId, ...asManager(), now: new Date("2026-10-29T15:00:00Z") });
    const [row] = await db.select().from(interview).where(eq(interview.id, interviewId));
    expect(row!.status).toBe("canceled");
    expect((await audits(interviewId)).at(-1)).toMatchObject({ action: "interview.cancel", changes: { status: { from: "scheduled", to: "canceled" } } });

    await expectInterviewError(cancelInterview(db, { interviewId, ...asManager() }), "not_scheduled");
    await expectInterviewError(rescheduleInterview(db, { interviewId, ...asManager(), scheduledAt: new Date() }), "not_scheduled");
    await expectInterviewError(
      recordInterviewResult(db, { interviewId, ...asManager(), outcome: "held", heldAt: new Date("2026-11-02T16:00:00Z"), now: new Date("2026-11-02T18:00:00Z") }),
      "interview_canceled",
    );
  });

  it("schedules nothing on a closed application until it is reopened", async () => {
    const { applicationId } = await newApplication(db, snow);
    const { interviewId } = await scheduled(applicationId);
    await transition(db, {
      action: "close",
      applicationId,
      actor: staffActor(adminId),
      outcome: "withdrew",
      reasonOptionId: await loadOption(db, "withdraw_reason", "took_another_job"),
    });
    await expectInterviewError(scheduled(applicationId), "application_closed");
    await expectInterviewError(rescheduleInterview(db, { interviewId, ...asManager(), scheduledAt: new Date() }), "application_closed");
    // The interview already on it can still be canceled.
    await cancelInterview(db, { interviewId, ...asManager() });
  });

  it("refuses an unknown kind, a way of booking it does not know, and an interviewer who is not active staff", async () => {
    const { applicationId } = await newApplication(db, snow);
    const base = { applicationId, ...asManager(), scheduledAt: new Date("2026-11-02T16:00:00Z") };
    await expectInterviewError(scheduleInterview(db, { ...base, kind: "group" as never }), "invalid_kind");
    await expectInterviewError(scheduleInterview(db, { ...base, kind: "one_on_one", bookedVia: "email" as never }), "invalid_booked_via");
    await expectInterviewError(scheduleInterview(db, { ...base, kind: "one_on_one", scheduledAt: new Date("nope") }), "invalid_time");
    await expectInterviewError(scheduleInterview(db, { ...base, kind: "one_on_one", interviewerUserId: uuidv7() }), "interviewer_not_found");
    await withRollback(db, async (tx) => {
      const leaverId = uuidv7();
      await tx.insert(appUser).values({ id: leaverId, email: "leaver@example.test", role: "hiring_manager", status: "disabled" });
      await expectInterviewError(scheduleInterview(tx, { ...base, kind: "one_on_one", interviewerUserId: leaverId }), "interviewer_not_found");
      expect((await listInterviewers(tx)).map((u) => u.id)).not.toContain(leaverId);
    });
    await expectInterviewError(scheduleInterview(db, { ...base, applicationId: uuidv7(), kind: "one_on_one" }), "application_not_found");
  });
});

describe("results and grades", () => {
  const notion = "https://www.notion.so/kahuna/Interview-notes-0123456789abcdef";

  it("records a held one-on-one with grades, an overall grade, a recommendation, notes and a Notion link", async () => {
    const { applicationId } = await newApplication(db, snow);
    const { interviewId } = await scheduled(applicationId);
    const result = await recordInterviewResult(db, {
      interviewId,
      ...asManager(),
      outcome: "held",
      heldAt: new Date("2026-11-02T16:05:00Z"),
      grades: { reliability: "a", work_ethic: "b_plus", communication: "b", coachability: null, safety: "a_minus", customer_presence: "c_plus" },
      overallGrade: "b_plus",
      recommendation: "hire",
      notes: "  Showed up early, asked about ladder training.  ",
      notionUrl: notion,
      now: new Date("2026-11-02T18:00:00Z"),
    });
    expect(result.changed).toBe(true);

    const [view] = await listInterviews(db, applicationId);
    expect(view).toMatchObject({
      status: "held",
      overallGrade: "b_plus",
      recommendation: "hire",
      notes: "Showed up early, asked about ladder training.",
      notionUrl: notion,
      grades: { reliability: "a", work_ethic: "b_plus", communication: "b", safety: "a_minus", customer_presence: "c_plus" },
    });
    expect(view!.heldAt!.toISOString()).toBe("2026-11-02T16:05:00.000Z");
    expect(view!.grades.coachability).toBeUndefined();

    // Notes and the Notion link are PII text: the audit row says they changed, never what they say.
    const entry = (await audits(interviewId)).at(-1)!;
    expect(entry.action).toBe("interview.result");
    expect(entry.changes).toMatchObject({
      status: { from: "scheduled", to: "held" },
      overallGrade: { from: null, to: "b_plus" },
      recommendation: { from: null, to: "hire" },
      notes: { from: CHANGED, to: CHANGED },
      notionUrl: { from: CHANGED, to: CHANGED },
      grades: { from: {}, to: { reliability: "a", work_ethic: "b_plus" } },
    });
    expect(JSON.stringify(entry.changes)).not.toContain("ladder training");
    expect(JSON.stringify(entry.changes)).not.toContain("notion.so");
  });

  it("edits the result later, replacing the scorecard grades and keeping a grade from an older scorecard", async () => {
    const { applicationId } = await newApplication(db, snow);
    const { interviewId } = await scheduled(applicationId);
    await recordInterviewResult(db, {
      interviewId,
      ...asManager(),
      outcome: "held",
      heldAt: new Date("2026-11-02T16:05:00Z"),
      grades: { reliability: "a", work_ethic: "b" },
      now: new Date("2026-11-02T18:00:00Z"),
    });
    // A grade under a category the owner has since dropped from the scorecard.
    await db.insert(interviewGrade).values({ interviewId, categoryKey: "punctuality", grade: "a_plus" });

    await recordInterviewResult(db, {
      interviewId,
      ...asManager(),
      outcome: "held",
      heldAt: new Date("2026-11-02T16:05:00Z"),
      grades: { reliability: "b_minus", communication: "a" },
      overallGrade: "b",
      now: new Date("2026-11-02T18:10:00Z"),
    });
    const rows = await db.select().from(interviewGrade).where(eq(interviewGrade.interviewId, interviewId));
    expect(Object.fromEntries(rows.map((r) => [r.categoryKey, r.grade]))).toEqual({ reliability: "b_minus", communication: "a", punctuality: "a_plus" });
    expect((await audits(interviewId)).at(-1)!.changes).toMatchObject({
      grades: { from: { reliability: "a", work_ethic: "b" }, to: { reliability: "b_minus", communication: "a" } },
      overallGrade: { from: null, to: "b" },
    });

    // Saving the same result again changes nothing and writes no audit row.
    const before = (await audits(interviewId)).length;
    const again = await recordInterviewResult(db, {
      interviewId,
      ...asManager(),
      outcome: "held",
      heldAt: new Date("2026-11-02T16:05:00Z"),
      grades: { reliability: "b_minus", communication: "a" },
      overallGrade: "b",
      now: new Date("2026-11-02T18:20:00Z"),
    });
    expect(again.changed).toBe(false);
    expect(await audits(interviewId)).toHaveLength(before);
  });

  it("records a no-show without grades, leaves the application open and names the Close reason", async () => {
    const { applicationId } = await newApplication(db, snow);
    const { interviewId } = await scheduled(applicationId);
    await recordInterviewResult(db, {
      interviewId,
      ...asManager(),
      outcome: "held",
      heldAt: new Date("2026-11-02T16:05:00Z"),
      grades: { reliability: "c" },
      recommendation: "maybe",
      now: new Date("2026-11-02T18:00:00Z"),
    });
    // Corrected to a no-show: the held time, grades and recommendation go.
    await recordInterviewResult(db, {
      interviewId,
      ...asManager(),
      outcome: "no_show",
      grades: { reliability: "a" },
      notes: "Did not answer two calls",
      now: new Date("2026-11-02T18:10:00Z"),
    });
    const [view] = await listInterviews(db, applicationId);
    expect(view).toMatchObject({ status: "no_show", heldAt: null, overallGrade: null, recommendation: null, grades: {}, notes: "Did not answer two calls" });

    const panel = await loadInterviewsPanel(db, applicationId, "hiring_manager");
    expect(panel!.application.status).toBe("open");
    expect(panel!.reasons.noShow).toBe("No-show to one-on-one");
  });

  it("refuses a held time in the future, a grade or category it does not know, long notes and links that are not Notion", async () => {
    const { applicationId } = await newApplication(db, snow);
    const { interviewId } = await scheduled(applicationId);
    const now = new Date("2026-11-02T18:00:00Z");
    const held = { interviewId, ...asManager(), outcome: "held" as const, heldAt: new Date("2026-11-02T16:05:00Z"), now };
    await expectInterviewError(recordInterviewResult(db, { ...held, heldAt: new Date("2026-11-02T19:00:00Z") }), "held_in_future");
    await expectInterviewError(recordInterviewResult(db, { ...held, heldAt: null }), "invalid_time");
    await expectInterviewError(recordInterviewResult(db, { ...held, grades: { punctuality: "a" } }), "unknown_category");
    await expectInterviewError(recordInterviewResult(db, { ...held, grades: { reliability: "e" as never } }), "invalid_grade");
    await expectInterviewError(recordInterviewResult(db, { ...held, overallGrade: "a_plus_plus" as never }), "invalid_grade");
    await expectInterviewError(recordInterviewResult(db, { ...held, recommendation: "strong_hire" as never }), "invalid_recommendation");
    await expectInterviewError(recordInterviewResult(db, { ...held, notes: "x".repeat(4001) }), "notes_too_long");
    await expectInterviewError(recordInterviewResult(db, { ...held, outcome: "maybe" as never }), "invalid_outcome");
    for (const url of [
      "http://www.notion.so/page",
      "https://notion.com/page",
      "https://evilnotion.so/page",
      "https://notion.so.example.com/page",
      "https://user:secret@www.notion.so/page",
      "https://www.notion.so:8443/page",
      "notion.so/page",
      "javascript:alert(1)",
    ]) {
      await expectInterviewError(recordInterviewResult(db, { ...held, notionUrl: url }), "invalid_notion_url");
    }
    expect(cleanNotionUrl("https://kahuna.notion.site/Interview-abc")).toBe("https://kahuna.notion.site/Interview-abc");
    expect(cleanNotionUrl("https://notion.so/abc")).toBe("https://notion.so/abc");
    expect(cleanNotionUrl("  ")).toBeNull();
    // Nothing was written by the refused calls.
    expect((await audits(interviewId)).map((e) => e.action)).toEqual(["interview.schedule"]);
  });

  it("keeps the scorecard as configuration", () => {
    expect(INTERVIEW_CATEGORIES).toEqual([
      { key: "reliability", label: "Reliability" },
      { key: "work_ethic", label: "Work ethic" },
      { key: "communication", label: "Communication" },
      { key: "coachability", label: "Coachability" },
      { key: "safety", label: "Safety awareness" },
      { key: "customer_presence", label: "Customer presence" },
    ]);
  });
});

describe("who may write", () => {
  it("refuses Viewers on every write and gives them the interviews without the staff list", async () => {
    const { applicationId } = await newApplication(db, snow);
    const { interviewId } = await scheduled(applicationId);
    const viewer = { userId: adminId, role: "viewer" as const };
    await expectInterviewError(
      scheduleInterview(db, { applicationId, ...viewer, kind: "one_on_one", scheduledAt: new Date("2026-11-02T16:00:00Z") }),
      "not_allowed",
    );
    await expectInterviewError(rescheduleInterview(db, { interviewId, ...viewer, scheduledAt: new Date("2026-11-04T16:00:00Z") }), "not_allowed");
    await expectInterviewError(cancelInterview(db, { interviewId, ...viewer }), "not_allowed");
    await expectInterviewError(
      recordInterviewResult(db, { interviewId, ...viewer, outcome: "held", heldAt: new Date("2026-11-02T16:05:00Z") }),
      "not_allowed",
    );

    const panel = await loadInterviewsPanel(db, applicationId, "viewer");
    expect(panel!.interviews.map((i) => i.id)).toEqual([interviewId]);
    expect(panel!.interviewers).toEqual([]);
    expect((await loadInterviewsPanel(db, applicationId, "admin"))!.interviewers.map((u) => u.id)).toContain(adminId);
    expect(await loadInterviewsPanel(db, uuidv7(), "admin")).toBeNull();
  });
});
