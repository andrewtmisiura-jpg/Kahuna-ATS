import { and, eq, isNull } from "drizzle-orm";
import { loadDotEnv } from "@/config/env";

// `pnpm quo:connect`: looks the hiring number up in the Quo workspace and stores
// its phone number id on the employer row, which is what the send function uses
// as `from` (DATA_MODEL.md, employer.sms_quo_phone_number_id).
// `pnpm quo:webhook`: creates the one Tidepool webhook, scoped to that number,
// for the four message events, and prints its signing secret for the owner to
// paste into Railway as QUO_WEBHOOK_SECRET. The secret is never stored.
//
// Both are thin HTTP clients and UNVERIFIED against live Quo: the paths follow
// OpenPhone's v1 API, which Quo inherited, plus the newer webhooks endpoint the
// plan names. Each response is read tolerantly and printed in full on failure,
// so a shape change is a one-line fix.

const QUO_API_BASE_URL = (process.env.QUO_API_BASE_URL ?? "https://api.quo.com").replace(/\/$/, "");
// The one place the phone-numbers path lives.
const PHONE_NUMBERS_PATH = "/v1/phone-numbers";
// The newer webhooks API, versioned by header.
const WEBHOOKS_URL = "https://api.quo.com/webhooks";
const QUO_API_VERSION = "2026-03-30";
const WEBHOOK_LABEL = "Tidepool";
const WEBHOOK_EVENTS = ["message.received", "message.delivered", "message.failed", "message.undelivered"];

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(obj: Json | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function list(payload: unknown): Json[] {
  const root = asObject(payload);
  const candidates = [root?.data, root?.items, root?.results, root?.phoneNumbers, root?.webhooks, payload];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(asObject).filter((x): x is Json => x !== null);
    const nested = asObject(candidate);
    if (nested && Array.isArray(nested.items)) return nested.items.map(asObject).filter((x): x is Json => x !== null);
  }
  return [];
}

function digitsOnly(value: string | null): string {
  return (value ?? "").replace(/\D/g, "");
}

async function quoFetch(apiKey: string, url: string, init: RequestInit = {}, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/json", ...extraHeaders, ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

function requireApiKey(): string {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) throw new Error("QUO_API_KEY is not set. Create an API key labeled Tidepool in Quo and put it in .env or Railway.");
  return apiKey;
}

type Db = (typeof import("@/db"))["db"];

async function loadHiringEmployer(db: Db) {
  const { employer } = await import("@/db/schema");
  const [row] = await db.select().from(employer).where(and(eq(employer.key, "kahuna"), isNull(employer.archivedAt)));
  if (!row) throw new Error("No employer row. Run pnpm db:seed first.");
  if (!row.smsFromE164) throw new Error("employer.sms_from_e164 is empty; the seed should have set +17632922259.");
  return row;
}

async function connect(db: Db) {
  const apiKey = requireApiKey();
  const emp = await loadHiringEmployer(db);
  const { response, body, text } = await quoFetch(apiKey, `${QUO_API_BASE_URL}${PHONE_NUMBERS_PATH}`);
  if (!response.ok) throw new Error(`Quo answered ${response.status} for ${PHONE_NUMBERS_PATH}: ${text.slice(0, 500)}`);
  const numbers = list(body);
  if (numbers.length === 0) throw new Error(`Quo returned no phone numbers. Raw response: ${text.slice(0, 500)}`);

  const wanted = digitsOnly(emp.smsFromE164);
  const match = numbers.find((n) => digitsOnly(str(n, ["number", "phoneNumber", "e164", "formattedNumber"])) === wanted);
  if (!match) {
    const seen = numbers.map((n) => `${str(n, ["number", "phoneNumber", "e164"]) ?? "?"} (${str(n, ["id"]) ?? "no id"}, ${str(n, ["name", "label"]) ?? "unnamed"})`);
    throw new Error(`The hiring number ${emp.smsFromE164} is not in this Quo workspace. Numbers seen: ${seen.join("; ")}`);
  }
  const id = str(match, ["id", "phoneNumberId"]);
  if (!id) throw new Error(`Found ${emp.smsFromE164} but the entry has no id. Raw entry: ${JSON.stringify(match).slice(0, 500)}`);

  const { employer } = await import("@/db/schema");
  if (emp.smsQuoPhoneNumberId === id) {
    console.log(`[quo:connect] ${emp.smsFromE164} is already connected as ${id}; nothing to do`);
  } else {
    await db.update(employer).set({ smsQuoPhoneNumberId: id, updatedAt: new Date() }).where(eq(employer.id, emp.id));
    console.log(`[quo:connect] ${emp.smsFromE164} is Quo phone number ${id}${emp.smsQuoPhoneNumberId ? ` (was ${emp.smsQuoPhoneNumberId})` : ""}; stored on employer ${emp.key}`);
  }
  console.log(`[quo:connect] texting ${emp.smsEnabled ? "is on" : "stays off until Settings > Texting turns it on"}`);
  return id;
}

