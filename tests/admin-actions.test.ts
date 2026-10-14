import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { db, sql } from "@/db";
import { appUser, auditLog, consentEvent, landingConflict, message, note, person, resumeToken, suppression } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { toActionFailure } from "@/server/actions/admin/application-errors";
import { AccessDeniedError, NotSignedInError } from "@/server/auth/authorize";
import { addNote, deleteNote, editNote, NoteError } from "@/server/services/applications/notes";
import { loadProfile } from "@/server/services/applications/queries";
import { RecordError, updateBackgroundCheck, updateHireStint, updateOffer } from "@/server/services/applications/records";
import { createApplication, StaleVersionError, transition, TransitionError } from "@/server/services/applications/transition";
import { LandingError } from "@/server/services/landing";
import { SuppressionLiftRefused } from "@/server/services/messaging/consent";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { SendError } from "@/server/services/messaging/send";
import {
  deleteTestApplication,
  markTextHandled,
  PersonError,
  recordStopRequest,
  resendApplicationLink,
  resolveLandingConflict,
  setDoNotContact,
  updateContact,
  updateIndeedAppliedOn,
} from "@/server/services/people";
import { createPerson, loadAdminId, loadOption, loadSnow, loadStages, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

let snow: SnowFixture;
let stages: Record<string, string>;
let adminId: string;
let managerId: string;
let staff: { type: "staff"; userId: string };
const applicant = { type: "applicant" } as const;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  adminId = await loadAdminId(db);
  staff = { type: "staff", userId: adminId };
  managerId = uuidv7();
  await db.insert(appUser).values({ id: managerId, email: `manager-${managerId}@example.test`, role: "hiring_manager", name: "Morgan Manager" });
});

afterAll(async () => {
  await sql.end();
});

async function newApplication(options: { submit?: boolean; email?: string | null } = {}) {
  const personId = await createPerson(db, options.email === null ? { email: null, emailNormalized: null } : {});
  const { applicationId } = await createApplication(db, {
    personId,
    openingId: snow.openingId,
    origin: "landing",
    entryChannel: "role_qr",
    actor: applicant,
  });
  if (options.submit !== false) await transition(db, { action: "submit", applicationId, actor: applicant });
  return { applicationId, personId };
}

async function audits(applicationId: string) {
  return db.select().from(auditLog).where(eq(auditLog.applicationId, applicationId)).orderBy(desc(auditLog.occurredAt));
}

describe("action error mapping", () => {
  it("maps each error class to a status and code", () => {
    const stale = toActionFailure(new StaleVersionError(2, 3, { userId: adminId, name: "Pat", email: "pat@example.test" }, new Date("2026-10-14T15:00:00Z")));
    expect(stale).toMatchObject({ ok: false, status: 409, code: "stale_version", stale: { changedBy: "Pat", changedAt: "2026-10-14T15:00:00.000Z" } });
    expect(stale.message).toContain("Pat");

    const anonymous = toActionFailure(new StaleVersionError(2, 3, null, new Date()));
    expect(anonymous.stale?.changedBy).toBe("the applicant or the system");

    expect(toActionFailure(new NotSignedInError())).toMatchObject({ status: 401, code: "not_signed_in" });
    expect(toActionFailure(new AccessDeniedError())).toMatchObject({ status: 403, code: "access_denied" });
    expect(toActionFailure(new TransitionError("fcra_waiting_period", "wait", { earliest: "2026-10-21", previousOccurredAt: new Date("2026-10-14T00:00:00Z") }))).toEqual({
      ok: false,
      status: 400,
      code: "fcra_waiting_period",
      message: "wait",
      details: { earliest: "2026-10-21", previousOccurredAt: "2026-10-14T00:00:00.000Z" },
    });
    expect(toActionFailure(new TransitionError("application_not_found", "gone"))).toMatchObject({ status: 404 });
    expect(toActionFailure(new NoteError("body_required", "Write something"))).toMatchObject({ status: 400, code: "body_required" });
    expect(toActionFailure(new PersonError("person_not_found", "gone"))).toMatchObject({ status: 404, code: "person_not_found" });
    expect(toActionFailure(new RecordError("pre_adverse_locked", "locked"))).toMatchObject({ status: 400, code: "pre_adverse_locked" });
    expect(toActionFailure(new LandingError("invalid_mobile", "bad"))).toMatchObject({ status: 400, code: "invalid_mobile" });
    expect(toActionFailure(new SendError("link_rate_limited", "slow down"))).toMatchObject({ status: 400, code: "link_rate_limited" });
    expect(toActionFailure(new SuppressionLiftRefused("stop_keyword"))).toMatchObject({ status: 400, code: "suppression_lift_refused" });
  });

  it("turns a validation failure into a readable 400 and anything else into a 500", () => {
    const parsed = z.object({ applicationId: z.uuid() }).safeParse({ applicationId: "nope" });
    const failure = toActionFailure(parsed.error);
    expect(failure).toMatchObject({ status: 400, code: "invalid_input" });
    expect(failure.message).toContain("applicationId");
    expect(toActionFailure(new Error("boom"))).toMatchObject({ status: 500, code: "unexpected" });
  });
});

