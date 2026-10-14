import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HelpArticle } from "@/components/admin/settings/help-article";
import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { findHelpGuide, HELP_GUIDES } from "@/content/help";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: findHelpGuide(slug)?.title ?? "Help" };
}

export default async function HelpGuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = findHelpGuide(slug);
  if (!guide) notFound();
  const index = HELP_GUIDES.indexOf(guide);
  const others = HELP_GUIDES.filter((g) => g.slug !== guide.slug);

  return (
    <div>
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
        <Link href="/help">
          <ChevronLeft />
          Help
        </Link>
      </Button>
      <PageHeader title={guide.title} description={`Guide ${index + 1} of ${HELP_GUIDES.length}`} />
      <HelpArticle body={guide.body} />
      <nav className="mt-10 border-t pt-4 text-sm" aria-label="Other guides">
        <p className="mb-2 text-muted-foreground">Other guides</p>
        <ul className="space-y-1">
          {others.map((g) => (
            <li key={g.slug}>
              <Link href={`/help/${g.slug}`} className="underline-offset-4 hover:underline">
                {g.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
