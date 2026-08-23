// Swipe right-to-left on the session list to jump straight back into the
// chat you just backed out of (closeChat() stashes it in
// state.lastSessionId — see routing.ts). Mirrors pull-refresh.ts's
// touch-gesture shape: module-level touch state, document-level
// listeners gated on state.view, and a direction lock so a normal
// vertical list scroll (or a pull-to-refresh pull) is never disturbed.
// Entirely passive — no preventDefault — so unlike pull-refresh this
// can never fight the browser's own scrolling.

import { state } from "./state.js";
import { openChat } from "./routing.js";

const THRESHOLD_PX = 80;
const DIRECTION_LOCK_PX = 12;

let startX: number | null = null;
let startY: number | null = null;
let candidate = false;
let locked = false;
let hint: HTMLElement | null = null;

function ensureHint(): HTMLElement {
  if (hint) return hint;
  hint = document.createElement("div");
  hint.className = "swipe-back-hint";
  document.body.appendChild(hint);
  return hint;
}

function targetLabel(): string {
  const id = state.lastSessionId;
  const session = state.sessions.find((s) => s.sessionId === id);
  if (session?.title) return session.title;
  return id ? id.slice(0, 12) : "";
}

function setHint(dx: number): void {
  const el = ensureHint();
  const progress = Math.min(-dx / THRESHOLD_PX, 1);
  el.textContent = (progress >= 1 ? "↩ Release to open " : "← ") + targetLabel();
  el.style.opacity = progress > 0 ? String(progress) : "0";
  el.style.transform = `translate(${Math.min(-dx, THRESHOLD_PX + 20) * -1}px, -50%)`;
}

function hideHint(): void {
  if (!hint) return;
  hint.style.opacity = "0";
}

function reset(): void {
  startX = null;
  startY = null;
  candidate = false;
  locked = false;
  hideHint();
}

function onTouchStart(e: TouchEvent): void {
  reset();
  if (state.view !== "list" || !state.lastSessionId) return;
  const touch = e.touches[0];
  if (!touch) return;
  startX = touch.clientX;
  startY = touch.clientY;
  candidate = true;
}

function onTouchMove(e: TouchEvent): void {
  if (!candidate || startX === null || startY === null) return;
  const touch = e.touches[0];
  if (!touch) return;
  const dx = touch.clientX - startX;
  const dy = touch.clientY - startY;
  if (!locked) {
    if (Math.abs(dx) < DIRECTION_LOCK_PX && Math.abs(dy) < DIRECTION_LOCK_PX) {
      return;
    }
    // Only lock into the gesture for a clearly horizontal, leftward
    // drag — anything more vertical (or rightward) is a normal list
    // scroll or pull-to-refresh, left completely alone.
    if (Math.abs(dy) > Math.abs(dx) || dx > 0) {
      candidate = false;
      return;
    }
    locked = true;
  }
  setHint(dx);
}

function onTouchEnd(e: TouchEvent): void {
  if (!locked || startX === null) {
    reset();
    return;
  }
  const touch = e.changedTouches[0];
  const dx = touch ? touch.clientX - startX : 0;
  const target = state.lastSessionId;
  if (dx <= -THRESHOLD_PX && target) {
    const session = state.sessions.find((s) => s.sessionId === target);
    if (session) {
      openChat(target, session.status === "cold");
    }
  }
  reset();
}

export function initSwipeBack(): void {
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: true });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });
}
