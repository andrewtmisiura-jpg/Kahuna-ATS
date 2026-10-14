"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { formatCentralDateTime } from "@/components/admin/settings/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SessionListRow, SessionStatus } from "@/server/services/config/sessions";
import { SessionFormDialog, type SessionOpeningOption } from "./session-form-dialog";

const STATUS_LABEL: Record<SessionStatus, string> = { scheduled: "Scheduled", held: "Held", canceled: "Canceled" };

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return <Badge variant={status === "scheduled" ? "default" : status === "held" ? "secondary" : "outline"}>{STATUS_LABEL[status]}</Badge>;
}

export function NewSessionButton({ openings }: { openings: SessionOpeningOption[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={openings.length === 0} title={openings.length === 0 ? "Open or draft an opening first" : undefined}>
        <Plus />
        New session
      </Button>
      {open ? <SessionFormDialog openings={openings} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function SessionsTable({ rows }: { rows: SessionListRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Where</TableHead>
          <TableHead className="hidden md:table-cell">Opening</TableHead>
          <TableHead className="text-right">Invited</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Attended</TableHead>
          <TableHead className="hidden text-right lg:table-cell">Scans</TableHead>
          <TableHead className="text-right">Applied</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
              No sessions yet.
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Link href={`/admin/sessions/${row.id}`} className="font-medium underline-offset-4 hover:underline">
                {formatCentralDateTime(row.startsAt)}
              </Link>
              <div className="text-xs text-muted-foreground md:hidden">{row.openingName}</div>
            </TableCell>
            <TableCell className="max-w-48 truncate" title={row.locationName}>
              {row.locationName}
            </TableCell>
            <TableCell className="hidden md:table-cell">{row.openingName}</TableCell>
            <TableCell className="text-right tabular-nums">{row.invitedCount ?? ""}</TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">{row.attendedCount ?? ""}</TableCell>
            <TableCell className="hidden text-right tabular-nums lg:table-cell" title="Scans today / in total">
              {row.scansToday} / {row.scansTotal}
            </TableCell>
            <TableCell className="text-right tabular-nums" title="Submitted / started">
              {row.submittedCount} / {row.startedCount}
            </TableCell>
            <TableCell>
              <SessionStatusBadge status={row.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
