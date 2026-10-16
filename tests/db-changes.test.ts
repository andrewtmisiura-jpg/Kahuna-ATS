import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { CHANGES, ChangeError, runChanges, type Change } from "@/db/changes";
import {
  SNOW_BEHAVIORAL_CHANGE_REASON,
  SNOW_BEHAVIORAL_QUESTIONS,
  snowBehavioralQuestions,
} from "@/db/changes/snow-behavioral-questions";
import { appliedChange, application, appUser, auditLog, formVersion } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { staffActor } from "@/server/services/actor";
import { loadApplicationForm, saveAnswer } from "@/server/services/applications/answers";
import { loadProfile } from "@/server/services/applications/queries";
import { createApplication } from "@/server/services/applications/transition";
import { matchDoNotAsk } from "@/server/services/forms/do-not-ask";
import { ensureDraft, loadFormSnapshot, removeQuestion } from "@/server/services/forms/editor";
import { publishForm } from "@/server/services/forms/publish";
import { withRollback } from "./helpers/db";
import { createPerson, loadAdminId, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// `pnpm db:changes` and its first change, the owner's five snow questions. Every
// case runs inside a rolled-back transaction, so the shared test database keeps
// snow form v1 for the other test files.

const ID = "2026-10-16-snow-behavioral-questions";
const KEYS = ["missed_commitment", "unnoticed_mistake", "hardest_physical_job", "best_boss_blue", "forgot_equipment"];

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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function publishedSnow(tx: Tx) {
  const [row] = await tx
    .select()
    .from(formVersion)
    .where(and(eq(formVersion.roleId, snow.roleId), eq(formVersion.status, "published")));
  return (await loadFormSnapshot(tx, row!.id))!;
}

async function newApplication(tx: Tx) {
  const personId = await createPerson(tx);
  const { applicationId } = await createApplication(tx, {
    personId,
    openingId: snow.openingId,
    origin: "landing",
    entryChannel: "role_qr",
    actor: { type: "applicant" },
  });
  return applicationId;
}

describe("the change list", () => {
  it("lists the snow change first, with its permanent id", () => {
    expect(CHANGES.map((c) => c.id)).toEqual([ID]);
  });

  it("refuses a list with the same id twice", async () => {
    await expect(runChanges(db, [snowBehavioralQuestions, snowBehavioralQuestions])).rejects.toBeInstanceOf(ChangeError);
  });

  it("keeps the five prompts clear of the do-not-ask list", () => {
    for (const q of SNOW_BEHAVIORAL_QUESTIONS) expect(matchDoNotAsk(q.prompt), q.key).toEqual([]);
  });
});

describe("the snow behavioral questions change", () => {
  it("applies once, publishing the next version with the five questions in a new last section", async () => {
    await withRollback(db, async (tx) => {
      const before = await publishedSnow(tx);
      const lines: string[] = [];
      const first = await runChanges(tx, CHANGES, (line) => lines.push(line));
      expect(first).toEqual({ applied: [ID], skipped: [] });
      expect(lines.join("\n")).toContain(`applied ${ID}`);

      const after = await publishedSnow(tx);
      expect(after.version).toBe(before.version + 1);
      expect(after.changeReason).toBe(SNOW_BEHAVIORAL_CHANGE_REASON);
      expect(after.publishedBy?.id).toBe(adminId);
      expect(after.sections.map((s) => s.key)).toEqual([...before.sections.map((s) => s.key), "how_you_work"]);
      expect(after.sections.at(-1)).toEqual({
        key: "how_you_work",
        title: "How you work",
        intro: "A few sentences is plenty. Spelling and grammar don't matter.",
      });

      // Everything from the old version is still there, unchanged.
      const kept = after.items.filter((i) => i.sectionKey !== "how_you_work");
      expect(kept.map((i) => i.questionVersionId)).toEqual(before.items.map((i) => i.questionVersionId));

      const added = after.items.filter((i) => i.sectionKey === "how_you_work");
      expect(added.map((i) => i.key)).toEqual(KEYS);
      for (const item of added) {
        expect(item.type).toBe("long_text");
        expect(item.required).toBe(true);
        expect(item.aiNeverSend).toBe(false);
        expect(item.version).toBe(1);
        expect(item.publishedAt).not.toBeNull();
        expect(item.staffGuidance).toBeTruthy();
      }
      const byKey = Object.fromEntries(added.map((i) => [i.key, i]));
      expect(byKey.best_boss_blue!.prompt).toBe("In 2 to 3 sentences, tell us about the best boss you've ever had. Start your answer with the word 'Blue.'");
      expect(byKey.best_boss_blue!.startsWithCheck).toBe("blue");
      expect(added.filter((i) => i.startsWithCheck).map((i) => i.key)).toEqual(["best_boss_blue"]);
      expect(byKey.missed_commitment!.staffGuidance).toContain("Strong: specific story, gave early notice, owns it.");
      expect(byKey.unnoticed_mistake!.staffGuidance).toContain("Ignore anything about health, family or legal matters.");
      expect(byKey.forgot_equipment!.staffGuidance).toContain("Hypothetical question, so a weaker signal than the other four.");
      expect(byKey.best_boss_blue!.staffGuidance).toBe(
        "Pass or fail only: did they start with the word Blue? The content barely matters. Treat a fail as a signal, not an automatic reject.",
      );

      const [row] = await tx.select().from(appliedChange).where(eq(appliedChange.id, ID));
      expect(row?.description).toBe(snowBehavioralQuestions.description);

      // Audit rows name the Admin, through the editor's own services.
      const publish = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "config.publish"), eq(auditLog.entityId, after.id)));
      expect(publish).toHaveLength(1);
      expect(publish[0]!.actorUserId).toBe(adminId);
      const creates = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "question.create"), eq(auditLog.actorUserId, adminId)))
        .orderBy(desc(auditLog.occurredAt));
      expect(creates.length).toBeGreaterThanOrEqual(5);

      // The second run does nothing.
      const second = await runChanges(tx, CHANGES);
      expect(second).toEqual({ applied: [], skipped: [ID] });
      expect((await publishedSnow(tx)).version).toBe(after.version);
    });
  });

  it("never re-adds a question someone later removed, because the id is recorded", async () => {
    await withRollback(db, async (tx) => {
      await runChanges(tx, CHANGES);
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: staffActor(adminId) });
      const blue = draft.items.find((i) => i.key === "best_boss_blue")!;
      await removeQuestion(tx, { formVersionId: draft.id, questionVersionId: blue.questionVersionId, actor: staffActor(adminId) });
      await publishForm(tx, { formVersionId: draft.id, changeReason: "Owner dropped the Blue question", actor: staffActor(adminId) });

      expect(await runChanges(tx, CHANGES)).toEqual({ applied: [], skipped: [ID] });
      const live = await publishedSnow(tx);
      expect(live.items.map((i) => i.key)).not.toContain("best_boss_blue");
      expect(live.items.filter((i) => i.sectionKey === "how_you_work")).toHaveLength(4);
    });
  });

  it("refuses when the snow form already has a draft, and changes nothing", async () => {
    await withRollback(db, async (tx) => {
      const draft = await ensureDraft(tx, { roleId: snow.roleId, actor: staffActor(adminId) });
      let caught: unknown;
      try {
        await runChanges(tx, CHANGES);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChangeError);
      expect((caught as Error).message).toMatch(/unpublished draft \(version \d+\)/);

      expect(await tx.select().from(appliedChange).where(eq(appliedChange.id, ID))).toHaveLength(0);
      const still = await loadFormSnapshot(tx, draft.id);
      expect(still!.status).toBe("draft");
      expect(still!.sections.map((s) => s.key)).not.toContain("how_you_work");
      expect((await publishedSnow(tx)).id).toBe(snow.formVersionId);
    });
  });

  it("publishes the next version while an application pinned to the old one keeps it", async () => {
    await withRollback(db, async (tx) => {
      const before = await publishedSnow(tx);
      const pinned = await newApplication(tx);
      await runChanges(tx, CHANGES);

      const [old] = await tx.select().from(application).where(eq(application.id, pinned));
      expect(old!.formVersionId).toBe(before.id);
      const oldForm = await loadApplicationForm(tx, pinned);
      expect(oldForm!.questions.map((q) => q.questionKey)).not.toContain("best_boss_blue");

      const fresh = await newApplication(tx);
      const [row] = await tx.select().from(application).where(eq(application.id, fresh));
      expect(row!.formVersionId).not.toBe(before.id);
      const form = await loadApplicationForm(tx, fresh);
      expect(form!.sections.at(-1)?.key).toBe("how_you_work");
      expect(form!.questions.filter((q) => q.sectionKey === "how_you_work").map((q) => q.questionKey)).toEqual(KEYS);
      // The applicant's copy of the form never carries the staff notes.
      expect(JSON.stringify(form)).not.toContain("Red flag");
      expect(JSON.stringify(form)).not.toContain("staffGuidance");
    });
  });

  it("shows staff the notes and the Blue check on the profile", async () => {
    await withRollback(db, async (tx) => {
      await runChanges(tx, CHANGES);
      const passes = await newApplication(tx);
      const fails = await newApplication(tx);
      const form = (await loadApplicationForm(tx, passes))!;
      const id = (key: string) => form.questions.find((q) => q.questionKey === key)!.questionVersionId;
      await saveAnswer(tx, { applicationId: passes, questionVersionId: id("best_boss_blue"), revision: 0, value: "Blue. Dana was fair and showed up." });
      await saveAnswer(tx, { applicationId: fails, questionVersionId: id("best_boss_blue"), revision: 0, value: "My best boss: Blue team lead Dana." });

      const profile = (await loadProfile(tx, passes, "hiring_manager"))!;
      const answers = Object.fromEntries(profile.answers.map((a) => [a.questionKey, a]));
      expect(answers.best_boss_blue).toMatchObject({ startsWith: "pass", value: "Blue. Dana was fair and showed up." });
      expect(answers.best_boss_blue!.staffGuidance).toContain("Pass or fail only");
      // Unanswered: notes but no badge. Seeded questions: neither.
      expect(answers.missed_commitment).toMatchObject({ startsWith: null, value: null });
      expect(answers.missed_commitment!.staffGuidance).toContain("Red flag");
      expect(answers.age_18_plus).toMatchObject({ startsWith: null, staffGuidance: null });

      const other = (await loadProfile(tx, fails, "viewer"))!;
      expect(other.answers.find((a) => a.questionKey === "best_boss_blue")!.startsWith).toBe("fail");
    });
  });

  it("acts as the earliest-created active Admin and fails loudly when there is none", async () => {
    await withRollback(db, async (tx) => {
      const elderId = uuidv7();
      await tx.insert(appUser).values({ id: elderId, email: "elder@example.test", role: "admin", createdAt: new Date("2020-01-01T00:00:00Z") });
      const disabledId = uuidv7();
      await tx
        .insert(appUser)
        .values({ id: disabledId, email: "gone@example.test", role: "admin", status: "disabled", createdAt: new Date("2019-01-01T00:00:00Z") });
      await runChanges(tx, CHANGES);
      const live = await publishedSnow(tx);
      expect(live.publishedBy?.id).toBe(elderId);
    });

    await withRollback(db, async (tx) => {
      await tx.update(appUser).set({ status: "disabled" }).where(eq(appUser.role, "admin"));
      await expect(runChanges(tx, CHANGES)).rejects.toThrow(/No active Admin/);
      expect(await tx.select().from(appliedChange)).toHaveLength(0);
    });
  });

  it("rolls a failing change back with its applied_change row", async () => {
    await withRollback(db, async (tx) => {
      const failing: Change = {
        id: "2099-01-01-fails",
        description: "Always fails",
        async run(inner) {
          await inner.insert(appliedChange).values({ id: "2099-01-01-side-effect", description: "should vanish" });
          throw new Error("boom");
        },
      };
      await expect(runChanges(tx, [failing])).rejects.toThrow(/2099-01-01-fails failed and was rolled back: boom/);
      expect(await tx.select().from(appliedChange)).toHaveLength(0);
    });
  });
});
