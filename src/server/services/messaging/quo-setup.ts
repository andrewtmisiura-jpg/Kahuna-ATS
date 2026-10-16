import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { auditLog, employer } from "@/db/schema";
import { SYSTEM_ACTOR } from "../actor";
import { writeAudit } from "../audit";
import { getEmployer } from "../config/employer";
import { QUO_WEBHOOK_SECRET_KEY, quoWebhookSecretFromEnv, readIntegrationSecretMeta, storeIntegrationSecret } from "../integration-secrets";
import { QUO_EVENT_TYPES } from "./webhooks";

// Connects Tidepool to Quo without anyone at a shell (README, Production): the
// Railway pre-deploy step runs `pnpm quo:setup` after every migrate, seed and
// db:changes, and that calls ensureQuoConnected. It is idempotent and safe on
// every deploy:
//
//   1. The hiring number. While employer.sms_quo_phone_number_id is null, list
//      the workspace's phone numbers, match the hiring number by digits and
//      store its id (the `from` of every text). Once stored, no API call.
//   2. The webhook. While no signing secret exists (QUO_WEBHOOK_SECRET in
//      Railway, or the integration_secret row), list the existing webhooks; if
//      one already posts to <PUBLIC_BASE_URL>/api/webhooks/quo, create nothing
//      and say how to recover its secret; otherwise create the one Tidepool
//      webhook, scoped to the hiring number, and store its signing secret in the
//      same run. Quo shows that secret only once, at creation.
//
// Quo is shared with Typhoon: this never updates or deletes a webhook, and only
// ever creates the one pointing at Tidepool's own address. Each step runs in its
// own transaction behind an advisory lock, so two overlapping deploys cannot
// create two webhooks. Nothing here throws: every failure comes back as an
// `error` status with a redacted message. Messages never carry the API key or a
// secret, and phone numbers and Quo ids only by their last 4 characters.
//
// Quo's API is UNVERIFIED against live responses (as in quo-connect.ts): the
// paths follow OpenPhone's v1 API plus the newer webhooks endpoint, and every
// response is read tolerantly from several likely field names.

export const QUO_DEFAULT_API_BASE_URL = "https://api.quo.com";
export const QUO_PHONE_NUMBERS_PATH = "/v1/phone-numbers";
// The newer webhooks API, versioned by header. Listed with GET, created with POST.
export const QUO_WEBHOOKS_PATH = "/webhooks";
export const QUO_API_VERSION = "2026-03-30";
export const QUO_WEBHOOK_LABEL = "Tidepool";
export const QUO_WEBHOOK_EVENTS: readonly string[] = QUO_EVENT_TYPES;
export const QUO_WEBHOOK_ROUTE = "/api/webhooks/quo";
export const QUO_SETUP_AUDIT_ACTION = "integration.quo_setup";
export const QUO_REQUEST_TIMEOUT_MS = 15_000;

const LOCK = sql`select pg_advisory_xact_lock(hashtext('tidepool:quo:setup'))`;

export type QuoPhoneStatus = "connected" | "already" | "not_found" | "error";
export type QuoWebhookStatus = "created" | "already" | "exists_without_secret" | "error";

export type QuoSetupResult = {
  phone: { status: QuoPhoneStatus; message: string; idLast4: string | null };
  webhook: { status: QuoWebhookStatus; message: string; idLast4: string | null; url: string | null };
  at: Date;
};

export type QuoSetupOptions = {
  apiKey: string;
  publicBaseUrl: string | undefined;
  fetch?: typeof fetch;
  // Defaults to https://api.quo.com; QUO_API_BASE_URL overrides it for a sandbox.
  apiBaseUrl?: string;
  // Defaults to process.env; only QUO_WEBHOOK_SECRET is read from it.
  env?: Record<string, string | undefined>;
  now?: Date;
  // Writes the run's result to audit_log for Settings > Texting (default true).
  record?: boolean;
};

export function quoSetupNeedsAttention(result: Pick<QuoSetupResult, "phone" | "webhook">): boolean {
  return (
    result.phone.status === "not_found" ||
    result.phone.status === "error" ||
    result.webhook.status === "exists_without_secret" ||
    result.webhook.status === "error"
  );
}

