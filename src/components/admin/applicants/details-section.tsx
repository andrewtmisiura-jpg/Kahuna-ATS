"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setIndeedAppliedOn } from "@/server/actions/admin/applications";
import type { Profile } from "@/server/services/applications/queries";
import { ActionNotice } from "./fields";
import { ENTRY_CHANNEL_LABELS, formatCalendarDate, formatDateTime, SOURCE_LABELS } from "./format";
import { Rows, Section } from "./section";
import { useAdminAction } from "./use-admin-action";

// Source, entry code, session, origin, form version, times and the Indeed apply date.

export function DetailsSection({ profile, canAct }: { profile: Profile; canAct: boolean }) {
  const { application: app } = profile;
  const [date, setDate] = useState(app.indeedAppliedOn ?? "");
  const { run, pending, failure } = useAdminAction();
  return (
    <Section title="Details">
      <Rows
        items={[
          { label: "How they heard", value: app.source ? `${SOURCE_LABELS[app.source] ?? app.source}${app.sourceDetail ? ` (${app.sourceDetail})` : ""}` : null },
          { label: "Entry code", value: app.entryCode ? `${app.entryCode} ${app.entryCodeLabel ?? ""}` : null },
          { label: "Came in through", value: ENTRY_CHANNEL_LABELS[app.entryChannel] ?? app.entryChannel },
          { label: "Group session", value: app.sessionLabel },
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
                <Input type="date" className="h-8 w-auto" value={date} onChange={(e) => setDate(e.target.value)} />
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
