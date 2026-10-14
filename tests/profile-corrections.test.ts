import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { hireStint, offer } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { rescindHire, stageBeforeHire, undoLastChange, undoPreview } from "@/server/services/applications/corrections";
import { listStages, loadProfile } from "@/server/services/applications/queries";
import { createApplication, StaleVersionError, transition, TransitionError } from "@/server/services/applications/transition";
import { createPerson, loadAdminId, loadOption, loadSnow, loadStages, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// "Rescind hire" and "Undo last change" on the profile: both go through
// transition(), so these tests check the reason rules, the default stage, the
// confirmation text and that undo only ever voids the latest state change.

let snow: SnowFixture;
let stages: Record<string, string>;
let staff: { type: "staff"; userId: string };
const applicant = { type: "applicant" } as const;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  staff = { type: "staff", userId: await loadAdminId(db) };
});

afterAll(async () => {
  await sql.end();
});

async function submitted() {
  const personId = await createPerson(db);
  const { applicationId } = await createApplication(db, { personId, openingId: snow.openingId, origin: "landing", entryChannel: "role_qr", actor: applicant });
  await transition(db, { action: "submit", applicationId, actor: applicant });
  return applicationId;
}

function move(applicationId: string, toStageId: string) {
  return transition(db, { action: "move", applicationId, toStageId, actor: staff });
}

async function expectCode(run: Promise<unknown>, code: TransitionError["code"]) {
  const caught = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught, `expected TransitionError ${code}`).toBeInstanceOf(TransitionError);
  expect((caught as TransitionError).code).toBe(code);
}

async function seqOf(applicationId: string) {
  return (await loadProfile(db, applicationId, "admin"))!.application.eventSeq;
}

describe("rescind hire", () => {
  it("closes with the picked reason, which becomes the hire record's void reason", async () => {
    const applicationId = await submitted();
    const hired = await move(applicationId, stages.hired!);
    const declined = await loadOption(db, "withdraw_reason", "declined_offer");
    const result = await rescindHire(db, {
      applicationId,
      actor: staff,
      expectedSeq: hired.application.eventSeq,
      to: { status: "closed", outcome: "withdrew", reasonOptionId: declined },
    });
    expect(result.application).toMatchObject({ status: "closed", closedOutcome: "withdrew", closedReasonOptionId: declined });
    expect(result.event.kind).toBe("hire_rescinded");
    const [stint] = await db.select().from(hireStint).where(eq(hireStint.id, hired.created.hireStintId!));
    expect(stint).toMatchObject({ voidKind: "rescinded" });
    expect(stint!.voidReason).toMatch(/^Declined/);
  });

  it("adds the note to the reason and keeps it on the event", async () => {
    const applicationId = await submitted();
    const hired = await move(applicationId, stages.hired!);
    const declined = await loadOption(db, "withdraw_reason", "declined_offer");
    const result = await rescindHire(db, {
      applicationId,
      actor: staff,
      note: "Took a warehouse job",
      to: { status: "closed", outcome: "withdrew", reasonOptionId: declined },
    });
    expect(result.event.note).toBe("Took a warehouse job");
    const [stint] = await db.select().from(hireStint).where(eq(hireStint.id, hired.created.hireStintId!));
    expect(stint!.voidReason).toMatch(/: Took a warehouse job$/);
  });

  it("going back to a stage needs a note and the stage, and lands there", async () => {
    const applicationId = await submitted();
    await move(applicationId, stages.reviewed!);
    const hired = await move(applicationId, stages.hired!);
    await expectCode(rescindHire(db, { applicationId, actor: staff, to: { status: "open", toStageId: stages.reviewed! } }), "note_required");
    await expectCode(rescindHire(db, { applicationId, actor: staff, note: "   ", to: { status: "open", toStageId: stages.reviewed! } }), "note_required");
    await expectCode(
      rescindHire(db, { applicationId, actor: staff, note: "Start date fell through", to: { status: "open", toStageId: "" as string } }),
      "stage_required",
    );
    const result = await rescindHire(db, {
      applicationId,
      actor: staff,
      expectedSeq: hired.application.eventSeq,
      note: "Start date fell through",
      to: { status: "open", toStageId: stages.reviewed! },
    });
    expect(result.application).toMatchObject({ status: "open", currentStageId: stages.reviewed });
    const [stint] = await db.select().from(hireStint).where(eq(hireStint.id, hired.created.hireStintId!));
    expect(stint).toMatchObject({ voidKind: "rescinded", voidReason: "Start date fell through" });
  });

  it("defaults the stage to the one before Hired", async () => {
    const viaReview = await submitted();
    await move(viaReview, stages.reviewed!);
    await move(viaReview, stages.hired!);
    expect((await loadProfile(db, viaReview, "admin"))!.rescindStageId).toBe(stages.reviewed);

    // Hire now from Submitted: back to Submitted.
    const hireNow = await submitted();
    await move(hireNow, stages.hired!);
    expect((await loadProfile(db, hireNow, "admin"))!.rescindStageId).toBe(stages.submitted);

    // Not hired: no default.
    expect((await loadProfile(db, await submitted(), "admin"))!.rescindStageId).toBeNull();

    // With no usable history, the last stage before Hired in the pipeline.
    const options = await listStages(db, snow.roleId);
    expect(stageBeforeHire([], options)).toBe(stages.background_check);
  });
});

