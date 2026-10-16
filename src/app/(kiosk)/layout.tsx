import type { Metadata } from "next";
import { kioskAccess } from "./_lib/kiosk-access";

// People arriving at a group interview see these pages, so they say Kahuna Window
// Cleaning, never Tidepool, and are never indexed.
export const metadata: Metadata = {
  title: { default: "Check in", template: "%s | Kahuna Window Cleaning" },
  robots: { index: false, follow: false, nocache: true },
};

// The door check-in kiosk (Phase 2, sessions): a tablet a staff member signs in on and
// hands to people at the door. It has no admin navigation, so nobody there can wander
// into the rest of the app.
export default async function KioskLayout({ children }: { children: React.ReactNode }) {
  const access = await kioskAccess();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-6">
      <header className="mb-6 text-base font-semibold tracking-tight">Kahuna Window Cleaning</header>
      <main className="flex-1">{access.ok ? children : access.view}</main>
    </div>
  );
}
