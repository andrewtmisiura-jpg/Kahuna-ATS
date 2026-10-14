import { EntryCodesTable } from "@/components/admin/settings/entry-codes-table";
import { formatCentralDate } from "@/components/admin/settings/format";
import { pageAccess } from "@/components/admin/settings/page-access";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { getEmployer } from "@/server/services/config/employer";
import { CREATABLE_CHANNELS, listEntryCodes } from "@/server/services/config/entry-codes-admin";
import { listOpenings } from "@/server/services/config/openings";
import { listSessions } from "@/server/services/config/sessions";
import { listRoles } from "@/server/services/config/stages";

export const metadata = { title: "Entry codes" };

// Entry codes: every printed QR or shared link. Admins and Hiring Managers.
export default async function EntryCodesPage() {
  const access = await pageAccess(["admin", "hiring_manager"]);
  const header = <PageHeader title="Entry codes" description="Every printed QR or shared link. Close a code instead of reprinting." />;
  if (!access.ok) {
    return (
      <div>
        {header}
        {access.view}
      </div>
    );
  }
  const [rows, roles, openings, sessions, employer] = await Promise.all([
    listEntryCodes(db),
    listRoles(db),
    listOpenings(db),
    listSessions(db),
    getEmployer(db),
  ]);
  return (
    <div>
      {header}
      <EntryCodesTable
        rows={rows}
        roles={roles.map((r) => ({ id: r.id, name: r.internalName }))}
        openings={openings.map((o) => ({ id: o.id, name: o.name, roleId: o.roleId, status: o.status }))}
        sessions={sessions
          .filter((s) => s.status !== "canceled")
          .map((s) => ({ id: s.id, openingId: s.openingId, label: `${formatCentralDate(s.startsAt)} at ${s.locationName}` }))}
        channels={CREATABLE_CHANNELS}
        hiringHost={employer.hiringHost}
      />
    </div>
  );
}
