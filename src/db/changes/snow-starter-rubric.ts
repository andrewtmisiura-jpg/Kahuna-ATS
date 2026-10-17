import { and, eq, inArray, isNull } from "drizzle-orm";
import { question, role, rubric } from "@/db/schema";
import { ensureRubricDraft, publishRubricVersion, saveRubricDraft, setScoringMode, type RubricCriterionInput } from "@/server/services/scoring/rubrics";
import { addTestCase, type TestCaseVariant } from "@/server/services/scoring/test-cases";
import type { Change } from "./types";
import { SNOW_ROLE_KEY } from "./snow-behavioral-questions";

// The owner asked for snow to be scored now, in visible mode (Oct 16, 2026). This is the
// starter rubric, written from the staff notes on the owner's behavioral questions
// (snow-behavioral-questions.ts): four criteria, one per question, weighted by how strong
// a signal each is, and a short list of job-related flags. It goes through the rubric
// editor's services, so versioning, publishing and audit rules apply as on screen. The
// Blue question is not scored: its check is code-only and already shows as a badge. Two
// groups of made-up sample answers, each written three ways, seed Try it.

export const SNOW_STARTER_CHANGE_REASON =
  "Starter rubric from the owner's notes on the snow questions (Oct 16, 2026). The owner asked for snow to be scored.";

export const SNOW_STARTER_INSTRUCTIONS = [
  "These answers come from people applying to be on-call snow removal technicians: shoveling and running snow equipment outdoors, often overnight or before sunrise.",
  "Reward specific, real examples over general statements. Applicants were told a few sentences is plenty and spelling and grammar don't matter, so judge only what they did.",
  "For Integrity, grade only how they handled the work mistake and ignore anything about health, family or legal matters.",
  "Problem solving comes from a what-would-you-do question, so grade the plan they describe; it is the weakest signal of the four.",
].join(" ");

export const SNOW_STARTER_FLAGS = [
  { key: "no_call_no_show", label: "Describes missing work without telling anyone" },
  { key: "blames_others", label: "Blames others for their own mistake" },
  { key: "hid_mistake", label: "Hid or ignored a mistake" },
  { key: "left_job_unfinished", label: "Would leave a job unfinished without telling anyone" },
  { key: "unsafe_shortcut", label: "Describes an unsafe shortcut" },
] as const;

type StarterCriterion = Omit<RubricCriterionInput, "questionIds" | "criterionId"> & { key: string; questionKey: string };

export const SNOW_STARTER_CRITERIA: readonly StarterCriterion[] = [
  {
    key: "reliability",
    name: "Reliability",
    questionKey: "missed_commitment",
    weight: 30,
    guidanceStrong: "Tells a specific story about a shift or commitment they missed, let people know early, and owns what happened.",
    guidanceAcceptable: "Gives a real example, but it is vague or the notice came late. They still let people know.",
    guidanceWeak: "Says it has never happened, gives no real example, blames someone else, or did not tell anyone.",
  },
  {
    key: "integrity",
    name: "Integrity",
    questionKey: "unnoticed_mistake",
    weight: 25,
    guidanceStrong: "Names a real mistake at work and fixed it or reported it, even though that cost them time, money or embarrassment.",
    guidanceAcceptable: "Names a real mistake and fixed it, but the example is small or vague.",
    guidanceWeak: "Can't name a mistake, talks about what they would do instead of a real example, or hid or ignored the mistake.",
  },
  {
    key: "work_ethic",
    name: "Work ethic",
    questionKey: "hardest_physical_job",
    weight: 30,
    guidanceStrong: "Gives concrete details of hard physical work, finished the job and stuck with it for a good while.",
    guidanceAcceptable: "Describes real physical work with some detail, but it is unclear how long they stayed or whether they finished.",
    guidanceWeak: "Vague, quit quickly, or mostly complains about the boss or coworkers.",
  },
  {
    key: "problem_solving",
    name: "Problem solving",
    questionKey: "forgot_equipment",
    weight: 15,
    guidanceStrong: "Tells the customer what is going on, finishes what they can, keeps trying the manager by call or text, and offers options.",
    guidanceAcceptable: "Has a sensible plan, such as finishing what they can and trying the manager, but leaves out the customer or other options.",
    guidanceWeak: "Leaves without telling anyone, or just goes home.",
  },
];

