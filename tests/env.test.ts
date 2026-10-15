import { describe, expect, it } from "vitest";
import { envSchema } from "@/config/env";

describe("env ADMIN_EMAIL", () => {
  const base = { DATABASE_URL: "postgres://postgres@127.0.0.1:54329/tidepool_test" };

  it("accepts one email or a comma-separated list", () => {
    expect(envSchema.safeParse({ ...base, ADMIN_EMAIL: "a@example.com" }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, ADMIN_EMAIL: "a@example.com, b@example.com" }).success).toBe(true);
  });

  it("rejects a list with a bad entry", () => {
    expect(envSchema.safeParse({ ...base, ADMIN_EMAIL: "a@example.com,not-an-email" }).success).toBe(false);
  });
});
