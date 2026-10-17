import { formatDay } from "@/components/admin/applicants/format";
import { formatTime } from "@/components/admin/sessions/format";
import { db } from "@/db";
import { isUuid } from "@/lib/uuid";
import { checkInClosedMessage, checkInState } from "@/server/services/sessions/attendees";
import { getSessionSummary } from "@/server/services/sessions/queries";
import { kioskAccess } from "../../_lib/kiosk-access";
import { CheckInForm } from "./check-in-form";

export const metadata = { title: "Check in" };

// The door check-in for one group session (Phase 2, sessions): each person arriving
// types a name and mobile, which become an attendee row (source door_checkin) matched
// to an application on an exact mobile. Open on the session's day (Central) while it
// is scheduled or held; any other day it says so in plain words.
export default async function CheckInPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const access = await kioskAccess();
  if (!access.ok) return access.view;
  const { sessionId } = await params;
  const session = isUuid(sessionId) ? await getSessionSummary(db, sessionId) : null;
  if (!session) {
    return <KioskNotice title="Check-in not found">This check-in page does not exist. Please ask a staff member for help.</KioskNotice>;
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
