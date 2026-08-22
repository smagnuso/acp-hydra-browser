// Pull-to-refresh on the session list. Installed home-screen PWAs don't
// get Chrome's native swipe-to-reload gesture (it's suppressed in
// standalone display mode) and mostly just resume a suspended process
// instead of re-fetching on relaunch, so there's otherwise no way to pick
// up a new server-side build short of force-killing the app from the
// OS task switcher. A full location.reload() also naturally re-runs
// startPolling()/WS setup, so this doubles as "reconnect everything."

import { state } from "./state.js";

const THRESHOLD_PX = 70;
const MAX_PULL_PX = 110;

let startY: number | null = null;
let active = false;
let armed = false;
let indicator: HTMLElement | null = null;

function ensureIndicator(): HTMLElement {
  if (indicator) return indicator;
  indicator = document.createElement("div");
  indicator.className = "pull-refresh";
  document.body.appendChild(indicator);
  return indicator;
}

function setIndicator(dy: number): void {
  const el = ensureIndicator();
  const clamped = Math.max(0, Math.min(dy, MAX_PULL_PX));
  armed = clamped >= THRESHOLD_PX;
  el.style.opacity = clamped > 0 ? String(Math.min(clamped / THRESHOLD_PX, 1)) : "0";
  el.style.transform = `translate(-50%, ${clamped > 0 ? clamped - 32 : -48}px)`;
  el.textContent = armed ? "↑ Release to refresh" : "↓ Pull to refresh";
}

function hideIndicator(): void {
  const el = ensureIndicator();
  el.style.opacity = "0";
  el.style.transform = "translate(-50%, -48px)";
}

function listElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".list");
}

function onTouchStart(e: TouchEvent): void {
  active = false;
  armed = false;
  if (state.view !== "list") return;
  const list = listElement();
  const touch = e.touches[0];
  if (!list || !touch || list.scrollTop > 0 || !list.contains(touch.target as Node)) {
    return;
  }
  startY = touch.clientY;
  active = true;
}

function onTouchMove(e: TouchEvent): void {
  if (!active || startY === null) return;
  const list = listElement();
  const touch = e.touches[0];
  if (!list || !touch) return;
  const dy = touch.clientY - startY;
  if (dy <= 0 || list.scrollTop > 0) {
    hideIndicator();
    armed = false;
    return;
  }
  // We're overriding the browser's own overscroll/bounce for this
  // gesture, so it needs to be an active (non-passive) listener.
  e.preventDefault();
  setIndicator(dy);
}

function onTouchEnd(): void {
  if (active && armed) {
    const el = ensureIndicator();
    el.textContent = "Refreshing…";
    location.reload();
  } else {
    hideIndicator();
  }
  active = false;
  armed = false;
  startY = null;
}

export function initPullToRefresh(): void {
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("touchcancel", onTouchEnd, { passive: true });
}
