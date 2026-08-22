// Boot. Wires up DOM events that drive the rest of the SPA.

import { startPolling, loadAgents, loadConfig } from "./api.js";
import { applyHashRoute } from "./routing.js";
import { render } from "./renderer.js";
import { initPullToRefresh } from "./pull-refresh.js";
import { initViewportHeight } from "./viewport.js";

initViewportHeight();

window.addEventListener("DOMContentLoaded", () => {
  startPolling();
  void loadAgents();
  void loadConfig();
  applyHashRoute();
  render();
  initPullToRefresh();
});

window.addEventListener("hashchange", () => {
  applyHashRoute();
});
