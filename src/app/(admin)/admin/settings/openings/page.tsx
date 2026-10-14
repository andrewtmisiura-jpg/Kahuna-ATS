import { OpeningsTable } from "@/components/admin/settings/openings-table";
import { pageAccess } from "@/components/admin/settings/page-access";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { listOpenings } from "@/server/services/config/openings";

export const metadata = { title: "Openings" };

// Settings > Openings: one role in one season. Admin only.
export default async function OpeningsSettingsPage() {
  const access = await pageAccess("admin");
  const header = (
    <PageHeader
      title="Openings"
      description="One role in one season. An opening cannot open without pay text and an opens-on date, and one opening per role is open at a time."
    />
  );
  if (!access.ok) {
    return (
      <div>
        {header}
        {access.view}
      </div>
    );
  }
  const openings = await listOpenings(db);
  return (
    <div>
      {header}
      <OpeningsTable openings={openings} />
      <p className="mt-6 text-xs text-muted-foreground">
        New roles and their openings arrive with the Phase 2 Settings screens; the two launch openings come from the seed.
      </p>
    </div>
  );
}
