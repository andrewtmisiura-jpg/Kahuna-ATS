import { Badge } from "@/components/ui/badge";
import type { Profile } from "@/server/services/applications/queries";
import { STARTS_WITH_LABELS } from "@/server/services/forms/starts-with";
import { GuidanceToggle } from "./guidance-toggle";
import { Empty, Section } from "./section";

// Answers with the wording of the question version the applicant saw. A question
// with staff notes gets a folded "What to look for"; one with a starting-word
// check shows whether the answer followed the instruction.
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
                      {a.startsWith ? (
                        <Badge
                          variant="outline"
                          className={a.startsWith === "pass" ? "border-emerald-500 text-emerald-800 dark:text-emerald-200" : "border-amber-400 text-amber-800 dark:text-amber-200"}
                        >
                          {STARTS_WITH_LABELS[a.startsWith]}
                        </Badge>
                      ) : null}
                      {a.staffGuidance ? (
                        <div className="basis-full">
                          <GuidanceToggle guidance={a.staffGuidance} />
                        </div>
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
