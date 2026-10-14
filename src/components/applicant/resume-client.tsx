"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ExpiredLink } from "./screens";

// Reads the token after "#" (which browsers never send to the server), posts it
// once, and continues to /apply with the cookie set. The address bar loses the
// token as soon as the server has answered.

type State = "working" | "expired" | "offline";

export function ResumeClient() {
  const [state, setState] = useState<State>("working");
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const token = window.location.hash.slice(1);
    const exchange: Promise<"ok" | "expired" | "offline"> = token
      ? fetch("/api/applicant/resume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
          credentials: "same-origin",
          cache: "no-store",
        })
          .then((response) => (response.ok ? "ok" : response.status === 401 ? "expired" : "offline"))
          .catch(() => "offline" as const)
      : Promise.resolve("expired" as const);
    void exchange.then((result) => {
      if (cancelled) return;
      if (result === "ok") {
        window.history.replaceState(null, "", "/r");
        window.location.replace("/apply");
        return;
      }
      if (result === "expired") window.history.replaceState(null, "", "/r");
      setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [tries]);

  if (state === "expired") return <ExpiredLink />;
  if (state === "offline") {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">We could not open your application</h1>
        <p className="text-muted-foreground">Check your connection and try again.</p>
        <Button type="button" className="h-12 w-full text-base" onClick={() => setTries((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3" role="status">
      <h1 className="text-2xl font-semibold tracking-tight">Opening your application</h1>
      <p className="text-muted-foreground">One moment while we find your saved answers.</p>
    </div>
  );
}
