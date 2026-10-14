import { describe, expect, it } from "vitest";
import { csvCell, escapeFormula, formatPhoneNational, toCsv } from "@/server/services/csv";

describe("CSV writer", () => {
  it("prefixes every formula-starting cell with an apostrophe", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(escapeFormula(`${start}SUM(A1)`)).toBe(`'${start}SUM(A1)`);
      expect(escapeFormula(`  ${start}1`)).toBe(`'  ${start}1`);
    }
    expect(escapeFormula("plain")).toBe("plain");
    expect(escapeFormula("")).toBe("");
    expect(escapeFormula("   ")).toBe("   ");
    expect(escapeFormula("a=b")).toBe("a=b");
  });

  it("quotes every field and doubles embedded quotes, commas and newlines survive", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(true)).toBe('"true"');
    expect(csvCell(-5)).toBe(`"'-5"`);
    expect(csvCell(new Date("2026-11-01T06:00:00Z"))).toBe('"2026-11-01T06:00:00.000Z"');
  });

  it("escapes headers too and ends every line with CRLF", () => {
    const csv = toCsv(
      ["=name", "source_detail"],
      [
        ["Ana", "@everyone"],
        ["Bo", "+1 referral"],
      ],
    );
    expect(csv).toBe(`"'=name","source_detail"\r\n"Ana","'@everyone"\r\n"Bo","'+1 referral"\r\n`);
  });

  it("formats phones nationally so they need no apostrophe", () => {
    expect(formatPhoneNational("+16125550123")).toBe("(612) 555-0123");
    expect(csvCell(formatPhoneNational("+16125550123"))).toBe('"(612) 555-0123"');
    expect(formatPhoneNational(null)).toBe("");
  });
});
