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
// (deliberately minimal, no-push) worker and its notificationclick
// handler, which is what brings the tab to front on click.

import { state } from "./state.js";
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
