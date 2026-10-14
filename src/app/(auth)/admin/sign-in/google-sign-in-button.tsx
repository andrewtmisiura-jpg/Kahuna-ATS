"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function GoogleSignInButton({ callbackURL }: { callbackURL: string }) {
  const [pending, setPending] = useState(false);

  async function signIn() {
    setPending(true);
    await authClient.signIn.social({
      provider: "google",
      callbackURL,
      errorCallbackURL: "/admin/sign-in?error=refused",
    });
    setPending(false);
  }

  return (
    <Button className="w-full" onClick={signIn} disabled={pending}>
      {pending ? "Redirecting to Google" : "Sign in with Google"}
    </Button>
  );
}
