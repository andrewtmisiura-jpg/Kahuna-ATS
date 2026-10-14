import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const sections = ["Answers", "Stage history", "Notes", "Messages", "Consent"];

export default async function ApplicantProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <PageHeader title="Applicant" description={`Application ${id}`}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled>Move</Button>
          <Button size="sm" variant="outline" disabled>Close</Button>
          <Button size="sm" variant="outline" disabled>Hold</Button>
          <Button size="sm" variant="secondary" disabled>Hire now</Button>
        </div>
      </PageHeader>
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map((section) => (
          <Card key={section}>
            <CardHeader>
              <CardTitle>{section}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">Nothing recorded yet.</CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
