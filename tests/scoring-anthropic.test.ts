import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { anthropicScorerFromEnv, createAnthropicScorer, SERVER_SIDE_FALLBACK_BETA, type CreateMessage } from "@/server/services/scoring/anthropic";
import { scoreWithRubric } from "@/server/services/scoring/engine";
import { ScorerError } from "@/server/services/scoring/errors";
import { LIVE_PROMPT_VERSION } from "@/server/services/scoring/prompt";
import { buildApplicationSnapshot } from "@/server/services/scoring/snapshot";
import type { RubricForScoring } from "@/server/services/scoring/types";

// The live scorer (scoring/anthropic.ts) with a fake Anthropic client in place of the
// network: the request it builds, and how it reads a success, a refusal, a broken reply
// and an error. Nothing here reaches Anthropic.

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

const RUBRIC: RubricForScoring = {
  rubricVersionId: "00000000-0000-7000-8000-000000000001",
  instructions: "Reward owning a problem.",
  allowedFlags: [{ key: "no_example", label: "Gave no real example" }],
  criteria: [
    {
      criterionId: "00000000-0000-7000-8000-000000000010",
      key: "reliability",
      name: "Reliability",
      weight: 2,
      guidanceStrong: "Gave notice early and owns it.",
      guidanceAcceptable: "Some notice.",
      guidanceWeak: "Says it never happened.",
      questions: [{ questionId: "00000000-0000-7000-8000-000000000100", key: "missed_commitment", prompt: "Tell us about a missed shift." }],
    },
    {
      criterionId: "00000000-0000-7000-8000-000000000011",
      key: "integrity",
      name: "Integrity",
      weight: 1,
      guidanceStrong: "Fixed or reported it.",
      guidanceAcceptable: "Fixed it quietly.",
      guidanceWeak: "Cannot name one.",
      questions: [{ questionId: "00000000-0000-7000-8000-000000000101", key: "unnoticed_mistake", prompt: "Describe a mistake." }],
    },
  ],
};

// An applicant whose name, phone and email are in their answers too.
const PERSON = { first: "Dana", last: "Kowalczyk", email: "dana.kowalczyk@example.com", mobile: "+16125550147" };
const INPUT = buildApplicationSnapshot(
  {
    criteria: [
      { criterionKey: "reliability", questionIds: ["00000000-0000-7000-8000-000000000100"] },
      { criterionKey: "integrity", questionIds: ["00000000-0000-7000-8000-000000000101"] },
    ],
    lineages: [
      { questionId: "00000000-0000-7000-8000-000000000100", key: "missed_commitment", aiNeverSend: false },
      { questionId: "00000000-0000-7000-8000-000000000101", key: "unnoticed_mistake", aiNeverSend: false },
    ],
    answers: [
      { questionId: "00000000-0000-7000-8000-000000000100", prompt: "Tell us about a missed shift.", text: `Dana Kowalczyk here: I called (612) 555-0147 the night before.` },
      { questionId: "00000000-0000-7000-8000-000000000101", prompt: "Describe a mistake.", text: `I emailed ${PERSON.email} to report it. Kowalczyk always owns it.` },
    ],
    names: [PERSON.first, PERSON.last],
  },
  "anon-live-test",
).input;

function message(overrides: Partial<Message> = {}): Message {
  const reply = {
    criteria: [
      { criterion_key: "reliability", score: 5, rationale: "Gave notice the night before." },
      { criterion_key: "integrity", score: 3, rationale: "Reported the mistake." },
    ],
    overall_rationale: "Owns problems and says so.",
    flags: [],
  };
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: JSON.stringify(reply), citations: null },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 800, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 600 },
    ...overrides,
  } as unknown as Message;
}

function fakeClient(respond: (params: Params) => Message | Promise<Message>) {
  const calls: Params[] = [];
  const createMessage: CreateMessage = async (params) => {
    calls.push(params);
    return respond(params);
  };
  return { calls, scorer: createAnthropicScorer({ createMessage, model: "claude-opus-5-5" }) };
}

function apiError(status: number | undefined, type: string) {
  return Anthropic.APIError.generate(status, { type: "error", error: { type, message: "details that are never stored" } }, undefined, new Headers());
}

