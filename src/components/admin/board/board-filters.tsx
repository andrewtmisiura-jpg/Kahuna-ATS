"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { NativeSelect } from "@/components/admin/applicants/fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BoardFilters } from "@/server/services/applications/board";
import type { ListFilterOptions } from "@/server/services/applications/queries";

// The board's filters: on hold only, group session, entry code and a name
// search. A plain GET form, so a filtered board is a link like the list.

type Props = { filters: BoardFilters; options: Pick<ListFilterOptions, "entryCodes" | "sessions">; active: boolean };

export function BoardFiltersForm({ filters, options, active }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const submit = () => form.current?.requestSubmit();

  return (
    <form ref={form} method="get" action="/admin/board" className="mb-4 flex flex-wrap items-end gap-3">
      <input type="hidden" name="opening" value={filters.openingId} />
      <label className="grid gap-1 text-xs text-muted-foreground">
        Name
        <Input type="search" name="q" placeholder="Search by name" defaultValue={filters.search ?? ""} className="w-56" />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Group session
        <NativeSelect name="session" defaultValue={filters.sessionId ?? ""} onChange={submit} className="w-48">
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
        Entry code
        <NativeSelect name="code" defaultValue={filters.entryCodeId ?? ""} onChange={submit} className="w-48">
          <option value="">Any code</option>
          {options.entryCodes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} {c.label}
            </option>
          ))}
          <option value="none">No code</option>
        </NativeSelect>
      </label>
      <label className="flex h-9 items-center gap-2 text-sm">
        <input type="checkbox" name="hold" value="1" defaultChecked={filters.onHold} onChange={submit} /> On hold only
      </label>
      <Button type="submit" variant="secondary">
        Search
      </Button>
      {active ? (
        <Button type="button" variant="ghost" onClick={() => router.push(`/admin/board?opening=${filters.openingId}` as Route)}>
          Clear
        </Button>
      ) : null}
    </form>
  );
}
