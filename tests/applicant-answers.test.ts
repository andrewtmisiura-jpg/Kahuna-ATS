import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { answer, application, applicationEvent, formItem, message, question, questionVersion } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import {
  AnswersError,
  loadApplicationForm,
  saveAnswer,
  submitApplication,
  type AnswerValue,
} from "@/server/services/applications/answers";
import { createApplication } from "@/server/services/applications/transition";
import { createPerson, loadEmployer, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// Autosave compare-and-set, submit locking and the form loader
// (DATA_MODEL.md, answer: "Autosave and submit").

let snow: SnowFixture;
let employerId: string;
// Snow form v1 question version ids by question key.
let qv: Record<string, string>;
let windowQuestionVersionId: string;

const applicant = { type: "applicant" } as const;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  employerId = (await loadEmployer(db)).id;
  const rows = await db
    .select({ key: question.key, id: formItem.questionVersionId })
    .from(formItem)
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(eq(formItem.formVersionId, snow.formVersionId));
  qv = Object.fromEntries(rows.map((r) => [r.key, r.id]));
  const [windowRow] = await db
    .select({ id: questionVersion.id })
    .from(questionVersion)
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(and(eq(question.key, "ladder_height")));
  windowQuestionVersionId = windowRow!.id;
});

afterAll(async () => {
  await sql.end();
});

async function newApplication() {
  const personId = await createPerson(db, { firstName: "Ana", email: `ana-${crypto.randomUUID()}@example.test` });
  const { applicationId } = await createApplication(db, {
    personId,
    openingId: snow.openingId,
    origin: "landing",
    entryChannel: "role_qr",
    actor: applicant,
  });
  return applicationId;
}

