import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { getSessionUser } from "@/server/auth/session";

export const metadata: Metadata = {
  title: { default: "Tidepool", template: "%s | Tidepool" },
};

// Staff pages. The redirect here is for people; data access is guarded by requireRole.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/admin/sign-in");
  return <AdminShell user={user}>{children}</AdminShell>;
}
