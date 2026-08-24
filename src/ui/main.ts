// Boot. Wires up DOM events that drive the rest of the SPA.

import { startPolling, loadAgents, loadConfig } from "./api.js";
import { applyHashRoute, applyProtocolLaunch } from "./routing.js";
import { render } from "./renderer.js";
import { initPullToRefresh } from "./pull-refresh.js";
import { initSwipeBack } from "./swipe-nav.js";
import { initViewportHeight } from "./viewport.js";
import { ensureServiceWorker, subscribeForPush } from "./notifications.js";
import { reportVisibility } from "./bridge.js";
import { state } from "./state.js";

initViewportHeight();

window.addEventListener("DOMContentLoaded", () => {
  startPolling();
  void loadAgents();
  void loadConfig();
  void ensureServiceWorker();
  // Re-arm the push subscription on reload — the checkbox preference
  // persists in localStorage but PushManager subscriptions don't
  // survive a service worker update/reinstall, so a stale or missing
  // one needs re-establishing rather than assuming last session's
  // subscribe() call is still good.
  if (
    state.notifyOnTurnEnd &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    void subscribeForPush();
  }
  applyProtocolLaunch();
  applyHashRoute();
  render();
  initPullToRefresh();
  initSwipeBack();
});

window.addEventListener("hashchange", () => {
  applyHashRoute();
});

// Keeps the server's per-session visibility registry (ws-bridge.ts)
// current so a turn-end push can be suppressed while this tab is
// actually the one being looked at — see turn-notify-callback.ts.
document.addEventListener("visibilitychange", () => reportVisibility());
window.addEventListener("focus", () => reportVisibility());
window.addEventListener("blur", () => reportVisibility());
