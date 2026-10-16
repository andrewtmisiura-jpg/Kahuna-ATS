import Anthropic from "@anthropic-ai/sdk";
import { env, type Env } from "@/config/env";
import { ScorerError } from "./errors";
import { LIVE_PROMPT_VERSION, parseScorerReply, SCORING_EFFORT, scoringOutputSchema, scoringSystemPrompt, scoringUserMessage } from "./prompt";
import { REFUSAL_ERROR, type RubricForScoring, type Scorer, type ScoreResult, type ScoringInput } from "./types";

// The live scorer (PLAN.md, Stack: "Anthropic SDK with structured output, model id in
// config, no tools"): one Messages API call per application, with the rubric as the
// system text, the anonymous input as the user message, a strict JSON schema for the
// reply, effort set explicitly and server-side fallbacks on. Thinking is always on for
// this model and needs no setting; there is no temperature and no prefill. It logs
// nothing: the key, the answers and the reply stay out of the logs.

// "default" fallbacks: when the model declines for a policy reason, the API re-runs the
// same request on Anthropic's recommended model for that kind of refusal, in one call.
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Thinking counts toward max_tokens; the reply itself is a few hundred tokens.
const MAX_TOKENS = 16_000;
// A pass gives jobs two minutes, so a call that hangs gives up and is retried later.
const TIMEOUT_MS = 90_000;

type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

// The one call the scorer makes, so tests hand in a fake client and check the request.
export type CreateMessage = (params: MessageParams) => Promise<Message>;

export function scoringRequest(rubric: RubricForScoring, input: ScoringInput, model: string): MessageParams {
  return {
    model,
    max_tokens: MAX_TOKENS,
    betas: [SERVER_SIDE_FALLBACK_BETA],
    fallbacks: "default",
    // The same text for every application on a rubric version, so it is cached.
    system: [{ type: "text", text: scoringSystemPrompt(rubric), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: scoringUserMessage(input) }],
    output_config: { effort: SCORING_EFFORT, format: { type: "json_schema", schema: scoringOutputSchema(rubric) } },
  };
}

export function createAnthropicScorer(options: { createMessage: CreateMessage; model: string }): Scorer {
  return {
    async score(rubric, input): Promise<ScoreResult> {
      let response: Message;
      try {
        response = await options.createMessage(scoringRequest(rubric, input, options.model));
      } catch (error) {
        throw scorerError(error);
      }
      // A fallback model may have answered; the stored id is the one that did.
      const about = { modelId: response.model, promptVersion: LIVE_PROMPT_VERSION };
      if (response.stop_reason === "refusal") {
        return { status: "failed", error: REFUSAL_ERROR, rawOutput: { stop_reason: "refusal", category: response.stop_details?.category ?? null }, ...about };
      }
      const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      if (response.stop_reason === "max_tokens") {
        return { status: "invalid_output", error: "The reply was cut off at the token limit", rawOutput: text, ...about };
      }
      const parsed = parseScorerReply(rubric, text);
      if (!parsed.ok) return { status: "invalid_output", error: parsed.error, rawOutput: parsed.raw, ...about };
      const usage = response.usage;
      return {
        status: "succeeded",
        ...about,
        criteria: parsed.reply.criteria,
        overallRationale: parsed.reply.overallRationale,
        flags: parsed.reply.flags,
        overallScore: null,
        // Every input token the call read, cached or not.
        inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
        rawOutput: parsed.raw,
      };
    },
  };
}

// Timeouts, dropped connections, 408, 409, 429 and 5xx are worth retrying in a few
// minutes. Any other refusal (a bad key, a model the account cannot use, a rejected
// request) will not fix itself, so scoring pauses until someone looks. The message
// carries the status and error type only, never the request.
export function scorerError(error: unknown): ScorerError {
  if (error instanceof ScorerError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ScorerError("retryable", "The scoring call timed out");
  if (error instanceof Anthropic.APIConnectionError) return new ScorerError("retryable", "The scoring call could not reach Anthropic");
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const label = `${status ?? "no status"}${error.type ? ` ${error.type}` : ""}`;
    if (status === undefined || status === 408 || status === 409 || status === 429 || status >= 500) {
      return new ScorerError("retryable", `Anthropic answered ${label}; trying again later`);
    }
    return new ScorerError("unavailable", `Anthropic refused the scoring call (${label})`);
  }
  return new ScorerError("retryable", `The scoring call failed (${error instanceof Error ? error.name : "unknown error"})`);
}

// The live scorer on the real API, with the key and the model (SCORING_MODEL, by default
// claude-opus-5-5) from the environment. The SDK retries a 429 or 5xx once; after that
// the job runner's backoff takes over.
export function anthropicScorerFromEnv(config: Pick<Env, "ANTHROPIC_API_KEY" | "SCORING_MODEL"> = env()): Scorer {
  if (!config.ANTHROPIC_API_KEY) throw new ScorerError("unavailable", "ANTHROPIC_API_KEY is not set, so nothing can be scored");
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 1, timeout: TIMEOUT_MS });
  return createAnthropicScorer({ createMessage: (params) => client.beta.messages.create(params), model: config.SCORING_MODEL });
}
