import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { createInterface } from "node:readline";
import { delimiter, join, resolve } from "node:path";
import { paths } from "../util/paths.js";
import { CONF_PATH, readExisting, writeConf } from "./conf-writer.js";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function header(num: number, total: number, title: string): void {
  process.stdout.write(`\n  ${BOLD}[${num}/${total}] ${title}${RESET}\n\n`);
}

function ok(msg: string): void {
  process.stdout.write(`      ${GREEN}✓${RESET} ${msg}\n`);
}

function warn(msg: string): void {
  process.stdout.write(`      ${YELLOW}⚠${RESET} ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`      ${RED}✗ ${msg}${RESET}\n`);
  process.exit(1);
}

function info(msg: string): void {
  process.stdout.write(`      ${msg}\n`);
}

function blank(): void {
  process.stdout.write("\n");
}

async function confirm(label: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reply: string = await new Promise((res) => {
      rl.question(`      ${label} ${hint}: `, res);
    });
    const trimmed = reply.trim().toLowerCase();
    if (!trimmed)
      return defaultYes;
    return trimmed.startsWith("y");
  } finally {
    rl.close();
  }
}

function hasBin(name: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    if (!dir)
      continue;
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, name + ext)))
          return true;
      } catch {
        // not present in this dir; keep looking
      }
    }
  }
  return false;
}

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

interface Prereqs {
  dnsName: string;
  tailscaleIp: string;
}

const TOTAL_STEPS = 4;

function step1Prereqs(): Prereqs {
  header(1, TOTAL_STEPS, "Checking Tailscale");

  if (!hasBin("tailscale")) {
    fail(
      "tailscale not found on PATH. Install it first: https://tailscale.com/download",
    );
  }
  ok("tailscale is installed");

  const result = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(
      `tailscale status failed: ${result.stderr?.trim() || "unknown error"}. Is the daemon running?`,
    );
  }
  let status: TailscaleStatus;
  try {
    status = JSON.parse(result.stdout) as TailscaleStatus;
  } catch {
    fail("Couldn't parse `tailscale status --json` output.");
  }
  if (status.BackendState !== "Running") {
    fail(
      `Tailscale isn't logged in (state: ${status.BackendState ?? "unknown"}). Run \`sudo tailscale up\` first, then re-run this wizard.`,
    );
  }
  const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
  const tailscaleIp = status.Self?.TailscaleIPs?.[0];
  if (!dnsName || !tailscaleIp) {
    fail(
      "Couldn't read this device's MagicDNS name or tailnet IP from `tailscale status`. Is MagicDNS enabled for this tailnet?",
    );
  }
  ok(`Logged in as ${dnsName}`);
  ok(`Tailnet IP: ${tailscaleIp}`);
  return { dnsName, tailscaleIp };
}

function isPermissionError(stderr: string): boolean {
  return /access denied|permission denied|must be root|operator/i.test(stderr);
}

// Tailscale's own wording for this varies ("HTTPS is not enabled for your
// tailnet" from older CLI builds vs. "your Tailscale account does not
// support getting TLS certs" from the control plane) — match both rather
// than one exact string.
function isCertsUnavailableError(stderr: string): boolean {
  return /https is not enabled|does not support getting tls certs/i.test(stderr);
}

function failCertsUnavailable(): never {
  fail(
    "This tailnet doesn't have HTTPS certificates enabled (or your account's plan " +
      "doesn't support them). Enable them at https://login.tailscale.com/admin/dns " +
      "(DNS tab -> HTTPS Certificates); if it's already on, this account/plan may not " +
      "support tailnet TLS certs at all — check https://tailscale.com/kb/1153/enabling-https.",
  );
}

