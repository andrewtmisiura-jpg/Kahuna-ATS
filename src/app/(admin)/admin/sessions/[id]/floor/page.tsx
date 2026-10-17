import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCentralDateTime } from "@/components/admin/settings/format";
import { pageAccess } from "@/components/admin/settings/page-access";
import { FloorView } from "@/components/admin/sessions/floor-view";
import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { isUuid } from "@/lib/uuid";
import { matchSessionByPhone } from "@/server/services/sessions/matching";
import { getSessionSummary, loadSessionAttendees } from "@/server/services/sessions/queries";
import { listStarReasons } from "@/server/services/sessions/stars";

export const metadata = { title: "Floor view" };

// The floor view of one group session (Phase 2, sessions): on a phone during the
// session, staff star or flag the people on the list. Admins and Hiring Managers.
export default async function FloorPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await pageAccess(["admin", "hiring_manager"]);
  if (!access.ok) return access.view;
  const { id } = await params;
  const session = isUuid(id) ? await getSessionSummary(db, id) : null;
  if (!session) notFound();

  // People apply during and after the session, so new phone matches are made first.
  await matchSessionByPhone(db, session.id);
  const [{ attendees }, reasons] = await Promise.all([loadSessionAttendees(db, session.id), listStarReasons(db, session.id)]);

  return (
    <div className="mx-auto max-w-xl">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
        <Link href={`/admin/sessions/${session.id}`}>
          <ChevronLeft />
          Session
        </Link>
      </Button>
      <PageHeader title="Floor view" description={`${formatCentralDateTime(session.startsAt)}, ${session.locationName}. Tap Star or Concern next to a name.`} />
      {session.status === "canceled" ? (
        <p className="text-sm text-muted-foreground">This session was canceled.</p>
      ) : (
        <FloorView attendees={attendees} reasons={reasons} userId={access.user.id} />
      )}
    </div>
  );
}
