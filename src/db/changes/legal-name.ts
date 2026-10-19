import { asc, eq, isNull } from "drizzle-orm";
import { employer } from "@/db/schema";
import { DRAFT_MARK } from "@/db/seed/owner-input";
import { writeAudit } from "@/server/services/audit";
import { currentLegalText, publishLegalText, type LegalTextKind } from "@/server/services/legal";
import type { Change } from "./types";

// The owner's legal entity name (Oct 19, 2026). Production was seeded with a DRAFT
// placeholder on the employer row, and the privacy policy and SMS terms went live as
// drafts with "[OWNER INPUT: legal entity name]" in their text. This fills in the name
// and nothing else: the employer row only while it still holds the DRAFT value, and
// each live legal text only while it still shows the placeholder, as a new published
// version so the old wording stays on record. The other OWNER INPUT blanks stay.

export const LEGAL_NAME = "Blue Skies Window Washing, LLC";
export const LEGAL_NAME_PLACEHOLDER = "[OWNER INPUT: legal entity name]";
export const LEGAL_NAME_CHANGE_NOTE = `Filled in the legal entity name (${LEGAL_NAME}); nothing else changed`;

const KINDS: readonly LegalTextKind[] = ["privacy_policy", "sms_terms", "opt_in_page"];

export const legalName: Change = {
  id: "2026-10-19-legal-name",
  description: `Employer and legal texts: fill in the legal entity name, ${LEGAL_NAME}`,
  async run(tx, ctx) {
    const [row] = await tx.select().from(employer).where(isNull(employer.archivedAt)).orderBy(asc(employer.createdAt)).limit(1);
    if (!row) throw new Error("No employer row. Run `pnpm db:seed` first.");

    if (row.legalName.startsWith(DRAFT_MARK)) {
      const now = new Date();
      await tx.update(employer).set({ legalName: LEGAL_NAME, updatedAt: now }).where(eq(employer.id, row.id));
      await writeAudit(tx, {
        actor: ctx.actor,
        action: "employer.legal_name_update",
        entityType: "employer",
        entityId: row.id,
        changes: { legal_name: { from: row.legalName, to: LEGAL_NAME } },
        occurredAt: now,
      });
      ctx.log(`employer legal name set to ${LEGAL_NAME}`);
    } else {
      ctx.log(`employer legal name already "${row.legalName}", left as is`);
    }

    for (const kind of KINDS) {
      const current = await currentLegalText(tx, kind, row.id);
      if (!current) {
        ctx.log(`${kind}: nothing published yet, nothing to fill in`);
        continue;
      }
      if (!current.body.includes(LEGAL_NAME_PLACEHOLDER)) {
        ctx.log(`${kind} v${current.version}: no legal name placeholder, left as is`);
        continue;
      }
      const published = await publishLegalText(tx, {
        kind,
        body: current.body.replaceAll(LEGAL_NAME_PLACEHOLDER, LEGAL_NAME),
        changeNote: LEGAL_NAME_CHANGE_NOTE,
        actor: ctx.actor,
        employerId: row.id,
      });
      ctx.log(`${kind} v${published.version} published with the legal name (was v${current.version})`);
    }
  },
};
