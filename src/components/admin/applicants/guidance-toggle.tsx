"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";

// The staff-only "What to look for" notes under an answer, folded away until
// someone opens them, so they guide scoring without crowding the answers.
export function GuidanceToggle({ guidance }: { guidance: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="text-xs">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:underline"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        What to look for
      </button>
      {open ? (
        <p id={id} className="mt-1 whitespace-pre-wrap rounded-md bg-muted/50 px-2 py-1.5 text-muted-foreground">
          {guidance}
        </p>
      ) : null}
    </div>
  );
}
