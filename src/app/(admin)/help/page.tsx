import Link from "next/link";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HELP_GUIDES } from "@/content/help";

export const metadata = { title: "Help" };

// Three one-page staff guides, readable on a phone. Any signed-in staff member.
export default function HelpPage() {
  return (
    <div>
      <PageHeader title="Help" description="Three short guides. Each fits on a phone screen or a printed page." />
      <div className="grid gap-3 md:grid-cols-3">
        {HELP_GUIDES.map((guide, i) => (
          <Link key={guide.slug} href={`/help/${guide.slug}`}>
            <Card className="h-full hover:bg-accent/40">
              <CardHeader>
                <CardTitle>
                  <span className="text-muted-foreground">Guide {i + 1}.</span> {guide.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{guide.summary}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
