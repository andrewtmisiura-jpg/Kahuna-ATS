import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { entryCode, entryCodeScanDay, groupSession, opening } from "@/db/schema";
import { LAUNCH_ENTRY_CODES, seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { generateEntryCode, normalizeEntryCode, recordScan, resolveEntryCode } from "@/server/services/entry-codes";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

let snow: SnowFixture;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
});

afterAll(async () => {
  await sql.end();
});

describe("entry codes", () => {
  it("resolves the launch codes to the open snow opening, in any case", async () => {
    const qr = await resolveEntryCode(db, LAUNCH_ENTRY_CODES.snowRoleQr.toLowerCase());
    expect(qr.status).toBe("open");
    if (qr.status !== "open") return;
    expect(qr.opening.id).toBe(snow.openingId);
    expect(qr.role.id).toBe(snow.roleId);
    expect(qr.session).toBeNull();
    expect(qr.entryCode.channel).toBe("role_qr");

    const msg = await resolveEntryCode(db, ` ${LAUNCH_ENTRY_CODES.snowIndeedMessage} `);
    expect(msg.status).toBe("open");
    if (msg.status === "open") expect(msg.entryCode.channel).toBe("indeed_message");
  });

  it("returns not_found for unknown or malformed codes", async () => {
    expect((await resolveEntryCode(db, "ZZZZZZ")).status).toBe("not_found");
    expect((await resolveEntryCode(db, "ILOU11")).status).toBe("not_found");
    expect((await resolveEntryCode(db, "")).status).toBe("not_found");
    expect(normalizeEntryCode("abc123")).toBe("ABC123");
    expect(normalizeEntryCode("ABCDEFGHJ")).toBeNull();
    expect(generateEntryCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  });

  it("falls back to the role page when the code is closed or its opening is not open", async () => {
    await withRollback(db, async (tx) => {
      await tx.update(entryCode).set({ closedAt: new Date() }).where(eq(entryCode.code, LAUNCH_ENTRY_CODES.snowIndeedMessage));
      const closed = await resolveEntryCode(tx, LAUNCH_ENTRY_CODES.snowIndeedMessage);
      expect(closed.status).toBe("closed");
      if (closed.status === "closed") expect(closed.opening?.id).toBe(snow.openingId);
    });

    await withRollback(db, async (tx) => {
      await tx.update(opening).set({ status: "closed" }).where(eq(opening.id, snow.openingId));
      const pinned = await resolveEntryCode(tx, LAUNCH_ENTRY_CODES.snowIndeedMessage);
      expect(pinned.status).toBe("closed");
      if (pinned.status === "closed") expect(pinned.opening).toBeNull();
      const roleQr = await resolveEntryCode(tx, LAUNCH_ENTRY_CODES.snowRoleQr);
      expect(roleQr.status).toBe("closed");
    });
  });

  it("resolves a session code with its session", async () => {
    await withRollback(db, async (tx) => {
      const sessionId = uuidv7();
      await tx.insert(groupSession).values({
        id: sessionId,
        openingId: snow.openingId,
        startsAt: new Date("2026-10-28T23:00:00Z"),
        locationName: "Golden Valley shop",
        status: "scheduled",
        createdBy: await loadAdminId(tx),
      });
      await tx.insert(entryCode).values({
        id: uuidv7(),
        code: "SESS01",
        roleId: snow.roleId,
        openingId: snow.openingId,
        groupSessionId: sessionId,
        channel: "session_qr",
        label: "Oct 28 session",
      });
      const result = await resolveEntryCode(tx, "SESS01");
      expect(result.status).toBe("open");
      if (result.status === "open") expect(result.session?.id).toBe(sessionId);
    });
  });

  it("counts scans per Central day, including the DST night", async () => {
    await withRollback(db, async (tx) => {
      const [code] = await tx.select({ id: entryCode.id }).from(entryCode).where(eq(entryCode.code, LAUNCH_ENTRY_CODES.snowRoleQr));
      const id = code!.id;
      await recordScan(tx, id, new Date("2026-11-01T04:30:00Z")); // Oct 31, 23:30 CDT
      await recordScan(tx, id, new Date("2026-11-01T04:45:00Z")); // Oct 31, 23:45 CDT
      await recordScan(tx, id, new Date("2026-11-01T05:30:00Z")); // Nov 1, 00:30 CDT
      await recordScan(tx, id, new Date("2026-11-02T05:30:00Z")); // Nov 1, 23:30 CST
      const rows = await tx.select().from(entryCodeScanDay).where(eq(entryCodeScanDay.entryCodeId, id));
      const byDay = Object.fromEntries(rows.map((r) => [r.day, r.scans]));
      expect(byDay).toEqual({ "2026-10-31": 2, "2026-11-01": 2 });
    });
  });
});
