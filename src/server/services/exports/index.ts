import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { opening, role } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "../actor";
import { writeAudit } from "../audit";
import { toCsv } from "../csv";
import { centralDate } from "../time";
import {
  openingsDictionary,
  picklistOptionsDictionary,
  questionsDictionary,
  stagesDictionary,
  templatesDictionary,
} from "./dictionary";
import {
  answersLong,
  backgroundChecksLong,
  consentEventsLong,
  entryCodesLong,
  hiresLong,
  messagesLong,
  notesLong,
  offersLong,
  sessionsLong,
  stageEventsLong,
} from "./long";
import {
  ExportError,
  parseDateRange,
  resolveOpening,
  type ExportContext,
  type ExportFilters,
  type ExportTable,
} from "./shared";
import { applicationsWide } from "./wide";

export { ExportError, type ExportFilters } from "./shared";

// The CSV export set (PLAN.md "CSV export set with dictionary files";
// DATA_MODEL.md "CSV export set"). Admin only (the route handler checks), one
// audit_log row per run, every cell formula-escaped by the CSV writer, files
// served as attachments with a dated name.

export type ExportGroup = "opening" | "long" | "dictionary";

export type ExportSummary = {
  name: string;
  label: string;
  description: string;
  group: ExportGroup;
  // The wide export is per opening and refuses to run without one.
  requiresOpening: boolean;
  // Whether the opening filter narrows this export at all.
  acceptsOpening: boolean;
  // What the date range applies to, for the page; null when dates are ignored.
  dateField: string | null;
  // True when the file carries contact details (DATA_MODEL.md, "Contact and free-text columns").
  includesContact: boolean;
};

type ExportDefinition = ExportSummary & { run: (db: Db, ctx: ExportContext) => Promise<ExportTable> };

const definitions: readonly ExportDefinition[] = [
  {
    name: "applications",
    label: "Applications (wide, per opening)",
    description:
      "One row per application: person and contact details, source, entry code, session, status, stage, hold, closed outcome and reason, the first time each milestone was reached, and one column per question version answered.",
    group: "opening",
    requiresOpening: true,
    acceptsOpening: true,
    dateField: "application start date",
    includesContact: true,
    run: applicationsWide,
  },
  {
    name: "answers",
    label: "Answers",
    description: "One row per answer, with the question key and version, the value and option labels.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "application start date",
    includesContact: false,
    run: answersLong,
  },
  {
    name: "stage_events",
    label: "Stage events",
    description: "Every move, close, hold, reopen, contact and void from the event log, with who recorded it and when it happened.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "when the event happened",
    includesContact: false,
    run: stageEventsLong,
  },
  {
    name: "messages",
    label: "Messages",
    description: "Every text and email, in and out: addresses, status, provider and the body as stored. Application links show as a placeholder.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "when the message was created",
    includesContact: true,
    run: messagesLong,
  },
  {
    name: "consent_events",
    label: "Consent events",
    description: "Text opt-ins, declines, opt-outs and START replies, with the legal text version each one saw.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "when the consent event happened",
    includesContact: true,
    run: consentEventsLong,
  },
  {
    name: "sessions",
    label: "Group sessions",
    description: "Each session with its counts and how many applications are attributed to it.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "session date",
    includesContact: false,
    run: sessionsLong,
  },
  {
    name: "entry_codes",
    label: "Entry codes with daily scans",
    description: "Every QR or link code, one row per day it was scanned.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "scan day",
    includesContact: false,
    run: entryCodesLong,
  },
  {
    name: "offers",
    label: "Offers",
    description: "Offer dates, pay, planned start and response.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "offer date",
    includesContact: false,
    run: offersLong,
  },
  {
    name: "background_checks",
    label: "Background checks",
    description: "Type, vendor, status and dates only. Never the report, a reference number or notes.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "when the check was created",
    includesContact: false,
    run: backgroundChecksLong,
  },
  {
    name: "hires",
    label: "Hires",
    description: "One row per hire record: crew, dates, temporary flag, outcome, leave reason and ratings.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "when the hire was recorded",
    includesContact: false,
    run: hiresLong,
  },
  {
    name: "notes",
    label: "Notes",
    description: "Staff notes with their author. Restricted notes are never included.",
    group: "long",
    requiresOpening: false,
    acceptsOpening: true,
    dateField: "when the note was written",
    includesContact: false,
    run: notesLong,
  },
  {
    name: "openings",
    label: "Openings",
    description: "Openings with their role, status, dates, season dates and headcount.",
    group: "dictionary",
    requiresOpening: false,
    acceptsOpening: false,
    dateField: null,
    includesContact: false,
    run: openingsDictionary,
  },
  {
    name: "stages",
    label: "Stages with milestones",
    description: "Every pipeline stage per role with its milestone and order.",
    group: "dictionary",
    requiresOpening: false,
    acceptsOpening: false,
    dateField: null,
    includesContact: false,
    run: stagesDictionary,
  },
  {
    name: "picklist_options",
    label: "Picklist options",
    description: "Reasons, crews and other list options with their keys and labels.",
    group: "dictionary",
    requiresOpening: false,
    acceptsOpening: false,
    dateField: null,
    includesContact: false,
    run: picklistOptionsDictionary,
  },
  {
    name: "questions",
    label: "Questions and versions",
    description: "Every question version with its prompt, type, option keys and labels, and the form versions it appears in.",
    group: "dictionary",
    requiresOpening: false,
    acceptsOpening: false,
    dateField: null,
    includesContact: false,
    run: questionsDictionary,
  },
  {
    name: "templates",
    label: "Message templates",
    description: "The current text of every template by purpose and channel.",
    group: "dictionary",
    requiresOpening: false,
    acceptsOpening: false,
    dateField: null,
    includesContact: false,
    run: templatesDictionary,
  },
];

