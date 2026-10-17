"use client";

import { Send } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { sendMessageAction } from "@/server/actions/admin/messages";
import type { SendOption } from "@/server/services/messaging/staff-sends";
import { ActionNotice } from "../fields";
import { useAdminAction } from "../use-admin-action";
import { MessagePreviewCard } from "./message-preview";

// "Send a message" on the profile: pick the invite, a status update or the decline, see
// it filled in with this person's values, and queue it. Templates only: content/legal/
// messages.md has staff send these as written, so there is nothing to type here.

const CHOICES: Record<SendOption["purpose"], { label: string; hint: string }> = {
  one_on_one_invite: { label: "One-on-one invite", hint: "Asks them to pick an interview time with the booking link." },
  status_update: { label: "Status update", hint: "Points them to their status page to see where things stand." },
  decline: { label: "Decline", hint: "Thanks them and says we won't move forward. No reasons." },
};

export function SendMessageDialog({ applicationId, options }: { applicationId: string; options: SendOption[] }) {
  // A fresh id each time the dialog opens, so a double click or a retry queues one message.
  const [requestId, setRequestId] = useState<string | null>(null);
  return (
    <>
      <Button className="min-h-11 md:min-h-9" onClick={() => setRequestId(crypto.randomUUID())}>
        <Send />
        Send a message
      </Button>
      <Dialog open={requestId !== null} onOpenChange={(open) => (open ? null : setRequestId(null))}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          {requestId ? <SendForm applicationId={applicationId} options={options} requestId={requestId} onClose={() => setRequestId(null)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SendForm({ applicationId, options, requestId, onClose }: { applicationId: string; options: SendOption[]; requestId: string; onClose: () => void }) {
  const [purpose, setPurpose] = useState(options.find((o) => !o.problem)?.purpose ?? options[0]!.purpose);
  const { run, pending, failure } = useAdminAction();
  const name = useId();
  const option = options.find((o) => o.purpose === purpose)!;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(() => sendMessageAction({ applicationId, purpose, requestId }), onClose);
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Send a message</DialogTitle>
        <DialogDescription>It goes out exactly as the template says. To change the wording, an Admin edits it in Settings, Message templates.</DialogDescription>
      </DialogHeader>

      <div role="radiogroup" aria-label="Message" className="grid gap-2">
        {options.map((o) => (
          <label key={o.purpose} className="flex min-h-11 items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary">
            <input type="radio" name={name} className="mt-1" checked={purpose === o.purpose} onChange={() => setPurpose(o.purpose)} />
            <span>
              <span className="font-medium">{CHOICES[o.purpose].label}</span>
              <span className="block text-xs text-muted-foreground">{CHOICES[o.purpose].hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="grid gap-2">
        <p className="text-sm font-medium">What they get</p>
        <MessagePreviewCard preview={option} />
      </div>
      <p className="text-xs text-muted-foreground">It shows in Messages on this profile right away and goes out within 5 minutes.</p>

      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} className="min-h-11 md:min-h-9">
          Cancel
        </Button>
        <Button type="submit" disabled={pending || Boolean(option.problem)} className="min-h-11 md:min-h-9">
          {pending ? "Sending" : "Send"}
        </Button>
      </DialogFooter>
    </form>
  );
}
