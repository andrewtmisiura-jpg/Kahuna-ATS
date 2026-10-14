import { NextResponse } from "next/server";
import { db } from "@/db";
import { checkHealth } from "@/server/services/health";

// Never prerendered: the uptime monitor and Railway's healthcheck need a live answer.
export const dynamic = "force-dynamic";

export async function GET() {
  const report = await checkHealth(db);
  return NextResponse.json(report, { status: report.ok ? 200 : 503 });
}
