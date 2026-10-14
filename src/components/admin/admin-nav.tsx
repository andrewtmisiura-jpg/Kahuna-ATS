"use client";

import { CalendarDays, CircleHelp, Columns3, Download, List, ListChecks, QrCode, Settings } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type NavItem = {
  href: Route;
  label: string;
  icon: typeof List;
  // Shown in the phone bottom bar; there is room for five.
  onPhone: boolean;
};

const items: NavItem[] = [
  { href: "/admin", label: "List", icon: List, onPhone: true },
  { href: "/admin/board", label: "Board", icon: Columns3, onPhone: true },
  { href: "/admin/sessions", label: "Sessions", icon: CalendarDays, onPhone: true },
  { href: "/admin/codes", label: "Codes", icon: QrCode, onPhone: true },
  { href: "/admin/questions", label: "Questions", icon: ListChecks, onPhone: false },
  { href: "/admin/exports", label: "Exports", icon: Download, onPhone: false },
  { href: "/admin/settings", label: "Settings", icon: Settings, onPhone: true },
  { href: "/help", label: "Help", icon: CircleHelp, onPhone: false },
];

function isActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin" || pathname.startsWith("/admin/applicants");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminSidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden w-56 shrink-0 border-r bg-sidebar md:flex md:flex-col">
      <div className="px-5 py-4 text-lg font-semibold tracking-tight">Tidepool</div>
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {items.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent",
              isActive(pathname, href) && "bg-sidebar-accent font-medium",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

export function AdminBottomNav() {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
      {items
        .filter((item) => item.onPhone)
        .map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex flex-col items-center gap-1 py-2 text-[11px] text-muted-foreground",
              isActive(pathname, href) && "text-foreground",
            )}
          >
            <Icon className="size-5" />
            {label}
          </Link>
        ))}
    </nav>
  );
}
