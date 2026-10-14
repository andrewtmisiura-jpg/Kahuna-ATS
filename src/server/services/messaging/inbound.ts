import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { application, employer, message, person } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import { SYSTEM_ACTOR } from "../actor";
import { liftByKeyword, recordConsent, suppress } from "./consent";
import type { Providers } from "./providers/types";
import { processMessages, queueMessage } from "./send";

// Inbound texts (DATA_MODEL.md, send rule 8). Quo's single-word opt-outs plus
// REVOKE and OPT OUT create a suppression and a consent event at once; START and
// UNSTOP lift it; HELP gets the templated reply; everything else waits for a person.

export const STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPT OUT", "OPTOUT"] as const;
export const START_KEYWORDS = ["START", "UNSTOP"] as const;
export const HELP_KEYWORDS = ["HELP"] as const;

export type InboundKeyword = "stop" | "start" | "help" | null;

export function classifyKeyword(body: string): InboundKeyword {
  const normalized = body
    .trim()
    .toUpperCase()
    .replace(/[.!?,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if ((STOP_KEYWORDS as readonly string[]).includes(normalized)) return "stop";
  if ((START_KEYWORDS as readonly string[]).includes(normalized)) return "start";
  if ((HELP_KEYWORDS as readonly string[]).includes(normalized)) return "help";
  return null;
}

export type InboundText = {
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  receivedAt: Date;
  // When given, the HELP reply goes out before this returns.
  providers?: Providers;
  now?: Date;
};

export type InboundOutcome =
  | { kind: "ignored"; reason: "unknown_number" }
  | { kind: "duplicate" }
  | { kind: "stop"; messageId: string; personId: string | null }
  | { kind: "start"; messageId: string; personId: string | null; lifted: number }
  | { kind: "help"; messageId: string; personId: string | null; replyMessageId: string | null }
  | { kind: "unhandled"; messageId: string; personId: string | null };

export async function recordInboundText(db: Db, input: InboundText): Promise<InboundOutcome> {
  const now = input.now ?? new Date();
  const outcome = await db.transaction(async (tx): Promise<InboundOutcome & { employerId?: string; applicationId?: string | null }> => {
    // Only the hiring number's traffic is stored; anything for another number is dropped.
    const [emp] = await tx
      .select()
      .from(employer)
      .where(and(eq(employer.smsFromE164, input.to), isNull(employer.archivedAt)));
    if (!emp) return { kind: "ignored", reason: "unknown_number" };

    const who = await personByMobile(tx, input.from);
    const app = who ? await latestApplication(tx, who.id) : null;

    const inserted = await tx
      .insert(message)
      .values({
        id: uuidv7(),
        direction: "inbound",
        channel: "sms",
        personId: who?.id ?? null,
        applicationId: app?.id ?? null,
        toAddress: input.to,
        fromAddress: input.from,
        body: input.body,
        status: "received",
        provider: "quo",
        providerMessageId: input.providerMessageId,
        triggeredByType: "applicant",
        createdAt: input.receivedAt,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: message.providerMessageId })
      .returning({ id: message.id });
    // Redeliveries dedupe on the provider id; opt-out handling runs only on a real insert.
    if (!inserted[0]) return { kind: "duplicate" };
    const messageId = inserted[0].id;

    const keyword = classifyKeyword(input.body);
    const consent = (action: "opt_out" | "opt_in_keyword") =>
      who
        ? recordConsent(tx, {
            personId: who.id,
            applicationId: app?.id ?? null,
            employerId: emp.id,
            channel: "sms",
            address: input.from,
            action,
            method: "keyword",
            messageId,
            occurredAt: input.receivedAt,
          })
        : Promise.resolve(null);
    const markHandled = () => tx.update(message).set({ handledAt: now, updatedAt: now }).where(eq(message.id, messageId));

    switch (keyword) {
      case "stop":
        await suppress(tx, { channel: "sms", address: input.from, reason: "stop_keyword", messageId, now: input.receivedAt });
        await consent("opt_out");
        await markHandled();
        return { kind: "stop", messageId, personId: who?.id ?? null };
      case "start": {
        const lifted = await liftByKeyword(tx, input.from, input.body.trim().toUpperCase(), input.receivedAt);
        await consent("opt_in_keyword");
        await markHandled();
        return { kind: "start", messageId, personId: who?.id ?? null, lifted };
      }
      case "help": {
        // The reply goes to the number that texted, opt-in or not, unless it is suppressed.
        const reply = await queueMessage(tx, {
          employerId: emp.id,
          channel: "sms",
          personId: who?.id ?? null,
          applicationId: app?.id ?? null,
          content: { purpose: "help_reply" },
          toAddress: input.from,
          triggeredBy: SYSTEM_ACTOR,
          now,
        });
        await markHandled();
        return { kind: "help", messageId, personId: who?.id ?? null, replyMessageId: reply.messageId };
      }
      default:
        return { kind: "unhandled", messageId, personId: who?.id ?? null };
    }
  });

  if (outcome.kind === "help" && outcome.replyMessageId && input.providers) {
    await processMessages(db, [outcome.replyMessageId], input.providers, now);
  }
  return outcome;
}

// The unshared person with that mobile, followed to the root of any merge.
async function personByMobile(db: Db, mobile: string) {
  const [row] = await db
    .select()
    .from(person)
    .where(and(eq(person.mobileE164, mobile), eq(person.sharedMobile, false), isNull(person.deletedAt)));
  if (!row) return null;
  let current = row;
  for (let hops = 0; current.mergedIntoPersonId && hops < 10; hops++) {
    const [root] = await db.select().from(person).where(eq(person.id, current.mergedIntoPersonId));
    if (!root) break;
    current = root;
  }
  return current;
}

async function latestApplication(db: Db, personId: string) {
  const [row] = await db
    .select()
    .from(application)
    .where(and(eq(application.personId, personId), isNull(application.deletedAt)))
    .orderBy(desc(application.createdAt))
    .limit(1);
  return row ?? null;
}