export const EXPORT_NAMES: readonly string[] = definitions.map((d) => d.name);

function toSummary(def: ExportDefinition): ExportSummary {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    group: def.group,
    requiresOpening: def.requiresOpening,
    acceptsOpening: def.acceptsOpening,
    dateField: def.dateField,
    includesContact: def.includesContact,
  };
}

// The catalog without the run functions, safe to hand to a client component.
export function exportSummaries(): ExportSummary[] {
  return definitions.map(toSummary);
}

export function findExport(name: string): ExportSummary | null {
  const def = definitions.find((d) => d.name === name);
  return def ? toSummary(def) : null;
}

export type ExportFile = {
  name: string;
  filename: string;
  body: string;
  rows: number;
  sha256: string;
  includesContact: boolean;
  auditId: string;
};

export type RunExportInput = { name: string; filters: ExportFilters; actor: Actor; now?: Date };

// Validates the name and filters, builds the file, and writes the audit row
// before the bytes leave the server.
export async function runExport(db: Db, input: RunExportInput): Promise<ExportFile> {
  const def = definitions.find((d) => d.name === input.name);
  if (!def) throw new ExportError("unknown_export", `No export named ${input.name}`);
  const now = input.now ?? new Date();

  const range = def.dateField ? parseDateRange(input.filters) : parseDateRange({});
  const openingRef = def.acceptsOpening ? await resolveOpening(db, input.filters.openingId) : null;
  if (def.requiresOpening && !openingRef) throw new ExportError("opening_required", "Pick an opening for this export");
  const ctx: ExportContext = { filters: input.filters, opening: openingRef, range };

  const table = await def.run(db, ctx);
  const body = toCsv(table.headers, table.rows);
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const filename = exportFilename(def.name, openingRef?.key ?? null, now);

  const auditId = await writeAudit(db, {
    actor: input.actor,
    action: "export.run",
    entityType: "export",
    entityId: uuidv7(),
    changes: {
      export: def.name,
      filters: {
        opening_id: openingRef?.id ?? null,
        opening_key: openingRef?.key ?? null,
        from: range.from,
        to: range.to,
      },
      files: [{ name: filename, rows: table.rows.length, sha256 }],
      includes_contact: def.includesContact,
    },
    occurredAt: now,
  });

  return { name: def.name, filename, body, rows: table.rows.length, sha256, includesContact: def.includesContact, auditId };
}

// tidepool-<export>[-<opening key>]-<Central date>.csv
export function exportFilename(name: string, openingKey: string | null, now: Date): string {
  const parts = ["tidepool", name, openingKey, centralDate(now)].filter((p): p is string => Boolean(p));
  return `${parts.join("-").replace(/[^A-Za-z0-9._-]+/g, "_")}.csv`;
}

export type OpeningChoice = { id: string; key: string; name: string; status: string; roleKey: string };

// The openings offered in the page's filter, newest season first.
export async function listOpeningChoices(db: Db): Promise<OpeningChoice[]> {
  return db
    .select({ id: opening.id, key: opening.key, name: opening.name, status: opening.status, roleKey: role.key })
    .from(opening)
    .innerJoin(role, eq(role.id, opening.roleId))
    .orderBy(asc(role.sortOrder), asc(opening.createdAt));
}
