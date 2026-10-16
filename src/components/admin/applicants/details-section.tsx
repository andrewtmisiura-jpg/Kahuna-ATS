"use client";

import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { SOURCES, sourceKey, sourceTakesDetail, type SourceKey } from "@/components/applicant/sources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setApplicationSession, setIndeedAppliedOn, updateApplicationSource } from "@/server/actions/admin/applications";
import type { Profile } from "@/server/services/applications/queries";
import { ArrivalSelect } from "./arrival-select";
import { ActionNotice, Field, NativeSelect } from "./fields";
import { ENTRY_CHANNEL_LABELS, formatCalendarDate, formatDateTime } from "./format";
import { Rows, Section } from "./section";
import { useAdminAction } from "./use-admin-action";

// Source, entry code, session, group interview arrival, text reply speed, origin,
// form version, times and the Indeed apply date. Staff can change how they heard
// about us, the attributed group session and the arrival; each change is audited.

// The applicant-facing labels, so staff pick from the same list the applicant saw.
export function sourceLabel(source: string | null): string | null {
  return source ? (SOURCES.find((s) => s.key === source)?.label ?? source) : null;
}

const ATTRIBUTION_LABELS: Record<Profile["application"]["attributionMethod"], string> = {
  none: "",
  scanned_session: "scanned the session QR",
  phone_match: "matched by phone",
  staff_confirmed: "set by staff",
};

export function DetailsSection({ profile, canAct }: { profile: Profile; canAct: boolean }) {
  const { application: app } = profile;
  const [date, setDate] = useState(app.indeedAppliedOn ?? "");
  const [editing, setEditing] = useState<"source" | "session" | null>(null);
  const { run, pending, failure } = useAdminAction();
  const heard = sourceLabel(app.source);

  return (
    <Section title="Details">
      <Rows
        items={[
          {
            label: "How they heard",
            value:
              editing === "source" ? (
                <SourceEditor application={app} onDone={() => setEditing(null)} />
              ) : (
                <EditableValue canAct={canAct} onEdit={() => setEditing("source")} editLabel="Change how they heard">
                  {heard ? `${heard}${app.sourceDetail ? ` (${app.sourceDetail})` : ""}` : null}
                </EditableValue>
              ),
          },
          { label: "Entry code", value: app.entryCode ? `${app.entryCode} ${app.entryCodeLabel ?? ""}` : null },
          { label: "Came in through", value: ENTRY_CHANNEL_LABELS[app.entryChannel] ?? app.entryChannel },
          {
            label: "Group session",
            value:
              editing === "session" ? (
                <SessionEditor application={app} sessions={profile.sessions} onDone={() => setEditing(null)} />
              ) : (
                <EditableValue canAct={canAct} onEdit={() => setEditing("session")} editLabel="Change group session">
                  {app.session ? (
                    <span>
                      <Link href={`/admin/sessions/${app.session.id}` as Route} className="underline underline-offset-4">
                        {formatDateTime(app.session.startsAt)}, {app.session.locationName}
                      </Link>
                      {app.session.status === "canceled" ? " (canceled)" : ""}
                      {ATTRIBUTION_LABELS[app.attributionMethod] ? (
                        <span className="text-muted-foreground"> ({ATTRIBUTION_LABELS[app.attributionMethod]})</span>
                      ) : null}
                    </span>
                  ) : null}
                </EditableValue>
              ),
          },
          {
            label: "Group interview arrival",
            value: (
              <ArrivalSelect key={app.groupInterviewArrival ?? "none"} applicationId={app.id} value={app.groupInterviewArrival} canAct={canAct} />
            ),
          },
          {
            label: "Text reply speed",
            value: (
              <span className="grid gap-0.5">
                <span>{profile.replySpeed.label}</span>
                <span className="text-xs text-muted-foreground">Email replies go to the hiring inbox and are not counted.</span>
              </span>
            ),
          },
          { label: "Started", value: formatDateTime(app.startedAt) },
          { label: "Submitted", value: app.submittedAt ? formatDateTime(app.submittedAt) : <span className="text-muted-foreground">not yet</span> },
          { label: "Last activity", value: formatDateTime(app.lastActivityAt) },
          { label: "Origin", value: app.origin.replace("_", " ") },
          { label: "Form version", value: `v${app.formVersion}` },
          ...(app.excludeFromAnalysis ? [{ label: "Reports", value: "Left out of analysis (current employee)" }] : []),
          {
            label: "Indeed apply date",
            value: canAct ? (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(() => setIndeedAppliedOn({ applicationId: app.id, date: date || null }));
                }}
              >
                <Input type="date" className="h-8 w-auto" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Indeed apply date" />
                <Button type="submit" size="xs" variant="outline" disabled={pending || (date || null) === app.indeedAppliedOn}>
                  Save
                </Button>
              </form>
            ) : (
              formatCalendarDate(app.indeedAppliedOn) || null
            ),
          },
        ]}
      />
      <ActionNotice failure={failure} className="mt-2" />
    </Section>
  );
}

