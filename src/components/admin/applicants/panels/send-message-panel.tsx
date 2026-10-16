import type { ProfilePanelProps } from "./types";

// Send a message from the profile (Phase 2, templates): pick a template for this
// application's role, see it filled in, and queue it through the single send function,
// which applies every send rule. Renders nothing until the templates build fills it in.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- a slot the templates build fills in
export async function SendMessagePanel({ applicationId, user, canAct }: ProfilePanelProps) {
  return null;
}
