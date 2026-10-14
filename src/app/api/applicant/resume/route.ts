import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { mintApplicantCookie } from "@/server/actions/applicant/session";
import { verifyResumeToken } from "@/server/services/tokens";

// The /r page posts the token from the URL fragment here once. A live token
// becomes an HttpOnly cookie bound to the application; anything else is refused
// without saying why. Never cached, never logged.

export const dynamic = "force-dynamic";

const body = z.object({ token: z.string().min(1).max(64) });

export async function POST(request: Request) {
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
  let parsed: z.infer<typeof body> | null = null;
  try {
    parsed = body.parse(await request.json());
  } catch {
    return NextResponse.json({ ok: false }, { status: 400, headers });
  }

  const verified = await verifyResumeToken(db, parsed.token);
  if (!verified) return NextResponse.json({ ok: false }, { status: 401, headers });

  const cookie = await mintApplicantCookie(verified.applicationId);
  const response = NextResponse.json({ ok: true }, { headers });
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
