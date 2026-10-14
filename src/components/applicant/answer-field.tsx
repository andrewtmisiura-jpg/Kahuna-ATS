"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AnswerValue, FormQuestion } from "@/server/services/applications/answers";
import { FieldError } from "./field-error";

// One question rendered for a phone. Text, number and date inputs report blur so
// the form can save at once; choices save on change.

export type AnswerFieldProps = {
  question: FormQuestion;
  value: AnswerValue;
  required: boolean;
  missing: boolean;
  error: string | null;
  onChange: (value: AnswerValue) => void;
  onBlur: () => void;
};

const choiceClass =
  "flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-left text-base has-checked:border-primary has-checked:bg-primary/5";

export function AnswerField({ question, value, required, missing, error, onChange, onBlur }: AnswerFieldProps) {
  const id = useId();
  const describedBy = [missing ? `${id}-missing` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;

  return (
    <fieldset className="space-y-2" aria-describedby={describedBy}>
      <legend className="text-base font-medium leading-snug">
        {question.prompt}
        {required ? null : <span className="ml-1 text-sm font-normal text-muted-foreground">(optional)</span>}
      </legend>
      {question.help ? <p className="text-sm text-muted-foreground">{question.help}</p> : null}
      {renderInput()}
      {missing ? (
        <p id={`${id}-missing`} role="alert" className="text-sm text-destructive">
          This one is required
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </fieldset>
  );

  function renderInput() {
    switch (question.type) {
      case "short_text":
        return (
          <Input
            id={id}
            className="h-12"
            value={typeof value === "string" ? value : ""}
            maxLength={question.validation?.maxLength ?? 200}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            aria-label={question.prompt}
          />
        );
      case "long_text":
        return (
          <textarea
            id={id}
            rows={4}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={typeof value === "string" ? value : ""}
            maxLength={question.validation?.maxLength ?? 2000}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            aria-label={question.prompt}
          />
        );
      case "number":
        return (
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            className="h-12"
            value={typeof value === "number" ? String(value) : typeof value === "string" ? value : ""}
            min={question.validation?.min}
            max={question.validation?.max}
            step={question.validation?.integer ? 1 : "any"}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === "") return onChange(null);
              const n = Number(raw);
              onChange(Number.isFinite(n) ? n : raw);
            }}
            onBlur={onBlur}
            aria-label={question.prompt}
          />
        );
      case "date":
        return (
          <Input
            id={id}
            type="date"
            className="h-12"
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value || null)}
            onBlur={onBlur}
            aria-label={question.prompt}
          />
        );
      case "yes_no":
        return (
          <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label={question.prompt}>
            {[
              { label: "Yes", bool: true },
              { label: "No", bool: false },
            ].map((option) => (
              <label key={option.label} className={cn(choiceClass, "justify-center")}>
                <input
                  type="radio"
                  name={id}
                  className="sr-only"
                  checked={value === option.bool}
                  onChange={() => onChange(option.bool)}
                />
                <span className={cn(value === option.bool && "font-semibold")}>{option.label}</span>
              </label>
            ))}
          </div>
        );
      case "single_choice":
        return (
          <div className="space-y-2" role="radiogroup" aria-label={question.prompt}>
            {(question.options ?? []).map((option) => {
              const checked = Array.isArray(value) && value[0] === option.key;
              return (
                <label key={option.key} className={choiceClass}>
                  <input type="radio" name={id} className="size-5 accent-primary" checked={checked} onChange={() => onChange([option.key])} />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
        );
      case "multi_choice":
        return (
          <div className="space-y-2" role="group" aria-label={question.prompt}>
            {(question.options ?? []).map((option) => {
              const picked = Array.isArray(value) ? value : [];
              const checked = picked.includes(option.key);
              return (
                <label key={option.key} className={choiceClass}>
                  <input
                    type="checkbox"
                    className="size-5 accent-primary"
                    checked={checked}
                    onChange={() => onChange(checked ? picked.filter((k) => k !== option.key) : [...picked, option.key])}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
        );
    }
  }
}
