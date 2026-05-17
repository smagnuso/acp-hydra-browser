import { timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "hb_session";
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function constantTimeKeyMatch(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

interface RateEntry {
  fails: number;
  windowStart: number;
}

// Per-IP rate limiter for failed auth attempts on the browser's own
// /login path. 10 failures in 15 min triggers a temporary block. The
// daemon has its own rate limiter for /v1/auth/login — this one is
// defense in depth for the browser-facing surface.
export class AuthRateLimiter {
  private entries = new Map<string, RateEntry>();
  private readonly maxFails = 10;
  private readonly windowMs = 15 * 60 * 1000;

  isBlocked(ip: string): boolean {
    const e = this.entries.get(ip);
    if (!e) {
      return false;
    }
    if (Date.now() - e.windowStart > this.windowMs) {
      this.entries.delete(ip);
      return false;
    }
    return e.fails >= this.maxFails;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const e = this.entries.get(ip);
    if (!e || now - e.windowStart > this.windowMs) {
      this.entries.set(ip, { fails: 1, windowStart: now });
      return;
    }
    e.fails += 1;
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }
}

export function buildSetCookie(
  value: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function buildClearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k.length > 0) {
      out.set(k, v);
    }
  }
  return out;
}
