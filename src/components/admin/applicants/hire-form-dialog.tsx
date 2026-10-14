"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { saveHireStint } from "@/server/actions/admin/applications";
import type { UserRole } from "@/server/auth/roles";
import type { PicklistItem, ProfileStint } from "@/server/services/applications/queries";
import { ActionNotice, Field, NativeSelect, Textarea, YesNo } from "./fields";
import { HIRE_OUTCOME_LABELS, SEASON_RATING_LABELS } from "./format";
import { useAdminAction } from "./use-admin-action";

// The hire form (PLAN.md, hire form with the temporary flag): crew, start date,
// Temporary, and the later fields. Opens after a move to Hired and from the
// profile's hire record panel.

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stint: ProfileStint;
  crews: PicklistItem[];
  leaveReasons: PicklistItem[];
  isSnow: boolean;
  role: UserRole;
};

type Outcome = ProfileStint["outcome"];

export function HireFormDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">{props.open ? <HireForm {...props} /> : null}</DialogContent>
    </Dialog>
  );
}

const numberOrNull = (value: string) => (value === "" ? null : Number(value));

function HireForm({ onOpenChange, stint, crews, leaveReasons, isSnow, role }: Props) {
  const [crewOptionId, setCrewOptionId] = useState(stint.crewOptionId ?? "");
  const [plannedStartOn, setPlannedStartOn] = useState(stint.plannedStartOn ?? "");
  const [startOn, setStartOn] = useState(stint.startOn ?? "");
  const [isTemporary, setIsTemporary] = useState(stint.isTemporary);
  const [plannedEndOn, setPlannedEndOn] = useState(stint.plannedEndOn ?? "");
  const [temporaryChangeReason, setTemporaryChangeReason] = useState("");
  const [lastWorkedOn, setLastWorkedOn] = useState(stint.lastWorkedOn ?? "");
  const [endOn, setEndOn] = useState(stint.endOn ?? "");
  const [outcome, setOutcome] = useState<Outcome>(stint.outcome);
  const [separationType, setSeparationType] = useState<"voluntary" | "involuntary" | "">(stint.separationType ?? "");
  const [leaveReasonOptionId, setLeaveReasonOptionId] = useState(stint.leaveReasonOptionId ?? "");
  const [leaveNote, setLeaveNote] = useState(stint.leaveNote ?? "");
  const [rehireEligible, setRehireEligible] = useState<"" | "yes" | "no">(stint.rehireEligible === null ? "" : stint.rehireEligible ? "yes" : "no");
  const [rating30, setRating30] = useState(stint.rating30?.toString() ?? "");
  const [rating90, setRating90] = useState(stint.rating90?.toString() ?? "");
  const [seasonEndRating, setSeasonEndRating] = useState(stint.seasonEndRating ?? "");
  const [stormsWorked, setStormsWorked] = useState(stint.stormsWorked?.toString() ?? "");
  const { run, pending, failure } = useAdminAction();

  const leaving = outcome === "separated" || outcome === "never_started";
  const ended = outcome !== "active";
  const temporaryLocked = stint.outcome !== "active" && role !== "admin";
  const temporaryNeedsReason = stint.outcome !== "active" && isTemporary !== stint.isTemporary;
  const leaveReason = leaveReasons.find((r) => r.id === leaveReasonOptionId);

  function pickLeaveReason(id: string) {
    setLeaveReasonOptionId(id);
    const option = leaveReasons.find((r) => r.id === id);
    if (option?.defaultSeparation && !separationType) setSeparationType(option.defaultSeparation);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(
      () =>
        saveHireStint({
          stintId: stint.id,
          patch: {
            crewOptionId: crewOptionId || null,
            plannedStartOn: plannedStartOn || null,
            startOn: startOn || null,
            isTemporary,
            plannedEndOn: isTemporary && plannedEndOn ? plannedEndOn : null,
            temporaryChangeReason: temporaryChangeReason || null,
            lastWorkedOn: lastWorkedOn || null,
            endOn: endOn || null,
            outcome,
            separationType: separationType || null,
            leaveReasonOptionId: leaveReasonOptionId || null,
            leaveNote: leaveNote || null,
            rehireEligible: rehireEligible === "" ? null : rehireEligible === "yes",
            rating30: numberOrNull(rating30),
            rating90: numberOrNull(rating90),
            seasonEndRating: (seasonEndRating || null) as ProfileStint["seasonEndRating"],
            stormsWorked: numberOrNull(stormsWorked),
          },
        }),
      () => onOpenChange(false),
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Hire record</DialogTitle>
        <DialogDescription>Fill in what you know now; the rest can wait until it happens. Every change is recorded with your name.</DialogDescription>
      </DialogHeader>

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
      <div className="grid grid-cols-2 gap-3">
        <Field label="Planned start">
          <Input type="date" value={plannedStartOn} onChange={(e) => setPlannedStartOn(e.target.value)} />
        </Field>
        <Field label="Start date" hint="First day actually worked.">
          <Input type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} />
        </Field>
      </div>
      <Field
        group
        label="Temporary hire?"
        hint={temporaryLocked ? "Set at hire. After an exit only an Admin can change it, with a reason." : "A planned short engagement, left out of retention numbers."}
      >
        {temporaryLocked ? <p className="text-sm">{isTemporary ? "Yes" : "No"}</p> : <YesNo name="temporary" value={isTemporary} onChange={setIsTemporary} />}
      </Field>
      {isTemporary ? (
        <Field label="Planned end date (optional)">
          <Input type="date" value={plannedEndOn} onChange={(e) => setPlannedEndOn(e.target.value)} />
        </Field>
      ) : null}
      {temporaryNeedsReason ? (
        <Field label="Reason for changing the temporary flag">
          <Input value={temporaryChangeReason} onChange={(e) => setTemporaryChangeReason(e.target.value)} required maxLength={500} />
        </Field>
      ) : null}

      <div className="grid gap-3 rounded-md border p-3">
        <p className="text-sm font-medium">Later</p>
        <Field label="Outcome">
          <NativeSelect value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
            {(Object.keys(HIRE_OUTCOME_LABELS) as Outcome[]).map((o) => (
              <option key={o} value={o}>
                {HIRE_OUTCOME_LABELS[o]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {ended ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Last day worked">
              <Input type="date" value={lastWorkedOn} onChange={(e) => setLastWorkedOn(e.target.value)} />
            </Field>
            <Field label="End date" hint={outcome === "completed_season" ? "The season end." : "The separation date."}>
              <Input type="date" value={endOn} onChange={(e) => setEndOn(e.target.value)} required />
            </Field>
          </div>
        ) : null}
        {leaving ? (
          <>
            <Field label="Voluntary or involuntary?" group>
              <div className="flex gap-4 text-sm">
                {(["voluntary", "involuntary"] as const).map((v) => (
                  <label key={v} className="flex items-center gap-1.5">
                    <input type="radio" name="separation" checked={separationType === v} onChange={() => setSeparationType(v)} />
                    {v === "voluntary" ? "Voluntary" : "Involuntary"}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Leave reason">
              <NativeSelect value={leaveReasonOptionId} onChange={(e) => pickLeaveReason(e.target.value)} required>
                <option value="">Pick a reason</option>
                {leaveReasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </>
        ) : null}
        {ended ? (
          <Field label={leaveReason?.requiresNote ? "Notes (required for this reason)" : "Notes"}>
            <Textarea value={leaveNote} onChange={(e) => setLeaveNote(e.target.value)} maxLength={2000} required={leaveReason?.requiresNote} />
          </Field>
        ) : null}
        {ended ? (
          <Field label="Rehire eligible?">
            <NativeSelect value={rehireEligible} onChange={(e) => setRehireEligible(e.target.value as typeof rehireEligible)} required={outcome !== "never_started"}>
              <option value="">Not decided</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </NativeSelect>
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="30-day rating (1 to 5)">
            <Input type="number" min={1} max={5} inputMode="numeric" value={rating30} onChange={(e) => setRating30(e.target.value)} />
          </Field>
          <Field label="90-day rating (1 to 5)">
            <Input type="number" min={1} max={5} inputMode="numeric" value={rating90} onChange={(e) => setRating90(e.target.value)} />
          </Field>
        </div>
        {isSnow ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Season-end rating">
              <NativeSelect value={seasonEndRating} onChange={(e) => setSeasonEndRating(e.target.value as typeof seasonEndRating)}>
                <option value="">Not rated yet</option>
                {Object.entries(SEASON_RATING_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Storms worked">
              <Input type="number" min={0} inputMode="numeric" value={stormsWorked} onChange={(e) => setStormsWorked(e.target.value)} />
            </Field>
          </div>
        ) : null}
      </div>

      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving" : "Save hire record"}
        </Button>
      </DialogFooter>
    </form>
  );
}
