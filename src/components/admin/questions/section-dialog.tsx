"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { FormSection } from "@/db/schema";
import { addSectionAction, updateSectionAction } from "@/server/actions/admin/questions";
import { ErrorText, Field, Textarea } from "./fields";

// Add a section or rename one. Sections are labels for the applicant; their
// keys are generated once and never shown as editable. The form inside the
// dialog mounts fresh each time it opens, so its state starts from the props.

export function SectionDialog({
  open,
  onOpenChange,
  roleId,
  formVersionId,
  section,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roleId: string;
  formVersionId: string;
  // Present when renaming.
  section?: FormSection | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <SectionForm key={section?.key ?? "new"} roleId={roleId} formVersionId={formVersionId} section={section ?? null} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SectionForm({
  roleId,
  formVersionId,
  section,
  onClose,
}: {
  roleId: string;
  formVersionId: string;
  section: FormSection | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(section?.title ?? "");
  const [intro, setIntro] = useState(section?.intro ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = section
        ? await updateSectionAction({ roleId, formVersionId, sectionKey: section.key, title, intro })
        : await addSectionAction({ roleId, formVersionId, title, intro });
      if (!result.ok) setError(result.message);
      else onClose();
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{section ? "Rename section" : "Add section"}</DialogTitle>
        <DialogDescription>Applicants see the title and the short intro at the top of the section.</DialogDescription>
      </DialogHeader>
      <Field label="Title" htmlFor="section-title">
        <Input id="section-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoFocus required />
      </Field>
      <Field label="Intro (optional)" htmlFor="section-intro" hint='For example "Skip this section if you have not had a job yet."'>
        <Textarea id="section-intro" value={intro} onChange={(e) => setIntro(e.target.value)} maxLength={500} className="min-h-16" />
      </Field>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !title.trim()}>
          {pending ? "Saving..." : section ? "Save" : "Add section"}
        </Button>
      </DialogFooter>
    </form>
  );
}
