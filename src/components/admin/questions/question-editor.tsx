"use client";

import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormSection } from "@/db/schema";
import {
  addExistingQuestionAction,
  createDraftAction,
  discardDraftAction,
  moveQuestionAction,
  moveSectionAction,
  removeQuestionAction,
  removeSectionAction,
  setAiNeverSendAction,
  type ActionResult,
} from "@/server/actions/admin/questions";
import { questionTextForMatching } from "@/server/services/forms/do-not-ask";
import type { EditorItem, FormSnapshot, RoleForms } from "@/server/services/forms/editor";
import type { DraftProblem } from "@/server/services/forms/publish";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";
import { DoNotAskPanel, hasDoNotAskMatch } from "./do-not-ask-panel";
import { Checkbox, ErrorText, Notice, Warning } from "./fields";
import { FormPreview } from "./form-preview";
import { FormView } from "./form-view";
import { attentionLabel, formatCentral, TYPE_LABELS } from "./format";
import { PublishDialog } from "./publish-dialog";
import { QuestionDialog, type QuestionDialogMode } from "./question-dialog";
import { SectionDialog } from "./section-dialog";

// The question editor for one role: the draft (editable), the published version
// (read-only) and a preview. Desktop-first like the other configuration screens,
// but every control stacks on a phone.

type Tab = "draft" | "published" | "preview";

type Confirm =
  | { kind: "remove_question"; item: EditorItem }
  | { kind: "remove_section"; section: FormSection }
  | { kind: "discard" };

