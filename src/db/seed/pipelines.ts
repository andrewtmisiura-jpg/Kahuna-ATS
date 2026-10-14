import type { Milestone } from "@/db/schema";

export type SeedStage = {
  sortOrder: number;
  key: string;
  name: string;
  publicLabel: string;
  milestone: Milestone;
  isSystem: boolean;
  showOnBoard: boolean;
};

// Default pipelines (DATA_MODEL.md, "Default pipelines"). Any stage may move straight
// to Hired or to any later stage; skipped milestones count as passed in reports.
const windowStages: SeedStage[] = [
  { sortOrder: 10, key: "started", name: "Started", publicLabel: "Received", milestone: "started", isSystem: true, showOnBoard: false },
  { sortOrder: 20, key: "submitted", name: "Submitted", publicLabel: "Received", milestone: "submitted", isSystem: true, showOnBoard: true },
  { sortOrder: 30, key: "reviewed", name: "Reviewed", publicLabel: "Under review", milestone: "reviewed", isSystem: false, showOnBoard: true },
  { sortOrder: 40, key: "one_on_one_invited", name: "One-on-one invited", publicLabel: "Interview", milestone: "interview_invited", isSystem: false, showOnBoard: true },
  { sortOrder: 50, key: "one_on_one_scheduled", name: "One-on-one scheduled", publicLabel: "Interview", milestone: "interview_invited", isSystem: false, showOnBoard: true },
  { sortOrder: 60, key: "one_on_one_done", name: "One-on-one done", publicLabel: "Interview", milestone: "interviewed", isSystem: false, showOnBoard: true },
  { sortOrder: 70, key: "conditional_offer", name: "Conditional offer", publicLabel: "Offer", milestone: "offered", isSystem: false, showOnBoard: true },
  { sortOrder: 80, key: "background_check", name: "Background check", publicLabel: "Background check", milestone: "background_check", isSystem: false, showOnBoard: true },
  { sortOrder: 90, key: "hired", name: "Hired", publicLabel: "Hired", milestone: "hired", isSystem: false, showOnBoard: true },
];

// Snow: the same without the scheduled stage; the check stage covers driving records too.
const snowStages: SeedStage[] = windowStages
  .filter((stage) => stage.key !== "one_on_one_scheduled")
  .map((stage) => (stage.key === "background_check" ? { ...stage, name: "Background or driving check" } : stage));

export const seedPipelines = {
  snow_removal_tech: snowStages,
  window_cleaning_tech: windowStages,
} as const;
