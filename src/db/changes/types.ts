import type { Db } from "@/db";
import type { Actor } from "@/server/services/actor";

// A one-time content change run by `pnpm db:changes` (src/db/changes/run.ts).
// The id is permanent: once it is in applied_change the change never runs again,
// even if someone later undoes what it did in the question editor.

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ChangeContext = {
  // The earliest-created active Admin, so audit rows name a real person.
  actor: Actor;
  actorEmail: string;
  log: (line: string) => void;
};

export type Change = {
  // Date first, then a slug: "2026-10-16-snow-behavioral-questions".
  id: string;
  description: string;
  // Runs inside the runner's transaction. Goes through the service layer, never
  // hand-written inserts into versioned tables. Throw to stop the deploy.
  run: (tx: Tx, ctx: ChangeContext) => Promise<void>;
};
