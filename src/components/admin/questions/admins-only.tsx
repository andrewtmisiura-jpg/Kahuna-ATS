import { redirect } from "next/navigation";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";

// The question editor is Admin only. Pages call this first and return what it
// gives back, so a Hiring manager sees a plain message instead of an error.

export async function requireAdminPage(): Promise<React.ReactElement | null> {
  try {
    await requireRole("admin");
    return null;
  } catch (error) {
    if (error instanceof NotSignedInError) redirect("/admin/sign-in");
    if (error instanceof AccessDeniedError) {
      return (
        <div>
          <PageHeader title="Questions" />
          <Card>
            <CardContent className="text-sm text-muted-foreground">Only an Admin can view or change the application questions.</CardContent>
          </Card>
        </div>
      );
    }
    throw error;
  }
}
