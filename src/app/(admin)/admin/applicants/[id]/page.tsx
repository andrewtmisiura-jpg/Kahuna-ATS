import type { Route } from "next";
import { notFound } from "next/navigation";
import { AnswersSection } from "@/components/admin/applicants/answers-section";
import { CheckPanel } from "@/components/admin/applicants/check-panel";
import { ConsentSection } from "@/components/admin/applicants/consent-section";
import { ContactSection } from "@/components/admin/applicants/contact-section";
import { DangerZone } from "@/components/admin/applicants/danger-zone";
import { DetailsSection } from "@/components/admin/applicants/details-section";
import { fullName } from "@/components/admin/applicants/format";
import { HirePanel } from "@/components/admin/applicants/hire-panel";
import { MessagesThread } from "@/components/admin/applicants/messages-thread";
import { NotesSection } from "@/components/admin/applicants/notes-section";
import { OfferPanel } from "@/components/admin/applicants/offer-panel";
import { ProfileHeader } from "@/components/admin/applicants/profile-header";
import { StageHistory } from "@/components/admin/applicants/stage-history";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/db";
import { listApplicationIds, listFilterParams, loadProfile, neighbors, parseListFilters } from "@/server/services/applications/queries";
import { canAct, pageUser } from "../_lib/page-user";

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await pageUser();
  const profile = user ? await loadProfile(db, id, user.role) : null;
  return { title: profile ? fullName(profile.person.firstName, profile.person.lastName) : "Applicant" };
}

// The profile (PLAN.md, "What staff experience"). The list's filter travels in
// the query string so Previous and Next walk the same list.
export default async function ApplicantProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await pageUser();
  if (!user) {
    return (
      <div>
        <PageHeader title="Applicant" />
        <Card>
          <CardContent className="text-sm text-muted-foreground">Your account cannot open this page. Ask an Admin to check your role in Settings, Users.</CardContent>
        </Card>
      </div>
    );
  }
  const profile = await loadProfile(db, id, user.role);
  if (!profile) notFound();

  const openingParam = Array.isArray(query.opening) ? query.opening[0] : query.opening;
  const filters = parseListFilters(query, openingParam ?? profile.application.openingId);
  const listQuery = listFilterParams(filters).toString();
  const listHref = `/admin?${listQuery}` as Route;
  const around = neighbors(await listApplicationIds(db, filters, user.role), profile.application.id);
  const link = (target: string | null) => (target ? (`/admin/applicants/${target}?${listQuery}` as Route) : null);
  const staff = canAct(user);

  return (
    <div className="mx-auto max-w-3xl">
      <ProfileHeader profile={profile} user={user} listHref={listHref} previousHref={link(around.previous)} nextHref={link(around.next)} />
      <div className="grid gap-3">
        <HirePanel profile={profile} role={user.role} />
        {profile.offers.length > 0 || profile.checks.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            <OfferPanel offers={profile.offers} checks={profile.checks} canAct={staff} />
            <CheckPanel checks={profile.checks} role={user.role} />
          </div>
        ) : null}
        <AnswersSection profile={profile} />
        <NotesSection notes={profile.notes} applicationId={profile.application.id} user={user} />
        <MessagesThread messages={profile.messages} canAct={staff} />
        <StageHistory events={profile.events} />
        <div className="grid gap-3 md:grid-cols-2">
          <ContactSection profile={profile} />
          <DetailsSection profile={profile} canAct={staff} />
        </div>
        {staff ? <ConsentSection consents={profile.consents} /> : null}
        {user.role === "admin" ? <DangerZone applicationId={profile.application.id} listHref={listHref} /> : null}
      </div>
    </div>
  );
}
