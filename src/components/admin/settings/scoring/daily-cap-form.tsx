"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { updateScoringCapAction } from "@/server/actions/admin/rubrics";
import { Field, Notice } from "../fields";

// employer.scoring_daily_cap: AI scoring calls per Central day across all roles.
export function DailyCapForm({ cap, usedToday, max }: { cap: number; usedToday: number; max: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(cap));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateScoringCapAction({ cap: value.trim() === "" ? Number.NaN : Number(value) });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily scoring limit</CardTitle>
        <CardDescription>
          AI scoring calls per day across all roles. Past the limit, scoring waits until midnight Central and the owner gets one alert email that day.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Scores per day" htmlFor="scoring-daily-cap" hint={`${usedToday} used today. Default 100; at most ${max}.`}>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="scoring-daily-cap"
                type="number"
                min={1}
                max={max}
                step={1}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="h-11 w-32 sm:h-9"
              />
              <Button type="submit" disabled={pending} className="h-11 sm:h-9">
                {pending ? "Saving" : "Save"}
              </Button>
            </div>
          </Field>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {saved && !error ? <Notice>Saved.</Notice> : null}
        </form>
      </CardContent>
    </Card>
  );
}
