import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { pipelineStage, role } from "@/db/schema";
import { archiveStage, StageError } from "@/server/services/config/stages";
import { SNOW_ROLE_KEY } from "./snow-behavioral-questions";
import type { Change } from "./types";

// Snow removal does not do one-on-one interviews (owner, Oct 19, 2026): people go from
// the group interview to an offer, often the same day with Hire now. This archives the
// snow pipeline's one-on-one stages through the stage editor's service, so the board
// and the Move dialog stop offering them and no one-on-one invite is ever offered for
// snow. A stage that holds an open application is left alone and logged. An Admin can
// bring a stage back in Settings > Roles and stages.

const ONE_ON_ONE_MILESTONES = ["interview_invited", "interviewed"] as const;

export const snowNoOneOnOne: Change = {
  id: "2026-10-19-snow-no-one-on-one",
  description: "Snow removal: archive the one-on-one interview stages, since snow hires skip the one-on-one",
  async run(tx, ctx) {
    const [snow] = await tx
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.key, SNOW_ROLE_KEY), isNull(role.archivedAt)));
    if (!snow) throw new Error(`The snow removal role (${SNOW_ROLE_KEY}) does not exist. Run \`pnpm db:seed\` first.`);

    const stages = await tx
      .select({ id: pipelineStage.id, name: pipelineStage.name })
      .from(pipelineStage)
      .where(
        and(eq(pipelineStage.roleId, snow.id), isNull(pipelineStage.archivedAt), inArray(pipelineStage.milestone, [...ONE_ON_ONE_MILESTONES])),
      )
      .orderBy(asc(pipelineStage.sortOrder));
    if (stages.length === 0) {
      ctx.log("snow removal has no one-on-one stages left, nothing to archive");
      return;
    }

    for (const stage of stages) {
      try {
        await archiveStage(tx, { actor: ctx.actor, stageId: stage.id });
        ctx.log(`snow removal stage "${stage.name}" archived`);
      } catch (error) {
        if (!(error instanceof StageError)) throw error;
        ctx.log(`snow removal stage "${stage.name}" kept: ${error.message}`);
      }
    }
  },
};
