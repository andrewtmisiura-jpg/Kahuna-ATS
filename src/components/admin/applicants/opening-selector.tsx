"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import type { OpeningOption } from "@/server/services/applications/queries";
import { NativeSelect } from "./fields";

export function OpeningSelector({ openings, value }: { openings: OpeningOption[]; value: string }) {
  const router = useRouter();
  return (
    <NativeSelect
      aria-label="Opening"
      className="w-auto max-w-full"
      value={value}
      onChange={(e) => router.push(`/admin?opening=${e.target.value}` as Route)}
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
