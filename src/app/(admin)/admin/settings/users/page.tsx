import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function UsersSettingsPage() {
  return (
    <div>
      <PageHeader title="Users" description="Staff emails with a role each. Disabling someone ends their sessions at once." />
      <Card>
        <CardContent className="text-sm text-muted-foreground">This screen lands with the schema.</CardContent>
      </Card>
    </div>
  );
}
