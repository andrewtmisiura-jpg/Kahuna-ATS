import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, applicationEvent, auditLog, backgroundCheck, hireStint, offer } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { replayEvents } from "@/server/services/applications/replay";
import {
  createApplication,
  StaleVersionError,
  transition,
  TransitionError,
  type TransitionInput,
} from "@/server/services/applications/transition";
import { addDays, addWeekdays, centralDate } from "@/server/services/time";
import { createPerson, loadAdminId, loadOption, loadSnow, loadStages, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

let snow: SnowFixture;
let stages: Record<string, string>;
let adminId: string;
let staff: { type: "staff"; userId: string };
const applicant = { type: "applicant" } as const;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  adminId = await loadAdminId(db);
  staff = { type: "staff", userId: adminId };
});

afterAll(async () => {
  await sql.end();
});

async function newApplication(options: { submitted?: boolean; startedAt?: Date; submittedAt?: Date } = {}) {
  const personId = await createPerson(db);
  const { applicationId } = await createApplication(db, {
    personId,
    openingId: snow.openingId,
    origin: "landing",
    entryChannel: "role_qr",
    actor: applicant,
    occurredAt: options.startedAt,
  });
  if (options.submitted || options.submittedAt) {
    await transition(db, { action: "submit", applicationId, actor: applicant, occurredAt: options.submittedAt });
  }
  return { applicationId, personId };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

async function loadApp(id: string) {
  const [row] = await db.select().from(application).where(eq(application.id, id));
  return row!;
}

async function loadEvents(id: string) {
  return db.select().from(applicationEvent).where(eq(applicationEvent.applicationId, id)).orderBy(asc(applicationEvent.seq));
}

async function expectCode(run: Promise<unknown>, code: TransitionError["code"]) {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected TransitionError ${code}`).toBeInstanceOf(TransitionError);
  expect((caught as TransitionError).code).toBe(code);
  return caught as TransitionError;
}

function move(applicationId: string, toStageId: string, extra: Partial<Extract<TransitionInput, { action: "move" }>> = {}) {
  return transition(db, { action: "move", applicationId, toStageId, actor: staff, ...extra });
}

describe("createApplication", () => {
  it("pins the published form and writes the created event", async () => {
    const { applicationId } = await newApplication();
    const app = await loadApp(applicationId);
    expect(app.formVersionId).toBe(snow.formVersionId);
    expect(app.currentStageId).toBe(stages.started);
    expect(app.eventSeq).toBe(1);
    expect(app.status).toBe("open");
    const events = await loadEvents(applicationId);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("created");
    expect(events[0]!.toStageId).toBe(stages.started);
  });
});

describe("submit", () => {
  it("moves Started to Submitted, locks answers and refuses a second submit", async () => {
    const { applicationId } = await newApplication();
    const { application: app } = await transition(db, { action: "submit", applicationId, actor: applicant });
    expect(app.currentStageId).toBe(stages.submitted);
    expect(app.submittedAt).not.toBeNull();
    expect(app.answersLocked).toBe(true);
    expect(app.eventSeq).toBe(2);
    await expectCode(transition(db, { action: "submit", applicationId, actor: applicant }), "already_submitted");
  });

  it("is refused on a closed application", async () => {
    const { applicationId } = await newApplication();
    const reason = await loadOption(db, "withdraw_reason", "pay");
    await transition(db, { action: "close", applicationId, outcome: "withdrew", reasonOptionId: reason, actor: staff });
    await expectCode(transition(db, { action: "submit", applicationId, actor: applicant }), "application_closed");
  });
});

describe("moves", () => {
  it("moves forward, backward and keeps the cache in step with the log", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    let result = await move(applicationId, stages.reviewed, { expectedSeq: 2 });
    expect(result.application.currentStageId).toBe(stages.reviewed);
    expect(result.event.fromStageId).toBe(stages.submitted);
    result = await move(applicationId, stages.one_on_one_invited, { expectedSeq: 3 });
    result = await move(applicationId, stages.reviewed, { expectedSeq: 4, note: "back for another look" });
    expect(result.application.currentStageId).toBe(stages.reviewed);
    expect(result.application.stageEnteredAt).toEqual(result.event.occurredAt);

    const events = await loadEvents(applicationId);
    const replayed = replayEvents(events);
    const app = await loadApp(applicationId);
    expect(replayed).toEqual({
      currentStageId: app.currentStageId,
      stageEnteredAt: app.stageEnteredAt,
      status: app.status,
      closedOutcome: app.closedOutcome,
      closedReasonOptionId: app.closedReasonOptionId,
      onHold: app.onHold,
      startedAt: app.startedAt,
      submittedAt: app.submittedAt,
      answersLocked: app.answersLocked,
      eventSeq: app.eventSeq,
    });
  });

  it("refuses the same stage, another role's stage and a closed application", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    await expectCode(move(applicationId, stages.submitted), "same_stage");
    const [windowStage] = await sql<{ id: string }[]>`
      select s.id from pipeline_stage s join role r on r.id = s.role_id where r.key = 'window_cleaning_tech' limit 1`;
    await expectCode(move(applicationId, windowStage!.id), "stage_wrong_role");
    const reason = await loadOption(db, "not_selected_reason", "roles_filled");
    await transition(db, { action: "close", applicationId, outcome: "not_selected", reasonOptionId: reason, actor: staff });
    await expectCode(move(applicationId, stages.reviewed), "application_closed");
  });

  it("Hire now: jumps from Submitted straight to Hired and creates the stint", async () => {
    const { applicationId, personId } = await newApplication({ submitted: true });
    const result = await move(applicationId, stages.hired, { hire: { isTemporary: true, startOn: "2026-11-02" } });
    expect(result.application.status).toBe("hired");
    expect(result.application.currentStageId).toBe(stages.hired);
    expect(result.event.toStatus).toBe("hired");
    expect(result.created.hireStintId).toBeDefined();
    const [stint] = await db.select().from(hireStint).where(eq(hireStint.id, result.created.hireStintId!));
    expect(stint!.personId).toBe(personId);
    expect(stint!.origin).toBe("ats");
    expect(stint!.openingId).toBe(snow.openingId);
    expect(stint!.isTemporary).toBe(true);
    expect(stint!.startOn).toBe("2026-11-02");
    // No offer or check was invented for the skipped milestones.
    expect(await db.select().from(offer).where(eq(offer.applicationId, applicationId))).toHaveLength(0);

    // A normal move out of Hired undoes the hire as a mistake.
    const back = await move(applicationId, stages.reviewed);
    expect(back.application.status).toBe("open");
    const [voided] = await db.select().from(hireStint).where(eq(hireStint.id, stint!.id));
    expect(voided!.voidKind).toBe("entered_in_error");
    expect(voided!.voidedAt).not.toBeNull();
  });

  it("creates the offer on the move into Conditional offer with the Central date", async () => {
    const { applicationId } = await newApplication({ startedAt: daysAgo(6), submittedAt: daysAgo(5) });
    // 23:30 Central four days ago is after midnight UTC: the offer date must read the Central day.
    const occurredAt = new Date(`${centralDate(daysAgo(4))}T23:30:00-05:00`);
    const result = await move(applicationId, stages.conditional_offer, {
      occurredAt,
      offer: { plannedStartOn: "2026-11-09" },
    });
    expect(result.created.offerId).toBeDefined();
    const [row] = await db.select().from(offer).where(eq(offer.id, result.created.offerId!));
    expect(row!.offeredOn).toBe(centralDate(occurredAt));
    expect(row!.offeredBy).toBe(adminId);
    expect(row!.isConditional).toBe(true);
    expect(row!.plannedStartOn).toBe("2026-11-09");

    // Moving back and in again does not create a second live offer.
    await move(applicationId, stages.reviewed);
    const again = await move(applicationId, stages.conditional_offer);
    expect(again.created.offerId).toBeUndefined();
    expect(await db.select().from(offer).where(eq(offer.applicationId, applicationId))).toHaveLength(1);
  });

  it("blocks Background check without an offer and creates the check with one", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    await expectCode(move(applicationId, stages.background_check, { check: { checkType: "criminal" } }), "offer_required");
    await move(applicationId, stages.conditional_offer);
    await expectCode(move(applicationId, stages.background_check), "check_type_required");
    const result = await move(applicationId, stages.background_check, { check: { checkType: "driving_record", vendor: "Checkr" } });
    const [check] = await db.select().from(backgroundCheck).where(eq(backgroundCheck.id, result.created.backgroundCheckId!));
    expect(check!.status).toBe("requested");
    expect(check!.checkType).toBe("driving_record");
    expect(check!.requestedOn).toBe(centralDate(result.event.occurredAt));
    // The stint created later carries the offer's planned start date.
    await move(applicationId, stages.conditional_offer);
  });
});

describe("backdating", () => {
  it("accepts a backdated time, refuses the future and anything before the previous event", async () => {
    const startedAt = daysAgo(3);
    const { applicationId } = await newApplication({ startedAt });
    const yesterday = daysAgo(1);
    const result = await transition(db, { action: "submit", applicationId, actor: applicant, occurredAt: yesterday });
    expect(result.application.submittedAt).toEqual(yesterday);

    await expectCode(move(applicationId, stages.reviewed, { occurredAt: new Date(Date.now() + 3_600_000) }), "occurred_in_future");
    await expectCode(
      move(applicationId, stages.reviewed, { occurredAt: new Date(startedAt.getTime() + 60_000) }),
      "occurred_before_previous",
    );
    const laterYesterday = new Date(yesterday.getTime() + 3_600_000);
    const moved = await move(applicationId, stages.reviewed, { occurredAt: laterYesterday });
    expect(moved.application.stageEnteredAt).toEqual(laterYesterday);
  });

  it("lets a voided mistake be re-entered with an earlier time", async () => {
    const { applicationId } = await newApplication({ startedAt: daysAgo(2), submittedAt: daysAgo(1) });
    const wrong = await move(applicationId, stages.reviewed);
    await transition(db, { action: "void", applicationId, eventId: wrong.event.id, actor: staff, note: "wrong time" });
    const earlier = new Date(Date.now() - 3_600_000);
    const fixed = await move(applicationId, stages.reviewed, { occurredAt: earlier });
    expect(fixed.application.stageEnteredAt).toEqual(earlier);
  });
});

describe("optimistic concurrency", () => {
  it("rejects a stale version and names who changed it", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    await move(applicationId, stages.reviewed, { expectedSeq: 2 });
    const error = (await expectCode(move(applicationId, stages.one_on_one_invited, { expectedSeq: 2 }), "stale_version")) as StaleVersionError;
    expect(error).toBeInstanceOf(StaleVersionError);
    expect(error.currentSeq).toBe(3);
    expect(error.changedBy?.email).toBe(TEST_ADMIN_EMAIL);
    expect(error.message).toContain("reload");
  });

  it("lets exactly one of two concurrent moves through", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    const results = await Promise.allSettled([
      move(applicationId, stages.reviewed, { expectedSeq: 2 }),
      move(applicationId, stages.one_on_one_invited, { expectedSeq: 2 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleVersionError);
    const app = await loadApp(applicationId);
    expect(app.eventSeq).toBe(3);
    expect(await loadEvents(applicationId)).toHaveLength(3);
  });
});

describe("close, hold, reopen, contacted", () => {
  it("closes with a reason from the matching list and requires a note when the reason says so", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    const withdraw = await loadOption(db, "withdraw_reason", "pay");
    const other = await loadOption(db, "disqualify_reason", "other");
    const availability = await loadOption(db, "disqualify_reason", "availability_conflict");
    await expectCode(
      transition(db, { action: "close", applicationId, outcome: "disqualified", reasonOptionId: withdraw, actor: staff }),
      "reason_wrong_list",
    );
    await expectCode(
      transition(db, { action: "close", applicationId, outcome: "disqualified", reasonOptionId: other, actor: staff }),
      "note_required",
    );
    const ladder = await loadOption(db, "disqualify_reason", "failed_ladder_test");
    await expectCode(
      transition(db, { action: "close", applicationId, outcome: "disqualified", reasonOptionId: ladder, actor: staff }),
      "reason_wrong_role",
    );
    const result = await transition(db, {
      action: "close",
      applicationId,
      outcome: "disqualified",
      reasonOptionId: availability,
      actor: staff,
    });
    expect(result.application.status).toBe("closed");
    expect(result.application.closedOutcome).toBe("disqualified");
    expect(result.application.closedReasonOptionId).toBe(availability);
    expect(result.application.currentStageId).toBe(stages.submitted);
    await expectCode(
      transition(db, { action: "close", applicationId, outcome: "withdrew", reasonOptionId: withdraw, actor: staff }),
      "application_closed",
    );
  });

  it("holds, unholds, reopens and records contact", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    let result = await transition(db, { action: "hold", applicationId, actor: staff });
    expect(result.application.onHold).toBe(true);
    await expectCode(transition(db, { action: "hold", applicationId, actor: staff }), "already_on_hold");
    result = await transition(db, { action: "unhold", applicationId, actor: staff });
    expect(result.application.onHold).toBe(false);
    await expectCode(transition(db, { action: "unhold", applicationId, actor: staff }), "not_on_hold");

    result = await transition(db, { action: "contacted", applicationId, actor: staff });
    expect(result.event.kind).toBe("contacted");

    await expectCode(transition(db, { action: "reopen", applicationId, actor: staff }), "application_not_closed");
    const reason = await loadOption(db, "withdraw_reason", "stopped_responding");
    await transition(db, { action: "close", applicationId, outcome: "withdrew", reasonOptionId: reason, actor: staff });
    await expectCode(transition(db, { action: "hold", applicationId, actor: staff }), "application_not_open");
    result = await transition(db, { action: "reopen", applicationId, toStageId: stages.reviewed, actor: staff });
    expect(result.application.status).toBe("open");
    expect(result.application.closedOutcome).toBeNull();
    expect(result.application.closedReasonOptionId).toBeNull();
    expect(result.application.currentStageId).toBe(stages.reviewed);
  });
});

describe("FCRA gate", () => {
  async function withOpenCheck() {
    const { applicationId } = await newApplication({ submitted: true });
    await move(applicationId, stages.conditional_offer);
    const result = await move(applicationId, stages.background_check, { check: { checkType: "criminal" } });
    return { applicationId, checkId: result.created.backgroundCheckId! };
  }

  it("needs the check, its pre-adverse date and five weekdays for a background-based disqualification", async () => {
    const { applicationId, checkId } = await withOpenCheck();
    const adverse = await loadOption(db, "disqualify_reason", "background_or_driving_record");
    const close = (fcra?: { backgroundCheckIds?: string[]; notReportBased?: boolean }) =>
      transition(db, { action: "close", applicationId, outcome: "disqualified", reasonOptionId: adverse, actor: staff, fcra });

    await expectCode(close(), "fcra_check_required");
    await expectCode(close({ backgroundCheckIds: ["00000000-0000-7000-8000-000000000000"] }), "fcra_check_not_found");
    await expectCode(close({ backgroundCheckIds: [checkId] }), "fcra_pre_adverse_required");

    const today = centralDate(new Date());
    await db.update(backgroundCheck).set({ preAdverseNoticeOn: today, status: "pre_adverse_sent" }).where(eq(backgroundCheck.id, checkId));
    const tooSoon = await expectCode(close({ backgroundCheckIds: [checkId] }), "fcra_waiting_period");
    expect(tooSoon.details.earliest).toBe(addWeekdays(today, 5));

    // The last notice date whose fifth weekday is today, so the boundary is exact.
    let notice = addDays(today, -5);
    while (addWeekdays(notice, 5) !== today) notice = addDays(notice, -1);
    await db.update(backgroundCheck).set({ preAdverseNoticeOn: notice }).where(eq(backgroundCheck.id, checkId));
    const result = await close({ backgroundCheckIds: [checkId] });
    expect(result.application.status).toBe("closed");
    expect(result.event.metadata).toEqual({ background_check_ids: [checkId] });
  });

  it("needs the not-report-based statement for any other disqualification while a check is open", async () => {
    const { applicationId } = await withOpenCheck();
    const availability = await loadOption(db, "disqualify_reason", "availability_conflict");
    const close = (fcra?: { notReportBased?: boolean }) =>
      transition(db, { action: "close", applicationId, outcome: "disqualified", reasonOptionId: availability, actor: staff, fcra });
    const refused = await expectCode(close(), "fcra_statement_required");
    expect(refused.details.openCheckIds).toHaveLength(1);

    const result = await close({ notReportBased: true });
    expect(result.event.metadata).toEqual({ not_report_based: true });
    const audits = await db.select().from(auditLog).where(eq(auditLog.applicationId, applicationId));
    expect(audits.map((a) => a.action)).toContain("application.close_not_report_based");
  });

  it("lets a withdrawal through while a check is open, and a canceled check no longer blocks", async () => {
    const { applicationId, checkId } = await withOpenCheck();
    const stopped = await loadOption(db, "withdraw_reason", "stopped_responding");
    await transition(db, { action: "close", applicationId, outcome: "withdrew", reasonOptionId: stopped, actor: staff });
    await transition(db, { action: "reopen", applicationId, actor: staff });

    await db.update(backgroundCheck).set({ status: "canceled" }).where(eq(backgroundCheck.id, checkId));
    const filled = await loadOption(db, "not_selected_reason", "roles_filled");
    const result = await transition(db, { action: "close", applicationId, outcome: "not_selected", reasonOptionId: filled, actor: staff });
    expect(result.event.metadata).toBeNull();
  });
});

describe("voiding", () => {
  it("voids only the latest change and undoes what the move created", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    const reviewed = await move(applicationId, stages.reviewed);
    const offered = await move(applicationId, stages.conditional_offer);
    const events = await loadEvents(applicationId);
    const created = events.find((e) => e.kind === "created")!;

    await expectCode(transition(db, { action: "void", applicationId, eventId: created.id, actor: staff }), "event_not_voidable");
    await expectCode(transition(db, { action: "void", applicationId, eventId: reviewed.event.id, actor: staff }), "event_not_latest");

    const result = await transition(db, { action: "void", applicationId, eventId: offered.event.id, actor: staff });
    expect(result.event.kind).toBe("event_voided");
    expect(result.event.voidsEventId).toBe(offered.event.id);
    expect(result.application.currentStageId).toBe(stages.reviewed);
    expect(result.application.stageEnteredAt).toEqual(reviewed.event.occurredAt);
    const [row] = await db.select().from(offer).where(eq(offer.id, offered.created.offerId!));
    expect(row!.deletedAt).not.toBeNull();

    await expectCode(transition(db, { action: "void", applicationId, eventId: offered.event.id, actor: staff }), "event_already_voided");
    // Now the earlier move is the latest and can be voided too.
    const second = await transition(db, { action: "void", applicationId, eventId: reviewed.event.id, actor: staff });
    expect(second.application.currentStageId).toBe(stages.submitted);
  });

  it("voids a Hire now move and marks the stint entered in error", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    const hired = await move(applicationId, stages.hired);
    const result = await transition(db, { action: "void", applicationId, eventId: hired.event.id, actor: staff });
    expect(result.application.status).toBe("open");
    expect(result.application.currentStageId).toBe(stages.submitted);
    const [stint] = await db.select().from(hireStint).where(eq(hireStint.id, hired.created.hireStintId!));
    expect(stint!.voidKind).toBe("entered_in_error");
  });
});

describe("rescinding a hire", () => {
  it("voids the stint as rescinded and closes with a reason", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    const hired = await move(applicationId, stages.hired);
    const declined = await loadOption(db, "withdraw_reason", "declined_offer");
    await expectCode(
      transition(db, { action: "close", applicationId, outcome: "withdrew", reasonOptionId: declined, actor: staff }),
      "application_hired",
    );
    const result = await transition(db, {
      action: "rescind_hire",
      applicationId,
      actor: staff,
      voidReason: "Took another job before day one",
      to: { status: "closed", outcome: "withdrew", reasonOptionId: declined },
    });
    expect(result.application.status).toBe("closed");
    expect(result.application.closedOutcome).toBe("withdrew");
    const [stint] = await db.select().from(hireStint).where(eq(hireStint.id, hired.created.hireStintId!));
    expect(stint!.voidKind).toBe("rescinded");
    expect(stint!.voidReason).toBe("Took another job before day one");
    await expectCode(
      transition(db, { action: "rescind_hire", applicationId, actor: staff, voidReason: "x", to: { status: "open" } }),
      "application_not_hired",
    );
  });

  it("can send the person back to an earlier stage, and voiding the rescission restores the stint", async () => {
    const { applicationId } = await newApplication({ submitted: true });
    const hired = await move(applicationId, stages.hired);
    const rescinded = await transition(db, {
      action: "rescind_hire",
      applicationId,
      actor: staff,
      voidReason: "Start date fell through",
      to: { status: "open", toStageId: stages.one_on_one_done },
    });
    expect(rescinded.application.status).toBe("open");
    expect(rescinded.application.currentStageId).toBe(stages.one_on_one_done);

    const restored = await transition(db, { action: "void", applicationId, eventId: rescinded.event.id, actor: staff });
    expect(restored.application.status).toBe("hired");
    expect(restored.application.currentStageId).toBe(stages.hired);
    const [stint] = await db.select().from(hireStint).where(eq(hireStint.id, hired.created.hireStintId!));
    expect(stint!.voidedAt).toBeNull();
  });
});
