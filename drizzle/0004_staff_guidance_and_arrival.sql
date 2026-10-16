-- Additive only: the owner's five snow questions (Oct 16, 2026) and the two new signals.
-- question_version gets staff_guidance (staff-only notes, never shown to applicants or sent
-- to AI) and starts_with_check (text questions only). application gets group_interview_arrival.
-- applied_change records the one-time content changes run by `pnpm db:changes`.
-- The 0001 immutability trigger needs no change: the new columns are set when a version is
-- created, and a published version still rejects every UPDATE and DELETE.
CREATE TYPE "public"."group_interview_arrival" AS ENUM('on_time', 'late', 'did_not_attend');--> statement-breakpoint
CREATE TABLE "applied_change" (
	"id" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_version" ADD COLUMN "staff_guidance" text;--> statement-breakpoint
ALTER TABLE "question_version" ADD COLUMN "starts_with_check" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "group_interview_arrival" "group_interview_arrival";--> statement-breakpoint
ALTER TABLE "question_version" ADD CONSTRAINT "question_version_starts_with_check_text_only" CHECK ("question_version"."starts_with_check" is null or "question_version"."type" in ('short_text', 'long_text'));