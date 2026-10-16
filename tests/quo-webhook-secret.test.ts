import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { employer, integrationSecret, message } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { getQuoWebhookSecret, QUO_WEBHOOK_SECRET_KEY, resetQuoWebhookSecretCache, storeIntegrationSecret } from "@/server/services/integration-secrets";
import { POST as quoPost } from "@/app/api/webhooks/quo/route";
import { loadEmployer, nextMobile, TEST_ADMIN_EMAIL } from "./helpers/fixtures";

// The Quo webhook route's signing secret: QUO_WEBHOOK_SECRET from Railway first,
// then the integration_secret row `pnpm quo:setup` stores, cached for 5 minutes;
// with neither the route answers 503 without processing.

const SECRET = "whsec_" + Buffer.from("tidepool-quo-signing-key-32byte!").toString("base64");
const HIRING_ID = "PNhireAbc123";

let employerId: string;

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

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function quoRequest(body: string, secret = SECRET) {
  const id = `msg_${uuidv7()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("http://localhost/api/webhooks/quo", {
    method: "POST",
    headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": sign(secret, id, timestamp, body), "content-type": "application/json" },
    body,
  });
}

function inboundBody(text: string) {
  return JSON.stringify({
    id: `EV${uuidv7()}`,
    type: "message.received",
    createdAt: new Date().toISOString(),
    data: { object: { id: `AC${uuidv7()}`, object: "message", direction: "incoming", from: nextMobile(), to: "+17632922259", body: text, phoneNumberId: HIRING_ID } },
  });
}

describe("the Quo webhook route", () => {
  const original = process.env.QUO_WEBHOOK_SECRET;
  beforeEach(async () => {
    delete process.env.QUO_WEBHOOK_SECRET;
    await db.update(employer).set({ smsQuoPhoneNumberId: HIRING_ID }).where(eq(employer.id, employerId));
  });
  afterEach(() => {
    if (original === undefined) delete process.env.QUO_WEBHOOK_SECRET;
    else process.env.QUO_WEBHOOK_SECRET = original;
  });

  it("answers 503 without processing when neither Railway nor the database has a secret", async () => {
    const body = inboundBody("route test with no secret");
    const response = await quoPost(quoRequest(body));
    expect(response.status).toBe(503);
    expect(await db.select().from(message).where(eq(message.body, "route test with no secret"))).toHaveLength(0);
  });

  it("verifies a signature with the stored secret and rejects a bad one", async () => {
    await storeIntegrationSecret(db, { key: QUO_WEBHOOK_SECRET_KEY, value: SECRET });
    const body = inboundBody("route test with the stored secret");

    const bad = await quoPost(quoRequest(body, "whsec_" + Buffer.from("a-different-key").toString("base64")));
    expect(bad.status).toBe(401);
    expect(await db.select().from(message).where(eq(message.body, "route test with the stored secret"))).toHaveLength(0);

    const good = await quoPost(quoRequest(body));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, outcome: "inbound" });
    expect(await db.select().from(message).where(eq(message.body, "route test with the stored secret"))).toHaveLength(1);
  });

  it("prefers QUO_WEBHOOK_SECRET and caches the stored one for 5 minutes", async () => {
    await storeIntegrationSecret(db, { key: QUO_WEBHOOK_SECRET_KEY, value: SECRET });
    const now = new Date();
    expect(await getQuoWebhookSecret(db, { now, env: {} })).toEqual({ secret: SECRET, source: "db" });
    await db.delete(integrationSecret);
    expect(await getQuoWebhookSecret(db, { now: new Date(now.getTime() + 4 * 60_000), env: {} })).toEqual({ secret: SECRET, source: "db" });
    expect(await getQuoWebhookSecret(db, { now: new Date(now.getTime() + 5 * 60_000), env: {} })).toBeNull();
    expect(await getQuoWebhookSecret(db, { now, env: { QUO_WEBHOOK_SECRET: "whsec_env" } })).toEqual({ secret: "whsec_env", source: "env" });
  });
});
