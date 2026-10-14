"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Field, NativeSelect, Notice, Textarea } from "@/components/admin/settings/fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createSessionAction, updateSessionAction } from "@/server/actions/admin/settings";

export type SessionOpeningOption = { id: string; name: string; roleName: string; status: string };

export type SessionFormValues = {
  id: string;
  openingId: string;
  startsAt: Date;
  locationName: string;
  locationAddress: string | null;
  invitedCount: number | null;
  attendedCount: number | null;
  notes: string | null;
  status: "scheduled" | "held" | "canceled";
  hasApplicants: boolean;
};

// The datetime-local value for an instant in the browser's own zone. Staff are in
// Central; the browser converts back to an instant on submit.
function toLocalInput(instant: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}

export function SessionFormDialog({
  openings,
  session,
  onClose,
}: {
  openings: SessionOpeningOption[];
  // Omitted to create, present to edit.
  session?: SessionFormValues;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const openingChoices = session && !openings.some((o) => o.id === session.openingId)
    ? [{ id: session.openingId, name: "Current opening (closed)", roleName: "", status: "closed" }, ...openings]
    : openings;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const count = (name: string) => (text(name) === "" ? null : Number(text(name)));
    const local = text("startsAt");
    const startsAt = local ? new Date(local) : new Date(Number.NaN);
    if (Number.isNaN(startsAt.getTime())) {
      setError("Enter the date and time");
      return;
    }
    const fields = {
      openingId: text("openingId"),
      startsAt: startsAt.toISOString(),
      locationName: text("locationName"),
      locationAddress: text("locationAddress") || null,
      invitedCount: count("invitedCount"),
      attendedCount: count("attendedCount"),
      notes: text("notes") || null,
    };
    startTransition(async () => {
      setError(null);
      if (session) {
        const result = await updateSessionAction({
          id: session.id,
          patch: { ...fields, status: text("status") as SessionFormValues["status"] },
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
        onClose();
      } else {
        const result = await createSessionAction(fields);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.push(`/admin/sessions/${result.data.id}`);
        router.refresh();
        onClose();
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{session ? "Edit session" : "New group session"}</DialogTitle>
          <DialogDescription>
            {session
              ? "Times are shown in your phone's time zone."
              : "The session gets its own QR code the moment it is saved, ready to download and print."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field
            label="Opening"
            htmlFor="openingId"
            hint={session?.hasApplicants ? "Locked: applicants are already attributed to this session." : undefined}
          >
            <NativeSelect id="openingId" name="openingId" defaultValue={session?.openingId ?? openings[0]?.id ?? ""} disabled={session?.hasApplicants} required>
              {openingChoices.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.status === "draft" ? " (draft)" : ""}
                </option>
              ))}
            </NativeSelect>
            {session?.hasApplicants ? <input type="hidden" name="openingId" value={session.openingId} /> : null}
          </Field>
          <Field label="Date and time" htmlFor="startsAt">
            <Input id="startsAt" name="startsAt" type="datetime-local" required defaultValue={session ? toLocalInput(session.startsAt) : ""} />
          </Field>
          <Field label="Location" htmlFor="locationName">
            <Input id="locationName" name="locationName" required defaultValue={session?.locationName ?? ""} placeholder="Golden Valley shop" />
          </Field>
          <Field label="Address" htmlFor="locationAddress" hint="Optional.">
            <Input id="locationAddress" name="locationAddress" defaultValue={session?.locationAddress ?? ""} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Invited" htmlFor="invitedCount" hint="How many Indeed says are coming.">
              <Input id="invitedCount" name="invitedCount" type="number" min={0} step={1} inputMode="numeric" defaultValue={session?.invitedCount ?? ""} />
            </Field>
            <Field label="Attended" htmlFor="attendedCount" hint="Headcount from the sign-up sheet, after the day.">
              <Input id="attendedCount" name="attendedCount" type="number" min={0} step={1} inputMode="numeric" defaultValue={session?.attendedCount ?? ""} />
            </Field>
          </div>
          {session ? (
            <Field label="Status" htmlFor="status">
              <NativeSelect id="status" name="status" defaultValue={session.status}>
                <option value="scheduled">Scheduled</option>
                <option value="held">Held</option>
                <option value="canceled">Canceled</option>
              </NativeSelect>
            </Field>
          ) : null}
          <Field label="Notes" htmlFor="notes" hint="Room, parking, who is presenting. Not for anything about an applicant.">
            <Textarea id="notes" name="notes" rows={3} defaultValue={session?.notes ?? ""} />
          </Field>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving" : session ? "Save" : "Create session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
