import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default function QuestionsPage() {
  return (
    <div>
      <PageHeader title="Questions" description="Edit a draft, then publish a locked form version. Applications already started keep theirs." />
      <Card>
        <CardContent className="text-sm text-muted-foreground">The question editor lands with the schema.</CardContent>
      </Card>
    </div>
  );
}
