import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Optimistic redirect only: a request to a staff page (the admin pages, the guides and
// the door check-in kiosk) without a session cookie is sent to sign-in, except a kiosk
// page on a tablet holding the kiosk's own cookie (sessions/kiosk.ts, KIOSK_COOKIE).
// Real access control is requireRole, or the kiosk check, in every action and handler.
//
// Applicant pages get their response headers here: never indexed, never a
// referrer, and a per-route Content-Security-Policy with a fresh nonce. Only the
// landing and lost-link pages may load the Turnstile script (DATA_MODEL.md,
// resume_token: "a per-route CSP allows challenges.cloudflare.com only on the
// landing and lost-link pages").
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPage(pathname)) return publicPageResponse(request, pathname);
  if (pathname === "/admin/sign-in") return NextResponse.next();

  const devBypass = process.env.NODE_ENV !== "production" && Boolean(process.env.DEV_AUTH_EMAIL);
  if (devBypass || getSessionCookie(request)) return NextResponse.next();
  if (pathname.startsWith("/check-in/") && request.cookies.has("kahuna_check_in")) return NextResponse.next();

  const signIn = new URL("/admin/sign-in", request.url);
  signIn.searchParams.set("next", pathname);
  return NextResponse.redirect(signIn);
}

const PUBLIC_PAGES = ["/", "/apply", "/r", "/lost-link", "/privacy", "/sms-terms", "/text-messages"];
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

function isPublicPage(pathname: string) {
  return PUBLIC_PAGES.includes(pathname) || pathname.startsWith("/q/");
}

function publicPageResponse(request: NextRequest, pathname: string) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const turnstile = pathname === "/lost-link" || pathname.startsWith("/q/");
  // React needs eval for its development-only error stacks; HMR talks over a websocket.
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}${dev ? " ws: wss:" : ""}`,
    `frame-src ${turnstile ? TURNSTILE_ORIGIN : "'none'"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  // Next reads the nonce from the request's CSP header and puts it on its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("cache-control", "no-store");
  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/help", "/check-in/:path*", "/", "/q/:path*", "/apply", "/r", "/lost-link", "/privacy", "/sms-terms", "/text-messages"],
};
