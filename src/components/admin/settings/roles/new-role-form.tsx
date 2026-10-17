"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createRoleAction } from "@/server/actions/admin/roles";
import type { RoleCopyPreview } from "@/server/services/config/roles";
import { CheckboxField, Field, NativeSelect, Notice } from "../fields";
import { roleKeyFrom, TAP } from "./format";

// New role from a template: pick the role to copy, name the new one and give it a key.
// The copy brings the stages, the role's own picklist options and, unless unticked, the
// questions as a draft; the role's page then says what to do next.

export type TemplateRole = { id: string; internalName: string; title: string; preview: RoleCopyPreview | null };

function describeCopy(preview: RoleCopyPreview | null, copyQuestions: boolean): string {
  if (!preview) return "";
  const parts = [`${preview.stages} stage${preview.stages === 1 ? "" : "s"}`];
  if (copyQuestions && preview.form) {
    parts.push(
      `${preview.questions} question${preview.questions === 1 ? "" : "s"} from its ${preview.form.status === "published" ? "live form" : "draft form"} (version ${preview.form.version})`,
    );
  }
  if (preview.picklistOptions > 0) {
    parts.push(`${preview.picklistOptions} picklist option${preview.picklistOptions === 1 ? "" : "s"} only this role uses`);
  }
  return `Copies ${parts.join(", ")}.`;
}

export function NewRoleForm({ templates }: { templates: TemplateRole[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [templateRoleId, setTemplateRoleId] = React.useState(templates[0]?.id ?? "");
  const [title, setTitle] = React.useState("");
  const [internalName, setInternalName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [key, setKey] = React.useState("");
  const [keyTouched, setKeyTouched] = React.useState(false);
  const [copyQuestions, setCopyQuestions] = React.useState(true);
  const template = templates.find((t) => t.id === templateRoleId) ?? null;

  function changeTitle(value: string) {
    setTitle(value);
    if (!nameTouched) {
      setInternalName(value);
      if (!keyTouched) setKey(roleKeyFrom(value));
    }
  }

  function changeName(value: string) {
    setNameTouched(true);
    setInternalName(value);
    if (!keyTouched) setKey(roleKeyFrom(value));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      setError(null);
      const result = await createRoleAction({ templateRoleId, title, internalName, key, copyQuestions });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/admin/settings/roles/${result.data.roleId}?created=1` as Route);
    });
  }

  return (
    <form onSubmit={submit} className="grid max-w-xl gap-4">
      <Field label="Copy from" htmlFor="templateRoleId" hint={describeCopy(template?.preview ?? null, copyQuestions)}>
        <NativeSelect id="templateRoleId" className={TAP} value={templateRoleId} onChange={(e) => setTemplateRoleId(e.target.value)} required>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.internalName}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Job title applicants see" htmlFor="title" hint="On the job page and in messages, for example Gutter Cleaning Technician.">
        <Input id="title" className={TAP} value={title} onChange={(e) => changeTitle(e.target.value)} maxLength={120} required autoFocus />
      </Field>
      <Field label="Name staff see" htmlFor="internalName" hint="In lists and Settings. Usually the same as the title.">
        <Input id="internalName" className={TAP} value={internalName} onChange={(e) => changeName(e.target.value)} maxLength={120} required />
      </Field>
      <Field label="Key" htmlFor="key" hint="Lowercase letters, digits and underscores. Reports group by it, so it never changes.">
        <Input
          id="key"
          className={`${TAP} font-mono`}
          value={key}
          onChange={(e) => {
            setKeyTouched(true);
            setKey(e.target.value);
          }}
          maxLength={40}
          required
        />
      </Field>
      <CheckboxField
        label="Copy the questions"
        hint="They arrive as a draft you edit and publish in Questions. Untick to start with an empty form."
        checked={copyQuestions}
        onChange={(e) => setCopyQuestions(e.target.checked)}
      />
      <Notice>The new role starts with scoring off and no opening. You add an opening on its page next.</Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div>
        <Button type="submit" className={TAP} disabled={pending || !templateRoleId}>
          {pending ? "Creating" : "Create role"}
        </Button>
      </div>
    </form>
  );
}
