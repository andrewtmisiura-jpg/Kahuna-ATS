-- Additive only: integration_secret holds secrets an integration hands Tidepool once, so
-- nobody copies them by hand. Today only quo_webhook_secret, written by `pnpm quo:setup` in the
-- run that creates the Quo webhook. Server-only: never exported, never in CSV or audit payloads.
CREATE TABLE "integration_secret" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
