import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { QuoConnection } from "@/server/services/config/texting";
import { formatCentralDate, formatCentralDateTime } from "./format";
import { Notice } from "./fields";

// Settings > Texting: whether the hiring number and the webhook are connected to
// Quo, and the newest `pnpm quo:setup` result (it runs before every deploy).
// Read-only. Shows the last 4 characters of the Quo id and never the webhook secret.

const PHONE_LABEL: Record<string, string> = {
  connected: "connected the number",
  already: "number already connected",
  not_found: "number not found in Quo",
  error: "number step failed",
};

const WEBHOOK_LABEL: Record<string, string> = {
  created: "created the webhook",
  already: "webhook already connected",
  exists_without_secret: "webhook exists but its secret is missing",
  error: "webhook step failed",
};

export function QuoConnectionCard({ quo }: { quo: QuoConnection }) {
  const last = quo.lastSetup;
  // A warning from the last run, shown only while that part is still not connected,
  // plus two that matter even once connected: a webhook created without Quo
  // confirming it covers only the hiring number, and a created webhook whose
  // secret was not kept because another was stored meanwhile.
  const phoneProblem = last && !quo.phoneIdLast4 && (last.phone.status === "not_found" || last.phone.status === "error") ? last.phone.message : null;
  const webhookProblem =
    last &&
    (last.webhook.status === "exists_without_secret" ||
      (last.webhook.status === "error" && !quo.webhookConnected) ||
      (last.webhook.status === "created" && last.webhook.scope !== null && last.webhook.scope !== "hiring_number"))
      ? last.webhook.message
      : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quo connection</CardTitle>
        <CardDescription>Set up automatically before every deploy once QUO_API_KEY is in Railway. Nothing to run by hand.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">Hiring number</span>
          {quo.phoneIdLast4 ? (
            <Badge variant="secondary">Connected (Quo id ending {quo.phoneIdLast4})</Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">Webhook (replies and delivery updates)</span>
          {quo.webhookConnected ? (
            <Badge variant="secondary">
              Connected
              {quo.webhookSecretSource === "railway"
                ? " (secret set in Railway)"
                : quo.webhookSecretStoredAt
                  ? ` (since ${formatCentralDate(quo.webhookSecretStoredAt)})`
                  : ""}
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </div>
        <div className="text-muted-foreground">
          {last ? (
            <>
              Last setup: {formatCentralDateTime(last.at)}, {PHONE_LABEL[last.phone.status] ?? last.phone.status},{" "}
              {WEBHOOK_LABEL[last.webhook.status] ?? last.webhook.status}.
            </>
          ) : (
            "No setup has run yet. It runs in the pre-deploy step of the next deploy once QUO_API_KEY is set in Railway."
          )}
        </div>
        {phoneProblem ? <Notice tone="warning">Hiring number: {phoneProblem}</Notice> : null}
        {webhookProblem ? <Notice tone="warning">Webhook: {webhookProblem}</Notice> : null}
      </CardContent>
    </Card>
  );
}
