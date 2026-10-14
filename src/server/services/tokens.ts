import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { resumeToken } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";

// Resume links (DATA_MODEL.md, resume_token). A token is 128 random bits, stored
// only as its SHA-256 hash, delivered after `#` in the link so browsers never send
// it, and expires 30 days after its last use. The plaintext exists only in the
// message delivered to the applicant and in the cookie exchange.

export const TOKEN_TTL_DAYS = 30;
const TOKEN_TTL_MS = TOKEN_TTL_DAYS * 86_400_000;

export type IssuedVia = (typeof resumeToken.$inferSelect)["issuedVia"];

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function resumeLink(hiringHost: string, token: string): string {
  return `https://${hiringHost}/r#${token}`;
}

// The placeholder stored in message.body instead of the link, so staff can never
// open an application as the applicant. Shown as "[application link]" in the UI.
export function linkPlaceholder(tokenId: string): string {
  return `{link:${tokenId}}`;
}

export type MintedToken = { tokenId: string; token: string; expiresAt: Date };

export async function mintResumeToken(
  db: Db,
  input: { applicationId: string; issuedVia: IssuedVia; messageId?: string | null; now?: Date },
): Promise<MintedToken> {
  const now = input.now ?? new Date();
  const token = randomBytes(16).toString("base64url");
  const tokenId = uuidv7();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
  await db.insert(resumeToken).values({
    id: tokenId,
    applicationId: input.applicationId,
    tokenHash: hashToken(token),
    issuedVia: input.issuedVia,
    messageId: input.messageId ?? null,
    expiresAt,
    createdAt: now,
  });
  return { tokenId, token, expiresAt };
}

export type VerifiedToken = { tokenId: string; applicationId: string; expiresAt: Date };

// Exchanges a token for its application and slides the expiry forward. Returns
// null for an unknown, revoked or expired token.
export async function verifyResumeToken(db: Db, token: string, now: Date = new Date()): Promise<VerifiedToken | null> {
  if (!token || token.length > 64) return null;
  const hash = hashToken(token);
  const [row] = await db.select().from(resumeToken).where(eq(resumeToken.tokenHash, hash)).limit(1);
  if (!row) return null;
  // The unique index already matched the hash; the constant-time compare is belt and braces.
  if (!timingSafeEqual(Buffer.from(row.tokenHash), hash)) return null;
  if (row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return null;

  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
  await db.update(resumeToken).set({ lastUsedAt: now, expiresAt }).where(eq(resumeToken.id, row.id));
  return { tokenId: row.id, applicationId: row.applicationId, expiresAt };
}

// Staff "revoke and resend": every live token of the application dies at once.
export async function revokeApplicationTokens(
  db: Db,
  input: { applicationId: string; revokedBy: string | null; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(resumeToken)
    .set({ revokedAt: now, revokedBy: input.revokedBy })
    .where(and(eq(resumeToken.applicationId, input.applicationId), isNull(resumeToken.revokedAt)))
    .returning({ id: resumeToken.id });
  return rows.length;
}
