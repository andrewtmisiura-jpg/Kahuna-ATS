"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ScoringMode } from "@/db/schema";
import { cn } from "@/lib/utils";
import { setScoringModeAction } from "@/server/actions/admin/rubrics";
import { Notice } from "../fields";
import { MODE_EXPLANATIONS, MODE_LABELS, MODES } from "./format";

// A role's scoring mode as three choices, each with what it means. A pick saves at once.
// Hidden and visible need a published rubric version.
export function ModeControl({ roleId, mode, canTurnOn }: { roleId: string; mode: ScoringMode; canTurnOn: boolean }) {
  const router = useRouter();
  const [choice, setChoice] = useState<ScoringMode>(mode);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pick(next: ScoringMode) {
    if (next === choice) return;
    setChoice(next);
    setError(null);
    startTransition(async () => {
      const result = await setScoringModeAction({ roleId, mode: next });
      if (!result.ok) {
        setError(result.message);
        setChoice(mode);
      }
      router.refresh();
    });
  }

  return (
    <fieldset className="grid gap-2" disabled={pending}>
      <legend className="mb-2 text-sm font-medium">Scoring</legend>
      {MODES.map((value) => {
        const locked = value !== "off" && !canTurnOn;
        return (
          <label
            key={value}
            className={cn(
              "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm has-checked:border-primary has-checked:bg-primary/5",
              locked && "cursor-not-allowed opacity-60",
            )}
          >
            <input
              type="radio"
              name={`scoring-mode-${roleId}`}
              value={value}
              checked={choice === value}
              disabled={locked}
              onChange={() => pick(value)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>
              <span className="font-medium">{MODE_LABELS[value]}</span>
              <span className="block text-muted-foreground">{MODE_EXPLANATIONS[value]}</span>
            </span>
          </label>
        );
      })}
      {!canTurnOn ? <p className="text-xs text-muted-foreground">Publish a rubric version to turn scoring on.</p> : null}
      {mode === "hidden" ? (
        <p className="text-xs text-muted-foreground">
          Scores made while hidden stay hidden after you switch to visible. Re-score all to show new ones.
        </p>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </fieldset>
  );
}
