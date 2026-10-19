import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql, type Db } from "@/db";
import { CHANGES, runChanges } from "@/db/changes";
import { LEGAL_NAME, LEGAL_NAME_CHANGE_NOTE, LEGAL_NAME_PLACEHOLDER, legalName } from "@/db/changes/legal-name";
import { snowNoOneOnOne } from "@/db/changes/snow-no-one-on-one";
import { application, auditLog, employer, pipelineStage, role } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { staffActor } from "@/server/services/actor";
import { transition } from "@/server/services/applications/transition";
import { rolesWaitingOnBookingLink } from "@/server/services/config/openings";
import { currentLegalText, publishLegalText } from "@/server/services/legal";
import { withRollback } from "./helpers/db";
import { loadAdminId, loadSnow, loadStages, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { newApplication } from "./helpers/interviews";

// The Oct 19 follow-ups: the owner's legal name, and no one-on-ones for snow, plus
// the Settings > Openings reminder that waits on the booking link for spring. Every
// case runs inside a rolled-back transaction.

let snow: SnowFixture;
let snowStages: Record<string, string>;
let actor: ReturnType<typeof staffActor>;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  snowStages = await loadStages(db, snow.roleId);
  actor = staffActor(await loadAdminId(db));
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function theEmployer(conn: Db) {
  const [row] = await conn.select().from(employer).where(isNull(employer.archivedAt)).limit(1);
  return row!;
}

async function windowRoleId(tx: Tx) {
  const [row] = await tx.select({ id: role.id }).from(role).where(eq(role.key, "window_cleaning_tech"));
  return row!.id;
}

async function liveOneOnOneStages(tx: Tx, roleId: string) {
  return tx
    .select({ key: pipelineStage.key })
    .from(pipelineStage)
    .where(
      and(eq(pipelineStage.roleId, roleId), isNull(pipelineStage.archivedAt), inArray(pipelineStage.milestone, ["interview_invited", "interviewed"])),
    );
}

// Other test files leave open snow applications in the one-on-one stages; move them
// back to Reviewed (inside the rollback) so each case starts from empty stages.
async function emptySnowOneOnOneStages(tx: Tx) {
  const stuck = await tx
    .select({ id: application.id })
    .from(application)
    .where(
      and(
        inArray(application.currentStageId, [snowStages.one_on_one_invited!, snowStages.one_on_one_done!]),
        eq(application.status, "open"),
        isNull(application.deletedAt),
      ),
    );
  for (const row of stuck) await transition(tx, { action: "move", applicationId: row.id, actor, toStageId: snowStages.reviewed! });
}

describe("the change list", () => {
  it("runs the two Oct 19 changes after the Phase 2 ones", () => {
    expect(CHANGES.slice(3).map((c) => c.id)).toEqual(["2026-10-19-legal-name", "2026-10-19-snow-no-one-on-one"]);
  });
});

describe("the legal name change", () => {
  it("fills in a DRAFT employer name and republishes each live text that still shows the placeholder, changing nothing else", async () => {
    await withRollback(db, async (tx) => {
      const emp = await theEmployer(tx);
      await tx.update(employer).set({ legalName: "DRAFT: confirm the legal name" }).where(eq(employer.id, emp.id));
      const draftBody = `Kahuna Window Cleaning is the business name of ${LEGAL_NAME_PLACEHOLDER}, in Minnesota.\n\nEffective: [OWNER INPUT: effective date]`;
      const before = await publishLegalText(tx, { kind: "privacy_policy", body: draftBody, actor });
      await publishLegalText(tx, { kind: "sms_terms", body: `Who sends it: Kahuna Window Cleaning (${LEGAL_NAME_PLACEHOLDER})`, actor });
      const optInBefore = await currentLegalText(tx, "opt_in_page");

      expect(await runChanges(tx, [legalName])).toEqual({ applied: ["2026-10-19-legal-name"], skipped: [] });

      expect((await theEmployer(tx)).legalName).toBe(LEGAL_NAME);
      const privacy = (await currentLegalText(tx, "privacy_policy"))!;
      expect(privacy.version).toBe(before.version + 1);
      expect(privacy.body).toBe(
        `Kahuna Window Cleaning is the business name of ${LEGAL_NAME}, in Minnesota.\n\nEffective: [OWNER INPUT: effective date]`,
      );
      expect(privacy.changeNote).toBe(LEGAL_NAME_CHANGE_NOTE);
      expect((await currentLegalText(tx, "sms_terms"))!.body).toBe(`Who sends it: Kahuna Window Cleaning (${LEGAL_NAME})`);
      // The seeded opt-in page already carries the name from content/legal, so it is left as is.
      expect((await currentLegalText(tx, "opt_in_page"))?.id).toBe(optInBefore?.id);

      const audits = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "employer"), eq(auditLog.entityId, emp.id), eq(auditLog.action, "employer.legal_name_update")));
      expect(audits).toHaveLength(1);
    });
  });

  it("leaves a legal name someone already set, and does nothing on a second run", async () => {
    await withRollback(db, async (tx) => {
      const emp = await theEmployer(tx);
      await tx.update(employer).set({ legalName: "Someone Else, LLC" }).where(eq(employer.id, emp.id));
      const privacyBefore = await currentLegalText(tx, "privacy_policy");
      const ctx = { actor, actorEmail: TEST_ADMIN_EMAIL, log: () => {} };

      await legalName.run(tx, ctx);
      await legalName.run(tx, ctx);

      expect((await theEmployer(tx)).legalName).toBe("Someone Else, LLC");
      expect((await currentLegalText(tx, "privacy_policy"))?.id).toBe(privacyBefore?.id);
    });
  });

  it("seeds a fresh database with the legal name and no placeholder for it", async () => {
    expect((await theEmployer(db)).legalName).toBe(LEGAL_NAME);
    for (const kind of ["privacy_policy", "sms_terms"] as const) {
      const text = await currentLegalText(db, kind);
      expect(text?.body).toContain(LEGAL_NAME);
      expect(text?.body).not.toContain(LEGAL_NAME_PLACEHOLDER);
    }
  });
});

