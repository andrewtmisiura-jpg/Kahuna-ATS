// Who performed an action: a signed-in staff member, the applicant through the
// public pages, or the system (cron, webhooks). The actor_type enum deliberately
// has no AI value (DATA_MODEL.md, Enumerations).

export type Actor = { type: "staff"; userId: string } | { type: "applicant" } | { type: "system" };

export const SYSTEM_ACTOR: Actor = { type: "system" };
export const APPLICANT_ACTOR: Actor = { type: "applicant" };

export function staffActor(userId: string): Actor {
  return { type: "staff", userId };
}

// The two columns every log table stores for an actor.
export function actorColumns(actor: Actor): { actorType: Actor["type"]; actorUserId: string | null } {
  return { actorType: actor.type, actorUserId: actor.type === "staff" ? actor.userId : null };
}
