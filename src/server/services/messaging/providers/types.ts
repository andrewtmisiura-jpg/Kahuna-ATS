// The provider interface behind the single send function. Each provider sends one
// message per call and reports the provider's id; everything else (consent,
// suppression, quiet hours, status) is the send function's job.

export type ProviderName = "quo" | "resend" | "sink";

export type OutboundText = {
  messageId: string;
  attempt: number;
  to: string;
  // The employer's Quo phone number id; the only `from` a text ever uses.
  fromPhoneNumberId: string;
  body: string;
};

export type OutboundEmail = {
  messageId: string;
  attempt: number;
  to: string;
  from: string;
  fromName: string;
  replyTo: string | null;
  subject: string;
  body: string;
};

export type ProviderResult = { providerMessageId: string | null; segments?: number };

export type ProviderErrorKind =
  // Quo's prepaid balance is empty: stop texting for the pass and alert.
  | "insufficient_balance"
  // The carrier or Quo reports the number opted out: record carrier_blocked.
  | "opted_out"
  // Worth retrying later (rate limit, 5xx, network).
  | "transient"
  // Refused for good (bad request, bad key).
  | "rejected";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface TextProvider {
  readonly name: ProviderName;
  sendText(message: OutboundText): Promise<ProviderResult>;
}

export interface EmailProvider {
  readonly name: ProviderName;
  sendEmail(message: OutboundEmail): Promise<ProviderResult>;
}

export type Providers = { text: TextProvider; email: EmailProvider };
