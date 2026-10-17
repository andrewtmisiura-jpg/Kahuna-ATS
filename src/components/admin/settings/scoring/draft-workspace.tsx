"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { startRubricDraftAction } from "@/server/actions/admin/rubrics";
import { Notice } from "../fields";
import { RubricEditor } from "./rubric-editor";

type EditorProps = React.ComponentProps<typeof RubricEditor>;

// Holds the editor across the remount a save causes (the page keys it on the saved
// draft), so "Saved." still shows on the fresh copy.
export function DraftWorkspace({ editorKey, ...props }: Omit<EditorProps, "justSaved" | "onSaved"> & { editorKey: string }) {
  const [justSaved, setJustSaved] = useState(false);
  return <RubricEditor key={editorKey} {...props} justSaved={justSaved} onSaved={() => setJustSaved(true)} />;
}

// No draft open: start one from the published version, or the first version of a new rubric.
export function StartDraftCard({ roleId, publishedVersion }: { roleId: string; publishedVersion: number | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function start() {
    setError(null);
    startTransition(async () => {
      const result = await startRubricDraftAction({ roleId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>No draft</CardTitle>
        <CardDescription>
          {publishedVersion !== null
            ? `Start a draft from version ${publishedVersion} to change the rubric. Nothing changes for scoring until you publish it.`
            : "This role has no rubric yet. Start the first draft: criteria, weights, guidance and the questions each one reads."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div>
          <Button type="button" onClick={start} disabled={pending} className="h-11 sm:h-9">
            {pending ? "Starting..." : publishedVersion !== null ? `Start a draft from version ${publishedVersion}` : "Start the first draft"}
          </Button>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </CardContent>
    </Card>
  );
}
