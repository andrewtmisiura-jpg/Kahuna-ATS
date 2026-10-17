import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { application, employer, groupSession, message, messageTemplate, person, role } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { actorColumns, type Actor } from "../actor";
import { centralDate, addDays, centralInstant, isInSendWindow, nextSendWindowStart, SEND_WINDOW } from "../time";
import { linkPlaceholder, mintResumeToken, resumeLink } from "../tokens";
import { isOptedIn, latestConsent, liveSuppression, recordConsent, suppress } from "./consent";
import { ProviderError, type Providers } from "./providers/types";
import { formatCentralMoment, parseInterviewReminderKey } from "./template-text";

// The single send function (DATA_MODEL.md, "Send rules"). Every outbound text and
// email is a message row: queued first, then claimed, checked against the rules at
// send time, committed as `sending` and only then handed to a provider.

export type MessageRow = typeof message.$inferSelect;
export type MessagePurpose = NonNullable<MessageRow["purpose"]>;
export type Channel = "sms" | "email";
type EmployerRow = typeof employer.$inferSelect;
type PersonRow = typeof person.$inferSelect;
type ApplicationRow = typeof application.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// A text the applicant did not just ask for waits for the 9am to 8pm window; a
// text that cannot go falls back to email unless the same send already carries one.
const PURPOSE_RULES: Record<MessagePurpose, { requested: boolean; emailFallback: boolean }> = {
  resume_link: { requested: true, emailFallback: false },
  link_recovery: { requested: true, emailFallback: false },
  help_reply: { requested: true, emailFallback: false },
  reminder_24h: { requested: false, emailFallback: true },
  submit_confirmation: { requested: false, emailFallback: true },
  group_invite: { requested: false, emailFallback: true },
  one_on_one_invite: { requested: false, emailFallback: true },
  one_on_one_reminder: { requested: false, emailFallback: true },
  status_update: { requested: false, emailFallback: true },
  decline: { requested: false, emailFallback: true },
};

const LINK_PURPOSES: readonly MessagePurpose[] = ["resume_link", "link_recovery"];
const LINK_SENDS_PER_HOUR = 3;
export const MAX_ATTEMPTS = 3;
// A row left in `sending` this long without a provider id is stuck.
const STUCK_AFTER_MS = 10 * 60_000;

// Send rule 4: the first text to a number since its latest opt-in carries the full disclosure.
export const FULL_DISCLOSURE = "Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
const SHORT_CLOSING = "Reply STOP to opt out.";

export type SendErrorCode = "employer_not_found" | "no_address" | "no_template" | "link_rate_limited" | "sms_not_configured";

export class SendError extends Error {
  constructor(
    readonly code: SendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SendError";
  }
}

export type QueueRequest = {
  employerId: string;
  channel: Channel;
  personId?: string | null;
  applicationId?: string | null;
  // A seeded template by purpose, or raw content (alerts and digests to staff).
  content: { purpose: MessagePurpose; vars?: Record<string, string> } | { subject: string; body: string };
  // Used instead of the person's address: a HELP reply goes to the number that texted.
  toAddress?: string | null;
  // At most one message per key, ever (reminder_24h:<application_id>, alert:<kind>:<hour>).
  dedupeKey?: string | null;
  triggeredBy: Actor;
  sendAfter?: Date | null;
  now?: Date;
};

export type QueueResult = { messageId: string; created: boolean };

