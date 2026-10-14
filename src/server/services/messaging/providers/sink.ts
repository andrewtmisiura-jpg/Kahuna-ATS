import { uuidv7 } from "@/lib/uuid";
import type { OutboundEmail, OutboundText, Providers, ProviderError } from "./types";

// Local development and tests: records every send and sends nothing. A test can
// make the next send fail with a given provider error.

export type SinkSend = { channel: "sms"; message: OutboundText } | { channel: "email"; message: OutboundEmail };

export type SinkProviders = Providers & {
  sent: SinkSend[];
  // Errors to throw on the next sends, in order; empty means every send succeeds.
  failures: ProviderError[];
};

export function createSinkProviders(options: { log?: boolean } = {}): SinkProviders {
  const sent: SinkSend[] = [];
  const failures: ProviderError[] = [];
  const record = (send: SinkSend) => {
    const failure = failures.shift();
    if (failure) throw failure;
    sent.push(send);
    if (options.log) {
      const to = send.message.to;
      console.log(`[sink] ${send.channel} to ${to.slice(0, 4)}... (message ${send.message.messageId})`);
    }
    return { providerMessageId: `sink_${uuidv7()}` };
  };
  return {
    sent,
    failures,
    text: { name: "sink", sendText: async (message) => record({ channel: "sms", message }) },
    email: { name: "sink", sendEmail: async (message) => record({ channel: "email", message }) },
  };
}
