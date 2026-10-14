"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { application, role } from "@/db/schema";
import { AnswersError, saveAnswer, submitApplication, type AnswerValue } from "@/server/services/applications/answers";
import { getProviders } from "@/server/services/messaging/providers";
import { processMessages } from "@/server/services/messaging/send";
import { sourceKey, sourceTakesDetail } from "@/components/applicant/sources";
import { currentApplicationId } from "./session";

// Autosave and submit for the application the session cookie is bound to.

const answerValue: z.ZodType<AnswerValue> = z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(100)).max(50), z.null()]);

const saveInput = z.object({
  questionVersionId: z.string().uuid(),
  revision: z.number().int().min(0),
  value: answerValue,
});

export type SaveState =
  | { ok: true; revision: number; value: AnswerValue }
  | { ok: false; reason: "stale"; revision: number; value: AnswerValue }
  | { ok: false; reason: "locked" | "invalid" | "no_session" | "error"; message: string };

export async function saveAnswerAction(raw: unknown): Promise<SaveState> {
  const parsed = saveInput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid", message: "That answer could not be read" };
  const applicationId = await currentApplicationId();
  if (!applicationId) return { ok: false, reason: "no_session", message: "Your link has expired" };
  try {
    const result = await saveAnswer(db, { applicationId, ...parsed.data });
    return result.ok
      ? { ok: true, revision: result.revision, value: result.value }
      : { ok: false, reason: "stale", revision: result.revision, value: result.value };
  } catch (error) {
    if (error instanceof AnswersError) {
      if (error.code === "answers_locked" || error.code === "application_not_open" || error.code === "already_submitted") {
        return { ok: false, reason: "locked", message: "This application was already sent" };
      }
      if (error.code === "invalid_value" || error.code === "question_not_in_form") {
        return { ok: false, reason: "invalid", message: error.message };
      }
      if (error.code === "application_not_found") return { ok: false, reason: "no_session", message: "Your link has expired" };
    }
    console.error("[autosave] failed", error);
    return { ok: false, reason: "error", message: "Not saved" };
  }
}

const submitInput = z.object({
  pending: z.array(saveInput).max(100).default([]),
  source: z
    .object({ source: z.string().max(40), sourceDetail: z.string().max(200).optional() })
    .nullable()
    .optional(),
});

export type SubmitState =
  | { ok: true }
  | { ok: false; reason: "required_missing"; missing: string[] }
  | { ok: false; reason: "already_submitted" | "closed" | "invalid" | "no_session" | "error"; message: string };

export async function submitAction(raw: unknown): Promise<SubmitState> {
  const parsed = submitInput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid", message: "The form could not be read" };
  const applicationId = await currentApplicationId();
  if (!applicationId) return { ok: false, reason: "no_session", message: "Your link has expired" };

  const [row] = await db
    .select({ employerId: role.employerId })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .where(eq(application.id, applicationId));
  if (!row) return { ok: false, reason: "no_session", message: "Your link has expired" };

  const source = sourceKey(parsed.data.source?.source);
  try {
    const result = await submitApplication(db, {
      applicationId,
      employerId: row.employerId,
      pending: parsed.data.pending,
      source: source
        ? { source, sourceDetail: sourceTakesDetail(source) ? (parsed.data.source?.sourceDetail ?? null) : null }
        : null,
    });
    try {
      await processMessages(db, result.queued, getProviders());
    } catch (error) {
      console.error("[submit] sending the confirmation failed", error);
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof AnswersError) {
      switch (error.code) {
        case "required_missing":
          return { ok: false, reason: "required_missing", missing: (error.details.missing as string[] | undefined) ?? [] };
        case "already_submitted":
        case "answers_locked":
          return { ok: false, reason: "already_submitted", message: "This application was already sent" };
        case "application_not_open":
          return { ok: false, reason: "closed", message: "This application is closed" };
        case "invalid_value":
        case "question_not_in_form":
          return { ok: false, reason: "invalid", message: error.message };
        case "application_not_found":
          return { ok: false, reason: "no_session", message: "Your link has expired" };
      }
    }
    console.error("[submit] failed", error);
    return { ok: false, reason: "error", message: "Something went wrong on our side. Please try again." };
  }
}
