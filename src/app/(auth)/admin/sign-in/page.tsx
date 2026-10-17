import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { isGoogleSignInConfigured } from "@/server/auth/auth";
import { devBypassUser } from "@/server/auth/session";
import { GoogleSignInButton } from "./google-sign-in-button";

export const metadata: Metadata = { title: "Sign in | Tidepool" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const bypass = devBypassUser();
  const callbackURL = next?.startsWith("/admin") || next === "/help" || next?.startsWith("/check-in/") ? next : "/admin";

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Tidepool</CardTitle>
          <CardDescription>Kahuna Window Cleaning hiring. Staff only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              Sign-in refused. Ask an admin to add you.
            </p>
          ) : null}
          {bypass ? (
            <>
              <p className="text-sm text-muted-foreground">
                Development sign-in is on for <span className="font-medium">{bypass.email}</span>.
              </p>
              <Button asChild className="w-full">
                <Link href="/admin">Open Tidepool</Link>
              </Button>
            </>
          ) : isGoogleSignInConfigured() ? (
            <GoogleSignInButton callbackURL={callbackURL} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or
              DEV_AUTH_EMAIL for local development.
            </p>
          )}
        </CardContent>
        <CardFooter className="text-xs text-muted-foreground">
          Sign in with the Google account an admin added in Settings &gt; Users.
        </CardFooter>
      </Card>
    </div>
  );
}
