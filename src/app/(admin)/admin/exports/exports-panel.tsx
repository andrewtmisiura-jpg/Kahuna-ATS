"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ExportGroup, ExportSummary, OpeningChoice } from "@/server/services/exports";

type Filters = { openingId: string; from: string; to: string };

const GROUPS: { key: ExportGroup; title: string; intro: string }[] = [
  {
    key: "opening",
    title: "Per opening",
    intro: "The wide file, one row per application. Pick an opening first.",
  },
  {
    key: "long",
    title: "Long files",
    intro: "One row per record. The opening filter and the date range apply where the table shows.",
  },
  {
    key: "dictionary",
    title: "Dictionary files",
    intro: "Keys, labels and versions, so the long files can be read outside the app. Filters do not apply.",
  },
];

function downloadHref(name: string, summary: ExportSummary, filters: Filters): string {
  const params = new URLSearchParams();
  if (summary.acceptsOpening && filters.openingId) params.set("opening", filters.openingId);
  if (summary.dateField) {
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
  }
  const query = params.toString();
  return `/api/admin/exports/${name}${query ? `?${query}` : ""}`;
}

export function ExportsPanel({ openings, exports }: { openings: OpeningChoice[]; exports: ExportSummary[] }) {
  const [filters, setFilters] = useState<Filters>({ openingId: "", from: "", to: "" });
  const datesInvalid = Boolean(filters.from && filters.to && filters.from > filters.to);
  const openingName = openings.find((o) => o.id === filters.openingId)?.name ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>
            Dates are Central calendar days and include both ends. Leave them blank for everything.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-[minmax(16rem,1fr)_10rem_10rem]">
            <div className="grid gap-1.5">
              <Label htmlFor="export-opening">Opening</Label>
              <select
                id="export-opening"
                value={filters.openingId}
                onChange={(event) => setFilters({ ...filters, openingId: event.target.value })}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              >
                <option value="">All openings</option>
                {openings.map((opening) => (
                  <option key={opening.id} value={opening.id}>
                    {opening.name} ({opening.status})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="export-from">From</Label>
              <Input
                id="export-from"
                type="date"
                value={filters.from}
                onChange={(event) => setFilters({ ...filters, from: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="export-to">To</Label>
              <Input
                id="export-to"
                type="date"
                value={filters.to}
                onChange={(event) => setFilters({ ...filters, to: event.target.value })}
                aria-invalid={datesInvalid || undefined}
              />
            </div>
          </div>
          {datesInvalid ? <p className="mt-2 text-sm text-destructive">The from date must not be after the to date.</p> : null}
        </CardContent>
      </Card>

      {GROUPS.map((group) => {
        const items = exports.filter((item) => item.group === group.key);
        return (
          <section key={group.key}>
            <h2 className="text-lg font-semibold tracking-tight">{group.title}</h2>
            <p className="mb-3 text-sm text-muted-foreground">{group.intro}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-56">File</TableHead>
                  <TableHead>What it holds</TableHead>
                  <TableHead className="hidden w-48 md:table-cell">Filters</TableHead>
                  <TableHead className="w-40 text-right">Download</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const needsOpening = item.requiresOpening && !filters.openingId;
                  const disabled = needsOpening || (Boolean(item.dateField) && datesInvalid);
                  const scope = [
                    item.acceptsOpening ? (openingName ? openingName : "all openings") : null,
                    item.dateField ? `dates: ${item.dateField}` : null,
                  ]
                    .filter(Boolean)
                    .join("; ");
                  return (
                    <TableRow key={item.name}>
                      <TableCell className="align-top font-medium">
                        {item.label}
                        <div className="font-mono text-xs text-muted-foreground">{item.name}.csv</div>
                      </TableCell>
                      <TableCell className="align-top whitespace-normal text-sm">{item.description}</TableCell>
                      <TableCell className="hidden align-top whitespace-normal text-sm text-muted-foreground md:table-cell">
                        {scope || "none"}
                      </TableCell>
                      <TableCell className="align-top text-right">
                        {disabled ? (
                          <div className="inline-flex flex-col items-end gap-1">
                            <Button size="sm" variant="outline" disabled>
                              <Download /> Download CSV
                            </Button>
                            {needsOpening ? <span className="text-xs text-muted-foreground">Pick an opening first</span> : null}
                          </div>
                        ) : (
                          <Button size="sm" variant="outline" asChild>
                            <a href={downloadHref(item.name, item, filters)} download>
                              <Download /> Download CSV
                            </a>
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>
        );
      })}

      <p className="text-sm text-muted-foreground">
        Every download writes an audit row with your name, the file and the filters. Restricted notes are never included in any
        file. Cells that start with =, +, -, @ or a tab are written as text, so a sheet never runs them as a formula.
      </p>
    </div>
  );
}
