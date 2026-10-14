import { Download, Printer } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { entryCodeShortUrl, entryCodeUrl } from "@/server/services/qr";

// The QR for one entry code: the picture, the address it encodes, downloads as SVG
// and PNG, and the printable sheet. Used on the session page and the codes list.

export function qrDownloadHref(codeId: string, format: "svg" | "png", inline = false) {
  return `/admin/codes/${codeId}/qr?format=${format}${inline ? "&inline=1" : ""}`;
}

export function QrCard({
  code,
  hiringHost,
  title = "QR code",
  description,
  scansToday,
  scansTotal,
}: {
  code: { id: string; code: string; closedAt: Date | null };
  hiringHost: string;
  title?: string;
  description?: string;
  scansToday?: number;
  scansTotal?: number;
}) {
  const url = entryCodeUrl(hiringHost, code.code);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          {code.closedAt ? <Badge variant="outline">Closed</Badge> : null}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-[12rem_1fr] sm:items-start">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrDownloadHref(code.id, "svg", true)} alt={`QR code for ${code.code}`} width={192} height={192} className="rounded-md border bg-white p-2" />
        <div className="grid gap-3 text-sm">
          <div>
            <div className="font-mono text-2xl font-semibold tracking-wider">{code.code}</div>
            <div className="break-all text-muted-foreground">{entryCodeShortUrl(hiringHost, code.code)}</div>
            <div className="sr-only">{url}</div>
          </div>
          {scansToday !== undefined ? (
            <div className="text-muted-foreground">
              Scans: <span className="font-medium text-foreground">{scansToday}</span> today, <span className="font-medium text-foreground">{scansTotal ?? 0}</span> in total
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <a href={qrDownloadHref(code.id, "svg")} download>
                <Download />
                SVG (print)
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={qrDownloadHref(code.id, "png")} download>
                <Download />
                PNG (slide)
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={`/admin/codes/${code.id}/print`}>
                <Printer />
                Printable sheet
              </Link>
            </Button>
          </div>
          {code.closedAt ? (
            <p className="text-xs text-muted-foreground">This code is closed: a scan shows the role page instead of this session or opening.</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
