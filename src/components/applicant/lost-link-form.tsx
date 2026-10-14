"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { suggestEmailAction } from "@/server/actions/applicant/email";
import { lostLinkAction, type LostLinkState } from "@/server/actions/applicant/lost-link";
import { FieldError, FormNotice } from "./field-error";
import { APPLICANT_COPY, QUESTIONS_LINE } from "./status-copy";
import { Turnstile } from "./turnstile";

const idle: LostLinkState = { status: "idle" };

export function LostLinkForm({ turnstileSiteKey, nonce }: { turnstileSiteKey: string | null; nonce: string | null }) {
  const [state, formAction, pending] = useActionState(lostLinkAction, idle);
  const [email, setEmail] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const ids = useId();

  if (state.status === "sent") {
    return (
      <div className="space-y-3">
        <FormNotice>{APPLICANT_COPY.lostLinkSent}</FormNotice>
        <p className="text-sm text-muted-foreground">{QUESTIONS_LINE}</p>
      </div>
    );
  }
  const errors = state.status === "errors" ? state.errors : {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {errors.form ? <FormNotice tone="error">{errors.form}</FormNotice> : null}
      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-mobile`}>Mobile number</Label>
        <Input
          id={`${ids}-mobile`}
          name="mobile"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="612-555-0123"
          className="h-12"
          required
          aria-invalid={Boolean(errors.mobile)}
          aria-describedby={errors.mobile ? `${ids}-mobile-error` : undefined}
        />
        <FieldError id={`${ids}-mobile-error`} message={errors.mobile} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-email`}>Email</Label>
        <Input
          id={`${ids}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          className="h-12"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setSuggestion(null);
          }}
          onBlur={async (event) => {
            const typed = event.target.value.trim();
            const hint = typed ? await suggestEmailAction(typed) : null;
            setSuggestion(hint && hint.toLowerCase() !== typed.toLowerCase() ? hint : null);
          }}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? `${ids}-email-error` : undefined}
        />
        <FieldError id={`${ids}-email-error`} message={errors.email} />
        {suggestion ? (
          <button
            type="button"
            className="text-sm underline underline-offset-2"
            onClick={() => {
              setEmail(suggestion);
              setSuggestion(null);
            }}
          >
            Did you mean {suggestion}?
          </button>
        ) : null}
      </div>
      <Turnstile siteKey={turnstileSiteKey} nonce={nonce} resetOn={state.status === "errors" ? state : null} />
      <Button type="submit" className="h-12 w-full text-base" disabled={pending}>
        {pending ? "One moment" : "Send my link"}
      </Button>
    </form>
  );
}
