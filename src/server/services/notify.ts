import { asc, isNull } from "drizzle-orm";
import { env } from "@/config/env";
import type { Db } from "@/db";
import { employer } from "@/db/schema";
import { SYSTEM_ACTOR } from "./actor";
import { getProviders } from "./messaging/providers";
import type { Providers } from "./messaging/providers/types";
import { processMessages, queueMessage } from "./messaging/send";
import { hourBucket } from "./time";

// notifyAdmin (PLAN.md, Stack): emails the ALERT_EMAIL address through the send
// function, at most once per kind per hour (dedupe on alert:<kind>:<hour>).
// Bodies carry ids, never names or numbers. It never throws: an alert that fails
// is logged, because the caller is usually already handling an error.

export type NotifyResult = { queued: boolean; messageId: string | null };

export async function notifyAdmin(
  db: Db,
  kind: string,
  subject: string,
  body: string,
  options: { providers?: Providers; now?: Date } = {},
): Promise<NotifyResult> {
  const now = options.now ?? new Date();
  const to = env().ALERT_EMAIL;
  if (!to) {
    console.warn(`[notify] ${kind}: ${subject} (ALERT_EMAIL not set)\n${body}`);
    return { queued: false, messageId: null };
  }
  try {
    const [emp] = await db.select({ id: employer.id }).from(employer).where(isNull(employer.archivedAt)).orderBy(asc(employer.createdAt)).limit(1);
    if (!emp) {
      console.warn(`[notify] ${kind}: no employer row yet, alert not sent`);
      return { queued: false, messageId: null };
    }
    const result = await queueMessage(db, {
      employerId: emp.id,
      channel: "email",
      content: { subject: `[Tidepool] ${subject}`, body },
      toAddress: to,
      dedupeKey: `alert:${kind}:${hourBucket(now)}`,
      triggeredBy: SYSTEM_ACTOR,
      now,
    });
    if (result.created) await processMessages(db, [result.messageId], options.providers ?? getProviders(), now);
    return { queued: result.created, messageId: result.messageId };
  } catch (error) {
    console.error(`[notify] ${kind}: could not send alert`, error);
    return { queued: false, messageId: null };
  }
}
