import { readFileSync } from "node:fs";
import path from "node:path";
import { env, loadDotEnv } from "@/config/env";

// `pnpm legal:publish <key> <file.md>`: publishes the Markdown file as the next
// version of that legal text and supersedes the current one, with an audit row.
// Runs as an Admin: the app_user named by LEGAL_PUBLISH_AS, else ADMIN_EMAIL.
// Keys: sms_consent, privacy_policy, sms_terms, landing_notice, ai_disclosure, opt_in_page.

async function main() {
  const [key, file] = process.argv.slice(2);
  if (!key || !file) throw new Error("usage: pnpm legal:publish <key> <file.md>");
  loadDotEnv();

  const { db, sql } = await import("@/db");
  const { isLegalTextKind, LEGAL_TEXT_KINDS, publishLegalText, stripLeadingComment } = await import("@/server/services/legal");
  const { staffActor } = await import("@/server/services/actor");
  const { findUserByEmail } = await import("@/server/services/users");

  if (!isLegalTextKind(key)) throw new Error(`unknown key ${key}; one of ${LEGAL_TEXT_KINDS.join(", ")}`);
  const body = stripLeadingComment(readFileSync(path.resolve(file), "utf8"));
  if (!body) throw new Error(`${file} is empty after the leading comment`);

  try {
    const asEmail = process.env.LEGAL_PUBLISH_AS?.trim() || env().ADMIN_EMAIL;
    const user = asEmail ? await findUserByEmail(db, asEmail) : null;
    if (!user || user.status !== "active" || user.role !== "admin") {
      throw new Error("legal:publish runs as an active Admin: set LEGAL_PUBLISH_AS (or ADMIN_EMAIL) to an Admin's email");
    }
    for (const mark of ["Draft for owner approval", "OWNER INPUT"]) {
      if (body.includes(mark)) console.warn(`[legal:publish] warning: the text still contains "${mark}"`);
    }
    const result = await publishLegalText(db, {
      kind: key,
      body,
      changeNote: `Published from ${path.basename(file)} with pnpm legal:publish`,
      actor: staffActor(user.id),
    });
    console.log(
      `[legal:publish] ${key} v${result.version} published (id ${result.id})` +
        (result.previousVersionId ? `, supersedes ${result.previousVersionId}` : ", first version"),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[legal:publish] failed", error instanceof Error ? error.message : error);
  process.exit(1);
});
