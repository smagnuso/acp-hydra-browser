// TEMPORARY diagnostic instrumentation for tracking down a reported
// input-lag bug (iOS Chrome, held-backspace stutter) that's hard to
// capture with live DevTools since the device is unresponsive exactly
// when it happens, and Chrome-for-iOS isn't attachable via Safari's
// remote Web Inspector even though it's WebKit-based. Buffers timing
// data client-side and flushes it to the server so it can be read back
// without an attached debugger. Remove once diagnosed — not meant to
// ship long-term.

interface TraceEntry {
  t: number;
  kind: "stall" | "fn";
  label: string;
  ms: number;
}

const buffer: TraceEntry[] = [];
const MAX_BUFFER = 800;

function push(entry: TraceEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
}

// Wrap a function so calls taking longer than THRESHOLD_MS get logged.
const THRESHOLD_MS = 6;
export function traced<T extends (...args: never[]) => unknown>(
  label: string,
  fn: T,
): T {
  return ((...args: never[]) => {
    const start = performance.now();
    const result = fn(...args);
    const ms = performance.now() - start;
    if (ms >= THRESHOLD_MS) {
      push({ t: start, kind: "fn", label, ms });
    }
    return result;
  }) as T;
}

// Frame-stall detector: the gap between consecutive rAF callbacks.
// Catches a main-thread block regardless of what caused it — native
// browser work, GC, something outside our own instrumented functions —
// not just calls we happened to wrap with traced().
const STALL_THRESHOLD_MS = 50;
let lastFrame = performance.now();
function frameTick(now: number): void {
  const gap = now - lastFrame;
  if (gap >= STALL_THRESHOLD_MS) {
    push({ t: lastFrame, kind: "stall", label: "frame-gap", ms: gap });
  }
  lastFrame = now;
  requestAnimationFrame(frameTick);
}
requestAnimationFrame(frameTick);

function flush(): void {
  if (buffer.length === 0) return;
  const entries = buffer.splice(0, buffer.length);
  void fetch("/api/debug-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries, ua: navigator.userAgent, at: Date.now() }),
  }).catch(() => undefined);
}
setInterval(flush, 3000);
window.addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});
