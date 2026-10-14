import { headers } from "next/headers";
import { LostLinkForm } from "@/components/applicant/lost-link-form";
import { APPLICANT_COPY } from "@/components/applicant/status-copy";
import { turnstileSiteKey } from "@/server/actions/applicant/turnstile";

export const metadata = { title: "Lost your link?" };
export const dynamic = "force-dynamic";

// Mobile plus email; always the same neutral answer; a fresh link only on a match.
export default async function LostLinkPage() {
  const nonce = (await headers()).get("x-nonce");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{APPLICANT_COPY.lostLinkHeading}</h1>
      <p className="text-muted-foreground">{APPLICANT_COPY.lostLinkHelp}</p>
      <LostLinkForm turnstileSiteKey={turnstileSiteKey()} nonce={nonce} />
    </div>
  );
}
