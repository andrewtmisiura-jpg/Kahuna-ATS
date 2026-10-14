import { LegalArticle, LegalMissing } from "@/components/applicant/legal-article";
import { db } from "@/db";
import { currentLegalText, renderMarkdown } from "@/server/services/legal";

export const metadata = { title: "Privacy policy" };
export const dynamic = "force-dynamic";

// Served from the current published privacy_policy version.
export default async function PrivacyPage() {
  const text = await currentLegalText(db, "privacy_policy");
  if (!text) return <LegalMissing title="Privacy policy" />;
  return <LegalArticle html={renderMarkdown(text.body)} />;
}
