import { createHash } from "node:crypto";
// drizzle's raw sql tag is named apart from the postgres client exported as `sql`.
import { and, eq, sql as sqlRaw } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql, type Db } from "@/db";
import { answer, auditLog, entryCode, formItem, formVersion, note, question, questionVersion } from "@/db/schema";
import { LAUNCH_ENTRY_CODES, seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { SYSTEM_ACTOR, staffActor, type Actor } from "@/server/services/actor";
import { createApplication, transition } from "@/server/services/applications/transition";
import { recordScan } from "@/server/services/entry-codes";
import { EXPORT_NAMES, ExportError, exportFilename, runExport } from "@/server/services/exports";
import { centralIso } from "@/server/services/exports/shared";
import { createSinkProviders } from "@/server/services/messaging/providers";
import { processMessages, queueMessage } from "@/server/services/messaging/send";
import { centralDate } from "@/server/services/time";
import { withRollback } from "./helpers/db";
import {
  createPerson,
  loadAdminId,
  loadEmployer,
  loadOption,
  loadSnow,
  loadStages,
  TEST_ADMIN_EMAIL,
  type SnowFixture,
} from "./helpers/fixtures";

let snow: SnowFixture;
let stages: Record<string, string>;
let adminId: string;
let staff: Actor;
let employerId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  adminId = await loadAdminId(db);
  staff = staffActor(adminId);
  employerId = (await loadEmployer(db)).id;
});

afterAll(async () => {
  await sql.end();
});

// A small RFC 4180 reader: quoted fields, doubled quotes, CRLF and newlines inside quotes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function readTable(body: string) {
  const [headers = [], ...rows] = parseCsv(body);
  return {
    headers,
    rows: rows.map((cells) => Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? ""]))),
  };
}

async function questionVersionId(tx: Db, roleId: string, key: string, version = 1): Promise<string> {
  const [row] = await tx
    .select({ id: questionVersion.id })
    .from(questionVersion)
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(and(eq(question.roleId, roleId), eq(question.key, key), eq(questionVersion.version, version)));
  if (!row) throw new Error(`question ${key} v${version} missing`);
  return row.id;
}

// Snow form v2: response_time reworded as v2 of its lineage, everything else kept
// at v1. Retires v1 and publishes v2 the way the publish service does.
async function publishSnowFormV2(tx: Db, now: Date) {
  const [current] = await tx
    .select({ questionId: question.id, v1: questionVersion })
    .from(questionVersion)
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(and(eq(question.roleId, snow.roleId), eq(question.key, "response_time"), eq(questionVersion.version, 1)));
  const v2Id = uuidv7();
  await tx.insert(questionVersion).values({
    id: v2Id,
    questionId: current!.questionId,
    version: 2,
    type: current!.v1.type,
    prompt: "During a storm, how fast could you be on the road?",
    options: current!.v1.options,
    validation: current!.v1.validation,
    meaningChanged: false,
    changeNote: "Reworded for the export test",
    publishedAt: now,
  });

  const [v1Form] = await tx.select().from(formVersion).where(eq(formVersion.id, snow.formVersionId));
  const items = await tx.select().from(formItem).where(eq(formItem.formVersionId, snow.formVersionId));
  const v2FormId = uuidv7();
  await tx.insert(formVersion).values({
    id: v2FormId,
    roleId: snow.roleId,
    version: 2,
    status: "draft",
    sections: v1Form!.sections,
    aiDisclosureVersionId: v1Form!.aiDisclosureVersionId,
    changeReason: "Export test: reworded response_time",
  });
  for (const item of items) {
    await tx.insert(formItem).values({
      formVersionId: v2FormId,
      questionVersionId: item.questionVersionId === current!.v1.id ? v2Id : item.questionVersionId,
      sectionKey: item.sectionKey,
      sortOrder: item.sortOrder,
      required: item.required,
      attentionValues: item.attentionValues,
    });
  }
  await tx.update(formVersion).set({ status: "retired" }).where(eq(formVersion.id, snow.formVersionId));
  await tx.update(formVersion).set({ status: "published", publishedAt: now }).where(eq(formVersion.id, v2FormId));
  return { v2FormId, responseTimeV1: current!.v1.id, responseTimeV2: v2Id };
}

