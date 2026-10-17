// Small helpers for Settings > Roles and stages. Keys are only suggested here; the
// services check them.

// "Gutter Cleaning Technician (seasonal)" -> "gutter_cleaning_technician_seasonal"
export function roleKeyFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 40)
    .replace(/_+$/, "");
}

// "Gutter Cleaning 2027" -> "gutter-cleaning-2027"
export function openingKeyFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export const OPENING_STATUS_LABELS: Record<"draft" | "open" | "closed", string> = { draft: "Draft", open: "Open", closed: "Closed" };

// What the applicant status page shows for a stage; the stage editor offers these first.
export const PUBLIC_LABEL_SUGGESTIONS = ["Received", "Under review", "Interview", "Offer", "Background check", "Hired"];

// Phone-sized tap targets, back to the usual height on wider screens.
export const TAP = "h-11 md:h-9";