export async function ensureQuoConnected(db: Db, options: QuoSetupOptions): Promise<QuoSetupResult> {
  const ctx = context(options);
  const phone = await ensureQuoPhone(db, options, ctx);
  const webhook = await ensureQuoWebhook(db, options, ctx);
  const result: QuoSetupResult = { phone, webhook, at: ctx.now };
  if (options.record !== false) await recordQuoSetup(db, result, ctx);
  return result;
}

// Step 1 on its own (also `pnpm quo:connect`).
export async function ensureQuoPhone(db: Db, options: QuoSetupOptions, ctx: Context = context(options)): Promise<QuoSetupResult["phone"]> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(LOCK);
      const emp = await getEmployer(tx);
      if (!emp.smsFromE164) return phoneError("employer.sms_from_e164 is empty; the seed sets it to the hiring number.");
      const wanted = usDigits(emp.smsFromE164);
      if (emp.smsQuoPhoneNumberId) {
        const last4 = tail(emp.smsQuoPhoneNumberId);
        return { status: "already", idLast4: last4, message: `The hiring number ${maskNumber(wanted)} is connected (Quo id ${mask(last4)}); no API call made.` };
      }

      const listed = await ctx.call("GET", `${ctx.apiBaseUrl}${QUO_PHONE_NUMBERS_PATH}`);
      if (!listed.ok) return phoneError(`Could not list the workspace's phone numbers: ${listed.problem}`);
      const numbers = findList(listed.body);
      if (!numbers) return phoneError(`Quo's ${QUO_PHONE_NUMBERS_PATH} response has no list of numbers Tidepool recognizes (HTTP ${listed.status}).`);

      const match = numbers.find((entry) => numberCandidates(entry).some((value) => usDigits(value) === wanted));
      if (!match) {
        const seen = numbers.map((entry) => maskNumber(usDigits(numberCandidates(entry)[0] ?? ""))).join(", ");
        return {
          status: "not_found",
          idLast4: null,
          message:
            `The hiring number ${maskNumber(wanted)} is not among the ${numbers.length} phone number(s) this Quo API key can see` +
            `${numbers.length > 0 ? ` (${seen})` : ""}. Check that QUO_API_KEY belongs to the Quo workspace that owns the hiring number.`,
        };
      }
      const id = str(match, ["id", "phoneNumberId", "phone_number_id"]);
      if (!id) return phoneError(`Quo lists the hiring number ${maskNumber(wanted)} but its entry carries no id.`);

      await tx
        .update(employer)
        .set({ smsQuoPhoneNumberId: id, updatedAt: ctx.now })
        .where(and(eq(employer.id, emp.id), isNull(employer.smsQuoPhoneNumberId)));
      const last4 = tail(id);
      return { status: "connected", idLast4: last4, message: `Connected the hiring number ${maskNumber(wanted)} as Quo phone number ${mask(last4)}.` };
    });
  } catch (error) {
    return phoneError(`Setup failed: ${ctx.redact(errorText(error))}`);
  }
}

