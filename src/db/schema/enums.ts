import { pgEnum } from "drizzle-orm/pg-core";

// Postgres enum types from the "Enumerations" section of DATA_MODEL.md.
// Adding a value later is additive; renaming or removing one is not allowed.
// The Phase 1 enums come first, then the Phase 2 ones (drizzle/0007_phase2_tables.sql).

export const MILESTONES = [
  "started",
  "submitted",
  "reviewed",
  "interview_invited",
  "interviewed",
  "offered",
  "background_check",
  "hired",
] as const;
export type Milestone = (typeof MILESTONES)[number];
export const milestoneEnum = pgEnum("milestone", MILESTONES);

export const applicationStatusEnum = pgEnum("application_status", ["open", "hired", "closed"]);
export const closedOutcomeEnum = pgEnum("closed_outcome", ["disqualified", "withdrew", "not_selected"]);
export const applicationOriginEnum = pgEnum("application_origin", ["landing", "staff_created", "imported"]);
export const applicationEventKindEnum = pgEnum("application_event_kind", [
  "created",
  "submitted",
  "stage_changed",
  "closed",
  "reopened",
  "hold_set",
  "hold_cleared",
  "contacted",
  "hire_rescinded",
  "event_voided",
  "person_merged",
]);
// Deliberately has no AI value: the AI never moves, closes or rejects an application.
export const actorTypeEnum = pgEnum("actor_type", ["staff", "applicant", "system"]);
export const channelEnum = pgEnum("channel", ["sms", "email"]);
export const messageDirectionEnum = pgEnum("message_direction", ["outbound", "inbound"]);
export const messageStatusEnum = pgEnum("message_status", [
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "undelivered",
  "suppressed",
  "canceled",
  "received",
  "unknown",
]);
export const messageProviderEnum = pgEnum("message_provider", ["quo", "resend", "sink"]);
// Phase 2 purposes are created now so no enum change is needed later.
export const messagePurposeEnum = pgEnum("message_purpose", [
  "resume_link",
  "link_recovery",
  "reminder_24h",
  "submit_confirmation",
  "help_reply",
  "group_invite",
  "one_on_one_invite",
  "one_on_one_reminder",
  "status_update",
  "decline",
]);
export const tokenIssueEnum = pgEnum("token_issue", ["landing_cookie", "message", "staff_reissue"]);
export const consentActionEnum = pgEnum("consent_action", ["opt_in", "declined", "opt_out", "opt_in_keyword"]);
export const consentMethodEnum = pgEnum("consent_method", ["web_form", "keyword", "free_text_reply", "staff_recorded"]);
export const suppressionReasonEnum = pgEnum("suppression_reason", [
  "stop_keyword",
  "free_text_request",
  "staff_marked",
  "carrier_blocked",
  "email_hard_bounce",
  "email_complaint",
]);
export const entryChannelEnum = pgEnum("entry_channel", [
  "role_qr",
  "session_qr",
  "indeed_message",
  "job_posting",
  "flyer",
  "website",
  "staff_entered",
  "other",
]);
export const sourceEnum = pgEnum("source", [
  "indeed",
  "referral",
  "current_employee",
  "former_employee",
  "social_media",
  "sign_or_walk_in",
  "other",
]);
export const attributionMethodEnum = pgEnum("attribution_method", ["none", "scanned_session", "phone_match", "staff_confirmed"]);
// How the person arrived at the group interview, set by staff. Null means not recorded.
export const GROUP_INTERVIEW_ARRIVALS = ["on_time", "late", "did_not_attend"] as const;
export type GroupInterviewArrival = (typeof GROUP_INTERVIEW_ARRIVALS)[number];
export const groupInterviewArrivalEnum = pgEnum("group_interview_arrival", GROUP_INTERVIEW_ARRIVALS);
export const QUESTION_TYPES = ["short_text", "long_text", "single_choice", "multi_choice", "yes_no", "date", "number"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const questionTypeEnum = pgEnum("question_type", QUESTION_TYPES);
export const configStatusEnum = pgEnum("config_status", ["draft", "published", "retired"]);
export const openingStatusEnum = pgEnum("opening_status", ["draft", "open", "closed"]);
export const groupSessionStatusEnum = pgEnum("group_session_status", ["scheduled", "held", "canceled"]);
export const legalTextKindEnum = pgEnum("legal_text_kind", [
  "sms_consent",
  "privacy_policy",
  "sms_terms",
  "landing_notice",
  "ai_disclosure",
  // Added by drizzle/0002_applicant_opt_in_page.sql for the public opt-in page.
  "opt_in_page",
]);
export const picklistKeyEnum = pgEnum("picklist_key", [
  "disqualify_reason",
  "withdraw_reason",
  "not_selected_reason",
  "leave_reason",
  "star_reason",
  "crew",
  "assessment_type",
]);
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);
export const userRoleEnum = pgEnum("user_role", ["admin", "hiring_manager", "viewer"]);
export const offerResponseEnum = pgEnum("offer_response", ["pending", "accepted", "declined", "rescinded", "expired"]);
export const payUnitEnum = pgEnum("pay_unit", ["hourly", "daily", "salary"]);
export const backgroundCheckTypeEnum = pgEnum("background_check_type", ["criminal", "driving_record", "drug_screen", "other"]);
export const backgroundCheckStatusEnum = pgEnum("background_check_status", [
  "requested",
  "in_progress",
  "clear",
  "needs_review",
  "pre_adverse_sent",
  "final_adverse_sent",
  "canceled",
]);
export const hireOriginEnum = pgEnum("hire_origin", ["ats", "external", "historical_import"]);
export const hireOutcomeEnum = pgEnum("hire_outcome", ["active", "completed_season", "separated", "never_started"]);
export const hireVoidKindEnum = pgEnum("hire_void_kind", ["entered_in_error", "rescinded"]);
export const separationTypeEnum = pgEnum("separation_type", ["voluntary", "involuntary"]);
export const seasonEndRatingEnum = pgEnum("season_end_rating", ["reliable", "mixed", "unreliable", "never_worked"]);

