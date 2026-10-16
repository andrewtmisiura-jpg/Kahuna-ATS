import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import {
  answer,
  application,
  applicationEvent,
  appUser,
  backgroundCheck,
  consentEvent,
  employer,
  entryCode,
  entryCodeScanDay,
  groupSession,
  hireStint,
  legalTextVersion,
  message,
  messageTemplate,
  note,
  offer,
  opening,
  picklistOption,
  pipelineStage,
  question,
  questionVersion,
  role,
} from "@/db/schema";
import {
  boolCell,
  centralIso,
  dayRange,
  displayBody,
  jsonCell,
  openingFilter,
  timestampRange,
  type ExportContext,
  type ExportTable,
} from "./shared";
import { answerLabels, answerValue, checkResult } from "./wide";

// The long files: one row per answer, event, message, consent event, session,
// entry code scan day, offer, background check, hire stint or note. Each takes
// the optional opening filter (through the application where the row has one)
// and the optional date range on the column named in the registry.

export async function answersLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const rows = await db
    .select({
      a: answer,
      openingKey: opening.key,
      personId: application.personId,
      questionKey: question.key,
      version: questionVersion.version,
      type: questionVersion.type,
      options: questionVersion.options,
      startsWithCheck: questionVersion.startsWithCheck,
    })
    .from(answer)
    .innerJoin(application, eq(application.id, answer.applicationId))
    .innerJoin(opening, eq(opening.id, application.openingId))
    .innerJoin(questionVersion, eq(questionVersion.id, answer.questionVersionId))
    .innerJoin(question, eq(question.id, questionVersion.questionId))
    .where(and(isNull(application.deletedAt), openingFilter(application.openingId, ctx), timestampRange(application.startedAt, ctx.range)))
    .orderBy(asc(application.startedAt), asc(answer.applicationId), asc(question.key), asc(questionVersion.version));

  return {
    headers: [
      "application_id",
      "opening_key",
      "person_id",
      "question_key",
      "question_version",
      "type",
      "value",
      "option_labels",
      "check_result",
      "revision",
      "updated_at",
    ],
    rows: rows.map((row) => [
      row.a.applicationId,
      row.openingKey,
      row.personId,
      row.questionKey,
      row.version,
      row.type,
      answerValue({ type: row.type }, row.a),
      answerLabels({ options: row.options }, row.a),
      checkResult(row.startsWithCheck, row.a),
      row.a.revision,
      centralIso(row.a.updatedAt),
    ]),
  };
}

export async function stageEventsLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const fromStage = alias(pipelineStage, "from_stage");
  const toStage = alias(pipelineStage, "to_stage");
  const rows = await db
    .select({
      e: applicationEvent,
      openingKey: opening.key,
      fromStageKey: fromStage.key,
      toStageKey: toStage.key,
      toMilestone: toStage.milestone,
      reasonKey: picklistOption.key,
      reasonLabel: picklistOption.label,
      actorEmail: appUser.email,
      voided: sql<boolean>`exists (select 1 from application_event v where v.voids_event_id = ${applicationEvent.id})`,
    })
    .from(applicationEvent)
    .innerJoin(application, eq(application.id, applicationEvent.applicationId))
    .innerJoin(opening, eq(opening.id, application.openingId))
    .leftJoin(fromStage, eq(fromStage.id, applicationEvent.fromStageId))
    .leftJoin(toStage, eq(toStage.id, applicationEvent.toStageId))
    .leftJoin(picklistOption, eq(picklistOption.id, applicationEvent.reasonOptionId))
    .leftJoin(appUser, eq(appUser.id, applicationEvent.actorUserId))
    .where(and(isNull(application.deletedAt), openingFilter(application.openingId, ctx), timestampRange(applicationEvent.occurredAt, ctx.range)))
    .orderBy(asc(applicationEvent.occurredAt), asc(applicationEvent.applicationId), asc(applicationEvent.seq));

  return {
    headers: [
      "event_id",
      "application_id",
      "opening_key",
      "seq",
      "kind",
      "from_stage_key",
      "to_stage_key",
      "to_milestone",
      "from_status",
      "to_status",
      "closed_outcome",
      "reason_key",
      "reason_label",
      "note",
      "voided",
      "voids_event_id",
      "actor_type",
      "actor_email",
      "occurred_at",
      "recorded_at",
      "batch_id",
      "metadata",
    ],
    rows: rows.map((row) => [
      row.e.id,
      row.e.applicationId,
      row.openingKey,
      row.e.seq,
      row.e.kind,
      row.fromStageKey,
      row.toStageKey,
      row.toMilestone,
      row.e.fromStatus,
      row.e.toStatus,
      row.e.closedOutcome,
      row.reasonKey,
      row.reasonLabel,
      row.e.note,
      boolCell(row.voided),
      row.e.voidsEventId,
      row.e.actorType,
      row.actorEmail,
      centralIso(row.e.occurredAt),
      centralIso(row.e.recordedAt),
      row.e.batchId,
      jsonCell(row.e.metadata),
    ]),
  };
}

