import { db } from "@/db";
import { loadInterviewsPanel } from "@/server/services/interviews/panel";
import { InterviewsSection } from "./interviews/interviews-section";
import { TestSection } from "./interviews/test-section";
import type { ProfilePanelProps } from "./types";

// Interviews and assessments (Phase 2, interviews): one-on-ones and phone screens with
// their grades and recommendation, then each test the role uses, such as the ladder
// test, which only window applicants see. Hiring Managers and Admins record; Viewers
// read, without the tests' restricted notes, and see nothing where nothing is recorded.
export async function InterviewsPanel({ applicationId, user, canAct }: ProfilePanelProps) {
  const data = await loadInterviewsPanel(db, applicationId, user.role);
  if (!data) return null;
  const { application, interviews, interviewers, tests, reasons } = data;
  return (
    <>
      {canAct || interviews.length > 0 ? (
        <InterviewsSection
          applicationId={application.id}
          applicationStatus={application.status}
          interviews={interviews}
          interviewers={interviewers}
          canAct={canAct}
          currentUserId={user.id}
          noShowReason={reasons.noShow}
        />
      ) : null}
      {tests
        .filter((block) => canAct || block.live || block.voided.length > 0)
        .map((block) => (
          <TestSection
            key={block.type.id}
            applicationId={application.id}
            applicationStatus={application.status}
            block={block}
            canAct={canAct}
            failedTestReason={reasons.failedTest}
          />
        ))}
    </>
  );
}
