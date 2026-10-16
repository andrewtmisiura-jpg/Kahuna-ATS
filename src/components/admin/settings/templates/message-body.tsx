import { cn } from "@/lib/utils";

// A message the way the applicant sees it: a text as a phone bubble, an email as a
// subject line over the body. Used by the template editor's preview and the profile's
// send previews, so both look alike.
export function MessageBody({
  channel,
  subject,
  body,
  className,
}: {
  channel: "sms" | "email";
  subject?: string | null;
  body: string;
  className?: string;
}) {
  if (channel === "sms") {
    return (
      <div className={cn("flex", className)}>
        <p className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm">{body}</p>
      </div>
    );
  }
  return (
    <div className={cn("rounded-md border bg-background text-sm", className)}>
      <p className="border-b px-3 py-2">
        <span className="text-muted-foreground">Subject: </span>
        <span className="font-medium">{subject || "(no subject)"}</span>
      </p>
      <p className="whitespace-pre-wrap break-words px-3 py-2">{body}</p>
    </div>
  );
}

// "154 characters, 1 segment" for a text.
export function segmentLine(characters: number, segments: number): string {
  return `${characters} characters, ${segments} ${segments === 1 ? "segment" : "segments"}`;
}
