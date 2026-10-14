import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, auditLog, formItem, formVersion, question, questionVersion, role } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { snowForm, windowForm } from "@/db/seed/questions";
import { staffActor } from "@/server/services/actor";
import { DO_NOT_ASK_LIST, matchDoNotAsk, questionTextForMatching } from "@/server/services/forms/do-not-ask";
import {
  addExistingQuestion,
  addQuestion,
  addSection,
  discardDraft,
  editQuestion,
  ensureDraft,
  FormEditorError,
  loadFormSnapshot,
  loadRoleForms,
  moveQuestion,
  moveSection,
  removeQuestion,
  removeSection,
  setAiNeverSend,
  slugKey,
  uniqueKey,
  updateItem,
  updateSection,
  type FormSnapshot,
} from "@/server/services/forms/editor";
import { checkDraft, publishForm } from "@/server/services/forms/publish";
import { expectPgError, PG, withRollback } from "./helpers/db";
import { createApplication, createPerson, loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

let snow: SnowFixture;
let windowRoleId: string;
let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  adminId = await loadAdminId(db);
  const [windowRole] = await db.select({ id: role.id }).from(role).where(eq(role.key, "window_cleaning_tech"));
  windowRoleId = windowRole!.id;
});

afterAll(async () => {
  await sql.end();
});

const actor = () => staffActor(adminId);

function itemByKey(form: FormSnapshot, key: string) {
  const item = form.items.find((i) => i.key === key);
  if (!item) throw new Error(`item ${key} missing from form version ${form.version}`);
  return item;
}

