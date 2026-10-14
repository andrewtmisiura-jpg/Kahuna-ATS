import { Badge } from "@/components/ui/badge";
import type { EditorItem, FormSnapshot } from "@/server/services/forms/editor";
import { attentionLabel, TYPE_LABELS } from "./format";

// The read-only staff view of a form version: sections and their questions with
// the facts that matter for reports (key, version, type, required, never to AI).

export function FormView({ form }: { form: FormSnapshot }) {
  const bySection = new Map<string, EditorItem[]>();
  for (const item of form.items) {
    const list = bySection.get(item.sectionKey) ?? [];
    list.push(item);
    bySection.set(item.sectionKey, list);
  }
  return (
    <div className="space-y-6">
      {form.sections.map((section) => (
        <section key={section.key}>
          <h3 className="text-sm font-semibold">
            {section.title} <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">{section.key}</span>
          </h3>
          {section.intro ? <p className="text-xs text-muted-foreground">{section.intro}</p> : null}
          <ol className="mt-2 divide-y rounded-md border">
            {(bySection.get(section.key) ?? []).map((item) => (
              <li key={item.questionVersionId} className="px-3 py-2">
                <QuestionFacts item={item} />
              </li>
            ))}
            {(bySection.get(section.key) ?? []).length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">No questions.</li> : null}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function QuestionFacts({ item }: { item: EditorItem }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-mono text-muted-foreground">{item.key}</span>
        <Badge variant="outline">{TYPE_LABELS[item.type]}</Badge>
        <Badge variant="outline">v{item.version}</Badge>
        {item.required ? <Badge variant="secondary">Required</Badge> : null}
        {item.aiNeverSend ? <Badge variant="secondary">Never to AI</Badge> : null}
        {item.meaningChanged ? <Badge variant="outline">Meaning changed in v{item.version}</Badge> : null}
      </div>
      <p className="text-sm">{item.prompt}</p>
      {item.help ? <p className="text-xs text-muted-foreground">{item.help}</p> : null}
      {item.options ? (
        <p className="text-xs text-muted-foreground">
          {item.options.map((option) => option.label).join(" / ")}
        </p>
      ) : null}
      {item.attentionValues?.length ? (
        <p className="text-xs text-muted-foreground">
          Flags on the profile when the answer is {item.attentionValues.map((value) => `"${attentionLabel(item.type, value, item.options)}"`).join(" or ")}.
        </p>
      ) : null}
    </div>
  );
}
