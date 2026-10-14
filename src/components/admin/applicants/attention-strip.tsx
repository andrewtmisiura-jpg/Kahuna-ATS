import type { Route } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { AttentionCounts } from "@/server/services/applications/queries";

// Things needing attention: unhandled texts, open contact conflicts and
// returning applicants marked not eligible for rehire (PLAN.md, list view).

export function AttentionStrip({ counts, openingId }: { counts: AttentionCounts; openingId: string }) {
  const items: { label: string; count: number; href?: Route; tone: "default" | "destructive" }[] = [
    { label: "Unhandled texts", count: counts.unhandledTexts, tone: "default" },
    { label: "Contact conflicts", count: counts.openConflicts, href: `/admin?opening=${openingId}&conflicts=1` as Route, tone: "default" },
    { label: "Not rehire eligible", count: counts.notRehireEligible, href: `/admin?opening=${openingId}&status=open` as Route, tone: "destructive" },
  ];
  const active = items.filter((item) => item.count > 0);
  if (active.length === 0) {
    return <p className="mb-4 text-sm text-muted-foreground">Nothing needs attention.</p>;
  }
  return (
    <div className="mb-4 flex flex-wrap gap-2" aria-label="Needs attention">
      {active.map((item) => {
        const badge = (
          <Badge variant={item.tone === "destructive" ? "destructive" : "secondary"} className="px-2.5 py-1 text-xs">
            {item.label} ({item.count})
          </Badge>
        );
        return item.href ? (
          <Link key={item.label} href={item.href}>
            {badge}
          </Link>
        ) : (
          <span key={item.label}>{badge}</span>
        );
      })}
    </div>
  );
}
