"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import type { UserRole } from "@/server/auth/roles";
import { staffActor } from "@/server/services/actor";
import { closeEntryCode, createEntryCode, reopenEntryCode } from "@/server/services/config/entry-codes-admin";
import { ConfigError } from "@/server/services/config/errors";
import { updateOpening } from "@/server/services/config/openings";
import {
  addPicklistOption,
  archivePicklistOption,
  PICKLIST_KEYS,
  unarchivePicklistOption,
  updatePicklistOption,
} from "@/server/services/config/picklists";
import { createSession, updateSession } from "@/server/services/config/sessions";
import { updateTextingSettings } from "@/server/services/config/texting";
import { addUser, changeUserRole, disableUser, enableUser } from "@/server/services/config/users-admin";

// Server actions for Settings, entry codes and group sessions. Each one checks the
// role with requireRole, validates the plain input with zod, calls a service and
// returns a result the client can show. Nothing here holds business rules.

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

const ADMIN: UserRole = "admin";
const STAFF: readonly UserRole[] = ["admin", "hiring_manager"];

function describe(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof NotSignedInError) return "You are signed out. Sign in again.";
  if (error instanceof AccessDeniedError) return error.message === "Access denied" ? "Only an Admin can do this." : error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the form and try again.";
  console.error("[settings action]", error);
  return "Something went wrong. Try again.";
}

async function run<T>(roles: UserRole | readonly UserRole[], fn: (actor: ReturnType<typeof staffActor>) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole(roles);
    return { ok: true, data: await fn(staffActor(user.id)) };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

const uuid = z.uuid({ message: "Something is missing from this form. Reload and try again." });
const optionalDate = z.string().trim().max(10).nullable();
const optionalText = z.string().trim().max(4000).nullable();
const optionalCount = z.number().int().min(0).nullable();

// ---------------------------------------------------------------------------
// Openings (Admin)

const openingPatchSchema = z.object({
  status: z.enum(["draft", "open", "closed"]),
  opensOn: optionalDate,
  closesOn: optionalDate,
  seasonStartOn: optionalDate,
  seasonEndOn: optionalDate,
  targetHeadcount: optionalCount,
  payText: optionalText,
  benefitsText: optionalText,
});

export async function updateOpeningAction(input: { id: string; patch: z.infer<typeof openingPatchSchema> }): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    const id = uuid.parse(input.id);
    const patch = openingPatchSchema.parse(input.patch);
    await updateOpening(db, { actor, id, patch });
    revalidatePath("/admin/settings/openings");
    return null;
  });
}

// ---------------------------------------------------------------------------
// Users (Admin)

const roleSchema = z.enum(["admin", "hiring_manager"], { message: "Pick Admin or Hiring Manager" });

export async function addUserAction(input: { email: string; role: string }): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    await addUser(db, { actor, email: z.string().trim().parse(input.email), role: roleSchema.parse(input.role) });
    revalidatePath("/admin/settings/users");
    return null;
  });
}

export async function changeUserRoleAction(input: { userId: string; role: string }): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    await changeUserRole(db, { actor, userId: uuid.parse(input.userId), role: roleSchema.parse(input.role) });
    revalidatePath("/admin/settings/users");
    return null;
  });
}

export async function disableUserAction(input: { userId: string }): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    await disableUser(db, { actor, userId: uuid.parse(input.userId) });
    revalidatePath("/admin/settings/users");
    return null;
  });
}

export async function enableUserAction(input: { userId: string }): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    await enableUser(db, { actor, userId: uuid.parse(input.userId) });
    revalidatePath("/admin/settings/users");
    return null;
  });
}

// ---------------------------------------------------------------------------
// Texting (Admin)

const textingSchema = z.object({
  smsEnabled: z.boolean(),
  helpContact: z.string().trim().max(300).nullable(),
  dailySendCap: z.number({ message: "Daily send cap must be a number" }).int(),
});

export async function updateTextingAction(input: z.infer<typeof textingSchema>): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    const parsed = textingSchema.parse(input);
    await updateTextingSettings(db, { actor, ...parsed });
    revalidatePath("/admin/settings/texting");
    return null;
  });
}

// ---------------------------------------------------------------------------
// Picklists (Admin)

const picklistKeySchema = z.enum(PICKLIST_KEYS as [string, ...string[]]);
const separationSchema = z.enum(["voluntary", "involuntary"]).nullable();

const addOptionSchema = z.object({
  listKey: picklistKeySchema,
  roleId: z.string().nullable(),
  key: z.string().trim(),
  label: z.string().trim(),
  requiresNote: z.boolean(),
  fcraAdverse: z.boolean(),
  defaultSeparation: separationSchema,
});

