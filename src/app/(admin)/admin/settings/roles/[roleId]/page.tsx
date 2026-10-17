import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pageAccess } from "@/components/admin/settings/page-access";
import { RoleOpenings } from "@/components/admin/settings/roles/role-openings";
import { StageEditor } from "@/components/admin/settings/roles/stage-editor";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { MILESTONES } from "@/db/schema";
import { isUuid } from "@/lib/uuid";
import { listRoleOpenings, listRoleSummaries } from "@/server/services/config/roles";
import { listStagesForEditor, MILESTONE_LABELS } from "@/server/services/config/stages";

export const metadata = { title: "Roles and stages" };

// One role in Settings > Roles and stages: its stages in the stage editor, where its
// questions are edited, and its openings. Right after New role it lists the next steps.
// Admin only.
export default async function RoleSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ roleId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ roleId }, query] = await Promise.all([params, searchParams]);
  const access = await pageAccess("admin");
  if (!access.ok) {
    return (
      <div>
        <PageHeader title="Roles and stages" />
        {access.view}
      </div>
    );
  }
  if (!isUuid(roleId)) notFound();
  const summary = (await listRoleSummaries(db)).find((r) => r.id === roleId);
  if (!summary) notFound();
  const [stages, openings] = await Promise.all([listStagesForEditor(db, roleId), listRoleOpenings(db, roleId)]);
  const created = query.created === "1";
  const questionsHref = `/admin/questions/${roleId}` as Route;

  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader
        title={summary.internalName}
        description={`${summary.title === summary.internalName ? "Applicants see the same title." : `Applicants see "${summary.title}".`} Key ${summary.key}.`}
      >
        <Link href="/admin/settings/roles" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          All roles
        </Link>
      </PageHeader>

      {created ? (
        <Card className="border-emerald-300 bg-emerald-50/60">
          <CardHeader>
            <CardTitle>Role created</CardTitle>
            <CardDescription>Scoring is off and nothing is open to applicants yet. Next:</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>
                <Link href={questionsHref} className="underline underline-offset-4">
                  Edit the questions
                </Link>{" "}
                and publish them with a reason.
              </li>
              <li>Check the stages below: rename, reorder or archive what this role does not use.</li>
              <li>
                Add an opening below, then set its pay and dates and open it in{" "}
                <Link href="/admin/settings/openings" className="underline underline-offset-4">
                  Settings, Openings
                </Link>
                .
              </li>
              <li>
                For AI scores,{" "}
                <Link href={`/admin/settings/scoring/${roleId}` as Route} className="underline underline-offset-4">
                  write a rubric
                </Link>{" "}
                once the questions are published, then turn scoring on in Settings, AI scoring.
              </li>
            </ol>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Stages</CardTitle>
          <CardDescription>The steps an application moves through, in order. Applicants see only the label on their status page.</CardDescription>
        </CardHeader>
        <CardContent>
          <StageEditor
            roleId={roleId}
            stages={stages.map((s) => ({
              id: s.id,
              key: s.key,
              name: s.name,
              publicLabel: s.publicLabel,
              milestone: s.milestone,
              isSystem: s.isSystem,
              showOnBoard: s.showOnBoard,
              archivedAt: s.archivedAt,
              inUse: s.inUse,
              openCount: s.openCount,
            }))}
            milestones={MILESTONES.map((m) => ({ value: m, label: MILESTONE_LABELS[m] }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Questions</CardTitle>
          <CardDescription>
            {summary.form.published ? `Version ${summary.form.published} is live.` : "Nothing is published yet, so applicants cannot apply."}
            {summary.form.draft ? ` Draft version ${summary.form.draft} is open.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={questionsHref} className="text-sm underline underline-offset-4">
            Edit the questions
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Openings</CardTitle>
          <CardDescription>One opening per season. Only one can be open at a time.</CardDescription>
        </CardHeader>
        <CardContent>
          <RoleOpenings roleId={roleId} openings={openings} />
        </CardContent>
      </Card>
    </div>
  );
}
