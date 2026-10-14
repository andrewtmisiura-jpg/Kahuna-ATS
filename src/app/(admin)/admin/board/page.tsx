import { BoardFiltersForm } from "@/components/admin/board/board-filters";
import { BoardSummary, PhoneBoardNote } from "@/components/admin/board/board-summary";
import { BoardView } from "@/components/admin/board/board-view";
import { OpeningSelector } from "@/components/admin/applicants/opening-selector";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/db";
import { boardFilterParams, boardFiltersActive, loadBoard, parseBoardFilters } from "@/server/services/applications/board";
import { defaultOpening, listFilterOptions, listOpenings, loadPicklists } from "@/server/services/applications/queries";
import { canAct, pageUser } from "../applicants/_lib/page-user";

export const metadata = { title: "Board" };

type SearchParams = Record<string, string | string[] | undefined>;

// The kanban board (PLAN.md, Admin list, Kanban), a desktop screen: one opening
// at a time, a column per stage the role shows on the board, filters in the URL.
export default async function BoardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const user = await pageUser();
  if (!user) {
    return (
      <div>
        <PageHeader title="Board" />
        <Card>
          <CardContent className="text-sm text-muted-foreground">Your account cannot open this page. Ask an Admin to check your role in Settings, Users.</CardContent>
        </Card>
      </div>
    );
  }

  const openings = await listOpenings(db);
  const requested = Array.isArray(params.opening) ? params.opening[0] : params.opening;
  const open = defaultOpening(openings, requested);
  if (!open) {
    return (
      <div>
        <PageHeader title="Board" />
        <Card>
          <CardContent className="text-sm text-muted-foreground">No openings yet. An Admin creates one in Settings, Openings.</CardContent>
        </Card>
      </div>
    );
  }

  const filters = parseBoardFilters(params, open.id);
  const [board, options, picklists] = await Promise.all([
    loadBoard(db, filters, user.role),
    listFilterOptions(db, open),
    loadPicklists(db, open.employerId, open.roleId),
  ]);
  const staff = canAct(user);
  const filterKey = boardFilterParams(filters).toString();

  return (
    <div>
      <PageHeader
        title="Board"
        description={
          staff
            ? "One column per stage. Every move is recorded in the stage history with your name."
            : "One column per stage. You can look; moving cards needs an Admin or Hiring Manager."
        }
      >
        <OpeningSelector openings={openings} value={open.id} path="/admin/board" />
      </PageHeader>
      <PhoneBoardNote openingId={open.id} />
      <div className="hidden md:block">
        <BoardFiltersForm key={filterKey} filters={filters} options={options} active={boardFiltersActive(filters)} />
        <BoardSummary board={board} openingId={open.id} filtered={boardFiltersActive(filters)} />
        <BoardView
          key={open.id}
          board={board}
          openingId={open.id}
          picklists={picklists}
          isSnow={open.roleKey === "snow_removal_tech"}
          role={user.role}
          canAct={staff}
        />
      </div>
    </div>
  );
}