export async function addPicklistOptionAction(input: z.infer<typeof addOptionSchema>): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    const parsed = addOptionSchema.parse(input);
    await addPicklistOption(db, {
      actor,
      listKey: parsed.listKey as (typeof PICKLIST_KEYS)[number],
      roleId: parsed.roleId ? uuid.parse(parsed.roleId) : null,
      key: parsed.key,
      label: parsed.label,
      requiresNote: parsed.requiresNote,
      fcraAdverse: parsed.fcraAdverse,
      defaultSeparation: parsed.defaultSeparation,
    });
    revalidatePath("/admin/settings/picklists");
    return null;
  });
}

const updateOptionSchema = z.object({
  key: z.string().trim().optional(),
  label: z.string().trim().optional(),
  requiresNote: z.boolean().optional(),
  fcraAdverse: z.boolean().optional(),
  defaultSeparation: separationSchema.optional(),
});

export async function updatePicklistOptionAction(input: { id: string; patch: z.infer<typeof updateOptionSchema> }): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    await updatePicklistOption(db, { actor, id: uuid.parse(input.id), patch: updateOptionSchema.parse(input.patch) });
    revalidatePath("/admin/settings/picklists");
    return null;
  });
}

export async function archivePicklistOptionAction(input: { id: string }): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    await archivePicklistOption(db, { actor, id: uuid.parse(input.id) });
    revalidatePath("/admin/settings/picklists");
    return null;
  });
}

export async function unarchivePicklistOptionAction(input: { id: string }): Promise<ActionResult> {
  return run(ADMIN, async (actor) => {
    await unarchivePicklistOption(db, { actor, id: uuid.parse(input.id) });
    revalidatePath("/admin/settings/picklists");
    return null;
  });
}

// ---------------------------------------------------------------------------
// Entry codes (Admin and Hiring Manager)

const channelSchema = z.enum(["role_qr", "session_qr", "indeed_message", "job_posting", "flyer", "website", "other"], {
  message: "Pick a channel",
});

const createCodeSchema = z.object({
  label: z.string().trim(),
  channel: channelSchema,
  roleId: uuid,
  openingId: z.string().nullable(),
  groupSessionId: z.string().nullable(),
});

export async function createEntryCodeAction(input: z.infer<typeof createCodeSchema>): Promise<ActionResult<{ id: string; code: string }>> {
  return run(STAFF, async (actor) => {
    const parsed = createCodeSchema.parse(input);
    const row = await createEntryCode(db, {
      actor,
      label: parsed.label,
      channel: parsed.channel,
      roleId: parsed.roleId,
      openingId: parsed.openingId ? uuid.parse(parsed.openingId) : null,
      groupSessionId: parsed.groupSessionId ? uuid.parse(parsed.groupSessionId) : null,
    });
    revalidatePath("/admin/codes");
    if (row.groupSessionId) revalidatePath(`/admin/sessions/${row.groupSessionId}`);
    return { id: row.id, code: row.code };
  });
}

export async function closeEntryCodeAction(input: { id: string }): Promise<ActionResult> {
  return run(STAFF, async (actor) => {
    const row = await closeEntryCode(db, { actor, id: uuid.parse(input.id) });
    revalidatePath("/admin/codes");
    if (row.groupSessionId) revalidatePath(`/admin/sessions/${row.groupSessionId}`);
    return null;
  });
}

export async function reopenEntryCodeAction(input: { id: string }): Promise<ActionResult> {
  return run(STAFF, async (actor) => {
    const row = await reopenEntryCode(db, { actor, id: uuid.parse(input.id) });
    revalidatePath("/admin/codes");
    if (row.groupSessionId) revalidatePath(`/admin/sessions/${row.groupSessionId}`);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Group sessions (Admin and Hiring Manager)

// The browser posts an instant (ISO string), never a wall-clock string.
const instant = z.iso.datetime({ offset: true, message: "Enter the date and time" }).transform((value) => new Date(value));

const sessionFieldsSchema = z.object({
  openingId: uuid,
  startsAt: instant,
  locationName: z.string().trim(),
  locationAddress: z.string().trim().max(300).nullable(),
  invitedCount: optionalCount,
  attendedCount: optionalCount,
  notes: optionalText,
});

export async function createSessionAction(input: z.input<typeof sessionFieldsSchema>): Promise<ActionResult<{ id: string }>> {
  return run(STAFF, async (actor) => {
    const parsed = sessionFieldsSchema.parse(input);
    const created = await createSession(db, { actor, ...parsed });
    revalidatePath("/admin/sessions");
    revalidatePath("/admin/codes");
    return { id: created.id };
  });
}

const sessionPatchSchema = sessionFieldsSchema.extend({ status: z.enum(["scheduled", "held", "canceled"]) }).partial();

export async function updateSessionAction(input: { id: string; patch: z.input<typeof sessionPatchSchema> }): Promise<ActionResult> {
  return run(STAFF, async (actor) => {
    const id = uuid.parse(input.id);
    const patch = sessionPatchSchema.parse(input.patch);
    await updateSession(db, { actor, id, patch });
    revalidatePath("/admin/sessions");
    revalidatePath(`/admin/sessions/${id}`);
    revalidatePath("/admin/codes");
    return null;
  });
}
