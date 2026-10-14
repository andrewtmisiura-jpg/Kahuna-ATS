"use client";

import { Download, Plus, Printer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { closeEntryCodeAction, createEntryCodeAction, reopenEntryCodeAction } from "@/server/actions/admin/settings";
import type { EntryCodeListRow } from "@/server/services/config/entry-codes-admin";
import { Field, NativeSelect, Notice } from "./fields";
import { formatCentralDate } from "./format";
import { qrDownloadHref } from "./qr-card";

export type CodeRoleOption = { id: string; name: string };
export type CodeOpeningOption = { id: string; name: string; roleId: string; status: string };
export type CodeSessionOption = { id: string; openingId: string; label: string };
export type ChannelOption = { value: string; label: string };

type Props = {
  rows: EntryCodeListRow[];
  roles: CodeRoleOption[];
  openings: CodeOpeningOption[];
  sessions: CodeSessionOption[];
  channels: ChannelOption[];
  hiringHost: string;
};

export function EntryCodesTable({ rows, roles, openings, sessions, channels, hiringHost }: Props) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const channelLabel = (value: string) => channels.find((c) => c.value === value)?.label ?? value;

  function toggle(row: EntryCodeListRow) {
    const question = row.closedAt
      ? `Reopen ${row.code}? Scans go back to its opening or session.`
      : `Close ${row.code}? Anyone who scans it sees the role page instead. You can reopen it later.`;
    if (!window.confirm(question)) return;
    startTransition(async () => {
      setError(null);
      const result = row.closedAt ? await reopenEntryCodeAction({ id: row.id }) : await closeEntryCodeAction({ id: row.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus />
          New code
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead className="hidden md:table-cell">Channel</TableHead>
            <TableHead className="hidden lg:table-cell">Opening</TableHead>
            <TableHead className="hidden lg:table-cell">Session</TableHead>
            <TableHead className="text-right">Today</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-56" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                No codes yet.
              </TableCell>
            </TableRow>
          ) : null}
          {rows.map((row) => (
            <TableRow key={row.id} className={row.closedAt ? "text-muted-foreground" : undefined}>
              <TableCell>
                <div className="font-mono font-semibold tracking-wider">{row.code}</div>
                <div className="max-w-56 truncate text-xs text-muted-foreground" title={row.label}>
                  {row.label}
                </div>
                <div className="text-xs text-muted-foreground md:hidden">{channelLabel(row.channel)}</div>
              </TableCell>
              <TableCell className="hidden md:table-cell">{channelLabel(row.channel)}</TableCell>
              <TableCell className="hidden lg:table-cell">
                {row.openingName ?? <span className="text-muted-foreground">Whichever {row.roleName} opening is open</span>}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                {row.sessionId ? (
                  <Link href={`/admin/sessions/${row.sessionId}`} className="underline-offset-4 hover:underline">
                    {formatCentralDate(row.sessionStartsAt)} {row.sessionLocation}
                  </Link>
                ) : (
                  ""
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.scansToday}</TableCell>
              <TableCell className="text-right tabular-nums">{row.scansTotal}</TableCell>
              <TableCell>{row.closedAt ? <Badge variant="outline">Closed</Badge> : <Badge variant="secondary">Open</Badge>}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button asChild size="icon-sm" variant="ghost" title="Download SVG">
                    <a href={qrDownloadHref(row.id, "svg")} download aria-label={`Download SVG for ${row.code}`}>
                      <Download />
                    </a>
                  </Button>
                  <Button asChild size="sm" variant="ghost" title="Download PNG">
                    <a href={qrDownloadHref(row.id, "png")} download aria-label={`Download PNG for ${row.code}`}>
                      PNG
                    </a>
                  </Button>
                  <Button asChild size="icon-sm" variant="ghost" title="Printable sheet">
                    <Link href={`/admin/codes/${row.id}/print`} aria-label={`Printable sheet for ${row.code}`}>
                      <Printer />
                    </Link>
                  </Button>
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => toggle(row)}>
                    {row.closedAt ? "Reopen" : "Close"}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Each QR encodes https://{hiringHost}/q/ plus the code. Closing a code never needs a reprint: the printed code simply shows the role page.
      </p>
      {creating ? <NewCodeDialog roles={roles} openings={openings} sessions={sessions} channels={channels} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function NewCodeDialog({
  roles,
  openings,
  sessions,
  channels,
  onClose,
}: {
  roles: CodeRoleOption[];
  openings: CodeOpeningOption[];
  sessions: CodeSessionOption[];
  channels: ChannelOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [roleId, setRoleId] = React.useState(roles[0]?.id ?? "");
  const [openingId, setOpeningId] = React.useState("");
  const [sessionId, setSessionId] = React.useState("");
  const [channel, setChannel] = React.useState("flyer");
  const roleOpenings = openings.filter((o) => o.roleId === roleId);
  const openingSessions = sessions.filter((s) => s.openingId === openingId);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      setError(null);
      const result = await createEntryCodeAction({
        label: String(form.get("label") ?? ""),
        channel: channel as "flyer",
        roleId,
        openingId: openingId || null,
        groupSessionId: sessionId || null,
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New entry code</DialogTitle>
          <DialogDescription>A short code for one place a link or QR will live, so it can be closed on its own later.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Label" htmlFor="label" hint="Where it will be printed or pasted, for example: Snow flyer, Golden Valley shop.">
            <Input id="label" name="label" required autoFocus />
          </Field>
          <Field label="Channel" htmlFor="channel">
            <NativeSelect id="channel" value={channel} onChange={(event) => setChannel(event.target.value)}>
              {channels.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Role" htmlFor="roleId">
            <NativeSelect
              id="roleId"
              value={roleId}
              onChange={(event) => {
                setRoleId(event.target.value);
                setOpeningId("");
                setSessionId("");
              }}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Opening" htmlFor="openingId" hint="Leave on the first choice for a code that should keep working season after season.">
            <NativeSelect
              id="openingId"
              value={openingId}
              onChange={(event) => {
                setOpeningId(event.target.value);
                setSessionId("");
              }}
            >
              <option value="">Whichever opening of this role is open</option>
              {roleOpenings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.status})
                </option>
              ))}
            </NativeSelect>
          </Field>
          {openingId ? (
            <Field label="Group session" htmlFor="sessionId" hint="Optional. Applicants who scan a session code are attributed to it.">
              <NativeSelect
                id="sessionId"
                value={sessionId}
                onChange={(event) => {
                  setSessionId(event.target.value);
                  if (event.target.value) setChannel("session_qr");
                }}
              >
                <option value="">None</option>
                {openingSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating" : "Create code"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
