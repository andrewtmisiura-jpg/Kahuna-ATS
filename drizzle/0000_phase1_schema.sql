CREATE TYPE "public"."actor_type" AS ENUM('staff', 'applicant', 'system');--> statement-breakpoint
CREATE TYPE "public"."application_event_kind" AS ENUM('created', 'submitted', 'stage_changed', 'closed', 'reopened', 'hold_set', 'hold_cleared', 'contacted', 'hire_rescinded', 'event_voided', 'person_merged');--> statement-breakpoint
CREATE TYPE "public"."application_origin" AS ENUM('landing', 'staff_created', 'imported');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('open', 'hired', 'closed');--> statement-breakpoint
CREATE TYPE "public"."attribution_method" AS ENUM('none', 'scanned_session', 'phone_match', 'staff_confirmed');--> statement-breakpoint
CREATE TYPE "public"."background_check_status" AS ENUM('requested', 'in_progress', 'clear', 'needs_review', 'pre_adverse_sent', 'final_adverse_sent', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."background_check_type" AS ENUM('criminal', 'driving_record', 'drug_screen', 'other');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."closed_outcome" AS ENUM('disqualified', 'withdrew', 'not_selected');--> statement-breakpoint
CREATE TYPE "public"."config_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."consent_action" AS ENUM('opt_in', 'declined', 'opt_out', 'opt_in_keyword');--> statement-breakpoint
CREATE TYPE "public"."consent_method" AS ENUM('web_form', 'keyword', 'free_text_reply', 'staff_recorded');--> statement-breakpoint
CREATE TYPE "public"."entry_channel" AS ENUM('role_qr', 'session_qr', 'indeed_message', 'job_posting', 'flyer', 'website', 'staff_entered', 'other');--> statement-breakpoint
CREATE TYPE "public"."group_session_status" AS ENUM('scheduled', 'held', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."hire_origin" AS ENUM('ats', 'external', 'historical_import');--> statement-breakpoint
CREATE TYPE "public"."hire_outcome" AS ENUM('active', 'completed_season', 'separated', 'never_started');--> statement-breakpoint
CREATE TYPE "public"."hire_void_kind" AS ENUM('entered_in_error', 'rescinded');--> statement-breakpoint
CREATE TYPE "public"."legal_text_kind" AS ENUM('sms_consent', 'privacy_policy', 'sms_terms', 'landing_notice', 'ai_disclosure');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."message_provider" AS ENUM('quo', 'resend', 'sink');--> statement-breakpoint
CREATE TYPE "public"."message_purpose" AS ENUM('resume_link', 'link_recovery', 'reminder_24h', 'submit_confirmation', 'help_reply', 'group_invite', 'one_on_one_invite', 'one_on_one_reminder', 'status_update', 'decline');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'suppressed', 'canceled', 'received', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."milestone" AS ENUM('started', 'submitted', 'reviewed', 'interview_invited', 'interviewed', 'offered', 'background_check', 'hired');--> statement-breakpoint
CREATE TYPE "public"."offer_response" AS ENUM('pending', 'accepted', 'declined', 'rescinded', 'expired');--> statement-breakpoint
CREATE TYPE "public"."opening_status" AS ENUM('draft', 'open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."pay_unit" AS ENUM('hourly', 'daily', 'salary');--> statement-breakpoint
CREATE TYPE "public"."picklist_key" AS ENUM('disqualify_reason', 'withdraw_reason', 'not_selected_reason', 'leave_reason', 'star_reason', 'crew', 'assessment_type');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('short_text', 'long_text', 'single_choice', 'multi_choice', 'yes_no', 'date', 'number');--> statement-breakpoint
CREATE TYPE "public"."season_end_rating" AS ENUM('reliable', 'mixed', 'unreliable', 'never_worked');--> statement-breakpoint
CREATE TYPE "public"."separation_type" AS ENUM('voluntary', 'involuntary');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('indeed', 'referral', 'current_employee', 'former_employee', 'social_media', 'sign_or_walk_in', 'other');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('stop_keyword', 'free_text_request', 'staff_marked', 'carrier_blocked', 'email_hard_bounce', 'email_complaint');--> statement-breakpoint
CREATE TYPE "public"."token_issue" AS ENUM('landing_cookie', 'message', 'staff_reissue');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'hiring_manager', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"role" "user_role" NOT NULL,
	"google_sub" text,
	"invited_by" uuid,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email"),
	CONSTRAINT "app_user_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"website_url" text,
	"hiring_host" text NOT NULL,
	"logo_url" text,
	"email_from_name" text NOT NULL,
	"email_from_address" text,
	"reply_to_address" text,
	"sms_quo_phone_number_id" text,
	"sms_enabled" boolean DEFAULT false NOT NULL,
	"sms_from_e164" text,
	"daily_send_cap" integer DEFAULT 200 NOT NULL,
	"help_contact" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "employer_key_unique" UNIQUE("key"),
	CONSTRAINT "employer_sms_from_e164_phone_us" CHECK ("employer"."sms_from_e164" ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "form_item" (
	"form_version_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"sort_order" integer NOT NULL,
	"required" boolean NOT NULL,
	"attention_values" text[],
	CONSTRAINT "form_item_form_version_id_question_version_id_pk" PRIMARY KEY("form_version_id","question_version_id")
);
--> statement-breakpoint
CREATE TABLE "form_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "config_status" NOT NULL,
	"sections" jsonb NOT NULL,
	"ai_disclosure_version_id" uuid,
	"change_reason" text,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_version_role_id_version_unique" UNIQUE("role_id","version")
);
--> statement-breakpoint
CREATE TABLE "legal_text_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employer_id" uuid NOT NULL,
	"kind" "legal_text_kind" NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"change_note" text,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_text_version_employer_id_kind_version_unique" UNIQUE("employer_id","kind","version")
);
--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employer_id" uuid NOT NULL,
	"role_id" uuid,
	"purpose" "message_purpose" NOT NULL,
	"channel" "channel" NOT NULL,
	"name" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "opening" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" "opening_status" NOT NULL,
	"opens_on" date,
	"closes_on" date,
	"season_start_on" date,
	"season_end_on" date,
	"target_headcount" integer,
	"pay_text" text,
	"benefits_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_role_id_key_unique" UNIQUE("role_id","key")
);
--> statement-breakpoint
CREATE TABLE "picklist_option" (
	"id" uuid PRIMARY KEY NOT NULL,
	"list_key" "picklist_key" NOT NULL,
	"employer_id" uuid,
	"role_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"requires_note" boolean DEFAULT false NOT NULL,
	"fcra_adverse" boolean DEFAULT false NOT NULL,
	"default_separation" "separation_type",
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "picklist_option_list_key_employer_id_role_id_key_unique" UNIQUE NULLS NOT DISTINCT("list_key","employer_id","role_id","key")
);
--> statement-breakpoint
CREATE TABLE "pipeline_stage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"public_label" text NOT NULL,
	"milestone" "milestone",
	"sort_order" integer NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"show_on_board" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "pipeline_stage_role_id_key_unique" UNIQUE("role_id","key")
);
--> statement-breakpoint
CREATE TABLE "question" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"key" text NOT NULL,
	"ai_never_send" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "question_role_id_key_unique" UNIQUE("role_id","key")
);
--> statement-breakpoint
CREATE TABLE "question_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"question_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"type" "question_type" NOT NULL,
	"prompt" text NOT NULL,
	"help" text,
	"options" jsonb,
	"validation" jsonb,
	"meaning_changed" boolean DEFAULT false NOT NULL,
	"change_note" text,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_version_question_id_version_unique" UNIQUE("question_id","version"),
	CONSTRAINT "question_version_options_iff_choice" CHECK (("question_version"."options" is not null) = ("question_version"."type" in ('single_choice', 'multi_choice')))
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employer_id" uuid NOT NULL,
	"key" text NOT NULL,
	"internal_name" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"uses_group_interview" boolean NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "role_employer_id_key_unique" UNIQUE("employer_id","key")
);
--> statement-breakpoint
CREATE TABLE "entry_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"role_id" uuid NOT NULL,
	"opening_id" uuid,
	"group_session_id" uuid,
	"channel" "entry_channel" NOT NULL,
	"label" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_code_code_unique" UNIQUE("code"),
	CONSTRAINT "entry_code_session_requires_opening" CHECK ("entry_code"."group_session_id" is null or "entry_code"."opening_id" is not null),
	CONSTRAINT "entry_code_code_format" CHECK ("entry_code"."code" ~ '^[0-9A-HJKMNP-TV-Z]{6,8}$')
);
--> statement-breakpoint
CREATE TABLE "entry_code_scan_day" (
	"entry_code_id" uuid NOT NULL,
	"day" date NOT NULL,
	"scans" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "entry_code_scan_day_entry_code_id_day_pk" PRIMARY KEY("entry_code_id","day")
);
--> statement-breakpoint
CREATE TABLE "group_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opening_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"location_name" text NOT NULL,
	"location_address" text,
	"invited_count" integer,
	"attended_count" integer,
	"status" "group_session_status" NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "answer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"value_text" text,
	"value_number" numeric,
	"value_date" date,
	"value_bool" boolean,
	"value_options" text[],
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_application_id_question_version_id_unique" UNIQUE("application_id","question_version_id"),
	CONSTRAINT "answer_one_value_column" CHECK (num_nonnulls("answer"."value_text", "answer"."value_number", "answer"."value_date", "answer"."value_bool", "answer"."value_options") <= 1)
);
--> statement-breakpoint
CREATE TABLE "application" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"opening_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"form_version_id" uuid NOT NULL,
	"origin" "application_origin" NOT NULL,
	"status" "application_status" DEFAULT 'open' NOT NULL,
	"closed_outcome" "closed_outcome",
	"closed_reason_option_id" uuid,
	"current_stage_id" uuid NOT NULL,
	"stage_entered_at" timestamp with time zone NOT NULL,
	"on_hold" boolean DEFAULT false NOT NULL,
	"event_seq" integer DEFAULT 0 NOT NULL,
	"answers_locked" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"entry_code_id" uuid,
	"entry_channel" "entry_channel" NOT NULL,
	"scanned_session_id" uuid,
	"attributed_session_id" uuid,
	"attribution_method" "attribution_method" DEFAULT 'none' NOT NULL,
	"source" "source",
	"source_detail" text,
	"source_set_by" "actor_type",
	"indeed_applied_on" date,
	"exclude_from_analysis" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "application_closed_has_outcome" CHECK (("application"."status" = 'closed') = ("application"."closed_outcome" is not null)),
	CONSTRAINT "application_closed_has_reason" CHECK ("application"."closed_outcome" is null or "application"."closed_reason_option_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "application_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "application_event_kind" NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"from_status" "application_status",
	"to_status" "application_status",
	"closed_outcome" "closed_outcome",
	"reason_option_id" uuid,
	"note" text,
	"voids_event_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"batch_id" uuid,
	"metadata" jsonb,
	CONSTRAINT "application_event_application_id_seq_unique" UNIQUE("application_id","seq"),
	CONSTRAINT "application_event_occurred_not_future" CHECK ("application_event"."occurred_at" <= "application_event"."recorded_at" + interval '5 minutes'),
	CONSTRAINT "application_event_staff_has_user" CHECK ("application_event"."actor_type" <> 'staff' or "application_event"."actor_user_id" is not null),
	CONSTRAINT "application_event_closed_has_outcome_and_reason" CHECK ("application_event"."kind" <> 'closed' or ("application_event"."closed_outcome" is not null and "application_event"."reason_option_id" is not null)),
	CONSTRAINT "application_event_voided_names_event" CHECK ("application_event"."kind" <> 'event_voided' or "application_event"."voids_event_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "landing_conflict" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opening_id" uuid NOT NULL,
	"entry_code_id" uuid,
	"typed_first_name" text,
	"typed_last_name" text,
	"typed_mobile_e164" text,
	"typed_email" text,
	"matched_person_ids" uuid[] NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_conflict_typed_mobile_e164_phone_us" CHECK ("landing_conflict"."typed_mobile_e164" ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"application_id" uuid,
	"body" text,
	"is_restricted" boolean DEFAULT false NOT NULL,
	"author_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY NOT NULL,
	"first_name" text,
	"last_name" text,
	"mobile_e164" text,
	"email" text,
	"email_normalized" text,
	"shared_mobile" boolean DEFAULT false NOT NULL,
	"merged_into_person_id" uuid,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"preferred_language" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "person_mobile_e164_phone_us" CHECK ("person"."mobile_e164" ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
	CONSTRAINT "person_name_required_unless_redacted" CHECK ("person"."redacted_at" is not null or ("person"."first_name" is not null and "person"."last_name" is not null)),
	CONSTRAINT "person_not_merged_into_self" CHECK ("person"."merged_into_person_id" <> "person"."id")
);
--> statement-breakpoint
CREATE TABLE "consent_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"application_id" uuid,
	"employer_id" uuid,
	"channel" "channel" NOT NULL,
	"address" text NOT NULL,
	"action" "consent_action" NOT NULL,
	"method" "consent_method" NOT NULL,
	"legal_text_version_id" uuid,
	"checkbox_value" boolean,
	"language" text,
	"ip" "inet",
	"user_agent" text,
	"entry_code_id" uuid,
	"message_id" uuid,
	"recorded_by" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_event_web_form_has_legal_text" CHECK ("consent_event"."method" <> 'web_form' or "consent_event"."legal_text_version_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"direction" "message_direction" NOT NULL,
	"channel" "channel" NOT NULL,
	"person_id" uuid,
	"application_id" uuid,
	"template_id" uuid,
	"purpose" "message_purpose",
	"to_address" text,
	"from_address" text,
	"subject" text,
	"body" text,
	"status" "message_status" NOT NULL,
	"provider" "message_provider" NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"segments" smallint,
	"dedupe_key" text,
	"send_after" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"triggered_by_type" "actor_type" NOT NULL,
	"triggered_by_user_id" uuid,
	"handled_at" timestamp with time zone,
	"handled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "message_provider_message_id_unique" UNIQUE("provider_message_id"),
	CONSTRAINT "message_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "message_addresses_unless_redacted" CHECK ("message"."redacted_at" is not null or ("message"."to_address" is not null and "message"."from_address" is not null))
);
--> statement-breakpoint
CREATE TABLE "resume_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"issued_via" "token_issue" NOT NULL,
	"message_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "suppression" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel" "channel" NOT NULL,
	"address" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"message_id" uuid,
	"created_by" uuid,
	"lifted_at" timestamp with time zone,
	"lift_reason" text,
	"lifted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_check" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"check_type" "background_check_type" NOT NULL,
	"vendor" text,
	"vendor_reference" text,
	"status" "background_check_status" NOT NULL,
	"requested_on" date,
	"completed_on" date,
	"pre_adverse_notice_on" date,
	"final_adverse_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_check_final_adverse_needs_pre_adverse" CHECK ("background_check"."final_adverse_on" is null or "background_check"."pre_adverse_notice_on" is not null)
);
--> statement-breakpoint
CREATE TABLE "hire_stint" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"application_id" uuid,
	"origin" "hire_origin" NOT NULL,
	"employer_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"opening_id" uuid,
	"is_temporary" boolean DEFAULT false NOT NULL,
	"planned_end_on" date,
	"crew_option_id" uuid,
	"offer_accepted_on" date,
	"planned_start_on" date,
	"start_on" date,
	"last_worked_on" date,
	"end_on" date,
	"outcome" "hire_outcome" DEFAULT 'active' NOT NULL,
	"separation_type" "separation_type",
	"leave_reason_option_id" uuid,
	"leave_note" text,
	"rehire_eligible" boolean,
	"rating_30" smallint,
	"rating_90" smallint,
	"rating_30_by" uuid,
	"rating_90_by" uuid,
	"season_end_rating" "season_end_rating",
	"storms_worked" smallint,
	"voided_at" timestamp with time zone,
	"void_kind" "hire_void_kind",
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hire_stint_separation_fields" CHECK ("hire_stint"."outcome" not in ('separated', 'never_started') or ("hire_stint"."separation_type" is not null and "hire_stint"."leave_reason_option_id" is not null and "hire_stint"."end_on" is not null)),
	CONSTRAINT "hire_stint_completed_has_end" CHECK ("hire_stint"."outcome" <> 'completed_season' or "hire_stint"."end_on" is not null),
	CONSTRAINT "hire_stint_end_after_start" CHECK ("hire_stint"."start_on" is null or "hire_stint"."end_on" is null or "hire_stint"."end_on" >= "hire_stint"."start_on"),
	CONSTRAINT "hire_stint_last_worked_in_range" CHECK ("hire_stint"."last_worked_on" is null or (("hire_stint"."start_on" is null or "hire_stint"."last_worked_on" >= "hire_stint"."start_on") and ("hire_stint"."end_on" is null or "hire_stint"."last_worked_on" <= "hire_stint"."end_on"))),
	CONSTRAINT "hire_stint_rating_30_range" CHECK ("hire_stint"."rating_30" is null or "hire_stint"."rating_30" between 1 and 5),
	CONSTRAINT "hire_stint_rating_90_range" CHECK ("hire_stint"."rating_90" is null or "hire_stint"."rating_90" between 1 and 5),
	CONSTRAINT "hire_stint_ats_has_application" CHECK ("hire_stint"."origin" <> 'ats' or ("hire_stint"."application_id" is not null and "hire_stint"."opening_id" is not null)),
	CONSTRAINT "hire_stint_void_fields_together" CHECK (("hire_stint"."voided_at" is null) = ("hire_stint"."void_kind" is null))
);
--> statement-breakpoint
CREATE TABLE "offer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"offered_on" date NOT NULL,
	"offered_by" uuid NOT NULL,
	"is_conditional" boolean DEFAULT true NOT NULL,
	"pay_amount" numeric(8, 2),
	"pay_unit" "pay_unit",
	"planned_start_on" date,
	"response" "offer_response" DEFAULT 'pending' NOT NULL,
	"responded_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"person_id" uuid,
	"application_id" uuid,
	"changes" jsonb,
	"request_id" text,
	"ip" "inet"
);
--> statement-breakpoint
CREATE TABLE "cron_heartbeat" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cron_heartbeat_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_invited_by_app_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_item" ADD CONSTRAINT "form_item_form_version_id_form_version_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_item" ADD CONSTRAINT "form_item_question_version_id_question_version_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_version" ADD CONSTRAINT "form_version_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_version" ADD CONSTRAINT "form_version_ai_disclosure_version_id_legal_text_version_id_fk" FOREIGN KEY ("ai_disclosure_version_id") REFERENCES "public"."legal_text_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_version" ADD CONSTRAINT "form_version_published_by_app_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_version" ADD CONSTRAINT "form_version_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_text_version" ADD CONSTRAINT "legal_text_version_employer_id_employer_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."employer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_text_version" ADD CONSTRAINT "legal_text_version_published_by_app_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_employer_id_employer_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."employer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening" ADD CONSTRAINT "opening_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picklist_option" ADD CONSTRAINT "picklist_option_employer_id_employer_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."employer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picklist_option" ADD CONSTRAINT "picklist_option_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_version" ADD CONSTRAINT "question_version_question_id_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_version" ADD CONSTRAINT "question_version_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_employer_id_employer_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."employer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_code" ADD CONSTRAINT "entry_code_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_code" ADD CONSTRAINT "entry_code_opening_id_opening_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."opening"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_code" ADD CONSTRAINT "entry_code_group_session_id_group_session_id_fk" FOREIGN KEY ("group_session_id") REFERENCES "public"."group_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_code" ADD CONSTRAINT "entry_code_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_code_scan_day" ADD CONSTRAINT "entry_code_scan_day_entry_code_id_entry_code_id_fk" FOREIGN KEY ("entry_code_id") REFERENCES "public"."entry_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_session" ADD CONSTRAINT "group_session_opening_id_opening_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."opening"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_session" ADD CONSTRAINT "group_session_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer" ADD CONSTRAINT "answer_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer" ADD CONSTRAINT "answer_question_version_id_question_version_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_opening_id_opening_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."opening"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_form_version_id_form_version_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_closed_reason_option_id_picklist_option_id_fk" FOREIGN KEY ("closed_reason_option_id") REFERENCES "public"."picklist_option"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_current_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("current_stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_entry_code_id_entry_code_id_fk" FOREIGN KEY ("entry_code_id") REFERENCES "public"."entry_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_scanned_session_id_group_session_id_fk" FOREIGN KEY ("scanned_session_id") REFERENCES "public"."group_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_attributed_session_id_group_session_id_fk" FOREIGN KEY ("attributed_session_id") REFERENCES "public"."group_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_from_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_to_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_reason_option_id_picklist_option_id_fk" FOREIGN KEY ("reason_option_id") REFERENCES "public"."picklist_option"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_voids_event_id_application_event_id_fk" FOREIGN KEY ("voids_event_id") REFERENCES "public"."application_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_conflict" ADD CONSTRAINT "landing_conflict_opening_id_opening_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."opening"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_conflict" ADD CONSTRAINT "landing_conflict_entry_code_id_entry_code_id_fk" FOREIGN KEY ("entry_code_id") REFERENCES "public"."entry_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_conflict" ADD CONSTRAINT "landing_conflict_resolved_by_app_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_author_user_id_app_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_merged_into_person_id_person_id_fk" FOREIGN KEY ("merged_into_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_employer_id_employer_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."employer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_legal_text_version_id_legal_text_version_id_fk" FOREIGN KEY ("legal_text_version_id") REFERENCES "public"."legal_text_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_entry_code_id_entry_code_id_fk" FOREIGN KEY ("entry_code_id") REFERENCES "public"."entry_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_template_id_message_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_triggered_by_user_id_app_user_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_handled_by_app_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_token" ADD CONSTRAINT "resume_token_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_token" ADD CONSTRAINT "resume_token_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_token" ADD CONSTRAINT "resume_token_revoked_by_app_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression" ADD CONSTRAINT "suppression_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression" ADD CONSTRAINT "suppression_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression" ADD CONSTRAINT "suppression_lifted_by_app_user_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_check" ADD CONSTRAINT "background_check_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_check" ADD CONSTRAINT "background_check_offer_id_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hire_stint" ADD CONSTRAINT "hire_stint_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hire_stint" ADD CONSTRAINT "hire_stint_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hire_stint" ADD CONSTRAINT "hire_stint_employer_id_employer_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."employer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hire_stint" ADD CONSTRAINT "hire_stint_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hire_stint" ADD CONSTRAINT "hire_stint_opening_id_opening_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."opening"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hire_stint" ADD CONSTRAINT "hire_stint_crew_option_id_picklist_option_id_fk" FOREIGN KEY ("crew_option_id") REFERENCES "public"."picklist_option"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hire_stint" ADD CONSTRAINT "hire_stint_leave_reason_option_id_picklist_option_id_fk" FOREIGN KEY ("leave_reason_option_id") REFERENCES "public"."picklist_option"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hire_stint" ADD CONSTRAINT "hire_stint_rating_30_by_app_user_id_fk" FOREIGN KEY ("rating_30_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hire_stint" ADD CONSTRAINT "hire_stint_rating_90_by_app_user_id_fk" FOREIGN KEY ("rating_90_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_offered_by_app_user_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "form_version_one_published_per_role" ON "form_version" USING btree ("role_id") WHERE status = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "opening_one_open_per_role" ON "opening" USING btree ("role_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "pipeline_stage_role_id_sort_order_idx" ON "pipeline_stage" USING btree ("role_id","sort_order");--> statement-breakpoint
CREATE INDEX "entry_code_group_session_id_idx" ON "entry_code" USING btree ("group_session_id");--> statement-breakpoint
CREATE INDEX "group_session_opening_id_starts_at_idx" ON "group_session" USING btree ("opening_id","starts_at");--> statement-breakpoint
CREATE INDEX "answer_question_version_id_idx" ON "answer" USING btree ("question_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "application_one_per_person_per_opening" ON "application" USING btree ("person_id","opening_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "application_opening_id_status_current_stage_id_idx" ON "application" USING btree ("opening_id","status","current_stage_id");--> statement-breakpoint
CREATE INDEX "application_submitted_at_idx" ON "application" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX "application_attributed_session_id_idx" ON "application" USING btree ("attributed_session_id");--> statement-breakpoint
CREATE INDEX "application_last_activity_at_unsubmitted_idx" ON "application" USING btree ("last_activity_at") WHERE submitted_at is null;--> statement-breakpoint
CREATE INDEX "application_event_application_id_occurred_at_idx" ON "application_event" USING btree ("application_id","occurred_at");--> statement-breakpoint
CREATE INDEX "application_event_to_stage_id_occurred_at_idx" ON "application_event" USING btree ("to_stage_id","occurred_at");--> statement-breakpoint
CREATE INDEX "application_event_kind_occurred_at_idx" ON "application_event" USING btree ("kind","occurred_at");--> statement-breakpoint
CREATE INDEX "landing_conflict_opening_id_unresolved_idx" ON "landing_conflict" USING btree ("opening_id") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "note_application_id_created_at_idx" ON "note" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "note_person_id_idx" ON "note" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_one_per_unshared_mobile" ON "person" USING btree ("mobile_e164") WHERE mobile_e164 is not null and not shared_mobile;--> statement-breakpoint
CREATE INDEX "person_email_normalized_idx" ON "person" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "person_merged_into_person_id_idx" ON "person" USING btree ("merged_into_person_id");--> statement-breakpoint
CREATE INDEX "consent_event_address_employer_id_occurred_at_idx" ON "consent_event" USING btree ("address","employer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "consent_event_person_id_idx" ON "consent_event" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "message_send_after_queued_idx" ON "message" USING btree ("send_after") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "message_application_id_created_at_idx" ON "message" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "message_person_id_created_at_idx" ON "message" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "message_inbound_unhandled_idx" ON "message" USING btree ("created_at") WHERE direction = 'inbound' and handled_at is null;--> statement-breakpoint
CREATE INDEX "resume_token_application_id_idx" ON "resume_token" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_one_live_per_address" ON "suppression" USING btree ("channel","address") WHERE lifted_at is null;--> statement-breakpoint
CREATE INDEX "background_check_application_id_idx" ON "background_check" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hire_stint_one_active_per_application" ON "hire_stint" USING btree ("application_id") WHERE voided_at is null and outcome = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "hire_stint_one_active_per_person_per_opening" ON "hire_stint" USING btree ("person_id","opening_id") WHERE voided_at is null and outcome = 'active' and opening_id is not null;--> statement-breakpoint
CREATE INDEX "hire_stint_role_id_start_on_idx" ON "hire_stint" USING btree ("role_id","start_on");--> statement-breakpoint
CREATE INDEX "hire_stint_person_id_idx" ON "hire_stint" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "hire_stint_opening_id_idx" ON "hire_stint" USING btree ("opening_id");--> statement-breakpoint
CREATE INDEX "offer_application_id_offered_on_idx" ON "offer" USING btree ("application_id","offered_on");--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_entity_id_occurred_at_idx" ON "audit_log" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_application_id_occurred_at_idx" ON "audit_log" USING btree ("application_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_user_id_occurred_at_idx" ON "audit_log" USING btree ("actor_user_id","occurred_at");