// A value with a small Change button for staff; "none" when empty.
function EditableValue({ children, canAct, onEdit, editLabel }: { children: React.ReactNode; canAct: boolean; onEdit: () => void; editLabel: string }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {children ?? <span className="text-muted-foreground">none</span>}
      {canAct ? (
        <Button type="button" size="xs" variant="outline" onClick={onEdit} aria-label={editLabel}>
          Change
        </Button>
      ) : null}
    </span>
  );
}

function SourceEditor({ application, onDone }: { application: Profile["application"]; onDone: () => void }) {
  const [source, setSource] = useState<SourceKey | "">(sourceKey(application.source) ?? "");
  const [detail, setDetail] = useState(application.sourceDetail ?? "");
  const { run, pending, failure } = useAdminAction();
  const takesDetail = sourceTakesDetail(source || null);

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            updateApplicationSource({
              applicationId: application.id,
              source: source || null,
              sourceDetail: takesDetail ? detail.trim() || null : null,
            }),
          onDone,
        );
      }}
    >
      <Field label="How did you hear about us?">
        <NativeSelect value={source} onChange={(e) => setSource(e.target.value as SourceKey | "")}>
          <option value="">Not given</option>
          {SOURCES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {takesDetail ? (
        <Field label={source === "referral" ? "Who referred them?" : "Other (what they said)"}>
          <Input value={detail} maxLength={200} onChange={(e) => setDetail(e.target.value)} />
        </Field>
      ) : null}
      {source === "current_employee" ? <p className="text-xs text-muted-foreground">Current employees are left out of the reports.</p> : null}
      <ActionNotice failure={failure} />
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SessionEditor({ application, sessions, onDone }: { application: Profile["application"]; sessions: Profile["sessions"]; onDone: () => void }) {
  const [sessionId, setSessionId] = useState(application.session?.id ?? "");
  const { run, pending, failure } = useAdminAction();
  // Canceled sessions are not offered, except the one already attributed.
  const choices = sessions.filter((s) => s.status !== "canceled" || s.id === application.session?.id);

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => setApplicationSession({ applicationId: application.id, sessionId: sessionId || null }), onDone);
      }}
    >
      <Field label="Attributed session" hint="For someone who scanned the role QR at a group session instead of the session's own code.">
        <NativeSelect value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
          <option value="">No session</option>
          {choices.map((s) => (
            <option key={s.id} value={s.id}>
              {formatDateTime(s.startsAt)}, {s.locationName}
              {s.status === "canceled" ? " (canceled)" : ""}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {choices.length === 0 ? <p className="text-xs text-muted-foreground">This opening has no group sessions yet. Add them under Sessions.</p> : null}
      <ActionNotice failure={failure} />
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
