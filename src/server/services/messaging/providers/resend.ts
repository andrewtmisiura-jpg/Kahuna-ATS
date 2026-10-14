import { Resend } from "resend";
import { ProviderError, type EmailProvider, type OutboundEmail, type ProviderResult } from "./types";

// Email through Resend. Plain text only, click and open tracking off (account
// setting), `message.id:attempt` as the idempotency key so a retry after a crash
// never sends twice. Not yet exercised against the live API.

export function createResendProvider(options: { apiKey: string | undefined }): EmailProvider {
  let client: Resend | undefined;
  return {
    name: "resend",
    async sendEmail(message: OutboundEmail): Promise<ProviderResult> {
      if (!options.apiKey) throw new ProviderError("rejected", "RESEND_API_KEY is not set");
      client ??= new Resend(options.apiKey);
      let result: Awaited<ReturnType<Resend["emails"]["send"]>>;
      try {
        result = await client.emails.send(
          {
            from: `${message.fromName} <${message.from}>`,
            to: message.to,
            replyTo: message.replyTo ?? undefined,
            subject: message.subject,
            text: message.body,
          },
          { idempotencyKey: `${message.messageId}:${message.attempt}` },
        );
      } catch (error) {
        throw new ProviderError("transient", `Resend request failed: ${String(error)}`);
      }
      if (result.error) {
        const name = result.error.name;
        const transient = name === "rate_limit_exceeded" || name === "internal_server_error" || name === "application_error";
        throw new ProviderError(transient ? "transient" : "rejected", `Resend ${name}: ${result.error.message}`, name);
      }
      return { providerMessageId: result.data?.id ?? null };
    },
  };
}
