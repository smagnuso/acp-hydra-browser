// Boot. Wires up DOM events that drive the rest of the SPA.

import { startPolling, loadAgents } from "./api.js";
import { applyHashRoute } from "./routing.js";
import { render } from "./renderer.js";

window.addEventListener("DOMContentLoaded", () => {
  startPolling();
  void loadAgents();
  applyHashRoute();
  render();
});

window.addEventListener("hashchange", () => {
  applyHashRoute();
});
