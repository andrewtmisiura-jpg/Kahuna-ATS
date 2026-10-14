import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { employer, legalTextKindEnum, legalTextVersion } from "@/db/schema";
import { uuidv7 } from "@/lib/uuid";
import type { Actor } from "./actor";
import { writeAudit } from "./audit";

// Versioned legal text (DATA_MODEL.md, legal_text_version): the current text of a
// kind is its latest published version for the employer; publishing creates the
// next version and the previous one is superseded (rows are immutable, so there
// is no status column to flip). The public pages render the Markdown body with
// the small renderer below, which never passes HTML through.

export type LegalTextKind = (typeof legalTextVersion.$inferSelect)["kind"];

export const LEGAL_TEXT_KINDS: readonly LegalTextKind[] = legalTextKindEnum.enumValues;

export function isLegalTextKind(value: string): value is LegalTextKind {
  return (LEGAL_TEXT_KINDS as readonly string[]).includes(value);
}

export type LegalTextRow = typeof legalTextVersion.$inferSelect;

// Phase 1 has one employer; the first non-archived row is it.
export async function defaultEmployerId(db: Db): Promise<string> {
  const [row] = await db
    .select({ id: employer.id })
    .from(employer)
    .where(isNull(employer.archivedAt))
    .orderBy(asc(employer.createdAt))
    .limit(1);
  if (!row) throw new Error("No employer row; run the seed first");
  return row.id;
}

// The latest published version of a kind, or null when nothing is published yet.
export async function currentLegalText(db: Db, kind: LegalTextKind, employerId?: string): Promise<LegalTextRow | null> {
  const emp = employerId ?? (await defaultEmployerId(db));
  const [row] = await db
    .select()
    .from(legalTextVersion)
    .where(and(eq(legalTextVersion.employerId, emp), eq(legalTextVersion.kind, kind), isNotNull(legalTextVersion.publishedAt)))
    .orderBy(desc(legalTextVersion.version))
    .limit(1);
  return row ?? null;
}

export async function legalTextById(db: Db, id: string): Promise<LegalTextRow | null> {
  const [row] = await db.select().from(legalTextVersion).where(eq(legalTextVersion.id, id)).limit(1);
  return row ?? null;
}

export type PublishLegalTextInput = {
  kind: LegalTextKind;
  body: string;
  changeNote?: string | null;
  actor: Actor;
  employerId?: string;
  now?: Date;
};

export type PublishLegalTextResult = { id: string; version: number; previousVersionId: string | null };

// Creates and publishes the next version in one transaction and writes an audit row
// naming the version it supersedes.
export async function publishLegalText(db: Db, input: PublishLegalTextInput): Promise<PublishLegalTextResult> {
  const body = input.body.trim();
  if (!body) throw new Error("The legal text body is empty");
  return db.transaction(async (tx) => {
    const now = input.now ?? new Date();
    const employerId = input.employerId ?? (await defaultEmployerId(tx));
    // Serialises two publishes of the same kind.
    await tx.select({ id: employer.id }).from(employer).where(eq(employer.id, employerId)).for("update");
    const previous = await currentLegalText(tx, input.kind, employerId);
    const [latest] = await tx
      .select({ max: sql<number>`coalesce(max(${legalTextVersion.version}), 0)::int` })
      .from(legalTextVersion)
      .where(and(eq(legalTextVersion.employerId, employerId), eq(legalTextVersion.kind, input.kind)));
    const version = (latest?.max ?? 0) + 1;
    const id = uuidv7();
    await tx.insert(legalTextVersion).values({
      id,
      employerId,
      kind: input.kind,
      version,
      body,
      changeNote: input.changeNote ?? null,
      publishedAt: now,
      publishedBy: input.actor.type === "staff" ? input.actor.userId : null,
      createdAt: now,
    });
    await writeAudit(tx, {
      actor: input.actor,
      action: "legal_text.publish",
      entityType: "legal_text_version",
      entityId: id,
      changes: {
        kind: input.kind,
        version: { from: previous?.version ?? null, to: version },
        superseded_version_id: previous?.id ?? null,
        change_note: input.changeNote ?? null,
      },
      occurredAt: now,
    });
    return { id, version, previousVersionId: previous?.id ?? null };
  });
}

