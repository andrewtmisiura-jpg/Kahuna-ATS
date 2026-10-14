import { ZodError } from "zod";
import { AccessDeniedError, NotSignedInError } from "@/server/auth/authorize";
import { NoteError } from "@/server/services/applications/notes";
import { RecordError } from "@/server/services/applications/records";
import { StaleVersionError, TransitionError } from "@/server/services/applications/transition";
import { LandingError } from "@/server/services/landing";
import { SuppressionLiftRefused } from "@/server/services/messaging/consent";
import { SendError } from "@/server/services/messaging/send";
import { PersonError } from "@/server/services/people";

// What every admin server action returns. Errors from the services map to an
// HTTP-style status so the UI can tell a stale version (409) from a refused
// action (400), a lost sign-in (401) and a role problem (403).

export type ActionStatus = 400 | 401 | 403 | 404 | 409 | 500;

export type ActionFailure = {
  ok: false;
  status: ActionStatus;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  // Set on 409: who changed the application first, and when (ISO).
  stale?: { changedBy: string; changedAt: string };
};

export type ActionSuccess<T> = { ok: true; data: T };
export type ActionResult<T> = ActionSuccess<T> | ActionFailure;

export function toActionFailure(error: unknown): ActionFailure {
  if (error instanceof StaleVersionError) {
    const changedBy = error.changedBy ? (error.changedBy.name ?? error.changedBy.email) : "the applicant or the system";
    return {
      ok: false,
      status: 409,
      code: "stale_version",
      message: `Changed by ${changedBy} since you opened it. Reloading.`,
      stale: { changedBy, changedAt: error.changedAt.toISOString() },
    };
  }
  if (error instanceof NotSignedInError) return { ok: false, status: 401, code: "not_signed_in", message: "Sign in again to continue" };
  if (error instanceof AccessDeniedError) return { ok: false, status: 403, code: "access_denied", message: error.message };
  if (error instanceof TransitionError) {
    return { ok: false, status: statusForCode(error.code), code: error.code, message: error.message, details: serializable(error.details) };
  }
  if (
    error instanceof NoteError ||
    error instanceof PersonError ||
    error instanceof RecordError ||
    error instanceof LandingError ||
    error instanceof SendError
  ) {
    return { ok: false, status: statusForCode(error.code), code: error.code, message: error.message };
  }
  if (error instanceof SuppressionLiftRefused) return { ok: false, status: 400, code: "suppression_lift_refused", message: error.message };
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
    return { ok: false, status: 400, code: "invalid_input", message: `${issue?.message ?? "Check the form"}${where}` };
  }
  console.error("[admin action] unexpected error", error);
  return { ok: false, status: 500, code: "unexpected", message: "Something went wrong. Try again, and tell the builder if it keeps happening." };
}

function statusForCode(code: string): ActionStatus {
  return code.endsWith("_not_found") ? 404 : 400;
}

function serializable(details: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(details);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}
