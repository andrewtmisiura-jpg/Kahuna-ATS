"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { hireNow, holdApplication, markContacted, unholdApplication } from "@/server/actions/admin/applications";
import type { UserRole } from "@/server/auth/roles";
import type { Profile } from "@/server/services/applications/queries";
import { CloseDialog } from "./close-dialog";
import { ActionNotice } from "./fields";
import { HireFormDialog } from "./hire-form-dialog";
import { MoveDialog } from "./move-dialog";
import { ReopenDialog } from "./reopen-dialog";
import { RescindDialog } from "./rescind-dialog";
import { UndoDialog } from "./undo-dialog";
import { useAdminAction } from "./use-admin-action";

// Move, Close, Hold, Unhold, Reopen, Contacted and Hire now (PLAN.md). Hire now
// jumps straight to Hired and opens the hire form on the new record. A Hired
// application can have its hire rescinded; Hiring Managers and Admins can undo
// the latest change after a confirmation that names it.

type Props = {
  application: Profile["application"];
  stages: Profile["stages"];
  picklists: Profile["picklists"];
  checks: Profile["checks"];
  stint: Profile["stint"];
  undo: Profile["undo"];
  rescindStageId: Profile["rescindStageId"];
  role: UserRole;
};

export function ActionBar({ application, stages, picklists, checks, stint, undo, rescindStageId, role }: Props) {
  const [dialog, setDialog] = useState<"move" | "close" | "reopen" | "rescind" | "undo" | null>(null);
  const [hireFormOpen, setHireFormOpen] = useState(false);
  const { run, pending, failure } = useAdminAction();
  const target = { applicationId: application.id, eventSeq: application.eventSeq, currentStageId: application.stageId };
  const base = { applicationId: application.id, expectedSeq: application.eventSeq };
  const isOpen = application.status === "open";
  const canUndo = role === "admin" || role === "hiring_manager";

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {application.status !== "closed" ? (
          <Button size="sm" onClick={() => setDialog("move")}>
            Move
          </Button>
        ) : null}
        {isOpen ? (
          <Button size="sm" variant="outline" onClick={() => setDialog("close")}>
            Close
          </Button>
        ) : null}
        {isOpen ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => (application.onHold ? unholdApplication(base) : holdApplication(base)))}>
            {application.onHold ? "Take off hold" : "Hold"}
          </Button>
        ) : null}
        {application.status === "closed" ? (
          <Button size="sm" onClick={() => setDialog("reopen")}>
            Reopen
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => markContacted(base))}>
          Contacted
        </Button>
        {isOpen ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => hireNow(base), () => setHireFormOpen(true))}>
            Hire now
          </Button>
        ) : null}
        {application.status === "hired" && stint ? (
          <Button size="sm" variant="secondary" onClick={() => setHireFormOpen(true)}>
            Hire record
          </Button>
        ) : null}
        {application.status === "hired" ? (
          <Button size="sm" variant="outline" onClick={() => setDialog("rescind")}>
            Rescind hire
          </Button>
        ) : null}
        {canUndo && undo ? (
          <Button size="sm" variant="ghost" onClick={() => setDialog("undo")}>
            Undo last change
          </Button>
        ) : null}
      </div>
      <ActionNotice failure={failure} />

      <MoveDialog open={dialog === "move"} onOpenChange={(o) => setDialog(o ? "move" : null)} stages={stages} crews={picklists.crews} target={target} onDone={(result) => {
        if ("created" in result && result.created.hireStintId) setHireFormOpen(true);
      }} />
      <CloseDialog open={dialog === "close"} onOpenChange={(o) => setDialog(o ? "close" : null)} application={application} picklists={picklists} checks={checks} />
      <ReopenDialog open={dialog === "reopen"} onOpenChange={(o) => setDialog(o ? "reopen" : null)} application={application} stages={stages} />
      {application.status === "hired" ? (
        <RescindDialog
          open={dialog === "rescind"}
          onOpenChange={(o) => setDialog(o ? "rescind" : null)}
          application={application}
          stages={stages}
          picklists={picklists}
          checks={checks}
          defaultStageId={rescindStageId}
        />
      ) : null}
      {canUndo && undo ? (
        <UndoDialog open={dialog === "undo"} onOpenChange={(o) => setDialog(o ? "undo" : null)} application={application} undo={undo} />
      ) : null}
      {stint ? (
        <HireFormDialog
          open={hireFormOpen}
          onOpenChange={setHireFormOpen}
          stint={stint}
          crews={picklists.crews}
          leaveReasons={picklists.leaveReasons}
          isSnow={application.roleKey === "snow_removal_tech"}
          role={role}
        />
      ) : null}
    </div>
  );
}
