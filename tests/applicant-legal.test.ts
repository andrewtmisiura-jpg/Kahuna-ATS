import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOSED_LINE, publicStatus, STATUS_SENTENCES } from "@/components/applicant/status-copy";
import { db, sql } from "@/db";
import { auditLog, legalTextVersion } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import {
  currentLegalText,
  publishLegalText,
  renderMarkdown,
  splitConsentText,
  stripLeadingComment,
} from "@/server/services/legal";
import { withRollback } from "./helpers/db";
import { loadAdminId, TEST_ADMIN_EMAIL } from "./helpers/fixtures";

let adminId: string;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  adminId = await loadAdminId(db);
});

afterAll(async () => {
  await sql.end();
});

describe("legal text versions", () => {
  // Published rows are immutable (no delete), so each case runs in a rolled-back
  // transaction and leaves the shared test database as the seed made it.
  it("serves the latest published version and publishing supersedes it with an audit row", async () => {
    await withRollback(db, async (tx) => {
      const v1 = await currentLegalText(tx, "sms_terms");
      expect(v1?.version).toBe(1);

      const result = await publishLegalText(tx, {
        kind: "sms_terms",
        body: "# SMS Terms\n\nNew wording.",
        changeNote: "test",
        actor: { type: "staff", userId: adminId },
      });
      expect(result.version).toBe(2);
      expect(result.previousVersionId).toBe(v1!.id);

      const current = await currentLegalText(tx, "sms_terms");
      expect(current?.id).toBe(result.id);
      expect(current?.publishedBy).toBe(adminId);
      expect(current?.body).toBe("# SMS Terms\n\nNew wording.");

      const [audit] = await tx.select().from(auditLog).where(eq(auditLog.entityId, result.id));
      expect(audit!.action).toBe("legal_text.publish");
      expect(audit!.actorUserId).toBe(adminId);
      expect(audit!.changes).toMatchObject({ kind: "sms_terms", version: { from: 1, to: 2 }, superseded_version_id: v1!.id });

      // The old row stays as it was: consent records may point at it.
      const [old] = await tx.select().from(legalTextVersion).where(eq(legalTextVersion.id, v1!.id));
      expect(old!.publishedAt).not.toBeNull();
    });
  });

  it("publishes the opt-in page under its own kind, added by the applicant migration", async () => {
    await withRollback(db, async (tx) => {
      expect(await currentLegalText(tx, "opt_in_page")).toBeNull();
      const result = await publishLegalText(tx, {
        kind: "opt_in_page",
        body: "# Text messages\n\nHow you opt in.",
        actor: { type: "staff", userId: adminId },
      });
      expect(result.version).toBe(1);
      expect(result.previousVersionId).toBeNull();
      expect((await currentLegalText(tx, "opt_in_page"))?.id).toBe(result.id);
    });
  });

  it("refuses an empty body", async () => {
    await expect(publishLegalText(db, { kind: "privacy_policy", body: "  \n", actor: { type: "system" } })).rejects.toThrow(/empty/);
  });
});

describe("markdown renderer", () => {
  it("renders the structures the content files use", () => {
    const html = renderMarkdown(
      [
        "<!-- builder note -->",
        "# Title",
        "",
        "A **bold** word, `code` and a [link](/privacy) plus [out](https://example.com/x).",
        "Second line.",
        "",
        "## Section",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "| Col A | Col B |",
        "|---|---|",
        "| a | b |",
        "",
        "---",
      ].join("\n"),
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="/privacy">link</a>');
    expect(html).toContain('<a href="https://example.com/x" rel="noopener noreferrer">out</a>');
    expect(html).toContain("plus");
    expect(html).toContain("<br>Second line.");
    expect(html).toContain("<h2>Section</h2>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(html).toContain("<table><thead><tr><th>Col A</th><th>Col B</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>");
    expect(html).toContain("<hr>");
    expect(html).not.toContain("builder note");
  });

  it("never passes HTML or unsafe links through", () => {
    const html = renderMarkdown('Hi <script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](data:text/html,hi) "quoted"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain("&quot;quoted&quot;");
  });

  it("strips the leading comment and splits the consent text in both shapes", () => {
    expect(stripLeadingComment("<!--\nnotes\n-->\n\n# Body")).toBe("# Body");
    const seeded = splitConsentText(
      "Text me my application link and updates about this application (optional). I agree that Kahuna may text me. See our SMS Terms.",
    );
    expect(seeded.label).toBe("Text me my application link and updates about this application (optional)");
    expect(seeded.disclosure).toBe("I agree that Kahuna may text me. See our SMS Terms.");
    const twoParagraphs = splitConsentText(
      "Text me my application link and updates about this application (optional)\n\nBy checking this box, you agree that Kahuna Window Cleaning may send you text messages. See our [SMS Terms](/sms-terms).",
    );
    expect(twoParagraphs.label).toBe("Text me my application link and updates about this application (optional)");
    expect(twoParagraphs.disclosure).toMatch(/^By checking this box/);
  });
});

describe("status page mapping", () => {
  it("maps every public label to its sentence and shows a closed application one fixed line", () => {
    for (const [label, sentence] of Object.entries(STATUS_SENTENCES)) {
      expect(publicStatus({ status: "open", stagePublicLabel: label })).toEqual({ label, sentence, closed: false });
    }
    expect(publicStatus({ status: "hired", stagePublicLabel: "Hired" }).sentence).toBe(STATUS_SENTENCES.Hired);
    // Closed at any stage: the label and sentence never carry the stage or a reason.
    for (const label of ["Received", "Interview", "Background check"]) {
      const view = publicStatus({ status: "closed", stagePublicLabel: label });
      expect(view).toEqual({ label: "Closed", sentence: CLOSED_LINE, closed: true });
      expect(JSON.stringify(view)).not.toContain(label);
    }
    // A renamed or custom stage with an unknown label still gets a plain sentence.
    expect(publicStatus({ status: "open", stagePublicLabel: "Phone screen" }).sentence).toBe("A person on our team reviews every application.");
  });
});
