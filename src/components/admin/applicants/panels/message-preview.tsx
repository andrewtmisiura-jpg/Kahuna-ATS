"use client";

import { useEffect, useState } from "react";
import { MessageBody, segmentLine } from "@/components/admin/settings/templates/message-body";
import { previewMessageAction } from "@/server/actions/admin/messages";
import type { SendPreview } from "@/server/services/messaging/staff-sends";
import type { StaffSendPurpose } from "@/server/services/messaging/template-text";
import { formatMobile } from "../format";

// The message a send would queue right now, as the Move, Close and Send a message
// dialogs show it: who it goes to and how, the text filled in with this person's values,
// and the reason it cannot go when it cannot.

type Loaded = { key: string; preview: SendPreview | null; error: string | null };

// Loads the preview while applicationId is set; null means "not offered here".
export function useMessagePreview(applicationId: string | null, purpose: StaffSendPurpose): { preview: SendPreview | null; error: string | null } | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = applicationId ? `${applicationId}:${purpose}` : null;
  useEffect(() => {
    if (!applicationId) return;
    const loadedKey = `${applicationId}:${purpose}`;
    let alive = true;
    previewMessageAction({ applicationId, purpose })
      .then((result) => (result.ok ? { key: loadedKey, preview: result.data, error: null } : { key: loadedKey, preview: null, error: result.message }))
      .catch(() => ({ key: loadedKey, preview: null, error: "The message could not be loaded. Check your connection and try again." }))
      .then((next) => {
        if (alive) setLoaded(next);
      });
    return () => {
      alive = false;
    };
  }, [applicationId, purpose]);
  return key && loaded?.key === key ? { preview: loaded.preview, error: loaded.error } : null;
}

export function MessagePreviewCard({ preview }: { preview: SendPreview }) {
  return (
    <div className="grid gap-2">
      {preview.channel ? (
        <p className="text-sm">
          <span className="font-medium">{preview.channel === "sms" ? "Text" : "Email"}</span> to{" "}
          {preview.channel === "sms" ? formatMobile(preview.to) : preview.to}
          {preview.note ? <span className="block text-xs text-muted-foreground">{preview.note}</span> : null}
        </p>
      ) : null}
      {preview.problem ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {preview.problem}
        </p>
      ) : null}
      {preview.channel && preview.body !== null ? <MessageBody channel={preview.channel} subject={preview.subject} body={preview.body} /> : null}
      {preview.channel === "sms" && preview.characters !== null && preview.segments !== null ? (
        <p className="text-xs text-muted-foreground">
          {segmentLine(preview.characters, preview.segments)}. Texts wait for 9am to 8pm Central; if it is their first text since opting in, the
          longer closing is used.
        </p>
      ) : null}
    </div>
  );
}
