"use client";

import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Milestone } from "@/db/schema";
import { addStageAction, archiveStageAction, moveStageAction, unarchiveStageAction, updateStageAction } from "@/server/actions/admin/roles";
import { CheckboxField, Field, NativeSelect, Notice } from "../fields";
import { PUBLIC_LABEL_SUGGESTIONS, TAP } from "./format";

// The stage editor for one role: stages in pipeline order with the label applicants
// see, the milestone each counts as and whether it shows on the board. Add a custom
// stage, rename, edit the applicant label, reorder with up and down, hide from the
// board, archive and unarchive. The service enforces the lock rules; the buttons only
// stay out of the way of the obvious ones.

export type StageItem = {
  id: string;
  key: string;
  name: string;
  publicLabel: string;
  milestone: Milestone | null;
  isSystem: boolean;
  showOnBoard: boolean;
  archivedAt: Date | null;
  inUse: boolean;
  openCount: number;
};

export type MilestoneOption = { value: Milestone; label: string };

type Result = { ok: true; data: unknown } | { ok: false; error: string };

// Started and Submitted belong to the two system stages.
const SYSTEM_MILESTONES: readonly Milestone[] = ["started", "submitted"];

export function StageEditor({ roleId, stages, milestones }: { roleId: string; stages: StageItem[]; milestones: MilestoneOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<StageItem | null>(null);
  const live = stages.filter((s) => !s.archivedAt);
  const archived = stages.filter((s) => s.archivedAt);
  const label = (m: Milestone | null) => milestones.find((o) => o.value === m)?.label ?? "Custom, no milestone";

  function act(call: () => Promise<Result>) {
    startTransition(async () => {
      setError(null);
      const result = await call();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="grid gap-3">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ol className="grid gap-2" aria-label="Stages">
        {live.map((stage, index) => {
          const above = live[index - 1];
          const below = live[index + 1];
          const upLocked = stage.isSystem || !above || above.isSystem;
          const downLocked = stage.isSystem || !below || below.isSystem;
          return (
            <li key={stage.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {index + 1}. {stage.name}
                  </p>
                  <p className="text-xs text-muted-foreground">Applicants see &ldquo;{stage.publicLabel}&rdquo;</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge variant="secondary">{label(stage.milestone)}</Badge>
                    {stage.isSystem ? <Badge variant="outline">System</Badge> : null}
                    {stage.showOnBoard ? null : <Badge variant="outline">Not on the board</Badge>}
                    {stage.openCount > 0 ? <Badge variant="outline">{stage.openCount} open</Badge> : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-11 md:size-9"
                    aria-label={`Move ${stage.name} up`}
                    disabled={pending || upLocked}
                    onClick={() => act(() => moveStageAction({ stageId: stage.id, direction: "up", roleId }))}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-11 md:size-9"
                    aria-label={`Move ${stage.name} down`}
                    disabled={pending || downLocked}
                    onClick={() => act(() => moveStageAction({ stageId: stage.id, direction: "down", roleId }))}
                  >
                    <ArrowDown />
                  </Button>
                  <Button size="sm" variant="outline" className={TAP} aria-label={`Edit ${stage.name}`} disabled={pending} onClick={() => setEditing(stage)}>
                    <Pencil />
                    Edit
                  </Button>
                  {stage.isSystem ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className={TAP}
                      aria-label={`Archive ${stage.name}`}
                      disabled={pending}
                      title="Take it out of the pipeline and the board; past records keep it"
                      onClick={() => act(() => archiveStageAction({ stageId: stage.id }))}
                    >
                      <Archive />
                      Archive
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">
        Started and Submitted are system stages: the app moves applications into them, so they stay first. Once applications have been
        through a stage, its milestone stays as it is; archive it and add a new one to count it differently.
      </p>
      <div>
        <Button className={TAP} onClick={() => setAdding(true)} disabled={pending}>
          <Plus />
          Add a stage
        </Button>
      </div>
      {archived.length > 0 ? (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">Archived ({archived.length})</summary>
          <ul className="mt-3 grid gap-2">
            {archived.map((stage) => (
              <li key={stage.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {stage.name} <span className="text-xs">({label(stage.milestone)})</span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className={TAP}
                  aria-label={`Unarchive ${stage.name}`}
                  disabled={pending}
                  onClick={() => act(() => unarchiveStageAction({ stageId: stage.id }))}
                >
                  <ArchiveRestore />
                  Unarchive
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {adding ? <AddStageDialog roleId={roleId} live={live} milestones={milestones} onClose={() => setAdding(false)} /> : null}
      {editing ? <EditStageDialog stage={editing} milestones={milestones} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function MilestoneSelect({ id, milestones, defaultValue, disabled }: { id: string; milestones: MilestoneOption[]; defaultValue: Milestone | null; disabled?: boolean }) {
  const choices = milestones.filter((m) => !SYSTEM_MILESTONES.includes(m.value) || m.value === defaultValue);
  return (
    <NativeSelect id={id} name="milestone" className={TAP} defaultValue={defaultValue ?? ""} disabled={disabled}>
      <option value="">None (a custom stage)</option>
      {choices.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </NativeSelect>
  );
}

function PublicLabelInput({ id, defaultValue }: { id: string; defaultValue?: string }) {
  const listId = `${id}-suggestions`;
  return (
    <>
      <Input id={id} name="publicLabel" className={TAP} list={listId} defaultValue={defaultValue} maxLength={60} required />
      <datalist id={listId}>
        {PUBLIC_LABEL_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}

function AddStageDialog({ roleId, live, milestones, onClose }: { roleId: string; live: StageItem[]; milestones: MilestoneOption[]; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  // New stages go after Submitted at the earliest; Reviewed is the usual place.
  const firstAllowed = Math.max(0, live.findLastIndex((s) => s.isSystem));
  const places = live.slice(firstAllowed);
  const defaultAfter = places.find((s) => s.key === "reviewed") ?? places[0];

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const milestone = String(form.get("milestone") ?? "");
    startTransition(async () => {
      setError(null);
      const result = await addStageAction({
        roleId,
        name: String(form.get("name") ?? ""),
        publicLabel: String(form.get("publicLabel") ?? ""),
        milestone: milestone ? (milestone as Milestone) : null,
        showOnBoard: form.get("showOnBoard") === "on",
        afterStageId: String(form.get("afterStageId") ?? ""),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a stage</DialogTitle>
          <DialogDescription>A custom stage such as a phone screen needs no milestone. Reports count only the milestones.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Name" htmlFor="stage-name" hint="What staff see on the list and the board.">
            <Input id="stage-name" name="name" className={TAP} maxLength={60} required autoFocus />
          </Field>
          <Field label="What applicants see" htmlFor="stage-public-label" hint="Shown on their status page, for example Under review.">
            <PublicLabelInput id="stage-public-label" />
          </Field>
          <Field label="Counts as" htmlFor="stage-milestone" hint="The hiring step reports count it as. Stages follow the order of these steps.">
            <MilestoneSelect id="stage-milestone" milestones={milestones} defaultValue={null} />
          </Field>
          <Field label="Put it after" htmlFor="stage-after">
            <NativeSelect id="stage-after" name="afterStageId" className={TAP} defaultValue={defaultAfter?.id}>
              {places.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <CheckboxField name="showOnBoard" label="Show it as a column on the board" defaultChecked />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" className={TAP} onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" className={TAP} disabled={pending}>
              {pending ? "Adding" : "Add stage"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditStageDialog({ stage, milestones, onClose }: { stage: StageItem; milestones: MilestoneOption[]; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const milestoneLocked = stage.isSystem || stage.inUse;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const milestone = String(form.get("milestone") ?? "");
    startTransition(async () => {
      setError(null);
      const result = await updateStageAction({
        stageId: stage.id,
        patch: {
          name: String(form.get("name") ?? ""),
          publicLabel: String(form.get("publicLabel") ?? ""),
          showOnBoard: form.get("showOnBoard") === "on",
          ...(milestoneLocked ? {} : { milestone: milestone ? (milestone as Milestone) : null }),
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {stage.name}</DialogTitle>
          <DialogDescription>Renaming is safe: reports count the milestone, not the name.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Name" htmlFor="edit-stage-name">
            <Input id="edit-stage-name" name="name" className={TAP} defaultValue={stage.name} maxLength={60} required autoFocus />
          </Field>
          <Field label="What applicants see" htmlFor="edit-stage-public-label">
            <PublicLabelInput id="edit-stage-public-label" defaultValue={stage.publicLabel} />
          </Field>
          <Field
            label="Counts as"
            htmlFor="edit-stage-milestone"
            hint={
              stage.isSystem
                ? "Locked: the app moves applications into this system stage."
                : stage.inUse
                  ? "Locked: applications have already been through this stage. Archive it and add a new one to count it differently."
                  : "Nothing has used this stage yet, so its milestone can still change."
            }
          >
            <MilestoneSelect id="edit-stage-milestone" milestones={milestones} defaultValue={stage.milestone} disabled={milestoneLocked} />
          </Field>
          <CheckboxField name="showOnBoard" label="Show it as a column on the board" defaultChecked={stage.showOnBoard} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" className={TAP} onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" className={TAP} disabled={pending}>
              {pending ? "Saving" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
