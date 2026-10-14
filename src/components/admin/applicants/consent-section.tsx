import type { ProfileConsent } from "@/server/services/applications/queries";
import { CONSENT_ACTION_LABELS, CONSENT_METHOD_LABELS, formatDateTime, formatMobile } from "./format";
import { Empty, Section } from "./section";

export function ConsentSection({ consents }: { consents: ProfileConsent[] }) {
  return (
    <Section title="Text consent">
      {consents.length === 0 ? <Empty>No consent records.</Empty> : null}
      <ul className="grid gap-1.5">
        {consents.map((c) => (
          <li key={c.id} className="text-sm">
            <span className="font-medium">{CONSENT_ACTION_LABELS[c.action] ?? c.action}</span>{" "}
            <span className="text-muted-foreground">
              {formatMobile(c.address)}, {CONSENT_METHOD_LABELS[c.method] ?? c.method}
              {c.recordedByName ? ` (${c.recordedByName})` : ""}, {formatDateTime(c.occurredAt)}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
