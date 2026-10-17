import { db } from "@/db";
import { loadSendOptions } from "@/server/services/messaging/staff-sends";
import { STAFF_SEND_PURPOSES } from "@/server/services/messaging/template-text";
import { Section } from "../section";
import { SendMessageDialog } from "./send-message-dialog";
import type { ProfilePanelProps } from "./types";

// Send a message from the profile (Phase 2, templates): pick the one-on-one invite, a
// status update or the decline, see it filled in with this person's values, and queue it
// through the single send function, which applies every send rule. The channel is chosen
// for them (send rules: a text with a current opt-in, otherwise email). Hiring Managers
// and Admins only; Viewers see nothing here.
export async function SendMessagePanel({ applicationId, canAct }: ProfilePanelProps) {
  if (!canAct) return null;
  const options = await loadSendOptions(db, applicationId, STAFF_SEND_PURPOSES);
  if (!options) return null;
  return (
    <Section title="Send a message">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">The invite, a status update or the decline, as the template says.</p>
        <SendMessageDialog applicationId={applicationId} options={options} />
      </div>
    </Section>
  );
}
