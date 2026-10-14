import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function OpeningsSettingsPage() {
  return (
    <div>
      <PageHeader title="Openings" description="One role in one season. An opening cannot open without pay text and an opens-on date." />
      <Card>
        <CardContent className="text-sm text-muted-foreground">This screen lands with the schema.</CardContent>
      </Card>
    </div>
  );
}
