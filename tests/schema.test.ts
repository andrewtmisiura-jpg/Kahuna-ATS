import { and, eq, sql as raw } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import {
  application,
  applicationEvent,
  auditLog,
  consentEvent,
  employer,
  entryCode,
  formItem,
  formVersion,
  hireStint,
  legalTextVersion,
  messageTemplate,
  opening,
  picklistOption,
  question,
  questionVersion,
  role,
  suppression,
} from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { findUserByEmail } from "@/server/services/users";
import { expectPgError, PG, withRollback } from "./helpers/db";
import { createApplication, createPerson, loadSnow, nextMobile, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

let snow: SnowFixture;
let windowRoleId: string;
let employerId: string;
let adminId: string;
let smsConsentId: string;

async function questionVersionId(roleId: string, key: string) {
  const [row] = await db
    .select({ id: questionVersion.id })
    .from(questionVersion)
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(and(eq(question.roleId, roleId), eq(question.key, key)));
  if (!row) throw new Error(`question ${key} missing`);
  return row.id;
}

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  const [windowRole] = await db.select({ id: role.id }).from(role).where(eq(role.key, "window_cleaning_tech"));
  windowRoleId = windowRole!.id;
  const [kahuna] = await db.select({ id: employer.id }).from(employer);
  employerId = kahuna!.id;
  adminId = (await findUserByEmail(db, TEST_ADMIN_EMAIL))!.id;
  const [consent] = await db
    .select({ id: legalTextVersion.id })
    .from(legalTextVersion)
    .where(eq(legalTextVersion.kind, "sms_consent"));
  smsConsentId = consent!.id;
});

afterAll(async () => {
  await sql.end();
});

describe("append-only tables", () => {
  it("application_event rejects UPDATE and DELETE", async () => {
    const personId = await createPerson(db);
    const { eventId } = await createApplication(db, snow, personId);
    await expectPgError(
      db.update(applicationEvent).set({ note: "edited" }).where(eq(applicationEvent.id, eventId)),
      PG.appendOnly,
    );
    await expectPgError(db.delete(applicationEvent).where(eq(applicationEvent.id, eventId)), PG.appendOnly);
  });

  it("audit_log rejects UPDATE and DELETE, except for the purge job", async () => {
    const id = uuidv7();
    await db.insert(auditLog).values({
      id,
      occurredAt: new Date(),
      actorType: "staff",
      actorUserId: adminId,
      action: "test.write",
      entityType: "test",
      entityId: uuidv7(),
    });
    await expectPgError(db.update(auditLog).set({ action: "test.edited" }).where(eq(auditLog.id, id)), PG.appendOnly);
    await expectPgError(db.delete(auditLog).where(eq(auditLog.id, id)), PG.appendOnly);

    // The Phase 3 purge runs with the session setting on, inside its own transaction.
    await withRollback(db, async (tx) => {
      await tx.execute(raw`set local tidepool.purge = 'on'`);
      await tx.delete(auditLog).where(eq(auditLog.id, id));
      const rows = await tx.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, id));
      expect(rows).toHaveLength(0);
    });
  });

  it("consent_event rejects UPDATE and DELETE", async () => {
    const personId = await createPerson(db);
    const id = uuidv7();
    await db.insert(consentEvent).values({
      id,
      personId,
      employerId,
      channel: "sms",
      address: nextMobile(),
      action: "declined",
      method: "web_form",
      legalTextVersionId: smsConsentId,
      checkboxValue: false,
      occurredAt: new Date(),
    });
    await expectPgError(db.update(consentEvent).set({ action: "opt_in" }).where(eq(consentEvent.id, id)), PG.appendOnly);
    await expectPgError(db.delete(consentEvent).where(eq(consentEvent.id, id)), PG.appendOnly);
  });

  it("consent from a web form must name the legal text shown", async () => {
    const personId = await createPerson(db);
    await expectPgError(
      db.insert(consentEvent).values({
        id: uuidv7(),
        personId,
        channel: "sms",
        address: nextMobile(),
        action: "opt_in",
        method: "web_form",
        occurredAt: new Date(),
      }),
      PG.checkViolation,
    );
  });
});

