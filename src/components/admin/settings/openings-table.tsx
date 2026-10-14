"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { updateOpeningAction } from "@/server/actions/admin/settings";
import type { OpeningListRow, OpeningStatus } from "@/server/services/config/openings";
import { Field, NativeSelect, Notice, Textarea } from "./fields";
import { formatDateOnly } from "./format";

const STATUS_LABEL: Record<OpeningStatus, string> = { draft: "Draft", open: "Open", closed: "Closed" };

export function OpeningStatusBadge({ status }: { status: OpeningStatus }) {
  return <Badge variant={status === "open" ? "default" : status === "draft" ? "secondary" : "outline"}>{STATUS_LABEL[status]}</Badge>;
}

export function OpeningsTable({ openings }: { openings: OpeningListRow[] }) {
  const [editing, setEditing] = React.useState<OpeningListRow | null>(null);
  const byRole = new Map<string, { roleName: string; rows: OpeningListRow[] }>();
  for (const row of openings) {
    const group = byRole.get(row.roleId) ?? { roleName: row.roleName, rows: [] };
    group.rows.push(row);
    byRole.set(row.roleId, group);
  }

  return (
    <div className="space-y-8">
      {[...byRole.values()].map((group) => (
        <section key={group.roleName}>
          <h2 className="mb-2 text-base font-semibold">{group.roleName}</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Opening</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Opens</TableHead>
                <TableHead className="hidden md:table-cell">Closes</TableHead>
                <TableHead className="hidden lg:table-cell">Season</TableHead>
                <TableHead className="hidden lg:table-cell">Headcount</TableHead>
                <TableHead className="hidden xl:table-cell">Pay</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    {row.name}
                    <div className="text-xs text-muted-foreground">{row.key}</div>
                  </TableCell>
                  <TableCell>
                    <OpeningStatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{formatDateOnly(row.opensOn) || "Not set"}</TableCell>
                  <TableCell className="hidden md:table-cell">{formatDateOnly(row.closesOn) || "Not set"}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {row.seasonStartOn || row.seasonEndOn
                      ? `${formatDateOnly(row.seasonStartOn) || "?"} to ${formatDateOnly(row.seasonEndOn) || "?"}`
                      : "Not set"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{row.targetHeadcount ?? "Not set"}</TableCell>
                  <TableCell className="hidden max-w-64 truncate xl:table-cell" title={row.payText ?? ""}>
                    {row.payText ?? <span className="text-muted-foreground">Missing</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => setEditing(row)}>
                      <Pencil />
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ))}
      {editing ? <OpeningEditDialog opening={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function OpeningEditDialog({ opening, onClose }: { opening: OpeningListRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = String(form.get(name) ?? "").trim();
      return value === "" ? null : value;
    };
    const headcount = text("targetHeadcount");
    startTransition(async () => {
      setError(null);
      const result = await updateOpeningAction({
        id: opening.id,
        patch: {
          status: String(form.get("status")) as OpeningStatus,
          opensOn: text("opensOn"),
          closesOn: text("closesOn"),
          seasonStartOn: text("seasonStartOn"),
          seasonEndOn: text("seasonEndOn"),
          targetHeadcount: headcount === null ? null : Number(headcount),
          payText: text("payText"),
          benefitsText: text("benefitsText"),
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{opening.name}</DialogTitle>
          <DialogDescription>
            {opening.roleName}. An opening cannot be set to open without pay text and an opens-on date, and only one opening per role is open
            at a time.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Status" htmlFor="status">
            <NativeSelect id="status" name="status" defaultValue={opening.status}>
              <option value="draft">Draft</option>
              <option value="open">Open (accepting applications)</option>
              <option value="closed">Closed</option>
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Opens on" htmlFor="opensOn">
              <Input id="opensOn" name="opensOn" type="date" defaultValue={opening.opensOn ?? ""} />
            </Field>
            <Field label="Closes on" htmlFor="closesOn" hint="Optional. For your records; the status decides whether the form is live.">
              <Input id="closesOn" name="closesOn" type="date" defaultValue={opening.closesOn ?? ""} />
            </Field>
            <Field label="Season start" htmlFor="seasonStartOn">
              <Input id="seasonStartOn" name="seasonStartOn" type="date" defaultValue={opening.seasonStartOn ?? ""} />
            </Field>
            <Field label="Season end" htmlFor="seasonEndOn" hint="Needed before retention is reported for this opening.">
              <Input id="seasonEndOn" name="seasonEndOn" type="date" defaultValue={opening.seasonEndOn ?? ""} />
            </Field>
          </div>
          <Field label="Target headcount" htmlFor="targetHeadcount">
            <Input id="targetHeadcount" name="targetHeadcount" type="number" min={0} step={1} defaultValue={opening.targetHeadcount ?? ""} className="sm:w-40" />
          </Field>
          <Field label="Pay text" htmlFor="payText" hint="Shown on the landing page exactly as written.">
            <Textarea id="payText" name="payText" defaultValue={opening.payText ?? ""} rows={3} />
          </Field>
          <Field label="Benefits text" htmlFor="benefitsText" hint="Optional. Shown under the pay.">
            <Textarea id="benefitsText" name="benefitsText" defaultValue={opening.benefitsText ?? ""} rows={3} />
          </Field>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
