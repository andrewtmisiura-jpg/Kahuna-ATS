// Values DATA_MODEL.md marks OWNER INPUT. Each one is either the owner's approved
// value or a clearly marked DRAFT placeholder. Replace the placeholders here before
// the production seed runs; after that these fields change through Settings.
// ADMIN_EMAIL is the one owner input read from the environment instead.

export const DRAFT_MARK = "DRAFT";

export const ownerInput = {
  employer: {
    // Exactly as on the IRS EIN letter (the carrier registration must match). Owner, Oct 19.
    legalName: "Blue Skies Window Washing, LLC",
    websiteUrl: null as string | null,
    // On the domain Resend already verifies for REEF or Typhoon.
    emailFromAddress: "hiring@kahunawindowcleaning.com" as string | null,
    // Where applicant replies go: Brea's inbox (owner, Oct 15).
    replyToAddress: "lavignebreanna1@gmail.com" as string | null,
    hiringEmail: null as string | null,
  },
  snow: {
    // Launch date; the opening is open from the seed through go-live.
    opensOn: "2026-10-23",
    payText: "Starts at $20 an hour",
    // No benefits listed (owner, Oct 15); the landing page hides the line when null.
    benefitsText: null as string | null,
    seasonStartOn: null as string | null,
    seasonEndOn: null as string | null,
    targetHeadcount: null as number | null,
  },
  window: {
    // Everything stays null until the owner provides it before the window opening opens.
    payText: null as string | null,
    benefitsText: null as string | null,
    opensOn: null as string | null,
    seasonStartOn: null as string | null,
    seasonEndOn: null as string | null,
    targetHeadcount: null as number | null,
  },
};

// Every string value still carrying the DRAFT mark, for the seed's warning.
export function draftValues(): string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string" && value.startsWith(DRAFT_MARK)) found.push(path);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    }
  };
  walk(ownerInput, "ownerInput");
  return found;
}
