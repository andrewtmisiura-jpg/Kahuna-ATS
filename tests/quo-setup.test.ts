import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "@/db";
import { auditLog, employer, integrationSecret, message } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { getTextingSettings } from "@/server/services/config/texting";
import { QUO_WEBHOOK_SECRET_KEY, readIntegrationSecret, resetQuoWebhookSecretCache, storeIntegrationSecret } from "@/server/services/integration-secrets";
import {
  describeQuoSetup,
  ensureQuoConnected,
  QUO_API_VERSION,
  QUO_SETUP_AUDIT_ACTION,
  quoSetupNeedsAttention,
  redactText,
  type QuoSetupOptions,
} from "@/server/services/messaging/quo-setup";
import { loadEmployer, TEST_ADMIN_EMAIL } from "./helpers/fixtures";

// pnpm quo:setup: ensureQuoConnected and the CLI. Quo is faked: in-process tests
// pass a fake fetch, and the CLI tests run the real command against a local HTTP
// server standing in for api.quo.com. The route's secret lookup is in
// quo-webhook-secret.test.ts.

const API_KEY = "quo-test-api-key-0123456789abcdef";
const SECRET = "whsec_" + Buffer.from("tidepool-quo-signing-key-32byte!").toString("base64");
const HIRING_ID = "PNhireAbc123";
const TYPHOON_ID = "PNtyphoon0001";
const BASE = "https://tidepool.example.test";
const TARGET = `${BASE}/api/webhooks/quo`;
const TYPHOON_HOOK = { id: "WHtyphoon0001", label: "Typhoon", url: "https://typhoon.kahunawindowcleaning.com/api/quo/webhook", events: ["message.received"] };
const NUMBERS = { data: [{ id: TYPHOON_ID, number: "+16125550100", name: "Office" }, { id: HIRING_ID, phoneNumber: "(763) 292-2259", name: "Hiring" }] };

let employerId: string;

type Call = { method: string; url: string; path: string; headers: Record<string, string>; body: unknown };
type Handler = (call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A stand-in for Quo: handlers keyed "METHOD /path"; anything else is a 404.
function fakeQuo(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { method, url, path: new URL(url).pathname, headers: Object.fromEntries(new Headers(init?.headers).entries()), body };
    calls.push(call);
    const handler = handlers[`${method} ${call.path}`];
    return handler ? handler(call) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

// The happy path: the hiring number is listed, no webhook exists, create returns a secret.
function happyQuo(overrides: Record<string, Handler> = {}) {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    ...fakeQuo({
      "GET /v1/phone-numbers": () => json(NUMBERS),
      "GET /webhooks": () => json({ data: [TYPHOON_HOOK, ...created] }),
      "POST /webhooks": (call) => {
        const hook = { id: `WHtidepool${created.length + 1}`, ...(call.body as object) };
        created.push(hook);
        return json({ data: { ...hook, key: SECRET } }, 201);
      },
      ...overrides,
    }),
  };
}

function options(fetchImpl: typeof fetch, extra: Partial<QuoSetupOptions> = {}): QuoSetupOptions {
  return { apiKey: API_KEY, publicBaseUrl: BASE, fetch: fetchImpl, env: {}, ...extra };
}

async function storedPhoneId() {
  const [row] = await db.select({ id: employer.smsQuoPhoneNumberId }).from(employer).where(eq(employer.id, employerId));
  return row?.id ?? null;
}

async function resetQuoState() {
  await db.update(employer).set({ smsQuoPhoneNumberId: null }).where(eq(employer.id, employerId));
  await db.delete(integrationSecret);
  resetQuoWebhookSecretCache();
}

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  employerId = (await loadEmployer(db)).id;
});

beforeEach(resetQuoState);

afterAll(async () => {
  await resetQuoState();
  await sql.end();
});

