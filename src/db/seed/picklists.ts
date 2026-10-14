export type SeedPicklistOption = {
  listKey: "disqualify_reason" | "withdraw_reason" | "not_selected_reason" | "leave_reason" | "star_reason" | "assessment_type";
  key: string;
  label: string;
  requiresNote?: boolean;
  fcraAdverse?: boolean;
  defaultSeparation?: "voluntary" | "involuntary";
  // Role key when the option belongs to one role; otherwise all roles of the employer.
  roleKey?: "snow_removal_tech" | "window_cleaning_tech";
};

// Reason picklists (DATA_MODEL.md, "Reason picklists"). Crews are entered by the
// owner in Settings > Picklists, so the crew list is seeded empty.
export const seedPicklists: SeedPicklistOption[] = [
  { listKey: "disqualify_reason", key: "missing_requirement", label: "Missing a job requirement", requiresNote: true },
  { listKey: "disqualify_reason", key: "availability_conflict", label: "Availability doesn't fit" },
  { listKey: "disqualify_reason", key: "failed_ladder_test", label: "Did not pass the ladder test", roleKey: "window_cleaning_tech" },
  { listKey: "disqualify_reason", key: "interview_concerns", label: "Interview concerns", requiresNote: true },
  { listKey: "disqualify_reason", key: "background_or_driving_record", label: "Background or driving record", fcraAdverse: true },
  { listKey: "disqualify_reason", key: "other", label: "Other", requiresNote: true },

  { listKey: "withdraw_reason", key: "took_another_job", label: "Took another job" },
  { listKey: "withdraw_reason", key: "pay", label: "Pay" },
  { listKey: "withdraw_reason", key: "schedule_or_hours", label: "Schedule or hours" },
  { listKey: "withdraw_reason", key: "no_show_one_on_one", label: "No-show to one-on-one" },
  { listKey: "withdraw_reason", key: "stopped_responding", label: "Stopped responding" },
  { listKey: "withdraw_reason", key: "declined_offer", label: "Declined the offer" },
  { listKey: "withdraw_reason", key: "other", label: "Other", requiresNote: true },

  { listKey: "not_selected_reason", key: "roles_filled", label: "Roles filled" },
  { listKey: "not_selected_reason", key: "opening_closed", label: "Opening closed before review" },
  { listKey: "not_selected_reason", key: "other", label: "Other", requiresNote: true },

  { listKey: "leave_reason", key: "part_time_conflict", label: "Conflict with another job", defaultSeparation: "voluntary" },
  { listKey: "leave_reason", key: "heights", label: "Uncomfortable with heights", defaultSeparation: "voluntary" },
  { listKey: "leave_reason", key: "too_physical", label: "Work was too physical", defaultSeparation: "voluntary" },
  { listKey: "leave_reason", key: "wanted_more_hours", label: "Wanted more or steadier hours", defaultSeparation: "voluntary" },
  { listKey: "leave_reason", key: "took_another_job", label: "Took another job", defaultSeparation: "voluntary" },
  { listKey: "leave_reason", key: "relocated", label: "Moved away", defaultSeparation: "voluntary" },
  { listKey: "leave_reason", key: "performance", label: "Performance", defaultSeparation: "involuntary" },
  { listKey: "leave_reason", key: "attendance", label: "Attendance", defaultSeparation: "involuntary" },
  { listKey: "leave_reason", key: "no_call_no_show", label: "No call, no show" },
  { listKey: "leave_reason", key: "other", label: "Other", requiresNote: true },

  { listKey: "star_reason", key: "on_time", label: "Arrived on time" },
  { listKey: "star_reason", key: "engaged", label: "Engaged or asked good questions" },
  { listKey: "star_reason", key: "relevant_experience", label: "Relevant experience" },
  { listKey: "star_reason", key: "followed_up", label: "Talked to staff afterward" },
  { listKey: "star_reason", key: "other", label: "Other" },

  { listKey: "assessment_type", key: "ladder_test", label: "Ladder test", roleKey: "window_cleaning_tech" },
];
