import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { EditorItem, FormSnapshot } from "@/server/services/forms/editor";

// A compact, read-only picture of the form as an applicant would see it on a
// phone: one column, a card per section, a disabled control per question.
// It shares nothing with the applicant pages on purpose. The staff-only fields
// (what to look for, the starting-word check) never appear here, as they never
// appear to applicants.

export function FormPreview({ form }: { form: FormSnapshot }) {
  const bySection = new Map<string, EditorItem[]>();
  for (const item of form.items) {
    const list = bySection.get(item.sectionKey) ?? [];
    list.push(item);
    bySection.set(item.sectionKey, list);
  }
  const orphaned = form.items.filter((item) => !form.sections.some((section) => section.key === item.sectionKey));

  return (
    <div className="mx-auto w-full max-w-md space-y-4">
      <div className="rounded-xl border border-dashed px-4 py-2 text-center text-xs text-muted-foreground">
        Preview of version {form.version}
        {form.status === "draft" ? " (draft, not live)" : form.status === "published" ? " (live)" : " (retired)"}. Nothing here saves.
      </div>
      <h2 className="text-2xl font-semibold tracking-tight">Your application</h2>
      {form.sections.map((section) => (
        <Card key={section.key}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
            {section.intro ? <CardDescription>{section.intro}</CardDescription> : null}
          </CardHeader>
          <CardContent className="space-y-5">
            {(bySection.get(section.key) ?? []).map((item) => (
              <PreviewQuestion key={item.questionVersionId} item={item} />
            ))}
            {(bySection.get(section.key) ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No questions in this section yet.</p> : null}
          </CardContent>
        </Card>
      ))}
      {orphaned.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Questions outside any section</CardTitle>
            <CardDescription>These sit in a section that was removed. Move them before publishing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {orphaned.map((item) => (
              <PreviewQuestion key={item.questionVersionId} item={item} />
            ))}
          </CardContent>
        </Card>
      ) : null}
      <div className="rounded-md bg-primary px-4 py-2 text-center text-sm font-medium text-primary-foreground opacity-60">Submit application</div>
    </div>
  );
}

function PreviewQuestion({ item }: { item: EditorItem }) {
  return (
    <fieldset disabled className="space-y-2">
      <legend className="text-sm font-medium">
        {item.prompt}
        {item.required ? <span className="text-muted-foreground"> *</span> : <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>}
      </legend>
      {item.help ? <p className="text-xs text-muted-foreground">{item.help}</p> : null}
      <PreviewControl item={item} />
    </fieldset>
  );
}

const boxClass = "h-9 w-full rounded-md border border-input bg-muted/30 px-3 text-sm text-muted-foreground flex items-center";

function PreviewControl({ item }: { item: EditorItem }) {
  switch (item.type) {
    case "short_text":
      return <div className={boxClass}>Type your answer</div>;
    case "long_text":
      return <div className={`${boxClass} h-20 items-start py-2`}>Type your answer</div>;
    case "number":
      return (
        <div className={`${boxClass} w-32`}>
          {item.validation?.min !== undefined || item.validation?.max !== undefined
            ? `${item.validation?.min ?? ""} to ${item.validation?.max ?? ""}`.trim()
            : "0"}
        </div>
      );
    case "date":
      return <div className={`${boxClass} w-44`}>mm/dd/yyyy</div>;
    case "yes_no":
      return (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border px-3 py-2 text-center text-sm">Yes</div>
          <div className="rounded-md border px-3 py-2 text-center text-sm">No</div>
        </div>
      );
    case "single_choice":
    case "multi_choice":
      return (
        <ul className="space-y-1.5">
          {(item.options ?? []).map((option) => (
            <li key={option.key} className="flex items-center gap-2 text-sm">
              <span className={`inline-block size-4 border border-input ${item.type === "single_choice" ? "rounded-full" : "rounded-sm"}`} aria-hidden />
              {option.label}
            </li>
          ))}
        </ul>
      );
  }
}
