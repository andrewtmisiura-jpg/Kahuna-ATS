"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { UserRole } from "@/server/auth/roles";
import type { Profile } from "@/server/services/applications/queries";
import { formatCalendarDate, HIRE_OUTCOME_LABELS, SEASON_RATING_LABELS } from "./format";
import { HireFormDialog } from "./hire-form-dialog";
import { Empty, Rows, Section } from "./section";

// The hire record: what the form holds, with Edit opening the hire form.

export function HirePanel({ profile, role }: { profile: Profile; role: UserRole }) {
  const [open, setOpen] = useState(false);
  const { stint, voidedStints, picklists, application } = profile;
  const canAct = role !== "viewer";
  if (!stint && voidedStints.length === 0) return null;
  return (
    <Section
      title="Hire record"
      action={
        canAct && stint ? (
          <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
            Edit
          </Button>
        ) : null
      }
    >
      {stint ? (
        <Rows
          items={[
            { label: "Outcome", value: <span className="flex flex-wrap gap-1">{HIRE_OUTCOME_LABELS[stint.outcome]}{stint.isTemporary ? <Badge variant="outline">Temporary</Badge> : null}</span> },
            { label: "Crew", value: stint.crewLabel },
            { label: "Planned start", value: formatCalendarDate(stint.plannedStartOn) || null },
            { label: "Start date", value: formatCalendarDate(stint.startOn) || <span className="text-muted-foreground">not worked yet</span> },
            ...(stint.isTemporary ? [{ label: "Planned end", value: formatCalendarDate(stint.plannedEndOn) || null }] : []),
            ...(stint.outcome !== "active"
              ? [
                  { label: "Last day worked", value: formatCalendarDate(stint.lastWorkedOn) || null },
                  { label: "End date", value: formatCalendarDate(stint.endOn) || null },
                  { label: "Separation", value: stint.separationType },
                  { label: "Leave reason", value: stint.leaveReasonLabel },
                  { label: "Rehire eligible", value: stint.rehireEligible === null ? null : stint.rehireEligible ? "Yes" : "No" },
                ]
              : []),
            { label: "30-day rating", value: stint.rating30 ? `${stint.rating30}/5` : null },
            { label: "90-day rating", value: stint.rating90 ? `${stint.rating90}/5` : null },
            ...(application.roleKey === "snow_removal_tech"
              ? [
                  { label: "Season-end rating", value: stint.seasonEndRating ? SEASON_RATING_LABELS[stint.seasonEndRating] : null },
                  { label: "Storms worked", value: stint.stormsWorked ?? null },
                ]
              : []),
          ]}
        />
      ) : (
        <Empty>No active hire record.</Empty>
      )}
      {voidedStints.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {voidedStints.length} earlier hire record{voidedStints.length > 1 ? "s" : ""} voided ({voidedStints.map((s) => (s.voidKind === "rescinded" ? "rescinded" : "entered in error")).join(", ")}).
        </p>
      ) : null}
      {stint ? (
        <HireFormDialog
          open={open}
          onOpenChange={setOpen}
          stint={stint}
          crews={picklists.crews}
          leaveReasons={picklists.leaveReasons}
          isSnow={application.roleKey === "snow_removal_tech"}
          role={role}
        />
      ) : null}
    </Section>
  );
}
