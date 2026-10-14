import * as React from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Small form pieces the configuration screens share. Native controls on purpose:
// they post with FormData, work without JavaScript and behave well on phones.

const controlClass =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30";

export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(controlClass, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(controlClass, "min-h-20 py-2", className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function CheckboxField({
  label,
  hint,
  className,
  ...props
}: React.ComponentProps<"input"> & { label: string; hint?: React.ReactNode }) {
  const id = React.useId();
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" {...props} />
      <div className="grid gap-1">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

// A sentence the staff member needs to read: an error from an action, or a rule.
export function Notice({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "error" | "warning";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "error" && "border-destructive/40 bg-destructive/5 text-destructive",
        tone === "warning" && "border-amber-300 bg-amber-50 text-amber-900",
        tone === "info" && "border-border bg-muted/40 text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
