import { pageAccess } from "@/components/admin/settings/page-access";
import { TextingForm } from "@/components/admin/settings/texting-form";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { getTextingSettings } from "@/server/services/config/texting";

export const metadata = { title: "Texting" };

// Settings > Texting: the switch, help contact and daily cap. Admin only.
export default async function TextingSettingsPage() {
  const access = await pageAccess("admin");
  const header = <PageHeader title="Texting" description="Texts go out from the hiring number only while texting is on and the number is connected to Quo." />;
  if (!access.ok) {
    return (
      <div>
        {header}
        {access.view}
      </div>
    );
  }
  const settings = await getTextingSettings(db);
  return (
    <div>
      {header}
      <TextingForm settings={settings} />
    </div>
  );
}
