import { expect } from "vitest";
import type { Db } from "@/db";

// Drizzle wraps driver errors in DrizzleQueryError and keeps the original in `cause`.
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

export const PG = {
  uniqueViolation: "23505",
  checkViolation: "23514",
  appendOnly: "TP001",
  immutablePublished: "TP002",
} as const;

// Awaits a statement that must fail with the given Postgres SQLSTATE.
export async function expectPgError(run: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  if (!caught) throw new Error(`expected SQLSTATE ${code} but the statement succeeded`);
  expect(pgErrorCode(caught), `expected SQLSTATE ${code}, got: ${String(caught)}`).toBe(code);
}

class Rollback extends Error {}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Runs writes in a transaction that is always rolled back, so a test can prove a
// statement is allowed without leaving rows behind.
export async function withRollback(db: Db, fn: (tx: Tx) => Promise<void>) {
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
