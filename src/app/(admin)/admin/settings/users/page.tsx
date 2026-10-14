import { pageAccess } from "@/components/admin/settings/page-access";
import { UsersTable } from "@/components/admin/settings/users-table";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { listUsers } from "@/server/services/config/users-admin";

export const metadata = { title: "Users" };

// Settings > Users: the sign-in allowlist. Admin only.
export default async function UsersSettingsPage() {
  const access = await pageAccess("admin");
  const header = (
    <PageHeader
      title="Users"
      description="Who can sign in, with a role each. Disabling someone is the offboarding step: their sessions end at once."
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
  const users = await listUsers(db);
  return (
    <div>
      {header}
      <UsersTable
        currentUserId={access.user.id}
        users={users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          status: u.status,
          lastSignInAt: u.lastSignInAt,
          googleSub: u.googleSub,
        }))}
      />
    </div>
  );
}