describe("notes", () => {
  it("adds, edits as a new linked row and deletes, honouring author or Admin", async () => {
    const { applicationId } = await newApplication();
    await expect(addNote(db, { applicationId, body: "   ", isRestricted: false, userId: managerId })).rejects.toMatchObject({ code: "body_required" });
    const { noteId } = await addNote(db, { applicationId, body: "No-show 11/3, didn't call", isRestricted: false, userId: managerId });

    const edited = await editNote(db, { noteId, body: "No-show 11/3, called later", isRestricted: true, userId: managerId, role: "hiring_manager" });
    expect(edited.replacedNoteId).toBe(noteId);
    const [old] = await db.select().from(note).where(eq(note.id, noteId));
    expect(old!.deletedAt).not.toBeNull();
    expect(old!.body).toBe("No-show 11/3, didn't call");

    const profile = await loadProfile(db, applicationId, "admin");
    expect(profile!.notes).toHaveLength(1);
    expect(profile!.notes[0]).toMatchObject({ id: edited.noteId, body: "No-show 11/3, called later", isRestricted: true, replacesNoteId: noteId, replacedBody: "No-show 11/3, didn't call" });
    // Viewers never see a restricted note.
    expect((await loadProfile(db, applicationId, "viewer"))!.notes).toHaveLength(0);

    const otherId = uuidv7();
    await db.insert(appUser).values({ id: otherId, email: `other-${otherId}@example.test`, role: "hiring_manager" });
    await expect(deleteNote(db, { noteId: edited.noteId, userId: otherId, role: "hiring_manager" })).rejects.toMatchObject({ code: "not_allowed" });
    await deleteNote(db, { noteId: edited.noteId, userId: adminId, role: "admin" });
    expect((await loadProfile(db, applicationId, "admin"))!.notes).toHaveLength(0);
    expect((await audits(applicationId)).map((a) => a.action)).toEqual(["note.delete", "note.edit"]);
  });
});

