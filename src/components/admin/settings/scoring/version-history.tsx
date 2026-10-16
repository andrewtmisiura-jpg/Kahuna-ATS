import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RubricVersionView } from "@/server/services/scoring/rubrics";
import { formatCentralDateTime } from "../format";
import { RubricView } from "./rubric-view";

// Every version of the role's rubric, newest first, each with its reason and, on request,
// its criteria, guidance and instructions exactly as published.
export function VersionHistory({ versions, questionKeys }: { versions: RubricVersionView[]; questionKeys: Record<string, string> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Version history</CardTitle>
      </CardHeader>
      <CardContent>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No versions yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {versions.map((version) => (
              <li key={version.id} className="grid gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">Version {version.version}</span>
                  <Badge variant={version.status === "published" ? "default" : "outline"}>{version.status}</Badge>
                  {version.publishedAt ? (
                    <span className="text-muted-foreground">
                      published {formatCentralDateTime(version.publishedAt)}
                      {version.publishedBy ? ` by ${version.publishedBy.name ?? version.publishedBy.email}` : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">started {formatCentralDateTime(version.createdAt)}</span>
                  )}
                </div>
                {version.changeReason ? <p className="text-xs text-muted-foreground">Reason: {version.changeReason}</p> : null}
                <details>
                  <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground sm:min-h-0">Criteria, guidance and instructions</summary>
                  <div className="mt-2">
                    <RubricView
                      criteria={version.criteria}
                      allowedFlags={version.allowedFlags}
                      instructions={version.instructions}
                      questionKeys={questionKeys}
                      detailed
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
