import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import { staffActor } from "@/server/services/actor";
import { ExportError, runExport } from "@/server/services/exports";

// GET /api/admin/exports/<name>?opening=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
// Admin only. The service writes the audit row before the file is returned; the
// file comes back as a CSV attachment with a dated name.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  try {
    const user = await requireRole("admin");
    const { name } = await params;
    const query = request.nextUrl.searchParams;
    const file = await runExport(db, {
      name,
      filters: { openingId: query.get("opening"), from: query.get("from"), to: query.get("to") },
      actor: staffActor(user.id),
    });
    return new Response(file.body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
        "X-Export-Rows": String(file.rows),
      },
    });
  } catch (error) {
    if (error instanceof NotSignedInError || error instanceof AccessDeniedError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ExportError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }
}
