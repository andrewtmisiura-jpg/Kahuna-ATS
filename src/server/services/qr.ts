import QRCode from "qrcode";

// QR codes for entry codes (DATA_MODEL.md, entry_code): every printed or shared
// code encodes https://<hiring_host>/q/<code>, so a code can be closed without
// reprinting and the short link under the picture is the same address.

export function entryCodeUrl(hiringHost: string, code: string): string {
  return `https://${hiringHost}/q/${code}`;
}

// The address printed under the QR for phones that cannot scan.
export function entryCodeShortUrl(hiringHost: string, code: string): string {
  return `${hiringHost}/q/${code}`;
}

// Medium error correction and a quiet zone of two modules, which print and scan
// well at letter size and on a slide.
const QR_OPTIONS = { errorCorrectionLevel: "M" as const, margin: 2 };

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { ...QR_OPTIONS, type: "svg" });
}

export async function qrPng(text: string, width = 1024): Promise<Buffer> {
  return QRCode.toBuffer(text, { ...QR_OPTIONS, type: "png", width });
}

export function qrFileName(code: string, format: "svg" | "png"): string {
  return `tidepool-qr-${code}.${format}`;
}
