"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { updateTextingAction } from "@/server/actions/admin/settings";
import type { TextingSettings } from "@/server/services/config/texting";
import { CheckboxField, Field, Notice } from "./fields";

export function TextingForm({ settings }: { settings: TextingSettings }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cap = String(form.get("dailySendCap") ?? "").trim();
    startTransition(async () => {
      setError(null);
      setSaved(false);
      const result = await updateTextingAction({
        smsEnabled: form.get("smsEnabled") === "on",
        helpContact: String(form.get("helpContact") ?? "").trim() || null,
        dailySendCap: cap === "" ? Number.NaN : Number(cap),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Hiring number</CardTitle>
          <CardDescription>Every text goes out from this number and nowhere else.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="text-2xl font-semibold tabular-nums">{formatPhone(settings.smsFromE164)}</div>
          {settings.quoConnected ? (
            <Notice>Connected to Quo. The phone number id is stored, so texts can go out while texting is on.</Notice>
          ) : (
            <Notice tone="warning">
              Not connected to Quo yet: the phone number id is empty and no text can go out, whatever the switch below says. Once the Quo API
              key is in Railway, run <code className="rounded bg-muted px-1">pnpm quo:connect</code> to look the number up and store its id.
            </Notice>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Texting</CardTitle>
          <CardDescription>Turn texting off here if the real-phone test fails or whenever you need to. Email keeps going either way.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <CheckboxField
            name="smsEnabled"
            label="Texting is on"
            defaultChecked={settings.smsEnabled}
            hint="Off: a message that would have been a text goes by email instead, or is marked suppressed when the person has no email."
          />
          <Field
            label="Help contact"
            htmlFor="helpContact"
            hint="Shown on applicant pages, in templates as {help_contact} and in the automatic HELP reply."
          >
            <Input id="helpContact" name="helpContact" defaultValue={settings.helpContact ?? ""} placeholder="763-292-2259 (call or text) or hiring@..." />
          </Field>
          <Field
            label="Daily send cap"
            htmlFor="dailySendCap"
            hint="Texts and emails per Central day across everyone. At the cap, the rest wait for tomorrow and you get one alert. Default 200."
          >
            <Input id="dailySendCap" name="dailySendCap" type="number" min={1} max={5000} step={1} defaultValue={settings.dailySendCap} className="w-40" />
          </Field>
        </CardContent>
      </Card>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {saved && !error ? <Notice>Saved.</Notice> : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function formatPhone(e164: string | null): string {
  if (!e164) return "Not set";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : e164;
}
