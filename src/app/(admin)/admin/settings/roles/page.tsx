import type { Route } from "next";
import Link from "next/link";
import { pageAccess } from "@/components/admin/settings/page-access";
import { TAP } from "@/components/admin/settings/roles/format";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { listRoleSummaries } from "@/server/services/config/roles";

export const metadata = { title: "Roles and stages" };

// Settings > Roles and stages (Phase 2, interviews): every role with its stages, form
// and openings, and New role, which copies a role as a template. Each role's page holds
// the stage editor and its openings. Admin only.
export default async function RolesSettingsPage() {
  const access = await pageAccess("admin");
  const header = (
    <PageHeader title="Roles and stages" description="Add a role from a template and edit each role's pipeline stages.">
      {access.ok ? (
        <Button asChild className={TAP}>
          <Link href="/admin/settings/roles/new">New role</Link>
        </Button>
      ) : null}
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
  const roles = await listRoleSummaries(db);
  return (
    <div>
      {header}
      <div className="grid gap-3 md:grid-cols-2">
        {roles.map((role) => {
          const open = role.openings.find((o) => o.status === "open");
          return (
            <Link key={role.id} href={`/admin/settings/roles/${role.id}` as Route}>
              <Card className="h-full hover:bg-accent/40">
                <CardHeader>
                  <CardTitle>{role.internalName}</CardTitle>
                  <CardDescription>
                    {role.title === role.internalName ? "Applicants see the same title." : `Applicants see "${role.title}".`} Key {role.key}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Badge variant="outline">
                    {role.stageCount} stage{role.stageCount === 1 ? "" : "s"}
                  </Badge>
                  {role.form.published ? <Badge>Form v{role.form.published} live</Badge> : <Badge variant="outline">No live form</Badge>}
                  {role.form.draft ? <Badge variant="secondary">Draft v{role.form.draft}</Badge> : null}
                  {open ? <Badge>{open.name} open</Badge> : <Badge variant="outline">{role.openings.length === 0 ? "No opening" : "No open opening"}</Badge>}
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {roles.length === 0 ? (
          <Card>
            <CardContent className="text-sm text-muted-foreground">No roles yet. Run the seed first.</CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