describe("immutable once published", () => {
  it("rejects edits and deletes of a published question version", async () => {
    const id = await questionVersionId(snow.roleId, "age_18_plus");
    await expectPgError(db.update(questionVersion).set({ prompt: "Reworded" }).where(eq(questionVersion.id, id)), PG.immutablePublished);
    await expectPgError(db.delete(questionVersion).where(eq(questionVersion.id, id)), PG.immutablePublished);
  });

  it("still allows edits of a draft question version", async () => {
    const id = await questionVersionId(windowRoleId, "age_18_plus");
    await withRollback(db, async (tx) => {
      await tx.update(questionVersion).set({ help: "Draft help" }).where(eq(questionVersion.id, id));
      const [row] = await tx.select({ help: questionVersion.help }).from(questionVersion).where(eq(questionVersion.id, id));
      expect(row?.help).toBe("Draft help");
    });
  });

  it("rejects edits of a published legal text version", async () => {
    await expectPgError(
      db.update(legalTextVersion).set({ body: "changed" }).where(eq(legalTextVersion.id, smsConsentId)),
      PG.immutablePublished,
    );
    await expectPgError(db.delete(legalTextVersion).where(eq(legalTextVersion.id, smsConsentId)), PG.immutablePublished);
  });

  it("locks a published form version except for retiring it", async () => {
    const id = snow.formVersionId;
    await expectPgError(db.update(formVersion).set({ changeReason: "edited" }).where(eq(formVersion.id, id)), PG.immutablePublished);
    await expectPgError(db.delete(formVersion).where(eq(formVersion.id, id)), PG.immutablePublished);

    await withRollback(db, async (tx) => {
      await tx.update(formVersion).set({ status: "retired" }).where(eq(formVersion.id, id));
      const [row] = await tx.select({ status: formVersion.status }).from(formVersion).where(eq(formVersion.id, id));
      expect(row?.status).toBe("retired");
      // Retired is locked too, and status cannot move back.
      await expectPgError(
        tx.transaction(async (sp) => {
          await sp.update(formVersion).set({ status: "published" }).where(eq(formVersion.id, id));
        }),
        PG.immutablePublished,
      );
    });
  });

  it("locks the items of a published form and leaves a draft's editable", async () => {
    const extraQuestion = await questionVersionId(windowRoleId, "stranger");
    await expectPgError(
      db.insert(formItem).values({
        formVersionId: snow.formVersionId,
        questionVersionId: extraQuestion,
        sectionKey: "basics",
        sortOrder: 999,
        required: false,
      }),
      PG.immutablePublished,
    );
    const snowItem = await questionVersionId(snow.roleId, "equipment");
    await expectPgError(
      db.update(formItem).set({ required: false }).where(eq(formItem.questionVersionId, snowItem)),
      PG.immutablePublished,
    );
    await expectPgError(db.delete(formItem).where(eq(formItem.questionVersionId, snowItem)), PG.immutablePublished);

    const [draft] = await db
      .select({ id: formVersion.id })
      .from(formVersion)
      .where(and(eq(formVersion.roleId, windowRoleId), eq(formVersion.status, "draft")));
    await withRollback(db, async (tx) => {
      const deleted = await tx
        .delete(formItem)
        .where(and(eq(formItem.formVersionId, draft!.id), eq(formItem.questionVersionId, extraQuestion)))
        .returning({ questionVersionId: formItem.questionVersionId });
      expect(deleted).toHaveLength(1);
    });
  });
});

