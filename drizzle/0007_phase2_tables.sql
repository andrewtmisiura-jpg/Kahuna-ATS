-- Additive only: every Phase 2 table and enum in DATA_MODEL.md ("Phase 2 tables" and
-- "Enumerations"), generated from src/db/schema (sessions.ts, scoring.ts, interviews.ts and
-- jobs.ts), and two employer columns: booking_link_url, the one-on-one booking link (the
-- service accepts https only), and scoring_daily_cap, AI scoring calls per Central day
-- (default 100, above zero). Existing rows only gain those two columns with their defaults.
-- The interview grade enum is interview_grade_value: the interview_grade table's row type
-- already takes the name interview_grade, as review_decision's does for its enum.
-- The triggers and the read-only grants are in 0008_phase2_triggers_and_grants.sql.
CREATE TYPE "public"."ai_score_status" AS ENUM('queued', 'succeeded', 'failed', 'invalid_output');--> statement-breakpoint
CREATE TYPE "public"."assessment_result" AS ENUM('pass', 'fail', 'did_not_attempt');--> statement-breakpoint
CREATE TYPE "public"."attendee_source" AS ENUM('paper_sheet', 'door_checkin', 'staff_added');--> statement-breakpoint
CREATE TYPE "public"."interview_grade_value" AS ENUM('a_plus', 'a', 'a_minus', 'b_plus', 'b', 'b_minus', 'c_plus', 'c', 'c_minus', 'd', 'f');--> statement-breakpoint
CREATE TYPE "public"."interview_kind" AS ENUM('one_on_one', 'phone_screen');--> statement-breakpoint
CREATE TYPE "public"."interview_recommendation" AS ENUM('hire', 'maybe', 'no_hire');--> statement-breakpoint
CREATE TYPE "public"."interview_status" AS ENUM('scheduled', 'held', 'no_show', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'retry', 'succeeded', 'dead');--> statement-breakpoint
CREATE TYPE "public"."review_decision_value" AS ENUM('advance', 'hold', 'decline');--> statement-breakpoint
CREATE TYPE "public"."scoring_mode" AS ENUM('off', 'hidden', 'visible');--> statement-breakpoint
CREATE TYPE "public"."star_mark" AS ENUM('star', 'concern');--> statement-breakpoint
CREATE TABLE "attendee" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_session_id" uuid NOT NULL,
	"name_as_written" text,
	"mobile_e164" text,
	"source" "attendee_source" NOT NULL,
	"person_id" uuid,
	"application_id" uuid,
	"match_method" "attribution_method" DEFAULT 'none' NOT NULL,
	"matched_by" uuid,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "attendee_mobile_e164_phone_us" CHECK ("attendee"."mobile_e164" ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
	CONSTRAINT "attendee_name_required_unless_redacted" CHECK ("attendee"."redacted_at" is not null or "attendee"."name_as_written" is not null)
);
--> statement-breakpoint
CREATE TABLE "star" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attendee_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mark" "star_mark" NOT NULL,
	"reason_option_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "star_note_max_140" CHECK ("star"."note" is null or char_length("star"."note") <= 140)
);
--> statement-breakpoint
CREATE TABLE "ai_criterion_score" (
	"ai_score_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"score" smallint NOT NULL,
	"rationale" text,
	CONSTRAINT "ai_criterion_score_ai_score_id_criterion_id_pk" PRIMARY KEY("ai_score_id","criterion_id"),
	CONSTRAINT "ai_criterion_score_range" CHECK ("ai_criterion_score"."score" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "ai_score" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"rubric_version_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" "ai_score_status" NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"raw_output" jsonb,
	"overall_score" smallint,
	"rationale" text,
	"flags" text[],
	"keyword_hits" text[],
	"is_current" boolean NOT NULL,
	"hidden_from_reviewers" boolean NOT NULL,
	"scored_after_decision" boolean NOT NULL,
	"requested_by_type" "actor_type" NOT NULL,
	"requested_by_user_id" uuid,
	"input_tokens" integer,
	"output_tokens" integer,
	"error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_score_overall_score_range" CHECK ("ai_score"."overall_score" is null or "ai_score"."overall_score" between 1 and 100),
	CONSTRAINT "ai_score_overall_score_iff_succeeded" CHECK (("ai_score"."status" = 'succeeded') = ("ai_score"."overall_score" is not null))
);
--> statement-breakpoint
CREATE TABLE "review_decision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"decision" "review_decision_value" NOT NULL,
	"reason_option_id" uuid,
	"note" text,
	"ai_score_id" uuid,
	"ai_score_visible" boolean NOT NULL,
	"application_event_id" uuid,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_decision_decline_has_reason" CHECK ("review_decision"."decision" <> 'decline' or "review_decision"."reason_option_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "rubric" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"scoring_mode" "scoring_mode" DEFAULT 'off' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rubric_role_id_unique" UNIQUE("role_id")
);
--> statement-breakpoint
CREATE TABLE "rubric_criterion" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rubric_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "rubric_criterion_rubric_id_key_unique" UNIQUE("rubric_id","key")
);
--> statement-breakpoint
CREATE TABLE "rubric_test_case" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rubric_id" uuid NOT NULL,
	"group_key" text NOT NULL,
	"variant" text NOT NULL,
	"answers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rubric_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rubric_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "config_status" NOT NULL,
	"instructions" text NOT NULL,
	"allowed_flags" jsonb NOT NULL,
	"change_reason" text,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rubric_version_rubric_id_version_unique" UNIQUE("rubric_id","version")
);
--> statement-breakpoint
CREATE TABLE "rubric_version_criterion" (
	"rubric_version_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"name" text NOT NULL,
	"guidance_strong" text NOT NULL,
	"guidance_acceptable" text NOT NULL,
	"guidance_weak" text NOT NULL,
	"weight" numeric(5, 2) NOT NULL,
	"question_ids" uuid[] NOT NULL,
	"meaning_changed" boolean DEFAULT false NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "rubric_version_criterion_rubric_version_id_criterion_id_pk" PRIMARY KEY("rubric_version_id","criterion_id"),
	CONSTRAINT "rubric_version_criterion_weight_positive" CHECK ("rubric_version_criterion"."weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "assessment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"assessment_type_option_id" uuid NOT NULL,
	"result" "assessment_result" NOT NULL,
	"administered_by" uuid NOT NULL,
	"administered_on" date NOT NULL,
	"note" text,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interview" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" "interview_kind" NOT NULL,
	"status" "interview_status" NOT NULL,
	"scheduled_at" timestamp with time zone,
	"booked_via" text,
	"interviewer_user_id" uuid,
	"held_at" timestamp with time zone,
	"overall_grade" "interview_grade_value",
	"recommendation" "interview_recommendation",
	"notes" text,
	"notion_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"redacted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interview_grade" (
	"interview_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"grade" "interview_grade_value" NOT NULL,
	CONSTRAINT "interview_grade_interview_id_category_key_pk" PRIMARY KEY("interview_id","category_key")
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"dedupe_key" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "employer" ADD COLUMN "booking_link_url" text;--> statement-breakpoint
ALTER TABLE "employer" ADD COLUMN "scoring_daily_cap" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendee" ADD CONSTRAINT "attendee_group_session_id_group_session_id_fk" FOREIGN KEY ("group_session_id") REFERENCES "public"."group_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee" ADD CONSTRAINT "attendee_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee" ADD CONSTRAINT "attendee_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendee" ADD CONSTRAINT "attendee_matched_by_app_user_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "star" ADD CONSTRAINT "star_attendee_id_attendee_id_fk" FOREIGN KEY ("attendee_id") REFERENCES "public"."attendee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "star" ADD CONSTRAINT "star_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "star" ADD CONSTRAINT "star_reason_option_id_picklist_option_id_fk" FOREIGN KEY ("reason_option_id") REFERENCES "public"."picklist_option"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_criterion_score" ADD CONSTRAINT "ai_criterion_score_ai_score_id_ai_score_id_fk" FOREIGN KEY ("ai_score_id") REFERENCES "public"."ai_score"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_criterion_score" ADD CONSTRAINT "ai_criterion_score_criterion_id_rubric_criterion_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."rubric_criterion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_score" ADD CONSTRAINT "ai_score_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_score" ADD CONSTRAINT "ai_score_rubric_version_id_rubric_version_id_fk" FOREIGN KEY ("rubric_version_id") REFERENCES "public"."rubric_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_score" ADD CONSTRAINT "ai_score_requested_by_user_id_app_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_reason_option_id_picklist_option_id_fk" FOREIGN KEY ("reason_option_id") REFERENCES "public"."picklist_option"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_ai_score_id_ai_score_id_fk" FOREIGN KEY ("ai_score_id") REFERENCES "public"."ai_score"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_application_event_id_application_event_id_fk" FOREIGN KEY ("application_event_id") REFERENCES "public"."application_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric" ADD CONSTRAINT "rubric_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_criterion" ADD CONSTRAINT "rubric_criterion_rubric_id_rubric_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."rubric"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_test_case" ADD CONSTRAINT "rubric_test_case_rubric_id_rubric_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."rubric"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_version" ADD CONSTRAINT "rubric_version_rubric_id_rubric_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."rubric"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_version" ADD CONSTRAINT "rubric_version_published_by_app_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_version_criterion" ADD CONSTRAINT "rubric_version_criterion_rubric_version_id_rubric_version_id_fk" FOREIGN KEY ("rubric_version_id") REFERENCES "public"."rubric_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_version_criterion" ADD CONSTRAINT "rubric_version_criterion_criterion_id_rubric_criterion_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."rubric_criterion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_assessment_type_option_id_picklist_option_id_fk" FOREIGN KEY ("assessment_type_option_id") REFERENCES "public"."picklist_option"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_administered_by_app_user_id_fk" FOREIGN KEY ("administered_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview" ADD CONSTRAINT "interview_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview" ADD CONSTRAINT "interview_interviewer_user_id_app_user_id_fk" FOREIGN KEY ("interviewer_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_grade" ADD CONSTRAINT "interview_grade_interview_id_interview_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interview"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendee_group_session_id_idx" ON "attendee" USING btree ("group_session_id");--> statement-breakpoint
CREATE INDEX "attendee_mobile_e164_idx" ON "attendee" USING btree ("mobile_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "attendee_one_per_application_per_session" ON "attendee" USING btree ("group_session_id","application_id") WHERE application_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "star_one_live_per_user_and_mark" ON "star" USING btree ("attendee_id","user_id","mark") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_score_one_current_per_application" ON "ai_score" USING btree ("application_id") WHERE is_current;--> statement-breakpoint
CREATE INDEX "ai_score_rubric_version_id_idx" ON "ai_score" USING btree ("rubric_version_id");--> statement-breakpoint
CREATE INDEX "review_decision_application_id_decided_at_idx" ON "review_decision" USING btree ("application_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rubric_version_one_published_per_rubric" ON "rubric_version" USING btree ("rubric_id") WHERE status = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_one_live_per_type" ON "assessment" USING btree ("application_id","assessment_type_option_id") WHERE voided_at is null;--> statement-breakpoint
CREATE INDEX "interview_application_id_idx" ON "interview" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "interview_scheduled_at_idx" ON "interview" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "job_run_at_due_idx" ON "job" USING btree ("run_at") WHERE status in ('queued', 'retry');--> statement-breakpoint
ALTER TABLE "employer" ADD CONSTRAINT "employer_scoring_daily_cap_positive" CHECK ("employer"."scoring_daily_cap" > 0);