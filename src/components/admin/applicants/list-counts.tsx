import type { ListCounts } from "@/server/services/applications/queries";
import { percent } from "./format";

// Started, in progress, submitted and the rate, with the same per entry code
// behind a disclosure (PLAN.md, list view).

export function ListCountsCards({ counts }: { counts: ListCounts }) {
  const cells = [
    { label: "Started", value: String(counts.total.started) },
    { label: "In progress", value: String(counts.total.inProgress) },
    { label: "Submitted", value: String(counts.total.submitted) },
    { label: "Submit rate", value: percent(counts.total.submitRate) },
  ];
  return (
    <div className="mb-4">
      <dl className="grid grid-cols-4 gap-2">
        {cells.map((cell) => (
          <div key={cell.label} className="rounded-lg border bg-card px-2 py-2 text-center">
            <dt className="text-[11px] text-muted-foreground">{cell.label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{cell.value}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">By entry code</summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 font-medium">Code</th>
              <th className="py-1 text-right font-medium">Started</th>
              <th className="py-1 text-right font-medium">In progress</th>
              <th className="py-1 text-right font-medium">Submitted</th>
              <th className="py-1 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody>
            {counts.byEntryCode.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-2 text-muted-foreground">
                  Nothing yet.
                </td>
              </tr>
            ) : (
              counts.byEntryCode.map((row) => (
                <tr key={row.entryCodeId ?? "none"} className="border-t">
                  <td className="py-1">
                    {row.code ? <span className="font-mono text-xs">{row.code}</span> : null} <span className="text-muted-foreground">{row.label}</span>
                  </td>
                  <td className="py-1 text-right tabular-nums">{row.started}</td>
                  <td className="py-1 text-right tabular-nums">{row.inProgress}</td>
                  <td className="py-1 text-right tabular-nums">{row.submitted}</td>
                  <td className="py-1 text-right tabular-nums">{percent(row.submitRate)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </details>
    </div>
  );
}
