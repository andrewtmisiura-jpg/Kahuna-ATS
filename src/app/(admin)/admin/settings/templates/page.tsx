import { pageAccess } from "@/components/admin/settings/page-access";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Message templates" };

// Settings > Message templates (Phase 2, templates): the wording of each text and email by
// purpose and channel, with the variables it may use, and the one-on-one booking link.
// Admin only. A placeholder until that build fills it in.
export default async function TemplatesSettingsPage() {
  const access = await pageAccess("admin");
  const header = <PageHeader title="Message templates" description="The wording of every text and email Tidepool sends." />;
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
          The template editor arrives here, with the one-on-one invite, the one-on-one reminder, the decline and the status update. Until then the seeded templates send as they are.
        </CardContent>
      </Card>
    </div>
  );
}
