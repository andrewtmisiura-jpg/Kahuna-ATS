import { headers } from "next/headers";

// The one helper that reads the applicant's address and browser for the consent
// record (DATA_MODEL.md, consent_event.ip): CF-Connecting-IP when the host is
// proxied through Cloudflare, else the forwarded header Railway's edge sets.

const IP_SHAPE = /^[0-9a-fA-F:.]{3,45}$/;

export function clientIpFrom(h: Headers): string | null {
  const candidates = [h.get("cf-connecting-ip"), h.get("x-forwarded-for")?.split(",")[0], h.get("x-real-ip")];
  for (const candidate of candidates) {
    const ip = candidate?.trim();
    if (ip && IP_SHAPE.test(ip)) return ip;
  }
  return null;
}

export async function requestContext(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return { ip: clientIpFrom(h), userAgent: h.get("user-agent")?.slice(0, 500) ?? null };
}
