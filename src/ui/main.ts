// Boot. Wires up DOM events that drive the rest of the SPA.

import { startPolling, loadAgents, loadConfig } from "./api.js";
import { applyHashRoute, applyProtocolLaunch, closeChat, forceReconnect } from "./routing.js";
import { render } from "./renderer.js";
import { initPullToRefresh } from "./pull-refresh.js";
import { initSwipeBack } from "./swipe-nav.js";
import { initViewportHeight } from "./viewport.js";
import { ensureServiceWorker, subscribeForPush } from "./notifications.js";
import { reportVisibility } from "./bridge.js";
import { handleListKeydown } from "./views.js";
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

// Connectivity's back (per the OS, via the browser) — don't wait on a
// stale WebSocket to notice on its own. See routing.ts's forceReconnect.
window.addEventListener("online", () => forceReconnect());

// Ctrl-P: same binding as the TUI's session switcher (cli/src/tui/input.ts),
// so muscle memory carries over between the two. Always preventDefault —
// left alone the browser opens its print dialog, which nothing in this
// app ever wants. No-ops on the list view itself; there's nowhere further
// to switch to.
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "p" || !e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  e.preventDefault();
  if (state.view === "chat") {
    closeChat();
  }
});

// Up/Down to move a cursor over the session list, Enter to open it —
// same idea as the TUI's session picker. See views.ts's
// handleListKeydown for the actual logic.
window.addEventListener("keydown", (e) => handleListKeydown(e));
