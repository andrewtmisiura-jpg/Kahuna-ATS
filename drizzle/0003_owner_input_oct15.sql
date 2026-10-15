-- Owner input received Oct 15, 2026, applied to a database the seed already ran on.
-- Each update only touches a value still at its seeded placeholder, so a value an
-- Admin has since changed in Settings is left alone. On an empty database these
-- statements match nothing, and the seed writes the same values instead.

UPDATE "employer"
SET "email_from_address" = 'hiring@kahunawindowcleaning.com', "updated_at" = now()
WHERE "key" = 'kahuna' AND "email_from_address" IS NULL;
--> statement-breakpoint
UPDATE "employer"
SET "reply_to_address" = 'lavignebreanna1@gmail.com', "updated_at" = now()
WHERE "key" = 'kahuna' AND "reply_to_address" IS NULL;
--> statement-breakpoint
UPDATE "opening"
SET "pay_text" = 'Starts at $20 an hour', "updated_at" = now()
WHERE "key" = 'snow-2026-27' AND "pay_text" LIKE 'DRAFT:%';
--> statement-breakpoint
UPDATE "opening"
SET "benefits_text" = NULL, "updated_at" = now()
WHERE "key" = 'snow-2026-27' AND "benefits_text" LIKE 'DRAFT:%';