// Step 2 on its own (also `pnpm quo:webhook`).
export async function ensureQuoWebhook(db: Db, options: QuoSetupOptions, ctx: Context = context(options)): Promise<QuoSetupResult["webhook"]> {
  const base = normalizeBaseUrl(options.publicBaseUrl);
  const url = base ? `${base}${QUO_WEBHOOK_ROUTE}` : null;
  const webhookError = (message: string, idLast4: string | null = null): QuoSetupResult["webhook"] => ({ status: "error", message, idLast4, url });

  if (quoWebhookSecretFromEnv(ctx.env)) {
    return { status: "already", idLast4: null, url, message: "The webhook signing secret is set in Railway (QUO_WEBHOOK_SECRET); nothing to create." };
  }
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(LOCK);
      const stored = await readIntegrationSecretMeta(tx, QUO_WEBHOOK_SECRET_KEY);
      if (stored) {
        return { status: "already", idLast4: null, url, message: `The webhook signing secret is stored (since ${stored.createdAt.toISOString()}); nothing to create.` };
      }
      if (!url) {
        return webhookError("PUBLIC_BASE_URL must be the app's public https address (Quo posts to <PUBLIC_BASE_URL>/api/webhooks/quo); no webhook created.");
      }
      const emp = await getEmployer(tx);
      if (!emp.smsQuoPhoneNumberId) {
        return webhookError("Not attempted: the webhook is scoped to the hiring number, which is not connected to Quo yet.");
      }

      const listed = await ctx.call("GET", ctx.webhooksUrl, undefined, true);
      if (!listed.ok) return webhookError(`Could not list the existing Quo webhooks, so nothing was created (no risk of a duplicate): ${listed.problem}`);
      const hooks = findList(listed.body);
      if (!hooks) return webhookError(`Quo's webhook list has no shape Tidepool recognizes (HTTP ${listed.status}), so nothing was created.`);

      // Only a webhook pointing at Tidepool's own address is Tidepool's. Typhoon's
      // (and any other app's) webhooks are never touched.
      const ours = hooks.find((hook) => sameUrl(str(hook, ["url", "endpoint", "webhookUrl", "target"]), url));
      if (ours) {
        const last4 = tail(str(ours, ["id", "webhookId"]));
        return {
          status: "exists_without_secret",
          idLast4: last4,
          url,
          message:
            `A Quo webhook${last4 ? ` (id ${mask(last4)})` : ""} already posts to ${url}, but Quo shows a webhook's signing secret only when it is created, ` +
            "so Tidepool cannot read it and created nothing. Either paste that webhook's signing secret into Railway as QUO_WEBHOOK_SECRET on the web service, " +
            "or delete that one webhook in Quo (only the one posting to this address) so the next deploy recreates it and stores the new secret.",
        };
      }

      const payload = {
        label: QUO_WEBHOOK_LABEL,
        url,
        events: QUO_WEBHOOK_EVENTS,
        // Scoped to the hiring number. Field name unverified; both likely names are sent (as quo:webhook always did).
        resourceIds: [emp.smsQuoPhoneNumberId],
        phoneNumberIds: [emp.smsQuoPhoneNumberId],
        status: "enabled",
      };
      const created = await ctx.call("POST", ctx.webhooksUrl, payload, true);
      if (!created.ok) return webhookError(`Quo did not create the webhook: ${created.problem}`);

      const id = findField(created.body, ["id", "webhookId"]);
      const last4 = tail(id);
      const secret = findField(created.body, ["secret", "signingSecret", "signing_secret", "webhookSecret", "key"]);
      if (!secret || secret.length < 8) {
        return {
          status: "exists_without_secret",
          idLast4: last4,
          url,
          message:
            `Quo created the webhook${last4 ? ` (id ${mask(last4)})` : ""} for ${url}, but its response carried no signing secret Tidepool recognizes, so nothing was stored. ` +
            "Copy the signing secret from that webhook's page in Quo into Railway as QUO_WEBHOOK_SECRET on the web service, or delete that webhook in Quo so the next deploy recreates it.",
        };
      }
      ctx.sensitive.push(secret);
      await storeIntegrationSecret(tx, {
        key: QUO_WEBHOOK_SECRET_KEY,
        value: secret,
        note: `Signing secret of the Quo webhook${last4 ? ` ${mask(last4)}` : ""} for ${url}, created by quo:setup on ${ctx.now.toISOString()}`,
        now: ctx.now,
      });
      return {
        status: "created",
        idLast4: last4,
        url,
        message: `Created the Quo webhook${last4 ? ` (id ${mask(last4)})` : ""} for ${url} (${QUO_WEBHOOK_EVENTS.join(", ")}; hiring number only) and stored its signing secret.`,
      };
    });
  } catch (error) {
    return webhookError(`Setup failed: ${ctx.redact(errorText(error))}`);
  }
}

