import { loadDotEnv } from "@/config/env";

// `pnpm user:add-admin <email>`: creates an Admin, or makes an existing user an
// active Admin, so the owner can never be locked out (DATA_MODEL.md, app_user).

async function main() {
  const email = process.argv[2]?.trim();
  if (!email || !email.includes("@")) {
    throw new Error("usage: pnpm user:add-admin <email>");
  }
  loadDotEnv();
  const { db, sql } = await import("@/db");
  const { ensureAdminUser } = await import("@/server/services/users");
  try {
    const { user, created } = await ensureAdminUser(db, email, { promote: true });
    console.log(`[user:add-admin] ${created ? "created" : "updated"} ${user.email} as an active Admin (id ${user.id})`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[user:add-admin] failed", error);
  process.exit(1);
});
