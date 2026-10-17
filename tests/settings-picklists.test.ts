import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { applicationEvent, assessment, auditLog, hireStint, picklistOption, reviewDecision, star } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { ConfigError } from "@/server/services/config/errors";
import {
  addPicklistOption,
  archivePicklistOption,
  isOptionReferenced,
  listPicklistOptions,
  PICKLISTS,
  unarchivePicklistOption,
  updatePicklistOption,
} from "@/server/services/config/picklists";
import { withRollback } from "./helpers/db";
import {
  createApplication,
  createPerson,
  loadAdminId,
  loadEmployer,
  loadOption,
  loadSnow,
  TEST_ADMIN_EMAIL,
  type SnowFixture,
} from "./helpers/fixtures";
import { createAttendee, createGroupSession } from "./helpers/phase2";

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

async function expectConfigError(run: Promise<unknown>, code: ConfigError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof ConfigError && error.code === code);
}

describe("Settings > Picklists", () => {
  it("covers every seeded list", async () => {
    const options = await listPicklistOptions(db);
    const seededLists = new Set(options.map((o) => o.listKey));
    for (const list of seededLists) expect(PICKLISTS.map((l) => l.key)).toContain(list);
    expect(PICKLISTS.map((l) => l.key)).toContain("crew");
    expect(options.find((o) => o.listKey === "disqualify_reason" && o.key === "failed_ladder_test")?.roleName).toContain("Window");
  });

  it("adds a crew with the next sort order, audited, and refuses a duplicate key", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const first = await addPicklistOption(tx, { actor, listKey: "crew", key: "crew_a", label: "Crew A" });
      const second = await addPicklistOption(tx, { actor, listKey: "crew", key: "crew_b", label: "Crew B" });
      expect(first.employerId).toBe((await loadEmployer(tx)).id);
      expect(first.roleId).toBeNull();
      expect(second.sortOrder).toBe(first.sortOrder + 10);

      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "picklist_option"), eq(auditLog.entityId, first.id)));
      expect(entry!.action).toBe("picklist_option.add");
      expect(entry!.changes).toMatchObject({ key: { from: null, to: "crew_a" }, label: { from: null, to: "Crew A" } });

      await expectConfigError(addPicklistOption(tx, { actor, listKey: "crew", key: "crew_a", label: "Crew A again" }), "picklist_key_exists");
      await expectConfigError(addPicklistOption(tx, { actor, listKey: "crew", key: "Crew A", label: "Bad key" }), "invalid_input");
      await expectConfigError(addPicklistOption(tx, { actor, listKey: "crew", key: "crew_c", label: "C", fcraAdverse: true }), "fcra_only_disqualify");
      await expectConfigError(
        addPicklistOption(tx, { actor, listKey: "crew", key: "crew_c", label: "C", defaultSeparation: "voluntary" }),
        "separation_only_leave",
      );
    });
  });

  it("locks key, list, scope and the FCRA flag once a row references the option, but keeps the label editable", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      // A fresh option: other test files close applications with the seeded reasons and keep the rows.
      const reason = await addPicklistOption(tx, { actor, listKey: "disqualify_reason", key: "no_ladder_experience", label: "No ladder experience" });
      const reasonId = reason.id;
      expect(await isOptionReferenced(tx, reasonId)).toBe(false);

      // Nothing references it yet: the key may still change (and change back).
      const renamed = await updatePicklistOption(tx, { actor, id: reasonId, patch: { key: "no_ladder_experience_v2" } });
      expect(renamed.key).toBe("no_ladder_experience_v2");
      await updatePicklistOption(tx, { actor, id: reasonId, patch: { key: "no_ladder_experience" } });

      // A closed event names the reason, which locks it.
      const personId = await createPerson(tx);
      const { applicationId } = await createApplication(tx, snow, personId);
      await tx.insert(applicationEvent).values({
        id: uuidv7(),
        applicationId,
        seq: 2,
        kind: "closed",
        fromStatus: "open",
        toStatus: "closed",
        closedOutcome: "disqualified",
        reasonOptionId: reasonId,
        actorType: "staff",
        actorUserId: adminId,
        occurredAt: new Date(),
      });
      expect(await isOptionReferenced(tx, reasonId)).toBe(true);

      await expectConfigError(updatePicklistOption(tx, { actor, id: reasonId, patch: { key: "ladder" } }), "picklist_locked");
      await expectConfigError(updatePicklistOption(tx, { actor, id: reasonId, patch: { fcraAdverse: true } }), "picklist_locked");
      await expectConfigError(updatePicklistOption(tx, { actor, id: reasonId, patch: { listKey: "withdraw_reason" } }), "picklist_locked");
      await expectConfigError(updatePicklistOption(tx, { actor, id: reasonId, patch: { roleId: snow.roleId } }), "picklist_locked");

      const relabeled = await updatePicklistOption(tx, { actor, id: reasonId, patch: { label: "No ladder experience yet", requiresNote: true } });
      expect(relabeled.label).toBe("No ladder experience yet");
      expect(relabeled.requiresNote).toBe(true);
      expect(relabeled.key).toBe("no_ladder_experience");

      // The same patch with the locked values unchanged is fine.
      const same = await updatePicklistOption(tx, { actor, id: reasonId, patch: { key: "no_ladder_experience", fcraAdverse: false, label: "Ladders" } });
      expect(same.label).toBe("Ladders");
    });
  });

  it("treats a crew on a hire stint as a reference", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const crew = await addPicklistOption(tx, { actor, listKey: "crew", key: "north", label: "North" });
      const personId = await createPerson(tx);
      await tx.insert(hireStint).values({
        id: uuidv7(),
        personId,
        origin: "external",
        employerId: (await loadEmployer(tx)).id,
        roleId: snow.roleId,
        crewOptionId: crew.id,
      });
      expect(await isOptionReferenced(tx, crew.id)).toBe(true);
      await expectConfigError(updatePicklistOption(tx, { actor, id: crew.id, patch: { key: "north_crew" } }), "picklist_locked");
      expect((await updatePicklistOption(tx, { actor, id: crew.id, patch: { label: "North crew" } })).label).toBe("North crew");
    });
  });

  it("treats a star, a test result and a review decision as references", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const starReason = await addPicklistOption(tx, { actor, listKey: "star_reason", key: "helped_others", label: "Helped others" });
      const attendeeId = await createAttendee(tx, await createGroupSession(tx, snow.openingId, adminId));
      await tx.insert(star).values({ id: uuidv7(), attendeeId, userId: adminId, mark: "star", reasonOptionId: starReason.id });

      const testType = await addPicklistOption(tx, { actor, listKey: "assessment_type", key: "shovel_test", label: "Shovel test", roleId: snow.roleId });
      const tested = await createApplication(tx, snow, await createPerson(tx));
      await tx.insert(assessment).values({
        id: uuidv7(),
        applicationId: tested.applicationId,
        assessmentTypeOptionId: testType.id,
        result: "pass",
        administeredBy: adminId,
        administeredOn: "2026-10-16",
      });

      // A decision row alone locks the reason, though no event names it.
      const decline = await addPicklistOption(tx, { actor, listKey: "disqualify_reason", key: "no_show_ride_along", label: "No-show to the ride-along" });
      await tx.insert(reviewDecision).values({
        id: uuidv7(),
        applicationId: tested.applicationId,
        decision: "decline",
        reasonOptionId: decline.id,
        aiScoreVisible: false,
        decidedBy: adminId,
        decidedAt: new Date(),
      });

      for (const option of [starReason, testType, decline]) {
        expect(await isOptionReferenced(tx, option.id), option.key).toBe(true);
        await expectConfigError(updatePicklistOption(tx, { actor, id: option.id, patch: { key: `${option.key}_v2` } }), "picklist_locked");
      }
    });
  });

  it("archives and unarchives with an audit row each", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const id = await loadOption(tx, "withdraw_reason", "pay");
      const archived = await archivePicklistOption(tx, { actor, id });
      expect(archived.archivedAt).not.toBeNull();
      const back = await unarchivePicklistOption(tx, { actor, id });
      expect(back.archivedAt).toBeNull();
      const entries = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "picklist_option"), eq(auditLog.entityId, id)));
      expect(entries.map((e) => e.action).sort()).toEqual(["picklist_option.archive", "picklist_option.unarchive"]);
      const [row] = await tx.select().from(picklistOption).where(eq(picklistOption.id, id));
      expect(row!.key).toBe("pay");
    });
  });
});