export async function queueMessage(db: Db, request: QueueRequest): Promise<QueueResult> {
  const now = request.now ?? new Date();
  const emp = await loadEmployer(db, request.employerId);
  const app = request.applicationId ? await loadApplication(db, request.applicationId) : null;
  const personId = request.personId ?? app?.personId ?? null;
  const who = personId ? await loadPerson(db, personId) : null;

  const toAddress = request.toAddress ?? (who ? addressFor(who, request.channel) : null);
  if (!toAddress) throw new SendError("no_address", `The person has no ${request.channel === "sms" ? "mobile number" : "email"}`);

  let purpose: MessagePurpose | null = null;
  let templateId: string | null = null;
  let subject: string | null;
  let body: string;
  if ("purpose" in request.content) {
    purpose = request.content.purpose;
    const template = await findTemplate(db, emp.id, app?.roleId ?? null, purpose, request.channel);
    if (!template) throw new SendError("no_template", `No ${request.channel} template for ${purpose}`);
    templateId = template.id;
    const vars = { ...(await templateVars(db, emp, who, app)), ...request.content.vars };
    subject = template.subject ? renderTemplate(template.subject, vars) : null;
    body = renderTemplate(template.body, vars);
  } else {
    subject = request.content.subject;
    body = request.content.body;
  }

  if (purpose && LINK_PURPOSES.includes(purpose)) await enforceLinkRateLimit(db, toAddress, now);

  const id = uuidv7();
  const inserted = await db
    .insert(message)
    .values({
      id,
      direction: "outbound",
      channel: request.channel,
      personId,
      applicationId: app?.id ?? null,
      templateId,
      purpose,
      toAddress,
      fromAddress: fromAddress(emp, request.channel),
      subject,
      body,
      status: "queued",
      provider: "sink",
      dedupeKey: request.dedupeKey ?? null,
      sendAfter: request.sendAfter ?? null,
      ...triggeredColumns(request.triggeredBy),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: message.dedupeKey })
    .returning({ id: message.id });
  if (inserted[0]) return { messageId: inserted[0].id, created: true };

  const [existing] = await db
    .select({ id: message.id })
    .from(message)
    .where(eq(message.dedupeKey, request.dedupeKey!))
    .limit(1);
  return { messageId: existing!.id, created: false };
}

export type SendSummary = {
  sent: string[];
  failed: string[];
  deferred: string[];
  suppressed: string[];
  // Set when the pass hit the daily cap or an empty Quo balance, so the cron can alert once.
  capReached: boolean;
  balanceEmpty: boolean;
};

// Sends the given queued messages right away (resume links inside the request).
export async function processMessages(db: Db, ids: string[], providers: Providers, now: Date = new Date()): Promise<SendSummary> {
  return runPass(db, providers, now, (tx) =>
    tx
      .select()
      .from(message)
      .where(and(inArray(message.id, ids), eq(message.status, "queued"), eq(message.direction, "outbound")))
      .orderBy(asc(message.createdAt))
      .for("update", { skipLocked: true }),
  );
}

// The cron's pass: claims due rows with FOR UPDATE SKIP LOCKED so two passes at
// the same moment never both send one row.
export async function sendDueMessages(
  db: Db,
  providers: Providers,
  options: { now?: Date; limit?: number } = {},
): Promise<SendSummary> {
  const now = options.now ?? new Date();
  return runPass(db, providers, now, (tx) =>
    tx
      .select()
      .from(message)
      .where(
        and(
          eq(message.status, "queued"),
          eq(message.direction, "outbound"),
          or(isNull(message.sendAfter), lte(message.sendAfter, now)),
        ),
      )
      .orderBy(asc(message.createdAt))
      .limit(options.limit ?? 50)
      .for("update", { skipLocked: true }),
  );
}

type Prepared = {
  row: MessageRow;
  employer: EmployerRow;
  to: string;
  deliverBody: string;
  subject: string | null;
  attempt: number;
};

type PrepareOutcome =
  | { kind: "send"; prepared: Prepared }
  | { kind: "deferred"; until: Date; reason: "quiet_hours" | "daily_cap" }
  | { kind: "suppressed"; reason: string; fallbackId: string | null };

