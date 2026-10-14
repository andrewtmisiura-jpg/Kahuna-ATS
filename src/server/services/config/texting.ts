import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { employer } from "@/db/schema";
import type { Actor } from "@/server/services/actor";
import { diffChanges, writeAudit } from "@/server/services/audit";
import { getEmployer } from "./employer";
import { ConfigError } from "./errors";

// Settings > Texting (DATA_MODEL.md, employer): the sms_enabled switch, the help
// contact and the daily send cap. The hiring number is read-only, and the Quo
// phone number id is filled by quo:connect, never here.

export type TextingSettings = {
  employerId: string;
  smsEnabled: boolean;
  helpContact: string | null;
  dailySendCap: number;
  smsFromE164: string | null;
  // True once quo:connect has stored the Quo phone number id; no text goes out while false.
  quoConnected: boolean;
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