// The builder's HTML comment at the top of the content files is not part of the text.
export function stripLeadingComment(markdown: string): string {
  return markdown.replace(/^﻿?\s*<!--[\s\S]*?-->\s*/, "").trim();
}

// The consent block on the landing form: the first paragraph is the checkbox label,
// the rest is the disclosure under it. The seeded v1 is one paragraph whose label
// ends at "(optional)", so that shape splits there.
export function splitConsentText(body: string): { label: string; disclosure: string } {
  const text = body.trim();
  const gap = text.search(/\n\s*\n/);
  if (gap > 0) return { label: text.slice(0, gap).trim(), disclosure: text.slice(gap).trim() };
  const marker = text.indexOf("(optional)");
  if (marker > 0) {
    const end = marker + "(optional)".length;
    return { label: text.slice(0, end).trim(), disclosure: text.slice(end).replace(/^[.\s]+/, "").trim() };
  }
  return { label: text, disclosure: "" };
}

// ---------------------------------------------------------------------------
// Markdown to HTML, the small safe way: every character of text is escaped, raw
// HTML never passes through, and a link survives only with an http(s), mailto or
// site-relative address. Supports what the content files use: headings, paragraphs,
// bold, inline code, links, bullet and numbered lists, blockquotes, tables and rules.

export function renderMarkdown(markdown: string): string {
  const lines = stripLeadingComment(markdown).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (line.startsWith(">")) {
      const inner: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        inner.push(lines[i]!.replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(inner.join("\n"))}</blockquote>`);
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const header = splitCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(splitCells(lines[i]!));
        i += 1;
      }
      const head = `<thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`;
      const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("");
      out.push(`<table>${head}<tbody>${body}</tbody></table>`);
      continue;
    }

    const listMatch = /^(\s*)([-*]|\d+[.)])\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!item || /\d/.test(item[2]!) !== ordered) break;
        const parts = [item[3]!];
        i += 1;
        // Continuation lines indented under the item, including nested quotes.
        while (i < lines.length && lines[i]!.trim() !== "" && /^\s{2,}/.test(lines[i]!) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)) {
          parts.push(lines[i]!.trim());
          i += 1;
        }
        // A blank line followed by an indented block still belongs to the item.
        while (i + 1 < lines.length && lines[i]!.trim() === "" && /^\s{2,}\S/.test(lines[i + 1]!) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i + 1]!)) {
          i += 1;
          const block: string[] = [];
          while (i < lines.length && lines[i]!.trim() !== "" && /^\s{2,}/.test(lines[i]!)) {
            block.push(lines[i]!.replace(/^\s{2,}/, ""));
            i += 1;
          }
          parts.push(`\n${renderMarkdown(block.join("\n"))}`);
        }
        items.push(`<li>${parts.map((p) => (p.startsWith("\n") ? p.slice(1) : inline(p))).join(" ")}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !startsBlock(lines[i]!)) {
      paragraph.push(lines[i]!.trim());
      i += 1;
    }
    out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}

function startsBlock(line: string): boolean {
  return /^(#{1,4}\s|>|(-{3,}|\*{3,}|_{3,})\s*$|\s*([-*]|\d+[.)])\s+)/.test(line) || isTableRow(line);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

function isTableSeparator(line: string): boolean {
  return isTableRow(line) && /^\|(\s*:?-+:?\s*\|)+$/.test(line.trim());
}

function splitCells(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const SAFE_HREF = /^(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*|mailto:[^\s"'<>]+|#[^\s"'<>]*)$/;

// Inline marks on already-escaped text: links, bold, inline code.
function inline(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    if (!SAFE_HREF.test(href)) return match;
    const external = href.startsWith("http");
    return `<a href="${href}"${external ? ' rel="noopener noreferrer"' : ""}>${label}</a>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html;
}