// One audit row per run (action integration.quo_setup on the employer), carrying
// the two statuses and their redacted messages: the history of every setup run,
// and what Settings > Texting shows as the last result. Never the secret.
async function recordQuoSetup(db: Db, result: QuoSetupResult, ctx: Context): Promise<void> {
  try {
    const emp = await getEmployer(db);
    await writeAudit(db, {
      actor: SYSTEM_ACTOR,
      action: QUO_SETUP_AUDIT_ACTION,
      entityType: "employer",
      entityId: emp.id,
      occurredAt: result.at,
      changes: {
        phone: { status: result.phone.status, idLast4: result.phone.idLast4, message: ctx.scrub(result.phone.message) },
        webhook: { status: result.webhook.status, idLast4: result.webhook.idLast4, message: ctx.scrub(result.webhook.message) },
      },
    });
  } catch (error) {
    console.error(`[quo:setup] could not record the result: ${ctx.redact(errorText(error))}`);
  }
}

export type LastQuoSetup = {
  at: Date;
  phone: { status: QuoPhoneStatus; message: string };
  webhook: { status: QuoWebhookStatus; message: string };
};

// The newest setup run, for Settings > Texting.
export async function getLastQuoSetup(db: Db, employerId: string): Promise<LastQuoSetup | null> {
  const [row] = await db
    .select({ occurredAt: auditLog.occurredAt, changes: auditLog.changes })
    .from(auditLog)
    .where(and(eq(auditLog.action, QUO_SETUP_AUDIT_ACTION), eq(auditLog.entityType, "employer"), eq(auditLog.entityId, employerId)))
    .orderBy(desc(auditLog.occurredAt))
    .limit(1);
  if (!row) return null;
  const changes = asObject(row.changes);
  const phone = asObject(changes?.phone);
  const webhook = asObject(changes?.webhook);
  return {
    at: row.occurredAt,
    phone: { status: (str(phone, ["status"]) ?? "error") as QuoPhoneStatus, message: str(phone, ["message"]) ?? "" },
    webhook: { status: (str(webhook, ["status"]) ?? "error") as QuoWebhookStatus, message: str(webhook, ["message"]) ?? "" },
  };
}

// The lines `pnpm quo:setup` prints, already redacted.
export function describeQuoSetup(result: Pick<QuoSetupResult, "phone" | "webhook">): string[] {
  return [`hiring number: ${result.phone.status}. ${result.phone.message}`, `webhook: ${result.webhook.status}. ${result.webhook.message}`];
}

// ---------------------------------------------------------------------------
// HTTP and redaction

type CallResult = { ok: true; status: number; body: unknown } | { ok: false; status: number | null; problem: string };

type Context = {
  now: Date;
  apiBaseUrl: string;
  webhooksUrl: string;
  env: Record<string, string | undefined>;
  // Strings that must never appear in a message: the API key, and the secret once read.
  sensitive: string[];
  // For text Tidepool did not write (Quo error bodies, exceptions): everything redactText removes.
  redact: (text: string) => string;
  // For Tidepool's own messages: only the sensitive strings, so dates and URLs survive.
  scrub: (text: string) => string;
  call: (method: "GET" | "POST", url: string, body?: unknown, versioned?: boolean) => Promise<CallResult>;
};

function context(options: QuoSetupOptions): Context {
  const apiBaseUrl = (options.apiBaseUrl?.trim() || QUO_DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const sensitive = [options.apiKey];
  const redact = (text: string) => redactText(text, sensitive);
  const scrub = (text: string) => removeSensitive(text, sensitive);
  const call: Context["call"] = async (method, url, body, versioned = false) => {
    const headers: Record<string, string> = { Authorization: options.apiKey, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (versioned) headers["Quo-Api-Version"] = QUO_API_VERSION;
    const path = url.startsWith(apiBaseUrl) ? url.slice(apiBaseUrl.length) || "/" : url;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(QUO_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, status: null, problem: `${method} ${path} did not complete (${redact(errorText(error)).slice(0, 200)})` };
    }
    let text = "";
    try {
      text = await response.text();
    } catch {
      // an unreadable body is treated as empty
    }
    if (!response.ok) {
      // A failure body never carries a secret Tidepool wants, so a short redacted excerpt helps.
      const excerpt = redact(text.replace(/\s+/g, " ").trim()).slice(0, 200);
      return { ok: false, status: response.status, problem: `Quo answered HTTP ${response.status} to ${method} ${path}${excerpt ? `: ${excerpt}` : ""}` };
    }
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Never echo a 2xx body: it may hold a secret under a name Tidepool does not know.
      return { ok: false, status: response.status, problem: `Quo answered HTTP ${response.status} to ${method} ${path} with a body that is not JSON` };
    }
    return { ok: true, status: response.status, body: parsed };
  };
  return {
    now: options.now ?? new Date(),
    apiBaseUrl,
    webhooksUrl: `${apiBaseUrl}${QUO_WEBHOOKS_PATH}`,
    env: options.env ?? process.env,
    sensitive,
    redact,
    scrub,
    call,
  };
}

