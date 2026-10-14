import { LegalArticle, LegalMissing } from "@/components/applicant/legal-article";
import { db } from "@/db";
import { currentLegalText, renderMarkdown } from "@/server/services/legal";

export const metadata = { title: "SMS terms" };
export const dynamic = "force-dynamic";

// Served from the current published sms_terms version.
export default async function SmsTermsPage() {
  const text = await currentLegalText(db, "sms_terms");
  if (!text) return <LegalMissing title="SMS terms" />;
  return <LegalArticle html={renderMarkdown(text.body)} />;
}
