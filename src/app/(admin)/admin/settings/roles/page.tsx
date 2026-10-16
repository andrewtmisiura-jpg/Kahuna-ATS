import { pageAccess } from "@/components/admin/settings/page-access";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Roles and stages" };

// Settings > Roles and stages (Phase 2, interviews): a new role from a template, and the
// stage editor, where a stage in use keeps its key and milestone and is archived rather
// than remapped. Admin only. A placeholder until that build fills it in.
export default async function RolesSettingsPage() {
  const access = await pageAccess("admin");
  const header = <PageHeader title="Roles and stages" description="Add a role from a template and edit each role's pipeline stages." />;
  if (!access.ok) {
    return (
      <div>
        {header}
        {access.view}
      </div>
    );
  }
  return (
    <div>
      {header}
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Coming in this release</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          New roles from a template and the stage editor arrive here. Until then the two roles and their stages are as seeded.
        </CardContent>
      </Card>
    </div>
  );
}
