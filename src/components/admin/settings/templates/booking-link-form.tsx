"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { setBookingLinkAction } from "@/server/actions/admin/templates";
import { Field, Notice } from "../fields";

// The one-on-one booking link that invites carry as {booking_link}. Admins change it;
// everyone else sees it. The service accepts only an https:// address.
export function BookingLinkForm({ url, canEdit }: { url: string | null; canEdit: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("bookingLinkUrl") ?? "");
    startTransition(async () => {
      setError(null);
      setSaved(false);
      const result = await setBookingLinkAction({ url: value.trim() || null });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>One-on-one booking link</CardTitle>
        <CardDescription>The link applicants use to pick an interview time. The invite carries it as {"{booking_link}"}.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!url ? <Notice tone="warning">No booking link yet, so invites cannot go out. Paste the link from your scheduling tool.</Notice> : null}
        {canEdit ? (
          <form onSubmit={submit} className="grid gap-3">
            <Field label="Booking link" htmlFor="bookingLinkUrl" hint="Starts with https://. Leave it empty to remove it.">
              <Input
                id="bookingLinkUrl"
                name="bookingLinkUrl"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                defaultValue={url ?? ""}
                placeholder="https://"
                className="h-11 md:h-9"
              />
            </Field>
            {error ? <Notice tone="error">{error}</Notice> : null}
            {saved && !error ? <Notice>Saved.</Notice> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={pending} className="min-h-11 md:min-h-9">
                {pending ? "Saving" : "Save link"}
              </Button>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-4">
                  Open it to check
                </a>
              ) : null}
            </div>
          </form>
        ) : (
          <p className="break-all text-sm">{url ?? "Not set yet. An Admin adds it here."}</p>
        )}
      </CardContent>
    </Card>
  );
}
