import { and, eq, isNull } from "drizzle-orm";
import { formVersion, role } from "@/db/schema";
import { addQuestion, addSection, ensureDraft } from "@/server/services/forms/editor";
import { publishForm } from "@/server/services/forms/publish";
import type { Change } from "./types";

// The owner's five behavioral questions for snow removal (Oct 16, 2026), with
// staff notes on what to look for. Goes through the question editor's services,
// so versioning, publishing and audit rules all apply: a draft from the live
// form, a new "How you work" section at the end, five required long answers, then
// a publish. Applications already started keep the version they pinned.

export const SNOW_ROLE_KEY = "snow_removal_tech";
export const HOW_YOU_WORK_SECTION = {
  key: "how_you_work",
  title: "How you work",
  intro: "A few sentences is plenty. Spelling and grammar don't matter.",
} as const;

export const SNOW_BEHAVIORAL_CHANGE_REASON =
  "Owner added five behavioral questions on reliability, integrity, work ethic, following directions and problem solving (Oct 16, 2026).";

export type BehavioralQuestion = { key: string; prompt: string; staffGuidance: string; startsWithCheck: string | null };

// In the owner's order. Prompts are the owner's wording; question 4 keeps its
// instruction in plain text so it tests whether the applicant read it.
export const SNOW_BEHAVIORAL_QUESTIONS: readonly BehavioralQuestion[] = [
  {
    key: "missed_commitment",
    prompt:
      "Tell us about the last time you couldn't make it to a shift or commitment you'd agreed to. What happened, and when and how did you let people know?",
    staffGuidance: [
      "Strong: specific story, gave early notice, owns it.",
      "Red flag: \"That's never happened\" (unlikely to be true) or blaming someone else.",
    ].join("\n"),
    startsWithCheck: null,
  },
  {
    key: "unnoticed_mistake",
    prompt: "Describe a mistake you made at work that nobody else noticed. What did you do about it?",
    staffGuidance: [
      "Strong: fixed or reported it even though it cost them something.",
      "Red flag: can't name one, or switches to \"I would...\" instead of a real example.",
      "Score only how they handled the work mistake. Ignore anything about health, family or legal matters.",
    ].join("\n"),
    startsWithCheck: null,
  },
  {
    key: "hardest_physical_job",
    prompt: "What's the hardest physical job you've done? What made it hard, and how long did you stick with it?",
    staffGuidance: [
      "Strong: concrete details, finished the job, stayed a while.",
      "Red flag: vague, quit fast, complains about the boss or coworkers.",
    ].join("\n"),
    startsWithCheck: null,
  },
  {
    key: "best_boss_blue",
    prompt: "In 2 to 3 sentences, tell us about the best boss you've ever had. Start your answer with the word 'Blue.'",
    staffGuidance: "Pass or fail only: did they start with the word Blue? The content barely matters. Treat a fail as a signal, not an automatic reject.",
    startsWithCheck: "blue",
  },
  {
    key: "forgot_equipment",
    prompt:
      "You're working a job alone, halfway done, and realize you forgot equipment you need to finish. The shop is 40 minutes away and your manager isn't answering. What do you do?",
    staffGuidance: [
      "Strong: tells the customer, finishes what they can, keeps trying the manager or texts, offers options.",
      "Red flag: leaves without telling anyone, or just goes home.",
      "Hypothetical question, so a weaker signal than the other four.",
    ].join("\n"),
    startsWithCheck: null,
  },
];

export const snowBehavioralQuestions: Change = {
  id: "2026-10-16-snow-behavioral-questions",
  description: "Snow removal: add the owner's five behavioral questions in a new How you work section and publish the next form version",
  async run(tx, ctx) {
    const [snow] = await tx
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.key, SNOW_ROLE_KEY), isNull(role.archivedAt)));
    if (!snow) throw new Error(`The snow removal role (${SNOW_ROLE_KEY}) does not exist. Run \`pnpm db:seed\` first.`);

    // The editor's ensureDraft locks this row before it looks for or starts a draft.
    // Taking the same lock first means a draft someone starts while this runs either
    // exists by the check below (and the change refuses) or waits until it commits,
    // so the change never fills and publishes someone else's draft.
    await tx.select({ id: role.id }).from(role).where(eq(role.id, snow.id)).for("update");

    const versions = await tx
      .select({ version: formVersion.version, status: formVersion.status })
      .from(formVersion)
      .where(eq(formVersion.roleId, snow.id));
    const draft = versions.find((v) => v.status === "draft");
    if (draft) {
      throw new Error(
        `The snow removal form has an unpublished draft (version ${draft.version}). Publish or discard it in the question editor, then run this again. ` +
          "This change will not mix its questions into someone's unpublished edits.",
      );
    }
    if (!versions.some((v) => v.status === "published")) {
      throw new Error("The snow removal form has no published version to start from.");
    }

    const created = await ensureDraft(tx, { roleId: snow.id, actor: ctx.actor });
    ctx.log(`draft version ${created.version} started from the live form`);
    await addSection(tx, { formVersionId: created.id, ...HOW_YOU_WORK_SECTION, actor: ctx.actor });
    for (const q of SNOW_BEHAVIORAL_QUESTIONS) {
      await addQuestion(tx, {
        formVersionId: created.id,
        sectionKey: HOW_YOU_WORK_SECTION.key,
        key: q.key,
        type: "long_text",
        prompt: q.prompt,
        required: true,
        aiNeverSend: false,
        staffGuidance: q.staffGuidance,
        startsWithCheck: q.startsWithCheck,
        actor: ctx.actor,
      });
    }
    ctx.log(`section ${HOW_YOU_WORK_SECTION.key} added with ${SNOW_BEHAVIORAL_QUESTIONS.map((q) => q.key).join(", ")}`);

    const published = await publishForm(tx, { formVersionId: created.id, changeReason: SNOW_BEHAVIORAL_CHANGE_REASON, actor: ctx.actor });
    ctx.log(
      `snow removal form version ${published.version} published` +
        (published.previous ? `; applications already started keep version ${published.previous.version}` : ""),
    );
  },
};