// Metadata and status plus the body as stored; links were already replaced by a
// placeholder at send time, shown here as "[application link]".
export async function messagesLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const triggeredBy = alias(appUser, "triggered_by_user");
  const handledBy = alias(appUser, "handled_by_user");
  const rows = await db
    .select({
      m: message,
      openingKey: opening.key,
      templateName: messageTemplate.name,
      triggeredByEmail: triggeredBy.email,
      handledByEmail: handledBy.email,
    })
    .from(message)
    .leftJoin(application, eq(application.id, message.applicationId))
    .leftJoin(opening, eq(opening.id, application.openingId))
    .leftJoin(messageTemplate, eq(messageTemplate.id, message.templateId))
    .leftJoin(triggeredBy, eq(triggeredBy.id, message.triggeredByUserId))
    .leftJoin(handledBy, eq(handledBy.id, message.handledBy))
    .where(and(openingFilter(application.openingId, ctx), timestampRange(message.createdAt, ctx.range)))
    .orderBy(asc(message.createdAt), asc(message.id));

  return {
    headers: [
      "message_id",
      "direction",
      "channel",
      "person_id",
      "application_id",
      "opening_key",
      "purpose",
      "template_name",
      "to_address",
      "from_address",
      "subject",
      "body",
      "status",
      "provider",
      "provider_message_id",
      "error_code",
      "segments",
      "dedupe_key",
      "send_after",
      "attempts",
      "sent_at",
      "delivered_at",
      "failed_at",
      "triggered_by_type",
      "triggered_by_email",
      "handled_at",
      "handled_by_email",
      "created_at",
    ],
    rows: rows.map((row) => [
      row.m.id,
      row.m.direction,
      row.m.channel,
      row.m.personId,
      row.m.applicationId,
      row.openingKey,
      row.m.purpose,
      row.templateName,
      row.m.toAddress,
      row.m.fromAddress,
      row.m.subject,
      displayBody(row.m.body),
      row.m.status,
      row.m.provider,
      row.m.providerMessageId,
      row.m.errorCode,
      row.m.segments,
      row.m.dedupeKey,
      centralIso(row.m.sendAfter),
      row.m.attempts,
      centralIso(row.m.sentAt),
      centralIso(row.m.deliveredAt),
      centralIso(row.m.failedAt),
      row.m.triggeredByType,
      row.triggeredByEmail,
      centralIso(row.m.handledAt),
      row.handledByEmail,
      centralIso(row.m.createdAt),
    ]),
  };
}

