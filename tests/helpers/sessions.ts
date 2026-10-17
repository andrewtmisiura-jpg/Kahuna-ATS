import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { appUser, auditLog, groupSession, opening, role } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { SessionStaff } from "@/server/services/sessions/errors";
import { createApplication, createPerson, nextMobile, type SnowFixture } from "./fixtures";

// Group session rows for the sessions-* tests, written straight to the tables. No
// entry codes, since the seed test counts those; extra staff users only inside a
// rolled-back transaction, since it counts users too.

type SessionStatus = (typeof groupSession.$inferSelect)["status"];

export async function createSessionAt(
  db: Db,
  openingId: string,
  createdBy: string,
  startsAt: Date = new Date(),
  status: SessionStatus = "held",
): Promise<string> {
  const id = uuidv7();
  await db.insert(groupSession).values({ id, openingId, startsAt, locationName: "Golden Valley shop", status, createdBy });
  return id;
}

// A last name no other test file uses, so name suggestions only find this test's people.
export function uniqueLastName(base: string): string {
  const letters = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
  return `${base}${letters}`;
}

export type Applicant = { personId: string; applicationId: string; mobile: string; firstName: string; lastName: string };

// A person with a started snow application.
export async function createApplicant(db: Db, snow: SnowFixture, values: { firstName?: string; lastName?: string; mobile?: string } = {}): Promise<Applicant> {
  const firstName = values.firstName ?? "Jordan";
  const lastName = values.lastName ?? uniqueLastName("Applicant");
  const mobile = values.mobile ?? nextMobile();
  const personId = await createPerson(db, { firstName, lastName, mobileE164: mobile });
  const { applicationId } = await createApplication(db, snow, personId);
  return { personId, applicationId, mobile, firstName, lastName };
}

// The seeded window opening (a draft), for checking nothing links across openings.
export async function loadWindowOpening(db: Db): Promise<string> {
  const [row] = await db
    .select({ id: opening.id })
    .from(opening)
    .innerJoin(role, eq(role.id, opening.roleId))
    .where(eq(role.key, "window_cleaning_tech"));
  if (!row) throw new Error("window opening missing: run the seed first");
  return row.id;
}

// A second staff member with the given role; call it inside withRollback.
export async function createStaff(db: Db, staffRole: SessionStaff["role"]): Promise<SessionStaff> {
  const id = uuidv7();
  await db.insert(appUser).values({ id, email: `staff-${id}@example.test`, name: "Second Staffer", role: staffRole });
  return { userId: id, role: staffRole };
}

// "(612) 555-0123" for a +1 number, the way staff type it from a sheet.
export function typed(e164: string): string {
  return `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
}

export async function auditActions(db: Db, entityId: string): Promise<string[]> {
  const rows = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(auditLog.occurredAt, auditLog.id);
  return rows.map((r) => r.action);
}

export async function latestAudit(db: Db, entityId: string, action: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action)))
    .orderBy(auditLog.occurredAt, auditLog.id);
  return rows[rows.length - 1] ?? null;
}
