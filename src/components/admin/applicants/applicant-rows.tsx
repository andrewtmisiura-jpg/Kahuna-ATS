"use client";

import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { moveApplication } from "@/server/actions/admin/applications";
import type { ListPage, ListRow, PicklistItem, StageOption } from "@/server/services/applications/queries";
import { ActionNotice, NativeSelect } from "./fields";
import { formatMobile, formatShortDay, fullName, OUTCOME_LABELS, SOURCE_LABELS } from "./format";
import { MoveDialog, stageNeedsDetails, type MoveTarget } from "./move-dialog";
import { useAdminAction } from "./use-admin-action";

// The rows: one card per applicant, phone-first. A stage dropdown moves one
// applicant; checked rows move together. Both go through transition() with the
// event_seq the row was rendered with, so a stale row is refused and reloaded.

type Props = {
  page: ListPage;
  stages: StageOption[];
  crews: PicklistItem[];
  canAct: boolean;
  profileQuery: string;
};

export function ApplicantRows({ page, stages, crews, canAct, profileQuery }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ target: MoveTarget | { bulk: MoveTarget[] }; stageId?: string } | null>(null);
  const { run, pending, failure } = useAdminAction();

  const rowsById = new Map(page.rows.map((row) => [row.id, row]));
  const selectedRows = [...selected].map((id) => rowsById.get(id)).filter((row): row is ListRow => Boolean(row));

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function moveOne(row: ListRow, stageId: string) {
    const target: MoveTarget = { applicationId: row.id, eventSeq: row.eventSeq, currentStageId: row.stageId };
    if (stageNeedsDetails(stages.find((s) => s.id === stageId))) {
      setDialog({ target, stageId });
      return;
    }
    run(() => moveApplication({ applicationId: row.id, expectedSeq: row.eventSeq, toStageId: stageId }));
  }

  if (page.rows.length === 0) {
    return <p className="rounded-md border py-10 text-center text-sm text-muted-foreground">No applicants match.</p>;
  }

  return (
    <div className="grid gap-2">
      <ActionNotice failure={failure} />
      {canAct && selectedRows.length > 0 ? (
        <div className="sticky top-12 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-background p-2 shadow-sm">
          <span className="text-sm font-medium">{selectedRows.length} selected</span>
          <Button
            size="sm"
            onClick={() =>
              setDialog({ target: { bulk: selectedRows.map((r) => ({ applicationId: r.id, eventSeq: r.eventSeq, currentStageId: r.stageId })) } })
            }
          >
            Move selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      <ul className="grid gap-2">
        {page.rows.map((row) => (
          <li key={`${row.id}:${row.eventSeq}`} className="rounded-lg border bg-card p-3">
            <div className="flex items-start gap-3">
              {canAct ? (
                <input
                  type="checkbox"
                  className="mt-1.5 size-4 shrink-0"
                  aria-label={`Select ${fullName(row.firstName, row.lastName)}`}
                  checked={selected.has(row.id)}
                  onChange={(e) => toggle(row.id, e.target.checked)}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link href={`/admin/applicants/${row.id}?${profileQuery}` as Route} className="text-base font-medium hover:underline">
                    {fullName(row.firstName, row.lastName)}
                  </Link>
                  {row.returning !== "none" ? (
                    <Badge variant={row.returning === "not_rehire_eligible" ? "destructive" : "secondary"}>
                      {row.returning === "not_rehire_eligible" ? "Returning, not rehire eligible" : "Returning"}
                    </Badge>
                  ) : null}
                  {row.onHold ? <Badge variant="outline">On hold</Badge> : null}
                  {row.status === "closed" && row.closedOutcome ? (
                    <Badge variant="outline">
                      {OUTCOME_LABELS[row.closedOutcome]}
                      {row.closedReasonLabel ? `: ${row.closedReasonLabel}` : ""}
                    </Badge>
                  ) : null}
                  {row.status === "hired" ? <Badge>Hired</Badge> : null}
                  {row.unhandledTexts > 0 ? <Badge variant="secondary">Texts ({row.unhandledTexts})</Badge> : null}
                  {row.textsBlocked ? <Badge variant="outline">Texts opted out</Badge> : null}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {row.submittedAt ? `Submitted ${formatShortDay(row.submittedAt)}` : `Started ${formatShortDay(row.startedAt)}`}
                  {row.source ? ` · ${SOURCE_LABELS[row.source] ?? row.source}` : ""}
                  {row.entryCode ? ` · ${row.entryCode}` : ""}
                  {row.sessionLabel ? ` · ${row.sessionLabel}` : ""}
                  {row.mobile ? ` · ${formatMobile(row.mobile)}` : ""}
                </p>
                {row.attention.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {row.attention.map((flag) => (
                      <Badge key={flag.prompt} variant="outline" className="border-amber-400 text-amber-800">
                        {flag.prompt} {flag.value}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="shrink-0">
                {canAct && row.status !== "closed" ? (
                  <NativeSelect
                    aria-label={`Stage for ${fullName(row.firstName, row.lastName)}`}
                    className="h-8 w-auto max-w-36 text-xs"
                    value={row.stageId}
                    disabled={pending}
                    onChange={(e) => moveOne(row, e.target.value)}
                  >
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <span className="text-xs text-muted-foreground">{row.stageName}</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {dialog ? (
        <MoveDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          stages={stages}
          crews={crews}
          initialStageId={dialog.stageId}
          target={dialog.target}
          onDone={() => setSelected(new Set())}
        />
      ) : null}
    </div>
  );
}
