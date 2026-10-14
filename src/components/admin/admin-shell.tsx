import { Badge } from "@/components/ui/badge";
import type { SessionUser } from "@/server/auth/session";
import { AdminBottomNav, AdminSidebar } from "./admin-nav";
import { SignOutButton } from "./sign-out-button";

// Staff layout: sidebar on desktop, bottom bar on phones, one header with who is signed in.
export function AdminShell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background px-4 py-2 md:px-8">
          <span className="text-base font-semibold tracking-tight md:hidden">Tidepool</span>
          <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <span className="truncate">{user.email}</span>
            {user.isDevBypass ? <Badge variant="secondary">dev sign-in</Badge> : <SignOutButton />}
          </div>
        </header>
        <main className="flex-1 px-4 py-4 pb-24 md:px-8 md:py-6 md:pb-8">{children}</main>
      </div>
      <AdminBottomNav />
    </div>
  );
}
