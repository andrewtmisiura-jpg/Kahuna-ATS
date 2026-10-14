import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { auditLog, opening } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { ConfigError } from "@/server/services/config/errors";
import { listOpenings, updateOpening, type OpeningPatch } from "@/server/services/config/openings";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

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

async function windowOpening() {
  const [row] = await db.select().from(opening).where(eq(opening.key, "window-2027"));
  return row!;
}

function patchFrom(row: typeof opening.$inferSelect, overrides: Partial<OpeningPatch> = {}): OpeningPatch {
  return {
    status: row.status,
    opensOn: row.opensOn,
    closesOn: row.closesOn,
    seasonStartOn: row.seasonStartOn,
    seasonEndOn: row.seasonEndOn,
    targetHeadcount: row.targetHeadcount,
    payText: row.payText,
    benefitsText: row.benefitsText,
    ...overrides,
  };
}

async function expectConfigError(run: Promise<unknown>, code: ConfigError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof ConfigError && error.code === code);
}

describe("Settings > Openings", () => {
  it("lists openings with their role", async () => {
    const rows = await listOpenings(db);
    expect(rows.map((r) => r.key)).toEqual(["snow-2026-27", "window-2027"]);
    expect(rows[0]!.roleName).toContain("Snow");
    expect(rows[0]!.status).toBe("open");
  });

  it("refuses to open an opening without pay text or an opens-on date", async () => {
    const window = await windowOpening();
    expect(window.payText).toBeNull();
    const actor = staffActor(adminId);
    await expectConfigError(
      updateOpening(db, { actor, id: window.id, patch: patchFrom(window, { status: "open", opensOn: "2027-03-01" }) }),
      "opening_missing_pay_text",
    );
    await expectConfigError(
      updateOpening(db, { actor, id: window.id, patch: patchFrom(window, { status: "open", payText: "$22 an hour", opensOn: null }) }),
      "opening_missing_opens_on",
    );
    const [unchanged] = await db.select().from(opening).where(eq(opening.id, window.id));
    expect(unchanged!.status).toBe("draft");
  });

  it("keeps one open opening per role", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const secondId = uuidv7();
      await tx.insert(opening).values({
        id: secondId,
        roleId: snow.roleId,
        key: "snow-2027-28",
        name: "Snow Removal 2027-28",
        status: "draft",
        opensOn: "2027-10-01",
        payText: "$25 an hour",
      });
      const [second] = await tx.select().from(opening).where(eq(opening.id, secondId));
      await expectConfigError(updateOpening(tx, { actor, id: secondId, patch: patchFrom(second!, { status: "open" }) }), "role_already_open");

      const [first] = await tx.select().from(opening).where(eq(opening.id, snow.openingId));
      await updateOpening(tx, { actor, id: snow.openingId, patch: patchFrom(first!, { status: "closed", closesOn: "2027-04-01" }) });
      const opened = await updateOpening(tx, { actor, id: secondId, patch: patchFrom(second!, { status: "open" }) });
      expect(opened.status).toBe("open");

      const openNow = await tx
        .select({ id: opening.id })
        .from(opening)
        .where(and(eq(opening.roleId, snow.roleId), eq(opening.status, "open")));
      expect(openNow.map((r) => r.id)).toEqual([secondId]);
    });
  });

  it("audits every change with the fields that moved, and nothing when nothing moved", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const window = await windowOpening();
      await updateOpening(tx, {
        actor,
        id: window.id,
        patch: patchFrom(window, { payText: "$22 to $26 an hour", targetHeadcount: 12, seasonStartOn: "2027-04-01", seasonEndOn: "2027-10-31" }),
      });
      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "opening"), eq(auditLog.entityId, window.id)))
        .orderBy(desc(auditLog.occurredAt))
        .limit(1);
      expect(entry).toBeDefined();
      expect(entry!.action).toBe("opening.update");
      expect(entry!.actorUserId).toBe(adminId);
      expect(entry!.changes).toMatchObject({
        payText: { from: null, to: "$22 to $26 an hour" },
        targetHeadcount: { from: null, to: 12 },
        seasonStartOn: { from: null, to: "2027-04-01" },
      });
      expect(entry!.changes).not.toHaveProperty("status");

      const before = await tx.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, window.id));
      const [current] = await tx.select().from(opening).where(eq(opening.id, window.id));
      await updateOpening(tx, { actor, id: window.id, patch: patchFrom(current!) });
      const after = await tx.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, window.id));
      expect(after.length).toBe(before.length);
    });
  });

  it("rejects dates out of order and a negative headcount", async () => {
    const window = await windowOpening();
    const actor = staffActor(adminId);
    await expectConfigError(
      updateOpening(db, { actor, id: window.id, patch: patchFrom(window, { opensOn: "2027-03-01", closesOn: "2027-02-01" }) }),
      "dates_out_of_order",
    );
    await expectConfigError(
      updateOpening(db, { actor, id: window.id, patch: patchFrom(window, { seasonStartOn: "2027-05-01", seasonEndOn: "2027-04-01" }) }),
      "dates_out_of_order",
    );
    await expectConfigError(updateOpening(db, { actor, id: window.id, patch: patchFrom(window, { targetHeadcount: -1 }) }), "invalid_input");
    await expectConfigError(updateOpening(db, { actor, id: uuidv7(), patch: patchFrom(window) }), "not_found");
  });
});
