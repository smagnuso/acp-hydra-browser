import type { IncomingHttpHeaders } from "node:http";

export interface SecurityContext {
  // Allowed Host header values (lowercased, with port). Defaults always
  // include 127.0.0.1:<port>, [::1]:<port>, and localhost:<port>.
  allowedHosts: Set<string>;
  // Allowed Origin header values (with scheme + host + port).
  allowedOrigins: Set<string>;
}

export function buildSecurityContext(
  host: string,
  port: number,
  scheme: "http" | "https",
  extraHosts: string[],
): SecurityContext {
  const hostsAndPorts = new Set<string>();
  const origins = new Set<string>();
  const portSuffix = `:${port}`;
  const baseHosts = new Set<string>([host, "127.0.0.1", "localhost", "[::1]"]);
  for (const h of baseHosts) {
    hostsAndPorts.add(`${h}${portSuffix}`.toLowerCase());
    origins.add(`${scheme}://${h}${portSuffix}`.toLowerCase());
  }
  for (const h of extraHosts) {
    const trimmed = h.trim();
    if (!trimmed) {
      continue;
    }
    const withPort = trimmed.includes(":") ? trimmed : `${trimmed}${portSuffix}`;
    hostsAndPorts.add(withPort.toLowerCase());
    origins.add(`${scheme}://${withPort}`.toLowerCase());
  }
  return { allowedHosts: hostsAndPorts, allowedOrigins: origins };
}

export function checkHost(
  ctx: SecurityContext,
  headers: IncomingHttpHeaders,
): boolean {
  const host = headers.host;
  if (typeof host !== "string") {
    return false;
  }
  return ctx.allowedHosts.has(host.toLowerCase());
}

export function checkOrigin(
  ctx: SecurityContext,
  headers: IncomingHttpHeaders,
): boolean {
  const origin = headers.origin;
  if (typeof origin !== "string") {
    // Same-origin browser navigations sometimes omit Origin; allow when
    // Sec-Fetch-Site is present and same-origin/none.
    return checkSecFetchSite(headers);
  }
  return ctx.allowedOrigins.has(origin.toLowerCase());
}

export function checkSecFetchSite(headers: IncomingHttpHeaders): boolean {
  const v = headers["sec-fetch-site"];
  if (typeof v !== "string") {
    // Older browsers / non-fetch clients don't send this; fall through.
    return true;
  }
  return v === "same-origin" || v === "none";
}

export function checkStateChanging(
  ctx: SecurityContext,
  headers: IncomingHttpHeaders,
): { ok: true } | { ok: false; reason: string; status: number } {
  if (!checkHost(ctx, headers)) {
    return { ok: false, reason: "host not allowed", status: 421 };
  }
  if (!checkOrigin(ctx, headers)) {
    return { ok: false, reason: "origin not allowed", status: 403 };
  }
  if (!checkSecFetchSite(headers)) {
    return { ok: false, reason: "cross-site request blocked", status: 403 };
  }
  return { ok: true };
}