describe("the live scorer's request", () => {
  it("asks claude-opus-5-5 for the strict schema at medium effort, with default fallbacks and no sampling or prefill", async () => {
    const { calls, scorer } = fakeClient(() => message());
    await scorer.score(RUBRIC, INPUT);
    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    expect(request).toMatchObject({
      model: "claude-opus-5-5",
      betas: [SERVER_SIDE_FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    expect(SERVER_SIDE_FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
    const schema = request.output_config!.format!.schema as { properties: { criteria: { items: { properties: { criterion_key: { enum: string[] } } } } } };
    expect(schema.properties.criteria.items.properties.criterion_key.enum).toEqual(["reliability", "integrity"]);
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(request).not.toHaveProperty("thinking");
    expect(request.tools).toBeUndefined();
    // One user turn and nothing after it: no prefill.
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]!.role).toBe("user");
  });

  it("sends no name, phone number or email anywhere in the request", async () => {
    const { calls, scorer } = fakeClient(() => message());
    await scorer.score(RUBRIC, INPUT);
    const sent = JSON.stringify(calls[0]).toLowerCase();
    for (const secret of [PERSON.first, PERSON.last, PERSON.email, "example.com", "555", "0147", "@"]) {
      expect(sent).not.toContain(secret.toLowerCase());
    }
    // The answers themselves still go, redacted.
    expect(sent).toContain("[redacted] here: i called [redacted] the night before.");
  });
});

describe("reading the reply", () => {
  it("returns the grades with the model that answered, the prompt version and the tokens, and leaves the overall score to the app", async () => {
    const { scorer } = fakeClient(() => message({ model: "claude-opus-4-8" }));
    const result = await scorer.score(RUBRIC, INPUT);
    expect(result).toMatchObject({
      status: "succeeded",
      modelId: "claude-opus-4-8",
      promptVersion: LIVE_PROMPT_VERSION,
      criteria: [
        { criterionKey: "reliability", score: 5 },
        { criterionKey: "integrity", score: 3 },
      ],
      overallRationale: "Owns problems and says so.",
      flags: [],
      overallScore: null,
      inputTokens: 1400,
      outputTokens: 120,
    });
    // (2 x 5 + 1 x 3) / 3 = 4.33, so 1 + 99 x 3.33 / 4 = 83.5, which is 84.
    expect(await scoreWithRubric(RUBRIC, INPUT, scorer)).toMatchObject({ status: "succeeded", overallScore: 84 });
  });

  it("stores a refusal as failed with the error refusal, never as a low number", async () => {
    const { scorer } = fakeClient(() =>
      message({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: null } as Message["stop_details"] }),
    );
    const result = await scoreWithRubric(RUBRIC, INPUT, scorer);
    expect(result).toEqual({
      status: "failed",
      error: "refusal",
      modelId: "claude-opus-5-5",
      promptVersion: LIVE_PROMPT_VERSION,
      rawOutput: { stop_reason: "refusal", category: "general_harms" },
    });
  });

  it("stores a reply that breaks the rubric as invalid_output", async () => {
    const text = (value: unknown) => message({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value), citations: null }] as Message["content"] });
    const broken: [unknown, string][] = [
      ["Here you go: 5, 3", "The reply was not JSON"],
      [{ criteria: [{ criterion_key: "reliability", score: 5, rationale: "r" }], overall_rationale: "o", flags: [] }, "The reply did not grade integrity"],
      [
        { criteria: [{ criterion_key: "reliability", score: 9, rationale: "r" }, { criterion_key: "integrity", score: 3, rationale: "r" }], overall_rationale: "o", flags: [] },
        "The reply graded reliability outside 1 to 5",
      ],
      [
        { criteria: [{ criterion_key: "reliability", score: 4, rationale: "r" }, { criterion_key: "integrity", score: 3, rationale: "r" }], overall_rationale: "o", flags: ["too_old"] },
        "The reply raised a flag that is not on the rubric's list",
      ],
    ];
    for (const [reply, error] of broken) {
      const { scorer } = fakeClient(() => text(reply));
      const result = await scoreWithRubric(RUBRIC, INPUT, scorer);
      expect(result).toMatchObject({ status: "invalid_output", error, promptVersion: LIVE_PROMPT_VERSION });
      expect("overallScore" in result).toBe(false);
    }
    const { scorer } = fakeClient(() => message({ stop_reason: "max_tokens" }));
    expect(await scorer.score(RUBRIC, INPUT)).toMatchObject({ status: "invalid_output", error: "The reply was cut off at the token limit" });
  });
});

describe("errors", () => {
  it("throws a retryable error for timeouts, dropped connections, 429 and 5xx", async () => {
    const failures = [
      new Anthropic.APIConnectionTimeoutError(),
      new Anthropic.APIConnectionError({ message: "socket hang up" }),
      apiError(429, "rate_limit_error"),
      apiError(500, "api_error"),
      apiError(529, "overloaded_error"),
    ];
    for (const failure of failures) {
      const { scorer } = fakeClient(() => {
        throw failure;
      });
      const thrown = await scorer.score(RUBRIC, INPUT).then(
        () => null,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(ScorerError);
      expect(thrown).toMatchObject({ kind: "retryable" });
    }
  });

  it("throws an unavailable error for a refused key or model, without the API's message", async () => {
    for (const [status, type] of [
      [401, "authentication_error"],
      [403, "permission_error"],
      [404, "not_found_error"],
      [400, "invalid_request_error"],
    ] as const) {
      const { scorer } = fakeClient(() => {
        throw apiError(status, type);
      });
      const thrown = (await scorer.score(RUBRIC, INPUT).catch((error: unknown) => error)) as ScorerError;
      expect(thrown).toBeInstanceOf(ScorerError);
      expect(thrown.kind).toBe("unavailable");
      expect(thrown.message).toBe(`Anthropic refused the scoring call (${status} ${type})`);
      expect(thrown.message).not.toContain("details");
    }
  });

  it("refuses to start without ANTHROPIC_API_KEY", () => {
    expect(() => anthropicScorerFromEnv({ ANTHROPIC_API_KEY: undefined, SCORING_MODEL: "claude-opus-5-5" })).toThrow(ScorerError);
  });
});
