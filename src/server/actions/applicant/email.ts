"use server";

import { suggestEmail } from "@/server/services/landing";

// "Did you mean ana@gmail.com?" for the landing and lost-link forms, computed by
// the landing service so the form and the server agree on what counts as a typo.
export async function suggestEmailAction(email: unknown): Promise<string | null> {
  if (typeof email !== "string" || email.length > 254) return null;
  return suggestEmail(email);
}
