import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/db";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import { exportSummaries, listOpeningChoices } from "@/server/services/exports";
import { ExportsPanel } from "./exports-panel";

export const metadata: Metadata = { title: "Exports" };

// Admin-only, desktop-first: the list of CSV files with the opening and date
// filters. Downloads go through /api/admin/exports/<name>, which checks the role
// again and writes the audit row.
export default async function ExportsPage() {
  try {
    await requireRole("admin");
  } catch (error) {
    if (error instanceof NotSignedInError) redirect("/admin/sign-in");
    if (error instanceof AccessDeniedError) {
      return (
        <div>
          <PageHeader title="Exports" />
          <Card>
            <CardContent className="text-sm text-muted-foreground">Exports are for Admins. Ask an Admin if you need a file.</CardContent>
          </Card>
        </div>
      );
    }
    throw error;
  }

  const openings = await listOpeningChoices(db);
  return (
    <div>
      <PageHeader
        title="Exports"
        description="CSV files for Google Sheets or your own analysis. Every export is logged with your name, the file and the filters you used."
      />
      <ExportsPanel openings={openings} exports={exportSummaries()} />
    </div>
  );
}
