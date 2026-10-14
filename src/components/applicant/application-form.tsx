"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { saveAnswerAction, submitAction, type SaveState } from "@/server/actions/applicant/answers";
import type { AnswerValue, FormQuestion, StoredAnswer } from "@/server/services/applications/answers";
import type { FormSection } from "@/db/schema";
import { AnswerField } from "./answer-field";
import { FormNotice } from "./field-error";
import { SubmittedScreen } from "./screens";
import { SOURCES, sourceTakesDetail, type SourceKey } from "./sources";
import { APPLICANT_COPY, HIRING_NUMBER } from "./status-copy";

// The application: the pinned form's sections as short screens with a progress
// bar. Every answer saves about a second after typing stops and on blur, with a
// per-answer revision so a stale device never overwrites a newer answer, three
// retries, and one indicator: Saved, Saving, or Not saved, check your connection.
// Required checks happen only on submit.

export type ApplicationFormProps = {
  sections: FormSection[];
  questions: FormQuestion[];
  answers: StoredAnswer[];
  // Null when the landing form left "How did you hear about us?" blank; asked once at the end.
  source: string | null;
  textsBlocked: boolean;
};

type FieldStatus = "idle" | "dirty" | "saving" | "saved" | "failed";
type Field = { value: AnswerValue; revision: number; status: FieldStatus; error: string | null };

const DEBOUNCE_MS = 1000;
const RETRY_DELAYS_MS = [600, 1500, 3000];

