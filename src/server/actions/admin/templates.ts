"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import { staffActor } from "@/server/services/actor";
import type { TemplateIssue } from "@/server/services/messaging/template-text";
import { setBookingLink, TemplateError, updateTemplate } from "@/server/services/messaging/templates";

// Settings > Message templates. Admins edit the Phase 2 templates and the booking link;
// Hiring Managers only read the page. Each action checks the role with requireRole,
// validates the plain input and hands the rules to the templates service.

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string; issues?: TemplateIssue[] };

function failure(error: unknown): { ok: false; error: string; issues?: TemplateIssue[] } {
  if (error instanceof TemplateError) return { ok: false, error: error.message, issues: error.issues.length > 0 ? error.issues : undefined };
  if (error instanceof NotSignedInError) return { ok: false, error: "You are signed out. Sign in again." };
  if (error instanceof AccessDeniedError) return { ok: false, error: error.message === "Access denied" ? "Only an Admin can do this." : error.message };
  if (error instanceof z.ZodError) return { ok: false, error: error.issues[0]?.message ?? "Check the form and try again." };
  console.error("[templates action]", error);
  return { ok: false, error: "Something went wrong. Try again." };
}

const templateSchema = z.object({
  templateId: z.uuid({ message: "Something is missing from this form. Reload and try again." }),
  name: z.string().max(500),
  subject: z.string().max(1000).nullable(),
  body: z.string().max(20_000),
});

export async function updateTemplateAction(input: z.input<typeof templateSchema>): Promise<ActionResult> {
  try {
    const user = await requireRole("admin");
    await updateTemplate(db, { ...templateSchema.parse(input), actor: staffActor(user.id) });
    revalidatePath("/admin/settings/templates");
    return { ok: true, data: null };
  } catch (error) {
    return failure(error);
  }
}

export async function setBookingLinkAction(input: { url: string | null }): Promise<ActionResult<{ url: string | null }>> {
  try {
    const user = await requireRole("admin");
    const url = await setBookingLink(db, { url: z.string().max(2000).nullable().parse(input.url), actor: staffActor(user.id) });
    revalidatePath("/admin/settings/templates");
    return { ok: true, data: { url } };
  } catch (error) {
    return failure(error);
  }
}
