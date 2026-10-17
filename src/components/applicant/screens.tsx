import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CENTRAL_TZ } from "@/server/services/time";
import { APPLICANT_COPY, BOOK_INTERVIEW, QUESTIONS_LINE, REVIEWS_LINE, publicStatus } from "./status-copy";

// Shared applicant screens with no client state: the expired link, the status page
// and the "We got it" confirmation.

export function ExpiredLink() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">This link has expired</h1>
      <p className="text-muted-foreground">{APPLICANT_COPY.expiredLink}</p>
      <Button asChild className="h-12 w-full text-base">
        <Link href="/lost-link">Get a new link</Link>
      </Button>
      <p className="text-sm text-muted-foreground">{QUESTIONS_LINE}</p>
    </div>
  );
}

export function SubmittedScreen() {
  return (
    <div className="space-y-4" role="status">
      <h1 className="text-2xl font-semibold tracking-tight">We got it</h1>
      <p>{APPLICANT_COPY.submitted}</p>
      <p className="text-sm text-muted-foreground">{QUESTIONS_LINE}</p>
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL_TZ, month: "short", day: "numeric", year: "numeric" });

export function StatusPage(props: {
  roleTitle: string;
  submittedAt: Date | null;
  status: "open" | "hired" | "closed";
  stagePublicLabel: string;
  // The one-on-one booking link while an invite is out (messaging/staff-sends.ts).
  bookingLink?: string | null;
}) {
  const view = publicStatus({ status: props.status, stagePublicLabel: props.stagePublicLabel });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Your application</h1>
      <p>{props.roleTitle} at Kahuna Window Cleaning</p>
      {props.submittedAt ? <p className="text-sm text-muted-foreground">Submitted {dateFormat.format(props.submittedAt)}</p> : null}
      <div className="rounded-md border p-4">
        <p className="text-lg font-semibold">{view.label}</p>
        <p className="text-sm">{view.sentence}</p>
      </div>
      {props.bookingLink && !view.closed ? (
        <Button asChild className="h-12 w-full text-base">
          <a href={props.bookingLink} rel="noreferrer">
            {BOOK_INTERVIEW}
          </a>
        </Button>
      ) : null}
      {view.closed ? null : <p className="text-sm text-muted-foreground">{REVIEWS_LINE}</p>}
      <p className="text-sm text-muted-foreground">{QUESTIONS_LINE}</p>
    </div>
  );
}
