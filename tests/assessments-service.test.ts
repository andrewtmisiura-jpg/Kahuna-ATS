import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { assessment, auditLog, picklistOption } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { AssessmentError, listAssessments, listAssessmentTypes, recordAssessment, voidAssessment } from "@/server/services/assessments/assessments";
import { CHANGED } from "@/server/services/audit";
import { loadInterviewsPanel } from "@/server/services/interviews/panel";
import { expectPgError, PG, withRollback } from "./helpers/db";
import { loadAdminId, loadOption, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { loadWindow, newApplication, type WindowFixture } from "./helpers/interviews";

let snow: SnowFixture;
let windowRole: WindowFixture;
let adminId: string;
let ladderTestId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  windowRole = await loadWindow(db);
  adminId = await loadAdminId(db);
  ladderTestId = await loadOption(db, "assessment_type", "ladder_test");
});

afterAll(async () => {
  await sql.end();
});

async function expectAssessmentError(run: Promise<unknown>, code: AssessmentError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof AssessmentError && error.code === code);
}

const NOW = new Date("2026-10-30T17:00:00Z");

describe("the ladder test", () => {
  it("is offered on window applications and not on snow ones", async () => {
    expect((await listAssessmentTypes(db, windowRole.roleId)).map((t) => t.key)).toEqual(["ladder_test"]);
    expect(await listAssessmentTypes(db, snow.roleId)).toEqual([]);
    const { applicationId } = await newApplication(db, snow);
    const panel = await loadInterviewsPanel(db, applicationId, "admin");
    expect(panel!.tests).toEqual([]);
  });

  it("records a pass given by the current user on a Central date, audited with the note as [changed]", async () => {
    await withRollback(db, async (tx) => {
      const { applicationId, personId } = await newApplication(tx, windowRole);
      const { assessmentId } = await recordAssessment(tx, {
        applicationId,
        userId: adminId,
        role: "hiring_manager",
        assessmentTypeOptionId: ladderTestId,
        result: "pass",
        administeredOn: "2026-10-30",
        note: "  Set the 28 foot ladder alone.  ",
        now: NOW,
      });
      const [row] = await tx.select().from(assessment).where(eq(assessment.id, assessmentId));
      expect(row).toMatchObject({ result: "pass", administeredBy: adminId, administeredOn: "2026-10-30", note: "Set the 28 foot ladder alone.", voidedAt: null });

      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "assessment"), eq(auditLog.entityId, assessmentId)));
      expect(entry).toMatchObject({ action: "assessment.record", applicationId, personId, actorUserId: adminId });
      expect(entry!.changes).toMatchObject({ type: { to: "ladder_test" }, result: { to: "pass" }, note: { from: null, to: CHANGED } });
      expect(JSON.stringify(entry!.changes)).not.toContain("28 foot");
    });
  });

  it("keeps one live result per test: a second one is refused until the first is voided, then recorded again", async () => {
    await withRollback(db, async (tx) => {
      const { applicationId } = await newApplication(tx, windowRole);
      const base = { applicationId, userId: adminId, role: "admin" as const, assessmentTypeOptionId: ladderTestId, administeredOn: "2026-10-29", now: NOW };
      const first = await recordAssessment(tx, { ...base, result: "fail" });
      await expectAssessmentError(recordAssessment(tx, { ...base, result: "pass" }), "already_recorded");
      // The partial unique backs the service: a second live row is refused by the database too.
      await expectPgError(
        tx.transaction(async (sp) => {
          await sp.insert(assessment).values({
            id: uuidv7(),
            applicationId,
            assessmentTypeOptionId: ladderTestId,
            result: "pass",
            administeredBy: adminId,
            administeredOn: "2026-10-30",
          });
        }),
        PG.uniqueViolation,
      );

      await voidAssessment(tx, { assessmentId: first.assessmentId, userId: adminId, role: "hiring_manager", now: NOW });
      await expectAssessmentError(voidAssessment(tx, { assessmentId: first.assessmentId, userId: adminId, role: "admin" }), "already_voided");
      const second = await recordAssessment(tx, { ...base, result: "pass", administeredOn: "2026-10-30" });

      const results = await listAssessments(tx, applicationId, "admin");
      expect(results.map((r) => [r.id, r.result, r.voidedAt === null])).toEqual([
        [second.assessmentId, "pass", true],
        [first.assessmentId, "fail", false],
      ]);
      const audits = await tx.select().from(auditLog).where(eq(auditLog.applicationId, applicationId)).orderBy(asc(auditLog.occurredAt), asc(auditLog.id));
      expect(audits.map((a) => a.action)).toEqual(["assessment.record", "assessment.void", "assessment.record"]);

      const panel = await loadInterviewsPanel(tx, applicationId, "hiring_manager");
      expect(panel!.tests).toHaveLength(1);
      expect(panel!.tests[0]).toMatchObject({ type: { key: "ladder_test", label: "Ladder test" }, live: { id: second.assessmentId, result: "pass" } });
      expect(panel!.tests[0]!.voided.map((r) => r.id)).toEqual([first.assessmentId]);
    });
  });

  it("names the Close reason on a fail and never closes the application", async () => {
    await withRollback(db, async (tx) => {
      const { applicationId } = await newApplication(tx, windowRole);
      await recordAssessment(tx, { applicationId, userId: adminId, role: "admin", assessmentTypeOptionId: ladderTestId, result: "fail", administeredOn: "2026-10-30", now: NOW });
      const panel = await loadInterviewsPanel(tx, applicationId, "admin");
      expect(panel!.application.status).toBe("open");
      expect(panel!.tests[0]!.live!.result).toBe("fail");
      expect(panel!.reasons.failedTest).toBe("Did not pass the ladder test");
    });
  });

  it("never shows the restricted note to a Viewer", async () => {
    await withRollback(db, async (tx) => {
      const { applicationId } = await newApplication(tx, windowRole);
      await recordAssessment(tx, {
        applicationId,
        userId: adminId,
        role: "admin",
        assessmentTypeOptionId: ladderTestId,
        result: "did_not_attempt",
        administeredOn: "2026-10-30",
        note: "Said they would rather not climb today",
        now: NOW,
      });
      expect((await listAssessments(tx, applicationId, "admin"))[0]!.note).toBe("Said they would rather not climb today");
      expect((await listAssessments(tx, applicationId, "hiring_manager"))[0]!.note).toBe("Said they would rather not climb today");
      expect((await listAssessments(tx, applicationId, "viewer"))[0]!.note).toBeNull();
      const panel = await loadInterviewsPanel(tx, applicationId, "viewer");
      expect(panel!.tests[0]!.live).toMatchObject({ result: "did_not_attempt", note: null });
      expect(JSON.stringify(panel)).not.toContain("rather not climb");
    });
  });

  it("refuses Viewers, a test the role does not use, an archived test, a future date and a long note", async () => {
    await withRollback(db, async (tx) => {
      const { applicationId } = await newApplication(tx, windowRole);
      const base = { applicationId, userId: adminId, role: "admin" as const, assessmentTypeOptionId: ladderTestId, result: "pass" as const, administeredOn: "2026-10-30", now: NOW };
      await expectAssessmentError(recordAssessment(tx, { ...base, role: "viewer" }), "not_allowed");
      await expectAssessmentError(recordAssessment(tx, { ...base, administeredOn: "2026-10-31" }), "date_in_future");
      await expectAssessmentError(recordAssessment(tx, { ...base, administeredOn: "2026-02-30" }), "invalid_date");
      await expectAssessmentError(recordAssessment(tx, { ...base, administeredOn: "Oct 30" }), "invalid_date");
      await expectAssessmentError(recordAssessment(tx, { ...base, result: "passed" as never }), "invalid_result");
      await expectAssessmentError(recordAssessment(tx, { ...base, note: "x".repeat(2001) }), "note_too_long");
      await expectAssessmentError(recordAssessment(tx, { ...base, assessmentTypeOptionId: await loadOption(tx, "star_reason", "on_time") }), "type_not_found");
      await expectAssessmentError(recordAssessment(tx, { ...base, applicationId: uuidv7() }), "application_not_found");

      // The window ladder test does not apply to a snow application.
      const snowApp = await newApplication(tx, snow);
      await expectAssessmentError(recordAssessment(tx, { ...base, applicationId: snowApp.applicationId }), "type_wrong_role");

      await tx.update(picklistOption).set({ archivedAt: NOW }).where(eq(picklistOption.id, ladderTestId));
      await expectAssessmentError(recordAssessment(tx, base), "type_archived");
      expect(await listAssessmentTypes(tx, windowRole.roleId)).toEqual([]);

      await tx.update(picklistOption).set({ archivedAt: null }).where(eq(picklistOption.id, ladderTestId));
      const { assessmentId } = await recordAssessment(tx, base);
      await expectAssessmentError(voidAssessment(tx, { assessmentId, userId: adminId, role: "viewer" }), "not_allowed");
      await expectAssessmentError(voidAssessment(tx, { assessmentId: uuidv7(), userId: adminId, role: "admin" }), "assessment_not_found");

      // An archived test still shows where the application has a result for it.
      await tx.update(picklistOption).set({ archivedAt: NOW }).where(eq(picklistOption.id, ladderTestId));
      const panel = await loadInterviewsPanel(tx, applicationId, "admin");
      expect(panel!.tests.map((t) => t.type.key)).toEqual(["ladder_test"]);
    });
  });
});
