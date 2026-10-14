import { LegalArticle, LegalMissing } from "@/components/applicant/legal-article";
import { db } from "@/db";
import { currentLegalText, renderMarkdown } from "@/server/services/legal";

export const metadata = { title: "Text messages" };
export const dynamic = "force-dynamic";

// The permanent opt-in page: served from the current published opt_in_page
// version (pnpm legal:publish opt_in_page content/legal/opt-in-page.md).
export default async function TextMessagesPage() {
  const text = await currentLegalText(db, "opt_in_page");
  if (!text) return <LegalMissing title="Text messages from Kahuna Window Cleaning Hiring" />;
  return <LegalArticle html={renderMarkdown(text.body)} />;
}
