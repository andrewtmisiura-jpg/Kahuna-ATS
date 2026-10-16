import { pageAccess } from "@/components/admin/settings/page-access";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "AI scoring" };

// Settings > AI scoring (Phase 2, rubric): each role's rubric and scoring mode (off,
// hidden or visible), Try it with sample answers, and the AI disclosure as a legal text
// version. Admin only. A placeholder until that build fills it in.
export default async function ScoringSettingsPage() {
  const access = await pageAccess("admin");
  const header = <PageHeader title="AI scoring" description="Rubrics, Try it and the scoring mode for each role. A person makes every decision." />;
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
          The rubric editor, Try it and the scoring mode arrive here. Until then scoring is off for both roles.
        </CardContent>
      </Card>
    </div>
  );
}