function manualSteps(url: string, phoneNumberId: string) {
  return [
    "Create the webhook by hand in Quo (Settings > Integrations > Webhooks, or the API docs):",
    `  label:   ${WEBHOOK_LABEL}`,
    `  url:     ${url}`,
    `  events:  ${WEBHOOK_EVENTS.join(", ")}`,
    `  numbers: only ${phoneNumberId} (the hiring number)`,
    "Then paste the signing secret Quo shows into Railway as QUO_WEBHOOK_SECRET on the web service.",
    "Never change a webhook Tidepool did not create: Typhoon's connection must stay as it is.",
  ].join("\n");
}

async function webhook(db: Db) {
  const apiKey = requireApiKey();
  const emp = await loadHiringEmployer(db);
  if (!emp.smsQuoPhoneNumberId) throw new Error("The hiring number is not connected yet. Run pnpm quo:connect first.");
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("PUBLIC_BASE_URL must be the public https address of the app (Quo posts to it).");
  const url = `${base}/api/webhooks/quo`;
  const versionHeader = { "Quo-Api-Version": QUO_API_VERSION };

  // Read before writing: Tidepool creates exactly one webhook and touches nothing else.
  const existing = await quoFetch(apiKey, WEBHOOKS_URL, {}, versionHeader);
  if (existing.response.ok) {
    const hooks = list(existing.body);
    const ours = hooks.find((h) => str(h, ["url"]) === url);
    if (ours) {
      console.log(`[quo:webhook] a webhook for ${url} already exists (id ${str(ours, ["id"]) ?? "?"}). Nothing created.`);
      console.log("[quo:webhook] If you lost its secret, delete that webhook in Quo and run this again.");
      return;
    }
    const wide = hooks.filter((h) => h !== ours && !Array.isArray(h.resourceIds) && !Array.isArray(h.phoneNumberIds));
    if (wide.length > 0) {
      console.log(`[quo:webhook] note: ${wide.length} existing webhook(s) seem to cover all numbers; Tidepool drops events for other numbers, and whether Typhoon narrows its own is the owner's call.`);
    }
  } else {
    console.log(`[quo:webhook] could not list existing webhooks (${existing.response.status}); creating anyway`);
  }

  const payload = {
    label: WEBHOOK_LABEL,
    url,
    events: WEBHOOK_EVENTS,
    // Scoped to the hiring number. Field name unverified; both likely names are sent.
    resourceIds: [emp.smsQuoPhoneNumberId],
    phoneNumberIds: [emp.smsQuoPhoneNumberId],
    status: "enabled",
  };
  const created = await quoFetch(apiKey, WEBHOOKS_URL, { method: "POST", body: JSON.stringify(payload) }, versionHeader);
  if (!created.response.ok) {
    console.error(`[quo:webhook] Quo refused the webhook (${created.response.status}): ${created.text.slice(0, 800)}`);
    console.log(manualSteps(url, emp.smsQuoPhoneNumberId));
    process.exitCode = 1;
    return;
  }
  const root = asObject(created.body);
  const data = asObject(root?.data) ?? root;
  const secret = str(data, ["secret", "signingSecret", "key", "signing_secret"]);
  console.log(`[quo:webhook] created webhook ${str(data, ["id"]) ?? "(no id in response)"} for ${url}, events ${WEBHOOK_EVENTS.join(", ")}, number ${emp.smsQuoPhoneNumberId}`);
  if (secret) {
    console.log("[quo:webhook] Paste this into Railway as QUO_WEBHOOK_SECRET on the web service (it is shown once and not stored anywhere):");
    console.log(secret);
  } else {
    console.log("[quo:webhook] The response carried no secret field. Copy the signing secret from the webhook's page in Quo into Railway as QUO_WEBHOOK_SECRET.");
    console.log(`[quo:webhook] Raw response (no secret found in it): ${created.text.slice(0, 800)}`);
  }
}

async function main() {
  const command = process.argv[2] ?? "connect";
  loadDotEnv();
  const { db, sql } = await import("@/db");
  try {
    if (command === "connect") await connect(db);
    else if (command === "webhook") await webhook(db);
    else throw new Error("usage: pnpm quo:connect | pnpm quo:webhook");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(`[quo:${process.argv[2] ?? "connect"}] failed:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
