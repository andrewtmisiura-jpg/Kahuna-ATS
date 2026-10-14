import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdminPage } from "@/components/admin/questions/admins-only";
import { QuestionEditor } from "@/components/admin/questions/question-editor";
import { db } from "@/db";
import { isUuid } from "@/lib/uuid";
import { loadRoleForms } from "@/server/services/forms/editor";
import { checkDraft } from "@/server/services/forms/publish";

export const metadata: Metadata = { title: "Questions" };

// The editor for one role: published version, draft and preview.
export default async function RoleQuestionsPage({ params }: { params: Promise<{ roleId: string }> }) {
  const denied = await requireAdminPage();
  if (denied) return denied;

  const { roleId } = await params;
  if (!isUuid(roleId)) notFound();
  const forms = await loadRoleForms(db, roleId);
  if (!forms) notFound();
  const problems = forms.draft ? await checkDraft(db, forms.draft.id) : [];

  return (
    <div>
      <PageHeader
        title={forms.role.internalName}
        description="Edit the draft, then publish it as a locked version with a written reason. Applications already started keep theirs."
      >
        <Link href="/admin/questions" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          All roles
        </Link>
      </PageHeader>
      <QuestionEditor forms={forms} problems={problems} />
    </div>
  );
}
