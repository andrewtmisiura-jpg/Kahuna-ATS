"use client";

import { Tablet } from "lucide-react";
import { useState, useTransition } from "react";
import { ActionNotice } from "@/components/admin/applicants/fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authClient } from "@/lib/auth-client";
import type { ActionFailure } from "@/server/actions/admin/application-errors";
import { startCheckInAction } from "@/server/actions/admin/attendees";
import { TAP } from "./format";

// "Door check-in" (Phase 2, sessions): turns this device into the session's check-in
// kiosk. The device gets its own credential for this one check-in, the staff member is
// signed out on it, and the kiosk loads in this page's place in the history, so nobody
// at the door can go Back to the list of who came or open anything else.
export function StartCheckInButton({ sessionId, variant = "outline" }: { sessionId: string; variant?: "outline" | "default" }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<ActionFailure | null>(null);

  function start() {
    setFailure(null);
    startTransition(async () => {
      const started = await startCheckInAction({ sessionId });
      if (!started.ok) {
        setFailure(started);
        return;
      }
      const signedOut = await authClient.signOut();
      if (signedOut.error) {
        setFailure({ ok: false, status: 500, code: "sign_out_failed", message: "You could not be signed out on this device, so check-in did not start. Try again." });
        return;
      }
      window.location.replace(started.data.url);
    });
  }

  return (
    <>
      <Button variant={variant} className={TAP} onClick={() => setOpen(true)}>
        <Tablet />
        Door check-in
      </Button>
      <Dialog open={open} onOpenChange={(next) => (pending ? null : setOpen(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start door check-in on this device?</DialogTitle>
            <DialogDescription>
              Use the tablet you will hand to people as they arrive. You are signed out on it first, so it can only check people in to this
              session until the end of the day. Sign in again when check-in is over.
            </DialogDescription>
          </DialogHeader>
          <ActionNotice failure={failure} />
          <DialogFooter>
            <Button type="button" variant="outline" className={TAP} onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" className={TAP} onClick={start} disabled={pending}>
              {pending ? "Starting" : "Start check-in"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
