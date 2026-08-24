// Turn-end notifications for prompts THIS browser tab submitted, scoped
// to "own" turns only (see ws-bridge.ts's prompt_queue/added matching by
// clientId — a peer-submitted turn finishing isn't "browser initiated").
// Delivered via real Web Push, registered server-side per prompt against
// the daemon's turn-notify webhook (see ws-bridge.ts / turn-notify-callback.ts),
// so it reaches the user even once the tab — or, on iOS, the installed
// PWA — is fully closed, not just backgrounded. The server also skips
// delivery when this tab is the one currently looking at the session
// (session-visibility.ts), which is what tabIsHidden()/reportVisibility
// below feed.
//
// Safari (desktop and iOS) doesn't support the plain `new Notification()`
// constructor called from page script — it requires going through a
// service worker's showNotification(). sw.js's `push` handler is what
// actually renders the notification; see its notificationclick handler
// for bringing the tab to front on click.

import { api } from "./api.js";

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

// Fed to the server (see reportVisibility in bridge.ts) so it can skip
// a push when this tab is the one currently looking at the session.
export function tabIsHidden(): boolean {
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
