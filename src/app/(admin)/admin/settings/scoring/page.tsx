import { Notice } from "@/components/admin/settings/fields";
import { pageAccess } from "@/components/admin/settings/page-access";
import { DailyCapForm } from "@/components/admin/settings/scoring/daily-cap-form";
import { DisclosureCard } from "@/components/admin/settings/scoring/disclosure-card";
import { RoleScoringCard } from "@/components/admin/settings/scoring/role-card";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { loadAiDisclosures, MAX_DISCLOSURE_LENGTH } from "@/server/services/scoring/disclosure";
import { anthropicKeyConfigured, scoringProvider } from "@/server/services/scoring/provider";
import { getScoringCap, listRoleRubrics, loadCalibration, loadRubricQuestions, SCORING_DAILY_CAP_MAX } from "@/server/services/scoring/rubrics";

export const metadata = { title: "AI scoring" };

// Settings > AI scoring (Phase 2): for each role the scoring mode, the published rubric,
// re-scoring and, in hidden mode, the calibration table; then the daily limit and the AI
// notice applicants read. Admin only. Each role's rubric editor and Try it are on its own page.
export default async function ScoringSettingsPage() {
  const access = await pageAccess("admin");
  const header = (
    <PageHeader
      title="AI scoring"
      description="Each role's rubric and scoring mode, the daily limit and the AI notice applicants read. The score is a sorting aid; a person makes every decision."
    />
  );
  if (!access.ok) {
    return (
      <div>
        {header}
        {access.view}
      </div>
    );
  }

  const [roles, cap, disclosures] = await Promise.all([listRoleRubrics(db), getScoringCap(db), loadAiDisclosures(db)]);
  const extras = await Promise.all(
    roles.map(async (data) => ({
      questionKeys: Object.fromEntries((await loadRubricQuestions(db, data.role.id)).map((question) => [question.questionId, question.key])),
      calibration: data.mode === "hidden" ? await loadCalibration(db, data.role.id) : null,
    })),
  );
  const provider = scoringProvider();
  const keyMissing = provider === "live" && !anthropicKeyConfigured();

  return (
    <div>
      {header}
      <div className="grid max-w-3xl gap-6">
        {keyMissing ? (
          <Notice tone="warning">
            The Anthropic API key (ANTHROPIC_API_KEY) is not set, so nothing is scored and Try it cannot run. Paste it into Railway on the web and cron
            services.
          </Notice>
        ) : provider === "fake" ? (
          <Notice>
            Scores here come from the stand-in scorer, which calls no AI: it grades every criterion 3 unless an answer carries a test marker. Production
            uses the Anthropic model.
          </Notice>
        ) : null}
        {roles.map((data, index) => (
          <RoleScoringCard
            key={data.role.id}
            data={data}
            questionKeys={extras[index]!.questionKeys}
            calibration={extras[index]!.calibration}
            cap={cap.cap}
            usedToday={cap.usedToday}
          />
        ))}
        <DailyCapForm cap={cap.cap} usedToday={cap.usedToday} max={SCORING_DAILY_CAP_MAX} />
        <DisclosureCard overview={disclosures} maxLength={MAX_DISCLOSURE_LENGTH} />
      </div>
    </div>
  );
}
