"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { publishAiDisclosureAction } from "@/server/actions/admin/rubrics";
import type { AiDisclosureOverview } from "@/server/services/scoring/disclosure";
import { Field, Notice, Textarea } from "../fields";
import { formatCentralDateTime } from "../format";
import { plural } from "./format";

// The AI notice on every landing page (legal_text_version kind ai_disclosure). Publishing a
// new version shows it to applicants from their next page load; each application stays
// tied to the version that was live when it started.
export function DisclosureCard({ overview, maxLength }: { overview: AiDisclosureOverview; maxLength: number }) {
  const router = useRouter();
  const { current, versions } = overview;
  const [body, setBody] = useState(current?.body ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const nextVersion = (current?.version ?? 0) + 1;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPublished(null);
    startTransition(async () => {
      const result = await publishAiDisclosureAction({ body, changeNote: note });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPublished(result.data.version);
      setNote("");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI notice on the landing page</CardTitle>
        <CardDescription>
          Every applicant reads this before starting. A new version shows from their next page load, and each application stays tied to the version
          that was live when it started.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {current ? (
          <div className="grid gap-1 text-sm">
            <blockquote className="rounded-md border bg-muted/40 px-3 py-2">{current.body}</blockquote>
            <p className="text-xs text-muted-foreground">
              Version {current.version}, live since {formatCentralDateTime(new Date(current.publishedAt))}
              {current.publishedBy ? ` (published by ${current.publishedBy})` : ""}. {plural(current.applicationsStarted, "application")} started under it.
              {current.changeNote ? ` Note: ${current.changeNote}` : ""}
            </p>
          </div>
        ) : (
          <Notice tone="warning">No AI notice is published, so the landing page shows none.</Notice>
        )}

        <form onSubmit={submit} className="grid gap-3">
          <Field label="New wording" htmlFor="ai-disclosure-body" hint={`Plain text, one or two sentences, at most ${maxLength} characters.`}>
            <Textarea id="ai-disclosure-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={maxLength} required />
          </Field>
          <Field label="What changed and why" htmlFor="ai-disclosure-note" hint="Required. Kept with the version for the record.">
            <Input id="ai-disclosure-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="h-11 sm:h-9" required />
          </Field>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {published !== null && !error ? <Notice>Version {published} is live on every landing page.</Notice> : null}
          <div>
            <Button type="submit" disabled={pending || !body.trim() || !note.trim()} className="h-11 sm:h-9">
              {pending ? "Publishing..." : `Publish version ${nextVersion}`}
            </Button>
          </div>
        </form>

        {versions.length > 1 ? (
          <details className="text-sm">
            <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground sm:min-h-0">Earlier versions</summary>
            <ul className="mt-2 divide-y rounded-md border">
              {versions.slice(1).map((version) => (
                <li key={version.id} className="grid gap-1 px-3 py-2">
                  <p className="text-xs text-muted-foreground">
                    Version {version.version}: live from {formatCentralDateTime(new Date(version.publishedAt))}
                    {version.replacedAt ? ` to ${formatCentralDateTime(new Date(version.replacedAt))}` : ""}, {plural(version.applicationsStarted, "application")}{" "}
                    started under it.
                    {version.changeNote ? ` Note: ${version.changeNote}` : ""}
                  </p>
                  <p>{version.body}</p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
