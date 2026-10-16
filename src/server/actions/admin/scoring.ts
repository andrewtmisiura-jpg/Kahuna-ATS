"use server";

import { z } from "zod";
import { db } from "@/db";
import { requireRole } from "@/server/auth/require-role";
import type { SessionUser } from "@/server/auth/session";
import { ScoringRequestError } from "@/server/services/scoring/errors";
import { requestRescore, type RescoreRequestResult } from "@/server/services/scoring/jobs";
import { enqueueRescore, type RescoreResult } from "@/server/services/scoring/rescore";
import { toActionFailure, type ActionResult } from "./application-errors";

// Re-scoring, Admin only: Hiring Managers and Viewers see scores but never ask for one.
// Each action starts with requireRole and hands the work to the scoring service, which
// queues jobs for the cron and audits the request. Nothing here calls the model.

async function run<T>(fn: (user: SessionUser) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole("admin");
    return { ok: true, data: await fn(user) };
  } catch (error) {
    if (error instanceof ScoringRequestError) {
      return { ok: false, status: error.code === "application_not_found" ? 404 : 400, code: error.code, message: error.message };
    }
    return toActionFailure(error);
  }
}

// "Re-score" on the profile's AI score panel: one job, run within five minutes.
export async function rescoreApplicationAction(raw: { applicationId: string }): Promise<ActionResult<RescoreRequestResult>> {
  return run(async (user) => {
    const input = z.object({ applicationId: z.uuid() }).parse(raw);
    return requestRescore(db, { applicationId: input.applicationId, actorUserId: user.id });
  });
}

// Re-score every submitted application of a role against its published rubric version,
// for Settings > AI scoring after a new version is published.
export async function rescoreRoleAction(raw: { roleId: string }): Promise<ActionResult<RescoreResult>> {
  return run(async (user) => {
    const input = z.object({ roleId: z.uuid() }).parse(raw);
    return enqueueRescore(db, { roleId: input.roleId, actorUserId: user.id });
  });
}