describe("the snow no one-on-one change", () => {
  it("archives snow's one-on-one stages through the stage service and leaves window cleaning alone", async () => {
    await withRollback(db, async (tx) => {
      await emptySnowOneOnOneStages(tx);
      const windowId = await windowRoleId(tx);
      const windowBefore = await liveOneOnOneStages(tx, windowId);
      expect((await liveOneOnOneStages(tx, snow.roleId)).length).toBeGreaterThan(0);

      await runChanges(tx, [snowNoOneOnOne]);

      expect(await liveOneOnOneStages(tx, snow.roleId)).toEqual([]);
      expect(await liveOneOnOneStages(tx, windowId)).toEqual(windowBefore);
      const archived = await tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "pipeline_stage"), eq(auditLog.action, "pipeline_stage.archive")))
        .orderBy(desc(auditLog.occurredAt));
      expect(archived.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("keeps a stage that still holds an open application and archives the rest", async () => {
    await withRollback(db, async (tx) => {
      await emptySnowOneOnOneStages(tx);
      const invited = snowStages.one_on_one_invited!;
      const { applicationId } = await newApplication(tx, snow);
      await transition(tx, { action: "move", applicationId, actor, toStageId: invited });
      const lines: string[] = [];

      await snowNoOneOnOne.run(tx, { actor, actorEmail: TEST_ADMIN_EMAIL, log: (line) => lines.push(line) });

      expect((await liveOneOnOneStages(tx, snow.roleId)).map((s) => s.key)).toEqual(["one_on_one_invited"]);
      expect(lines.some((line) => line.includes("kept") && line.includes("1 open application"))).toBe(true);
    });
  });
});

describe("the booking link reminder on Settings > Openings", () => {
  it("names the roles with one-on-one stages and a draft or open opening while no booking link is set", async () => {
    await withRollback(db, async (tx) => {
      await emptySnowOneOnOneStages(tx);
      const emp = await theEmployer(tx);
      await tx.update(employer).set({ bookingLinkUrl: null }).where(eq(employer.id, emp.id));
      const windowId = await windowRoleId(tx);
      expect((await rolesWaitingOnBookingLink(tx)).map((r) => r.roleId).sort()).toEqual([snow.roleId, windowId].sort());

      await runChanges(tx, [snowNoOneOnOne]);
      expect((await rolesWaitingOnBookingLink(tx)).map((r) => r.roleId)).toEqual([windowId]);

      await tx.update(employer).set({ bookingLinkUrl: "https://calendly.com/kahuna/interview" }).where(eq(employer.id, emp.id));
      expect(await rolesWaitingOnBookingLink(tx)).toEqual([]);
    });
  });
});
