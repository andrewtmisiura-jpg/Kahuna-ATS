"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import type { ActionFailure, ActionResult } from "@/server/actions/admin/application-errors";

// Runs one admin server action and handles its result the same way everywhere:
// success refreshes the page, a stale version (409) says who changed it and
// reloads, a lost sign-in goes to the sign-in page, anything else shows inline.

const STALE_RELOAD_MS = 1800;

export function useAdminAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<ActionFailure | null>(null);

  const run = useCallback(
    <T,>(call: () => Promise<ActionResult<T>>, onSuccess?: (data: T) => void) => {
      setFailure(null);
      startTransition(async () => {
        const result = await call();
        if (result.ok) {
          onSuccess?.(result.data);
          router.refresh();
          return;
        }
        setFailure(result);
        if (result.status === 409) setTimeout(() => router.refresh(), STALE_RELOAD_MS);
        if (result.status === 401) router.push("/admin/sign-in");
      });
    },
    [router],
  );

  const clear = useCallback(() => setFailure(null), []);
  return { run, pending, failure, clear };
}
