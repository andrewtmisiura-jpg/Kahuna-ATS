"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { markInboundTextHandled } from "@/server/actions/admin/applications";
import type { ProfileMessage } from "@/server/services/applications/queries";
import { ActionNotice } from "./fields";
import { CANCELED_REASONS, formatDateTime, MESSAGE_STATUS_LABELS, PURPOSE_LABELS, SUPPRESSED_REASONS } from "./format";
import { Empty, Section } from "./section";
import { useAdminAction } from "./use-admin-action";

// Texts and emails in and out as one thread with status; inbound texts carry
// "Mark handled" until a person has dealt with them.

// `unhandled` is the profile's count from the inbox service, the same rule the
// list's attention strip and the daily digest use.
export function MessagesThread({ messages, unhandled, canAct }: { messages: ProfileMessage[]; unhandled: number; canAct: boolean }) {
  const { run, pending, failure } = useAdminAction();
  return (
    <Section title="Messages" action={unhandled > 0 ? <Badge variant="secondary">{unhandled} unhandled</Badge> : null}>
      {messages.length === 0 ? <Empty>No messages yet.</Empty> : null}
      <ol className="grid gap-2">
        {messages.map((m) => {
          const inbound = m.direction === "inbound";
          const bad = m.status === "failed" || m.status === "undelivered" || m.status === "unknown";
          return (
            <li key={m.id} className={`rounded-md border p-3 ${inbound ? "border-sky-200 bg-sky-50/60" : ""} ${bad ? "border-red-300" : ""}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {inbound ? "From applicant" : m.triggeredByType === "staff" ? `To applicant (${m.triggeredByName ?? "staff"})` : "To applicant (automatic)"}
                </span>
                <span>{m.channel === "sms" ? "Text" : "Email"}</span>
                {m.purpose ? <span>{PURPOSE_LABELS[m.purpose] ?? m.purpose}</span> : null}
                <span>{formatDateTime(m.sentAt ?? m.createdAt)}</span>
                <Badge variant={bad ? "destructive" : "outline"}>
                  {MESSAGE_STATUS_LABELS[m.status] ?? m.status}
                  {m.status === "suppressed" && m.errorCode ? `: ${SUPPRESSED_REASONS[m.errorCode] ?? m.errorCode}` : ""}
                  {m.status === "canceled" && m.errorCode ? `: ${CANCELED_REASONS[m.errorCode] ?? m.errorCode}` : ""}
                </Badge>
                {m.status === "queued" && m.sendAfter ? <span>will send at {formatDateTime(m.sendAfter)}</span> : null}
                {m.deliveredAt ? <span>delivered {formatDateTime(m.deliveredAt)}</span> : null}
              </div>
              {m.subject ? <p className="mt-1 text-sm font-medium">{m.subject}</p> : null}
              {m.body !== null ? <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p> : <p className="mt-1 text-xs text-muted-foreground">Message text is hidden for Viewers.</p>}
              {inbound ? (
                <div className="mt-2 flex items-center gap-2 text-xs">
                  {m.handledAt ? (
                    <span className="text-muted-foreground">
                      Handled {formatDateTime(m.handledAt)}
                      {m.handledByName ? ` by ${m.handledByName}` : ""}
                    </span>
                  ) : canAct ? (
                    <Button size="xs" variant="outline" disabled={pending} onClick={() => run(() => markInboundTextHandled({ messageId: m.id }))}>
                      Mark handled
                    </Button>
                  ) : (
                    <span className="text-muted-foreground">Not handled yet</span>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <ActionNotice failure={failure} className="mt-2" />
      <p className="mt-3 text-xs text-muted-foreground">Answer texts in the Quo app on the hiring number; your reply shows up here. Then mark the text handled.</p>
    </Section>
  );
}
