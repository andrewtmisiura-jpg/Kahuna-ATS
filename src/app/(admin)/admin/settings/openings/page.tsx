import Link from "next/link";
import { Notice } from "@/components/admin/settings/fields";
import { OpeningsTable } from "@/components/admin/settings/openings-table";
import { pageAccess } from "@/components/admin/settings/page-access";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { listOpenings, rolesWaitingOnBookingLink } from "@/server/services/config/openings";

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
  const [openings, waiting] = await Promise.all([listOpenings(db), rolesWaitingOnBookingLink(db)]);
  return (
    <div>
      {header}
      {waiting.map((r) => (
        <Notice key={r.roleId} tone="warning" className="mb-4">
          {r.roleName} invites people to one-on-one interviews, and no booking link is set yet. Add it in{" "}
          <Link href="/admin/settings/templates" className="font-medium underline">
            Settings, Message templates
          </Link>{" "}
          before you open its opening, or the one-on-one invites can&apos;t go out.
        </Notice>
      ))}
      <OpeningsTable openings={openings} />
      <p className="mt-6 text-xs text-muted-foreground">
        A new opening is added on its role&apos;s page in Settings, Roles and stages, as a draft; set its pay and dates here, then open it.
      </p>
    </div>
  );
}
