"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addOpeningAction } from "@/server/actions/admin/roles";
import type { RoleOpening } from "@/server/services/config/roles";
import { Field, Notice } from "../fields";
import { openingKeyFrom, OPENING_STATUS_LABELS, TAP } from "./format";

// A role's openings, and a new one for it. A new opening starts as a draft; its pay,
// dates and status are set in Settings > Openings, which refuses to open it without
// pay text and an opens-on date.

export function RoleOpenings({ roleId, openings }: { roleId: string; openings: RoleOpening[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [key, setKey] = React.useState("");
  const [keyTouched, setKeyTouched] = React.useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      setError(null);
      const result = await addOpeningAction({ roleId, name, key });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setKey("");
      setKeyTouched(false);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4">
      {openings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No openings yet. Add one below, then set its pay and dates in Settings, Openings.</p>
      ) : (
        <ul className="grid gap-2">
          {openings.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{o.name}</span> <span className="font-mono text-xs text-muted-foreground">{o.key}</span>
                {o.payText ? null : <span className="block text-xs text-muted-foreground">Pay and dates not set yet</span>}
              </span>
              <Badge variant={o.status === "open" ? "default" : "outline"}>{OPENING_STATUS_LABELS[o.status]}</Badge>
            </li>
          ))}
        </ul>
      )}
      <Link href="/admin/settings/openings" className="text-sm underline underline-offset-4">
        Set pay, dates and status in Settings, Openings
      </Link>
      <form onSubmit={submit} className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="New opening name" htmlFor="opening-name">
          <Input
            id="opening-name"
            className={TAP}
            placeholder="Gutter Cleaning 2027"
            value={name}
            maxLength={120}
            required
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey(openingKeyFrom(e.target.value));
            }}
          />
        </Field>
        <Field label="Opening key" htmlFor="opening-key">
          <Input
            id="opening-key"
            className={`${TAP} font-mono`}
            placeholder="gutters-2027"
            value={key}
            maxLength={40}
            required
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value);
            }}
          />
        </Field>
        <Button type="submit" className={TAP} disabled={pending}>
          {pending ? "Adding" : "Add opening"}
        </Button>
      </form>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
