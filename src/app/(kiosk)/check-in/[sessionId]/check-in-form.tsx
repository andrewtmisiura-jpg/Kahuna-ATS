"use client";

import { CircleCheck } from "lucide-react";
import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkInAction } from "@/server/actions/kiosk/check-in";

// The door check-in form on a tablet passed from person to person: big fields, no
// autofill (the next person must never see the last one's name or number), a
// thank-you that clears itself after five seconds, and nothing about anyone else.

const RESET_MS = 5000;

export function CheckInForm({ sessionId }: { sessionId: string }) {
  const nameId = useId();
  const mobileId = useId();
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [error, setError] = useState<{ field: "name" | "mobile" | null; message: string } | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (thanks === null) return;
    const timer = setTimeout(() => setThanks(null), RESET_MS);
    return () => clearTimeout(timer);
  }, [thanks]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      setError(null);
      const result = await checkInAction({ sessionId, name, mobile });
      if (!result.ok) {
        setError({ field: result.field, message: result.message });
        return;
      }
      setName("");
      setMobile("");
      setThanks(result.firstName ? `Thanks, ${result.firstName}.` : "Thanks.");
    });
  }

  if (thanks !== null) {
    return (
      <div role="status" className="grid justify-items-center gap-4 py-10 text-center">
        <CircleCheck aria-hidden className="size-16 text-emerald-600" />
        <p className="text-3xl font-semibold tracking-tight">{thanks}</p>
        <p className="text-xl">You&apos;re checked in. Have a seat and we&apos;ll start soon.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} autoComplete="off" className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Welcome.</h1>
        <p className="text-xl">Enter your name and mobile number to check in.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={nameId} className="text-lg">
          Your name
        </Label>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          maxLength={120}
          aria-invalid={error?.field === "name" || undefined}
          className="h-14 text-xl md:text-xl"
        />
        {error?.field === "name" ? <p className="text-base text-destructive">{error.message}</p> : null}
      </div>
      <div className="grid gap-2">
        <Label htmlFor={mobileId} className="text-lg">
          Mobile number
        </Label>
        <Input
          id={mobileId}
          type="tel"
          inputMode="tel"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          autoComplete="off"
          maxLength={40}
          aria-invalid={error?.field === "mobile" || undefined}
          className="h-14 text-xl md:text-xl"
        />
        {error?.field === "mobile" ? <p className="text-base text-destructive">{error.message}</p> : null}
        <p className="text-sm text-muted-foreground">We use your number only to match you with your application.</p>
      </div>
      {error && error.field === null ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-base text-destructive">
          {error.message}
        </p>
      ) : null}
      <Button type="submit" className="h-14 text-xl" disabled={pending}>
        {pending ? "Checking in" : "Check in"}
      </Button>
    </form>
  );
}
