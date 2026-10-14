import { env, isProduction } from "@/config/env";
import { createQuoProvider } from "./quo";
import { createResendProvider } from "./resend";
import { createSinkProviders } from "./sink";
import type { Providers } from "./types";

export * from "./types";
export { createSinkProviders, type SinkProviders, type SinkSend } from "./sink";
export { createQuoProvider, classifyQuoError } from "./quo";
export { createResendProvider } from "./resend";

let cached: Providers | undefined;

// The providers the running process sends through: Quo and Resend in production
// (or with MESSAGE_PROVIDERS=live), otherwise a sink that logs and sends nothing.
export function getProviders(): Providers {
  if (!cached) {
    const config = env();
    const mode = config.MESSAGE_PROVIDERS ?? (isProduction() ? "live" : "sink");
    cached =
      mode === "live"
        ? {
            text: createQuoProvider({ apiKey: config.QUO_API_KEY, baseUrl: config.QUO_API_BASE_URL }),
            email: createResendProvider({ apiKey: config.RESEND_API_KEY }),
          }
        : createSinkProviders({ log: true });
  }
  return cached;
}