async function runPass(
  db: Db,
  providers: Providers,
  now: Date,
  claim: (tx: Tx) => Promise<MessageRow[]>,
): Promise<SendSummary> {
  const summary: SendSummary = { sent: [], failed: [], deferred: [], suppressed: [], capReached: false, balanceEmpty: false };
  const toDeliver: Prepared[] = [];
  const followUps: string[] = [];

  // Claim and the rule checks happen in one transaction: when it commits, every
  // claimed row is `sending`, deferred or suppressed, so another pass skips it.
  await db.transaction(async (tx) => {
    const rows = await claim(tx);
    for (const row of rows) {
      const outcome = await prepare(tx, row, now);
      applyOutcome(summary, row.id, outcome, toDeliver, followUps);
    }
  });

  for (const prepared of toDeliver) {
    if (summary.balanceEmpty && prepared.row.channel === "sms") {
      await requeue(db, prepared.row.id, now);
      continue;
    }
    const result = await deliver(db, prepared, providers, now);
    if (result === "sent") summary.sent.push(prepared.row.id);
    else if (result === "retry") summary.deferred.push(prepared.row.id);
    else {
      summary.failed.push(prepared.row.id);
      if (result === "balance_empty") summary.balanceEmpty = true;
      if (result === "balance_empty" || result === "opted_out") {
        const fallbackId = await db.transaction((tx) => queueEmailFallback(tx, prepared.row, now));
        if (fallbackId) followUps.push(fallbackId);
      }
    }
  }

  // Email fallbacks created during this pass go out in the same pass.
  if (followUps.length > 0) {
    const more = await processMessages(db, followUps, providers, now);
    summary.sent.push(...more.sent);
    summary.failed.push(...more.failed);
    summary.deferred.push(...more.deferred);
    summary.suppressed.push(...more.suppressed);
    summary.capReached ||= more.capReached;
  }
  return summary;
}

function applyOutcome(summary: SendSummary, id: string, outcome: PrepareOutcome, toDeliver: Prepared[], followUps: string[]) {
  switch (outcome.kind) {
    case "send":
      toDeliver.push(outcome.prepared);
      break;
    case "deferred":
      summary.deferred.push(id);
      if (outcome.reason === "daily_cap") summary.capReached = true;
      break;
    case "suppressed":
      summary.suppressed.push(id);
      if (outcome.fallbackId) followUps.push(outcome.fallbackId);
      break;
  }
}

// The send-time rule checks, in the doc's order. Runs under the row lock.
async function prepare(tx: Tx, row: MessageRow, now: Date): Promise<PrepareOutcome> {
  const emp = await resolveEmployer(tx, row);
  const who = row.personId ? await loadPerson(tx, row.personId) : null;
  const rules = row.purpose ? PURPOSE_RULES[row.purpose] : { requested: true, emailFallback: false };
  const refuse = (reason: string) => markSuppressed(tx, row, emp, who, reason, rules.emailFallback, now);

  // Rule 1: do-not-contact blocks every send; a suppressed address blocks that channel.
  if (who?.doNotContact) return refuse("do_not_contact");

  // The address on file now, not the one at queue time (consent belongs to the number).
  let to = row.toAddress;
  if (who && row.purpose !== "help_reply") to = addressFor(who, row.channel);
  if (!to) return refuse(row.channel === "sms" ? "no_mobile" : "no_email");
  if (await liveSuppression(tx, row.channel, to)) return refuse("suppressed");

  if (row.channel === "sms") {
    // Rule 2: texting on, the number connected, and a current opt-in for this number.
    if (!emp.smsEnabled) return refuse("sms_disabled");
    if (!emp.smsQuoPhoneNumberId) return refuse("sms_not_connected");
    if (row.purpose !== "help_reply" && !isOptedIn(await latestConsent(tx, to, emp.id))) return refuse("no_opt_in");
    // Rule 3: quiet hours for anything the applicant did not just ask for.
    if (!rules.requested && !isInSendWindow(now)) {
      const until = nextSendWindowStart(now);
      await tx.update(message).set({ sendAfter: until, updatedAt: now }).where(eq(message.id, row.id));
      return { kind: "deferred", until, reason: "quiet_hours" };
    }
  }

  // Rule 9: the daily cap across both channels; alerts to staff are exempt.
  if (row.purpose && (await sentTodayCount(tx, now)) >= emp.dailySendCap) {
    const until = centralInstant(addDays(centralDate(now), 1), SEND_WINDOW.startHour);
    await tx.update(message).set({ sendAfter: until, updatedAt: now }).where(eq(message.id, row.id));
    return { kind: "deferred", until, reason: "daily_cap" };
  }

  // Rule 5: links are minted at send; the stored body keeps a placeholder.
  let storedBody = row.body ?? "";
  let deliverBody = storedBody;
  if (LINK_PATTERN.test(storedBody)) {
    if (!row.applicationId) throw new SendError("no_address", "A link message needs an application");
    const minted = await mintResumeToken(tx, {
      applicationId: row.applicationId,
      issuedVia: row.triggeredByType === "staff" ? "staff_reissue" : "message",
      messageId: row.id,
      now,
    });
    storedBody = storedBody.replace(LINK_PATTERN, linkPlaceholder(minted.tokenId));
    deliverBody = deliverBody.replace(LINK_PATTERN, resumeLink(emp.hiringHost, minted.token));
  }

  // Rule 4: the first text since the latest opt-in carries the full disclosure.
  if (row.channel === "sms" && (await isFirstTextSinceOptIn(tx, row, to, emp.id))) {
    storedBody = withFullDisclosure(storedBody);
    deliverBody = withFullDisclosure(deliverBody);
  }

  // Rule 6: `sending` and the attempt count are committed before the provider call.
  const attempt = row.attempts + 1;
  await tx
    .update(message)
    .set({ status: "sending", attempts: attempt, lockedAt: now, toAddress: to, body: storedBody, updatedAt: now })
    .where(eq(message.id, row.id));
  return { kind: "send", prepared: { row, employer: emp, to, deliverBody, subject: row.subject, attempt } };
}