export function ApplicationForm(props: ApplicationFormProps) {
  const initial = useMemo(() => {
    const stored = new Map(props.answers.map((a) => [a.questionVersionId, a]));
    const fields: Record<string, Field> = {};
    for (const q of props.questions) {
      const a = stored.get(q.questionVersionId);
      fields[q.questionVersionId] = { value: a?.value ?? null, revision: a?.revision ?? 0, status: "idle", error: null };
    }
    return fields;
  }, [props.answers, props.questions]);

  const [fields, setFields] = useState<Record<string, Field>>(initial);
  const latest = useRef<Record<string, Field>>(initial);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Set<string>());
  const [screen, setScreen] = useState(0);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<SourceKey | "">("");
  const [sourceDetail, setSourceDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"editing" | "submitted" | "locked" | "expired">("editing");

  const update = useCallback((id: string, patch: Partial<Field>) => {
    const next = { ...latest.current, [id]: { ...latest.current[id]!, ...patch } };
    latest.current = next;
    setFields(next);
  }, []);

  // One save in flight per answer. A value that changes while its save is out is
  // saved again with the new revision, so the server always ends with the latest.
  const save = useCallback(
    async (id: string) => {
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      try {
        for (;;) {
          const field = latest.current[id];
          if (!field || (field.status !== "dirty" && field.status !== "failed")) return;
          const sent = field.value;
          update(id, { status: "saving" });

          let result: SaveState | null = null;
          for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
            try {
              result = await saveAnswerAction({ questionVersionId: id, revision: field.revision, value: sent });
            } catch {
              result = null;
            }
            if (result && !(result.ok === false && result.reason === "error")) break;
            await sleep(RETRY_DELAYS_MS[attempt]!);
          }

          const now = latest.current[id]!;
          const changedSince = !sameValue(now.value, sent);
          if (!result || (!result.ok && result.reason === "error")) {
            update(id, { status: "failed" });
          } else if (result.ok) {
            update(id, { revision: result.revision, status: changedSince ? "dirty" : "saved", error: null });
          } else if (result.reason === "stale") {
            // A newer answer exists: keep what the applicant is typing now, otherwise show the newer one.
            update(id, { value: changedSince ? now.value : result.value, revision: result.revision, status: changedSince ? "dirty" : "saved" });
          } else if (result.reason === "invalid") {
            update(id, { status: "failed", error: result.message });
          } else if (result.reason === "locked") {
            setOutcome((current) => (current === "submitted" ? current : "locked"));
            return;
          } else {
            setOutcome("expired");
            return;
          }
          if (!changedSince) return;
        }
      } finally {
        inFlight.current.delete(id);
      }
    },
    [update],
  );

  const schedule = useCallback(
    (id: string) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void save(id);
        }, DEBOUNCE_MS),
      );
    },
    [save],
  );

  const flush = useCallback(
    (id: string) => {
      const existing = timers.current.get(id);
      if (existing) {
        clearTimeout(existing);
        timers.current.delete(id);
      }
      void save(id);
    },
    [save],
  );

  const flushAll = useCallback(() => {
    for (const id of Object.keys(latest.current)) flush(id);
  }, [flush]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const onChange = (q: FormQuestion, value: AnswerValue) => {
    update(q.questionVersionId, { value, status: "dirty", error: null });
    if (!isEmptyValue(value) && missing.has(q.questionVersionId)) {
      const next = new Set(missing);
      next.delete(q.questionVersionId);
      setMissing(next);
    }
    const typed = q.type === "short_text" || q.type === "long_text" || q.type === "number" || q.type === "date";
    if (typed) schedule(q.questionVersionId);
    else flush(q.questionVersionId);
  };

  const screens = useMemo(() => {
    const sections = props.sections
      .map((section) => ({ ...section, questions: props.questions.filter((q) => q.sectionKey === section.key) }))
      .filter((section) => section.questions.length > 0);
    return [...sections, { key: "__send", title: "Send", intro: undefined, questions: [] as FormQuestion[] }];
  }, [props.sections, props.questions]);

  const goTo = (index: number) => {
    flushAll();
    setScreen(Math.max(0, Math.min(screens.length - 1, index)));
    window.scrollTo({ top: 0 });
  };

  const submit = async () => {
    flushAll();
    setSubmitError(null);
    const unanswered = props.questions.filter((q) => q.required && isEmptyValue(latest.current[q.questionVersionId]?.value ?? null));
    if (unanswered.length > 0) {
      setMissing(new Set(unanswered.map((q) => q.questionVersionId)));
      jumpToFirst(unanswered[0]!.questionVersionId);
      return;
    }
    setSubmitting(true);
    const pending = Object.entries(latest.current)
      .filter(([, f]) => f.status === "dirty" || f.status === "saving" || f.status === "failed")
      .map(([questionVersionId, f]) => ({ questionVersionId, revision: f.revision, value: f.value }));
    const sourceInput = props.source === null && source ? { source, sourceDetail: sourceTakesDetail(source) ? sourceDetail : undefined } : null;

    let result: Awaited<ReturnType<typeof submitAction>> | null = null;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      try {
        result = await submitAction({ pending, source: sourceInput });
      } catch {
        result = null;
      }
      if (result && !(result.ok === false && result.reason === "error")) break;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
    setSubmitting(false);
    if (!result || (!result.ok && result.reason === "error")) {
      setSubmitError("Not sent, check your connection and try again.");
      return;
    }
    if (result.ok || result.reason === "already_submitted") {
      setOutcome("submitted");
      return;
    }
    if (result.reason === "required_missing") {
      setMissing(new Set(result.missing));
      if (result.missing[0]) jumpToFirst(result.missing[0]);
      return;
    }
    if (result.reason === "no_session") return setOutcome("expired");
    if (result.reason === "closed") return setOutcome("locked");
    setSubmitError(result.message);
  };

  const jumpToFirst = (questionVersionId: string) => {
    const index = screens.findIndex((s) => s.questions.some((q) => q.questionVersionId === questionVersionId));
    if (index >= 0) {
      setScreen(index);
      window.scrollTo({ top: 0 });
    }
  };

  if (outcome === "submitted") return <SubmittedScreen />;
  if (outcome === "locked") {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Your application</h1>
        <FormNotice>This application was already sent or closed. Reload the page to see where it stands.</FormNotice>
        <Button asChild variant="outline" className="h-12 w-full">
          <Link href="/apply">Reload</Link>
        </Button>
      </div>
    );
  }
  if (outcome === "expired") {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Your link has expired</h1>
        <p className="text-muted-foreground">{APPLICANT_COPY.expiredLink}</p>
        <Button asChild className="h-12 w-full">
          <Link href="/lost-link">Get a new link</Link>
        </Button>
      </div>
    );
  }

  const current = screens[screen]!;
  const isLast = screen === screens.length - 1;
  const indicator = saveIndicator(fields);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Your application</h1>
          <span className="text-xs text-muted-foreground">
            {screen + 1} of {screens.length}
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={screens.length}
          aria-valuenow={screen + 1}
          aria-label="Progress"
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary transition-all" style={{ width: `${((screen + 1) / screens.length) * 100}%` }} />
        </div>
        <p
          aria-live="polite"
          className={cn("min-h-5 text-sm", indicator === "failed" ? "text-destructive" : "text-muted-foreground")}
        >
          {indicator === "saving" ? APPLICANT_COPY.saving : indicator === "saved" ? APPLICANT_COPY.saved : indicator === "failed" ? APPLICANT_COPY.notSaved : ""}
        </p>
      </div>

      {props.textsBlocked && screen === 0 ? <FormNotice>{APPLICANT_COPY.textsBlocked}</FormNotice> : null}

      <section className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold">{current.title}</h2>
          {current.intro ? <p className="text-sm text-muted-foreground">{current.intro}</p> : null}
          {screen === 0 ? <p className="text-sm text-muted-foreground">Your answers save as you go. You can finish on any device.</p> : null}
        </div>

        {current.questions.map((q) => {
          const field = fields[q.questionVersionId]!;
          return (
            <AnswerField
              key={q.questionVersionId}
              question={q}
              value={field.value}
              required={q.required}
              missing={missing.has(q.questionVersionId)}
              error={field.error}
              onChange={(value) => onChange(q, value)}
              onBlur={() => flush(q.questionVersionId)}
            />
          );
        })}

        {isLast ? (
          <div className="space-y-4">
            {props.source === null ? (
              <div className="space-y-1.5">
                <Label htmlFor="apply-source">How did you hear about us? (optional)</Label>
                <select
                  id="apply-source"
                  value={source}
                  onChange={(event) => setSource(event.target.value as SourceKey | "")}
                  className="h-12 w-full rounded-md border border-input bg-transparent px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="">Choose one</option>
                  {SOURCES.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {sourceTakesDetail(source || null) ? (
                  <Input
                    className="h-12"
                    value={sourceDetail}
                    maxLength={200}
                    onChange={(event) => setSourceDetail(event.target.value)}
                    placeholder={source === "referral" ? "Who referred you?" : "Tell us where"}
                    aria-label={source === "referral" ? "Who referred you?" : "Where did you hear about us?"}
                  />
                ) : null}
              </div>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Tap Send when you are done. You can go back to check any answer first.
            </p>
            {missing.size > 0 ? <FormNotice tone="error">A few required questions are not answered yet. Go back to answer them.</FormNotice> : null}
            {submitError ? <FormNotice tone="error">{submitError}</FormNotice> : null}
          </div>
        ) : null}
      </section>

      <div className="flex gap-3">
        {screen > 0 ? (
          <Button type="button" variant="outline" className="h-12 flex-1 text-base" onClick={() => goTo(screen - 1)}>
            Back
          </Button>
        ) : null}
        {isLast ? (
          <Button type="button" className="h-12 flex-1 text-base" disabled={submitting} onClick={() => void submit()}>
            {submitting ? "Sending" : "Send my application"}
          </Button>
        ) : (
          <Button type="button" className="h-12 flex-1 text-base" onClick={() => goTo(screen + 1)}>
            Next
          </Button>
        )}
      </div>
      <p className="text-center text-xs text-muted-foreground">Questions? Call or text {HIRING_NUMBER}.</p>
    </div>
  );
}

function saveIndicator(fields: Record<string, Field>): "idle" | "saving" | "saved" | "failed" {
  const statuses = Object.values(fields).map((f) => f.status);
  if (statuses.includes("saving") || statuses.includes("dirty")) return "saving";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("saved")) return "saved";
  return "idle";
}

function isEmptyValue(value: AnswerValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function sameValue(a: AnswerValue, b: AnswerValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
