"use client";

import { cloneElement, isValidElement, useId, useState, type ReactElement } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ActionFailure } from "@/server/actions/admin/application-errors";
import { formatDateTime, toLocalInputValue } from "./format";

// Small form pieces for the dialogs and panels. Native selects, checkboxes and
// textareas: they work best on a phone and need no extra code.

// A labelled control. The label points at the control through its id; a group
// (radios, several inputs) is a labelled group instead, so screen readers and
// tests find both kinds by their label.
export function Field({
  label,
  hint,
  children,
  className,
  group = false,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
  group?: boolean;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const control = !group && isValidElement(children) ? cloneElement(children as ReactElement<{ id?: string }>, { id }) : children;
  return (
    <div className={cn("grid gap-1.5", className)} role={group ? "group" : undefined} aria-labelledby={group ? labelId : undefined}>
      <Label id={labelId} htmlFor={group ? undefined : id} className="text-sm">
        {label}
      </Label>
      {control}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

export function NativeSelect(props: React.ComponentProps<"select">) {
  const { className, ...rest } = props;
  return <select className={cn(selectClass, className)} {...rest} />;
}

export function Textarea(props: React.ComponentProps<"textarea">) {
  const { className, ...rest } = props;
  return (
    <textarea
      className={cn(
        "min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
      {...rest}
    />
  );
}

export function CheckboxRow({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="flex items-start gap-2 text-sm">
        <input id={id} type="checkbox" className="mt-0.5 size-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint ? <p className="pl-6 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function YesNo({ value, onChange, name }: { value: boolean; onChange: (value: boolean) => void; name: string }) {
  return (
    <div className="flex gap-4 text-sm">
      {[
        { label: "Yes", v: true },
        { label: "No", v: false },
      ].map((option) => (
        <label key={option.label} className="flex items-center gap-1.5">
          <input type="radio" name={name} checked={value === option.v} onChange={() => onChange(option.v)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}

// "When did this happen?" Defaults to now; the backdate control opens a
// datetime-local input. Returns an ISO instant or undefined for "now".
export function OccurredAtField({ value, onChange }: { value: string | undefined; onChange: (iso: string | undefined) => void }) {
  const [backdate, setBackdate] = useState(Boolean(value));
  const [local, setLocal] = useState(() => toLocalInputValue(value ? new Date(value) : new Date()));
  const nameId = useId();
  return (
    <Field label="When did this happen?" group>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name={nameId}
            checked={!backdate}
            onChange={() => {
              setBackdate(false);
              onChange(undefined);
            }}
          />
          Now
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name={nameId}
            checked={backdate}
            onChange={() => {
              setBackdate(true);
              onChange(new Date(local).toISOString());
            }}
          />
          Earlier (backdate)
        </label>
      </div>
      {backdate ? (
        <Input
          type="datetime-local"
          value={local}
          max={toLocalInputValue(new Date())}
          onChange={(e) => {
            setLocal(e.target.value);
            const parsed = new Date(e.target.value);
            onChange(Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString());
          }}
        />
      ) : null}
      {backdate && value ? <p className="text-xs text-muted-foreground">Recorded as {formatDateTime(value)} Central.</p> : null}
    </Field>
  );
}

export function ActionNotice({ failure, className }: { failure: ActionFailure | null; className?: string }) {
  if (!failure) return null;
  const stale = failure.status === 409;
  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        stale ? "border-amber-300 bg-amber-50 text-amber-900" : "border-destructive/40 bg-destructive/5 text-destructive",
        className,
      )}
    >
      {stale && failure.stale ? (
        <>
          Changed by {failure.stale.changedBy} at {formatDateTime(failure.stale.changedAt)}. Reloading.
        </>
      ) : (
        failure.message
      )}
    </div>
  );
}