async function expectCode(run: Promise<unknown>, code: AnswersError["code"]) {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected AnswersError ${code}`).toBeInstanceOf(AnswersError);
  expect((caught as AnswersError).code).toBe(code);
  return caught as AnswersError;
}

const REQUIRED: Array<[string, AnswerValue]> = [
  ["age_18_plus", true],
  ["drivers_license", true],
  ["short_notice_travel", true],
  ["start_date", "2026-11-02"],
  ["essential_functions", true],
  ["call_windows", ["overnight", "weekends"]],
  ["response_time", ["under_30"]],
  ["other_job", ["none"]],
  ["equipment", ["shovel"]],
];

async function answerRequired(applicationId: string, except: string[] = []) {
  for (const [key, value] of REQUIRED) {
    if (except.includes(key)) continue;
    await saveAnswer(db, { applicationId, questionVersionId: qv[key]!, revision: 0, value });
  }
}

describe("autosave compare-and-set", () => {
  it("inserts at revision 1, updates when the revision matches and returns the newer value on a miss", async () => {
    const applicationId = await newApplication();
    const first = await saveAnswer(db, { applicationId, questionVersionId: qv.job1_employer!, revision: 0, value: "Acme Snow" });
    expect(first).toEqual({ ok: true, revision: 1, value: "Acme Snow" });

    const second = await saveAnswer(db, { applicationId, questionVersionId: qv.job1_employer!, revision: 1, value: "Acme Snow Co" });
    expect(second).toEqual({ ok: true, revision: 2, value: "Acme Snow Co" });

    // A stale device still at revision 1 never overwrites revision 2.
    const stale = await saveAnswer(db, { applicationId, questionVersionId: qv.job1_employer!, revision: 1, value: "Old phone" });
    expect(stale).toEqual({ ok: false, reason: "stale", revision: 2, value: "Acme Snow Co" });

    // A device that never saved this answer (revision 0) also loses to the stored row.
    const fresh = await saveAnswer(db, { applicationId, questionVersionId: qv.job1_employer!, revision: 0, value: "Other device" });
    expect(fresh).toEqual({ ok: false, reason: "stale", revision: 2, value: "Acme Snow Co" });

    const rows = await db.select().from(answer).where(eq(answer.applicationId, applicationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valueText).toBe("Acme Snow Co");
    expect(rows[0]!.revision).toBe(2);
  });

  it("stores each type in its own column and clears with null or empty", async () => {
    const applicationId = await newApplication();
    await saveAnswer(db, { applicationId, questionVersionId: qv.age_18_plus!, revision: 0, value: true });
    await saveAnswer(db, { applicationId, questionVersionId: qv.start_date!, revision: 0, value: "2026-11-02" });
    await saveAnswer(db, { applicationId, questionVersionId: qv.job1_months!, revision: 0, value: 14 });
    await saveAnswer(db, { applicationId, questionVersionId: qv.call_windows!, revision: 0, value: ["overnight", "daytime"] });
    await saveAnswer(db, { applicationId, questionVersionId: qv.response_time!, revision: 0, value: ["under_30"] });

    const form = await loadApplicationForm(db, applicationId);
    const byId = new Map(form!.answers.map((a) => [a.questionVersionId, a.value]));
    expect(byId.get(qv.age_18_plus!)).toBe(true);
    expect(byId.get(qv.start_date!)).toBe("2026-11-02");
    expect(byId.get(qv.job1_months!)).toBe(14);
    expect(byId.get(qv.call_windows!)).toEqual(["overnight", "daytime"]);
    expect(byId.get(qv.response_time!)).toEqual(["under_30"]);

    const cleared = await saveAnswer(db, { applicationId, questionVersionId: qv.job1_months!, revision: 1, value: "" });
    expect(cleared).toEqual({ ok: true, revision: 2, value: null });
    const [row] = await db.select().from(answer).where(and(eq(answer.applicationId, applicationId), eq(answer.questionVersionId, qv.job1_months!)));
    expect(row!.valueNumber).toBeNull();
  });

  it("refuses values that break the question's type, options or validation", async () => {
    const applicationId = await newApplication();
    const save = (key: string, value: AnswerValue) => saveAnswer(db, { applicationId, questionVersionId: qv[key]!, revision: 0, value });
    await expectCode(save("job1_months", 601), "invalid_value");
    await expectCode(save("job1_months", 2.5), "invalid_value");
    await expectCode(save("response_time", ["under_30", "over_2h"]), "invalid_value");
    await expectCode(save("equipment", ["jetpack"]), "invalid_value");
    await expectCode(save("age_18_plus", "yes"), "invalid_value");
    await expectCode(save("start_date", "2026-13-45"), "invalid_value");
    await expectCode(save("job1_employer", "x".repeat(201)), "invalid_value");
    expect(await db.select().from(answer).where(eq(answer.applicationId, applicationId))).toHaveLength(0);
  });

  it("refuses a question that is not on the application's pinned form", async () => {
    const applicationId = await newApplication();
    await expectCode(
      saveAnswer(db, { applicationId, questionVersionId: windowQuestionVersionId, revision: 0, value: ["never"] }),
      "question_not_in_form",
    );
    await expectCode(saveAnswer(db, { applicationId: crypto.randomUUID(), questionVersionId: qv.age_18_plus!, revision: 0, value: true }), "application_not_found");
  });
});

describe("submit", () => {
  it("checks required items only at submit and names the missing ones", async () => {
    const applicationId = await newApplication();
    await answerRequired(applicationId, ["call_windows", "start_date"]);
    const error = await expectCode(submitApplication(db, { applicationId, employerId }), "required_missing");
    expect([...(error.details.missing as string[])].sort()).toEqual([qv.call_windows!, qv.start_date!].sort());
    const [app] = await db.select().from(application).where(eq(application.id, applicationId));
    expect(app!.submittedAt).toBeNull();
    expect(app!.answersLocked).toBe(false);
  });

  it("applies pending values, writes the submitted event with a snapshot, locks answers and queues the confirmation", async () => {
    const applicationId = await newApplication();
    await answerRequired(applicationId, ["equipment"]);
    // The device had typed an employer and picked equipment but not saved them yet.
    const result = await submitApplication(db, {
      applicationId,
      employerId,
      pending: [
        { questionVersionId: qv.equipment!, revision: 0, value: ["snowblower"] },
        { questionVersionId: qv.job1_employer!, revision: 0, value: "Acme Snow" },
      ],
      source: { source: "referral", sourceDetail: "Marcus" },
    });
    expect(result.queued).toHaveLength(1);

    const [app] = await db.select().from(application).where(eq(application.id, applicationId));
    expect(app!.submittedAt).toEqual(result.submittedAt);
    expect(app!.answersLocked).toBe(true);
    expect(app!.eventSeq).toBe(2);
    expect(app!.source).toBe("referral");
    expect(app!.sourceDetail).toBe("Marcus");
    expect(app!.sourceSetBy).toBe("applicant");

    const events = await db.select().from(applicationEvent).where(eq(applicationEvent.applicationId, applicationId)).orderBy(asc(applicationEvent.seq));
    expect(events.map((e) => e.kind)).toEqual(["created", "submitted"]);
    const snapshot = events[1]!.metadata?.submission as { form_version_id: string; answers: Array<{ question_key: string; value: unknown }> };
    expect(snapshot.form_version_id).toBe(snow.formVersionId);
    const byKey = Object.fromEntries(snapshot.answers.map((a) => [a.question_key, a.value]));
    expect(byKey.equipment).toEqual(["snowblower"]);
    expect(byKey.job1_employer).toBe("Acme Snow");
    expect(byKey.age_18_plus).toBe(true);
    expect(byKey.job1_end).toBeNull();

    const [queued] = await db.select().from(message).where(eq(message.id, result.queued[0]!));
    expect(queued!.purpose).toBe("submit_confirmation");
    expect(queued!.channel).toBe("email");
    expect(queued!.applicationId).toBe(applicationId);
    expect(queued!.status).toBe("queued");

    // Locked: a late autosave is refused and a second submit says so.
    await expectCode(saveAnswer(db, { applicationId, questionVersionId: qv.job1_employer!, revision: 1, value: "Changed" }), "answers_locked");
    await expectCode(submitApplication(db, { applicationId, employerId }), "already_submitted");
    const form = await loadApplicationForm(db, applicationId);
    expect(form!.answersLocked).toBe(true);
    expect(form!.stagePublicLabel).toBe("Received");
  });

  it("a stale pending value at submit never overwrites a newer saved answer", async () => {
    const applicationId = await newApplication();
    await answerRequired(applicationId);
    await saveAnswer(db, { applicationId, questionVersionId: qv.job1_employer!, revision: 0, value: "First" });
    await saveAnswer(db, { applicationId, questionVersionId: qv.job1_employer!, revision: 1, value: "Newer" });
    await submitApplication(db, {
      applicationId,
      employerId,
      pending: [{ questionVersionId: qv.job1_employer!, revision: 1, value: "Old device" }],
    });
    const [row] = await db.select().from(answer).where(and(eq(answer.applicationId, applicationId), eq(answer.questionVersionId, qv.job1_employer!)));
    expect(row!.valueText).toBe("Newer");
  });
});

describe("loadApplicationForm", () => {
  it("returns the pinned form's sections and questions in order with the application's state", async () => {
    const applicationId = await newApplication();
    const form = await loadApplicationForm(db, applicationId);
    expect(form).not.toBeNull();
    expect(form!.sections.map((s) => s.key)).toEqual(["basics", "availability", "experience"]);
    expect(form!.questions.map((q) => q.questionKey)).toEqual([
      "age_18_plus",
      "drivers_license",
      "short_notice_travel",
      "start_date",
      "essential_functions",
      "call_windows",
      "response_time",
      "other_job",
      "equipment",
      "job1_employer",
      "job1_months",
      "job1_end",
    ]);
    expect(form!.questions.find((q) => q.questionKey === "job1_months")!.validation).toEqual({ min: 0, max: 600, integer: true });
    expect(form!.status).toBe("open");
    expect(form!.submittedAt).toBeNull();
    expect(form!.roleTitle).toBe("Snow Removal Technician (on-call)");
    expect(form!.answers).toEqual([]);
    expect(await loadApplicationForm(db, crypto.randomUUID())).toBeNull();
  });
});