describe("ensureQuoConnected: the hiring number", () => {
  it("matches the hiring number by digits and stores its id, sending the key with no Bearer prefix", async () => {
    const quo = happyQuo();
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(result.phone).toMatchObject({ status: "connected", idLast4: "c123" });
    expect(result.phone.message).toContain("...2259");
    expect(await storedPhoneId()).toBe(HIRING_ID);
    const list = quo.calls.find((c) => c.path === "/v1/phone-numbers")!;
    expect(list.method).toBe("GET");
    expect(list.url).toBe("https://api.quo.com/v1/phone-numbers");
    expect(list.headers.authorization).toBe(API_KEY);
  });

  it("makes no API call at all once the number and the secret are stored", async () => {
    await db.update(employer).set({ smsQuoPhoneNumberId: HIRING_ID }).where(eq(employer.id, employerId));
    await storeIntegrationSecret(db, { key: QUO_WEBHOOK_SECRET_KEY, value: SECRET });
    const quo = happyQuo();
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(quo.calls).toHaveLength(0);
    expect(result.phone).toMatchObject({ status: "already", idLast4: "c123" });
    expect(result.webhook.status).toBe("already");
    expect(quoSetupNeedsAttention(result)).toBe(false);
  });

  it("treats QUO_WEBHOOK_SECRET in Railway as connected and calls nothing", async () => {
    await db.update(employer).set({ smsQuoPhoneNumberId: HIRING_ID }).where(eq(employer.id, employerId));
    const quo = happyQuo();
    const result = await ensureQuoConnected(db, options(quo.fetch, { env: { QUO_WEBHOOK_SECRET: SECRET } }));
    expect(quo.calls).toHaveLength(0);
    expect(result.webhook.status).toBe("already");
    expect(await readIntegrationSecret(db, QUO_WEBHOOK_SECRET_KEY)).toBeNull();
  });

  it("reports not_found with a count and last 4 digits only, and does not attempt the webhook", async () => {
    const quo = happyQuo({ "GET /v1/phone-numbers": () => json({ data: [{ id: TYPHOON_ID, number: "+16125550100" }, { id: "PNother0002", number: "+19525550199" }] }) });
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(result.phone.status).toBe("not_found");
    expect(result.phone.message).toContain("2 phone number(s)");
    expect(result.phone.message).toContain("...0100");
    expect(result.phone.message).toContain("...0199");
    expect(result.phone.message).not.toMatch(/6125550100|9525550199|7632922259|PNtyphoon|PNother/);
    expect(result.webhook.status).toBe("error");
    expect(result.webhook.message).toContain("not connected");
    expect(quo.calls.map((c) => c.path)).toEqual(["/v1/phone-numbers"]);
    expect(await storedPhoneId()).toBeNull();
    expect(quoSetupNeedsAttention(result)).toBe(true);
  });
});