// Phase 2: sessions, scoring, interviews and jobs. Each list is exported so screens
// and services read the values from here rather than repeating them.

export const JOB_STATUSES = ["queued", "running", "retry", "succeeded", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);

export const ATTENDEE_SOURCES = ["paper_sheet", "door_checkin", "staff_added"] as const;
export type AttendeeSource = (typeof ATTENDEE_SOURCES)[number];
export const attendeeSourceEnum = pgEnum("attendee_source", ATTENDEE_SOURCES);

export const STAR_MARKS = ["star", "concern"] as const;
export type StarMark = (typeof STAR_MARKS)[number];
export const starMarkEnum = pgEnum("star_mark", STAR_MARKS);

export const SCORING_MODES = ["off", "hidden", "visible"] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];
export const scoringModeEnum = pgEnum("scoring_mode", SCORING_MODES);

// The 1 to 100 overall_score replaces the brief's Advance / Review / Decline; there is no label enum.
export const AI_SCORE_STATUSES = ["queued", "succeeded", "failed", "invalid_output"] as const;
export type AiScoreStatus = (typeof AI_SCORE_STATUSES)[number];
export const aiScoreStatusEnum = pgEnum("ai_score_status", AI_SCORE_STATUSES);

export const REVIEW_DECISION_VALUES = ["advance", "hold", "decline"] as const;
export type ReviewDecisionValue = (typeof REVIEW_DECISION_VALUES)[number];
export const reviewDecisionValueEnum = pgEnum("review_decision_value", REVIEW_DECISION_VALUES);

export const INTERVIEW_KINDS = ["one_on_one", "phone_screen"] as const;
export type InterviewKind = (typeof INTERVIEW_KINDS)[number];
export const interviewKindEnum = pgEnum("interview_kind", INTERVIEW_KINDS);

export const INTERVIEW_STATUSES = ["scheduled", "held", "no_show", "canceled"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];
export const interviewStatusEnum = pgEnum("interview_status", INTERVIEW_STATUSES);

// The type is interview_grade_value, not interview_grade as DATA_MODEL.md first had it:
// the interview_grade table's row type already takes that name, the same reason the
// review_decision enum is review_decision_value.
export const INTERVIEW_GRADES = ["a_plus", "a", "a_minus", "b_plus", "b", "b_minus", "c_plus", "c", "c_minus", "d", "f"] as const;
export type InterviewGrade = (typeof INTERVIEW_GRADES)[number];
export const interviewGradeValueEnum = pgEnum("interview_grade_value", INTERVIEW_GRADES);

export const INTERVIEW_RECOMMENDATIONS = ["hire", "maybe", "no_hire"] as const;
export type InterviewRecommendation = (typeof INTERVIEW_RECOMMENDATIONS)[number];
export const interviewRecommendationEnum = pgEnum("interview_recommendation", INTERVIEW_RECOMMENDATIONS);

export const ASSESSMENT_RESULTS = ["pass", "fail", "did_not_attempt"] as const;
export type AssessmentResult = (typeof ASSESSMENT_RESULTS)[number];
export const assessmentResultEnum = pgEnum("assessment_result", ASSESSMENT_RESULTS);