async function newSnowApplication(tx: Db, personId: string, occurredAt: Date) {
  const { applicationId } = await createApplication(tx, {
    personId,
    openingId: snow.openingId,
    origin: "landing",
    entryChannel: "role_qr",
    actor: { type: "applicant" },
    occurredAt,
  });
  return applicationId;
}

describe("wide export", () => {
  it("has one column per question version, milestone dates from the event log, escaped answers and an audit row", async () => {
    await withRollback(db, async (tx) => {
      const now = new Date();
      const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

      // Application A on form v1, carried all the way to Hired.
      const anaId = await createPerson(tx, { firstName: "Ana", lastName: "Formula", mobileE164: "+16125550177" });
      const a = await newSnowApplication(tx, anaId, minutesAgo(600));
      await tx.insert(answer).values([
        { id: uuidv7(), applicationId: a, questionVersionId: await questionVersionId(tx, snow.roleId, "job1_employer"), valueText: "=1+1" },
        { id: uuidv7(), applicationId: a, questionVersionId: await questionVersionId(tx, snow.roleId, "response_time"), valueOptions: ["under_30"] },
        {
          id: uuidv7(),
          applicationId: a,
          questionVersionId: await questionVersionId(tx, snow.roleId, "call_windows"),
          valueOptions: ["overnight", "weekends"],
        },
        { id: uuidv7(), applicationId: a, questionVersionId: await questionVersionId(tx, snow.roleId, "age_18_plus"), valueBool: true },
        { id: uuidv7(), applicationId: a, questionVersionId: await questionVersionId(tx, snow.roleId, "job1_months"), valueNumber: "14" },
      ]);
      const submittedAt = minutesAgo(500);
      const reviewedAt = minutesAgo(400);
      const offeredAt = minutesAgo(300);
      const checkedAt = minutesAgo(200);
      const hiredAt = minutesAgo(100);
      await transition(tx, { action: "submit", applicationId: a, actor: { type: "applicant" }, occurredAt: submittedAt });
      await transition(tx, { action: "move", applicationId: a, toStageId: stages.reviewed!, actor: staff, occurredAt: reviewedAt });
      await transition(tx, { action: "move", applicationId: a, toStageId: stages.conditional_offer!, actor: staff, occurredAt: offeredAt });
      await transition(tx, {
        action: "move",
        applicationId: a,
        toStageId: stages.background_check!,
        actor: staff,
        occurredAt: checkedAt,
        check: { checkType: "driving_record", vendor: "Checkr" },
      });
      await transition(tx, {
        action: "move",
        applicationId: a,
        toStageId: stages.hired!,
        actor: staff,
        occurredAt: hiredAt,
        hire: { startOn: "2026-11-02" },
      });

      // Form v2 is published; application B pins it and is disqualified at Submitted.
      const forms = await publishSnowFormV2(tx, minutesAgo(90));
      const boId = await createPerson(tx, { firstName: "Bo", lastName: "Second" });
      const b = await newSnowApplication(tx, boId, minutesAgo(80));
      await tx.insert(answer).values({ id: uuidv7(), applicationId: b, questionVersionId: forms.responseTimeV2, valueOptions: ["over_2h"] });
      await transition(tx, { action: "submit", applicationId: b, actor: { type: "applicant" }, occurredAt: minutesAgo(70) });
      const availability = await loadOption(tx, "disqualify_reason", "availability_conflict");
      await transition(tx, {
        action: "close",
        applicationId: b,
        outcome: "disqualified",
        reasonOptionId: availability,
        actor: staff,
        occurredAt: minutesAgo(60),
      });

      const file = await runExport(tx, { name: "applications", filters: { openingId: snow.openingId }, actor: staff, now });
      expect(file.filename).toBe(`tidepool-applications-snow-2026-27-${centralDate(now)}.csv`);
      expect(file.includesContact).toBe(true);

      const { headers, rows } = readTable(file.body);
      expect(rows).toHaveLength(file.rows);
      const rowA = rows.find((row) => row.application_id === a)!;
      const rowB = rows.find((row) => row.application_id === b)!;
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();

      // Question columns: one per question version, labeled "<key> (v<version>)".
      expect(headers).toContain("response_time (v1)");
      expect(headers).toContain("response_time (v2)");
      expect(headers).toContain("response_time (v1) label");
      expect(headers.filter((h) => h === "age_18_plus (v1)")).toHaveLength(1);
      expect(headers.indexOf("response_time (v1)")).toBeLessThan(headers.indexOf("response_time (v2)"));
      expect(rowA["form_version"]).toBe("1");
      expect(rowB["form_version"]).toBe("2");
      expect(rowA["response_time (v1)"]).toBe("under_30");
      expect(rowA["response_time (v1) label"]).toBe("Within 30 minutes");
      expect(rowA["response_time (v2)"]).toBe("");
      expect(rowB["response_time (v1)"]).toBe("");
      expect(rowB["response_time (v2)"]).toBe("over_2h");
      expect(rowB["response_time (v2) label"]).toBe("More than 2 hours");
      expect(rowA["call_windows (v1)"]).toBe("overnight; weekends");
      expect(rowA["call_windows (v1) label"]).toBe("Overnight (midnight to 5am); Weekends");
      expect(rowA["age_18_plus (v1)"]).toBe("true");
      expect(rowA["job1_months (v1)"]).toBe("14");

      // The formula answer comes back as text: the apostrophe guard in front, the answer intact behind it.
      const formula = rowA["job1_employer (v1)"]!;
      expect(formula).toBe("'=1+1");
      expect(formula.startsWith("=")).toBe(false);
      expect(formula.slice(1)).toBe("=1+1");

      // Person and state columns.
      expect(rowA["first_name"]).toBe("Ana");
      expect(rowA["mobile"]).toBe("(612) 555-0177");
      expect(rowA["status"]).toBe("hired");
      expect(rowA["stage_key"]).toBe("hired");
      expect(rowA["stage_milestone"]).toBe("hired");
      expect(rowA["entry_channel"]).toBe("role_qr");
      expect(rowB["status"]).toBe("closed");
      expect(rowB["stage_key"]).toBe("submitted");
      expect(rowB["closed_outcome"]).toBe("disqualified");
      expect(rowB["closed_reason_key"]).toBe("availability_conflict");
      expect(rowB["closed_reason_label"]).toBe("Availability doesn't fit");

      // Milestone dates: first reached, with skipped milestones counted by the later one.
      expect(rowA["reached_started_at"]).toBe(centralIso(minutesAgo(600)));
      expect(rowA["reached_submitted_at"]).toBe(centralIso(submittedAt));
      expect(rowA["reached_reviewed_at"]).toBe(centralIso(reviewedAt));
      expect(rowA["reached_interview_invited_at"]).toBe(centralIso(offeredAt));
      expect(rowA["reached_interviewed_at"]).toBe(centralIso(offeredAt));
      expect(rowA["reached_offered_at"]).toBe(centralIso(offeredAt));
      expect(rowA["reached_background_check_at"]).toBe(centralIso(checkedAt));
      expect(rowA["reached_hired_at"]).toBe(centralIso(hiredAt));
      expect(rowA["submitted_at"]).toBe(centralIso(submittedAt));
      expect(rowB["reached_submitted_at"]).toBe(centralIso(minutesAgo(70)));
      expect(rowB["reached_reviewed_at"]).toBe("");
      expect(rowB["reached_hired_at"]).toBe("");

      // Nothing from notes is in the wide file.
      expect(headers.some((h) => /note/.test(h))).toBe(false);

      // The audit row: export.run with the name, the filters and the file's hash.
      const [audit] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "export.run"), eq(auditLog.id, file.auditId)));
      expect(audit).toBeDefined();
      expect(audit!.entityType).toBe("export");
      expect(audit!.actorType).toBe("staff");
      expect(audit!.actorUserId).toBe(adminId);
      const changes = audit!.changes as {
        export: string;
        filters: { opening_id: string; opening_key: string; from: string | null; to: string | null };
        files: { name: string; rows: number; sha256: string }[];
        includes_contact: boolean;
      };
      expect(changes.export).toBe("applications");
      expect(changes.filters.opening_id).toBe(snow.openingId);
      expect(changes.filters.opening_key).toBe("snow-2026-27");
      expect(changes.files).toEqual([
        { name: file.filename, rows: file.rows, sha256: createHash("sha256").update(file.body, "utf8").digest("hex") },
      ]);
      expect(changes.includes_contact).toBe(true);
    });
  });

  it("refuses to run without an opening and rejects bad filters", async () => {
    await expect(runExport(db, { name: "applications", filters: {}, actor: staff })).rejects.toMatchObject({ code: "opening_required" });
    await expect(runExport(db, { name: "applications", filters: { openingId: uuidv7() }, actor: staff })).rejects.toMatchObject({
      code: "opening_not_found",
    });
    await expect(runExport(db, { name: "nope", filters: {}, actor: staff })).rejects.toBeInstanceOf(ExportError);
    await expect(runExport(db, { name: "stage_events", filters: { from: "10/23/2026" }, actor: staff })).rejects.toMatchObject({
      code: "bad_date",
    });
    await expect(runExport(db, { name: "stage_events", filters: { from: "2026-02-30" }, actor: staff })).rejects.toMatchObject({
      code: "bad_date",
    });
    await expect(runExport(db, { name: "stage_events", filters: { from: "2026-10-23", to: "2026-10-01" }, actor: staff })).rejects.toMatchObject(
      { code: "bad_date_range" },
    );
    expect(exportFilename("hires", "Snow 2026/27", new Date("2026-10-23T12:00:00Z"))).toBe("tidepool-hires-Snow_2026_27-2026-10-23.csv");
  });
});