type DeliverResult = "sent" | "retry" | "failed" | "balance_empty" | "opted_out";

async function deliver(db: Db, prepared: Prepared, providers: Providers, now: Date): Promise<DeliverResult> {
  const { row, employer: emp, to, deliverBody, subject, attempt } = prepared;
  try {
    const result =
      row.channel === "sms"
        ? await providers.text.sendText({ messageId: row.id, attempt, to, fromPhoneNumberId: emp.smsQuoPhoneNumberId!, body: deliverBody })
        : await providers.email.sendEmail({
            messageId: row.id,
            attempt,
            to,
            from: fromAddress(emp, "email"),
            fromName: emp.emailFromName,
            replyTo: emp.replyToAddress,
            subject: subject ?? "",
            body: deliverBody,
          });
    await db
      .update(message)
      .set({
        status: "sent",
        provider: providers[row.channel === "sms" ? "text" : "email"].name,
        providerMessageId: result.providerMessageId,
        segments: row.channel === "sms" ? (result.segments ?? estimateSegments(deliverBody)) : null,
        sentAt: now,
        lockedAt: null,
        updatedAt: now,
      })
      .where(eq(message.id, row.id));
    return "sent";
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : new ProviderError("transient", String(error));
    const code = providerError.code ?? providerError.kind;
    console.error(`[send] message ${row.id} attempt ${attempt} failed: ${providerError.kind} ${providerError.message}`);

    if (providerError.kind === "transient" && attempt < MAX_ATTEMPTS) {
      await db
        .update(message)
        .set({ status: "queued", sendAfter: new Date(now.getTime() + attempt * 60_000), errorCode: code, lockedAt: null, updatedAt: now })
        .where(eq(message.id, row.id));
      return "retry";
    }
    await db
      .update(message)
      .set({ status: "failed", failedAt: now, errorCode: code, lockedAt: null, updatedAt: now })
      .where(eq(message.id, row.id));

    if (providerError.kind === "opted_out" && row.channel === "sms") {
      // Rule 8: a Quo opt-out from any Kahuna number is recorded here, with no staff step.
      await db.transaction(async (tx) => {
        await suppress(tx, { channel: "sms", address: to, reason: "carrier_blocked", messageId: row.id, now });
        if (row.personId) {
          await recordConsent(tx, {
            personId: row.personId,
            applicationId: row.applicationId,
            employerId: emp.id,
            channel: "sms",
            address: to,
            action: "opt_out",
            method: "keyword",
            messageId: row.id,
            occurredAt: now,
          });
        }
      });
      return "opted_out";
    }
    return providerError.kind === "insufficient_balance" ? "balance_empty" : "failed";
  }
}

