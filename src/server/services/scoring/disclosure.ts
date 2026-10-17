import { and, count, desc, eq, gte, isNotNull, isNull, lt, lte } from "drizzle-orm";
import type { Db } from "@/db";
import { application, appUser, legalTextVersion, role } from "@/db/schema";
import type { Actor } from "../actor";
import { ConfigError } from "../config/errors";
import { currentLegalText, defaultEmployerId, publishLegalText, type LegalTextRow } from "../legal";

// The AI disclosure applicants read on the landing page (DATA_MODEL.md, legal_text_version
// kind ai_disclosure; PLAN.md, Phase 2: "AI disclosure editable as a legal text version").
// The landing page always shows the newest published version, so a new one reaches
// applicants at once, without a question-editor publish. What each applicant saw stays
// provable from two facts: published legal text never changes (trigger) and published_at
// is the moment a version went live on every landing page; and the landing form refuses a
// page that showed an older version than the current one (isCurrentAiDisclosure). So an
// application saw the newest version published at or before it started.

export const MAX_DISCLOSURE_LENGTH = 1000;
const MAX_NOTE_LENGTH = 500;

export type AiDisclosureVersion = {
  id: string;
  version: number;
  // Plain text, shown as one paragraph under the landing notice.
  body: string;
  changeNote: string | null;
  publishedAt: Date;
  publishedBy: string | null;
  // When the next version took over; null for the current one.
  replacedAt: Date | null;
  // Applications started on a landing page while this version was current.
  applicationsStarted: number;
};

export type AiDisclosureOverview = {
  current: AiDisclosureVersion | null;
  // Newest first.
  versions: AiDisclosureVersion[];
};

export async function loadAiDisclosures(db: Db): Promise<AiDisclosureOverview> {
  const employerId = await defaultEmployerId(db);
  const rows = await db
    .select({ row: legalTextVersion, publisherName: appUser.name, publisherEmail: appUser.email })
    .from(legalTextVersion)
    .leftJoin(appUser, eq(appUser.id, legalTextVersion.publishedBy))
    .where(and(eq(legalTextVersion.employerId, employerId), eq(legalTextVersion.kind, "ai_disclosure"), isNotNull(legalTextVersion.publishedAt)))
    .orderBy(desc(legalTextVersion.version));

  const versions: AiDisclosureVersion[] = [];
  let replacedAt: Date | null = null;
  for (const { row, publisherName, publisherEmail } of rows) {
    const publishedAt = row.publishedAt!;
    versions.push({
      id: row.id,
      version: row.version,
      body: row.body,
      changeNote: row.changeNote,
      publishedAt,
      publishedBy: publisherName ?? publisherEmail ?? null,
      replacedAt,
      applicationsStarted: await startedBetween(db, employerId, publishedAt, replacedAt),
    });
    replacedAt = publishedAt;
  }
  return { current: versions[0] ?? null, versions };
}

async function startedBetween(db: Db, employerId: string, from: Date, until: Date | null): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .where(
      and(
        eq(role.employerId, employerId),
        eq(application.origin, "landing"),
        isNull(application.deletedAt),
        gte(application.startedAt, from),
        until ? lt(application.startedAt, until) : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

// Publishes the next version with a note on what changed, through the legal text
// service (audited as legal_text.publish). Applicants see it from their next page load.
export async function publishAiDisclosure(
  db: Db,
  input: { body: string; changeNote: string; actor: Actor; now?: Date },
): Promise<{ id: string; version: number }> {
  const body = input.body.trim();
  const changeNote = input.changeNote.trim();
  if (!body) throw new ConfigError("invalid_input", "Write the notice applicants will read");
  if (body.length > MAX_DISCLOSURE_LENGTH) throw new ConfigError("invalid_input", `Keep the notice under ${MAX_DISCLOSURE_LENGTH} characters`);
  if (!changeNote) throw new ConfigError("invalid_input", "Write a short note on what changed and why");
  if (changeNote.length > MAX_NOTE_LENGTH) throw new ConfigError("invalid_input", `Keep the note under ${MAX_NOTE_LENGTH} characters`);
  const current = await currentLegalText(db, "ai_disclosure");
  if (current?.body === body) throw new ConfigError("invalid_input", "That is the notice applicants see now. Change the wording to publish a new version.");
  const result = await publishLegalText(db, { kind: "ai_disclosure", body, changeNote, actor: input.actor, now: input.now });
  return { id: result.id, version: result.version };
}

// The version live at a moment: the newest published at or before it.
export async function aiDisclosureLiveAt(db: Db, at: Date, employerId?: string): Promise<LegalTextRow | null> {
  const emp = employerId ?? (await defaultEmployerId(db));
  const [row] = await db
    .select()
    .from(legalTextVersion)
    .where(
      and(
        eq(legalTextVersion.employerId, emp),
        eq(legalTextVersion.kind, "ai_disclosure"),
        isNotNull(legalTextVersion.publishedAt),
        lte(legalTextVersion.publishedAt, at),
      ),
    )
    .orderBy(desc(legalTextVersion.version))
    .limit(1);
  return row ?? null;
}

// The version an application's landing page showed. Null for an application staff entered
// or imported (no landing page) and for one started before any version was published.
export async function aiDisclosureForApplication(db: Db, applicationId: string): Promise<LegalTextRow | null> {
  const [app] = await db
    .select({ origin: application.origin, startedAt: application.startedAt, employerId: role.employerId })
    .from(application)
    .innerJoin(role, eq(role.id, application.roleId))
    .where(eq(application.id, applicationId));
  if (!app || app.origin !== "landing") return null;
  return aiDisclosureLiveAt(db, app.startedAt, app.employerId);
}

// For the landing form: whether the version its page showed is still the current one, or
// it showed none and none is published. A stale page is refused and reloaded, so every
// application starts under the version it actually showed.
export async function isCurrentAiDisclosure(db: Db, shownVersionId: string | null, employerId?: string): Promise<boolean> {
  const current = await currentLegalText(db, "ai_disclosure", employerId);
  return (current?.id ?? null) === (shownVersionId || null);
}
