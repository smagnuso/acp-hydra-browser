// Light/dark theme. The actual palette lives entirely in CSS custom
// properties on :root plus a matching html[data-theme="light"] override
// block in index.html (including the highlight.js syntax colors, which
// aren't variable-driven, so they get their own light-mode .hljs rules
// there too) — this module's only job is deciding which one applies and
// keeping it in sync with state.theme / the OS preference.

import { state } from "./state.js";

// Query built fresh inside each function, not hoisted to a module-level
// constant — this module is reachable (via views.ts) from plain-Node
// unit tests that have no `window`/`matchMedia`, and a top-level call
// would throw at import time. Mirrors dom.ts's isWideLayout().
const DARK_QUERY = "(prefers-color-scheme: dark)";

function resolvedTheme(): "light" | "dark" {
  if (state.theme === "system") {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  }
  return state.theme;
}

export function applyTheme(): void {
  const resolved = resolvedTheme();
  document.documentElement.setAttribute("data-theme", resolved);
  // Keeps the PWA status bar / app-switcher chrome matching instead of
  // staying hardcoded dark under a light theme.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "light" ? "#ffffff" : "#0e1116");
}

export function initTheme(): void {
  applyTheme();
  // Only matters while state.theme === "system" — re-resolves live if
  // the OS preference flips (e.g. a sunset-triggered dark mode) without
  // needing a reload.
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });
}