// Puts a claimed row back in the queue untouched by a provider (empty balance mid-pass).
async function requeue(db: Db, id: string, now: Date) {
  await db
    .update(message)
    .set({ status: "queued", attempts: sql`greatest(${message.attempts} - 1, 0)`, lockedAt: null, updatedAt: now })
    .where(and(eq(message.id, id), eq(message.status, "sending")));
}

async function markSuppressed(
  tx: Tx,
  row: MessageRow,
  emp: EmployerRow,
  who: PersonRow | null,
  reason: string,
  emailFallback: boolean,
  now: Date,
): Promise<PrepareOutcome> {
  await tx
    .update(message)
    .set({ status: "suppressed", errorCode: reason, lockedAt: null, updatedAt: now })
    .where(eq(message.id, row.id));
  const canFallBack = emailFallback && row.channel === "sms" && reason !== "do_not_contact" && who?.email;
  const fallbackId = canFallBack ? await queueEmailFallback(tx, row, now, emp) : null;
  return { kind: "suppressed", reason, fallbackId };
}

// The same message by email when a text cannot go (send rule 2).
async function queueEmailFallback(tx: Db, row: MessageRow, now: Date, emp?: EmployerRow): Promise<string | null> {
  if (!row.purpose || !row.personId || !PURPOSE_RULES[row.purpose].emailFallback) return null;
  const employerRow = emp ?? (await resolveEmployer(tx, row));
  const who = await loadPerson(tx, row.personId);
  if (!who.email || who.doNotContact || (await liveSuppression(tx, "email", who.email))) return null;
  const app = row.applicationId ? await loadApplication(tx, row.applicationId) : null;
  const template = await findTemplate(tx, employerRow.id, app?.roleId ?? null, row.purpose, "email");
  if (!template) return null;
  const vars = { ...(await templateVars(tx, employerRow, who, app)), ...fallbackVars(row) };
  const [inserted] = await tx
    .insert(message)
    .values({
      id: uuidv7(),
      direction: "outbound",
      channel: "email",
      personId: who.id,
      applicationId: app?.id ?? null,
      templateId: template.id,
      purpose: row.purpose,
      toAddress: who.email,
      fromAddress: fromAddress(employerRow, "email"),
      subject: template.subject ? renderTemplate(template.subject, vars) : null,
      body: renderTemplate(template.body, vars),
      status: "queued",
      provider: "sink",
      dedupeKey: row.dedupeKey ? `${row.dedupeKey}:email` : null,
      triggeredByType: row.triggeredByType,
      triggeredByUserId: row.triggeredByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: message.dedupeKey })
    .returning({ id: message.id });
  return inserted?.id ?? null;
}

// A text stuck in `sending` with no provider id becomes `unknown` and is shown to
// staff, never resent; an email is safe to retry under its idempotency key.
export async function reapStuckMessages(db: Db, now: Date = new Date()): Promise<{ unknown: number; requeued: number }> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  const stuck = and(eq(message.status, "sending"), isNull(message.providerMessageId), lt(message.lockedAt, cutoff));
  const unknown = await db
    .update(message)
    .set({ status: "unknown", lockedAt: null, updatedAt: now })
    .where(and(stuck, eq(message.channel, "sms")))
    .returning({ id: message.id });
  const requeued = await db
    .update(message)
    .set({ status: "queued", lockedAt: null, updatedAt: now })
    .where(and(stuck, eq(message.channel, "email")))
    .returning({ id: message.id });
  return { unknown: unknown.length, requeued: requeued.length };
}