describe("ensureQuoConnected: the webhook", () => {
  it("creates the one webhook scoped to the hiring number and stores its secret, never logging or returning it", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name));
    try {
      const quo = happyQuo();
      const result = await ensureQuoConnected(db, options(quo.fetch));
      for (const line of describeQuoSetup(result)) console.log(`[quo:setup] ${line}`);

      expect(result.webhook).toMatchObject({ status: "created", idLast4: "ool1", url: TARGET, scope: "hiring_number" });
      expect(result.webhook.message).toContain("hiring number only, as Quo confirmed");
      expect(quoSetupNeedsAttention(result)).toBe(false);
      expect(await readIntegrationSecret(db, QUO_WEBHOOK_SECRET_KEY)).toBe(SECRET);

      const post = quo.calls.find((c) => c.method === "POST")!;
      expect(post.url).toBe("https://api.quo.com/webhooks");
      expect(post.headers["quo-api-version"]).toBe(QUO_API_VERSION);
      expect(post.headers.authorization).toBe(API_KEY);
      expect(post.body).toMatchObject({
        label: "Tidepool",
        url: TARGET,
        events: ["message.received", "message.delivered", "message.failed", "message.undelivered"],
        resourceIds: [HIRING_ID],
      });
      expect(quo.calls.find((c) => c.method === "GET" && c.path === "/webhooks")!.headers["quo-api-version"]).toBe(QUO_API_VERSION);

      // Nowhere but the integration_secret row: not the result, the console or the audit row.
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      const printed = spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" "))).join("\n");
      expect(printed).toContain("[quo:setup]");
      expect(printed).not.toContain(SECRET);
      expect(printed).not.toContain(SECRET.slice(6));
      expect(printed).not.toContain(API_KEY);
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, QUO_SETUP_AUDIT_ACTION), eq(auditLog.entityId, employerId)))
        .orderBy(desc(auditLog.occurredAt))
        .limit(1);
      expect(audit?.actorType).toBe("system");
      expect(JSON.stringify(audit?.changes)).toContain("created");
      expect(JSON.stringify(audit?.changes)).not.toContain(SECRET);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("never duplicates or deletes a webhook that already points at Tidepool's address", async () => {
    const quo = happyQuo({ "GET /webhooks": () => json({ data: [TYPHOON_HOOK, { id: "WHtidepool77", label: "Tidepool", url: `${TARGET}/` }] }) });
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(result.phone.status).toBe("connected");
    expect(result.webhook).toMatchObject({ status: "exists_without_secret", idLast4: "ol77" });
    expect(result.webhook.message).toContain("QUO_WEBHOOK_SECRET");
    expect(result.webhook.message).toContain("delete");
    expect(quo.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(await readIntegrationSecret(db, QUO_WEBHOOK_SECRET_KEY)).toBeNull();
    expect(quoSetupNeedsAttention(result)).toBe(true);
  });

  it("ignores Typhoon's webhook for another address, even one covering the hiring number: creates Tidepool's and touches nothing else", async () => {
    const typhoonAllNumbers = { ...TYPHOON_HOOK, resourceIds: [TYPHOON_ID, HIRING_ID] };
    const quo = happyQuo({ "GET /webhooks": () => json({ data: [typhoonAllNumbers] }) });
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(result.webhook.status).toBe("created");
    const writes = quo.calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: "/webhooks" });
    expect(JSON.stringify(writes[0]!.body)).not.toContain("typhoon");
    expect(quo.calls.some((c) => c.path.includes(TYPHOON_HOOK.id))).toBe(false);
  });

  it("finds its own webhook under a field name it does not know, so repeated deploys create one webhook", async () => {
    // Quo lists the address under an unknown key, nested, and returns the secret under an unknown name.
    const made: { id: string; url: string }[] = [];
    const quo = fakeQuo({
      "GET /v1/phone-numbers": () => json(NUMBERS),
      "GET /webhooks": () => json({ data: [TYPHOON_HOOK, ...made.map((hook) => ({ id: hook.id, title: "x", config: { webhookURL: hook.url } }))] }),
      "POST /webhooks": (call) => {
        const hook = { id: `WHtidepool${made.length + 1}`, url: (call.body as { url: string }).url };
        made.push(hook);
        return json({ data: { id: hook.id, signingKey: SECRET } }, 201);
      },
    });
    const results = [];
    for (let deploy = 0; deploy < 3; deploy++) results.push(await ensureQuoConnected(db, options(quo.fetch)));
    expect(quo.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(results.map((r) => r.webhook.status)).toEqual(["exists_without_secret", "exists_without_secret", "exists_without_secret"]);
    expect(results[1]!.webhook.message).toContain(`already posts to ${TARGET}`);
    expect(results[2]!.webhook.idLast4).toBe("ool1");
    expect(await readIntegrationSecret(db, QUO_WEBHOOK_SECRET_KEY)).toBeNull();
    expect(quo.calls.some((c) => c.method !== "GET" && c.method !== "POST")).toBe(false);
  });

  it("treats a webhook labeled Tidepool as its own even when its address is unreadable", async () => {
    const quo = happyQuo({ "GET /webhooks": () => json({ data: [TYPHOON_HOOK, { id: "WHtidepool55", name: " tidepool " }] }) });
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(result.webhook).toMatchObject({ status: "exists_without_secret", idLast4: "ol55" });
    expect(result.webhook.message).toContain("labeled Tidepool already exists");
    expect(quo.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("keeps a secret stored by something else during the create and says the new webhook must be deleted", async () => {
    const OTHER = "whsec_" + Buffer.from("a-secret-written-by-hand-32bytes").toString("base64");
    const quo = happyQuo({
      "POST /webhooks": async (call) => {
        // A row written without the setup lock (by hand, a restore) lands while Quo is creating the webhook.
        await db.insert(integrationSecret).values({ key: QUO_WEBHOOK_SECRET_KEY, value: OTHER });
        return json({ data: { id: "WHtidepool2", ...(call.body as object), secret: SECRET } }, 201);
      },
    });
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(result.webhook).toMatchObject({ status: "exists_without_secret", idLast4: "ool2", scope: null });
    expect(result.webhook.message).toContain("was not kept");
    expect(result.webhook.message).toContain("Delete that new webhook (id ...ool2)");
    expect(quoSetupNeedsAttention(result)).toBe(true);
    expect(await readIntegrationSecret(db, QUO_WEBHOOK_SECRET_KEY)).toBe(OTHER);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(OTHER);
  });

  it("flags a created webhook whose scope Quo does not echo", async () => {
    const quo = happyQuo({ "POST /webhooks": () => json({ data: { id: "WHtidepool3", label: "Tidepool", url: TARGET, secret: SECRET } }, 201) });
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(result.webhook).toMatchObject({ status: "created", scope: "unconfirmed" });
    expect(result.webhook.message).toContain("does not say which numbers it covers");
    expect(result.webhook.message).toContain("...2259");
    expect(quoSetupNeedsAttention(result)).toBe(true);
    expect(await readIntegrationSecret(db, QUO_WEBHOOK_SECRET_KEY)).toBe(SECRET);
    const settings = await getTextingSettings(db);
    expect(settings.quo.lastSetup?.webhook).toMatchObject({ status: "created", scope: "unconfirmed" });
  });

  it("flags a created webhook that Quo says covers more than the hiring number", async () => {
    for (const scope of [{ resourceIds: [HIRING_ID, TYPHOON_ID] }, { resourceIds: [] }, { phoneNumberIds: null }, { resourceIds: [HIRING_ID], phoneNumberIds: [] }]) {
      await resetQuoState();
      const quo = happyQuo({ "POST /webhooks": () => json({ data: { id: "WHtidepool4", url: TARGET, ...scope, secret: SECRET } }, 201) });
      const result = await ensureQuoConnected(db, options(quo.fetch));
      expect(result.webhook).toMatchObject({ status: "created", scope: "wider" });
      expect(result.webhook.message).toContain("covers more than the hiring number");
      expect(result.webhook.message).not.toMatch(/PNhire|PNtyphoon/);
      expect(quoSetupNeedsAttention(result)).toBe(true);
    }
  });

  it("stores nothing when the create response has no recognizable secret, and never echoes that body", async () => {
    const quo = happyQuo({ "POST /webhooks": () => json({ data: { id: "WHtidepool9", hmacMaterial: "zzzzSOMETHING-UNKNOWNzzzz" } }, 201) });
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(result.webhook).toMatchObject({ status: "exists_without_secret", idLast4: "ool9" });
    expect(result.webhook.message).not.toContain("SOMETHING-UNKNOWN");
    expect(await readIntegrationSecret(db, QUO_WEBHOOK_SECRET_KEY)).toBeNull();
  });

  it("refuses to create without an https PUBLIC_BASE_URL", async () => {
    const quo = happyQuo();
    const result = await ensureQuoConnected(db, options(quo.fetch, { publicBaseUrl: "http://localhost:3000" }));
    expect(result.phone.status).toBe("connected");
    expect(result.webhook.status).toBe("error");
    expect(result.webhook.message).toContain("PUBLIC_BASE_URL");
    expect(quo.calls.some((c) => c.path === "/webhooks")).toBe(false);
  });

  it("creates exactly one webhook when two runs overlap", async () => {
    const quo = happyQuo();
    const [a, b] = await Promise.all([ensureQuoConnected(db, options(quo.fetch)), ensureQuoConnected(db, options(quo.fetch))]);
    expect(quo.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect([a.webhook.status, b.webhook.status].sort()).toEqual(["already", "created"]);
    expect([a.phone.status, b.phone.status].sort()).toEqual(["already", "connected"]);
  });
});

describe("ensureQuoConnected: bad responses never throw", () => {
  it("a 500 listing the numbers is an error, with the key redacted even when Quo echoes it", async () => {
    const quo = happyQuo({ "GET /v1/phone-numbers": (call) => new Response(`upstream exploded for key ${call.headers.authorization} and +1 763 292 2259`, { status: 500 }) });
    const result = await ensureQuoConnected(db, options(quo.fetch));
    expect(result.phone.status).toBe("error");
    expect(result.phone.message).toContain("HTTP 500");
    expect(result.phone.message).not.toContain(API_KEY);
    expect(result.phone.message).not.toMatch(/763 292 2259/);
    expect(result.webhook.status).toBe("error");
    expect(await storedPhoneId()).toBeNull();
  });

  it("malformed phone-number responses are errors", async () => {
    for (const handler of [() => new Response("<html>oops</html>", { status: 200 }), () => json({ unexpected: true }), () => json(null)] as Handler[]) {
      await resetQuoState();
      const quo = happyQuo({ "GET /v1/phone-numbers": handler });
      const result = await ensureQuoConnected(db, options(quo.fetch));
      expect(result.phone.status).toBe("error");
      expect(await storedPhoneId()).toBeNull();
    }
  });

  it("a failed or malformed webhook list creates nothing", async () => {
    for (const handler of [() => json({ message: "boom" }, 500), () => json({ webhooks: "nope" }), () => new Response("not json", { status: 200 })] as Handler[]) {
      await resetQuoState();
      const quo = happyQuo({ "GET /webhooks": handler });
      const result = await ensureQuoConnected(db, options(quo.fetch));
      expect(result.phone.status).toBe("connected");
      expect(result.webhook.status).toBe("error");
      expect(quo.calls.some((c) => c.method === "POST")).toBe(false);
    }
  });

  it("a refused create and a network failure are errors", async () => {
    const refused = happyQuo({ "POST /webhooks": () => json({ message: "invalid resourceIds" }, 422) });
    const r1 = await ensureQuoConnected(db, options(refused.fetch));
    expect(r1.webhook.status).toBe("error");
    expect(r1.webhook.message).toContain("HTTP 422");

    await resetQuoState();
    const offline = (async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED (key ${API_KEY})`);
    }) as typeof fetch;
    const r2 = await ensureQuoConnected(db, options(offline));
    expect(r2.phone.status).toBe("error");
    expect(r2.phone.message).toContain("did not complete");
    expect(r2.phone.message).not.toContain(API_KEY);
  });

  it("redactText masks phone numbers, webhook secrets and long tokens", () => {
    const text = redactText(`call +1 (763) 292-2259 or 612.555.0100, secret ${SECRET}, token abcdefghijklmnopqrstuvwxyz0123, on 2026-10-16`, [API_KEY]);
    expect(text).toContain("...2259");
    expect(text).toContain("...0100");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(text).toContain("2026-10-16");
  });
});

describe("Settings > Texting", () => {
  it("shows the number's last 4, whether the webhook is connected and the last result, never the secret", async () => {
    const before = await getTextingSettings(db);
    expect(before.quo).toMatchObject({ phoneIdLast4: null, webhookConnected: false, webhookSecretSource: null });

    const quo = happyQuo();
    const result = await ensureQuoConnected(db, options(quo.fetch, { now: new Date(Date.now() + 60_000) }));
    const after = await getTextingSettings(db);
    expect(after.quoConnected).toBe(true);
    expect(after.quo).toMatchObject({ phoneIdLast4: "c123", webhookConnected: true, webhookSecretSource: "stored" });
    expect(after.quo.lastSetup).toMatchObject({ at: result.at, phone: { status: "connected" }, webhook: { status: "created" } });
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(JSON.stringify(after)).not.toContain(HIRING_ID);
  });
});

// ---------------------------------------------------------------------------
// The CLI, run for real against a local stand-in for Quo

type ServerRequest = { method: string; path: string; authorization: string | undefined };

async function startQuoServer(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const requests: ServerRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", path: req.url ?? "/", authorization: req.headers.authorization });
      handle(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function runCli(env: Record<string, string>): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "node_modules/.bin/tsx",
      ["src/cli/quo-setup.ts"],
      {
        cwd: process.cwd(),
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "test",
          TZ: "UTC",
          DATABASE_URL: process.env.DATABASE_URL_TEST ?? "",
          ALERT_EMAIL: "alerts@example.test",
          MESSAGE_PROVIDERS: "sink",
          QUO_WEBHOOK_SECRET: "",
          PUBLIC_BASE_URL: BASE,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code ?? 1) : error ? 1 : 0;
        resolve({ code, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

describe("pnpm quo:setup", () => {
  it("skips quietly and exits 0 without QUO_API_KEY", async () => {
    const { code, output } = await runCli({ QUO_API_KEY: "" });
    expect(code).toBe(0);
    expect(output).toContain("[quo:setup] QUO_API_KEY is not set; skipped");
  }, 60_000);

  it("exits 0 when Quo answers 500, logs the problem redacted and alerts", async () => {
    const quo = await startQuoServer((req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`boom for ${req.headers.authorization}`);
    });
    try {
      const { code, output } = await runCli({ QUO_API_KEY: API_KEY, QUO_API_BASE_URL: quo.url });
      expect(code).toBe(0);
      expect(output).toContain("hiring number: error");
      expect(output).toContain("HTTP 500");
      expect(output).toContain("needs attention");
      expect(output).not.toContain(API_KEY);
      expect(quo.requests[0]).toMatchObject({ method: "GET", path: "/v1/phone-numbers", authorization: API_KEY });
      const alerts = await db.select().from(message).where(eq(message.toAddress, "alerts@example.test"));
      expect(alerts.some((row) => row.dedupeKey?.startsWith("alert:quo_setup:"))).toBe(true);
    } finally {
      await quo.close();
    }
  }, 60_000);

  it("exits 0 when the database is unreachable", async () => {
    const { code, output } = await runCli({ QUO_API_KEY: API_KEY, DATABASE_URL: "postgres://postgres@127.0.0.1:1/nowhere", QUO_API_BASE_URL: "http://127.0.0.1:1" });
    expect(code).toBe(0);
    expect(output).toContain("[quo:setup]");
    expect(output).not.toContain(API_KEY);
  }, 60_000);

  it("connects the number, creates the webhook and stores the secret, printing neither the key nor the secret", async () => {
    const quo = await startQuoServer((req, res, body) => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "GET" && req.url === "/v1/phone-numbers") return send(200, NUMBERS);
      if (req.method === "GET" && req.url === "/webhooks") return send(200, { data: [TYPHOON_HOOK] });
      if (req.method === "POST" && req.url === "/webhooks") return send(201, { data: { id: "WHtidepoolCLI1", ...JSON.parse(body), secret: SECRET } });
      send(404, { message: "not found" });
    });
    try {
      const { code, output } = await runCli({ QUO_API_KEY: API_KEY, QUO_API_BASE_URL: quo.url });
      expect(code).toBe(0);
      expect(output).toContain("hiring number: connected");
      expect(output).toContain("webhook: created");
      expect(output).toContain("[quo:setup] done");
      expect(output).not.toContain(API_KEY);
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain(SECRET.slice(6));
      expect(output).not.toContain(HIRING_ID);
      expect(await storedPhoneId()).toBe(HIRING_ID);
      expect(await readIntegrationSecret(db, QUO_WEBHOOK_SECRET_KEY)).toBe(SECRET);
      expect(quo.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/phone-numbers", "GET /webhooks", "POST /webhooks"]);

      // A second deploy does nothing and calls nothing.
      const again = await runCli({ QUO_API_KEY: API_KEY, QUO_API_BASE_URL: quo.url });
      expect(again.code).toBe(0);
      expect(again.output).toContain("hiring number: already");
      expect(again.output).toContain("webhook: already");
      expect(quo.requests).toHaveLength(3);
    } finally {
      await quo.close();
    }
  }, 60_000);
});
