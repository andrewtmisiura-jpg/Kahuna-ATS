"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { suggestEmailAction } from "@/server/actions/applicant/email";
import { landAction, type LandState } from "@/server/actions/applicant/land";
import { FieldError, FormNotice } from "./field-error";
import { SOURCES, sourceTakesDetail, type SourceKey } from "./sources";
import { APPLICANT_COPY, HIRING_NUMBER } from "./status-copy";
import { Turnstile } from "./turnstile";

export type LandingFormProps = {
  code: string;
  consentVersionId: string;
  consentLabel: string;
  // Safe HTML from the legal renderer; links open in a new tab so the form is not lost.
  consentDisclosureHtml: string;
  // The AI notice version the page shows, posted back so a stale page is caught.
  aiDisclosureVersionId: string | null;
  turnstileSiteKey: string | null;
  nonce: string | null;
};

const idle: LandState = { status: "idle" };

export function LandingForm(props: LandingFormProps) {
  const [state, formAction, pending] = useActionState(landAction, idle);
  const [email, setEmail] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [source, setSource] = useState<SourceKey | "">("");
  const ids = useId();

  // The application opens with a full page load, so the bot-check script stays behind.
  useEffect(() => {
    if (state.status === "created") window.location.assign(state.textsBlocked ? "/apply?texts=off" : "/apply");
  }, [state]);

  if (state.status === "created") {
    return <p className="text-muted-foreground">Opening your application.</p>;
  }
  if (state.status === "check_messages") {
    return <FormNotice>{APPLICANT_COPY.checkMessages}</FormNotice>;
  }
  if (state.status === "rate_limited") {
    return <FormNotice>{APPLICANT_COPY.tooManyLinks}</FormNotice>;
  }
  if (state.status === "not_open") {
    return <FormNotice>{APPLICANT_COPY.notOpen}</FormNotice>;
  }

  const errors = state.status === "errors" ? state.errors : {};
  const emailSuggestion = suggestion ?? (state.status === "errors" ? (state.emailSuggestion ?? null) : null);

  const checkEmail = async (value: string) => {
    const typed = value.trim();
    if (!typed) return setSuggestion(null);
    const hint = await suggestEmailAction(typed);
    setSuggestion(hint && hint.toLowerCase() !== typed.toLowerCase() ? hint : null);
  };

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="code" value={props.code} />
      <input type="hidden" name="consentVersionId" value={props.consentVersionId} />
      <input type="hidden" name="aiDisclosureVersionId" value={props.aiDisclosureVersionId ?? ""} />

      {errors.form ? <FormNotice tone="error">{errors.form}</FormNotice> : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-first`}>First name</Label>
          <Input
            id={`${ids}-first`}
            name="firstName"
            autoComplete="given-name"
            className="h-12"
            required
            aria-invalid={Boolean(errors.firstName)}
            aria-describedby={errors.firstName ? `${ids}-first-error` : undefined}
          />
          <FieldError id={`${ids}-first-error`} message={errors.firstName} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-last`}>Last name</Label>
          <Input
            id={`${ids}-last`}
            name="lastName"
            autoComplete="family-name"
            className="h-12"
            required
            aria-invalid={Boolean(errors.lastName)}
            aria-describedby={errors.lastName ? `${ids}-last-error` : undefined}
          />
          <FieldError id={`${ids}-last-error`} message={errors.lastName} />
        </div>
      </div>

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

      <div className="space-y-2 rounded-md border p-3">
        <label className="flex items-start gap-3 text-sm leading-snug">
          <input type="checkbox" name="textConsent" className="mt-0.5 size-5 shrink-0 accent-primary" />
          <span>{props.consentLabel}</span>
        </label>
        <div
          className="text-xs leading-relaxed text-muted-foreground [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: props.consentDisclosureHtml }}
        />
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
          onBlur={(event) => void checkEmail(event.target.value)}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? `${ids}-email-error` : undefined}
        />
        <FieldError id={`${ids}-email-error`} message={errors.email} />
        {emailSuggestion ? (
          <button
            type="button"
            className="text-sm underline underline-offset-2"
            onClick={() => {
              setEmail(emailSuggestion);
              setSuggestion(null);
            }}
          >
            Did you mean {emailSuggestion}?
          </button>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${ids}-source`}>How did you hear about us? (optional)</Label>
        <select
          id={`${ids}-source`}
          name="source"
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
            name="sourceDetail"
            className="h-12"
            placeholder={source === "referral" ? "Who referred you?" : "Tell us where"}
            maxLength={200}
            aria-label={source === "referral" ? "Who referred you?" : "Where did you hear about us?"}
          />
        ) : null}
      </div>

      <Turnstile siteKey={props.turnstileSiteKey} nonce={props.nonce} resetOn={state.status === "errors" ? state : null} />

      <Button type="submit" className="h-12 w-full text-base" disabled={pending}>
        {pending ? "One moment" : "Start my application"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">Questions? Call or text {HIRING_NUMBER}.</p>
    </form>
  );
}