// ---------------------------------------------------------------------------
// Rendering

// {link} in a template, or {link:<token id>} left in a stored body by an earlier attempt.
const LINK_PATTERN = /\{link(?::[0-9a-f-]{36})?\}/;

export function renderTemplate(text: string, vars: Record<string, string | null | undefined>): string {
  return text.replace(/\{([a-z_]+)\}/g, (match, key: string) => (key === "link" ? match : (vars[key] ?? "")));
}

// What a template's placeholders render to. {link} stays for the send to mint;
// {booking_link} is the employer's one-on-one booking link and {session_date} the
// application's group session in Central time, both empty when there is none (staff
// sends check that first). {interview_time} comes in the request's vars from the
// one-on-one reminder. The send dialog's preview uses this same function.
export async function templateVars(db: Db, emp: EmployerRow, who: PersonRow | null, app: ApplicationRow | null): Promise<Record<string, string>> {
  return {
    first_name: who?.firstName ?? "there",
    role_title: (app ? await loadRoleTitle(db, app.roleId) : null) ?? "",
    employer_name: emp.displayName,
    help_contact: emp.helpContact ?? emp.smsFromE164 ?? "",
    booking_link: emp.bookingLinkUrl ?? "",
    session_date: app ? await sessionDate(db, app) : "",
  };
}

async function sessionDate(db: Db, app: ApplicationRow): Promise<string> {
  const sessionId = app.attributedSessionId ?? app.scannedSessionId;
  if (!sessionId) return "";
  const [row] = await db
    .select({ startsAt: groupSession.startsAt })
    .from(groupSession)
    .where(and(eq(groupSession.id, sessionId), isNull(groupSession.deletedAt)));
  return row ? formatCentralMoment(row.startsAt) : "";
}

// A one-on-one reminder keeps its interview time in its dedupe key, so the email that
// replaces a text that cannot go says the same time.
function fallbackVars(row: MessageRow): Record<string, string> {
  const reminder = row.purpose === "one_on_one_reminder" ? parseInterviewReminderKey(row.dedupeKey) : null;
  return reminder ? { interview_time: formatCentralMoment(reminder.scheduledAt) } : {};
}

export function withFullDisclosure(body: string): string {
  if (body.includes(FULL_DISCLOSURE)) return body;
  const trimmed = body.trimEnd();
  if (trimmed.endsWith(SHORT_CLOSING)) return `${trimmed.slice(0, -SHORT_CLOSING.length).trimEnd()} ${FULL_DISCLOSURE}`;
  return `${trimmed} ${FULL_DISCLOSURE}`;
}

// GSM-7 texts carry 160 characters in one segment and 153 per segment after that;
// anything outside GSM-7 drops to 70 and 67.
export function estimateSegments(body: string): number {
  const gsm = /^[\x20-\x7E\n\r€£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà]*$/.test(body);
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}

// ---------------------------------------------------------------------------
// Lookups

async function loadEmployer(db: Db, id: string): Promise<EmployerRow> {
  const [row] = await db.select().from(employer).where(eq(employer.id, id));
  if (!row) throw new SendError("employer_not_found", "No such employer");
  return row;
}

// Messages carry no employer column: the template, the application's role, the
// hiring number or (Phase 1 has one employer) the only row says whose it is.
async function resolveEmployer(db: Db, row: MessageRow): Promise<EmployerRow> {
  if (row.templateId) {
    const [t] = await db.select({ employerId: messageTemplate.employerId }).from(messageTemplate).where(eq(messageTemplate.id, row.templateId));
    if (t) return loadEmployer(db, t.employerId);
  }
  if (row.applicationId) {
    const app = await loadApplication(db, row.applicationId);
    const [r] = await db.select({ employerId: role.employerId }).from(role).where(eq(role.id, app.roleId));
    if (r) return loadEmployer(db, r.employerId);
  }
  if (row.channel === "sms" && row.fromAddress) {
    const [e] = await db.select().from(employer).where(eq(employer.smsFromE164, row.fromAddress));
    if (e) return e;
  }
  const [only] = await db.select().from(employer).where(isNull(employer.archivedAt)).orderBy(asc(employer.createdAt)).limit(1);
  if (!only) throw new SendError("employer_not_found", "No employer");
  return only;
}

