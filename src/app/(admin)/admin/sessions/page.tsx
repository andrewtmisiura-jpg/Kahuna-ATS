import { pageAccess } from "@/components/admin/settings/page-access";
import { NewSessionButton, SessionsTable } from "@/components/admin/sessions/sessions-table";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { listSessionOpenings, listSessions } from "@/server/services/config/sessions";

export const metadata = { title: "Group sessions" };

// Group interview sessions: each gets its own QR code and shows on the applicants
// who scanned it. Admins and Hiring Managers.
export default async function SessionsPage() {
  const access = await pageAccess(["admin", "hiring_manager"]);
  if (!access.ok) {
    return (
      <div>
        <PageHeader title="Group sessions" />
        {access.view}
      </div>
    );
  }
  const [rows, openings] = await Promise.all([listSessions(db), listSessionOpenings(db)]);
  const openingOptions = openings.map((o) => ({ id: o.id, name: o.name, roleName: o.roleName, status: o.status }));
  return (
    <div>
      <PageHeader title="Group sessions" description="Each session gets its own QR code and shows on the applicants who scanned it.">
        <NewSessionButton openings={openingOptions} />
      </PageHeader>
      <SessionsTable rows={rows} />
      <p className="mt-4 text-xs text-muted-foreground">Applied shows submitted / started applications attributed to the session.</p>
    </div>
  );
}
