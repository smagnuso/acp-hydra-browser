// Persisted Web Push state: this install's VAPID key pair (generated
// once, reused forever — regenerating would invalidate every browser's
// existing subscription) and the set of subscriptions registered by
// browsers that turned on turn-end notifications. Single JSON file
// under ~/.hydra-acp/browser/, mirroring the rest of this module's
// persisted state (auth, link file).

import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import webpush from "web-push";
import { paths } from "../util/paths.js";
import { logger } from "../util/log.js";

const log = logger("push-store");

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface PushFile {
  vapid: { publicKey: string; privateKey: string };
  subscriptions: PushSubscriptionJSON[];
}

let cached: PushFile | undefined;

async function load(): Promise<PushFile> {
  if (cached) return cached;
  try {
    const text = await fsp.readFile(paths.pushFile(), "utf8");
    cached = JSON.parse(text) as PushFile;
    return cached;
  } catch {
    const keys = webpush.generateVAPIDKeys();
    cached = { vapid: keys, subscriptions: [] };
    await save();
    return cached;
  }
}

async function save(): Promise<void> {
  if (!cached) return;
  await fsp.mkdir(dirname(paths.pushFile()), { recursive: true, mode: 0o700 });
  await fsp.writeFile(paths.pushFile(), JSON.stringify(cached, null, 2), {
    mode: 0o600,
  });
}

export async function getVapidPublicKey(): Promise<string> {
  return (await load()).vapid.publicKey;
}

// Apple's Web Push (APNs-backed) validates the VAPID JWT's `sub` claim
// strictly and rejects anything without a real-looking domain —
// "mailto:...@localhost" comes back 403 BadJwtToken. example.com is
// reserved for documentation use (RFC 2606) precisely so placeholders
// like this don't need to resolve to anything real.
async function vapidDetails(): Promise<{
  subject: string;
  publicKey: string;
  privateKey: string;
}> {
  const { vapid } = await load();
  return { subject: "mailto:hydra-acp@example.com", ...vapid };
}

export async function addSubscription(sub: PushSubscriptionJSON): Promise<void> {
  const file = await load();
  file.subscriptions = file.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
  file.subscriptions.push(sub);
  await save();
  log.info(`subscribed ${sub.endpoint.slice(0, 60)}… (${file.subscriptions.length} total)`);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const file = await load();
  const before = file.subscriptions.length;
  file.subscriptions = file.subscriptions.filter((s) => s.endpoint !== endpoint);
  if (file.subscriptions.length !== before) {
    await save();
    log.info(`unsubscribed ${endpoint.slice(0, 60)}… (${file.subscriptions.length} total)`);
  }
}

export async function hasSubscriptions(): Promise<boolean> {
  return (await load()).subscriptions.length > 0;
}

// Sends to every registered subscription, pruning any the push service
// reports as gone (404/410 — the user uninstalled, revoked permission,
// or the browser rotated the endpoint). Best-effort: a delivery failure
// for one subscription doesn't block the others.
export async function sendPushToAll(payload: {
  title: string;
  body: string;
  url: string;
  tag: string;
}): Promise<void> {
  const file = await load();
  if (file.subscriptions.length === 0) {
    log.info(`sendPushToAll: no subscriptions, skipping "${payload.title}"`);
    return;
  }
  log.info(`sending push to ${file.subscriptions.length} subscription(s): "${payload.title}" / "${payload.body}"`);
  const details = await vapidDetails();
  const body = JSON.stringify(payload);
  const stale: string[] = [];
  await Promise.all(
    file.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body, { vapidDetails: details });
      } catch (err) {
        const e = err as { statusCode?: number; body?: string; headers?: unknown; message?: string };
        if (e.statusCode === 404 || e.statusCode === 410) {
          stale.push(sub.endpoint);
        } else {
          log.warn(
            `push delivery failed: status=${e.statusCode} body=${e.body} headers=${JSON.stringify(e.headers)} msg=${e.message}`,
          );
        }
      }
    }),
  );
  if (stale.length > 0) {
    file.subscriptions = file.subscriptions.filter((s) => !stale.includes(s.endpoint));
    await save();
  }
}
