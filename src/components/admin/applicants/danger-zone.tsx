"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { deleteTestApplicationAction } from "@/server/actions/admin/applications";
import type { ActionFailure } from "@/server/actions/admin/application-errors";
import { ActionNotice } from "./fields";
import { Section } from "./section";

// Admin only: soft-deletes a test application and writes an audit row
// (DATA_MODEL.md, application). Used to clear the dry run before go-live.

export function DangerZone({ applicationId, listHref }: { applicationId: string; listHref: Route }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  return (
    <Section title="Admin">
      <p className="text-sm text-muted-foreground">Delete this application if it was a test. It leaves every count and report; the audit log keeps who deleted it and when.</p>
      <div className="mt-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => {
            if (!window.confirm("Delete this test application? This cannot be undone from the app.")) return;
            startTransition(async () => {
              const result = await deleteTestApplicationAction({ applicationId });
              if (result.ok) router.push(listHref);
              else setFailure(result);
            });
          }}
        >
          Delete test application
        </Button>
      </div>
      <ActionNotice failure={failure} className="mt-2" />
    </Section>
  );
}
