import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { kioskAccess } from "../../_lib/kiosk-access";

export const metadata = { title: "Check in" };

// The door check-in for one group session (Phase 2, sessions): each person arriving types
// a name and mobile, which become an attendee row matched to an application on an exact
// mobile. A placeholder until that build fills it in.
export default async function CheckInPage() {
  const access = await kioskAccess();
  if (!access.ok) return access.view;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Check in</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">Coming in this release.</CardContent>
    </Card>
  );
}