describe("contact edits and housekeeping", () => {
  it("edits contact details with values audited as [changed] and refuses a number in use", async () => {
    const { applicationId, personId } = await newApplication();
    const result = await updateContact(db, {
      personId,
      userId: managerId,
      firstName: "Ana",
      lastName: "Lopez",
      mobile: "612 555 0199",
      email: "Ana.Lopez@Example.test",
      sharedMobile: false,
    });
    expect(result.changed.sort()).toEqual(["email", "firstName", "lastName", "mobileE164"]);
    const [row] = await db.select().from(person).where(eq(person.id, personId));
    expect(row!.mobileE164).toBe("+16125550199");
    expect(row!.emailNormalized).toBe("ana.lopez@example.test");
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.personId, personId), eq(auditLog.action, "person.update")));
    expect(audit!.changes).toEqual({
      firstName: { from: "[changed]", to: "[changed]" },
      lastName: { from: "[changed]", to: "[changed]" },
      mobileE164: { from: "[changed]", to: "[changed]" },
      email: { from: "[changed]", to: "[changed]" },
    });

    const other = await createPerson(db);
    await expect(
      updateContact(db, { personId: other, userId: managerId, firstName: "B", lastName: "C", mobile: "+16125550199", email: null, sharedMobile: false }),
    ).rejects.toMatchObject({ code: "mobile_in_use" });
    await expect(
      updateContact(db, { personId: other, userId: managerId, firstName: "B", lastName: "C", mobile: "123", email: null, sharedMobile: false }),
    ).rejects.toMatchObject({ code: "invalid_mobile" });
    await expect(
      updateContact(db, { personId: other, userId: managerId, firstName: "", lastName: "C", mobile: null, email: null, sharedMobile: false }),
    ).rejects.toMatchObject({ code: "name_required" });

    // The shared-phone flag lets a second person keep the same number.
    await updateContact(db, { personId, userId: managerId, firstName: "Ana", lastName: "Lopez", mobile: "+16125550199", email: row!.email, sharedMobile: true });
    await updateContact(db, { personId: other, userId: managerId, firstName: "B", lastName: "C", mobile: "+16125550199", email: null, sharedMobile: true });
    expect((await loadProfile(db, applicationId, "admin"))!.person.sharedMobile).toBe(true);
  });

  it("toggles do-not-contact with an audit row", async () => {
    const { personId } = await newApplication();
    await setDoNotContact(db, { personId, userId: managerId, value: true });
    const [row] = await db.select().from(person).where(eq(person.id, personId));
    expect(row!.doNotContact).toBe(true);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.personId, personId), eq(auditLog.action, "person.do_not_contact")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changes).toEqual({ doNotContact: { from: false, to: true } });
  });

  it("records 'they asked me to stop' as a staff opt-out plus a suppression", async () => {
    const { applicationId, personId } = await newApplication();
    const [who] = await db.select().from(person).where(eq(person.id, personId));
    const result = await recordStopRequest(db, { applicationId, userId: managerId });
    const [consent] = await db.select().from(consentEvent).where(eq(consentEvent.id, result.consentEventId));
    expect(consent).toMatchObject({ action: "opt_out", method: "staff_recorded", recordedBy: managerId, address: who!.mobileE164 });
    const [live] = await db.select().from(suppression).where(eq(suppression.id, result.suppressionId));
    expect(live).toMatchObject({ reason: "staff_marked", createdBy: managerId });
    const profile = await loadProfile(db, applicationId, "admin");
    expect(profile!.texting?.suppression?.reason).toBe("staff_marked");
    expect(profile!.consents[0]!.recordedByName).toBe("Morgan Manager");
  });

  it("marks an inbound text handled once", async () => {
    const { applicationId, personId } = await newApplication();
    const messageId = uuidv7();
    await db.insert(message).values({
      id: messageId,
      direction: "inbound",
      channel: "sms",
      personId,
      applicationId,
      toAddress: "+17632922259",
      fromAddress: "+16125550100",
      body: "hi",
      status: "received",
      provider: "quo",
      providerMessageId: `quo-${messageId}`,
      triggeredByType: "applicant",
    });
    await markTextHandled(db, { messageId, userId: managerId });
    const [row] = await db.select().from(message).where(eq(message.id, messageId));
    expect(row!.handledBy).toBe(managerId);
    expect(row!.handledAt).not.toBeNull();
    await expect(markTextHandled(db, { messageId: uuidv7(), userId: managerId })).rejects.toMatchObject({ code: "message_not_found" });
  });

  it("resends a link by email and text, and revoke kills the live tokens first", async () => {
    const { applicationId } = await newApplication();
    const providers = createSinkProviders();
    const first = await resendApplicationLink(db, { applicationId, userId: managerId, providers });
    expect(first.queued).toHaveLength(2);
    // Email goes; the text has no opt-in so the send function suppresses it.
    expect(first.sent).toHaveLength(1);
    expect(first.suppressed).toHaveLength(1);
    const live = await db.select().from(resumeToken).where(eq(resumeToken.applicationId, applicationId));
    expect(live.filter((t) => !t.revokedAt)).toHaveLength(1);

    const second = await resendApplicationLink(db, { applicationId, userId: managerId, revokeFirst: true, providers });
    expect(second.revoked).toBe(1);
    const after = await db.select().from(resumeToken).where(eq(resumeToken.applicationId, applicationId));
    expect(after.filter((t) => !t.revokedAt)).toHaveLength(1);
    expect(after.filter((t) => t.revokedAt)).toHaveLength(1);
    expect((await audits(applicationId)).map((a) => a.action)).toEqual(["application.link_revoke", "application.link_resend"]);

    const nobody = await newApplication({ email: null });
    await db.update(person).set({ mobileE164: null }).where(eq(person.id, nobody.personId));
    await expect(resendApplicationLink(db, { applicationId: nobody.applicationId, userId: managerId, providers })).rejects.toMatchObject({ code: "no_address" });
  });

  it("stores the Indeed apply date with an audit row", async () => {
    const { applicationId } = await newApplication();
    await updateIndeedAppliedOn(db, { applicationId, userId: managerId, date: "2026-10-12" });
    expect((await loadProfile(db, applicationId, "admin"))!.application.indeedAppliedOn).toBe("2026-10-12");
    expect((await audits(applicationId))[0]!.changes).toEqual({ indeedAppliedOn: { from: null, to: "2026-10-12" } });
  });

  it("resolves a landing conflict either way", async () => {
    const { applicationId, personId } = await newApplication();
    const conflictId = uuidv7();
    await db.insert(landingConflict).values({
      id: conflictId,
      openingId: snow.openingId,
      typedFirstName: "Same",
      typedLastName: "Person",
      typedMobileE164: nextMobile(),
      typedEmail: "new.address@example.test",
      matchedPersonIds: [personId],
    });
    expect((await loadProfile(db, applicationId, "admin"))!.conflicts).toHaveLength(1);
    await resolveLandingConflict(db, { conflictId, personId, resolution: "update_email", userId: managerId });
    const [who] = await db.select().from(person).where(eq(person.id, personId));
    expect(who!.email).toBe("new.address@example.test");
    const [conflict] = await db.select().from(landingConflict).where(eq(landingConflict.id, conflictId));
    expect(conflict).toMatchObject({ resolvedBy: managerId, resolution: "updated email on file" });
    expect((await loadProfile(db, applicationId, "admin"))!.conflicts).toHaveLength(0);
    await expect(resolveLandingConflict(db, { conflictId, personId, resolution: "mark_shared", userId: managerId })).rejects.toMatchObject({ code: "already_resolved" });

    const secondId = uuidv7();
    await db.insert(landingConflict).values({ id: secondId, openingId: snow.openingId, typedMobileE164: who!.mobileE164, typedEmail: "x@example.test", matchedPersonIds: [personId] });
    await resolveLandingConflict(db, { conflictId: secondId, personId, resolution: "mark_shared", userId: managerId });
    const [shared] = await db.select().from(person).where(eq(person.id, personId));
    expect(shared!.sharedMobile).toBe(true);
  });

  it("soft-deletes a test application with an audit row", async () => {
    const { applicationId } = await newApplication();
    await deleteTestApplication(db, { applicationId, userId: adminId });
    expect(await loadProfile(db, applicationId, "admin")).toBeNull();
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.applicationId, applicationId), eq(auditLog.action, "application.delete_test")));
    expect(rows).toHaveLength(1);
    await expect(deleteTestApplication(db, { applicationId, userId: adminId })).rejects.toMatchObject({ code: "application_not_found" });
    await expect(transition(db, { action: "hold", applicationId, actor: staff })).rejects.toMatchObject({ code: "application_not_found" });
  });
});

