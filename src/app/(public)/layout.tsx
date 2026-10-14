import type { Metadata } from "next";
import Link from "next/link";

// Applicant pages: phone-first, one column, the Kahuna name and never "Tidepool".
// Never indexed and never a referrer; the matching response headers come from
// src/proxy.ts, which also sets the per-route Content-Security-Policy.
export const metadata: Metadata = {
  title: { default: "Kahuna Window Cleaning Hiring", template: "%s | Kahuna Window Cleaning" },
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-6">
      <header className="mb-6">
        <Link href="/" className="text-base font-semibold tracking-tight">
          Kahuna Window Cleaning
        </Link>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="mt-10 flex flex-wrap gap-x-4 gap-y-1 border-t pt-4 text-xs text-muted-foreground">
        <Link href="/privacy">Privacy policy</Link>
        <Link href="/sms-terms">SMS terms</Link>
        <Link href="/text-messages">Text messages</Link>
        <Link href="/lost-link">Lost your link?</Link>
      </footer>
    </div>
  );
}