describe("partial unique indexes", () => {
  it("allows one open opening per role", async () => {
    const values = { id: uuidv7(), roleId: snow.roleId, key: "snow-extra", name: "Extra", opensOn: "2026-11-01", payText: "x" };
    await expectPgError(db.insert(opening).values({ ...values, status: "open" }), PG.uniqueViolation);
    await withRollback(db, async (tx) => {
      await tx.insert(opening).values({ ...values, status: "draft" });
    });
  });

  it("allows one published form per role", async () => {
    await expectPgError(
      db.insert(formVersion).values({ id: uuidv7(), roleId: snow.roleId, version: 2, status: "published", sections: [] }),
      PG.uniqueViolation,
    );
  });

  it("allows one person per mobile unless the phone is shared", async () => {
    const mobileE164 = nextMobile();
    await createPerson(db, { mobileE164 });
    await expectPgError(createPerson(db, { mobileE164 }), PG.uniqueViolation);
    await withRollback(db, async (tx) => {
      await createPerson(tx, { mobileE164, sharedMobile: true });
    });
  });

  it("allows one application per person per opening unless deleted", async () => {
    const personId = await createPerson(db);
    const { applicationId } = await createApplication(db, snow, personId);
    await expectPgError(createApplication(db, snow, personId), PG.uniqueViolation);
    await withRollback(db, async (tx) => {
      await tx.update(application).set({ deletedAt: new Date() }).where(eq(application.id, applicationId));
      await createApplication(tx, snow, personId);
    });
  });

  it("allows one live suppression per address", async () => {
    const address = nextMobile();
    const first = uuidv7();
    await db.insert(suppression).values({ id: first, channel: "sms", address, reason: "stop_keyword" });
    await expectPgError(
      db.insert(suppression).values({ id: uuidv7(), channel: "sms", address, reason: "staff_marked" }),
      PG.uniqueViolation,
    );
    await withRollback(db, async (tx) => {
      await tx.update(suppression).set({ liftedAt: new Date(), liftReason: "START" }).where(eq(suppression.id, first));
      await tx.insert(suppression).values({ id: uuidv7(), channel: "sms", address, reason: "stop_keyword" });
    });
  });

  it("allows one active hire stint per application", async () => {
    const personId = await createPerson(db);
    const { applicationId } = await createApplication(db, snow, personId);
    const stint = { personId, applicationId, origin: "ats" as const, employerId, roleId: snow.roleId, openingId: snow.openingId };
    await db.insert(hireStint).values({ id: uuidv7(), ...stint });
    await expectPgError(db.insert(hireStint).values({ id: uuidv7(), ...stint }), PG.uniqueViolation);
  });

  it("counts a null role as a value for live message templates", async () => {
    const duplicate = {
      id: uuidv7(),
      employerId,
      roleId: null,
      purpose: "resume_link" as const,
      channel: "sms" as const,
      name: "Duplicate",
      body: "x",
    };
    await expectPgError(db.insert(messageTemplate).values(duplicate), PG.uniqueViolation);
    await withRollback(db, async (tx) => {
      await tx.insert(messageTemplate).values({ ...duplicate, archivedAt: new Date() });
    });
  });

  it("counts null scopes as values for picklist options", async () => {
    await expectPgError(
      db.insert(picklistOption).values({
        id: uuidv7(),
        listKey: "disqualify_reason",
        employerId,
        roleId: null,
        key: "other",
        label: "Other again",
        sortOrder: 999,
      }),
      PG.uniqueViolation,
    );
  });
});

