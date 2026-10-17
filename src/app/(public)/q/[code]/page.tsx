import { headers } from "next/headers";
import { LandingForm } from "@/components/applicant/landing-form";
import { FormNotice } from "@/components/applicant/field-error";
import { APPLICANT_COPY } from "@/components/applicant/status-copy";
import { db } from "@/db";
import { turnstileSiteKey } from "@/server/actions/applicant/turnstile";
import { recordScan, resolveEntryCode } from "@/server/services/entry-codes";
import { currentLegalText, renderMarkdown, splitConsentText } from "@/server/services/legal";

// Entry code resolver and role landing page: every QR and shared link lands here.
// The code is looked up and its scan counted; a closed code falls back to the
// role's open opening; an unknown code shows a plain "not active" page.

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const resolution = await resolveEntryCode(db, code);
  return { title: resolution.status === "not_found" ? "Link not active" : `Apply: ${resolution.role.title}` };
}

export default async function EntryCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const resolution = await resolveEntryCode(db, code);

  if (resolution.status === "not_found") {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">{APPLICANT_COPY.linkNotActive}</h1>
        <p className="text-muted-foreground">
          Check the link you were given, or call or text 763-292-2259 and we will help.
        </p>
      </div>
    );
  }

  await recordScan(db, resolution.entryCode.id);
  const { role, opening } = resolution;

  if (!opening) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">{role.title}</h1>
        <FormNotice>{APPLICANT_COPY.notOpen}</FormNotice>
      </div>
    );
  }

  // The newest AI notice, so a new version reaches applicants without a form publish. The
  // form posts back which one it showed (scoring/disclosure.ts proves what each applicant read).
  const [notice, consent, aiDisclosure, nonce] = await Promise.all([
    currentLegalText(db, "landing_notice"),
    currentLegalText(db, "sms_consent"),
    currentLegalText(db, "ai_disclosure"),
    headers().then((h) => h.get("x-nonce")),
  ]);

  if (!consent) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">{role.title}</h1>
        <FormNotice>{APPLICANT_COPY.notOpen}</FormNotice>
      </div>
    );
  }
  const consentText = splitConsentText(consent.body);
  const disclosureHtml = renderMarkdown(consentText.disclosure).replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">{role.title}</h1>
        <p className="text-sm text-muted-foreground">{opening.name}</p>
        {role.summary ? <p>{role.summary}</p> : null}
        {opening.payText ? (
          <div>
            <h2 className="text-sm font-semibold">Pay</h2>
            <p className="whitespace-pre-line">{opening.payText}</p>
          </div>
        ) : null}
        {opening.benefitsText ? (
          <div>
            <h2 className="text-sm font-semibold">Benefits</h2>
            <p className="whitespace-pre-line">{opening.benefitsText}</p>
          </div>
        ) : null}
        <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
          {notice ? <p>{notice.body}</p> : null}
          {aiDisclosure ? <p>{aiDisclosure.body}</p> : null}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Start your application</h2>
        <p className="text-sm text-muted-foreground">
          About five minutes. Your answers save as you go, and your personal link lets you finish on any device.
        </p>
        <LandingForm
          code={resolution.entryCode.code}
          consentVersionId={consent.id}
          consentLabel={consentText.label}
          consentDisclosureHtml={disclosureHtml}
          aiDisclosureVersionId={aiDisclosure?.id ?? null}
          turnstileSiteKey={turnstileSiteKey()}
          nonce={nonce}
        />
      </section>
    </div>
  );
}
