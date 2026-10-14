-- Applicant area: the public opt-in page (/text-messages) is versioned legal text like
-- the privacy policy and the SMS terms, so it needs its own legal_text_kind value.
-- Adding an enum value is additive (DATA_MODEL.md, Enumerations). The Drizzle enum in
-- src/db/schema/enums.ts does not list it yet; src/server/services/legal.ts carries the
-- value until the schema owner folds it in.
ALTER TYPE "public"."legal_text_kind" ADD VALUE IF NOT EXISTS 'opt_in_page';
