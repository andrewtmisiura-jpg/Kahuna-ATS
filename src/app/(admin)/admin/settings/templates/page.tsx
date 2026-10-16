import { pageAccess } from "@/components/admin/settings/page-access";
import { BookingLinkForm } from "@/components/admin/settings/templates/booking-link-form";
import { TemplatesView } from "@/components/admin/settings/templates/templates-view";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { getTemplateSettings } from "@/server/services/messaging/templates";

export const metadata = { title: "Message templates" };

// Settings > Message templates (content/legal/messages.md): the one-on-one booking link,
// then the wording of each text and email by purpose and channel. Admins edit; Hiring
// Managers read what they send.
export default async function TemplatesSettingsPage() {
  const access = await pageAccess(["admin", "hiring_manager"]);
  const header = <PageHeader title="Message templates" description="The wording of every text and email Tidepool sends, and the one-on-one booking link." />;
  if (!access.ok) {
    return (
      <div>
        {header}
        {access.view}
      </div>
    );
  }
  const settings = await getTemplateSettings(db);
  const canEdit = access.user.role === "admin";
  return (
    <div className="grid gap-8">
      <div>
        {header}
        <BookingLinkForm url={settings.bookingLinkUrl} canEdit={canEdit} />
      </div>
      {!canEdit ? <p className="text-sm text-muted-foreground">You can read these here. An Admin changes the wording.</p> : null}
      <TemplatesView templates={settings.templates} brand={settings.brand} sample={settings.sample} canEdit={canEdit} />
    </div>
  );
}
