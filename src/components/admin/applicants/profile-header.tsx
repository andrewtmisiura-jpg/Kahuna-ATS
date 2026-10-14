import type { Route } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SessionUser } from "@/server/auth/session";
import type { Profile } from "@/server/services/applications/queries";
import { ActionBar } from "./action-bar";
import { ConflictBanner } from "./conflict-banner";
import { formatCalendarDate, formatDateTime, formatMobile, fullName, HIRE_OUTCOME_LABELS, OPT_OUT_WARNING, OUTCOME_LABELS, STATUS_LABELS } from "./format";

// Name, contact, opening, stage, status and hold; the Returning strip (red when
// a stint says not rehire eligible); the live text opt-out warning; the
// contact-conflict banner; next and previous within the list.

type Props = {
  profile: Profile;
  user: SessionUser;
  listHref: Route;
  previousHref: Route | null;
  nextHref: Route | null;
};

export function ProfileHeader({ profile, user, listHref, previousHref, nextHref }: Props) {
  const { application: app, person, texting, returning } = profile;
  const staff = user.role !== "viewer";
  const stop = texting?.suppression;
  const quoBlocked = stop && (stop.reason === "stop_keyword" || stop.reason === "carrier_blocked");

  return (
    <div className="mb-4 grid gap-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <Link href={listHref} className="text-muted-foreground hover:underline">
          Back to list
        </Link>
        <div className="flex gap-1">
          <Button asChild={Boolean(previousHref)} variant="outline" size="sm" disabled={!previousHref}>
            {previousHref ? <Link href={previousHref}>Previous</Link> : <span>Previous</span>}
          </Button>
          <Button asChild={Boolean(nextHref)} variant="outline" size="sm" disabled={!nextHref}>
            {nextHref ? <Link href={nextHref}>Next</Link> : <span>Next</span>}
          </Button>
        </div>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{fullName(person.firstName, person.lastName)}</h1>
        {staff ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {person.mobile ? <a href={`tel:${person.mobile}`}>{formatMobile(person.mobile)}</a> : "No mobile"}
            {person.sharedMobile ? " (shared phone)" : ""}
            {" · "}
            {person.email ? <a href={`mailto:${person.email}`}>{person.email}</a> : "No email"}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
          <Badge variant="outline">{app.openingName}</Badge>
          <Badge>{app.stageName}</Badge>
          <Badge variant={app.status === "closed" ? "outline" : app.status === "hired" ? "default" : "secondary"}>
            {app.status === "closed" && app.closedOutcome ? `${OUTCOME_LABELS[app.closedOutcome]}${app.closedReasonLabel ? `: ${app.closedReasonLabel}` : ""}` : STATUS_LABELS[app.status]}
          </Badge>
          {app.onHold ? <Badge variant="outline">On hold</Badge> : null}
          {person.doNotContact ? <Badge variant="destructive">Do not contact</Badge> : null}
          <span className="text-xs text-muted-foreground">in stage since {formatDateTime(app.stageEnteredAt)}</span>
        </div>
      </div>

      {returning.applications.length > 0 || returning.stints.length > 0 ? (
        <div
          className={
            returning.notRehireEligible
              ? "rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900"
              : "rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950"
          }
        >
          <p className="font-medium">{returning.notRehireEligible ? "Returning, marked not eligible for rehire" : "Returning"}</p>
          <ul className="mt-1 list-disc pl-5">
            {returning.stints.map((s) => (
              <li key={s.id}>
                Worked {s.roleName}
                {s.openingName ? ` (${s.openingName})` : ""}: {HIRE_OUTCOME_LABELS[s.outcome]}
                {s.isTemporary ? ", temporary" : ""}
                {s.leaveReasonLabel ? `, ${s.leaveReasonLabel}` : ""}
                {s.rehireEligible === null ? "" : s.rehireEligible ? ", rehire eligible" : ", not rehire eligible"}
                {s.rating30 ? `, 30-day ${s.rating30}/5` : ""}
                {s.rating90 ? `, 90-day ${s.rating90}/5` : ""}
                {s.startOn ? `, ${formatCalendarDate(s.startOn)}` : ""}
                {s.endOn ? ` to ${formatCalendarDate(s.endOn)}` : ""}
              </li>
            ))}
            {returning.applications.map((a) => (
              <li key={a.id}>
                <Link href={`/admin/applicants/${a.id}` as Route} className="underline">
                  Applied to {a.openingName}
                </Link>
                : {a.status === "closed" && a.closedOutcome ? OUTCOME_LABELS[a.closedOutcome] : a.stageName}, {formatDateTime(a.startedAt)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {staff && texting ? (
        quoBlocked ? (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">{OPT_OUT_WARNING}</div>
        ) : stop ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Texts are off: opted out ({stop.reason === "staff_marked" ? "recorded by staff" : stop.reason.replace(/_/g, " ")}) on {formatDateTime(stop.createdAt)}. Messages fall back to email.
          </div>
        ) : !texting.optedIn && person.mobile ? (
          <p className="text-xs text-muted-foreground">Texts off: no opt-in for this number. Messages go by email.</p>
        ) : null
      ) : null}

      {staff ? <ConflictBanner conflicts={profile.conflicts} personId={person.id} canAct={staff} /> : null}

      {staff ? (
        <ActionBar application={app} stages={profile.stages} picklists={profile.picklists} checks={profile.checks} stint={profile.stint} role={user.role} />
      ) : (
        <p className="text-xs text-muted-foreground">Viewers can read but not act.</p>
      )}
    </div>
  );
}