export async function consentEventsLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const rows = await db
    .select({
      c: consentEvent,
      openingKey: opening.key,
      legalKind: legalTextVersion.kind,
      legalVersion: legalTextVersion.version,
      entryCode: entryCode.code,
      recordedByEmail: appUser.email,
    })
    .from(consentEvent)
    .leftJoin(application, eq(application.id, consentEvent.applicationId))
    .leftJoin(opening, eq(opening.id, application.openingId))
    .leftJoin(legalTextVersion, eq(legalTextVersion.id, consentEvent.legalTextVersionId))
    .leftJoin(entryCode, eq(entryCode.id, consentEvent.entryCodeId))
    .leftJoin(appUser, eq(appUser.id, consentEvent.recordedBy))
    .where(and(openingFilter(application.openingId, ctx), timestampRange(consentEvent.occurredAt, ctx.range)))
    .orderBy(asc(consentEvent.occurredAt), asc(consentEvent.id));

  return {
    headers: [
      "consent_event_id",
      "person_id",
      "application_id",
      "opening_key",
      "channel",
      "address",
      "action",
      "method",
      "legal_text_kind",
      "legal_text_version",
      "checkbox_value",
      "language",
      "ip",
      "user_agent",
      "entry_code",
      "message_id",
      "recorded_by_email",
      "occurred_at",
    ],
    rows: rows.map((row) => [
      row.c.id,
      row.c.personId,
      row.c.applicationId,
      row.openingKey,
      row.c.channel,
      row.c.address,
      row.c.action,
      row.c.method,
      row.legalKind,
      row.legalVersion,
      boolCell(row.c.checkboxValue),
      row.c.language,
      row.c.ip,
      row.c.userAgent,
      row.entryCode,
      row.c.messageId,
      row.recordedByEmail,
      centralIso(row.c.occurredAt),
    ]),
  };
}

export async function sessionsLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const rows = await db
    .select({
      s: groupSession,
      openingKey: opening.key,
      createdByEmail: appUser.email,
      attributedApplications: sql<number>`(select count(*)::int from application a where a.attributed_session_id = ${groupSession.id} and a.deleted_at is null)`,
    })
    .from(groupSession)
    .innerJoin(opening, eq(opening.id, groupSession.openingId))
    .leftJoin(appUser, eq(appUser.id, groupSession.createdBy))
    .where(and(isNull(groupSession.deletedAt), openingFilter(groupSession.openingId, ctx), timestampRange(groupSession.startsAt, ctx.range)))
    .orderBy(asc(groupSession.startsAt), asc(groupSession.id));

  return {
    headers: [
      "session_id",
      "opening_key",
      "starts_at",
      "location_name",
      "location_address",
      "status",
      "invited_count",
      "attended_count",
      "attributed_applications",
      "notes",
      "created_by_email",
      "created_at",
    ],
    rows: rows.map((row) => [
      row.s.id,
      row.openingKey,
      centralIso(row.s.startsAt),
      row.s.locationName,
      row.s.locationAddress,
      row.s.status,
      row.s.invitedCount,
      row.s.attendedCount,
      row.attributedApplications,
      row.s.notes,
      row.createdByEmail,
      centralIso(row.s.createdAt),
    ]),
  };
}

