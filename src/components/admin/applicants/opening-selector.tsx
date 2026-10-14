"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import type { OpeningOption } from "@/server/services/applications/queries";
import { NativeSelect } from "./fields";

// path: the page the selector reloads with ?opening=, the list by default.
export function OpeningSelector({ openings, value, path = "/admin" }: { openings: OpeningOption[]; value: string; path?: "/admin" | "/admin/board" }) {
  const router = useRouter();
  return (
    <NativeSelect
      aria-label="Opening"
      className="w-auto max-w-full"
      value={value}
      onChange={(e) => router.push(`${path}?opening=${e.target.value}` as Route)}
    >
      {openings.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
          {o.status !== "open" ? ` (${o.status})` : ""}
        </option>
      ))}
    </NativeSelect>
  );
}
