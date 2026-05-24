import { readFileSync } from "node:fs";
import { expandHome, paths } from "./util/paths.js";

export interface TlsConfig {
  cert: string;
  key: string;
}

export interface Config {
  browserHost: string;
  browserPort: number;
  tls: TlsConfig | undefined;
  linkFile: string;
  allowedHosts: string[];
  fileMaxBytes: number;
  hydraDaemonUrl: string;
  hydraWsUrl: string;
  // Service token (the long-lived daemon master bearer, injected by hydra
  // as HYDRA_ACP_TOKEN when this runs as an extension). Used only for
  // background/privileged daemon calls — user-attributed traffic carries
  // the per-user session token extracted from the hb_session cookie.
  hydraToken: string;
  // Delay (ms) between receiving session/request_permission from hydra
  // and forwarding it to the browser tab. If session/update
  // permission_resolved (RFD #533) fires within this window — e.g. the
  // auto-approver answers — the request is never forwarded and the UI
  // never sees the prompt. 0 disables (forward immediately, today's
  // behavior).
  permissionDisplayDelayMs: number;
  debug: boolean;
}

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out.set(key, val);
  }
  return out;
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return (
      "wss://" + httpUrl.slice("https://".length).replace(/\/$/, "") + "/acp"
    );
  }
  if (httpUrl.startsWith("http://")) {
    return (
      "ws://" + httpUrl.slice("http://".length).replace(/\/$/, "") + "/acp"
    );
  }
  throw new Error(
    `hydraDaemonUrl must start with http:// or https://: ${httpUrl}`,
  );
}

function bool(map: Map<string, string>, key: string, fallback: boolean): boolean {
  const v = map.get(key);
  if (v === undefined) {
    return fallback;
  }
  return TRUTHY.has(v.toLowerCase());
}

function intVal(
  map: Map<string, string>,
  key: string,
  fallback: number,
): number {
  const v = map.get(key);
  if (v === undefined || v.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function commaList(map: Map<string, string>, key: string): string[] {
  const v = map.get(key);
  if (!v) {
    return [];
  }
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const DEFAULT_DAEMON_PORT = 55514;
export const DEFAULT_BROWSER_PORT = 5514;

export function loadConfig(path: string = paths.configFile()): Config {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Config file is optional; defaults + env vars cover the required keys.
  }
  const map = parseEnvFile(text);

  const hydraDaemonUrl =
    process.env.HYDRA_ACP_DAEMON_URL ??
    map.get("HYDRA_DAEMON_URL") ??
    `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`;
  const hydraToken =
    process.env.HYDRA_ACP_TOKEN ?? map.get("HYDRA_TOKEN") ?? "";
  if (!hydraToken) {
    throw new Error(
      "Missing HYDRA_ACP_TOKEN env var (or HYDRA_TOKEN config key). When run as a hydra extension, hydra injects this automatically; otherwise set it in ~/.hydra-acp/browser.conf.",
    );
  }
  const hydraWsUrl =
    process.env.HYDRA_ACP_WS_URL ??
    map.get("HYDRA_WS_URL") ??
    deriveWsUrl(hydraDaemonUrl);

  const tlsCert = map.get("BROWSER_TLS_CERT");
  const tlsKey = map.get("BROWSER_TLS_KEY");
  let tls: TlsConfig | undefined;
  if (tlsCert && tlsKey) {
    tls = { cert: expandHome(tlsCert), key: expandHome(tlsKey) };
  } else if (tlsCert || tlsKey) {
    throw new Error(
      "BROWSER_TLS_CERT and BROWSER_TLS_KEY must both be set or both omitted.",
    );
  }

  return {
    browserHost: map.get("BROWSER_HOST") ?? "127.0.0.1",
    browserPort: intVal(map, "BROWSER_PORT", DEFAULT_BROWSER_PORT),
    tls,
    linkFile: expandHome(map.get("BROWSER_LINK_FILE") ?? paths.linkFile()),
    allowedHosts: commaList(map, "BROWSER_ALLOWED_HOSTS"),
    fileMaxBytes: intVal(map, "BROWSER_FILE_MAX_BYTES", 256 * 1024),
    hydraDaemonUrl,
    hydraWsUrl,
    hydraToken,
    permissionDisplayDelayMs: intVal(map, "PERMISSION_DELAY_MS", 500),
    debug: bool(map, "DEBUG", false),
  };
}
