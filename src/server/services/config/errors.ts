// Errors raised by the configuration services (Settings, entry codes and group
// sessions). Each carries a code the server actions turn into a plain sentence,
// and an HTTP status for route handlers.

export type ConfigErrorCode =
  | "not_found"
  | "invalid_input"
  | "opening_missing_pay_text"
  | "opening_missing_opens_on"
  | "role_already_open"
  | "dates_out_of_order"
  | "opening_wrong_role"
  | "opening_closed"
  | "user_exists"
  | "cannot_disable_self"
  | "cannot_change_own_role"
  | "last_admin"
  | "picklist_key_exists"
  | "picklist_locked"
  | "fcra_only_disqualify"
  | "separation_only_leave"
  | "session_requires_opening"
  | "session_wrong_opening"
  | "session_has_applicants"
  | "code_generation_failed";

const STATUS: Partial<Record<ConfigErrorCode, number>> = {
  not_found: 404,
  role_already_open: 409,
  user_exists: 409,
  picklist_key_exists: 409,
  picklist_locked: 409,
  session_has_applicants: 409,
};

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly status: number;

  constructor(code: ConfigErrorCode, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.status = STATUS[code] ?? 400;
  }
}

// Drizzle wraps driver errors; the Postgres SQLSTATE sits on the cause.
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

export const PG_UNIQUE_VIOLATION = "23505";