async function loadApplication(db: Db, id: string) {
  const [row] = await db.select().from(application).where(eq(application.id, id));
  if (!row) throw new SendError("no_address", "No such application");
  return row;
}

async function loadPerson(db: Db, id: string): Promise<PersonRow> {
  const [row] = await db.select().from(person).where(eq(person.id, id));
  if (!row) throw new SendError("no_address", "No such person");
  return row;
}

async function loadRoleTitle(db: Db, roleId: string): Promise<string | null> {
  const [row] = await db.select({ title: role.title }).from(role).where(eq(role.id, roleId));
  return row?.title ?? null;
}

function addressFor(who: PersonRow, channel: Channel): string | null {
  return channel === "sms" ? who.mobileE164 : who.email;
}

function fromAddress(emp: EmployerRow, channel: Channel): string {
  if (channel === "sms") {
    if (!emp.smsFromE164) throw new SendError("sms_not_configured", "The employer has no hiring number");
    return emp.smsFromE164;
  }
  // The seed leaves the From address to the owner; until it is set, local sends use a placeholder.
  return emp.emailFromAddress ?? `hiring@${emp.hiringHost}`;
}

function triggeredColumns(actor: Actor) {
  const { actorType, actorUserId } = actorColumns(actor);
  return { triggeredByType: actorType, triggeredByUserId: actorUserId };
}

// Role-specific templates win over employer-wide ones.
export async function findTemplate(db: Db, employerId: string, roleId: string | null, purpose: MessagePurpose, channel: Channel) {
  const rows = await db
    .select()
    .from(messageTemplate)
    .where(
      and(
        eq(messageTemplate.employerId, employerId),
        eq(messageTemplate.purpose, purpose),
        eq(messageTemplate.channel, channel),
        isNull(messageTemplate.archivedAt),
        roleId ? or(eq(messageTemplate.roleId, roleId), isNull(messageTemplate.roleId)) : isNull(messageTemplate.roleId),
      ),
    )
    .orderBy(desc(messageTemplate.roleId));
  return rows[0] ?? null;
}

// No more than 3 link sends to one number or email in an hour (send rule 9).
async function enforceLinkRateLimit(db: Db, toAddress: string, now: Date) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(message)
    .where(
      and(
        eq(message.direction, "outbound"),
        eq(message.toAddress, toAddress),
        inArray(message.purpose, [...LINK_PURPOSES]),
        gt(message.createdAt, new Date(now.getTime() - 3_600_000)),
      ),
    );
  if ((row?.count ?? 0) >= LINK_SENDS_PER_HOUR) {
    throw new SendError("link_rate_limited", "Too many link requests for this address; try again in an hour");
  }
}

// Messages to applicants sent since midnight Central. Alerts and the digest to staff carry
// no purpose and are left out, as they are exempt from the cap, so they never hold back
// an applicant's link or reminder.
async function sentTodayCount(db: Db, now: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(message)
    .where(and(eq(message.direction, "outbound"), isNotNull(message.purpose), gte(message.sentAt, centralInstant(centralDate(now), 0))));
  return row?.count ?? 0;
}

async function isFirstTextSinceOptIn(db: Db, row: MessageRow, to: string, employerId: string): Promise<boolean> {
  const consent = await latestConsent(db, to, employerId);
  const since = consent?.occurredAt ?? new Date(0);
  const [prior] = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.direction, "outbound"),
        eq(message.channel, "sms"),
        eq(message.toAddress, to),
        ne(message.id, row.id),
        inArray(message.status, ["sending", "sent", "delivered", "unknown"]),
        gte(message.createdAt, since),
      ),
    )
    .limit(1);
  return !prior;
}
