import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, sql } from "@/db";
import { application, applicationEvent } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import type { AfterTransitionContext } from "@/server/services/applications/after-transition";
import { createApplication, transition } from "@/server/services/applications/transition";
import { createPerson, loadAdminId, loadOption, loadSnow, loadStages, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// The Phase 2 slot in the transition function (applications/after-transition.ts): each
// area's function runs once per event, in order, inside the transition's transaction,
// with the context below, and a throw rolls the event back. The three area functions
// are wrapped to record what they were given, then run as they are.

const { recorded, wrap } = vi.hoisted(() => {
  const recorded = { calls: [] as { area: string; context: unknown }[], failing: null as string | null };
  function wrap<A extends [unknown, unknown], R>(area: string, run: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      recorded.calls.push({ area, context: args[1] });
      if (recorded.failing === area) throw new Error(`${area} broke on purpose`);
      return run(...args);
    };
  }
  return { recorded, wrap };
});

vi.mock("@/server/services/scoring/after-transition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/scoring/after-transition")>();
  return { ...actual, scoringAfterTransition: wrap("scoring", actual.scoringAfterTransition) };
});
vi.mock("@/server/services/messaging/after-transition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/messaging/after-transition")>();
  return { ...actual, messagesAfterTransition: wrap("messaging", actual.messagesAfterTransition) };
});
vi.mock("@/server/services/interviews/after-transition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/interviews/after-transition")>();
  return { ...actual, interviewsAfterTransition: wrap("interviews", actual.interviewsAfterTransition) };
});

let snow: SnowFixture;
let stages: Record<string, string>;
let staff: { type: "staff"; userId: string };

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  staff = { type: "staff", userId: await loadAdminId(db) };
});

afterAll(async () => {
  await sql.end();
});

async function newApplication() {
  const personId = await createPerson(db);
  const { applicationId } = await createApplication(db, { personId, openingId: snow.openingId, origin: "landing", entryChannel: "role_qr", actor: { type: "applicant" } });
  return applicationId;
}

function lastContexts() {
  const calls = recorded.calls.splice(0);
  return { areas: calls.map((c) => c.area), context: calls[0]?.context as AfterTransitionContext };
}

describe("afterTransition", () => {
  it("runs scoring, messaging and interviews once per event, with the event, both states and both stages", async () => {
    const applicationId = await newApplication();
    recorded.calls.length = 0;

    await transition(db, { action: "submit", applicationId, actor: { type: "applicant" } });
    const submitted = lastContexts();
    expect(submitted.areas).toEqual(["scoring", "messaging", "interviews"]);
    expect(submitted.context.event.kind).toBe("submitted");
    expect(submitted.context.fromStage.key).toBe("started");
    expect(submitted.context.toStage?.key).toBe("submitted");
    expect(submitted.context.earlierEvents.map((e) => e.kind)).toEqual(["created"]);

    await transition(db, { action: "move", applicationId, toStageId: stages.one_on_one_invited!, actor: staff, expectedSeq: 2 });
    const moved = lastContexts();
    expect(moved.areas).toEqual(["scoring", "messaging", "interviews"]);
    expect(moved.context.input).toMatchObject({ action: "move", toStageId: stages.one_on_one_invited });
    expect(moved.context.event).toMatchObject({ kind: "stage_changed", seq: 3, actorUserId: staff.userId });
    expect(moved.context.before.eventSeq).toBe(2);
    expect(moved.context.after).toMatchObject({ eventSeq: 3, currentStageId: stages.one_on_one_invited });
    expect(moved.context.toStage).toMatchObject({ key: "one_on_one_invited", milestone: "interview_invited" });
    expect(moved.context.earlierEvents.map((e) => e.kind)).toEqual(["created", "submitted"]);

    await transition(db, { action: "hold", applicationId, actor: staff });
    expect(lastContexts().context).toMatchObject({ event: { kind: "hold_set" }, toStage: null });

    const reasonOptionId = await loadOption(db, "withdraw_reason", "took_another_job");
    await transition(db, { action: "close", applicationId, actor: staff, outcome: "withdrew", reasonOptionId });
    expect(lastContexts().context).toMatchObject({ event: { kind: "closed", closedOutcome: "withdrew" }, after: { status: "closed" }, toStage: null });
  });

  it("rolls the whole transition back when an area throws", async () => {
    const applicationId = await newApplication();
    recorded.failing = "messaging";
    try {
      await expect(transition(db, { action: "submit", applicationId, actor: { type: "applicant" } })).rejects.toThrow("messaging broke on purpose");
    } finally {
      recorded.failing = null;
    }
    const [row] = await db.select().from(application).where(eq(application.id, applicationId));
    expect(row).toMatchObject({ eventSeq: 1, submittedAt: null, currentStageId: stages.started });
    const events = await db.select().from(applicationEvent).where(eq(applicationEvent.applicationId, applicationId));
    expect(events.map((e) => e.kind)).toEqual(["created"]);
  });
});