describe("long and dictionary exports", () => {
  it("every export runs on the seeded database and writes its audit row", async () => {
    for (const name of EXPORT_NAMES) {
      const before = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "export.run"));
      const file = await runExport(db, { name, filters: { openingId: snow.openingId }, actor: staff });
      const { headers, rows } = readTable(file.body);
      expect(headers.length, name).toBeGreaterThan(3);
      expect(rows, name).toHaveLength(file.rows);
      expect(file.body.endsWith("\r\n"), name).toBe(true);
      const after = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "export.run"));
      expect(after.length, name).toBe(before.length + 1);
    }
  });

  it("background checks carry type, vendor, status and dates only", async () => {
    const file = await runExport(db, { name: "background_checks", filters: {}, actor: staff });
    const { headers } = readTable(file.body);
    expect(headers).toEqual([
      "background_check_id",
      "application_id",
      "opening_key",
      "offer_id",
      "check_type",
      "vendor",
      "status",
      "requested_on",
      "completed_on",
      "pre_adverse_notice_on",
      "final_adverse_on",
      "created_at",
      "updated_at",
    ]);
    expect(headers).not.toContain("vendor_reference");
    expect(headers).not.toContain("note");
  });

  it("leaves restricted notes out", async () => {
    const personId = await createPerson(db, { firstName: "Cy", lastName: "Notes" });
    const applicationId = await newSnowApplication(db, personId, new Date());
    const plain = `Plain note ${uuidv7()}`;
    const restricted = `Accommodation detail ${uuidv7()}`;
    await db.insert(note).values([
      { id: uuidv7(), personId, applicationId, body: plain, isRestricted: false, authorUserId: adminId },
      { id: uuidv7(), personId, applicationId, body: restricted, isRestricted: true, authorUserId: adminId },
    ]);
    const file = await runExport(db, { name: "notes", filters: { openingId: snow.openingId }, actor: staff });
    expect(file.body).toContain(plain);
    expect(file.body).not.toContain(restricted);
    const row = readTable(file.body).rows.find((r) => r.body === plain)!;
    expect(row.author_email).toBe(TEST_ADMIN_EMAIL);
    expect(row.opening_key).toBe("snow-2026-27");
  });

  it("shows application links as a placeholder in the message log", async () => {
    const personId = await createPerson(db, { firstName: "Dee", lastName: "Link" });
    const applicationId = await newSnowApplication(db, personId, new Date());
    const { messageId } = await queueMessage(db, {
      employerId,
      channel: "email",
      applicationId,
      content: { purpose: "resume_link" },
      triggeredBy: SYSTEM_ACTOR,
    });
    const summary = await processMessages(db, [messageId], createSinkProviders());
    expect(summary.sent).toContain(messageId);

    const file = await runExport(db, { name: "messages", filters: { openingId: snow.openingId }, actor: staff });
    const row = readTable(file.body).rows.find((r) => r.message_id === messageId)!;
    expect(row).toBeDefined();
    expect(row.body).toContain("[application link]");
    expect(row.body).not.toMatch(/\{link/);
    expect(row.status).toBe("sent");
    expect(row.channel).toBe("email");
    expect(row.opening_key).toBe("snow-2026-27");
  });

  it("applies the date range and the opening filter", async () => {
    const personId = await createPerson(db, { firstName: "Eve", lastName: "Range" });
    const applicationId = await newSnowApplication(db, personId, new Date());
    const today = centralDate(new Date());

    const all = await runExport(db, { name: "stage_events", filters: { openingId: snow.openingId, from: today, to: today }, actor: staff });
    expect(readTable(all.body).rows.some((r) => r.application_id === applicationId && r.kind === "created")).toBe(true);
    const none = await runExport(db, { name: "stage_events", filters: { to: "2000-01-01" }, actor: staff });
    expect(none.rows).toBe(0);
    const windowOpening = await db.execute<{ id: string }>(sqlRaw`select id from opening where key = 'window-2027'`);
    const other = await runExport(db, { name: "stage_events", filters: { openingId: windowOpening[0]!.id }, actor: staff });
    expect(readTable(other.body).rows.some((r) => r.application_id === applicationId)).toBe(false);
  });

  it("lists entry codes with their daily scans", async () => {
    // Rolled back: other test files count the seeded codes and their scan days.
    await withRollback(db, async (tx) => {
      const codeId = uuidv7();
      await tx.insert(entryCode).values({
        id: codeId,
        code: "EXP0RT1",
        roleId: snow.roleId,
        openingId: snow.openingId,
        channel: "flyer",
        label: "Export test flyer",
        createdBy: adminId,
      });
      await recordScan(tx, codeId);
      await recordScan(tx, codeId);
      const today = centralDate(new Date());
      const file = await runExport(tx, { name: "entry_codes", filters: { openingId: snow.openingId, from: today, to: today }, actor: staff });
      const { rows } = readTable(file.body);
      const scanned = rows.filter((r) => r.code === "EXP0RT1");
      expect(scanned).toHaveLength(1);
      expect(scanned[0]!.scan_day).toBe(today);
      expect(scanned[0]!.scans).toBe("2");
      expect(scanned[0]!.opening_key).toBe("snow-2026-27");
      expect(scanned[0]!.created_by_email).toBe(TEST_ADMIN_EMAIL);
      // The launch codes belong to the opening too (the role QR floats to whichever opening is open).
      expect(rows.some((r) => r.code === LAUNCH_ENTRY_CODES.snowIndeedMessage)).toBe(true);
      expect(rows.some((r) => r.code === LAUNCH_ENTRY_CODES.snowRoleQr)).toBe(true);
    });
  });

  it("the questions dictionary lists option keys and labels per version", async () => {
    const file = await runExport(db, { name: "questions", filters: {}, actor: staff });
    const { rows } = readTable(file.body);
    const snowResponse = rows.filter((r) => r.role_key === "snow_removal_tech" && r.question_key === "response_time" && r.version === "1");
    expect(snowResponse.map((r) => r.option_key)).toEqual(["under_30", "30_to_60", "1_to_2h", "over_2h"]);
    expect(snowResponse[0]!.option_label).toBe("Within 30 minutes");
    expect(snowResponse[0]!.in_form_versions).toContain("v1");
    const age = rows.find((r) => r.role_key === "snow_removal_tech" && r.question_key === "age_18_plus")!;
    expect(age.ai_never_send).toBe("true");
    expect(age.option_key).toBe("");
  });
});
