"use client";

import { Plus, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FormSection, QuestionType, QuestionValidation } from "@/db/schema";
import { addQuestionAction, saveQuestionAction } from "@/server/actions/admin/questions";
import type { EditorItem } from "@/server/services/forms/editor";
import { slugKey } from "@/server/services/forms/keys";
import { sameValidation } from "@/server/services/forms/validation";
import { DoNotAskWarning } from "./do-not-ask-panel";
import { Checkbox, ErrorText, Field, Notice, Radio, Textarea } from "./fields";
import { isChoiceType, isTextType, TYPE_LABELS, TYPE_ORDER } from "./format";

// Add a question or edit one. Editing a published wording asks whether it is
// the same question reworded (a new version in the same lineage) or a new
// question (a new lineage; the old one leaves the draft). Changing only the
// staff-only fields (what to look for, the starting-word check) of a published
// question makes a new version of the same question without asking. Option keys
// are generated once on the server and shown here as fixed labels. The form
// mounts fresh for each question, so its state starts from that question.

export type QuestionDialogMode = { kind: "add"; sectionKey: string } | { kind: "edit"; item: EditorItem };

export function QuestionDialog({
  open,
  onOpenChange,
  roleId,
  formVersionId,
  sections,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roleId: string;
  formVersionId: string;
  sections: FormSection[];
  mode: QuestionDialogMode | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        {open && mode ? (
          <QuestionForm
            key={mode.kind === "edit" ? mode.item.questionVersionId : `add:${mode.sectionKey}`}
            roleId={roleId}
            formVersionId={formVersionId}
            sections={sections}
            mode={mode}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type OptionRow = { id: number; key: string | null; label: string };

let nextOptionId = 1;
const newOption = (key: string | null = null, label = ""): OptionRow => ({ id: nextOptionId++, key, label });

function QuestionForm({
  roleId,
  formVersionId,
  sections,
  mode,
  onClose,
}: {
  roleId: string;
  formVersionId: string;
  sections: FormSection[];
  mode: QuestionDialogMode;
  onClose: () => void;
}) {
  const item = mode.kind === "edit" ? mode.item : null;
  const isEdit = item !== null;
  const published = !!item?.publishedAt;

  const [type, setType] = useState<QuestionType>(item?.type ?? "short_text");
  const [prompt, setPrompt] = useState(item?.prompt ?? "");
  const [help, setHelp] = useState(item?.help ?? "");
  const [options, setOptions] = useState<OptionRow[]>(() => (item?.options ?? []).map((option) => newOption(option.key, option.label)));
  const [min, setMin] = useState(item?.validation?.min !== undefined ? String(item.validation.min) : "");
  const [max, setMax] = useState(item?.validation?.max !== undefined ? String(item.validation.max) : "");
  const [integer, setInteger] = useState(!!item?.validation?.integer);
  const [maxLength, setMaxLength] = useState(item?.validation?.maxLength !== undefined ? String(item.validation.maxLength) : "");
  const [staffGuidance, setStaffGuidance] = useState(item?.staffGuidance ?? "");
  const [startsWith, setStartsWith] = useState(item?.startsWithCheck ?? "");
  const [required, setRequired] = useState(item?.required ?? true);
  const [attention, setAttention] = useState<string[]>(item?.attentionValues ?? []);
  const [sectionKey, setSectionKey] = useState(mode.kind === "add" ? mode.sectionKey : mode.item.sectionKey);
  const [keyInput, setKeyInput] = useState("");
  const [aiNeverSend, setAiNeverSend] = useState(item?.aiNeverSend ?? false);
  const [lineage, setLineage] = useState<"reworded" | "new">("reworded");
  const [meaningChanged, setMeaningChanged] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const choice = isChoiceType(type);

  function changeType(next: QuestionType) {
    setType(next);
    if (isChoiceType(next) && options.length === 0) setOptions([newOption(), newOption()]);
    if (!isChoiceType(next) && next !== "yes_no") setAttention([]);
    if (next === "yes_no") setAttention((values) => values.filter((v) => v === "true" || v === "false"));
  }

  const validation = useMemo<QuestionValidation | null>(() => {
    if (type === "number") {
      const v: QuestionValidation = {};
      if (min.trim() !== "" && Number.isFinite(Number(min))) v.min = Number(min);
      if (max.trim() !== "" && Number.isFinite(Number(max))) v.max = Number(max);
      if (integer) v.integer = true;
      return Object.keys(v).length > 0 ? v : null;
    }
    if (isTextType(type) && maxLength.trim() !== "" && Number(maxLength) > 0) return { maxLength: Math.floor(Number(maxLength)) };
    return null;
  }, [type, min, max, integer, maxLength]);

  const optionPayload = useMemo(() => (choice ? options.map((option) => ({ key: option.key, label: option.label.trim() })) : null), [choice, options]);

  const wordingChanged = useMemo(() => {
    if (!item) return true;
    if (type !== item.type) return true;
    if (prompt.trim() !== item.prompt) return true;
    if ((help.trim() || null) !== (item.help ?? null)) return true;
    const before = JSON.stringify((item.options ?? []).map((o) => ({ key: o.key, label: o.label })));
    const after = JSON.stringify((optionPayload ?? []).map((o) => ({ key: o.key, label: o.label })));
    if (before !== after) return true;
    return !sameValidation(validation, item.validation);
  }, [item, type, prompt, help, optionPayload, validation]);

  const guidancePayload = staffGuidance.trim() || null;
  const startsWithPayload = isTextType(type) ? startsWith.trim() || null : null;
  const staffChanged = !!item && (guidancePayload !== (item.staffGuidance ?? null) || startsWithPayload !== (item.startsWithCheck ?? null));

  const typeChanged = !!item && type !== item.type;
  const askLineage = isEdit && published && wordingChanged;
  // Only the staff-only fields changed: a new version of the same question.
  const staffOnly = isEdit && published && !wordingChanged && staffChanged;
  const effectiveLineage: "reworded" | "new" = typeChanged ? "new" : lineage;
  const matchText = [prompt, help, ...options.map((o) => o.label)].join("\n");
  const suggestedKey = slugKey(prompt) || "question";

  function toggleAttention(value: string, on: boolean) {
    setAttention((values) => (on ? [...new Set([...values, value])] : values.filter((v) => v !== value)));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const content = {
        type,
        prompt,
        help: help.trim() || null,
        options: optionPayload,
        validation,
        required,
        attentionValues: attention,
        staffGuidance: guidancePayload,
        startsWithCheck: startsWithPayload,
      };
      const result =
        mode.kind === "add"
          ? await addQuestionAction({ roleId, formVersionId, sectionKey, key: keyInput.trim() || null, aiNeverSend, ...content })
          : await saveQuestionAction({
              roleId,
              formVersionId,
              questionVersionId: mode.item.questionVersionId,
              sectionKey: sectionKey !== mode.item.sectionKey ? sectionKey : undefined,
              lineage: askLineage ? effectiveLineage : staffOnly ? "reworded" : undefined,
              meaningChanged: (askLineage && effectiveLineage === "reworded") || staffOnly ? meaningChanged : undefined,
              changeNote: changeNote.trim() || null,
              newKey: askLineage && effectiveLineage === "new" ? newKey.trim() || null : null,
              ...content,
            });
      if (!result.ok) setError(result.message);
      else onClose();
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{isEdit ? "Edit question" : "Add question"}</DialogTitle>
        <DialogDescription>
          {isEdit && published
            ? `Version ${item.version} of this question has been published, so a wording change creates a new version.`
            : "This wording has not been published yet, so changes land in place."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Answer type" htmlFor="q-type">
          <Select value={type} onValueChange={(value) => changeType(value as QuestionType)}>
            <SelectTrigger id="q-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_ORDER.map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Section" htmlFor="q-section">
          <Select value={sectionKey} onValueChange={setSectionKey}>
            <SelectTrigger id="q-section" className="w-full">
              <SelectValue placeholder="Pick a section" />
            </SelectTrigger>
            <SelectContent>
              {sections.map((section) => (
                <SelectItem key={section.key} value={section.key}>
                  {section.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Question" htmlFor="q-prompt" hint="Plain words, one thing per question. Applicants read this on a phone.">
        <Textarea id="q-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} required autoFocus />
      </Field>

      <Field label="Help text (optional)" htmlFor="q-help" hint="Shown in smaller print under the question.">
        <Textarea id="q-help" value={help} onChange={(e) => setHelp(e.target.value)} maxLength={2000} className="min-h-14" />
      </Field>

      <DoNotAskWarning text={matchText} />

      {choice ? (
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Choices</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setOptions((rows) => [...rows, newOption()])}>
              <Plus /> Add choice
            </Button>
          </div>
          <ul className="grid gap-2">
            {options.map((option, index) => (
              <li key={option.id} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Input
                    value={option.label}
                    onChange={(e) => setOptions((rows) => rows.map((row) => (row.id === option.id ? { ...row, label: e.target.value } : row)))}
                    placeholder={`Choice ${index + 1}`}
                    maxLength={200}
                    aria-label={`Choice ${index + 1}`}
                    required
                  />
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    <span className="font-mono">{option.key ?? "key made when saved"}</span>
                    <Checkbox
                      label="Flag this answer"
                      checked={option.key ? attention.includes(option.key) : false}
                      disabled={!option.key}
                      onChange={(e) => option.key && toggleAttention(option.key, e.target.checked)}
                      className="text-xs"
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove choice ${index + 1}`}
                  onClick={() => setOptions((rows) => rows.filter((row) => row.id !== option.id))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Each choice gets a key the first time it is saved. Relabel freely; the key stays, so reports keep counting the same answer.
          </p>
        </div>
      ) : null}

      {type === "number" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Lowest allowed" htmlFor="q-min">
            <Input id="q-min" type="number" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
          </Field>
          <Field label="Highest allowed" htmlFor="q-max">
            <Input id="q-max" type="number" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} />
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox label="Whole numbers only" checked={integer} onChange={(e) => setInteger(e.target.checked)} />
          </div>
        </div>
      ) : null}

      {isTextType(type) ? (
        <Field label="Longest answer (characters)" htmlFor="q-maxlength" hint="Leave blank for the usual limit.">
          <Input id="q-maxlength" type="number" inputMode="numeric" min={1} value={maxLength} onChange={(e) => setMaxLength(e.target.value)} className="w-40" />
        </Field>
      ) : null}

      {type === "yes_no" ? (
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">Flag on the profile when the answer is</span>
          <div className="flex gap-4">
            <Checkbox label="Yes" checked={attention.includes("true")} onChange={(e) => toggleAttention("true", e.target.checked)} />
            <Checkbox label="No" checked={attention.includes("false")} onChange={(e) => toggleAttention("false", e.target.checked)} />
          </div>
          <p className="text-xs text-muted-foreground">A flag is only a warning chip for staff. Nothing happens automatically.</p>
        </div>
      ) : null}

      <div className="grid gap-4 rounded-md border border-dashed p-3">
        <Field
          label="What to look for, staff only"
          htmlFor="q-guidance"
          hint="Shown on the profile under the answer, folded away until staff open it. Never shown to applicants and never sent to AI."
        >
          <Textarea id="q-guidance" value={staffGuidance} onChange={(e) => setStaffGuidance(e.target.value)} maxLength={4000} className="min-h-16" />
        </Field>
        {isTextType(type) ? (
          <Field
            label="Answer must start with this word (optional)"
            htmlFor="q-startswith"
            hint="One word. The profile shows whether the answer starts with it, ignoring capitals and punctuation. Leave blank for no check."
          >
            <Input id="q-startswith" value={startsWith} onChange={(e) => setStartsWith(e.target.value)} maxLength={40} className="w-48" />
          </Field>
        ) : null}
      </div>

      <Checkbox label="Required" hint="Checked when the applicant submits, not while they type." checked={required} onChange={(e) => setRequired(e.target.checked)} />

      {!isEdit ? (
        <>
          <Checkbox
            label="Never send to AI"
            hint="Answers stay out of anything sent to the AI scorer, whatever a rubric asks for. Use it when an answer could reveal age, health, family or other protected details."
            checked={aiNeverSend}
            onChange={(e) => setAiNeverSend(e.target.checked)}
          />
          <Field
            label="Report key (optional)"
            htmlFor="q-key"
            hint={`Lowercase letters, digits and underscores. Made from the question if blank: ${suggestedKey}. It never changes afterwards.`}
          >
            <Input id="q-key" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder={suggestedKey} maxLength={64} className="font-mono" />
          </Field>
        </>
      ) : null}

      {askLineage && item ? (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-sm font-medium">The published wording is changing. Same question, reworded, or a new question?</p>
          {typeChanged ? <Notice>Changing the answer type makes this a new question.</Notice> : null}
          <Radio
            name="lineage"
            label="Same question, reworded"
            hint={`Creates version ${item.version + 1} of "${item.key}". Reports keep comparing answers across versions.`}
            checked={effectiveLineage === "reworded"}
            disabled={typeChanged}
            onChange={() => setLineage("reworded")}
          />
          {effectiveLineage === "reworded" ? (
            <Checkbox
              className="ml-6"
              label="The meaning changed"
              hint="Tick this if the new wording asks for something different. Reports stop pooling answers across this version."
              checked={meaningChanged}
              onChange={(e) => setMeaningChanged(e.target.checked)}
            />
          ) : null}
          <Radio
            name="lineage"
            label="A new question"
            hint={`Starts a new question with its own key. "${item.key}" leaves this draft; its past answers stay in reports under the old key.`}
            checked={effectiveLineage === "new"}
            onChange={() => setLineage("new")}
          />
          {effectiveLineage === "new" ? (
            <Field className="ml-6" label="Key for the new question (optional)" htmlFor="q-newkey" hint={`Made from the question if blank: ${suggestedKey}`}>
              <Input id="q-newkey" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder={suggestedKey} maxLength={64} className="font-mono" />
            </Field>
          ) : null}
          <Field label="Note for the record (optional)" htmlFor="q-note">
            <Input id="q-note" value={changeNote} onChange={(e) => setChangeNote(e.target.value)} maxLength={500} />
          </Field>
        </div>
      ) : null}

      {staffOnly && item ? (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-sm">
            Saving creates version {item.version + 1} of &quot;{item.key}&quot;, the same question with new notes for staff. Applicants see the same wording.
          </p>
          <Checkbox
            label="The meaning changed"
            hint="Tick this only if the change means answers should not be compared with earlier versions."
            checked={meaningChanged}
            onChange={(e) => setMeaningChanged(e.target.checked)}
          />
          <Field label="Note for the record (optional)" htmlFor="q-note-staff">
            <Input id="q-note-staff" value={changeNote} onChange={(e) => setChangeNote(e.target.value)} maxLength={500} />
          </Field>
        </div>
      ) : null}

      <ErrorText>{error}</ErrorText>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !prompt.trim() || !sectionKey}>
          {pending ? "Saving..." : isEdit ? "Save" : "Add question"}
        </Button>
      </DialogFooter>
    </form>
  );
}
