import { ApplicationForm } from "@/components/applicant/application-form";
import { ExpiredLink, StatusPage } from "@/components/applicant/screens";
import { db } from "@/db";
import { currentApplicationId } from "@/server/actions/applicant/session";
import { loadApplicationForm } from "@/server/services/applications/answers";
import { openInviteBookingLink } from "@/server/services/messaging/staff-sends";

// The application itself, for the application the session cookie is bound to.
// Before submit: the form. After submit (or once closed): the status page, with the
// booking link while a one-on-one invite is out.
export const metadata = { title: "Your application" };
export const dynamic = "force-dynamic";

export default async function ApplyPage({ searchParams }: { searchParams: Promise<{ texts?: string }> }) {
  const applicationId = await currentApplicationId();
  if (!applicationId) return <ExpiredLink />;
  const form = await loadApplicationForm(db, applicationId);
  if (!form) return <ExpiredLink />;

  if (form.submittedAt || form.status !== "open") {
    const bookingLink = form.status === "open" ? await openInviteBookingLink(db, applicationId) : null;
    return (
      <StatusPage
        roleTitle={form.roleTitle}
        submittedAt={form.submittedAt}
        status={form.status}
        stagePublicLabel={form.stagePublicLabel}
        bookingLink={bookingLink}
      />
    );
  }

  const { texts } = await searchParams;
  return (
    <ApplicationForm
      sections={form.sections}
      questions={form.questions}
      answers={form.answers}
      source={form.source}
      textsBlocked={texts === "off"}
    />
  );
}
