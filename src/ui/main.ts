// Boot. Wires up DOM events that drive the rest of the SPA.

import { startPolling, loadAgents, loadConfig } from "./api.js";
import { applyHashRoute, applyProtocolLaunch, closeChat, forceReconnect } from "./routing.js";
import { render } from "./renderer.js";
import { initPullToRefresh } from "./pull-refresh.js";
import { initSwipeBack } from "./swipe-nav.js";
import { initViewportHeight } from "./viewport.js";
import { initWideLayoutWatcher, isWideLayout } from "./dom.js";
import { ensureServiceWorker, subscribeForPush } from "./notifications.js";
import { reportPushEndpoint, reportVisibility } from "./bridge.js";
import { handleListKeydown, focusListRail, closeModal, scrollToTurn } from "./views.js";
import { state } from "./state.js";
import { applyFontScale, initTheme } from "./theme.js";

// As early as possible, before the first render() — applying the
// persisted theme after paint would flash the wrong one.
initTheme();
// Before first paint, same as the theme — applying it after would
// visibly reflow the whole app.
applyFontScale();

initViewportHeight();

// Crossing the split-layout breakpoint (dom.ts's isWideLayout) needs a
// re-render even with no state change — it changes how renderApp lays
// out the existing state, not the state itself.
initWideLayoutWatcher(() => render());

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
    void subscribeForPush().then(() => reportPushEndpoint());
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

// Keep the live spinner's elapsed readout ticking through silent
// stretches (a long tool call streams nothing, so no notification would
// otherwise trigger a repaint). render() is rAF-coalesced, throttled,
// and takes the in-place patch path, so an extra call per second while
// a turn is active is cheap; outside a turn this is a no-op.
setInterval(() => {
  if (state.current?.inTurn && state.current.spinner) {
    render();
  }
}, 1000);

// Ctrl-P: same binding as the TUI's session switcher (cli/src/tui/input.ts),
// so muscle memory carries over between the two. Always preventDefault —
// left alone the browser opens its print dialog, which nothing in this
// app ever wants. In split (wide) layout the chat stays open the whole
// time, so this just moves keyboard focus to the rail instead of
// navigating away — narrow mode no-ops on the list view itself, since
// there's nowhere further to switch to.
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "p" || !e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  e.preventDefault();
  if (isWideLayout()) {
    focusListRail();
  } else if (state.view === "chat") {
    closeChat();
  }
});

// Escape closes whatever modal is open (new-session dialog, mode/model
// picker, options) — covers every kind generically since closeModal()
// just clears state.modal. Skipped while the session-create dialog is
// mid-submit (m.busy), matching its own Cancel button's disabled state
// — Escape shouldn't be able to do something the button itself refuses.
// Registered before handleListKeydown below so a modal takes priority
// over the list's own Escape handling while both could otherwise apply.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !state.modal) return;
  // The session dialog used to be exempt while busy, on the theory that
  // Escape shouldn't do what its own disabled Cancel button refuses. But
  // a create that never settles then had no exit at all — see
  // createSession's timeout and its now always-enabled Cancel.
  e.preventDefault();
  // stopImmediatePropagation, not stopPropagation: handleListKeydown
  // below is a SIBLING listener on this same window target (a separate
  // addEventListener call, not a descendant element), so plain
  // stopPropagation wouldn't stop it from also firing on this same
  // keypress — only stopImmediatePropagation skips other listeners
  // registered on the same target. Without it, handleListKeydown's own
  // (unrelated) Escape behavior would additionally fire — e.g. narrow
  // mode's "jump into lastSessionId" navigating away at the same moment
  // the modal closes.
  e.stopImmediatePropagation();
  closeModal();
});

// Up/Down to move a cursor over the session list, Enter to open it —
// same idea as the TUI's session picker. See views.ts's
// handleListKeydown for the actual logic.
window.addEventListener("keydown", (e) => handleListKeydown(e));

// PageUp/PageDown to page through chat history. Without this they're
// dead keys in the chat view: body is position:fixed and #app/.chat are
// overflow:hidden (see AGENTS.md's scroll-chaining gotcha), so there's
// no ancestor for the browser's own "scroll nearest scrollable
// container" default to find, even with the composer focused. Skipped
// when focus is in a textarea that's actually overflowing (the queue
// chip's inline prompt editor, given a long enough prompt) so paging
// there scrolls within the field instead of yanking focus-owner
// expectations out from under it — the composer itself is deliberately
// NOT exempted here, since desktop auto-focuses it (views.ts) and it's
// essentially never tall enough to have its own scrollable content.
window.addEventListener("keydown", (e) => {
  if (e.key !== "PageUp" && e.key !== "PageDown") return;
  if (state.view !== "chat") return;
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.scrollHeight > active.clientHeight) {
    return;
  }
  const chatBody = document.querySelector<HTMLElement>(".chat-body");
  if (!chatBody) return;
  e.preventDefault();
  // Cmd (Mac) or Ctrl (everywhere else) turns the same keys into a
  // by-turn jump instead of a by-screen page — see views.ts's
  // scrollToTurn for the TUI parity this mirrors.
  if (e.metaKey || e.ctrlKey) {
    scrollToTurn(e.key === "PageDown" ? "next" : "prev");
    return;
  }
  const delta = chatBody.clientHeight * 0.9;
  chatBody.scrollBy({ top: e.key === "PageDown" ? delta : -delta, behavior: "smooth" });
});
