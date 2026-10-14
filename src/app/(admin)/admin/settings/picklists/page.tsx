import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function PicklistsSettingsPage() {
  return (
    <div>
      <PageHeader title="Picklists" description="Add, relabel or archive options. Crews are entered here." />
      <Card>
        <CardContent className="text-sm text-muted-foreground">This screen lands with the schema.</CardContent>
      </Card>
    </div>
  );
}
