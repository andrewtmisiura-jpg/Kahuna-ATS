import type { NextRequest } from "next/server";
import { db } from "@/db";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import { getEmployer } from "@/server/services/config/employer";
import { getEntryCode } from "@/server/services/config/entry-codes-admin";
import { ConfigError } from "@/server/services/config/errors";
import { entryCodeUrl, qrFileName, qrPng, qrSvg } from "@/server/services/qr";

// GET /admin/codes/<id>/qr?format=svg|png[&inline=1]
// The QR picture for one entry code, encoding https://<hiring_host>/q/<code>.
// A download by default; inline=1 serves it for an <img>. Admins and Hiring Managers.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(["admin", "hiring_manager"]);
  } catch (error) {
    if (error instanceof NotSignedInError || error instanceof AccessDeniedError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }

  const { id } = await params;
  const code = await getEntryCode(db, id);
  if (!code) return new Response("No such code", { status: 404 });

  const query = request.nextUrl.searchParams;
  const format = query.get("format") === "png" ? "png" : "svg";
  const inline = query.get("inline") === "1";
  const disposition = `${inline ? "inline" : "attachment"}; filename="${qrFileName(code.code, format)}"`;

  try {
    const employer = await getEmployer(db);
    const url = entryCodeUrl(employer.hiringHost, code.code);
    const headers = { "Content-Disposition": disposition, "Cache-Control": "private, max-age=300" };
    if (format === "png") {
      const png = await qrPng(url);
      return new Response(new Uint8Array(png), { headers: { ...headers, "Content-Type": "image/png" } });
    }
    const svg = await qrSvg(url);
    return new Response(svg, { headers: { ...headers, "Content-Type": "image/svg+xml; charset=utf-8" } });
  } catch (error) {
    if (error instanceof ConfigError) return new Response(error.message, { status: error.status });
    throw error;
  }
}