async function step2MintCert(dnsName: string): Promise<{ certPath: string; keyPath: string }> {
  header(2, TOTAL_STEPS, "Minting cert");

  const tlsDir = resolve(paths.home(), "tls");
  mkdirSync(tlsDir, { recursive: true });
  chmodSync(tlsDir, 0o700);
  const certPath = resolve(tlsDir, "cert.pem");
  const keyPath = resolve(tlsDir, "key.pem");
  const certArgs = ["cert", "--cert-file", certPath, "--key-file", keyPath, dnsName];

  info("Requesting cert from Tailscale (network call, can take a few seconds)...");
  const attempt = spawnSync("tailscale", certArgs, { encoding: "utf8" });
  if (attempt.status !== 0) {
    const stderr = attempt.stderr?.trim() ?? "";
    if (isCertsUnavailableError(stderr)) {
      failCertsUnavailable();
    }
    if (!isPermissionError(stderr)) {
      fail(`tailscale cert failed: ${stderr || "unknown error"}`);
    }

    warn("tailscale cert needs elevated access to the local tailscaled socket.");
    info("Fix this permanently: sudo tailscale set --operator=$(whoami)");
    info("Future tailscale commands, including re-runs of this wizard, won't need sudo after that.");
    blank();
    if (!(await confirm("Retry cert generation with sudo now instead?", true))) {
      fail("Run `sudo tailscale set --operator=$(whoami)`, then re-run this wizard.");
    }
    // stdin stays attached to the real terminal so sudo's password prompt
    // still works; stdout/stderr are captured so we can still recognize a
    // certs-unavailable failure instead of just reporting a bare exit code.
    info("Requesting cert via sudo (may prompt for your password, then a network call)...");
    const sudoAttempt = spawnSync("sudo", ["tailscale", ...certArgs], {
      stdio: ["inherit", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (sudoAttempt.status !== 0) {
      const sudoStderr = sudoAttempt.stderr?.trim() ?? "";
      if (sudoStderr)
        process.stderr.write(`      ${sudoStderr}\n`);
      if (isCertsUnavailableError(sudoStderr)) {
        failCertsUnavailable();
      }
      fail(`tailscale cert failed even with sudo (exit ${sudoAttempt.status ?? "?"}).`);
    }
    // tailscale ran as root, so it owns the files it just wrote — the browser
    // server (running as the invoking user) needs to be able to read them.
    const owner = userInfo().username;
    const chownResult = spawnSync("sudo", ["chown", owner, certPath, keyPath], {
      stdio: "inherit",
    });
    if (chownResult.status !== 0) {
      warn(
        `Couldn't chown the cert files to ${owner}. Fix manually: sudo chown ${owner} ${certPath} ${keyPath}`,
      );
    }
  }

  try {
    chmodSync(certPath, 0o600);
    chmodSync(keyPath, 0o600);
  } catch (err) {
    warn(`Couldn't chmod cert files (${(err as Error).message}). Check ownership if HTTPS fails to start.`);
  }
  ok(`Wrote ${certPath}`);
  ok(`Wrote ${keyPath}`);
  info("Tailscale certs are valid ~90 days. Re-run this wizard to renew before expiry.");
  return { certPath, keyPath };
}

function step3WriteConfig(args: {
  dnsName: string;
  tailscaleIp: string;
  certPath: string;
  keyPath: string;
}): number {
  header(3, TOTAL_STEPS, "Writing config");

  const { map } = readExisting(CONF_PATH);
  const existingHosts = (map.get("BROWSER_ALLOWED_HOSTS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const hosts = new Set(existingHosts);
  hosts.add(args.dnsName);

  const port = Number.parseInt(map.get("BROWSER_PORT") ?? "", 10) || 5514;

  writeConf(CONF_PATH, {
    BROWSER_TLS_CERT: args.certPath,
    BROWSER_TLS_KEY: args.keyPath,
    BROWSER_HOST: args.tailscaleIp,
    BROWSER_ALLOWED_HOSTS: Array.from(hosts).join(","),
  });
  ok(`Wrote ${CONF_PATH} (chmod 600)`);
  info(`BROWSER_HOST=${args.tailscaleIp} — bound to the tailnet interface only, not your LAN.`);
  if (map.get("BROWSER_HOST") === "0.0.0.0") {
    warn("Previously bound to 0.0.0.0 (every interface). Narrowed to the tailnet IP.");
  }
  return port;
}

async function step4RestartExtension(): Promise<void> {
  header(4, TOTAL_STEPS, "Apply");

  if (!hasBin("hydra-acp")) {
    info("hydra-acp not found on PATH. Restart hydra-acp-browser manually to apply.");
    return;
  }
  if (!(await confirm("Restart the hydra-acp-browser extension now?", true))) {
    info("Skipped. Apply later with: hydra-acp extensions restart hydra-acp-browser");
    return;
  }
  const result = spawnSync("hydra-acp", ["extensions", "restart", "hydra-acp-browser"], {
    stdio: "inherit",
  });
  if (result.status === 0) {
    ok("Restarted.");
  } else {
    warn(`hydra-acp exited with code ${result.status ?? "?"}. Restart manually if needed.`);
  }
}

export async function runTailscaleSetup(): Promise<void> {
  process.stdout.write(`\n  ${BOLD}hydra-acp-browser tailscale setup${RESET}\n`);

  const { dnsName, tailscaleIp } = step1Prereqs();
  const { certPath, keyPath } = await step2MintCert(dnsName);
  const port = step3WriteConfig({ dnsName, tailscaleIp, certPath, keyPath });
  await step4RestartExtension();

  blank();
  ok("Setup complete.");
  info(`Open: https://${dnsName}:${port}/`);
}
