import { and, asc, eq, inArray, sql as raw } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql, type Db } from "@/db";
import { auditLog, formItem, formVersion, opening, picklistOption, pipelineStage, question, questionVersion, role, rubric } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { listAssessmentTypes } from "@/server/services/assessments/assessments";
import { createApplication } from "@/server/services/applications/transition";
import {
  addOpening,
  createRoleFromTemplate,
  listRoleOpenings,
  listRoleSummaries,
  previewRoleCopies,
  RoleError,
} from "@/server/services/config/roles";
import { checkDraft, publishForm } from "@/server/services/forms/publish";
import { withRollback } from "./helpers/db";
import { createPerson, loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { loadWindow, type WindowFixture } from "./helpers/interviews";

let snow: SnowFixture;
let windowRole: WindowFixture;
let actor: ReturnType<typeof staffActor>;
let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  windowRole = await loadWindow(db);
  adminId = await loadAdminId(db);
  actor = staffActor(adminId);
});

afterAll(async () => {
  await sql.end();
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function expectRoleError(run: Promise<unknown>, code: RoleError["code"]) {
  await expect(run).rejects.toSatisfy((error: unknown) => error instanceof RoleError && error.code === code);
}

function gutters(tx: Tx, overrides: Partial<Parameters<typeof createRoleFromTemplate>[1]> = {}) {
  return createRoleFromTemplate(tx, {
    actor,
    templateRoleId: snow.roleId,
    title: "Gutter Cleaning Technician",
    internalName: "Gutter Cleaning Technician (seasonal)",
    key: "gutter_cleaning_tech",
    ...overrides,
  });
}

// One digest per table of the rows a role owns, so any change to the template shows up.
async function roleDigest(tx: Tx, roleId: string) {
  const rows = await tx.execute<{ name: string; digest: string | null }>(raw`
    select 'role' as name, md5(string_agg(t::text, '|' order by t::text)) as digest from role t where t.id = ${roleId}
    union all select 'pipeline_stage', md5(string_agg(t::text, '|' order by t::text)) from pipeline_stage t where t.role_id = ${roleId}
    union all select 'picklist_option', md5(string_agg(t::text, '|' order by t::text)) from picklist_option t where t.role_id = ${roleId}
    union all select 'question', md5(string_agg(t::text, '|' order by t::text)) from question t where t.role_id = ${roleId}
    union all select 'question_version', md5(string_agg(t::text, '|' order by t::text)) from question_version t
      where t.question_id in (select id from question where role_id = ${roleId})
    union all select 'form_version', md5(string_agg(t::text, '|' order by t::text)) from form_version t where t.role_id = ${roleId}
    union all select 'form_item', md5(string_agg(t::text, '|' order by t::text)) from form_item t
      where t.form_version_id in (select id from form_version where role_id = ${roleId})`);
  return Object.fromEntries(rows.map((r) => [r.name, r.digest]));
}

// Every item of a form with its question version and lineage, in form order.
async function formContent(tx: Db, formVersionId: string) {
  const rows = await tx
    .select({ item: formItem, version: questionVersion, lineage: question })
    .from(formItem)
    .innerJoin(questionVersion, eq(questionVersion.id, formItem.questionVersionId))
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(eq(formItem.formVersionId, formVersionId))
    .orderBy(asc(formItem.sectionKey), asc(formItem.sortOrder));
  return rows.map(({ item, version, lineage }) => ({
    key: lineage.key,
    aiNeverSend: lineage.aiNeverSend,
    type: version.type,
    prompt: version.prompt,
    help: version.help,
    options: version.options,
    validation: version.validation,
    staffGuidance: version.staffGuidance,
    startsWithCheck: version.startsWithCheck,
    sectionKey: item.sectionKey,
    sortOrder: item.sortOrder,
    required: item.required,
    attentionValues: item.attentionValues,
  }));
}

describe("New role from a template", () => {
  it("copies the snow role's stages and its live questions as a draft, with no rubric or opening, and leaves snow untouched", async () => {
    await withRollback(db, async (tx) => {
      const before = await roleDigest(tx, snow.roleId);
      const created = await gutters(tx);

      const [newRole] = await tx.select().from(role).where(eq(role.id, created.roleId));
      const [snowRole] = await tx.select().from(role).where(eq(role.id, snow.roleId));
      expect(newRole).toMatchObject({
        key: "gutter_cleaning_tech",
        title: "Gutter Cleaning Technician",
        internalName: "Gutter Cleaning Technician (seasonal)",
        summary: null,
        usesGroupInterview: snowRole!.usesGroupInterview,
        employerId: snowRole!.employerId,
        archivedAt: null,
      });
      expect(newRole!.sortOrder).toBeGreaterThan(snowRole!.sortOrder);

      // Stages: the same pipeline, keys, milestones and flags included, as new rows.
      const shape = (rows: (typeof pipelineStage.$inferSelect)[]) =>
        rows.map(({ key, name, publicLabel, milestone, sortOrder, isSystem, showOnBoard }) => ({ key, name, publicLabel, milestone, sortOrder, isSystem, showOnBoard }));
      const snowStages = await tx.select().from(pipelineStage).where(eq(pipelineStage.roleId, snow.roleId)).orderBy(asc(pipelineStage.sortOrder));
      const newStages = await tx.select().from(pipelineStage).where(eq(pipelineStage.roleId, created.roleId)).orderBy(asc(pipelineStage.sortOrder));
      expect(shape(newStages)).toEqual(shape(snowStages.filter((s) => !s.archivedAt)));
      expect(created.stages).toBe(newStages.length);
      expect(newStages.map((s) => s.id).some((id) => snowStages.some((s) => s.id === id))).toBe(false);

      // Questions: version 1 of new lineages owned by the new role, in a draft form,
      // with the wording, choice keys, staff guidance and checks of snow's live form.
      const forms = await tx.select().from(formVersion).where(eq(formVersion.roleId, created.roleId));
      expect(forms).toHaveLength(1);
      const [snowForm] = await tx.select().from(formVersion).where(eq(formVersion.id, snow.formVersionId));
      expect(forms[0]).toMatchObject({
        id: created.formVersionId,
        version: 1,
        status: "draft",
        sections: snowForm!.sections,
        aiDisclosureVersionId: snowForm!.aiDisclosureVersionId,
        changeReason: null,
        publishedAt: null,
        createdBy: adminId,
      });
      const copied = await formContent(tx, created.formVersionId!);
      expect(copied).toEqual(await formContent(tx, snow.formVersionId));
      expect(created.questions).toBe(copied.length);
      const lineages = await tx.select().from(question).where(eq(question.roleId, created.roleId));
      expect(lineages).toHaveLength(copied.length);
      const versions = await tx
        .select()
        .from(questionVersion)
        .where(
          inArray(
            questionVersion.questionId,
            lineages.map((q) => q.id),
          ),
        );
      expect(versions.every((v) => v.version === 1 && v.publishedAt === null && !v.meaningChanged && v.createdBy === adminId)).toBe(true);

      // Scoring stays off (no rubric) and nothing is open for applicants yet.
      expect(await tx.select().from(rubric).where(eq(rubric.roleId, created.roleId))).toHaveLength(0);
      expect(await tx.select().from(opening).where(eq(opening.roleId, created.roleId))).toHaveLength(0);

      const audits = await tx.select().from(auditLog).where(inArray(auditLog.entityId, [created.roleId, created.formVersionId!]));
      expect(audits.map((a) => a.action).sort()).toEqual(["form.draft_create", "role.create"]);
      expect(audits.find((a) => a.action === "role.create")!.changes).toMatchObject({
        key: { from: null, to: "gutter_cleaning_tech" },
        copiedFrom: { roleId: snow.roleId, key: "snow_removal_tech" },
        questions: copied.length,
      });

      expect(await roleDigest(tx, snow.roleId)).toEqual(before);
    });
  });

  it("copies the window role's own picklist options and its draft questions", async () => {
    await withRollback(db, async (tx) => {
      const created = await gutters(tx, { templateRoleId: windowRole.roleId, key: "window_copy", internalName: "Window copy" });
      const options = await tx
        .select({ listKey: picklistOption.listKey, key: picklistOption.key, label: picklistOption.label, employerId: picklistOption.employerId })
        .from(picklistOption)
        .where(eq(picklistOption.roleId, created.roleId))
        .orderBy(asc(picklistOption.listKey));
      expect(options.map((o) => `${o.listKey}:${o.key}`)).toEqual(["disqualify_reason:failed_ladder_test", "assessment_type:ladder_test"]);
      expect(created.picklistOptions).toBe(2);
      expect((await listAssessmentTypes(tx, created.roleId)).map((t) => t.label)).toEqual(["Ladder test"]);

      // Window has never published a form, so the copy takes its draft.
      expect(await formContent(tx, created.formVersionId!)).toEqual(await formContent(tx, windowRole.formVersionId));
      const neverSend = await tx
        .select({ key: question.key })
        .from(question)
        .where(and(eq(question.roleId, created.roleId), eq(question.aiNeverSend, true)))
        .orderBy(asc(question.key));
      expect(neverSend.map((q) => q.key)).toEqual(["age_18_plus", "essential_functions", "job1_employer", "job2_employer", "slow_stretch", "two_years"]);
    });
  });

  it("publishes the copied form through the question editor's publish, and takes applications on it", async () => {
    await withRollback(db, async (tx) => {
      const created = await gutters(tx);
      expect(await checkDraft(tx, created.formVersionId!)).toEqual([]);
      const published = await publishForm(tx, { formVersionId: created.formVersionId!, changeReason: "First gutter form, copied from snow", actor });
      expect(published).toMatchObject({ version: 1, previous: null, questionVersionsPublished: created.questions });
      const [form] = await tx.select().from(formVersion).where(eq(formVersion.id, created.formVersionId!));
      expect(form).toMatchObject({ status: "published", publishedBy: adminId });

      // A first opening, then an application pinned to the new form.
      const { openingId } = await addOpening(tx, { actor, roleId: created.roleId, name: "Gutters 2027", key: "gutters-2027" });
      const personId = await createPerson(tx);
      const { applicationId } = await createApplication(tx, { personId, openingId, origin: "staff_created", entryChannel: "staff_entered", actor });
      const [app] = await tx.execute<{ form_version_id: string; stage_key: string }>(raw`
        select a.form_version_id, s.key as stage_key from application a join pipeline_stage s on s.id = a.current_stage_id where a.id = ${applicationId}`);
      expect(app).toEqual({ form_version_id: created.formVersionId, stage_key: "started" });
      // Snow's live form is still its own.
      const [snowForm] = await tx.select().from(formVersion).where(eq(formVersion.id, snow.formVersionId));
      expect(snowForm!.status).toBe("published");
    });
  });

  it("leaves the questions out when asked", async () => {
    await withRollback(db, async (tx) => {
      const created = await gutters(tx, { copyQuestions: false });
      expect(created).toMatchObject({ formVersionId: null, questions: 0 });
      expect(await tx.select().from(formVersion).where(eq(formVersion.roleId, created.roleId))).toHaveLength(0);
      expect(await tx.select().from(question).where(eq(question.roleId, created.roleId))).toHaveLength(0);
    });
  });

  it("checks the key, the names and the template", async () => {
    await withRollback(db, async (tx) => {
      for (const key of ["Gutters", "1gutters", "g", "gutter cleaning", "gutter-cleaning", "x".repeat(41), ""]) {
        await expectRoleError(gutters(tx, { key }), "invalid_input");
      }
      await expectRoleError(gutters(tx, { key: "snow_removal_tech" }), "role_key_exists");
      await expectRoleError(gutters(tx, { internalName: "snow removal technician (ON-CALL)" }), "role_name_taken");
      await expectRoleError(gutters(tx, { title: "   " }), "invalid_input");
      await expectRoleError(gutters(tx, { internalName: "x".repeat(121) }), "invalid_input");
      await expectRoleError(gutters(tx, { templateRoleId: uuidv7() }), "role_not_found");

      await gutters(tx);
      await expectRoleError(gutters(tx, { internalName: "Another name" }), "role_key_exists");
      // Nothing half-made is left behind by the refusals.
      expect(await tx.select().from(role).where(eq(role.key, "gutter_cleaning_tech"))).toHaveLength(1);
    });
  });

  it("adds draft openings with their own keys, and lists the new role with them", async () => {
    await withRollback(db, async (tx) => {
      const created = await gutters(tx);
      const { openingId } = await addOpening(tx, { actor, roleId: created.roleId, name: "  Gutters 2027  ", key: "gutters-2027" });
      const [row] = await tx.select().from(opening).where(eq(opening.id, openingId));
      expect(row).toMatchObject({ name: "Gutters 2027", key: "gutters-2027", status: "draft", payText: null, opensOn: null });
      await expectRoleError(addOpening(tx, { actor, roleId: created.roleId, name: "Again", key: "gutters-2027" }), "opening_key_exists");
      await expectRoleError(addOpening(tx, { actor, roleId: created.roleId, name: "Bad", key: "Gutters 2027" }), "invalid_input");
      await expectRoleError(addOpening(tx, { actor, roleId: created.roleId, name: " ", key: "gutters-2028" }), "invalid_input");
      await expectRoleError(addOpening(tx, { actor, roleId: uuidv7(), name: "Nowhere", key: "nowhere-2027" }), "role_not_found");
      const [entry] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "opening"), eq(auditLog.entityId, openingId)));
      expect(entry).toMatchObject({ action: "opening.create", changes: { key: { from: null, to: "gutters-2027" }, status: { from: null, to: "draft" } } });

      expect((await listRoleOpenings(tx, created.roleId)).map((o) => o.key)).toEqual(["gutters-2027"]);
      const summary = (await listRoleSummaries(tx)).find((r) => r.id === created.roleId);
      expect(summary).toMatchObject({ stageCount: created.stages, form: { published: null, draft: 1 }, openings: [{ id: openingId, status: "draft" }] });
    });
  });

  it("previews what each role would copy", async () => {
    const previews = await previewRoleCopies(db);
    const snowPreview = previews.find((p) => p.roleId === snow.roleId)!;
    const [snowForm] = await db.select().from(formVersion).where(eq(formVersion.id, snow.formVersionId));
    expect(snowPreview).toMatchObject({ stages: 8, picklistOptions: 0, form: { version: snowForm!.version, status: "published" } });
    expect(snowPreview.questions).toBe((await formContent(db, snow.formVersionId)).length);
    expect(previews.find((p) => p.roleId === windowRole.roleId)).toMatchObject({ stages: 9, picklistOptions: 2, questions: 22, form: { version: 1, status: "draft" } });
  });
});
