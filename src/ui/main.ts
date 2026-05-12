// Boot. Wires up DOM events that drive the rest of the SPA.

import { startPolling, loadAgents, loadConfig } from "./api.js";
import { applyHashRoute } from "./routing.js";
import { render } from "./renderer.js";

window.addEventListener("DOMContentLoaded", () => {
  startPolling();
  void loadAgents();
  void loadConfig();
  applyHashRoute();
  render();
});

window.addEventListener("hashchange", () => {
  applyHashRoute();
});
