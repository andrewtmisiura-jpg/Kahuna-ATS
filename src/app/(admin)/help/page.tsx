import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const guides = [
  { title: "Reviewing on your phone", body: "Open the list, tap an applicant, use Move, Close, Hold or Hire now." },
  { title: "Admin screens on desktop", body: "The board, question editor, entry codes and Settings." },
  { title: "Texts and consent", body: "What a STOP does, how to record an opt-out, and the unhandled texts badge." },
];

export const metadata = { title: "Help" };

export default function HelpPage() {
  return (
    <div>
      <PageHeader title="Help" description="Three one-page guides." />
      <div className="grid gap-3 md:grid-cols-3">
        {guides.map((guide) => (
          <Card key={guide.title}>
            <CardHeader>
              <CardTitle>{guide.title}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{guide.body}</CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
