"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { bulkMoveApplications, moveApplication, type BulkMoveOutcome, type TransitionOutcome } from "@/server/actions/admin/applications";
import { moveWithInviteAction } from "@/server/actions/admin/messages";
import type { PicklistItem, StageOption } from "@/server/services/applications/queries";
import { moveSendsInvite } from "@/server/services/messaging/template-text";
import { ActionNotice, CheckboxRow, Field, NativeSelect, OccurredAtField, Textarea, YesNo } from "./fields";
import { CHECK_TYPE_LABELS } from "./format";
import { MessagePreviewCard, useMessagePreview } from "./panels/message-preview";
import { useAdminAction } from "./use-admin-action";

// The Move dialog (PLAN.md: stage, time, optional note; backdate if catching up).
// The stage list includes every stage, jumps forward included. An offered stage
// also asks for the offer details, a background_check stage for the check, and
// Hired for the first hire form fields; the rest of the hire form is on the
// profile. In bulk mode those three are refused, so each record stays complete.
// A move of one application into an interview_invited stage from an earlier one
// offers the one-on-one invite with its preview, ticked when it can go; the move
// and the invite are then saved together.

export type MoveTarget = { applicationId: string; eventSeq: number; currentStageId: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stages: StageOption[];
  crews: PicklistItem[];
  initialStageId?: string;
  // One application, or several for a bulk move.
  target: MoveTarget | { bulk: MoveTarget[] };
  onDone?: (result: TransitionOutcome | BulkMoveOutcome) => void;
};

const NEEDS_DETAILS = new Set(["offered", "background_check", "hired"]);

export function stageNeedsDetails(stage: StageOption | undefined): boolean {
  return Boolean(stage?.milestone && NEEDS_DETAILS.has(stage.milestone));
}

export function MoveDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">{props.open ? <MoveForm {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

