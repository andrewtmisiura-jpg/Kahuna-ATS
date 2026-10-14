import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCentralDateTime } from "@/components/admin/settings/format";
import { pageAccess } from "@/components/admin/settings/page-access";
import { PrintButton } from "@/components/admin/settings/print-button";
import { qrDownloadHref } from "@/components/admin/settings/qr-card";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { getEmployer } from "@/server/services/config/employer";
import { getEntryCode } from "@/server/services/config/entry-codes-admin";
import { entryCodeShortUrl } from "@/server/services/qr";

export const metadata = { title: "Printable QR sheet" };

// One letter-size sheet per code: the QR large, the short address under it, and
// what it is for. The staff shell is hidden when printing.
export default async function PrintCodePage({ params }: { params: Promise<{ id: string }> }) {
  const access = await pageAccess(["admin", "hiring_manager"]);
  if (!access.ok) return access.view;
  const { id } = await params;
  const [code, employer] = await Promise.all([getEntryCode(db, id), getEmployer(db)]);
  if (!code) notFound();
  const shortUrl = entryCodeShortUrl(employer.hiringHost, code.code);
  const heading = code.sessionId
    ? `${code.roleName}: group interview, ${formatCentralDateTime(code.sessionStartsAt)}`
    : (code.openingName ?? code.roleName);

  return (
    <div>
      <style>{`@media print { aside, header, nav, .print-hide { display: none !important; } main { padding: 0 !important; } @page { margin: 0.75in; } }`}</style>
      <div className="print-hide mb-6 flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/admin/codes">
            <ChevronLeft />
            Entry codes
          </Link>
        </Button>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Scan it once on a phone before printing in bulk.</span>
          <PrintButton />
        </div>
      </div>
      <section className="mx-auto flex max-w-2xl flex-col items-center gap-6 bg-white px-6 py-10 text-center text-black">
        <h1 className="text-3xl font-bold tracking-tight">Apply here</h1>
        <p className="text-xl">{heading}</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrDownloadHref(code.id, "svg", true)} alt={`QR code for ${code.code}`} className="aspect-square w-full max-w-sm" />
        <p className="text-lg">Scan the code with your phone camera, or type this address:</p>
        <p className="break-all font-mono text-2xl font-semibold">{shortUrl}</p>
        <p className="text-base text-neutral-600">
          It takes about five minutes. You can finish it here or at home; it saves as you go.
        </p>
        <p className="print-hide text-xs text-muted-foreground">
          Code {code.code}: {code.label}
          {code.closedAt ? ". This code is closed, so scans show the role page." : ""}
        </p>
      </section>
    </div>
  );
}