describe("undo last change", () => {
  it("names the latest change and what undoing it does", async () => {
    const applicationId = await submitted();
    expect((await loadProfile(db, applicationId, "admin"))!.undo).toBeNull();

    await move(applicationId, stages.reviewed!);
    let profile = (await loadProfile(db, applicationId, "admin"))!;
    expect(profile.undo).toMatchObject({ summary: "Moved from Submitted to Reviewed", actorName: TEST_ADMIN_EMAIL });
    expect(profile.undo!.effects[0]).toBe("The application goes back to Submitted.");

    // Contacted changes no state, so the move is still what undo names.
    await transition(db, { action: "contacted", applicationId, actor: staff });
    profile = (await loadProfile(db, applicationId, "admin"))!;
    expect(profile.undo!.summary).toBe("Moved from Submitted to Reviewed");

    const offered = await move(applicationId, stages.conditional_offer!);
    profile = (await loadProfile(db, applicationId, "admin"))!;
    expect(profile.undo!.eventId).toBe(offered.event.id);
    expect(profile.undo!.effects).toContain("The offer this move created is removed.");
  });

  it("voids the change it named and walks back one change at a time", async () => {
    const applicationId = await submitted();
    const reviewed = await move(applicationId, stages.reviewed!);
    const offered = await move(applicationId, stages.conditional_offer!);

    const first = await undoLastChange(db, { applicationId, actor: staff, expectedSeq: offered.application.eventSeq, eventId: offered.event.id });
    expect(first.event).toMatchObject({ kind: "event_voided", voidsEventId: offered.event.id });
    expect(first.application.currentStageId).toBe(stages.reviewed);
    const [row] = await db.select().from(offer).where(eq(offer.id, offered.created.offerId!));
    expect(row!.deletedAt).not.toBeNull();

    const profile = (await loadProfile(db, applicationId, "admin"))!;
    expect(profile.undo!.eventId).toBe(reviewed.event.id);
    expect(profile.events.find((e) => e.id === offered.event.id)!.voided).toBe(true);

    const second = await undoLastChange(db, { applicationId, actor: staff, expectedSeq: first.application.eventSeq, eventId: reviewed.event.id });
    expect(second.application.currentStageId).toBe(stages.submitted);
    expect((await loadProfile(db, applicationId, "admin"))!.undo).toBeNull();
  });

  it("refuses a stale page, an older change, a change that is not a state change and another application's event", async () => {
    const applicationId = await submitted();
    const reviewed = await move(applicationId, stages.reviewed!);
    const contacted = await transition(db, { action: "contacted", applicationId, actor: staff });
    const held = await transition(db, { action: "hold", applicationId, actor: staff });

    await expect(undoLastChange(db, { applicationId, actor: staff, expectedSeq: reviewed.application.eventSeq, eventId: held.event.id })).rejects.toBeInstanceOf(
      StaleVersionError,
    );
    const current = await seqOf(applicationId);
    await expectCode(undoLastChange(db, { applicationId, actor: staff, expectedSeq: current, eventId: reviewed.event.id }), "event_not_latest");
    await expectCode(undoLastChange(db, { applicationId, actor: staff, expectedSeq: current, eventId: contacted.event.id }), "event_not_voidable");

    const other = await submitted();
    await expectCode(undoLastChange(db, { applicationId: other, actor: staff, expectedSeq: await seqOf(other), eventId: held.event.id }), "event_not_found");

    const undone = await undoLastChange(db, { applicationId, actor: staff, expectedSeq: current, eventId: held.event.id });
    expect(undone.application.onHold).toBe(false);
  });

  it("undoing a rescission makes the person hired again with the hire record back", async () => {
    const applicationId = await submitted();
    const hired = await move(applicationId, stages.hired!);
    await rescindHire(db, { applicationId, actor: staff, note: "Changed their mind", to: { status: "open", toStageId: stages.submitted! } });
    const profile = (await loadProfile(db, applicationId, "admin"))!;
    expect(profile.undo).toMatchObject({ summary: "Hire rescinded, back to Submitted" });
    expect(profile.undo!.effects[0]).toBe("The application is hired again and its hire record comes back.");

    const restored = await undoLastChange(db, { applicationId, actor: staff, expectedSeq: profile.application.eventSeq, eventId: profile.undo!.eventId });
    expect(restored.application.status).toBe("hired");
    const [stint] = await db.select().from(hireStint).where(eq(hireStint.id, hired.created.hireStintId!));
    expect(stint!.voidedAt).toBeNull();
  });

  it("describes each kind of change", () => {
    const base = {
      voidsEventId: null,
      toStatus: null,
      closedOutcome: null,
      metadata: null,
      occurredAt: new Date("2026-10-14T15:00:00Z"),
      actorType: "staff" as const,
      fromStage: "Reviewed",
      toStage: "Reviewed",
      reasonLabel: null,
      actorName: "Pat",
    };
    const one = (kind: "closed" | "reopened" | "hold_set" | "hold_cleared" | "hire_rescinded", extra = {}) =>
      undoPreview([
        { ...base, id: "a", seq: 1, kind: "created" },
        { ...base, id: "b", seq: 2, kind, ...extra },
      ]);
    expect(one("closed", { closedOutcome: "disqualified", reasonLabel: "No license" })!.summary).toBe("Closed as Disqualified (No license)");
    expect(one("reopened")!.summary).toBe("Reopened into Reviewed");
    expect(one("hold_set")!.effects[0]).toBe("The hold comes off.");
    expect(one("hold_cleared")!.effects[0]).toBe("The application goes back on hold.");
    expect(one("hire_rescinded", { toStatus: "closed", closedOutcome: "withdrew" })!.summary).toBe("Hire rescinded and closed as Withdrew");
    expect(one("hold_set")!.effects.at(-1)).toBe("The change stays in the stage history, marked voided.");
  });
});
