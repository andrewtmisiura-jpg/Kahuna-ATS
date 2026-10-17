"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateTemplateAction } from "@/server/actions/admin/templates";
import {
  checkTemplate,
  EDITABLE_PURPOSES,
  fillPlaceholders,
  isEditablePurpose,
  TEMPLATE_VARIABLES,
  textLength,
  variableAllowed,
  withFullClosing,
  type EditablePurpose,
  type TemplateIssue,
  type TemplateVariable,
} from "@/server/services/messaging/template-text";
import type { TemplateItem } from "@/server/services/messaging/templates";
import { Field, Notice, Textarea } from "../fields";
import { CHANNEL_LABELS, PURPOSE_COPY, VARIABLE_HELP } from "./labels";
import { MessageBody, segmentLine } from "./message-body";

// Settings > Message templates: the Phase 2 templates by purpose, text then email, each
// with an editor for Admins (name, subject for emails, message), a live preview with
// sample values, the text's length in segments and the checks from messages.md; then the
// messages that go out on their own, read-only.

type Props = { templates: TemplateItem[]; brand: string; sample: Record<TemplateVariable, string>; canEdit: boolean };

export function TemplatesView({ templates, brand, sample, canEdit }: Props) {
  const system = templates.filter((t) => !t.editable);
  return (
    <div className="grid gap-8">
      <section className="grid gap-6">
        <div>
          <h2 className="text-lg font-semibold">Messages staff send</h2>
          <p className="text-sm text-muted-foreground">
            Every text starts with &quot;{brand}:&quot; and ends with &quot;Reply STOP to opt out.&quot;, uses plain characters only, and gets
            links from placeholders. Staff send these as written; nobody adds to them per send.
          </p>
        </div>
        {EDITABLE_PURPOSES.map((purpose) => {
          const items = templates.filter((t) => t.purpose === purpose);
          return (
            <div key={purpose} className="grid gap-3">
              <div>
                <h3 className="font-semibold">{PURPOSE_COPY[purpose]?.title ?? purpose}</h3>
                <p className="text-sm text-muted-foreground">{PURPOSE_COPY[purpose]?.when}</p>
              </div>
              {items.length === 0 ? <Notice tone="warning">No template on file for this message yet.</Notice> : null}
              {items.map((template) => (
                <TemplateCard key={template.id} template={template} brand={brand} sample={sample} canEdit={canEdit} />
              ))}
            </div>
          );
        })}
      </section>

      {system.length > 0 ? (
        <section>
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">Messages that go out on their own ({system.length})</summary>
            <p className="mt-2 text-sm text-muted-foreground">
              These carry the application link and the opt-in wording, so their wording is fixed. They are here so you know what people receive.
            </p>
            <div className="mt-3 grid gap-3">
              {system.map((template) => (
                <TemplateCard key={template.id} template={template} brand={brand} sample={sample} canEdit={false} />
              ))}
            </div>
          </details>
        </section>
      ) : null}
    </div>
  );
}

