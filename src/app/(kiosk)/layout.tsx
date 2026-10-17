import type { Metadata } from "next";

// People arriving at a group interview see these pages, so they say Kahuna Window
// Cleaning, never Tidepool, and are never indexed.
export const metadata: Metadata = {
  title: { default: "Check in", template: "%s | Kahuna Window Cleaning" },
  robots: { index: false, follow: false, nocache: true },
};

// The door check-in kiosk (Phase 2, sessions): a tablet a staff member starts the
// check-in on and hands to people at the door. It has no admin navigation, and the
// tablet holds only the kiosk's own credential for one session (the staff member is
// signed out when it starts), so nobody there can reach the rest of the app. Each page
// checks that credential itself (_lib/kiosk-access.ts).
export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-6">
      <header className="mb-6 text-base font-semibold tracking-tight">Kahuna Window Cleaning</header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