// One row per code per scan day; a code never scanned (or not in the date range)
// still appears once with an empty day. With an opening filter, the role's codes
// that float to whichever opening is open are included too.
export async function entryCodesLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const scope = ctx.opening
    ? or(eq(entryCode.openingId, ctx.opening.id), and(isNull(entryCode.openingId), eq(entryCode.roleId, ctx.opening.roleId)))
    : undefined;
  const codes = await db
    .select({ c: entryCode, roleKey: role.key, openingKey: opening.key, createdByEmail: appUser.email })
    .from(entryCode)
    .innerJoin(role, eq(role.id, entryCode.roleId))
    .leftJoin(opening, eq(opening.id, entryCode.openingId))
    .leftJoin(appUser, eq(appUser.id, entryCode.createdBy))
    .where(scope)
    .orderBy(asc(entryCode.createdAt), asc(entryCode.code));
  const scans = await db
    .select()
    .from(entryCodeScanDay)
    .where(dayRange(entryCodeScanDay.day, ctx.range))
    .orderBy(asc(entryCodeScanDay.day));
  const scansByCode = new Map<string, typeof scans>();
  for (const scan of scans) {
    const list = scansByCode.get(scan.entryCodeId) ?? [];
    list.push(scan);
    scansByCode.set(scan.entryCodeId, list);
  }

  const headers = [
    "code",
    "label",
    "channel",
    "role_key",
    "opening_key",
    "group_session_id",
    "closed_at",
    "created_by_email",
    "created_at",
    "scan_day",
    "scans",
  ];
  const rows: ExportTable["rows"] = [];
  for (const row of codes) {
    const base = [
      row.c.code,
      row.c.label,
      row.c.channel,
      row.roleKey,
      row.openingKey,
      row.c.groupSessionId,
      centralIso(row.c.closedAt),
      row.createdByEmail,
      centralIso(row.c.createdAt),
    ];
    const days = scansByCode.get(row.c.id) ?? [];
    if (days.length === 0) rows.push([...base, "", 0]);
    for (const day of days) rows.push([...base, day.day, day.scans]);
  }
  return { headers, rows };
}

export async function offersLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const rows = await db
    .select({ o: offer, openingKey: opening.key, offeredByEmail: appUser.email })
    .from(offer)
    .innerJoin(application, eq(application.id, offer.applicationId))
    .innerJoin(opening, eq(opening.id, application.openingId))
    .leftJoin(appUser, eq(appUser.id, offer.offeredBy))
    .where(and(isNull(application.deletedAt), openingFilter(application.openingId, ctx), dayRange(offer.offeredOn, ctx.range)))
    .orderBy(asc(offer.offeredOn), asc(offer.createdAt));

  return {
    headers: [
      "offer_id",
      "application_id",
      "opening_key",
      "offered_on",
      "offered_by_email",
      "is_conditional",
      "pay_amount",
      "pay_unit",
      "planned_start_on",
      "response",
      "responded_on",
      "note",
      "deleted_at",
      "created_at",
    ],
    rows: rows.map((row) => [
      row.o.id,
      row.o.applicationId,
      row.openingKey,
      row.o.offeredOn,
      row.offeredByEmail,
      boolCell(row.o.isConditional),
      row.o.payAmount,
      row.o.payUnit,
      row.o.plannedStartOn,
      row.o.response,
      row.o.respondedOn,
      row.o.note,
      centralIso(row.o.deletedAt),
      centralIso(row.o.createdAt),
    ]),
  };
}

// Type, vendor, status and dates only: never the vendor reference, the note or
// anything from the report itself.
export async function backgroundChecksLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const rows = await db
    .select({ b: backgroundCheck, openingKey: opening.key })
    .from(backgroundCheck)
    .innerJoin(application, eq(application.id, backgroundCheck.applicationId))
    .innerJoin(opening, eq(opening.id, application.openingId))
    .where(and(isNull(application.deletedAt), openingFilter(application.openingId, ctx), timestampRange(backgroundCheck.createdAt, ctx.range)))
    .orderBy(asc(backgroundCheck.createdAt), asc(backgroundCheck.id));

  return {
    headers: [
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
    ],
    rows: rows.map((row) => [
      row.b.id,
      row.b.applicationId,
      row.openingKey,
      row.b.offerId,
      row.b.checkType,
      row.b.vendor,
      row.b.status,
      row.b.requestedOn,
      row.b.completedOn,
      row.b.preAdverseNoticeOn,
      row.b.finalAdverseOn,
      centralIso(row.b.createdAt),
      centralIso(row.b.updatedAt),
    ]),
  };
}

