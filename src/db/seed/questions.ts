import type { FormSection, QuestionOption, QuestionType, QuestionValidation } from "@/db/schema";

export type SeedQuestion = {
  key: string;
  section: string;
  type: QuestionType;
  prompt: string;
  help?: string;
  options?: QuestionOption[];
  validation?: QuestionValidation;
  required: boolean;
  // Answer values that show a warning chip; never acted on automatically.
  attention?: string[];
  // Never sent to the AI scorer, whatever a rubric asks for.
  aiNeverSend?: boolean;
};

export type SeedForm = {
  sections: FormSection[];
  questions: SeedQuestion[];
  // Snow form v1 is published by the seed; the window form stays a draft.
  publish: boolean;
  changeReason: string;
};

const JOB_END_OPTIONS: QuestionOption[] = [
  { key: "still_there", label: "I still work there" },
  { key: "seasonal_end", label: "Seasonal or temporary job ended" },
  { key: "laid_off", label: "Laid off" },
  { key: "left_for_job", label: "Left for another job" },
  { key: "left_other", label: "Left for another reason" },
  { key: "let_go", label: "Was let go" },
  { key: "other", label: "Other" },
];

const MONTHS: QuestionValidation = { min: 0, max: 600, integer: true };
const SHORT_TEXT: QuestionValidation = { maxLength: 200 };
const LONG_TEXT: QuestionValidation = { maxLength: 2000 };
const NO = ["false"];

// Snow removal question set, form version 1 (DATA_MODEL.md, "Snow removal question set").
export const snowForm: SeedForm = {
  publish: true,
  changeReason: "Snow form v1 from the seed (DATA_MODEL.md)",
  sections: [
    { key: "basics", title: "Basics" },
    { key: "availability", title: "Availability" },
    { key: "experience", title: "Experience", intro: "Skip the job questions if you haven't had a job yet." },
  ],
  questions: [
    { key: "age_18_plus", section: "basics", type: "yes_no", prompt: "Are you 18 or older?", required: true, attention: NO, aiNeverSend: true },
    { key: "drivers_license", section: "basics", type: "yes_no", prompt: "Do you have a valid driver's license?", required: true },
    {
      key: "short_notice_travel",
      section: "basics",
      type: "yes_no",
      prompt: "Can you get to job sites around the Twin Cities on short notice, including overnight?",
      required: true,
      attention: NO,
    },
    { key: "start_date", section: "basics", type: "date", prompt: "What is the earliest date you could start?", required: true },
    {
      key: "essential_functions",
      section: "basics",
      type: "yes_no",
      prompt:
        "This job means shoveling and running snow equipment outdoors in cold weather, often overnight or before sunrise, for several hours at a time. Can you do this work, with or without reasonable accommodation?",
      required: true,
      attention: NO,
      aiNeverSend: true,
    },
    {
      key: "call_windows",
      section: "availability",
      type: "multi_choice",
      prompt: "When could you take a snow call? Pick all that apply.",
      options: [
        { key: "overnight", label: "Overnight (midnight to 5am)" },
        { key: "early_morning", label: "Early morning (5am to 8am)" },
        { key: "daytime", label: "Daytime" },
        { key: "evening", label: "Evening" },
        { key: "weekends", label: "Weekends" },
      ],
      required: true,
    },
    {
      key: "response_time",
      section: "availability",
      type: "single_choice",
      prompt: "If we call you during a storm, how quickly could you be on your way?",
      options: [
        { key: "under_30", label: "Within 30 minutes" },
        { key: "30_to_60", label: "30 to 60 minutes" },
        { key: "1_to_2h", label: "1 to 2 hours" },
        { key: "over_2h", label: "More than 2 hours" },
      ],
      required: true,
      attention: ["over_2h"],
    },
    {
      key: "other_job",
      section: "availability",
      type: "single_choice",
      prompt: "Do you have another job, and when do you usually work it?",
      options: [
        { key: "none", label: "No other job" },
        { key: "weekday_days", label: "Yes, weekday daytime" },
        { key: "evenings_nights", label: "Yes, evenings or nights" },
        { key: "varies", label: "Yes, it varies" },
      ],
      required: true,
    },
    {
      key: "equipment",
      section: "experience",
      type: "multi_choice",
      prompt: "Which of these have you used for snow removal? Pick all that apply.",
      options: [
        { key: "shovel", label: "Shovel" },
        { key: "snowblower", label: "Snowblower" },
        { key: "plow_truck", label: "Plow truck" },
        { key: "skid_steer", label: "Skid steer" },
        { key: "tractor", label: "Tractor" },
        { key: "none", label: "None yet" },
      ],
      required: true,
    },
    {
      key: "job1_employer",
      section: "experience",
      type: "short_text",
      prompt: "Your most recent job: who was the employer?",
      validation: SHORT_TEXT,
      required: false,
      aiNeverSend: true,
    },
    {
      key: "job1_months",
      section: "experience",
      type: "number",
      prompt: "How many months did you work there (or have you so far)?",
      validation: MONTHS,
      required: false,
    },
    { key: "job1_end", section: "experience", type: "single_choice", prompt: "How did that job end?", options: JOB_END_OPTIONS, required: false },
  ],
};

