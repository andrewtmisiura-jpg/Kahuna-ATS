import { Badge } from "@/components/ui/badge";
import type { Profile } from "@/server/services/applications/queries";
import { Empty, Section } from "./section";

// Answers with the wording of the question version the applicant saw.
export function AnswersSection({ profile }: { profile: Profile }) {
  const { sections, answers, application } = profile;
  const answered = answers.filter((a) => a.value !== null).length;
  return (
    <Section title="Answers" action={<span className="text-xs font-normal normal-case tracking-normal">form v{application.formVersion}</span>}>
      {answers.length === 0 ? <Empty>No questions on this form.</Empty> : null}
      {answered === 0 && answers.length > 0 ? <Empty>Nothing answered yet.</Empty> : null}
      <div className="grid gap-4">
        {sections.map((section) => {
          const items = answers.filter((a) => a.sectionKey === section.key);
          if (items.length === 0) return null;
          return (
            <div key={section.key}>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{section.title}</p>
              <dl className="grid gap-2">
                {items.map((a) => (
                  <div key={a.questionKey} className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">
                      {a.prompt} <span className="opacity-60">(v{a.version})</span>
                    </dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      {a.value === null ? <span className="text-muted-foreground">not answered</span> : <span className="whitespace-pre-wrap">{a.value}</span>}
                      {a.attention ? (
                        <Badge variant="outline" className="border-amber-400 text-amber-800">
                          attention
                        </Badge>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
