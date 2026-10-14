import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function TextingSettingsPage() {
  return (
    <div>
      <PageHeader title="Texting" description="Texts go out from 763-292-2259 only while texting is on." />
      <Card>
        <CardContent className="text-sm text-muted-foreground">This screen lands with the schema.</CardContent>
      </Card>
    </div>
  );
}