export function QuestionEditor({ forms, problems }: { forms: RoleForms; problems: DraftProblem[] }) {
  const router = useRouter();
  const { role, published, draft, history, available } = forms;
  const [tab, setTab] = useState<Tab>(draft || !published ? "draft" : "published");
  const [previewSource, setPreviewSource] = useState<"draft" | "published">(draft ? "draft" : "published");
  const [sectionDialog, setSectionDialog] = useState<{ open: boolean; section: FormSection | null }>({ open: false, section: null });
  const [questionMode, setQuestionMode] = useState<QuestionDialogMode | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Quick actions (move, remove, toggle) with no dialog of their own.
  function act(run: () => Promise<ActionResult<unknown>>) {
    setBanner(null);
    startTransition(async () => {
      const result = await run();
      if (!result.ok) setBanner(result.message);
      router.refresh();
    });
  }

  const draftArgs = draft ? { roleId: role.id, formVersionId: draft.id } : null;

  const tabs: { key: Tab; label: string }[] = [
    { key: "draft", label: draft ? `Draft v${draft.version}` : "Draft" },
    { key: "published", label: published ? `Published v${published.version}` : "Published" },
    { key: "preview", label: "Preview" },
  ];

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Form versions" className="flex flex-wrap gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === t.key ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ErrorText>{banner}</ErrorText>

      {tab === "draft" ? (
        draft && draftArgs ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <Notice>
                Nothing here is live. Publishing locks this draft as version {draft.version}
                {published ? (
                  <>
                    {" "}
                    and retires version {published.version}. The {published.applicationCount} application{published.applicationCount === 1 ? "" : "s"} already
                    started keep version {published.version} to the end; new applications get version {draft.version}.
                  </>
                ) : (
                  <>. Applications for this role can start once a version is published.</>
                )}
              </Notice>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" onClick={() => setPublishOpen(true)} disabled={pending}>
                  Publish version {draft.version}
                </Button>
                <Button type="button" variant="outline" onClick={() => setSectionDialog({ open: true, section: null })} disabled={pending}>
                  <Plus /> Add section
                </Button>
                <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirm({ kind: "discard" })} disabled={pending}>
                  Discard draft
                </Button>
              </div>

              {problems.length > 0 ? (
                <Warning>
                  <p className="font-medium">Before this can be published:</p>
                  <ul className="list-disc pl-4">
                    {problems.map((problem, index) => (
                      <li key={index}>{problem.message}</li>
                    ))}
                  </ul>
                </Warning>
              ) : null}

              {draft.sections.map((section, index) => (
                <SectionCard
                  key={section.key}
                  section={section}
                  items={draft.items.filter((item) => item.sectionKey === section.key)}
                  first={index === 0}
                  last={index === draft.sections.length - 1}
                  pending={pending}
                  available={available}
                  onRename={() => setSectionDialog({ open: true, section })}
                  onMove={(direction) => act(() => moveSectionAction({ ...draftArgs, sectionKey: section.key, direction }))}
                  onRemove={() => setConfirm({ kind: "remove_section", section })}
                  onAddQuestion={() => setQuestionMode({ kind: "add", sectionKey: section.key })}
                  onRestore={(questionId) => act(() => addExistingQuestionAction({ ...draftArgs, questionId, sectionKey: section.key }))}
                  onEdit={(item) => setQuestionMode({ kind: "edit", item })}
                  onMoveQuestion={(item, direction) =>
                    act(() => moveQuestionAction({ ...draftArgs, questionVersionId: item.questionVersionId, direction }))
                  }
                  onRemoveQuestion={(item) => setConfirm({ kind: "remove_question", item })}
                  onToggleAi={(item, value) => act(() => setAiNeverSendAction({ roleId: role.id, questionId: item.questionId, value }))}
                />
              ))}

              <OrphanedItems
                draft={draft}
                pending={pending}
                onEdit={(item) => setQuestionMode({ kind: "edit", item })}
                onRemoveQuestion={(item) => setConfirm({ kind: "remove_question", item })}
              />
            </div>

            <aside className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">What the flags mean</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">Never to AI</span>: answers to this question are never included in anything sent to the AI
                    scorer, whatever a rubric asks for. It applies to every version of the question and is recorded in the audit log. Use it for anything
                    that could reveal age, health, family or other protected details.
                  </p>
                  <p>
                    <span className="font-medium text-foreground">Flag this answer</span>: a warning chip on the profile and list when an applicant gives
                    that answer. Staff decide what it means; nothing happens automatically.
                  </p>
                  <p>
                    <span className="font-medium text-foreground">Key</span>: the name reports use for a question. It is set once and never changes.
                    Removing a question from the draft keeps its key and every past answer.
                  </p>
                </CardContent>
              </Card>
              <DoNotAskPanel />
            </aside>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card>
              <CardHeader>
                <CardTitle>No draft</CardTitle>
                <CardDescription>
                  {published
                    ? `Start a draft from version ${published.version}. Nothing changes for applicants until you publish it.`
                    : "This role has no form yet. Start a draft to write its first version."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button type="button" onClick={() => act(() => createDraftAction({ roleId: role.id }))} disabled={pending}>
                  {pending ? "Starting..." : published ? `Start a draft from version ${published.version}` : "Start the first draft"}
                </Button>
              </CardContent>
            </Card>
            <aside>
              <DoNotAskPanel />
            </aside>
          </div>
        )
      ) : null}

      {tab === "published" ? (
        <div className="space-y-4">
          {published ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Version {published.version} is live</CardTitle>
                  <CardDescription>
                    Published {formatCentral(published.publishedAt)}
                    {published.publishedBy ? ` by ${published.publishedBy.name ?? published.publishedBy.email}` : " by the seed"}.{" "}
                    {published.applicationCount} application{published.applicationCount === 1 ? "" : "s"} pinned to it. Read-only: to change the form, edit the
                    draft and publish a new version.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {published.changeReason ? (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Reason: </span>
                      {published.changeReason}
                    </p>
                  ) : null}
                  <FormView form={published} />
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Nothing published yet</CardTitle>
                <CardDescription>The first publish makes the form live for new applications.</CardDescription>
              </CardHeader>
            </Card>
          )}
          {history.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">All versions</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y text-sm">
                  {history.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <span className="font-medium">Version {entry.version}</span>
                      <Badge variant={entry.status === "published" ? "default" : "outline"}>{entry.status}</Badge>
                      {entry.publishedAt ? <span className="text-muted-foreground">published {formatCentral(entry.publishedAt)}</span> : null}
                      <span className="text-muted-foreground">
                        {entry.applicationCount} application{entry.applicationCount === 1 ? "" : "s"}
                      </span>
                      {entry.changeReason && entry.status !== "draft" ? <span className="basis-full text-xs text-muted-foreground">{entry.changeReason}</span> : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === "preview" ? (
        <div className="space-y-4">
          {draft && published ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant={previewSource === "draft" ? "default" : "outline"} onClick={() => setPreviewSource("draft")}>
                Draft v{draft.version}
              </Button>
              <Button type="button" size="sm" variant={previewSource === "published" ? "default" : "outline"} onClick={() => setPreviewSource("published")}>
                Published v{published.version}
              </Button>
            </div>
          ) : null}
          {(() => {
            const form = previewSource === "draft" ? (draft ?? published) : (published ?? draft);
            return form ? <FormPreview form={form} /> : <Notice>Nothing to preview yet.</Notice>;
          })()}
        </div>
      ) : null}

      {draftArgs && draft ? (
        <>
          <SectionDialog
            open={sectionDialog.open}
            onOpenChange={(open) => {
              setSectionDialog((state) => ({ ...state, open }));
              if (!open) router.refresh();
            }}
            roleId={role.id}
            formVersionId={draft.id}
            section={sectionDialog.section}
          />
          <QuestionDialog
            open={questionMode !== null}
            onOpenChange={(open) => {
              if (!open) {
                setQuestionMode(null);
                router.refresh();
              }
            }}
            roleId={role.id}
            formVersionId={draft.id}
            sections={draft.sections}
            mode={questionMode}
          />
          <PublishDialog
            open={publishOpen}
            onOpenChange={(open) => {
              setPublishOpen(open);
              if (!open) router.refresh();
            }}
            roleId={role.id}
            draft={draft}
            published={published}
            problems={problems}
          />
          <ConfirmDialog
            open={confirm !== null}
            onOpenChange={(open) => {
              if (!open) {
                setConfirm(null);
                router.refresh();
              }
            }}
            title={
              confirm?.kind === "remove_question"
                ? "Remove this question from the draft?"
                : confirm?.kind === "remove_section"
                  ? "Remove this section?"
                  : "Discard this draft?"
            }
            description={
              confirm?.kind === "remove_question"
                ? `"${confirm.item.prompt}" leaves version ${draft.version}. Nothing is deleted: its key, earlier versions and every past answer stay, and you can add it back later.`
                : confirm?.kind === "remove_section"
                  ? `"${confirm.section.title}" is empty and will be removed from the draft.`
                  : `Version ${draft.version} and the wording written only for it are thrown away. ${published ? `Version ${published.version} stays live and untouched.` : ""}`
            }
            confirmLabel={confirm?.kind === "remove_question" ? "Remove question" : confirm?.kind === "remove_section" ? "Remove section" : "Discard draft"}
            destructive
            onConfirm={async () => {
              if (!confirm) return undefined;
              const result =
                confirm.kind === "remove_question"
                  ? await removeQuestionAction({ ...draftArgs, questionVersionId: confirm.item.questionVersionId })
                  : confirm.kind === "remove_section"
                    ? await removeSectionAction({ ...draftArgs, sectionKey: confirm.section.key })
                    : await discardDraftAction(draftArgs);
              return result.ok ? undefined : result.message;
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function SectionCard({
  section,
  items,
  first,
  last,
  pending,
  available,
  onRename,
  onMove,
  onRemove,
  onAddQuestion,
  onRestore,
  onEdit,
  onMoveQuestion,
  onRemoveQuestion,
  onToggleAi,
}: {
  section: FormSection;
  items: EditorItem[];
  first: boolean;
  last: boolean;
  pending: boolean;
  available: RoleForms["available"];
  onRename: () => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  onAddQuestion: () => void;
  onRestore: (questionId: string) => void;
  onEdit: (item: EditorItem) => void;
  onMoveQuestion: (item: EditorItem, direction: "up" | "down") => void;
  onRemoveQuestion: (item: EditorItem) => void;
  onToggleAi: (item: EditorItem, value: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>
              {section.title} <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">{section.key}</span>
            </CardTitle>
            {section.intro ? <CardDescription>{section.intro}</CardDescription> : null}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={onRename} disabled={pending}>
              <Pencil /> Rename
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Move section up" onClick={() => onMove("up")} disabled={pending || first}>
              <ArrowUp />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Move section down" onClick={() => onMove("down")} disabled={pending || last}>
              <ArrowDown />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove section"
              title={items.length > 0 ? "Move or remove its questions first" : "Remove section"}
              onClick={onRemove}
              disabled={pending || items.length > 0}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length > 0 ? (
          <ol className="divide-y rounded-md border">
            {items.map((item, index) => (
              <QuestionRow
                key={item.questionVersionId}
                item={item}
                first={index === 0}
                last={index === items.length - 1}
                pending={pending}
                onEdit={() => onEdit(item)}
                onMove={(direction) => onMoveQuestion(item, direction)}
                onRemove={() => onRemoveQuestion(item)}
                onToggleAi={(value) => onToggleAi(item, value)}
              />
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No questions in this section yet.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onAddQuestion} disabled={pending}>
            <Plus /> Add question
          </Button>
          {available.length > 0 ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="sr-only">Add back a question</span>
              <select
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                value=""
                disabled={pending}
                onChange={(e) => {
                  if (e.target.value) onRestore(e.target.value);
                }}
              >
                <option value="">Add back a removed question...</option>
                {available.map((entry) => (
                  <option key={entry.questionId} value={entry.questionId}>
                    {entry.key}: {entry.latest.prompt.slice(0, 60)}
                    {entry.latest.prompt.length > 60 ? "..." : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function QuestionRow({
  item,
  first,
  last,
  pending,
  onEdit,
  onMove,
  onRemove,
  onToggleAi,
}: {
  item: EditorItem;
  first: boolean;
  last: boolean;
  pending: boolean;
  onEdit: () => void;
  onMove?: (direction: "up" | "down") => void;
  onRemove: () => void;
  onToggleAi?: (value: boolean) => void;
}) {
  const flagged = hasDoNotAskMatch(questionTextForMatching(item));
  return (
    <li className="flex flex-col gap-3 px-3 py-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-mono text-muted-foreground">{item.key}</span>
          <Badge variant="outline">{TYPE_LABELS[item.type]}</Badge>
          <Badge variant="outline" title={item.publishedAt ? `Published ${formatCentral(item.publishedAt)}` : "Not published yet"}>
            v{item.version}
            {item.publishedAt ? "" : ", new in this draft"}
          </Badge>
          {item.required ? <Badge variant="secondary">Required</Badge> : null}
          {item.aiNeverSend ? <Badge variant="secondary">Never to AI</Badge> : null}
          {item.meaningChanged ? <Badge variant="outline">Meaning changed</Badge> : null}
          {flagged ? (
            <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-200">
              <TriangleAlert /> Check against do-not-ask
            </Badge>
          ) : null}
        </div>
        <p className="text-sm">{item.prompt}</p>
        {item.help ? <p className="text-xs text-muted-foreground">{item.help}</p> : null}
        {item.options ? <p className="text-xs text-muted-foreground">{item.options.map((option) => option.label).join(" / ")}</p> : null}
        {item.attentionValues?.length ? (
          <p className="text-xs text-muted-foreground">
            Flags when the answer is {item.attentionValues.map((value) => `"${attentionLabel(item.type, value, item.options)}"`).join(" or ")}.
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-end">
        <div className="flex gap-1">
          <Button type="button" variant="outline" size="sm" onClick={onEdit} disabled={pending}>
            <Pencil /> Edit
          </Button>
          {onMove ? (
            <>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Move question up" onClick={() => onMove("up")} disabled={pending || first}>
                <ArrowUp />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Move question down" onClick={() => onMove("down")} disabled={pending || last}>
                <ArrowDown />
              </Button>
            </>
          ) : null}
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove question" onClick={onRemove} disabled={pending}>
            <Trash2 />
          </Button>
        </div>
        {onToggleAi ? (
          <Checkbox label="Never to AI" checked={item.aiNeverSend} disabled={pending} onChange={(e) => onToggleAi(e.target.checked)} className="text-xs" />
        ) : null}
      </div>
    </li>
  );
}

// Items whose section was removed from the sections list. The editor never
// does this itself, but the data allows it, and publish refuses it.
function OrphanedItems({
  draft,
  pending,
  onEdit,
  onRemoveQuestion,
}: {
  draft: FormSnapshot;
  pending: boolean;
  onEdit: (item: EditorItem) => void;
  onRemoveQuestion: (item: EditorItem) => void;
}) {
  const orphaned = draft.items.filter((item) => !draft.sections.some((section) => section.key === item.sectionKey));
  if (orphaned.length === 0) return null;
  return (
    <Card className="border-amber-300">
      <CardHeader>
        <CardTitle>Questions outside any section</CardTitle>
        <CardDescription>Their section no longer exists. Edit each one to pick a section, or remove it.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="divide-y rounded-md border">
          {orphaned.map((item) => (
            <QuestionRow key={item.questionVersionId} item={item} first last pending={pending} onEdit={() => onEdit(item)} onRemove={() => onRemoveQuestion(item)} />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
