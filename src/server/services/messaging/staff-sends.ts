import { and, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { application, employer, interview, message, person, pipelineStage, role } from "@/db/schema";
import type { Actor } from "../actor";
import { writeAudit } from "../audit";
import { isOptedIn, latestConsent, liveSuppression } from "./consent";
import { findTemplate, queueMessage, templateVars, type Channel, type MessagePurpose } from "./send";
import { fillPlaceholders, textLength, variablesIn, type StaffSendPurpose, type TemplateVariable } from "./template-text";
import { TemplateError } from "./templates";

// Staff send templates, never free text (content/legal/messages.md, rule 6; PLAN.md:
// invites, declines and status news go out as templates so they are logged). One path
// for "Send a message" on the profile, the invite a move sends and the decline a close
// sends: choose the channel, check the template and every value it needs, queue it
// through queueMessage and audit it. The send rules still apply when the cron sends it.

type PersonRow = typeof person.$inferSelect;
type EmployerRow = typeof employer.$inferSelect;

// One way to reach someone: the address, or why it cannot be used, as a clause.
type Way = { address: string } | { reason: string };

// How a person can be reached right now.
export type Reach = {
  // Set when nothing may go at all.
  blocked: string | null;
  text: Way;
  email: Way;
};

export async function reachPerson(db: Db, who: PersonRow, emp: EmployerRow): Promise<Reach> {
  let text: Way;
  if (!who.mobileE164) text = { reason: "they have no mobile number" };
  else if (!emp.smsEnabled) text = { reason: "texting is off in Settings" };
  else if (await liveSuppression(db, "sms", who.mobileE164)) text = { reason: "their number opted out of texts" };
  else if (!isOptedIn(await latestConsent(db, who.mobileE164, emp.id))) text = { reason: "their number has no text opt-in" };
  else text = { address: who.mobileE164 };

  let email: Way;
  if (!who.email) email = { reason: "they have no email on file" };
  else if (await liveSuppression(db, "email", who.email)) email = { reason: "their email bounced or was reported as spam" };
  else email = { address: who.email };

  return { blocked: who.doNotContact ? "they are marked do not contact" : null, text, email };
}

function reasonOf(way: Way): string {
  return "reason" in way ? way.reason : "";
}

export type ChannelChoice = { channel: Channel; address: string; note: string | null } | { channel: null; address: null; note: string };

// A text when they have a current opt-in for their number, it is not suppressed and
// texting is on; otherwise an email. The decline goes the other way round: messages.md
// recommends the inbox for it even when they opted in to texts, and keeps the text for
// people with no working email.
export function chooseChannel(reach: Reach, purpose: MessagePurpose): ChannelChoice {
  if (reach.blocked) return { channel: null, address: null, note: `Nothing can be sent: ${reach.blocked}.` };
  const { text, email } = reach;
  if (purpose === "decline" && "address" in email) return { channel: "email", address: email.address, note: "By email: a decline reads better in an inbox." };
  if ("address" in text) return { channel: "sms", address: text.address, note: purpose === "decline" ? `By text, because ${reasonOf(email)}.` : null };
  if ("address" in email) return { channel: "email", address: email.address, note: `By email, because ${reasonOf(text)}.` };
  return { channel: null, address: null, note: `Nothing can be sent: ${reasonOf(text)}, and ${reasonOf(email)}.` };
}

// What the dialogs show before a send: the channel and address, the message filled in
// with this person's values (links as "[application link]", minted only at send), its
// length for a text, and the reason it cannot go, if any.
export type SendPreview = {
  channel: Channel | null;
  to: string | null;
  note: string | null;
  problem: string | null;
  subject: string | null;
  body: string | null;
  segments: number | null;
  characters: number | null;
};

type Plan = SendPreview & { employerId: string; personId: string };

const PURPOSE_NAMES: Record<StaffSendPurpose, string> = {
  one_on_one_invite: "one-on-one invite",
  status_update: "status update",
  decline: "decline",
};

// The values a send cannot go without, when the template uses them.
const MISSING_VALUE: Partial<Record<TemplateVariable, string>> = {
  booking_link: "Add the booking link at the top of Settings, Message templates first.",
  session_date: "This message gives their group session date, but they have no group session.",
  help_contact: "Add the help contact in Settings, Texting first.",
  interview_time: "This message gives an interview time, which only the one-on-one reminder knows.",
};

// The decline tells someone we won't move forward, so it goes only to an application
// closed as Disqualified or Not selected. Anyone still open is closed first, in the Close
// dialog, where the FCRA gate applies (DATA_MODEL.md, Key invariants: while a check is
// open, no rejection skips the FCRA steps); the decline that dialog sends is queued
// inside the close, after the application is closed.
const DECLINE_NEEDS_CLOSE =
  "The decline goes only to someone closed as Disqualified or Not selected. For someone still open, use Close and tick Send the decline message.";

function declinable(app: typeof application.$inferSelect): boolean {
  return app.status === "closed" && (app.closedOutcome === "disqualified" || app.closedOutcome === "not_selected");
}

// beforeClose: the Close dialog's preview, shown before the close that will carry the decline.
async function plan(db: Db, applicationId: string, purpose: StaffSendPurpose, beforeClose = false): Promise<Plan> {
  const [row] = await db
    .select({ app: application, employerId: role.employerId })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .where(eq(application.id, applicationId));
  if (!row || row.app.deletedAt) throw new TemplateError("not_found", "No such application");
  const app = row.app;
  const [who] = await db.select().from(person).where(eq(person.id, app.personId));
  const [emp] = await db.select().from(employer).where(eq(employer.id, row.employerId));

  const base: Plan = {
    employerId: emp!.id,
    personId: who!.id,
    channel: null,
    to: null,
    note: null,
    problem: null,
    subject: null,
    body: null,
    segments: null,
    characters: null,
  };
  if (purpose === "decline" && !beforeClose && !declinable(app)) return { ...base, problem: DECLINE_NEEDS_CLOSE };
  const choice = chooseChannel(await reachPerson(db, who!, emp!), purpose);
  if (!choice.channel) return { ...base, problem: choice.note };
  const withChannel = { ...base, channel: choice.channel, to: choice.address, note: choice.note };

  const template = await findTemplate(db, emp!.id, app.roleId, purpose, choice.channel);
  if (!template) {
    const kind = choice.channel === "sms" ? "text" : "email";
    return { ...withChannel, problem: `There is no ${kind} template for the ${PURPOSE_NAMES[purpose]}. An Admin can check Settings, Message templates.` };
  }

  const vars = await templateVars(db, emp!, who!, app);
  const used = variablesIn(`${template.subject ?? ""}\n${template.body}`);
  const missing = used.map((key) => (MISSING_VALUE[key] && !vars[key] ? MISSING_VALUE[key] : null)).find(Boolean) ?? null;

  const shown = { ...vars, link: "[application link]" };
  const length = choice.channel === "sms" ? textLength(fillPlaceholders(template.body, { ...vars, link: `https://${emp!.hiringHost}/r#${"x".repeat(22)}` })) : null;
  return {
    ...withChannel,
    problem: missing,
    subject: template.subject ? fillPlaceholders(template.subject, shown) : null,
    body: fillPlaceholders(template.body, shown),
    segments: length?.segments ?? null,
    characters: length?.characters ?? null,
  };
}

function previewOf(p: Plan): SendPreview {
  return { channel: p.channel, to: p.to, note: p.note, problem: p.problem, subject: p.subject, body: p.body, segments: p.segments, characters: p.characters };
}

// The Move and Close dialogs' preview, before the move or close that carries the message.
export async function previewTemplateMessage(db: Db, applicationId: string, purpose: StaffSendPurpose): Promise<SendPreview> {
  return previewOf(await plan(db, applicationId, purpose, true));
}

export type SendRequest = {
  applicationId: string;
  purpose: StaffSendPurpose;
  actor: Actor;
  // One message per key, ever: a retried request or a second click queues nothing more.
  dedupeKey: string;
  // Where the send came from, for the audit row.
  via: "profile" | "move" | "close";
  eventId?: string | null;
  now?: Date;
};

// Queues one template message and audits it. Refuses, without queueing, when the plan
// has a problem. Call it inside a transaction so the message and its audit row commit together.
export async function queueTemplateMessage(db: Db, input: SendRequest): Promise<{ messageId: string; channel: Channel; created: boolean }> {
  const now = input.now ?? new Date();
  const ready = await plan(db, input.applicationId, input.purpose);
  if (ready.problem || !ready.channel) throw new TemplateError("not_sendable", ready.problem ?? "Nothing can be sent");
  const queued = await queueMessage(db, {
    employerId: ready.employerId,
    channel: ready.channel,
    personId: ready.personId,
    applicationId: input.applicationId,
    content: { purpose: input.purpose },
    dedupeKey: input.dedupeKey,
    triggeredBy: input.actor,
    now,
  });
  if (queued.created) {
    await writeAudit(db, {
      actor: input.actor,
      action: "application.message_send",
      entityType: "application",
      entityId: input.applicationId,
      personId: ready.personId,
      applicationId: input.applicationId,
      changes: { purpose: input.purpose, channel: ready.channel, message_id: queued.messageId, via: input.via, application_event_id: input.eventId ?? null },
      occurredAt: now,
    });
  }
  return { messageId: queued.messageId, channel: ready.channel, created: queued.created };
}

// "Send a message" on the profile.
export async function sendTemplateMessage(db: Db, input: Omit<SendRequest, "via" | "eventId">) {
  return db.transaction((tx) => queueTemplateMessage(tx, { ...input, via: "profile" }));
}

export type SendOption = SendPreview & { purpose: StaffSendPurpose };

// The profile panel's choices, each previewed. Null for a missing or deleted application.
export async function loadSendOptions(db: Db, applicationId: string, purposes: readonly StaffSendPurpose[]): Promise<SendOption[] | null> {
  const [app] = await db.select({ deletedAt: application.deletedAt }).from(application).where(eq(application.id, applicationId));
  if (!app || app.deletedAt) return null;
  const options: SendOption[] = [];
  for (const purpose of purposes) options.push({ purpose, ...previewOf(await plan(db, applicationId, purpose)) });
  return options;
}

// The booking link the applicant's status page shows while a one-on-one invite is out
// (content/legal/messages.md, Status page): the application is open in a stage at the
// interview_invited milestone, an invite was queued after it entered that stage, no
// interview is booked, held or missed yet, and the booking link is set. Null otherwise,
// so moving on to the next stage or booking the interview takes the button away.
export async function openInviteBookingLink(db: Db, applicationId: string): Promise<string | null> {
  const [row] = await db
    .select({
      status: application.status,
      deletedAt: application.deletedAt,
      stageEnteredAt: application.stageEnteredAt,
      milestone: pipelineStage.milestone,
      bookingLinkUrl: employer.bookingLinkUrl,
    })
    .from(application)
    .innerJoin(pipelineStage, eq(pipelineStage.id, application.currentStageId))
    .innerJoin(role, eq(role.id, application.roleId))
    .innerJoin(employer, eq(employer.id, role.employerId))
    .where(eq(application.id, applicationId));
  if (!row || row.deletedAt || row.status !== "open" || row.milestone !== "interview_invited" || !row.bookingLinkUrl) return null;
  const [invite] = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.applicationId, applicationId),
        eq(message.purpose, "one_on_one_invite"),
        ne(message.status, "canceled"),
        gte(message.createdAt, row.stageEnteredAt),
      ),
    )
    .limit(1);
  if (!invite) return null;
  const [booked] = await db
    .select({ id: interview.id })
    .from(interview)
    .where(and(eq(interview.applicationId, applicationId), inArray(interview.status, ["scheduled", "held", "no_show"]), isNull(interview.deletedAt)))
    .limit(1);
  return booked ? null : row.bookingLinkUrl;
}