async function expectEditorError(run: Promise<unknown>, code: FormEditorError["code"]) {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected FormEditorError ${code}`).toBeInstanceOf(FormEditorError);
  expect((caught as FormEditorError).code).toBe(code);
}

describe("draft creation", () => {
  it("creates the snow draft from the published form, once", async () => {
    await withRollback(db, async (tx) => {
      const published = await loadFormSnapshot(tx, snow.formVersionId);
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      expect(draft.status).toBe("draft");
      expect(draft.version).toBe(2);
      expect(draft.sections).toEqual(published!.sections);
      expect(draft.aiDisclosureVersionId).toBe(published!.aiDisclosureVersionId);
      expect(draft.items.map((i) => [i.key, i.questionVersionId, i.sectionKey, i.required, i.attentionValues])).toEqual(
        published!.items.map((i) => [i.key, i.questionVersionId, i.sectionKey, i.required, i.attentionValues]),
      );
      expect(draft.items).toHaveLength(snowForm.questions.length);
      expect(draft.items.every((i) => i.publishedAt !== null)).toBe(true);

      const again = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      expect(again.id).toBe(draft.id);
      const drafts = await tx
        .select({ id: formVersion.id })
        .from(formVersion)
        .where(and(eq(formVersion.roleId, snow.roleId), eq(formVersion.status, "draft")));
      expect(drafts).toHaveLength(1);

      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, draft.id), eq(auditLog.action, "form.draft_create")));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorUserId).toBe(adminId);
      expect(audits[0]!.changes).toMatchObject({ version: 2, fromVersion: 1, items: snowForm.questions.length });
    });
  });

  it("returns the seeded window draft, whose versions are unpublished", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: windowRoleId, actor: actor() });
      expect(draft.version).toBe(1);
      expect(draft.items).toHaveLength(windowForm.questions.length);
      expect(draft.items.every((i) => i.publishedAt === null)).toBe(true);
      const forms = await loadRoleForms(tx, windowRoleId);
      expect(forms!.published).toBeNull();
      expect(forms!.draft!.id).toBe(draft.id);
    });
  });

  it("loads the editor state for a role with its history and application counts", async () => {
    await withRollback(db, async (tx) => {
      const personId = await createPerson(tx);
      await createApplication(tx, snow, personId);
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const forms = await loadRoleForms(tx, snow.roleId);
      expect(forms!.role.key).toBe("snow_removal_tech");
      expect(forms!.published!.id).toBe(snow.formVersionId);
      expect(forms!.published!.applicationCount).toBe(1);
      expect(forms!.draft!.id).toBe(draft.id);
      expect(forms!.history.map((h) => [h.version, h.status])).toEqual([
        [2, "draft"],
        [1, "published"],
      ]);
      expect(forms!.available).toEqual([]);
    });
  });
});

describe("keys", () => {
  it("slugs and de-duplicates keys", () => {
    expect(slugKey("What is the highest you have worked on a ladder?")).toBe("what_is_the_highest_you_have_worked_on");
    expect(slugKey("30 to 60 minutes")).toBe("n30_to_60_minutes");
    expect(slugKey("!!!")).toBe("");
    expect(uniqueKey("none", new Set(["none", "none_2"]))).toBe("none_3");
    expect(uniqueKey("", new Set(), "option")).toBe("option");
  });

  it("never changes a question key or role: a reword keeps them and a taken key is refused", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const before = itemByKey(draft, "drivers_license");
      await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: before.questionVersionId,
        type: "yes_no",
        prompt: "Do you hold a valid driver's license right now?",
        lineage: "reworded",
        actor: actor(),
      });
      const [lineage] = await tx.select().from(question).where(eq(question.id, before.questionId));
      expect(lineage!.key).toBe("drivers_license");
      expect(lineage!.roleId).toBe(snow.roleId);

      await expectEditorError(
        addQuestion(tx, {
          formVersionId: draft.id,
          sectionKey: "basics",
          key: "drivers_license",
          type: "yes_no",
          prompt: "Another license question",
          required: false,
          actor: actor(),
        }),
        "key_in_use",
      );
      await expectEditorError(
        addQuestion(tx, {
          formVersionId: draft.id,
          sectionKey: "basics",
          key: "Bad Key",
          type: "yes_no",
          prompt: "Another question",
          required: false,
          actor: actor(),
        }),
        "invalid_key",
      );
    });
  });

  it("keeps option keys when labels change and never reuses a key in a lineage", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const v1 = itemByKey(draft, "response_time");
      const relabelled = v1.options!.map((o) => ({ key: o.key, label: `${o.label} or so` }));
      const reworded = await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: v1.questionVersionId,
        type: "single_choice",
        prompt: "During a storm, how fast could you be on your way?",
        options: [...relabelled, { label: "Depends on the day" }],
        lineage: "reworded",
        actor: actor(),
      });
      expect(reworded.outcome).toBe("reworded");
      const [v2] = await tx.select().from(questionVersion).where(eq(questionVersion.id, reworded.questionVersionId));
      expect(v2!.options!.map((o) => o.key)).toEqual([...v1.options!.map((o) => o.key), "depends_on_the_day"]);
      expect(v2!.options![0]!.label).toBe("Within 30 minutes or so");

      // Drop "Depends on the day", then add a choice with the same label: the old key is not reused.
      const v3 = await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: v2!.id,
        type: "single_choice",
        prompt: v2!.prompt,
        options: [...v2!.options!.slice(0, 4).map((o) => ({ key: o.key, label: o.label })), { label: "Depends on the day" }],
        actor: actor(),
      });
      // v2 was never published, so this edit landed in place.
      expect(v3.outcome).toBe("edited_in_place");
      expect(v3.questionVersionId).toBe(v2!.id);

      // Publish v2 (the draft), then reword again: a removed key that comes back as a new label gets a fresh key.
      await publishForm(tx, { formVersionId: draft.id, changeReason: "Option wording test", actor: actor() });
      const draft3 = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const current = itemByKey(draft3, "response_time");
      const withoutLast = current.options!.slice(0, 4).map((o) => ({ key: o.key, label: o.label }));
      const r1 = await editQuestion(tx, {
        formVersionId: draft3.id,
        questionVersionId: current.questionVersionId,
        type: "single_choice",
        prompt: current.prompt,
        options: withoutLast,
        lineage: "reworded",
        actor: actor(),
      });
      const r2 = await editQuestion(tx, {
        formVersionId: draft3.id,
        questionVersionId: r1.questionVersionId,
        type: "single_choice",
        prompt: current.prompt,
        options: [...withoutLast, { label: "Depends on the day" }],
        actor: actor(),
      });
      const [latest] = await tx.select().from(questionVersion).where(eq(questionVersion.id, r2.questionVersionId));
      expect(latest!.options!.at(-1)!.key).toBe("depends_on_the_day_2");
    });
  });
});

describe("reworded or new", () => {
  it("reworded creates a new version in the same lineage and the draft points at it", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const before = itemByKey(draft, "short_notice_travel");
      const result = await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: before.questionVersionId,
        type: "yes_no",
        prompt: "Can you get to job sites around the Twin Cities on short notice, day or night?",
        help: "Most calls come overnight.",
        lineage: "reworded",
        changeNote: "Plainer wording",
        actor: actor(),
      });
      expect(result.outcome).toBe("reworded");
      if (result.outcome !== "reworded") return;
      expect(result.version).toBe(2);

      const after = await loadFormSnapshot(tx, draft.id);
      const item = itemByKey(after!, "short_notice_travel");
      expect(item.questionId).toBe(before.questionId);
      expect(item.questionVersionId).toBe(result.questionVersionId);
      expect(item.version).toBe(2);
      expect(item.meaningChanged).toBe(false);
      expect(item.changeNote).toBe("Plainer wording");
      expect(item.publishedAt).toBeNull();
      expect(item.required).toBe(before.required);
      expect(item.attentionValues).toEqual(before.attentionValues);
      expect(item.sectionKey).toBe(before.sectionKey);
      expect(item.sortOrder).toBe(before.sortOrder);

      // v1 is untouched and still in the published form.
      const [v1] = await tx.select().from(questionVersion).where(eq(questionVersion.id, before.questionVersionId));
      expect(v1!.prompt).toBe(before.prompt);
      const published = await loadFormSnapshot(tx, snow.formVersionId);
      expect(itemByKey(published!, "short_notice_travel").questionVersionId).toBe(before.questionVersionId);

      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, before.questionId), eq(auditLog.action, "question.reword")));
      expect(audits).toHaveLength(1);
    });
  });

  it("records meaning_changed when the editor says the meaning changed", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const before = itemByKey(draft, "other_job");
      const result = await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: before.questionVersionId,
        type: "single_choice",
        prompt: "Do you have another job you plan to keep this winter, and when do you work it?",
        options: before.options!.map((o) => ({ key: o.key, label: o.label })),
        lineage: "reworded",
        meaningChanged: true,
        actor: actor(),
      });
      const [v2] = await tx.select().from(questionVersion).where(eq(questionVersion.id, result.questionVersionId));
      expect(v2!.meaningChanged).toBe(true);
      expect(v2!.version).toBe(2);
    });
  });

  it("new creates a new lineage and removes the old one from the draft without archiving it", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const before = itemByKey(draft, "job1_employer");
      const result = await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: before.questionVersionId,
        type: "short_text",
        prompt: "Your most recent job: what was your job title?",
        lineage: "new",
        newKey: "job1_title",
        actor: actor(),
      });
      expect(result.outcome).toBe("new_question");
      if (result.outcome !== "new_question") return;
      expect(result.key).toBe("job1_title");

      const after = await loadFormSnapshot(tx, draft.id);
      expect(after!.items.find((i) => i.key === "job1_employer")).toBeUndefined();
      const item = itemByKey(after!, "job1_title");
      expect(item.questionId).toBe(result.questionId);
      expect(item.version).toBe(1);
      expect(item.sectionKey).toBe(before.sectionKey);
      expect(item.sortOrder).toBe(before.sortOrder);
      // The protective flag follows the replacement.
      expect(item.aiNeverSend).toBe(true);

      const [old] = await tx.select().from(question).where(eq(question.id, before.questionId));
      expect(old!.archivedAt).toBeNull();
      const oldVersions = await tx.select().from(questionVersion).where(eq(questionVersion.questionId, before.questionId));
      expect(oldVersions).toHaveLength(1);
      const published = await loadFormSnapshot(tx, snow.formVersionId);
      expect(itemByKey(published!, "job1_employer").questionVersionId).toBe(before.questionVersionId);

      // The removed lineage can come back at its latest version.
      const forms = await loadRoleForms(tx, snow.roleId);
      expect(forms!.available.map((a) => a.key)).toEqual(["job1_employer"]);
    });
  });

  it("asks for the choice when a published wording changes, and refuses a type change on a reword", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const item = itemByKey(draft, "start_date");
      await expectEditorError(
        editQuestion(tx, { formVersionId: draft.id, questionVersionId: item.questionVersionId, type: "date", prompt: "When could you start?", actor: actor() }),
        "lineage_choice_required",
      );
      await expectEditorError(
        editQuestion(tx, {
          formVersionId: draft.id,
          questionVersionId: item.questionVersionId,
          type: "short_text",
          prompt: "When could you start?",
          lineage: "reworded",
          actor: actor(),
        }),
        "type_change_needs_new_question",
      );
      await expectEditorError(
        editQuestion(tx, {
          formVersionId: draft.id,
          questionVersionId: item.questionVersionId,
          type: "date",
          prompt: item.prompt,
          lineage: "reworded",
          actor: actor(),
        }),
        "nothing_changed",
      );
    });
  });

  it("edits a never-published version in place", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: windowRoleId, actor: actor() });
      const before = itemByKey(draft, "why_this_job");
      const result = await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: before.questionVersionId,
        type: "long_text",
        prompt: "Why does this job interest you right now?",
        validation: { maxLength: 1500 },
        actor: actor(),
      });
      expect(result).toEqual({ outcome: "edited_in_place", questionVersionId: before.questionVersionId });
      const [row] = await tx.select().from(questionVersion).where(eq(questionVersion.id, before.questionVersionId));
      expect(row!.prompt).toBe("Why does this job interest you right now?");
      expect(row!.validation).toEqual({ maxLength: 1500 });
      expect(row!.version).toBe(1);
      const versions = await tx.select().from(questionVersion).where(eq(questionVersion.questionId, before.questionId));
      expect(versions).toHaveLength(1);
    });
  });
});

describe("draft editing", () => {
  it("adds, renames, reorders and removes sections", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const added = await addSection(tx, { formVersionId: draft.id, title: "About you", intro: "Short answers are fine.", actor: actor() });
      expect(added).toEqual({ key: "about_you", title: "About you", intro: "Short answers are fine." });
      await updateSection(tx, { formVersionId: draft.id, sectionKey: "about_you", title: "A bit about you", intro: "", actor: actor() });
      await moveSection(tx, { formVersionId: draft.id, sectionKey: "about_you", direction: "up", actor: actor() });
      let form = await loadFormSnapshot(tx, draft.id);
      expect(form!.sections.map((s) => s.key)).toEqual(["basics", "availability", "about_you", "experience"]);
      expect(form!.sections[2]).toEqual({ key: "about_you", title: "A bit about you" });

      await expectEditorError(removeSection(tx, { formVersionId: draft.id, sectionKey: "basics", actor: actor() }), "section_not_empty");
      await removeSection(tx, { formVersionId: draft.id, sectionKey: "about_you", actor: actor() });
      form = await loadFormSnapshot(tx, draft.id);
      expect(form!.sections.map((s) => s.key)).toEqual(["basics", "availability", "experience"]);
      await expectEditorError(addSection(tx, { formVersionId: draft.id, title: "  ", actor: actor() }), "section_title_required");
    });
  });

  it("adds, moves, flags, removes and restores questions", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const created = await addQuestion(tx, {
        formVersionId: draft.id,
        sectionKey: "experience",
        type: "multi_choice",
        prompt: "Which licenses or certifications do you hold?",
        options: [{ label: "CDL" }, { label: "Forklift" }, { label: "None" }],
        required: false,
        attentionValues: ["none", "bogus"],
        actor: actor(),
      });
      expect(created.key).toBe("which_licenses_or_certifications_do_you");
      let form = await loadFormSnapshot(tx, draft.id);
      let item = itemByKey(form!, created.key);
      expect(item.options).toEqual([
        { key: "cdl", label: "CDL" },
        { key: "forklift", label: "Forklift" },
        { key: "none", label: "None" },
      ]);
      expect(item.attentionValues).toEqual(["none"]);
      expect(form!.items.filter((i) => i.sectionKey === "experience").at(-1)!.key).toBe(created.key);

      await expectEditorError(
        addQuestion(tx, { formVersionId: draft.id, sectionKey: "experience", type: "single_choice", prompt: "One choice?", options: [{ label: "Only" }], required: true, actor: actor() }),
        "options_required",
      );
      await expectEditorError(
        addQuestion(tx, { formVersionId: draft.id, sectionKey: "nowhere", type: "yes_no", prompt: "Lost?", required: true, actor: actor() }),
        "section_not_found",
      );

      for (let i = 0; i < 3; i++) {
        await moveQuestion(tx, { formVersionId: draft.id, questionVersionId: created.questionVersionId, direction: "up", actor: actor() });
      }
      form = await loadFormSnapshot(tx, draft.id);
      expect(form!.items.filter((i) => i.sectionKey === "experience").map((i) => i.key)).toEqual([
        "equipment",
        created.key,
        "job1_employer",
        "job1_months",
        "job1_end",
      ]);

      await updateItem(tx, { formVersionId: draft.id, questionVersionId: created.questionVersionId, required: true, sectionKey: "basics", actor: actor() });
      form = await loadFormSnapshot(tx, draft.id);
      item = itemByKey(form!, created.key);
      expect(item.required).toBe(true);
      expect(item.sectionKey).toBe("basics");
      expect(form!.items.filter((i) => i.sectionKey === "basics").at(-1)!.key).toBe(created.key);

      const equipment = itemByKey(form!, "equipment");
      await removeQuestion(tx, { formVersionId: draft.id, questionVersionId: equipment.questionVersionId, actor: actor() });
      form = await loadFormSnapshot(tx, draft.id);
      expect(form!.items.find((i) => i.key === "equipment")).toBeUndefined();
      const [lineage] = await tx.select().from(question).where(eq(question.id, equipment.questionId));
      expect(lineage!.archivedAt).toBeNull();
      const forms = await loadRoleForms(tx, snow.roleId);
      expect(forms!.available.map((a) => a.key)).toEqual(["equipment"]);

      await addExistingQuestion(tx, { formVersionId: draft.id, questionId: equipment.questionId, sectionKey: "availability", required: true, actor: actor() });
      await expectEditorError(
        addExistingQuestion(tx, { formVersionId: draft.id, questionId: equipment.questionId, sectionKey: "availability", actor: actor() }),
        "question_already_in_draft",
      );
      form = await loadFormSnapshot(tx, draft.id);
      const restored = itemByKey(form!, "equipment");
      expect(restored.questionVersionId).toBe(equipment.questionVersionId);
      expect(restored.sectionKey).toBe("availability");
      expect(restored.required).toBe(true);

      await expectEditorError(
        removeQuestion(tx, { formVersionId: snow.formVersionId, questionVersionId: equipment.questionVersionId, actor: actor() }),
        "form_not_draft",
      );
    });
  });

  it("sets ai_never_send per lineage with an audit row", async () => {
    await withRollback(db, async (tx) => {
      const published = await loadFormSnapshot(tx, snow.formVersionId);
      const item = itemByKey(published!, "equipment");
      expect(item.aiNeverSend).toBe(false);
      await setAiNeverSend(tx, { questionId: item.questionId, value: true, actor: actor() });
      await setAiNeverSend(tx, { questionId: item.questionId, value: true, actor: actor() });
      const [row] = await tx.select().from(question).where(eq(question.id, item.questionId));
      expect(row!.aiNeverSend).toBe(true);
      const audits = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, item.questionId), eq(auditLog.action, "question.ai_never_send")));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.changes).toMatchObject({ key: "equipment", aiNeverSend: { from: false, to: true } });
    });
  });

  it("discards a draft along with the never-published versions only it used", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const created = await addQuestion(tx, {
        formVersionId: draft.id,
        sectionKey: "basics",
        type: "yes_no",
        prompt: "Do you have steel-toed boots?",
        required: false,
        actor: actor(),
      });
      const reworded = await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: itemByKey(draft, "equipment").questionVersionId,
        type: "multi_choice",
        prompt: "Which of these have you used to clear snow? Pick all that apply.",
        options: itemByKey(draft, "equipment").options!.map((o) => ({ key: o.key, label: o.label })),
        lineage: "reworded",
        actor: actor(),
      });
      await discardDraft(tx, { formVersionId: draft.id, actor: actor() });

      expect(await loadFormSnapshot(tx, draft.id)).toBeNull();
      expect(await tx.select().from(question).where(eq(question.id, created.questionId))).toHaveLength(0);
      expect(await tx.select().from(questionVersion).where(eq(questionVersion.id, reworded.questionVersionId))).toHaveLength(0);
      // The published form and its versions are untouched.
      const published = await loadFormSnapshot(tx, snow.formVersionId);
      expect(published!.items).toHaveLength(snowForm.questions.length);
      const equipmentVersions = await tx
        .select()
        .from(questionVersion)
        .where(eq(questionVersion.questionId, itemByKey(published!, "equipment").questionId));
      expect(equipmentVersions).toHaveLength(1);
    });
  });
});

describe("publish", () => {
  it("requires a written change reason and changes nothing without one", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      await expectEditorError(publishForm(tx, { formVersionId: draft.id, changeReason: "   ", actor: actor() }), "change_reason_required");
      const [row] = await tx.select().from(formVersion).where(eq(formVersion.id, draft.id));
      expect(row!.status).toBe("draft");
      const [previous] = await tx.select().from(formVersion).where(eq(formVersion.id, snow.formVersionId));
      expect(previous!.status).toBe("published");
    });
  });

  it("publishes in one transaction: stamps versions, retires the old form, leaves pinned applications alone", async () => {
    await withRollback(db, async (tx) => {
      const personId = await createPerson(tx);
      const { applicationId } = await createApplication(tx, snow, personId);

      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const reworded = await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: itemByKey(draft, "drivers_license").questionVersionId,
        type: "yes_no",
        prompt: "Do you have a valid driver's license today?",
        lineage: "reworded",
        actor: actor(),
      });
      const added = await addQuestion(tx, {
        formVersionId: draft.id,
        sectionKey: "basics",
        type: "number",
        prompt: "How many winters have you worked snow removal?",
        validation: { min: 0, max: 60, integer: true },
        required: false,
        actor: actor(),
      });
      expect(await checkDraft(tx, draft.id)).toEqual([]);

      const when = new Date("2026-10-20T15:00:00Z");
      const result = await publishForm(tx, { formVersionId: draft.id, changeReason: "Plainer license wording; add experience count", actor: actor(), now: when });
      expect(result).toEqual({
        formVersionId: draft.id,
        version: 2,
        previous: { formVersionId: snow.formVersionId, version: 1 },
        questionVersionsPublished: 2,
      });

      const [v2] = await tx.select().from(formVersion).where(eq(formVersion.id, draft.id));
      expect(v2!.status).toBe("published");
      expect(v2!.publishedAt).toEqual(when);
      expect(v2!.publishedBy).toBe(adminId);
      expect(v2!.changeReason).toBe("Plainer license wording; add experience count");
      const [v1] = await tx.select().from(formVersion).where(eq(formVersion.id, snow.formVersionId));
      expect(v1!.status).toBe("retired");
      expect(v1!.publishedAt).not.toBeNull();

      for (const id of [reworded.questionVersionId, added.questionVersionId]) {
        const [row] = await tx.select().from(questionVersion).where(eq(questionVersion.id, id));
        expect(row!.publishedAt).toEqual(when);
      }

      // One published form per role, and it is v2 now: that is what new applications pin.
      const live = await tx
        .select({ id: formVersion.id, version: formVersion.version })
        .from(formVersion)
        .where(and(eq(formVersion.roleId, snow.roleId), eq(formVersion.status, "published")));
      expect(live).toEqual([{ id: draft.id, version: 2 }]);

      // The application started on v1 still pins v1 and its items are still there.
      const [pinned] = await tx.select({ formVersionId: application.formVersionId }).from(application).where(eq(application.id, applicationId));
      expect(pinned!.formVersionId).toBe(snow.formVersionId);
      const v1Items = await tx.select().from(formItem).where(eq(formItem.formVersionId, snow.formVersionId));
      expect(v1Items).toHaveLength(snowForm.questions.length);

      const forms = await loadRoleForms(tx, snow.roleId);
      expect(forms!.published!.id).toBe(draft.id);
      expect(forms!.published!.publishedBy?.email).toBe(TEST_ADMIN_EMAIL);
      expect(forms!.draft).toBeNull();
      expect(forms!.history.map((h) => [h.version, h.status, h.applicationCount])).toEqual([
        [2, "published", 0],
        [1, "retired", 1],
      ]);

      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, draft.id), eq(auditLog.action, "config.publish")));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.changes).toMatchObject({ version: 2, previousVersion: 1, questionVersionsPublished: 2 });

      // Immutable from here on: the form, its items and the newly published versions.
      // Each attempt runs in a savepoint so the failure does not abort the outer transaction.
      await expectPgError(
        tx.transaction((sp) => sp.update(formVersion).set({ changeReason: "edited" }).where(eq(formVersion.id, draft.id))),
        PG.immutablePublished,
      );
      await expectPgError(
        tx.transaction((sp) =>
          sp.update(formItem).set({ required: true }).where(and(eq(formItem.formVersionId, draft.id), eq(formItem.questionVersionId, added.questionVersionId))),
        ),
        PG.immutablePublished,
      );
      await expectPgError(
        tx.transaction((sp) => sp.update(questionVersion).set({ prompt: "Changed" }).where(eq(questionVersion.id, reworded.questionVersionId))),
        PG.immutablePublished,
      );
      await expectEditorError(
        removeQuestion(tx, { formVersionId: draft.id, questionVersionId: added.questionVersionId, actor: actor() }),
        "form_not_draft",
      );
      await expectEditorError(publishForm(tx, { formVersionId: draft.id, changeReason: "again", actor: actor() }), "form_not_draft");

      // The next draft starts from v2.
      const next = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      expect(next.version).toBe(3);
      expect(itemByKey(next, "drivers_license").questionVersionId).toBe(reworded.questionVersionId);
      expect(next.items.every((i) => i.publishedAt !== null)).toBe(true);
    });
  });

  it("publishes a role that had no published form, with nothing to retire", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: windowRoleId, actor: actor() });
      const result = await publishForm(tx, { formVersionId: draft.id, changeReason: "Window form v1 for the spring opening", actor: actor() });
      expect(result.previous).toBeNull();
      expect(result.questionVersionsPublished).toBe(windowForm.questions.length);
      const forms = await loadRoleForms(tx, windowRoleId);
      expect(forms!.published!.version).toBe(1);
      expect(forms!.published!.items.every((i) => i.publishedAt !== null)).toBe(true);
    });
  });

  it("rolls back a publish that fails validation, leaving the old form live and nothing stamped", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      const added = await addQuestion(tx, {
        formVersionId: draft.id,
        sectionKey: "basics",
        type: "yes_no",
        prompt: "Can you lift 50 pounds?",
        required: true,
        actor: actor(),
      });
      // Two items of one lineage cannot happen through the editor; put one in directly.
      const dl = itemByKey(draft, "drivers_license");
      const reworded = await editQuestion(tx, {
        formVersionId: draft.id,
        questionVersionId: dl.questionVersionId,
        type: "yes_no",
        prompt: "Valid driver's license?",
        lineage: "reworded",
        actor: actor(),
      });
      await tx.insert(formItem).values({
        formVersionId: draft.id,
        questionVersionId: dl.questionVersionId,
        sectionKey: "basics",
        sortOrder: 999,
        required: true,
      });
      const problems = await checkDraft(tx, draft.id);
      expect(problems.map((p) => p.code)).toEqual(["duplicate_lineage"]);

      await expectEditorError(publishForm(tx, { formVersionId: draft.id, changeReason: "Should fail", actor: actor() }), "duplicate_lineage");

      const [previous] = await tx.select().from(formVersion).where(eq(formVersion.id, snow.formVersionId));
      expect(previous!.status).toBe("published");
      const [still] = await tx.select().from(formVersion).where(eq(formVersion.id, draft.id));
      expect(still!.status).toBe("draft");
      for (const id of [added.questionVersionId, reworded.questionVersionId]) {
        const [row] = await tx.select().from(questionVersion).where(eq(questionVersion.id, id));
        expect(row!.publishedAt).toBeNull();
      }
      expect(await tx.select().from(auditLog).where(and(eq(auditLog.entityId, draft.id), eq(auditLog.action, "config.publish")))).toHaveLength(0);
    });
  });

  it("refuses an empty draft", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: actor() });
      for (const item of draft.items) {
        await removeQuestion(tx, { formVersionId: draft.id, questionVersionId: item.questionVersionId, actor: actor() });
      }
      expect((await checkDraft(tx, draft.id)).map((p) => p.code)).toEqual(["empty_form"]);
      await expectEditorError(publishForm(tx, { formVersionId: draft.id, changeReason: "Nothing here", actor: actor() }), "empty_form");
    });
  });
});

describe("do-not-ask matcher", () => {
  it("lists every topic from the data model", () => {
    expect(DO_NOT_ASK_LIST.map((t) => t.key)).toEqual([
      "criminal_history",
      "age",
      "ssn",
      "license_number",
      "home_address",
      "photo",
      "pay_history",
      "family_status",
      "public_assistance",
      "health",
      "protected_traits",
      "human_rights_commission",
    ]);
  });

  it("warns on wording that asks about a listed topic", () => {
    const cases: Array<[string, string]> = [
      ["Have you ever been convicted of a crime?", "criminal_history"],
      ["Any arrests in the last five years?", "criminal_history"],
      ["What is your date of birth?", "age"],
      ["How old are you?", "age"],
      ["Enter your Social Security number", "ssn"],
      ["What is your driver's license number?", "license_number"],
      ["What is your home address?", "home_address"],
      ["Upload a photo of yourself", "photo"],
      ["What was your salary history at your last job?", "pay_history"],
      ["Tell us your prior pay", "pay_history"],
      ["Are you married?", "family_status"],
      ["Do you have children at home?", "family_status"],
      ["Are you on public assistance?", "public_assistance"],
      ["What is your religion?", "protected_traits"],
      ["Do you have a disability?", "health"],
      ["Do you sit on a human rights commission?", "human_rights_commission"],
    ];
    for (const [text, key] of cases) {
      const keys = matchDoNotAsk(text).map((m) => m.topic.key);
      expect(keys, text).toContain(key);
    }
    const match = matchDoNotAsk("Were you ever arrested or convicted?")[0]!;
    expect(match.matched).toEqual(["convicted", "arrested"]);
  });

  it("stays quiet on the seeded questions and on words that only contain a keyword", () => {
    for (const q of [...snowForm.questions, ...windowForm.questions]) {
      expect(matchDoNotAsk(questionTextForMatching(q)), q.key).toEqual([]);
    }
    expect(matchDoNotAsk("Can you manage a page of notes per day?")).toEqual([]);
    expect(matchDoNotAsk("Do you have a valid driver’s license?")).toEqual([]);
    expect(matchDoNotAsk("")).toEqual([]);
  });
});

describe("snapshot ordering", () => {
  it("orders items by section order then sort order", async () => {
    const published = await loadFormSnapshot(db, snow.formVersionId);
    expect(published!.items.map((i) => i.key)).toEqual(snowForm.questions.map((q) => q.key));
    const items = await db
      .select({ sortOrder: formItem.sortOrder })
      .from(formItem)
      .where(eq(formItem.formVersionId, snow.formVersionId))
      .orderBy(asc(formItem.sortOrder));
    expect(items[0]!.sortOrder).toBe(10);
  });
});