export async function hiresLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const crew = alias(picklistOption, "crew_option");
  const leaveReason = alias(picklistOption, "leave_reason_option");
  const rows = await db
    .select({
      h: hireStint,
      employerKey: employer.key,
      roleKey: role.key,
      openingKey: opening.key,
      crewKey: crew.key,
      crewLabel: crew.label,
      leaveReasonKey: leaveReason.key,
      leaveReasonLabel: leaveReason.label,
    })
    .from(hireStint)
    .innerJoin(employer, eq(employer.id, hireStint.employerId))
    .innerJoin(role, eq(role.id, hireStint.roleId))
    .leftJoin(opening, eq(opening.id, hireStint.openingId))
    .leftJoin(crew, eq(crew.id, hireStint.crewOptionId))
    .leftJoin(leaveReason, eq(leaveReason.id, hireStint.leaveReasonOptionId))
    .where(and(openingFilter(hireStint.openingId, ctx), timestampRange(hireStint.createdAt, ctx.range)))
    .orderBy(asc(hireStint.createdAt), asc(hireStint.id));

  return {
    headers: [
      "hire_stint_id",
      "person_id",
      "application_id",
      "origin",
      "employer_key",
      "role_key",
      "opening_key",
      "is_temporary",
      "planned_end_on",
      "crew_key",
      "crew_label",
      "offer_accepted_on",
      "planned_start_on",
      "start_on",
      "last_worked_on",
      "end_on",
      "outcome",
      "separation_type",
      "leave_reason_key",
      "leave_reason_label",
      "leave_note",
      "rehire_eligible",
      "rating_30",
      "rating_90",
      "season_end_rating",
      "storms_worked",
      "voided_at",
      "void_kind",
      "void_reason",
      "created_at",
      "updated_at",
    ],
    rows: rows.map((row) => [
      row.h.id,
      row.h.personId,
      row.h.applicationId,
      row.h.origin,
      row.employerKey,
      row.roleKey,
      row.openingKey,
      boolCell(row.h.isTemporary),
      row.h.plannedEndOn,
      row.crewKey,
      row.crewLabel,
      row.h.offerAcceptedOn,
      row.h.plannedStartOn,
      row.h.startOn,
      row.h.lastWorkedOn,
      row.h.endOn,
      row.h.outcome,
      row.h.separationType,
      row.leaveReasonKey,
      row.leaveReasonLabel,
      row.h.leaveNote,
      boolCell(row.h.rehireEligible),
      row.h.rating30,
      row.h.rating90,
      row.h.seasonEndRating,
      row.h.stormsWorked,
      centralIso(row.h.voidedAt),
      row.h.voidKind,
      row.h.voidReason,
      centralIso(row.h.createdAt),
      centralIso(row.h.updatedAt),
    ]),
  };
}

// Staff notes without the restricted ones (accommodation or health information
// never leaves the app) and without soft-deleted ones (a deleted note was retracted).
export async function notesLong(db: Db, ctx: ExportContext): Promise<ExportTable> {
  const rows = await db
    .select({ n: note, openingKey: opening.key, authorEmail: appUser.email })
    .from(note)
    .leftJoin(application, eq(application.id, note.applicationId))
    .leftJoin(opening, eq(opening.id, application.openingId))
    .leftJoin(appUser, eq(appUser.id, note.authorUserId))
    .where(
      and(
        eq(note.isRestricted, false),
        isNull(note.deletedAt),
        openingFilter(application.openingId, ctx),
        timestampRange(note.createdAt, ctx.range),
      ),
    )
    .orderBy(asc(note.createdAt), asc(note.id));

  return {
    headers: ["note_id", "person_id", "application_id", "opening_key", "body", "author_email", "created_at"],
    rows: rows.map((row) => [
      row.n.id,
      row.n.personId,
      row.n.applicationId,
      row.openingKey,
      row.n.body,
      row.authorEmail,
      centralIso(row.n.createdAt),
    ]),
  };
}
