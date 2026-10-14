import type { Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Board } from "@/server/services/applications/board";

// The header line above the columns: applications that are not cards. Started
// (not submitted) is the drop-off count; closed ones leave the board. Both link
// to the list, which can show them.

export function BoardSummary({ board, openingId, filtered }: { board: Board; openingId: string; filtered: boolean }) {
  const cards = board.columns.reduce((sum, column) => sum + column.cards.length, 0);
  const list = (status: string) => `/admin?opening=${openingId}&status=${status}` as Route;
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
      <span>
        <span className="font-semibold tabular-nums">{cards}</span> on the board{filtered ? " (filtered)" : ""}
      </span>
      <Link href={list("started")} className="text-muted-foreground hover:text-foreground hover:underline">
        <span className="font-semibold tabular-nums text-foreground">{board.counts.started}</span> started, not submitted
      </Link>
      <Link href={list("closed")} className="text-muted-foreground hover:text-foreground hover:underline">
        <span className="font-semibold tabular-nums text-foreground">{board.counts.closed}</span> closed
      </Link>
      {board.counts.offBoard > 0 ? (
        <Link href={`/admin?opening=${openingId}` as Route} className="text-amber-800 hover:underline">
          {board.counts.offBoard} in stages the board does not show; see the list
        </Link>
      ) : null}
    </div>
  );
}

// Phones get a pointer to the list instead of a cramped board.
export function PhoneBoardNote({ openingId }: { openingId: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 text-sm md:hidden">
      <p className="font-medium">The board needs a wider screen.</p>
      <p className="mt-1 text-muted-foreground">On a phone, use the list. It makes the same moves: stage, close, hold and hire.</p>
      <Button asChild variant="outline" size="sm" className="mt-3">
        <Link href={`/admin?opening=${openingId}` as Route}>Open the list</Link>
      </Button>
    </div>
  );
}