describe("column checks", () => {
  it("stores only valid US E.164 mobile numbers", async () => {
    await expectPgError(createPerson(db, { mobileE164: "+447911123456" }), PG.checkViolation);
    await expectPgError(createPerson(db, { mobileE164: "6125550123" }), PG.checkViolation);
    await expectPgError(createPerson(db, { mobileE164: "+16125550123x" }), PG.checkViolation);
  });

  it("rejects malformed entry codes", async () => {
    for (const code of ["abc", "SNOWILU", "TOOLONGCODE1"]) {
      await expectPgError(
        db.insert(entryCode).values({ id: uuidv7(), code, roleId: snow.roleId, channel: "flyer", label: "bad" }),
        PG.checkViolation,
      );
    }
  });

  it("requires an outcome and a reason on a closed application", async () => {
    const personId = await createPerson(db);
    const { applicationId } = await createApplication(db, snow, personId);
    await expectPgError(db.update(application).set({ status: "closed" }).where(eq(application.id, applicationId)), PG.checkViolation);
    await expectPgError(
      db.update(application).set({ status: "closed", closedOutcome: "withdrew" }).where(eq(application.id, applicationId)),
      PG.checkViolation,
    );
  });
});

// drizzle/0004_staff_guidance_and_arrival.sql: additive columns, enum and table.
describe("staff guidance, starts-with check, arrival and applied changes", () => {
  it("adds the nullable columns, the arrival enum and the applied_change table", async () => {
    const columns = await db.execute<{ table_name: string; column_name: string; is_nullable: string; udt_name: string }>(
      raw`select table_name, column_name, is_nullable, udt_name from information_schema.columns
          where table_schema = 'public' and (
            (table_name = 'question_version' and column_name in ('staff_guidance', 'starts_with_check'))
            or (table_name = 'application' and column_name = 'group_interview_arrival')
            or table_name = 'applied_change')
          order by table_name, column_name`,
    );
    expect(columns.map((c) => [c.table_name, c.column_name, c.is_nullable, c.udt_name])).toEqual([
      ["application", "group_interview_arrival", "YES", "group_interview_arrival"],
      ["applied_change", "applied_at", "NO", "timestamptz"],
      ["applied_change", "description", "NO", "text"],
      ["applied_change", "id", "NO", "text"],
      ["question_version", "staff_guidance", "YES", "text"],
      ["question_version", "starts_with_check", "YES", "text"],
    ]);
    const labels = await db.execute<{ enumlabel: string }>(
      raw`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'group_interview_arrival' order by e.enumsortorder`,
    );
    expect(labels.map((l) => l.enumlabel)).toEqual(["on_time", "late", "did_not_attend"]);
  });

  it("leaves seeded rows untouched: no guidance, no check, no arrival", async () => {
    const id = await questionVersionId(snow.roleId, "age_18_plus");
    const [version] = await db.select().from(questionVersion).where(eq(questionVersion.id, id));
    expect(version?.staffGuidance).toBeNull();
    expect(version?.startsWithCheck).toBeNull();
    const personId = await createPerson(db);
    const { applicationId } = await createApplication(db, snow, personId);
    const [app] = await db.select().from(application).where(eq(application.id, applicationId));
    expect(app?.groupInterviewArrival).toBeNull();
  });

  it("allows a starts-with check only on text questions", async () => {
    await withRollback(db, async (tx) => {
      const questionId = uuidv7();
      await tx.insert(question).values({ id: questionId, roleId: windowRoleId, key: `check_${questionId.slice(-8)}` });
      await tx.insert(questionVersion).values({ id: uuidv7(), questionId, version: 1, type: "long_text", prompt: "Start with Blue.", startsWithCheck: "blue" });
      await expectPgError(
        tx.insert(questionVersion).values({ id: uuidv7(), questionId, version: 2, type: "yes_no", prompt: "Yes or no?", startsWithCheck: "blue" }),
        PG.checkViolation,
      );
    });
  });

  it("keeps the new columns frozen once a version is published", async () => {
    const id = await questionVersionId(snow.roleId, "age_18_plus");
    await expectPgError(db.update(questionVersion).set({ staffGuidance: "Look for a yes" }).where(eq(questionVersion.id, id)), PG.immutablePublished);
    await expectPgError(db.update(questionVersion).set({ startsWithCheck: null }).where(eq(questionVersion.id, id)), PG.immutablePublished);
  });
});