describe("offer, check and hire record edits", () => {
  it("edits an offer, keeps the offer date and applies the FCRA guard to a rescission", async () => {
    const { applicationId } = await newApplication();
    const offered = await transition(db, { action: "move", applicationId, toStageId: stages.conditional_offer!, actor: staff });
    const offerId = offered.created.offerId!;
    const updated = await updateOffer(db, { offerId, userId: managerId, patch: { payAmount: "22.50", payUnit: "hourly", plannedStartOn: "2026-11-09" } });
    expect(updated).toMatchObject({ payAmount: "22.50", payUnit: "hourly", plannedStartOn: "2026-11-09" });
    const [audit] = (await audits(applicationId)).filter((a) => a.action === "offer.update");
    expect(audit!.changes).toMatchObject({ payAmount: { from: null, to: "22.50" } });

    await transition(db, { action: "move", applicationId, toStageId: stages.background_check!, actor: staff, check: { checkType: "criminal" } });
    await expect(updateOffer(db, { offerId, userId: managerId, patch: { response: "rescinded" } })).rejects.toMatchObject({ code: "fcra_statement_required" });
    const rescinded = await updateOffer(db, { offerId, userId: managerId, patch: { response: "rescinded", respondedOn: "2026-10-20", notReportBased: true } });
    expect(rescinded.response).toBe("rescinded");
  });

  it("locks the pre-adverse notice date to Admins once set", async () => {
    const { applicationId } = await newApplication();
    await transition(db, { action: "move", applicationId, toStageId: stages.conditional_offer!, actor: staff });
    const moved = await transition(db, { action: "move", applicationId, toStageId: stages.background_check!, actor: staff, check: { checkType: "driving_record", vendor: "Checkr" } });
    const checkId = moved.created.backgroundCheckId!;
    await expect(updateBackgroundCheck(db, { checkId, userId: managerId, role: "hiring_manager", patch: { status: "pre_adverse_sent" } })).rejects.toMatchObject({ code: "pre_adverse_required" });
    const sent = await updateBackgroundCheck(db, {
      checkId,
      userId: managerId,
      role: "hiring_manager",
      patch: { status: "pre_adverse_sent", preAdverseNoticeOn: "2026-10-15" },
    });
    expect(sent.preAdverseNoticeOn).toBe("2026-10-15");
    await expect(
      updateBackgroundCheck(db, { checkId, userId: managerId, role: "hiring_manager", patch: { preAdverseNoticeOn: "2026-10-16" } }),
    ).rejects.toMatchObject({ code: "pre_adverse_locked" });
    const fixed = await updateBackgroundCheck(db, { checkId, userId: adminId, role: "admin", patch: { preAdverseNoticeOn: "2026-10-16" } });
    expect(fixed.preAdverseNoticeOn).toBe("2026-10-16");
    await expect(updateBackgroundCheck(db, { checkId, userId: adminId, role: "admin", patch: { preAdverseNoticeOn: null, finalAdverseOn: "2026-10-30" } })).rejects.toMatchObject({
      code: "pre_adverse_required",
    });
    const profile = await loadProfile(db, applicationId, "admin");
    expect(profile!.checks[0]!.open).toBe(true);
  });

  it("applies the hire form rules and audits the edit", async () => {
    const { applicationId } = await newApplication();
    const hired = await transition(db, { action: "move", applicationId, toStageId: stages.hired!, actor: staff, hire: { startOn: "2026-11-02" } });
    const stintId = hired.created.hireStintId!;
    const leave = await loadOption(db, "leave_reason", "took_another_job");

    await expect(updateHireStint(db, { stintId, userId: managerId, role: "hiring_manager", patch: { rating30: 7 } })).rejects.toMatchObject({ code: "invalid_rating" });
    await expect(updateHireStint(db, { stintId, userId: managerId, role: "hiring_manager", patch: { outcome: "separated" } })).rejects.toMatchObject({ code: "separation_fields_required" });
    await expect(
      updateHireStint(db, { stintId, userId: managerId, role: "hiring_manager", patch: { outcome: "separated", separationType: "voluntary", leaveReasonOptionId: leave, endOn: "2026-10-01" } }),
    ).rejects.toMatchObject({ code: "rehire_eligible_required" });
    await expect(
      updateHireStint(db, {
        stintId,
        userId: managerId,
        role: "hiring_manager",
        patch: { outcome: "separated", separationType: "voluntary", leaveReasonOptionId: leave, endOn: "2026-10-01", rehireEligible: true },
      }),
    ).rejects.toMatchObject({ code: "invalid_dates" });
    await expect(updateHireStint(db, { stintId, userId: managerId, role: "hiring_manager", patch: { outcome: "completed_season", endOn: "2027-03-31", rehireEligible: true } })).rejects.toMatchObject({
      code: "season_end_rating_required",
    });

    const temporary = await updateHireStint(db, { stintId, userId: managerId, role: "hiring_manager", patch: { isTemporary: true, plannedEndOn: "2026-12-31", rating30: 4 } });
    expect(temporary).toMatchObject({ isTemporary: true, plannedEndOn: "2026-12-31", rating30: 4, rating30By: managerId });

    const left = await updateHireStint(db, {
      stintId,
      userId: managerId,
      role: "hiring_manager",
      patch: { outcome: "separated", separationType: "voluntary", leaveReasonOptionId: leave, lastWorkedOn: "2026-12-10", endOn: "2026-12-12", rehireEligible: true },
    });
    expect(left.outcome).toBe("separated");

    // After an exit the temporary flag needs an Admin and a reason.
    await expect(updateHireStint(db, { stintId, userId: managerId, role: "hiring_manager", patch: { isTemporary: false } })).rejects.toMatchObject({ code: "temporary_locked" });
    await expect(updateHireStint(db, { stintId, userId: adminId, role: "admin", patch: { isTemporary: false } })).rejects.toMatchObject({ code: "reason_required" });
    const flipped = await updateHireStint(db, { stintId, userId: adminId, role: "admin", patch: { isTemporary: false, temporaryChangeReason: "Entered by mistake at hire" } });
    expect(flipped.isTemporary).toBe(false);
    const [audit] = (await audits(applicationId)).filter((a) => a.action === "hire_stint.update");
    expect(audit!.changes).toMatchObject({ isTemporary: { from: true, to: false }, temporary_change_reason: "Entered by mistake at hire" });
  });
});
