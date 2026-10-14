import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { LAUNCH_ENTRY_CODES, seedPhase1 } from "@/db/seed";
import { getEmployer } from "@/server/services/config/employer";
import { entryCodeShortUrl, entryCodeUrl, qrFileName, qrPng, qrSvg } from "@/server/services/qr";
import { TEST_ADMIN_EMAIL } from "./helpers/fixtures";

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
});

afterAll(async () => {
  await sql.end();
});

describe("QR codes", () => {
  it("encode https://<hiring_host>/q/<code>", async () => {
    expect(entryCodeUrl("tidepool.kahunawindowcleaning.com", "7KX2QF")).toBe("https://tidepool.kahunawindowcleaning.com/q/7KX2QF");
    expect(entryCodeShortUrl("tidepool.kahunawindowcleaning.com", "7KX2QF")).toBe("tidepool.kahunawindowcleaning.com/q/7KX2QF");
    const employer = await getEmployer(db);
    expect(entryCodeUrl(employer.hiringHost, LAUNCH_ENTRY_CODES.snowRoleQr)).toBe("https://tidepool.kahunawindowcleaning.com/q/SNW26QR");
    expect(qrFileName("SNW26QR", "svg")).toBe("tidepool-qr-SNW26QR.svg");
  });

  it("render as SVG and PNG", async () => {
    const url = entryCodeUrl("tidepool.kahunawindowcleaning.com", "SNW26QR");
    const svg = await qrSvg(url);
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // A different code is a different picture.
    expect(await qrSvg(entryCodeUrl("tidepool.kahunawindowcleaning.com", "SNW26MSG"))).not.toBe(svg);

    const png = await qrPng(url, 256);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR width at bytes 16 to 19, big-endian.
    expect(png.readUInt32BE(16)).toBe(256);
  });
});