function TemplateCard({ template, brand, sample, canEdit }: { template: TemplateItem; brand: string; sample: Record<TemplateVariable, string>; canEdit: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const headingId = React.useId();
  const purpose = template.purpose;
  return (
    <section aria-labelledby={headingId} className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 id={headingId} className="font-medium">
            {template.name}
          </h4>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="secondary">{CHANNEL_LABELS[template.channel]}</Badge>
            {template.roleName ? <Badge variant="outline">{template.roleName} only</Badge> : null}
            {!template.editable ? <Badge variant="outline">Read-only</Badge> : null}
            {!template.editable && PURPOSE_COPY[purpose] ? <span className="text-xs text-muted-foreground">{PURPOSE_COPY[purpose]!.when}</span> : null}
          </div>
        </div>
        {canEdit && template.editable && !editing ? (
          <Button size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </Button>
        ) : null}
      </div>
      {editing && isEditablePurpose(purpose) ? (
        <TemplateEditor template={template} purpose={purpose} brand={brand} sample={sample} onDone={() => setEditing(false)} />
      ) : (
        <div className="mt-3 grid gap-1 text-sm">
          {template.subject ? (
            <p>
              <span className="text-muted-foreground">Subject: </span>
              {template.subject}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2">{template.body}</p>
        </div>
      )}
    </section>
  );
}

function TemplateEditor({
  template,
  purpose,
  brand,
  sample,
  onDone,
}: {
  template: TemplateItem;
  purpose: EditablePurpose;
  brand: string;
  sample: Record<TemplateVariable, string>;
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = React.useState(template.name);
  const [subject, setSubject] = React.useState(template.subject ?? "");
  const [body, setBody] = React.useState(template.body);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const ids = { name: React.useId(), subject: React.useId(), body: React.useId() };
  const sms = template.channel === "sms";

  const check = checkTemplate({ purpose, channel: template.channel, name, subject: sms ? null : subject, body }, { brand, sample });
  const rendered = fillPlaceholders(body, sample);
  const length = sms ? textLength(rendered) : null;
  const firstText = sms ? textLength(withFullClosing(rendered)) : null;
  const changed = name !== template.name || body !== template.body || (!sms && subject !== (template.subject ?? ""));

  // Puts a placeholder where the cursor is in the message.
  function insert(variable: TemplateVariable) {
    const token = `{${variable}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function save() {
    startTransition(async () => {
      setError(null);
      const result = await updateTemplateAction({ templateId: template.id, name, subject: sms ? null : subject, body });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <div className="grid content-start gap-3">
        <Field label="Name" htmlFor={ids.name} hint="Only staff see the name.">
          <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} className="h-11 md:h-9" />
        </Field>
        {!sms ? (
          <Field label="Subject" htmlFor={ids.subject}>
            <Input id={ids.subject} value={subject} onChange={(e) => setSubject(e.target.value)} className="h-11 md:h-9" />
          </Field>
        ) : null}
        <Field label="Message" htmlFor={ids.body} hint="Placeholders in braces are filled in for each person. Tap one below to add it where the cursor is.">
          <Textarea id={ids.body} ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} rows={sms ? 5 : 14} spellCheck />
        </Field>
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">Placeholders</p>
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATE_VARIABLES.filter((v) => variableAllowed(purpose, v)).map((v) => (
              <Button
                key={v}
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11 font-mono text-xs md:min-h-8"
                title={VARIABLE_HELP[v]}
                aria-label={`Add {${v}}: ${VARIABLE_HELP[v]}`}
                onClick={() => insert(v)}
              >
                {`{${v}}`}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid content-start gap-3" aria-live="polite">
        <p className="text-sm font-medium">Preview with sample values</p>
        <div data-testid="template-preview">
          <MessageBody channel={template.channel} subject={sms ? null : fillPlaceholders(subject, sample)} body={rendered} />
        </div>
        {length && firstText ? (
          <p className="text-xs text-muted-foreground">
            {segmentLine(length.characters, length.segments)}. The first text after someone opts in gets the longer closing:{" "}
            {segmentLine(firstText.characters, firstText.segments)}. Each segment costs about a cent.
          </p>
        ) : null}
        <Issues errors={check.errors} warnings={check.warnings} channel={template.channel} />
      </div>

      <div className="grid gap-3 md:col-span-2">
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={save} disabled={pending || !changed || check.errors.length > 0} className="min-h-11 md:min-h-9">
            {pending ? "Saving" : "Save"}
          </Button>
          <Button type="button" variant="outline" onClick={onDone} className="min-h-11 md:min-h-9">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function Issues({ errors, warnings, channel }: { errors: TemplateIssue[]; warnings: TemplateIssue[]; channel: "sms" | "email" }) {
  if (errors.length === 0 && warnings.length === 0) {
    return <Notice>Follows every rule for {channel === "sms" ? "texts" : "emails"}.</Notice>;
  }
  return (
    <div className="grid gap-2">
      {errors.length > 0 ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <p className="font-medium">Fix before saving</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((issue) => (
              <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">Worth a look</p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((issue) => (
              <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
