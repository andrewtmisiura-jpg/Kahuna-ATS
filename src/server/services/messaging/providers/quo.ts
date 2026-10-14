import { ProviderError, type OutboundText, type ProviderResult, type TextProvider } from "./types";

// Texts through Quo's v1 messages endpoint (DATA_MODEL.md, send rule 7): one
// recipient per call, `from` is always the employer's Quo phone number id, the API
// key goes in the Authorization header. Not yet exercised against the live API;
// the Oct 15 real-phone test is where the request and response shapes get
// confirmed. Response errors are classified by status and wording only.

export type QuoOptions = {
  apiKey: string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type QuoResponse = { data?: { id?: string }; message?: string; code?: string };

export function createQuoProvider(options: QuoOptions): TextProvider {
  const baseUrl = (options.baseUrl ?? "https://api.quo.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: "quo",
    async sendText(message: OutboundText): Promise<ProviderResult> {
      if (!options.apiKey) throw new ProviderError("rejected", "QUO_API_KEY is not set");
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { Authorization: options.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ from: message.fromPhoneNumberId, to: [message.to], content: message.body }),
        });
      } catch (error) {
        throw new ProviderError("transient", `Quo request failed: ${String(error)}`);
      }
      const text = await response.text();
      if (!response.ok) throw classifyQuoError(response.status, text);
      let parsed: QuoResponse = {};
      try {
        parsed = JSON.parse(text) as QuoResponse;
      } catch {
        // an empty or non-JSON body still counts as accepted
      }
      return { providerMessageId: parsed.data?.id ?? null };
    },
  };
}

export function classifyQuoError(status: number, body: string): ProviderError {
  const summary = body.slice(0, 300);
  if (status === 402 || /insufficient|balance|funds/i.test(body)) {
    return new ProviderError("insufficient_balance", `Quo ${status}: ${summary}`, String(status));
  }
  if (status >= 400 && status < 500 && /opt.?out|opted.?out|unsubscribed|blocked/i.test(body)) {
    return new ProviderError("opted_out", `Quo ${status}: ${summary}`, String(status));
  }
  if (status === 429 || status >= 500) {
    return new ProviderError("transient", `Quo ${status}: ${summary}`, String(status));
  }
  return new ProviderError("rejected", `Quo ${status}: ${summary}`, String(status));
}
