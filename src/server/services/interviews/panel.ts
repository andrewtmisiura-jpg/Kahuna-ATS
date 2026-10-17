import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@/db";
import { application, picklistOption, role } from "@/db/schema";
import type { UserRole } from "@/server/auth/roles";
import { listAssessments, listAssessmentTypes, type AssessmentType, type AssessmentView } from "../assessments/assessments";
import { listInterviewers, listInterviews, type InterviewView, type StaffChoice } from "./interviews";

// What the profile's interviews panel shows, loaded from the application id alone
// (components/admin/applicants/panels/interviews-panel.tsx): the interviews, the
// staff who can be picked as interviewer, one block per test the role uses (or once
// used on this application), and the existing close reasons the hints name. Viewers
// get no staff list and never a test's restricted note.

export type TestBlock = {
  type: AssessmentType;
  live: AssessmentView | null;
  voided: AssessmentView[];
};

export type InterviewsPanelData = {
  application: { id: string; roleId: string; status: "open" | "hired" | "closed" };
  interviews: InterviewView[];
  interviewers: StaffChoice[];
  tests: TestBlock[];
  // Labels of the reasons the Close dialog offers for a no-show and a failed ladder
  // test, or null when the role has no such reason.
  reasons: { noShow: string | null; failedTest: string | null };
};

export async function loadInterviewsPanel(db: Db, applicationId: string, viewer: UserRole): Promise<InterviewsPanelData | null> {
  const [app] = await db
    .select({ id: application.id, roleId: application.roleId, status: application.status, employerId: role.employerId })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .where(and(eq(application.id, applicationId), isNull(application.deletedAt)));
  if (!app) return null;

  const staff = viewer === "admin" || viewer === "hiring_manager";
  const [interviews, interviewers, types, results, reasons] = await Promise.all([
    listInterviews(db, app.id),
    staff ? listInterviewers(db) : Promise.resolve([]),
    listAssessmentTypes(db, app.roleId, { includeArchived: true }),
    listAssessments(db, app.id, viewer),
    db
      .select({ listKey: picklistOption.listKey, key: picklistOption.key, label: picklistOption.label })
      .from(picklistOption)
      .where(
        and(
          isNull(picklistOption.archivedAt),
          or(
            and(eq(picklistOption.listKey, "withdraw_reason"), eq(picklistOption.key, "no_show_one_on_one")),
            and(eq(picklistOption.listKey, "disqualify_reason"), eq(picklistOption.key, "failed_ladder_test")),
          ),
          or(isNull(picklistOption.employerId), eq(picklistOption.employerId, app.employerId)),
          or(isNull(picklistOption.roleId), eq(picklistOption.roleId, app.roleId)),
        ),
      ),
  ]);

  // An archived test still shows where this application has a result for it.
  const tests: TestBlock[] = types
    .filter((type) => !type.archivedAt || results.some((r) => r.assessmentTypeOptionId === type.id))
    .map((type) => {
      const mine = results.filter((r) => r.assessmentTypeOptionId === type.id);
      return { type, live: mine.find((r) => !r.voidedAt) ?? null, voided: mine.filter((r) => r.voidedAt) };
    });

  return {
    application: { id: app.id, roleId: app.roleId, status: app.status },
    interviews,
    interviewers,
    tests,
    reasons: {
      noShow: reasons.find((r) => r.listKey === "withdraw_reason")?.label ?? null,
      failedTest: reasons.find((r) => r.listKey === "disqualify_reason")?.label ?? null,
    },
  };
}
