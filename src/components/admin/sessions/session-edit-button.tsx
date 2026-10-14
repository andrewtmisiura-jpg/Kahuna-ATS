"use client";

import { Pencil } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { SessionFormDialog, type SessionFormValues, type SessionOpeningOption } from "./session-form-dialog";

export function SessionEditButton({ session, openings }: { session: SessionFormValues; openings: SessionOpeningOption[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Pencil />
        Edit
      </Button>
      {open ? <SessionFormDialog session={session} openings={openings} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