// Removes the given strings wherever they appear.
export function removeSensitive(text: string, sensitive: readonly string[]): string {
  let out = text;
  for (const value of sensitive) {
    if (value && value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out;
}

// For text Tidepool did not write: removes the given strings, anything shaped like
// a webhook secret or a long token, and all but the last 4 digits of anything
// shaped like a US phone number.
export function redactText(text: string, sensitive: readonly string[] = []): string {
  return removeSensitive(text, sensitive)
    .replace(/whsec_[A-Za-z0-9+/=_-]*/g, "[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]")
    .replace(/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g, (match) => maskNumber(match.replace(/\D/g, "")));
}

// An error's message plus its cause's code or message (ECONNREFUSED, a SQLSTATE),
// which is where fetch and the database driver keep the useful part.
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const base = error.name === "TimeoutError" ? `timed out after ${QUO_REQUEST_TIMEOUT_MS / 1000}s` : error.message;
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : null;
  return detail && !base.includes(detail) ? `${base}: ${detail}` : base;
}

function phoneError(message: string): QuoSetupResult["phone"] {
  return { status: "error", idLast4: null, message };
}

// ---------------------------------------------------------------------------
// Tolerant JSON reading (the same approach as quo-connect.ts)

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(obj: Json | null | undefined, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

// The array of entries in a list response, or null when there is none to find.
function findList(payload: unknown): Json[] | null {
  const root = asObject(payload);
  const candidates = [payload, root?.data, root?.items, root?.results, root?.phoneNumbers, root?.webhooks];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(asObject).filter((x): x is Json => x !== null);
    const nested = asObject(candidate);
    for (const key of ["items", "data", "webhooks", "phoneNumbers"]) {
      if (nested && Array.isArray(nested[key])) return (nested[key] as unknown[]).map(asObject).filter((x): x is Json => x !== null);
    }
  }
  return null;
}

// A field from a create response: the root, `data`, or a `webhook` object in either.
function findField(payload: unknown, keys: string[]): string | null {
  const root = asObject(payload);
  const data = asObject(root?.data);
  for (const obj of [data, asObject(data?.webhook), root, asObject(root?.webhook)]) {
    const found = str(obj, keys);
    if (found) return found;
  }
  return null;
}

function numberCandidates(entry: Json): string[] {
  return ["number", "phoneNumber", "e164", "formattedNumber"].map((key) => str(entry, [key])).filter((x): x is string => x !== null);
}

// Digits of a US number without the leading country code, so "+1 (763) 292-2259",
// "17632922259" and "7632922259" all compare equal.
function usDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function tail(value: string | null | undefined): string | null {
  return value ? value.slice(-4) : null;
}

function mask(last4: string | null): string {
  return last4 ? `...${last4}` : "(no id)";
}

function maskNumber(digits: string): string {
  return digits ? `...${digits.slice(-4)}` : "(unreadable number)";
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed || !/^https:\/\/[^/\s]+/i.test(trimmed)) return null;
  return trimmed;
}

function sameUrl(a: string | null, b: string): boolean {
  if (!a) return false;
  const normalize = (value: string) => {
    try {
      const parsed = new URL(value.trim());
      return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`.toLowerCase();
    } catch {
      return value.trim().replace(/\/+$/, "").toLowerCase();
    }
  };
  return normalize(a) === normalize(b);
}
