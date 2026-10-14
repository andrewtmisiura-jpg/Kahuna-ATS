import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AccessDeniedError, NotSignedInError, requireRole } from "@/server/auth/require-role";
import type { UserRole } from "@/server/auth/roles";
import type { SessionUser } from "@/server/auth/session";

export type PageAccess = { ok: true; user: SessionUser } | { ok: false; view: React.ReactElement };

// Page-level role check for the staff screens. The layout already redirects people
// without a session; this decides what a signed-in person may see. Server actions
// and route handlers still call requireRole themselves.
export async function pageAccess(allowed: UserRole | readonly UserRole[]): Promise<PageAccess> {
  try {
    return { ok: true, user: await requireRole(allowed) };
  } catch (error) {
    if (error instanceof NotSignedInError) redirect("/admin/sign-in");
    if (error instanceof AccessDeniedError) {
      const roles = typeof allowed === "string" ? [allowed] : allowed;
      return { ok: false, view: <AccessNotice adminOnly={roles.length === 1 && roles[0] === "admin"} message={error.message} /> };
    }
    throw error;
  }
}

export function AccessNotice({ adminOnly, message }: { adminOnly: boolean; message: string }) {
  const disabled = /disabled/i.test(message);
  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>{disabled ? "This account is disabled" : adminOnly ? "Admins only" : "No access"}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {disabled
          ? "Ask an Admin to re-enable your account under Settings, Users."
          : adminOnly
            ? "Only Admins can change this. Ask an Admin if you need something here changed."
            : "Your role does not include this screen. Ask an Admin if you need it."}
      </CardContent>
    </Card>
  );
}
