// Boot. Wires up DOM events that drive the rest of the SPA.

import { startPolling, loadAgents, loadConfig } from "./api.js";
import { applyHashRoute, applyProtocolLaunch } from "./routing.js";
import { render } from "./renderer.js";
import { initPullToRefresh } from "./pull-refresh.js";
import { initSwipeBack } from "./swipe-nav.js";
import { initViewportHeight } from "./viewport.js";
import { ensureServiceWorker } from "./notifications.js";

initViewportHeight();

window.addEventListener("DOMContentLoaded", () => {
  startPolling();
  void loadAgents();
  void loadConfig();
  void ensureServiceWorker();
  applyProtocolLaunch();
  applyHashRoute();
  render();
  initPullToRefresh();
  initSwipeBack();
});

window.addEventListener("hashchange", () => {
  applyHashRoute();
});
