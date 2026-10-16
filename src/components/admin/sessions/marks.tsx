import { Star, TriangleAlert } from "lucide-react";
import { formatDateTime } from "@/components/admin/applicants/format";
import { cn } from "@/lib/utils";
import type { StarMark } from "@/db/schema";
import type { AttendeeMark } from "@/server/services/sessions/queries";
import { MARK_LABELS } from "./format";

// Stars and concerns as the session page, the floor view and the profile show them.
// No hooks, so server and client components both use it.

export function MarkIcon({ mark, filled = true, className }: { mark: StarMark; filled?: boolean; className?: string }) {
  return mark === "star" ? (
    <Star aria-hidden className={cn("size-4 shrink-0 text-amber-500", filled && "fill-amber-400", className)} />
  ) : (
    <TriangleAlert aria-hidden className={cn("size-4 shrink-0 text-red-600", className)} />
  );
}

export function countMarks(marks: AttendeeMark[]) {
  return {
    star: marks.filter((m) => m.mark === "star").length,
    concern: marks.filter((m) => m.mark === "concern").length,
  };
}

// "2 stars, 1 concern" as two small icons with numbers.
export function MarkCounts({ marks, className }: { marks: AttendeeMark[]; className?: string }) {
  const counts = countMarks(marks);
  const label = `${counts.star} ${counts.star === 1 ? "star" : "stars"}, ${counts.concern} ${counts.concern === 1 ? "concern" : "concerns"}`;
  return (
    <span className={cn("inline-flex items-center gap-3 text-sm tabular-nums", className)} title={label}>
      <span className="sr-only">{label}</span>
      <span aria-hidden className="inline-flex items-center gap-1">
        <MarkIcon mark="star" filled={counts.star > 0} />
        {counts.star}
      </span>
      <span aria-hidden className="inline-flex items-center gap-1">
        <MarkIcon mark="concern" />
        {counts.concern}
      </span>
    </span>
  );
}

// One line per mark: what it is, the reason, the note and who gave it.
export function MarksList({ marks, showTime = false, className }: { marks: AttendeeMark[]; showTime?: boolean; className?: string }) {
  if (marks.length === 0) return null;
  return (
    <ul className={cn("grid gap-1 text-sm", className)}>
      {marks.map((m) => (
        <li key={m.id} className="flex items-start gap-2">
          <MarkIcon mark={m.mark} className="mt-0.5" />
          <span className="min-w-0 break-words">
            <span className="font-medium">{MARK_LABELS[m.mark]}</span>
            {m.reasonLabel ? `: ${m.reasonLabel}` : null}
            {m.note ? <span> &ldquo;{m.note}&rdquo;</span> : null}
            <span className="text-muted-foreground">
              {" "}
              {m.userName}
              {showTime ? `, ${formatDateTime(m.createdAt)}` : null}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
