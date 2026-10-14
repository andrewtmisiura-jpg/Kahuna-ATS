"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ListFilterOptions, ListFilters } from "@/server/services/applications/queries";
import { LIST_STATUSES, SOURCES } from "@/server/services/applications/queries";
import { NativeSelect } from "./fields";
import { SOURCE_LABELS } from "./format";

// The filters are the URL: a plain GET form the browser serialises, so a filtered
// list can be bookmarked and the profile's next and previous buttons can carry it.

const STATUS_LABELS: Record<(typeof LIST_STATUSES)[number] | "", string> = {
  "": "Submitted (any status)",
  open: "Open",
  hired: "Hired",
  closed: "Closed",
  started: "Started, not submitted",
  all: "Everything",
};

export function ListFiltersForm({ filters, options }: { filters: ListFilters; options: ListFilterOptions }) {
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const submit = () => form.current?.requestSubmit();
  const active =
    Boolean(filters.stageId || filters.status || filters.source || filters.entryCodeId || filters.sessionId || filters.from || filters.to) ||
    filters.onHold ||
    filters.attention ||
    filters.conflicts;

  return (
    <form ref={form} method="get" action="/admin" className="mb-4 grid gap-2">
      <input type="hidden" name="opening" value={filters.openingId} />
      <div className="flex gap-2">
        <Input type="search" name="q" placeholder="Search name, mobile or email" defaultValue={filters.search ?? ""} aria-label="Search" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </div>
      <details open={active} className="rounded-md border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Filters{active ? " (on)" : ""}</summary>
        <div className="grid gap-3 border-t p-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Stage
            <NativeSelect name="stage" defaultValue={filters.stageId ?? ""} onChange={submit}>
              <option value="">Any stage</option>
              {options.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Status
            <NativeSelect name="status" defaultValue={filters.status ?? ""} onChange={submit}>
              {(["", ...LIST_STATUSES] as const).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            How they heard
            <NativeSelect name="source" defaultValue={filters.source ?? ""} onChange={submit}>
              <option value="">Any source</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
              <option value="none">Not given</option>
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Entry code
            <NativeSelect name="code" defaultValue={filters.entryCodeId ?? ""} onChange={submit}>
              <option value="">Any code</option>
              {options.entryCodes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} {c.label}
                </option>
              ))}
              <option value="none">No code</option>
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Group session
            <NativeSelect name="session" defaultValue={filters.sessionId ?? ""} onChange={submit}>
              <option value="">Any session</option>
              {options.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              <option value="none">No session</option>
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Started from
            <Input type="date" name="from" defaultValue={filters.from ?? ""} onChange={submit} />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Started to
            <Input type="date" name="to" defaultValue={filters.to ?? ""} onChange={submit} />
          </label>
          <div className="grid gap-1.5 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="hold" value="1" defaultChecked={filters.onHold} onChange={submit} /> On hold
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="attention" value="1" defaultChecked={filters.attention} onChange={submit} /> Attention flags
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="conflicts" value="1" defaultChecked={filters.conflicts} onChange={submit} /> Contact conflicts
            </label>
          </div>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" size="sm">
              Apply
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => router.push(`/admin?opening=${filters.openingId}` as Route)}>
              Clear
            </Button>
          </div>
        </div>
      </details>
    </form>
  );
}
