import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { auditLog, legalTextVersion } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { createApplication } from "@/server/services/applications/transition";
import { ConfigError } from "@/server/services/config/errors";
import { currentLegalText } from "@/server/services/legal";
import {
  aiDisclosureForApplication,
  aiDisclosureLiveAt,
  isCurrentAiDisclosure,
  loadAiDisclosures,
  publishAiDisclosure,
} from "@/server/services/scoring/disclosure";
import { withRollback } from "./helpers/db";
import { createPerson, loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// The AI notice on the landing page (scoring/disclosure.ts): an Admin publishes a new
// version with a note, the landing page shows the newest at once, and each application
// is tied to the version that was live when it started. Published legal text never
// changes, so each case runs in a rolled-back transaction and the shared database keeps v1.

let adminId: string;
let snow: SnowFixture;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
  snow = await loadSnow(db);
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const NEW_WORDING = "We use software, including AI tools, to help sort and summarize applications. A person reviews every application and makes every decision.";

async function applyAt(tx: Tx, at: Date, origin: "landing" | "staff_created" = "landing") {
  const personId = await createPerson(tx);
  const { applicationId } = await createApplication(tx, {
    personId,
    openingId: snow.openingId,
    origin,
    entryChannel: origin === "landing" ? "role_qr" : "staff_entered",
    actor: origin === "landing" ? { type: "applicant" } : staffActor(adminId),
    occurredAt: at,
    now: at,
  });
  return applicationId;
}

describe("the AI notice", () => {
  it("publishes a new version with a note, audited, and the newest is the one shown", async () => {
    await withRollback(db, async (tx) => {
      const v1 = (await currentLegalText(tx, "ai_disclosure"))!;
      const published = await publishAiDisclosure(tx, { body: `  ${NEW_WORDING}  `, changeNote: " Owner approved clearer wording ", actor: staffActor(adminId) });
      expect(published.version).toBe(v1.version + 1);

      const current = (await currentLegalText(tx, "ai_disclosure"))!;
      expect(current).toMatchObject({ id: published.id, body: NEW_WORDING, changeNote: "Owner approved clearer wording", publishedBy: adminId });
      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.action, "legal_text.publish"), eq(auditLog.entityId, published.id)));
      expect(entry!.changes).toMatchObject({ kind: "ai_disclosure", superseded_version_id: v1.id, change_note: "Owner approved clearer wording" });

      const overview = await loadAiDisclosures(tx);
      expect(overview.current).toMatchObject({ id: published.id, version: published.version, replacedAt: null, publishedBy: TEST_ADMIN_EMAIL });
      expect(overview.versions.map((v) => v.version)).toEqual([published.version, v1.version]);
      expect(overview.versions[1]!.replacedAt).toEqual(current.publishedAt);

      // The old version stays as it was: applications that saw it still point at it.
      const [old] = await tx.select().from(legalTextVersion).where(eq(legalTextVersion.id, v1.id));
      expect(old!.body).toBe(v1.body);
    });
  });

  it("refuses a blank notice, a missing note and the wording already live", async () => {
    await withRollback(db, async (tx) => {
      const actor = staffActor(adminId);
      const current = (await currentLegalText(tx, "ai_disclosure"))!;
      await expect(publishAiDisclosure(tx, { body: "  ", changeNote: "Note", actor })).rejects.toBeInstanceOf(ConfigError);
      await expect(publishAiDisclosure(tx, { body: NEW_WORDING, changeNote: " ", actor })).rejects.toBeInstanceOf(ConfigError);
      await expect(publishAiDisclosure(tx, { body: "x".repeat(1001), changeNote: "Too long", actor })).rejects.toBeInstanceOf(ConfigError);
      await expect(publishAiDisclosure(tx, { body: ` ${current.body} `, changeNote: "Same again", actor })).rejects.toThrow(/applicants see now/);
      expect((await currentLegalText(tx, "ai_disclosure"))!.id).toBe(current.id);
    });
  });

  it("ties each landing application to the version live when it started", async () => {
    await withRollback(db, async (tx) => {
      const v1 = (await currentLegalText(tx, "ai_disclosure"))!;
      const base = Date.now();
      const before = await applyAt(tx, new Date(base + 60_000));
      const v2 = await publishAiDisclosure(tx, { body: NEW_WORDING, changeNote: "Clearer", actor: staffActor(adminId), now: new Date(base + 120_000) });
      // Other files date some applications ahead, so count what this case adds.
      const startedUnderV2 = async () => (await loadAiDisclosures(tx)).current!.applicationsStarted;
      const counted = await startedUnderV2();
      const after = await applyAt(tx, new Date(base + 180_000));
      const byStaff = await applyAt(tx, new Date(base + 180_000), "staff_created");
      expect(await startedUnderV2()).toBe(counted + 1);

      expect((await aiDisclosureForApplication(tx, before))?.id).toBe(v1.id);
      expect((await aiDisclosureForApplication(tx, after))?.id).toBe(v2.id);
      // Staff-entered applications never saw a landing page.
      expect(await aiDisclosureForApplication(tx, byStaff)).toBeNull();
      expect(await aiDisclosureForApplication(tx, uuidv7())).toBeNull();

      expect((await aiDisclosureLiveAt(tx, new Date(base + 119_999)))?.id).toBe(v1.id);
      expect((await aiDisclosureLiveAt(tx, new Date(base + 120_000)))?.id).toBe(v2.id);
      expect(await aiDisclosureLiveAt(tx, new Date("2020-01-01T00:00:00Z"))).toBeNull();
      expect((await loadAiDisclosures(tx)).versions[1]!.applicationsStarted).toBeGreaterThanOrEqual(1);
    });
  });

  it("lets the landing form through only when its page showed the current version", async () => {
    await withRollback(db, async (tx) => {
      const v1 = (await currentLegalText(tx, "ai_disclosure"))!;
      expect(await isCurrentAiDisclosure(tx, v1.id)).toBe(true);
      const v2 = await publishAiDisclosure(tx, { body: NEW_WORDING, changeNote: "Clearer", actor: staffActor(adminId) });
      // A page loaded before the publish shows v1 and is sent back to reload.
      expect(await isCurrentAiDisclosure(tx, v1.id)).toBe(false);
      expect(await isCurrentAiDisclosure(tx, v2.id)).toBe(true);
      expect(await isCurrentAiDisclosure(tx, null)).toBe(false);
      expect(await isCurrentAiDisclosure(tx, uuidv7())).toBe(false);
    });
  });
});
