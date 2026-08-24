// Turn-end notifications for prompts THIS browser tab submitted. Scoped
// to "own" turns only — hydra excludes the originator from turn_complete
// fan-out, so the response to our own session/prompt request (see
// bridge.ts) is the only own-turn-end signal available, and that's also
// exactly the scope we want: a peer-submitted turn finishing isn't
// "browser initiated."
//
// Safari (desktop and iOS) doesn't support the plain `new Notification()`
// constructor called from page script — it requires going through a
// service worker's showNotification(). Chrome/Firefox support both; we
// use the service-worker path unconditionally so the same code works
// everywhere rather than branching per browser. See sw.js for the
// notificationclick handler (shared by both the foreground path below
// and the `push` event handler that fires this same showNotification
// while the app isn't running at all) and its notificationclick
// handler, which is what brings the tab to front on click.
//
// This foreground path only fires while the page is alive and the tab
// is hidden — it can't reach the user once the tab (or, on iOS, the
// installed PWA) is fully closed. subscribeForPush/unsubscribeFromPush
// below cover that case via real Web Push, registered server-side per
// prompt (see ws-bridge.ts's maybeRegisterPush) against the daemon's
// turn-notify webhook.

import { state } from "./state.js";
import { api } from "./api.js";
import type { ChatState } from "./types.js";

let swRegistration: ServiceWorkerRegistration | null = null;

// Also called eagerly from main.ts at boot (not just lazily here when
// notifications are enabled) — Chrome's install-prompt eligibility
// requires an active service worker at page load, not one registered
// later on demand.
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (swRegistration) return swRegistration;
  if (!("serviceWorker" in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    return swRegistration;
  } catch {
    return null;
  }
}

// Called from the settings checkbox when the user turns notifications
// on. Registers the worker and prompts for permission if needed;
// returns whether notifications are actually usable now.
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  const reg = await ensureServiceWorker();
  if (!reg) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

function lastAgentText(c: ChatState): string {
  for (let i = c.log.length - 1; i >= 0; i--) {
    const item = c.log[i]!;
    if (item.kind === "stream" && item.role === "agent" && item.text) {
      return item.text;
    }
  }
  return "";
}

// Notify only when the tab genuinely isn't being looked at — a
// foreground notification while the user is staring at the finished
// turn would just be noise stacked on top of what's already on screen.
function tabIsHidden(): boolean {
  return document.visibilityState !== "visible" || !document.hasFocus();
}

// applicationServerKey wants a raw Uint8Array, not the base64url string
// the server hands back.
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Called after the user turns the "notify" checkbox on and permission
// is granted. Idempotent — PushManager.subscribe() returns the existing
// subscription if one's already active, and the server-side store
// dedupes by endpoint.
export async function subscribeForPush(): Promise<void> {
  const reg = await ensureServiceWorker();
  if (!reg || !("pushManager" in reg)) return;
  try {
    const { publicKey } = await api<{ publicKey: string }>("/api/push/vapid-public-key");
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
  } catch (err) {
    console.warn("push subscribe failed:", err);
  }
}

// Called when the user turns the checkbox off. Tears down the browser's
// own subscription (not just the server-side record) so a stale
// subscription doesn't linger consuming the push service's quota.
export async function unsubscribeFromPush(): Promise<void> {
  const reg = await ensureServiceWorker();
  if (!reg || !("pushManager" in reg)) return;
  try {
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });
  } catch (err) {
    console.warn("push unsubscribe failed:", err);
  }
}

export async function notifyTurnEnded(c: ChatState): Promise<void> {
  if (!state.notifyOnTurnEnd) return;
  if (!tabIsHidden()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  const reg = await ensureServiceWorker();
  if (!reg) return;
  const body = lastAgentText(c).trim().slice(0, 200) || "Turn finished.";
  const title = c.title || "hydra-acp";
  await reg.showNotification(title, {
    body,
    tag: `hydra-acp-turn-${c.sessionId}`,
    data: { url: `/#/session/${encodeURIComponent(c.sessionId)}` },
  });
}
