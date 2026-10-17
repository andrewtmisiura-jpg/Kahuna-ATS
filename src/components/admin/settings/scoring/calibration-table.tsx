import Link from "next/link";
import type { CalibrationRow } from "@/server/services/scoring/rubrics";
import { formatCentralDateTime } from "../format";
import { DECISION_LABELS } from "./format";

// Hidden mode's check of the rubric: the most recent scores beside what people decided,
// before anyone else sees a number. Only applications someone has decided are listed,
// so the number never reaches the person deciding.
export function CalibrationTable({ rows }: { rows: CalibrationRow[] }) {
  return (
    <div className="grid gap-2">
      <div>
        <h3 className="text-sm font-medium">Recent scores, hidden from staff</h3>
        <p className="text-xs text-muted-foreground">
          Compare the AI with what people decided before you make scores visible. An application shows here only once someone has decided, so the
          score never sways the decision.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing decided yet. A score shows here once someone advances, declines or closes that application.</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {rows.map((row) => (
            <li key={row.applicationId} className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)] sm:items-center sm:gap-3">
              <Link href={`/admin/applicants/${row.applicationId}`} className="flex min-h-11 items-center font-medium underline-offset-4 hover:underline sm:min-h-0">
                {row.name}
              </Link>
              <span className="tabular-nums">
                {row.overallScore !== null ? (
                  <>
                    <span className="font-semibold">{row.overallScore}</span>
                    <span className="text-muted-foreground"> out of 100</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Not scored</span>
                )}
              </span>
              <span className="text-muted-foreground">
                {row.decision ? `${DECISION_LABELS[row.decision.value]}${row.decision.reason ? `: ${row.decision.reason}` : ""}` : "No screening decision"}
                {` · ${row.closed ? "Closed at " : ""}${row.stage}`}
                <span className="block text-xs">
                  Rubric v{row.rubricVersion}
                  {row.completedAt ? `, scored ${formatCentralDateTime(row.completedAt)}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