// Window cleaning starter set, seeded as a draft and published in the question
// editor before the window opening opens (DATA_MODEL.md, "Window cleaning starter set").
export const windowForm: SeedForm = {
  publish: false,
  changeReason: "Window form v1 draft from the seed (DATA_MODEL.md)",
  sections: [
    { key: "basics", title: "Basics" },
    { key: "work_history", title: "Work history", intro: "Skip this section if you haven't had a job yet." },
    { key: "about_you", title: "About you", intro: "Short answers are fine. Spelling and grammar don't matter." },
  ],
  questions: [
    { key: "age_18_plus", section: "basics", type: "yes_no", prompt: "Are you 18 or older?", required: true, attention: NO, aiNeverSend: true },
    { key: "drivers_license", section: "basics", type: "yes_no", prompt: "Do you have a valid driver's license?", required: true, attention: NO },
    {
      key: "shop_commute",
      section: "basics",
      type: "yes_no",
      prompt: "Can you get to our Golden Valley shop by the start of each workday?",
      required: true,
      attention: NO,
    },
    { key: "start_date", section: "basics", type: "date", prompt: "What is the earliest date you could start?", required: true },
    {
      key: "full_season",
      section: "basics",
      type: "yes_no",
      prompt: "Can you work full-time from your start date through the end of the season?",
      help: "The season end date is on the job page.",
      required: true,
      attention: NO,
    },
    {
      key: "hours_fit",
      section: "basics",
      type: "single_choice",
      prompt: "Busy weeks here can run 55 hours, and slow weeks are much lighter. Which fits you best?",
      options: [
        { key: "varies_ok", label: "Weeks that go up and down work for me" },
        { key: "need_steady_40", label: "I need close to 40 hours every week" },
        { key: "not_sure", label: "Not sure" },
      ],
      required: true,
    },
    { key: "other_job", section: "basics", type: "yes_no", prompt: "Do you have another job you plan to keep during our season?", required: true },
    {
      key: "ladder_height",
      section: "basics",
      type: "single_choice",
      prompt: "What is the highest you have worked on a ladder?",
      options: [
        { key: "never", label: "I haven't worked on a ladder" },
        { key: "one_story", label: "One story or less" },
        { key: "two_story", label: "Two stories" },
        { key: "three_plus", label: "Three stories or higher" },
      ],
      required: true,
    },
    {
      key: "essential_functions",
      section: "basics",
      type: "yes_no",
      prompt:
        "This job means climbing and working on ladders, carrying ladders and equipment, and working outdoors most of the day. Can you do this work, with or without reasonable accommodation?",
      required: true,
      attention: NO,
      aiNeverSend: true,
    },
    {
      key: "job1_employer",
      section: "work_history",
      type: "short_text",
      prompt: "Most recent job: who was the employer?",
      validation: SHORT_TEXT,
      required: false,
      aiNeverSend: true,
    },
    {
      key: "job1_months",
      section: "work_history",
      type: "number",
      prompt: "How many months did you work there (or have you so far)?",
      validation: MONTHS,
      required: false,
    },
    { key: "job1_end", section: "work_history", type: "single_choice", prompt: "How did that job end?", options: JOB_END_OPTIONS, required: false },
    {
      key: "job2_employer",
      section: "work_history",
      type: "short_text",
      prompt: "The job before that: who was the employer?",
      validation: SHORT_TEXT,
      required: false,
      aiNeverSend: true,
    },
    { key: "job2_months", section: "work_history", type: "number", prompt: "How many months did you work there?", validation: MONTHS, required: false },
    { key: "job2_end", section: "work_history", type: "single_choice", prompt: "How did that job end?", options: JOB_END_OPTIONS, required: false },
    {
      key: "hardest_physical",
      section: "about_you",
      type: "long_text",
      prompt: "Tell us about the hardest physical job you've done. What made it hard, and how did you handle it?",
      validation: LONG_TEXT,
      required: true,
    },
    { key: "why_this_job", section: "about_you", type: "long_text", prompt: "Why does this job interest you?", validation: LONG_TEXT, required: true },
    {
      key: "slow_stretch",
      section: "about_you",
      type: "long_text",
      prompt: "When work slows down for a week or two, how would you handle it?",
      validation: LONG_TEXT,
      required: true,
      aiNeverSend: true,
    },
    {
      key: "stranger",
      section: "about_you",
      type: "long_text",
      prompt: "Tell us about a time you had to talk to a stranger and help them or convince them of something.",
      validation: LONG_TEXT,
      required: true,
    },
    {
      key: "supervisor_view",
      section: "about_you",
      type: "long_text",
      prompt: "What would your last supervisor say is your biggest strength, and the thing you most need to work on?",
      validation: LONG_TEXT,
      required: true,
    },
    {
      key: "pushed_through",
      section: "about_you",
      type: "long_text",
      prompt: "Tell us about a time you were uncomfortable or nervous doing something and pushed through anyway.",
      validation: LONG_TEXT,
      required: true,
    },
    {
      key: "two_years",
      section: "about_you",
      type: "long_text",
      prompt: "Where do you want to be in two years?",
      validation: LONG_TEXT,
      required: false,
      aiNeverSend: true,
    },
  ],
};