// Made up, with no names or numbers. Each group says the same thing three ways, so Try it
// shows whether the rubric grades the behavior rather than the writing.
export const SNOW_STARTER_TEST_CASES: readonly { groupKey: string; variant: TestCaseVariant; answers: Record<string, string> }[] = [
  {
    groupKey: "solid_answers",
    variant: "standard",
    answers: {
      missed_commitment:
        "Last winter I woke up sick on the morning of a shift. I called my lead before the crew left the shop, said I couldn't make it, and offered to cover a shift later that week. I covered it.",
      unnoticed_mistake:
        "I once forgot to salt a side entrance on my route. Nobody noticed, but I went back on my own time after the route, salted it and told my supervisor right away.",
      hardest_physical_job:
        "Roofing in the summer. Carrying bundles up a ladder all day in the heat was hard on my body. I stayed the whole season and finished every job we started.",
      forgot_equipment:
        "I would tell the customer what happened, finish everything I could with what I had, and keep calling and texting my manager. If I still couldn't reach anyone, I'd ask the customer whether they want me back today or tomorrow.",
    },
  },
  {
    groupKey: "solid_answers",
    variant: "broken_english",
    answers: {
      missed_commitment:
        "Last winter I am sick in the morning of my shift. I call my lead before crew leave the shop, I say I cannot come and I work other day for this. I work that day.",
      unnoticed_mistake: "One time I forget put salt on side door. Nobody see it but I go back after my route, on my time, I put the salt and I tell supervisor.",
      hardest_physical_job: "Roof work in summer. Carry heavy bundle up ladder all day in hot sun, very hard. I stay all season and finish every job.",
      forgot_equipment: "I tell customer what happen, I finish all I can with what I have, I keep call and text my manager. If nobody answer I ask customer I come back today or tomorrow.",
    },
  },
  {
    groupKey: "solid_answers",
    variant: "short",
    answers: {
      missed_commitment: "Got sick, called my lead before the crew left, made up the shift later.",
      unnoticed_mistake: "Missed salting a door. Went back on my own time and told my boss.",
      hardest_physical_job: "Roofing all summer. Hot and heavy. Stayed to the end.",
      forgot_equipment: "Tell the customer, finish what I can, keep calling the manager.",
    },
  },
  {
    groupKey: "red_flag_answers",
    variant: "standard",
    answers: {
      missed_commitment: "That has never happened to me. I have never missed anything I agreed to.",
      unnoticed_mistake: "I can't think of one. If I made a mistake I would probably fix it.",
      hardest_physical_job: "Warehouse work, I guess. The boss was always on us and the others were lazy, so I left after a little while.",
      forgot_equipment: "I would just go home and finish it another day. The manager should have answered.",
    },
  },
  {
    groupKey: "red_flag_answers",
    variant: "broken_english",
    answers: {
      missed_commitment: "This never happen to me. I never miss nothing.",
      unnoticed_mistake: "I don't know one. If I make mistake maybe I fix it.",
      hardest_physical_job: "Warehouse I think. Boss always angry and other workers lazy so I leave fast.",
      forgot_equipment: "I go home and do it other day. Manager must answer the phone.",
    },
  },
  {
    groupKey: "red_flag_answers",
    variant: "short",
    answers: {
      missed_commitment: "Never happened.",
      unnoticed_mistake: "Can't think of one.",
      hardest_physical_job: "Warehouse. Bad boss, left soon.",
      forgot_equipment: "Go home, finish later.",
    },
  },
];

export const snowStarterRubric: Change = {
  id: "2026-10-16-snow-starter-rubric",
  description: "Snow removal: publish the starter AI scoring rubric from the owner's notes as version 1, turn scoring to visible, and add two Try it sample groups",
  async run(tx, ctx) {
    const [snow] = await tx
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.key, SNOW_ROLE_KEY), isNull(role.archivedAt)));
    if (!snow) throw new Error(`The snow removal role (${SNOW_ROLE_KEY}) does not exist. Run \`pnpm db:seed\` first.`);

    // Whatever an Admin already wrote wins: this change never touches an existing rubric.
    const [existing] = await tx.select({ id: rubric.id }).from(rubric).where(eq(rubric.roleId, snow.id));
    if (existing) {
      ctx.log("snow removal already has a rubric, so nothing was changed; edit it in Settings, AI scoring");
      return;
    }

    const keys = SNOW_STARTER_CRITERIA.map((criterion) => criterion.questionKey);
    const lineages = await tx
      .select({ id: question.id, key: question.key })
      .from(question)
      .where(and(eq(question.roleId, snow.id), inArray(question.key, keys)));
    const idByKey = new Map(lineages.map((lineage) => [lineage.key, lineage.id]));
    const missing = keys.filter((key) => !idByKey.has(key));
    if (missing.length > 0) {
      throw new Error(`The snow removal questions ${missing.join(", ")} do not exist; the snow behavioral questions change must run first.`);
    }

    const draft = await ensureRubricDraft(tx, { roleId: snow.id, actor: ctx.actor });
    await saveRubricDraft(tx, {
      rubricVersionId: draft.id,
      instructions: SNOW_STARTER_INSTRUCTIONS,
      allowedFlags: [...SNOW_STARTER_FLAGS],
      criteria: SNOW_STARTER_CRITERIA.map(({ questionKey, ...criterion }) => ({ ...criterion, questionIds: [idByKey.get(questionKey)!] })),
      actor: ctx.actor,
    });
    const published = await publishRubricVersion(tx, { rubricVersionId: draft.id, changeReason: SNOW_STARTER_CHANGE_REASON, actor: ctx.actor });
    ctx.log(`snow removal rubric version ${published.version} published: ${SNOW_STARTER_CRITERIA.map((c) => `${c.name} ${c.weight}`).join(", ")}`);

    await setScoringMode(tx, { roleId: snow.id, mode: "visible", actor: ctx.actor });
    ctx.log("snow removal scoring is visible; the next cron pass queues a score for each submitted application, up to the daily limit");

    for (const testCase of SNOW_STARTER_TEST_CASES) {
      await addTestCase(tx, { rubricId: draft.rubricId, ...testCase, actor: ctx.actor });
    }
    ctx.log(`Try it samples added: ${[...new Set(SNOW_STARTER_TEST_CASES.map((c) => c.groupKey))].join(" and ")}, each standard, broken English and short`);
  },
};
