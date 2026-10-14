import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { auditLog, resumeToken } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { diffChanges, writeAudit } from "@/server/services/audit";
import {
  linkPlaceholder,
  mintResumeToken,
  resumeLink,
  revokeApplicationTokens,
  TOKEN_TTL_DAYS,
  verifyResumeToken,
} from "@/server/services/tokens";
import { createApplication, createPerson, loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

let snow: SnowFixture;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
});

afterAll(async () => {
  await sql.end();
});

async function newApplicationId() {
  const personId = await createPerson(db);
  return (await createApplication(db, snow, personId)).applicationId;
}

describe("resume tokens", () => {
  it("mints 128 random bits, stores only the hash and formats the link", async () => {
    const applicationId = await newApplicationId();
    const minted = await mintResumeToken(db, { applicationId, issuedVia: "message" });
    expect(Buffer.from(minted.token, "base64url")).toHaveLength(16);
    const [row] = await db.select().from(resumeToken).where(eq(resumeToken.id, minted.tokenId));
    expect(Buffer.from(row!.tokenHash)).toEqual(createHash("sha256").update(minted.token).digest());
    expect(JSON.stringify(row)).not.toContain(minted.token);
    expect(resumeLink("tidepool.kahunawindowcleaning.com", minted.token)).toBe(
      `https://tidepool.kahunawindowcleaning.com/r#${minted.token}`,
    );
    expect(linkPlaceholder(minted.tokenId)).toBe(`{link:${minted.tokenId}}`);
  });

  it("verifies a token, slides its expiry 30 days from last use and rejects garbage", async () => {
    const applicationId = await newApplicationId();
    const mintedAt = new Date("2026-10-23T15:00:00Z");
    const minted = await mintResumeToken(db, { applicationId, issuedVia: "landing_cookie", now: mintedAt });
    expect(minted.expiresAt.getTime()).toBe(mintedAt.getTime() + TOKEN_TTL_DAYS * 86_400_000);

    const usedAt = new Date("2026-11-10T15:00:00Z");
    const verified = await verifyResumeToken(db, minted.token, usedAt);
    expect(verified?.applicationId).toBe(applicationId);
    expect(verified?.expiresAt.getTime()).toBe(usedAt.getTime() + TOKEN_TTL_DAYS * 86_400_000);
    const [row] = await db.select().from(resumeToken).where(eq(resumeToken.id, minted.tokenId));
    expect(row!.lastUsedAt).toEqual(usedAt);

    expect(await verifyResumeToken(db, `${minted.token.slice(0, -1)}x`, usedAt)).toBeNull();
    expect(await verifyResumeToken(db, "", usedAt)).toBeNull();
  });

  it("expires after 30 days without use", async () => {
    const applicationId = await newApplicationId();
    const mintedAt = new Date("2026-10-23T15:00:00Z");
    const minted = await mintResumeToken(db, { applicationId, issuedVia: "message", now: mintedAt });
    const dayBefore = new Date("2026-11-22T14:59:00Z");
    expect(await verifyResumeToken(db, minted.token, dayBefore)).not.toBeNull();
    // That use slid the expiry, so the original deadline no longer applies.
    const original = new Date("2026-11-22T15:00:00Z");
    expect(await verifyResumeToken(db, minted.token, original)).not.toBeNull();
    const untouched = await mintResumeToken(db, { applicationId, issuedVia: "message", now: mintedAt });
    expect(await verifyResumeToken(db, untouched.token, original)).toBeNull();
  });

  it("revokes every live token of an application", async () => {
    const applicationId = await newApplicationId();
    const a = await mintResumeToken(db, { applicationId, issuedVia: "message" });
    const b = await mintResumeToken(db, { applicationId, issuedVia: "staff_reissue" });
    const other = await mintResumeToken(db, { applicationId: await newApplicationId(), issuedVia: "message" });
    const adminId = await loadAdminId(db);
    expect(await revokeApplicationTokens(db, { applicationId, revokedBy: adminId })).toBe(2);
    expect(await verifyResumeToken(db, a.token)).toBeNull();
    expect(await verifyResumeToken(db, b.token)).toBeNull();
    expect(await verifyResumeToken(db, other.token)).not.toBeNull();
    expect(await revokeApplicationTokens(db, { applicationId, revokedBy: adminId })).toBe(0);
  });
});

describe("audit helper", () => {
  it("writes a row and records PII fields as [changed]", async () => {
    const adminId = await loadAdminId(db);
    const personId = await createPerson(db);
    const changes = diffChanges(
      { email: "a@example.test", mobileE164: "+16125550100", sharedMobile: false, note: "x" },
      { email: "b@example.test", mobileE164: "+16125550100", sharedMobile: true, note: "x" },
      ["email", "mobileE164", "sharedMobile", "note"],
      ["email", "mobileE164"],
    );
    expect(changes).toEqual({
      email: { from: "[changed]", to: "[changed]" },
      sharedMobile: { from: false, to: true },
    });
    const id = await writeAudit(db, {
      actor: { type: "staff", userId: adminId },
      action: "person.update",
      entityType: "person",
      entityId: personId,
      personId,
      changes,
    });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, id));
    expect(row!.actorType).toBe("staff");
    expect(row!.actorUserId).toBe(adminId);
    expect(row!.changes).toEqual(changes);
    expect(JSON.stringify(row)).not.toContain("example.test");
  });
});
