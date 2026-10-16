import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CalibrationRow, RoleRubric } from "@/server/services/scoring/rubrics";
import { formatCentralDateTime } from "../format";
import { CalibrationTable } from "./calibration-table";
import { MODE_LABELS } from "./format";
import { ModeControl } from "./mode-control";
import { RescoreAllButton } from "./rescore-all-button";
import { RubricView } from "./rubric-view";

// One role on Settings > AI scoring: the mode with what each one means, the published
// version, the way into the rubric editor, re-scoring, hidden mode's calibration table and
// the version history.
export function RoleScoringCard({
  data,
  questionKeys,
  calibration,
  cap,
  usedToday,
}: {
  data: RoleRubric;
  questionKeys: Record<string, string>;
  calibration: CalibrationRow[] | null;
  cap: number;
  usedToday: number;
}) {
  const { role, mode, published, draft, history } = data;
  return (
    <Card role="region" aria-label={role.internalName}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1.5">
            <CardTitle>{role.internalName}</CardTitle>
            <CardDescription>
              {published ? `Rubric version ${published.version} is published.` : "No published rubric yet."}
              {draft ? ` Draft version ${draft.version} is open.` : ""}
            </CardDescription>
          </div>
          <Badge variant={mode === "off" ? "outline" : "default"}>Scoring {MODE_LABELS[mode].toLowerCase()}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        <ModeControl key={mode} roleId={role.id} mode={mode} canTurnOn={published !== null} />

        {published ? (
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">Published version {published.version}</h3>
            <p className="text-xs text-muted-foreground">
              Published {formatCentralDateTime(published.publishedAt)}
              {published.publishedBy ? ` by ${published.publishedBy.name ?? published.publishedBy.email}` : ""}.
              {published.changeReason ? ` Reason: ${published.changeReason}` : ""}
            </p>
            <RubricView criteria={published.criteria} allowedFlags={published.allowedFlags} questionKeys={questionKeys} />
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">
            Write the criteria, try them on sample answers, then publish with a written reason. Scoring stays off until a version is published.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button asChild className="h-11 sm:h-9">
            <Link href={`/admin/settings/scoring/${role.id}`}>{published || draft ? "Edit rubric" : "Write a rubric"}</Link>
          </Button>
        </div>

        {published && mode !== "off" ? (
          <RescoreAllButton roleId={role.id} roleName={role.internalName} version={published.version} submittedCount={data.submittedCount} cap={cap} usedToday={usedToday} />
        ) : null}

        {mode === "hidden" && calibration ? <CalibrationTable rows={calibration} /> : null}

        {history.length > 0 ? (
          <details className="text-sm">
            <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground sm:min-h-0">Version history ({history.length})</summary>
            <ul className="mt-2 divide-y rounded-md border">
              {history.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <span className="font-medium">Version {entry.version}</span>
                  <Badge variant={entry.status === "published" ? "default" : "outline"}>{entry.status}</Badge>
                  {entry.publishedAt ? (
                    <span className="text-muted-foreground">
                      published {formatCentralDateTime(entry.publishedAt)}
                      {entry.publishedBy ? ` by ${entry.publishedBy}` : ""}
                    </span>
                  ) : null}
                  {entry.changeReason ? <span className="basis-full text-xs text-muted-foreground">{entry.changeReason}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
