import { createHash } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pageAccess } from "@/components/admin/settings/page-access";
import { DraftWorkspace, StartDraftCard } from "@/components/admin/settings/scoring/draft-workspace";
import { TryItPanel } from "@/components/admin/settings/scoring/try-it-panel";
import { VersionHistory } from "@/components/admin/settings/scoring/version-history";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { isUuid } from "@/lib/uuid";
import { anthropicKeyConfigured, scoringProvider } from "@/server/services/scoring/provider";
import { checkRubricDraft, getScoringCap, loadRoleRubric, loadRubricQuestions, loadRubricVersions } from "@/server/services/scoring/rubrics";
import { listTestCases, NO_KEY_MESSAGE } from "@/server/services/scoring/test-cases";

export const metadata = { title: "AI rubric" };

// One role's rubric: the draft editor (or a way to start one), Try it with the samples, and
// every version. Admin only.
export default async function RoleRubricPage({ params }: { params: Promise<{ roleId: string }> }) {
  const access = await pageAccess("admin");
  if (!access.ok) {
    return (
      <div>
        <PageHeader title="AI rubric" />
        {access.view}
      </div>
    );
  }

  const { roleId } = await params;
  if (!isUuid(roleId)) notFound();
  const data = await loadRoleRubric(db, roleId);
  if (!data) notFound();
  const [questions, versions, testCases, cap, problems] = await Promise.all([
    loadRubricQuestions(db, roleId),
    data.rubricId ? loadRubricVersions(db, data.rubricId) : [],
    data.rubricId ? listTestCases(db, data.rubricId) : [],
    getScoringCap(db),
    data.draft ? checkRubricDraft(db, data.draft.id) : [],
  ]);
  const questionKeys = Object.fromEntries(questions.map((question) => [question.questionId, question.key]));

  // Try it scores the draft while one is open, else the published version; its sample form
  // asks for an answer to each question that version reads.
  const target = data.draft ?? data.published;
  const readKeys = [...new Set(target?.criteria.flatMap((criterion) => criterion.questionIds) ?? [])];
  const tryQuestions = readKeys.flatMap((id) => {
    const question = questions.find((q) => q.questionId === id);
    return question && !question.aiNeverSend ? [{ key: question.key, prompt: question.prompt }] : [];
  });
  const provider = scoringProvider();
  // A new key after each save remounts the editor on the saved draft.
  const editorKey = data.draft ? createHash("sha1").update(JSON.stringify(data.draft)).digest("hex") : "";

  return (
    <div>
      <PageHeader
        title={data.role.internalName}
        description="AI scoring rubric. Edit the draft, try it on sample answers, then publish it with a written reason."
      >
        <Link href="/admin/settings/scoring" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          All roles
        </Link>
      </PageHeader>
      <div className="grid max-w-4xl gap-6">
        {data.draft ? (
          <DraftWorkspace
            editorKey={editorKey}
            roleId={roleId}
            roleName={data.role.internalName}
            draft={data.draft}
            published={data.published}
            questions={questions}
            problems={problems}
            mode={data.mode}
            submittedCount={data.submittedCount}
            cap={cap.cap}
          />
        ) : (
          <StartDraftCard roleId={roleId} publishedVersion={data.published?.version ?? null} />
        )}
        <TryItPanel
          roleId={roleId}
          rubricId={data.rubricId}
          target={target ? { id: target.id, version: target.version, status: target.status } : null}
          questions={tryQuestions}
          testCases={testCases}
          keyMissingMessage={provider === "live" && !anthropicKeyConfigured() ? NO_KEY_MESSAGE : null}
          standIn={provider === "fake"}
        />
        <VersionHistory versions={versions} questionKeys={questionKeys} />
      </div>
    </div>
  );
}
