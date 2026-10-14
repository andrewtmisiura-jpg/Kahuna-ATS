export const metadata = { title: "Text messages" };

// Permanent opt-in page: shows applicants and carriers exactly how text consent is collected.
export default function TextMessagesPage() {
  return (
    <article className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Text messages from Kahuna Window Cleaning</h1>
      <p className="text-muted-foreground">
        When you start a job application you may tick an optional, unchecked box with this wording:
      </p>
      <blockquote className="rounded-md border bg-muted/40 p-3 text-sm">
        Text me my application link and updates about this application (optional). I agree that
        Kahuna Window Cleaning may text me at the number above about my job application: my
        application link, reminders, interview scheduling, status updates and decisions. Msg
        frequency varies. Msg &amp; data rates may apply. Reply HELP for help, STOP to opt out.
        Consent is not a condition of applying. See our SMS Terms and Privacy Policy.
      </blockquote>
      <p className="text-muted-foreground">
        Texts come from 763-292-2259. Reply STOP at any time to stop them.
      </p>
    </article>
  );
}
