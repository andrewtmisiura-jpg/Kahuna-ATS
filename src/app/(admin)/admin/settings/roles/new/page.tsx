import Link from "next/link";
import { pageAccess } from "@/components/admin/settings/page-access";
import { NewRoleForm } from "@/components/admin/settings/roles/new-role-form";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { previewRoleCopies } from "@/server/services/config/roles";
import { listRoles } from "@/server/services/config/stages";

export const metadata = { title: "New role" };

// Settings > Roles and stages > New role: a copy of an existing role, made in one go.
// Admin only.
export default async function NewRolePage() {
  const access = await pageAccess("admin");
  const header = (
    <PageHeader
      title="New role"
      description="Start from the role most like the new one. Its stages and questions come across, ready to edit; scoring stays off."
    >
      <Link href="/admin/settings/roles" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        All roles
      </Link>
    </PageHeader>
  );
  if (!access.ok) {
    return (
      <div>
        {header}
        {access.view}
      </div>
    );
  }
  const [roles, previews] = await Promise.all([listRoles(db), previewRoleCopies(db)]);
  return (
    <div>
      {header}
      <NewRoleForm
        templates={roles.map((r) => ({
          id: r.id,
          internalName: r.internalName,
          title: r.title,
          preview: previews.find((p) => p.roleId === r.id) ?? null,
        }))}
      />
    </div>
  );
}
