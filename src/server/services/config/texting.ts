import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { employer } from "@/db/schema";
import type { Actor } from "@/server/services/actor";
import { diffChanges, writeAudit } from "@/server/services/audit";
import { QUO_WEBHOOK_SECRET_KEY, quoWebhookSecretFromEnv, readIntegrationSecretMeta } from "@/server/services/integration-secrets";
import { getLastQuoSetup, type LastQuoSetup } from "@/server/services/messaging/quo-setup";
import { getEmployer } from "./employer";
import { ConfigError } from "./errors";

// Settings > Texting (DATA_MODEL.md, employer): the sms_enabled switch, the help
// contact and the daily send cap. The hiring number is read-only, and the Quo
// phone number id is filled by quo:setup on deploy (or quo:connect), never here.
// The Quo connection block is read-only too: whether the number and the webhook
// are connected and the newest quo:setup result. It reaches the browser, so it
// carries the last 4 characters of the Quo id and never the webhook secret.

export type QuoConnection = {
  phoneIdLast4: string | null;
  // The signing secret exists (Railway variable or the stored row); its value is never read here.
  webhookConnected: boolean;
  webhookSecretSource: "railway" | "stored" | null;
  webhookSecretStoredAt: Date | null;
  lastSetup: LastQuoSetup | null;
};

export type TextingSettings = {
  employerId: string;
  smsEnabled: boolean;
  helpContact: string | null;
  dailySendCap: number;
  smsFromE164: string | null;
  // True once the Quo phone number id is stored; no text goes out while false.
  quoConnected: boolean;
  quo: QuoConnection;
};

export const DAILY_SEND_CAP_MAX = 5000;

export async function getTextingSettings(db: Db): Promise<TextingSettings> {
  const row = await getEmployer(db);
  return {
    employerId: row.id,
    smsEnabled: row.smsEnabled,
    helpContact: row.helpContact,
    dailySendCap: row.dailySendCap,
    smsFromE164: row.smsFromE164,
    quoConnected: Boolean(row.smsQuoPhoneNumberId),
    quo: await getQuoConnection(db, row),
  };
}

export async function getQuoConnection(db: Db, row: { id: string; smsQuoPhoneNumberId: string | null }): Promise<QuoConnection> {
  const fromEnv = quoWebhookSecretFromEnv() !== null;
  const stored = fromEnv ? null : await readIntegrationSecretMeta(db, QUO_WEBHOOK_SECRET_KEY);
  return {
    phoneIdLast4: row.smsQuoPhoneNumberId ? row.smsQuoPhoneNumberId.slice(-4) : null,
    webhookConnected: fromEnv || stored !== null,
    webhookSecretSource: fromEnv ? "railway" : stored ? "stored" : null,
    webhookSecretStoredAt: stored?.createdAt ?? null,
    lastSetup: await getLastQuoSetup(db, row.id),
  };
}

export async function updateTextingSettings(
  db: Db,
  input: { actor: Actor; smsEnabled: boolean; helpContact: string | null; dailySendCap: number },
): Promise<TextingSettings> {
  const helpContact = input.helpContact?.trim() || null;
  if (!Number.isInteger(input.dailySendCap) || input.dailySendCap < 1 || input.dailySendCap > DAILY_SEND_CAP_MAX) {
    throw new ConfigError("invalid_input", `Daily send cap must be a whole number from 1 to ${DAILY_SEND_CAP_MAX}`);
  }
  return db.transaction(async (tx) => {
    const before = await getEmployer(tx);
    const [after] = await tx
      .update(employer)
      .set({ smsEnabled: input.smsEnabled, helpContact, dailySendCap: input.dailySendCap })
      .where(eq(employer.id, before.id))
      .returning();
    const changes = diffChanges(before, after!, ["smsEnabled", "helpContact", "dailySendCap"]);
    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, {
        actor: input.actor,
        action: "employer.texting_update",
        entityType: "employer",
        entityId: before.id,
        changes,
      });
    }
    return getTextingSettings(tx);
  });
}
