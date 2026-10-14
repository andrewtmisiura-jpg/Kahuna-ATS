import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdminPage } from "@/components/admin/questions/admins-only";
import { formatCentral } from "@/components/admin/questions/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { listRoleFormSummaries } from "@/server/services/forms/editor";

export const metadata: Metadata = { title: "Questions" };

// One card per role: the live version and whether a draft is open.
export default async function QuestionsPage() {
  const denied = await requireAdminPage();
  if (denied) return denied;
  const summaries = await listRoleFormSummaries(db);

  return (
    <div>
      <PageHeader
        title="Questions"
        description="Each role has one live form and at most one draft. Publishing locks a new version; applications already started keep the version they began on."
      />
      <div className="grid gap-3 md:grid-cols-2">
        {summaries.map(({ role, published, draft }) => (
          <Link key={role.id} href={`/admin/questions/${role.id}`}>
            <Card className="h-full hover:bg-accent/40">
              <CardHeader>
                <CardTitle>{role.internalName}</CardTitle>
                <CardDescription>
                  {published
                    ? `Version ${published.version} live since ${formatCentral(published.publishedAt)}, ${published.itemCount} question${published.itemCount === 1 ? "" : "s"}.`
                    : "Nothing published yet."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {published ? <Badge>Published v{published.version}</Badge> : <Badge variant="outline">Not published</Badge>}
                {draft ? (
                  <Badge variant="secondary">
                    Draft v{draft.version}, {draft.itemCount} question{draft.itemCount === 1 ? "" : "s"}
                  </Badge>
                ) : (
                  <Badge variant="outline">No draft</Badge>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
        {summaries.length === 0 ? (
          <Card>
            <CardContent className="text-sm text-muted-foreground">No roles yet. Run the seed first.</CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
