"use client";

import { TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DO_NOT_ASK_LIST, matchDoNotAsk } from "@/server/services/forms/do-not-ask";
import { Warning } from "./fields";

// The do-not-ask list beside the editor, and the soft warning the question
// dialog shows while someone types. Neither blocks anything.

export function DoNotAskPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Do not ask</CardTitle>
        <CardDescription>Applies to every role. The editor warns when new wording touches one of these; it never blocks you.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {DO_NOT_ASK_LIST.map((topic) => (
            <li key={topic.key}>
              <span className="font-medium">{topic.topic}</span>
              <span className="block text-xs text-muted-foreground">{topic.note}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function DoNotAskWarning({ text }: { text: string }) {
  const matches = matchDoNotAsk(text);
  if (matches.length === 0) return null;
  return (
    <Warning>
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium">This sounds like it asks about something on the do-not-ask list.</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {matches.map((match) => (
              <li key={match.topic.key}>
                <span className="font-medium">{match.topic.topic}</span> ({match.matched.join(", ")}). {match.topic.note}
              </li>
            ))}
          </ul>
          <p className="text-xs">You can still save it. Check the wording first.</p>
        </div>
      </div>
    </Warning>
  );
}

export function hasDoNotAskMatch(text: string) {
  return matchDoNotAsk(text).length > 0;
}
