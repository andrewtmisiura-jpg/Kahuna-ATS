import { env, isProduction, type Env } from "@/config/env";
import { fakeScorer } from "./fake";
import type { Scorer } from "./types";

export type ScoringProvider = "live" | "fake";

// Which scorer the running process uses, mirroring MESSAGE_PROVIDERS: the Anthropic
// model in production (or with SCORING_PROVIDER=live), otherwise the deterministic
// fake that calls nothing.
export function scoringProvider(config: Pick<Env, "SCORING_PROVIDER"> = env(), production = isProduction()): ScoringProvider {
  return config.SCORING_PROVIDER ?? (production ? "live" : "fake");
}

// Whether ANTHROPIC_API_KEY is set, so scoring and the rubric editor's "Try it" can say
// plainly that it is missing. The key itself never leaves the server's environment: it
// is never returned, logged or sent to the browser.
export function anthropicKeyConfigured(config: Pick<Env, "ANTHROPIC_API_KEY"> = env()): boolean {
  return Boolean(config.ANTHROPIC_API_KEY);
}

export function getScorer(provider: ScoringProvider = scoringProvider()): Scorer {
  if (provider === "live") {
    // The scoring build puts the Anthropic scorer here: structured output with a strict
    // schema, the model id in config, no tools.
    throw new Error("Live scoring is not built yet");
  }
  return fakeScorer;
}
