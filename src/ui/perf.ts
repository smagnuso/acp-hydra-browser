// Main-thread block diagnostics, readable on a phone.
//
// A blocked main thread freezes scrolling as well as painting, so it's
// distinguishable from a queued repaint — but knowing THAT it blocked
// doesn't say which function did it, and remote-debugging a phone to
// find out is a cable and a desktop away. This records the worst
// offenders in a ring buffer that the options modal can display and
// copy, so the device reports on itself.

interface SlowEntry {
  label: string;
  ms: number;
  at: number;
}

const MAX_ENTRIES = 6;
const SLOW_MS = 120;
const slow: SlowEntry[] = [];

function record(label: string, ms: number): void {
  if (ms < SLOW_MS) return;
  slow.push({ label, ms, at: Date.now() });
  // Keep the worst, not the newest: a single 4s block matters more than
  // six 130ms ones, and the interesting event may be several actions ago
  // by the time anyone opens the modal.
  slow.sort((a, b) => b.ms - a.ms);
  if (slow.length > MAX_ENTRIES) slow.length = MAX_ENTRIES;
}

// Wrap a synchronous call site. Returns whatever fn returns.
export function timed<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    record(label, performance.now() - t0);
  }
}

export async function timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    record(label, performance.now() - t0);
  }
}

// The browser's own view: any task that occupied the main thread long
// enough to be janky, including work we never wrapped (layout, GC,
// IndexedDB commit, the browser's own navigation handling).
export function initPerfObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        record(`longtask/${(e as PerformanceEntry & { name?: string }).name ?? "?"}`, e.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // Not supported (Safari) — the explicit timed() call sites still work.
  }
}

export function describeSlow(): string {
  if (slow.length === 0) return "none >120ms";
  return slow.map((e) => `${e.label} ${Math.round(e.ms)}ms`).join(" | ");
}
