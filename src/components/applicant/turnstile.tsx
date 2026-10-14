"use client";

import Script from "next/script";
import { useEffect } from "react";

// Cloudflare Turnstile, implicit rendering: the script finds the .cf-turnstile box
// and adds the hidden cf-turnstile-response field to the form. Rendered only when
// a site key is set; the script carries the page's CSP nonce.

declare global {
  interface Window {
    turnstile?: { reset: (container?: string | HTMLElement) => void };
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";

export function Turnstile({ siteKey, nonce, resetOn }: { siteKey: string | null; nonce: string | null; resetOn: unknown }) {
  // A token is single-use: after a refused submit (a new error state) the widget issues a fresh one.
  useEffect(() => {
    if (resetOn) window.turnstile?.reset();
  }, [resetOn]);

  if (!siteKey) return null;
  return (
    <>
      <Script src={SCRIPT_URL} strategy="afterInteractive" nonce={nonce ?? undefined} />
      <div className="cf-turnstile" data-sitekey={siteKey} data-size="flexible" data-theme="light" />
    </>
  );
}
