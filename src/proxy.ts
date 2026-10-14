import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Optimistic redirect only: a request to a staff page without a session cookie is
// sent to sign-in. Real access control is requireRole in every action and handler.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/admin/sign-in") return NextResponse.next();

  const devBypass = process.env.NODE_ENV !== "production" && Boolean(process.env.DEV_AUTH_EMAIL);
  if (devBypass || getSessionCookie(request)) return NextResponse.next();

  const signIn = new URL("/admin/sign-in", request.url);
  signIn.searchParams.set("next", pathname);
  return NextResponse.redirect(signIn);
}

export const config = {
  matcher: ["/admin/:path*", "/help"],
};
