import { formatDay } from "@/components/admin/applicants/format";
import { formatTime } from "@/components/admin/sessions/format";
import { StartCheckInButton } from "@/components/admin/sessions/start-check-in-button";
import { db } from "@/db";
import { isUuid } from "@/lib/uuid";
import { checkInClosedMessage, checkInState } from "@/server/services/sessions/attendees";
import { getSessionSummary } from "@/server/services/sessions/queries";
import { kioskAccess, kioskStarterAccess, staffSignedInHere } from "../../_lib/kiosk-access";
import { CheckInForm } from "./check-in-form";

export const metadata = { title: "Check in" };

// The door check-in for one group session (Phase 2, sessions): each person arriving
// types a name and mobile, which become an attendee row (source door_checkin) matched
// to an application on an exact mobile. Open on the session's day (Central) while it
// is scheduled or held; any other day it says so in plain words. Only a tablet holding
// this session's kiosk credential, with nobody signed in on it, gets the form; a staff
// member signed in here is asked to start the check-in, which signs them out first.
export default async function CheckInPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const ready = isUuid(sessionId) && (await kioskAccess(sessionId)) !== null && !(await staffSignedInHere());
  if (!ready) {
    const access = await kioskStarterAccess();
    if (!access.ok) return access.view;
  }
  const session = isUuid(sessionId) ? await getSessionSummary(db, sessionId) : null;
  if (!session) {
    return <KioskNotice title="Check-in not found">This check-in page does not exist. Please ask a staff member for help.</KioskNotice>;
  }
  if (!ready) {
    return (
      <div className="grid gap-4 py-10">
        <h1 className="text-3xl font-semibold tracking-tight">Set up door check-in</h1>
        <p className="text-xl">
          Group interview at {session.locationName}, {formatTime(session.startsAt)}
        </p>
        <p className="text-base text-muted-foreground">
          Starting check-in signs you out on this tablet first, so people at the door can only check in. Sign in again when check-in is over.
        </p>
        <div>
          <StartCheckInButton sessionId={session.id} variant="default" />
        </div>
      </div>
    );
  }
  const state = checkInState(session, new Date());
  if (!state.open) {
    const message =
      state.reason === "not_yet"
        ? `Check-in opens on the day of the group interview, ${formatDay(session.startsAt)}.`
        : checkInClosedMessage(state.reason);
    return <KioskNotice title="Check-in is closed">{message}</KioskNotice>;
  }
  return (
    <div className="grid gap-6">
      <p className="text-base text-muted-foreground">
        Group interview at {session.locationName}, {formatTime(session.startsAt)}
      </p>
      <CheckInForm sessionId={session.id} />
    </div>
  );
}

function KioskNotice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="text-xl">{children}</p>
    </div>
  );
}