function MoveForm({ stages, crews, initialStageId, target, onOpenChange, onDone }: Props) {
  const bulk = "bulk" in target;
  const current = bulk ? null : target.currentStageId;
  const choices = useMemo(
    () => stages.filter((s) => s.id !== current && !(bulk && stageNeedsDetails(s))),
    [stages, current, bulk],
  );
  const [stageId, setStageId] = useState(initialStageId && choices.some((s) => s.id === initialStageId) ? initialStageId : (choices[0]?.id ?? ""));
  const [occurredAt, setOccurredAt] = useState<string | undefined>(undefined);
  const [note, setNote] = useState("");
  // Offer
  const [isConditional, setIsConditional] = useState(true);
  const [plannedStartOn, setPlannedStartOn] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payUnit, setPayUnit] = useState<"hourly" | "daily" | "salary">("hourly");
  // Check
  const [checkType, setCheckType] = useState<"criminal" | "driving_record" | "drug_screen" | "other">("criminal");
  const [vendor, setVendor] = useState("");
  // Hire
  const [crewOptionId, setCrewOptionId] = useState("");
  const [startOn, setStartOn] = useState("");
  const [isTemporary, setIsTemporary] = useState(false);
  const [plannedEndOn, setPlannedEndOn] = useState("");
  const [skipped, setSkipped] = useState<BulkMoveOutcome["skipped"]>([]);
  // Invite: null until someone touches the box, so it follows the preview's default.
  const [inviteChoice, setInviteChoice] = useState<boolean | null>(null);
  const { run, pending, failure } = useAdminAction();

  const stage = stages.find((s) => s.id === stageId);
  const currentIndex = stages.findIndex((s) => s.id === current);
  const milestone = stage?.milestone ?? null;
  const offersInvite = !bulk && moveSendsInvite(stages[currentIndex], stage);
  const invite = useMessagePreview(offersInvite && !bulk ? target.applicationId : null, "one_on_one_invite");
  const inviteReady = Boolean(invite?.preview && !invite.preview.problem);
  const sendInvite = offersInvite && inviteReady && (inviteChoice ?? true);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stageId) return;
    if (!bulk && sendInvite) {
      run(
        () => moveWithInviteAction({ applicationId: target.applicationId, expectedSeq: target.eventSeq, toStageId: stageId, occurredAt, note: note || null }),
        (result) => {
          onOpenChange(false);
          onDone?.(result);
        },
      );
      return;
    }
    if (bulk) {
      run(
        () => bulkMoveApplications({ items: target.bulk.map((t) => ({ applicationId: t.applicationId, expectedSeq: t.eventSeq })), toStageId: stageId, occurredAt, note: note || null }),
        (result) => {
          setSkipped(result.skipped);
          if (result.skipped.length === 0) onOpenChange(false);
          onDone?.(result);
        },
      );
      return;
    }
    run(
      () =>
        moveApplication({
          applicationId: target.applicationId,
          expectedSeq: target.eventSeq,
          toStageId: stageId,
          occurredAt,
          note: note || null,
          offer:
            milestone === "offered"
              ? { isConditional, plannedStartOn: plannedStartOn || null, payAmount: payAmount || null, payUnit: payAmount ? payUnit : null }
              : undefined,
          check: milestone === "background_check" ? { checkType, vendor: vendor || null } : undefined,
          hire:
            milestone === "hired"
              ? { crewOptionId: crewOptionId || null, startOn: startOn || null, isTemporary, plannedEndOn: isTemporary && plannedEndOn ? plannedEndOn : null }
              : undefined,
        }),
      (result) => {
        onOpenChange(false);
        onDone?.(result);
      },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{bulk ? `Move ${target.bulk.length} applicants` : "Move"}</DialogTitle>
        <DialogDescription>
          {bulk ? "Offers, checks and Hired are moved one at a time from the profile." : "Pick the stage. You can jump ahead, or straight to Hired."}
        </DialogDescription>
      </DialogHeader>

      <Field label="Stage">
        <NativeSelect value={stageId} onChange={(e) => setStageId(e.target.value)} required>
          {choices.map((s) => {
            const index = stages.findIndex((x) => x.id === s.id);
            const direction = currentIndex >= 0 && index < currentIndex ? " (back)" : "";
            return (
              <option key={s.id} value={s.id}>
                {s.name}
                {direction}
              </option>
            );
          })}
        </NativeSelect>
      </Field>

      <OccurredAtField value={occurredAt} onChange={setOccurredAt} />

      {milestone === "offered" ? (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-sm font-medium">Offer</p>
          <p className="text-xs text-muted-foreground">The offer date is the time above. Backdate it if the offer was made earlier.</p>
          <Field label="Conditional offer?" group>
            <YesNo name="conditional" value={isConditional} onChange={setIsConditional} />
          </Field>
          <Field label="Planned start date (optional)">
            <Input type="date" value={plannedStartOn} onChange={(e) => setPlannedStartOn(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pay (optional)">
              <Input inputMode="decimal" placeholder="22.50" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            </Field>
            <Field label="Per">
              <NativeSelect value={payUnit} onChange={(e) => setPayUnit(e.target.value as typeof payUnit)}>
                <option value="hourly">hour</option>
                <option value="daily">day</option>
                <option value="salary">salary</option>
              </NativeSelect>
            </Field>
          </div>
        </div>
      ) : null}

      {milestone === "background_check" ? (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-sm font-medium">Background check</p>
          <Field label="Type of check">
            <NativeSelect value={checkType} onChange={(e) => setCheckType(e.target.value as typeof checkType)}>
              {Object.entries(CHECK_TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Vendor (optional)">
            <Input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Checkr" />
          </Field>
        </div>
      ) : null}

      {milestone === "hired" ? (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-sm font-medium">Hire record</p>
          <p className="text-xs text-muted-foreground">The rest of the hire form (ratings, leaving) is on the profile afterwards.</p>
          {crews.length > 0 ? (
            <Field label="Crew">
              <NativeSelect value={crewOptionId} onChange={(e) => setCrewOptionId(e.target.value)}>
                <option value="">Not assigned yet</option>
                {crews.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : (
            <p className="text-xs text-muted-foreground">No crews yet. An Admin adds them in Settings, Picklists.</p>
          )}
          <Field label="Start date (first day worked, if known)">
            <Input type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} />
          </Field>
          <Field label="Temporary hire?" group hint="A planned short engagement. Set it now, not the day they leave.">
            <YesNo name="temporary" value={isTemporary} onChange={setIsTemporary} />
          </Field>
          {isTemporary ? (
            <Field label="Planned end date (optional)">
              <Input type="date" value={plannedEndOn} onChange={(e) => setPlannedEndOn(e.target.value)} />
            </Field>
          ) : null}
        </div>
      ) : null}

      {offersInvite ? (
        <div className="grid gap-3 rounded-md border p-3">
          <CheckboxRow
            label="Also send the one-on-one invite"
            checked={sendInvite}
            disabled={!inviteReady}
            onChange={setInviteChoice}
            hint={
              occurredAt
                ? "This move is backdated. Untick the invite if you already invited them another way."
                : "Asks them to pick a time with the booking link. It goes out within 5 minutes."
            }
          />
          {invite === null ? <p className="text-xs text-muted-foreground">Loading the invite</p> : null}
          {invite?.error ? <p className="text-sm text-destructive">{invite.error}</p> : null}
          {invite?.preview && (sendInvite || invite.preview.problem) ? <MessagePreviewCard preview={invite.preview} /> : null}
        </div>
      ) : null}

      <Field label="Note (optional)">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </Field>

      <ActionNotice failure={failure} />
      {skipped.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Moved the rest. Skipped {skipped.length}:</p>
          <ul className="mt-1 list-disc pl-5">
            {skipped.map((s) => (
              <li key={s.applicationId}>{s.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !stageId || (offersInvite && invite === null)}>
          {pending ? "Moving" : bulk ? "Move all" : "Move"}
        </Button>
      </DialogFooter>
    </form>
  );
}
