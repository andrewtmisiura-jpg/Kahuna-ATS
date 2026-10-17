import type { Route } from "next";
import Link from "next/link";
import { ApplicantRows } from "@/components/admin/applicants/applicant-rows";
import { AttentionStrip } from "@/components/admin/applicants/attention-strip";
import { ListCountsCards } from "@/components/admin/applicants/list-counts";
import { ListFiltersForm } from "@/components/admin/applicants/list-filters";
import { OpeningSelector } from "@/components/admin/applicants/opening-selector";
import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/db";
import {
  attentionCounts,
  defaultOpening,
  listApplications,
  listCounts,
  listFilterOptions,
  listFilterParams,
  listOpenings,
  loadPicklists,
  parseListFilters,
} from "@/server/services/applications/queries";
import { canAct, pageUser } from "./applicants/_lib/page-user";

export const metadata = { title: "Applicants" };

type SearchParams = Record<string, string | string[] | undefined>;

// The list view (PLAN.md, "What staff experience"): counts, the attention strip,
// filters, search and the rows, for one opening at a time, sorted by AI score when
// the role shows scores and staff pick it.
export default async function ApplicantListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const user = await pageUser();
  if (!user) return <NoAccess />;

  const openings = await listOpenings(db);
  const requested = Array.isArray(params.opening) ? params.opening[0] : params.opening;
  const open = defaultOpening(openings, requested);
  if (!open) {
    return (
      <div>
        <PageHeader title="Applicants" />
        <Card>
          <CardContent className="text-sm text-muted-foreground">No openings yet. An Admin creates one in Settings, Openings.</CardContent>
        </Card>
      </div>
    );
  }

  const filters = parseListFilters(params, open.id);
  const [counts, attention, options, page, picklists] = await Promise.all([
    listCounts(db, filters),
    attentionCounts(db, open.id),
    listFilterOptions(db, open),
    listApplications(db, filters, user.role),
    loadPicklists(db, open.employerId, open.roleId),
  ]);
  const profileQuery = listFilterParams(filters).toString();
  const pageLink = (n: number) => `/admin?${listFilterParams({ ...filters, page: n }).toString()}` as Route;
  const from = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const to = Math.min(page.total, page.page * page.pageSize);

  return (
    <div>
      <PageHeader title={open.name} description={open.roleName}>
        <OpeningSelector openings={openings} value={open.id} />
      </PageHeader>
      <ListCountsCards counts={counts} />
      <AttentionStrip counts={attention} openingId={open.id} />
      <ListFiltersForm filters={filters} options={options} />
      <p className="mb-2 text-xs text-muted-foreground">
        {page.total === 0 ? "No applicants" : `Showing ${from} to ${to} of ${page.total}`}
        {filters.status ? "" : ". Started applications are counted above, not listed; pick a status to see them."}
      </p>
      {filters.sort === "ai_score" && options.aiScoreSort ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Sorted by AI score, highest first; applicants without a score come last. A sorting aid only: it never moves, rejects or messages anyone.
        </p>
      ) : null}
      <ApplicantRows page={page} stages={options.stages} crews={picklists.crews} canAct={canAct(user)} profileQuery={profileQuery} />
      {page.pageCount > 1 ? (
        <div className="mt-4 flex items-center justify-between">
          <Button asChild variant="outline" size="sm" disabled={page.page <= 1}>
            {page.page > 1 ? <Link href={pageLink(page.page - 1)}>Previous</Link> : <span>Previous</span>}
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page.page} of {page.pageCount}
          </span>
          <Button asChild variant="outline" size="sm">
            {page.page < page.pageCount ? <Link href={pageLink(page.page + 1)}>Next</Link> : <span>Next</span>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function NoAccess() {
  return (
    <div>
      <PageHeader title="Applicants" />
      <Card>
        <CardContent className="text-sm text-muted-foreground">Your account cannot open this page. Ask an Admin to check your role in Settings, Users.</CardContent>
      </Card>
    </div>
  );
}
