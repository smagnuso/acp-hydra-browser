// Tracks whether any currently-open browser WS connection is actively
// looking at a given session, so turn-notify-callback.ts can skip a
// push when the answer is already on screen. Kept as its own module
// (rather than living in ws-bridge.ts) because turn-notify-callback.ts
// needs to read it and ws-bridge.ts needs to write it — importing
// ws-bridge.ts from turn-notify-callback.ts would be circular, since
// ws-bridge.ts already imports registerForPush from there.

const visibleConnections = new Map<string, Set<symbol>>();

export function setConnectionVisible(sessionId: string, connId: symbol, visible: boolean): void {
  const existing = visibleConnections.get(sessionId);
  if (visible) {
    if (existing) {
      existing.add(connId);
    } else {
      visibleConnections.set(sessionId, new Set([connId]));
    }
    return;
  }
  if (!existing) return;
  existing.delete(connId);
  if (existing.size === 0) {
    visibleConnections.delete(sessionId);
  }
}

export function clearConnection(sessionId: string, connId: symbol): void {
  setConnectionVisible(sessionId, connId, false);
}

export function isSessionVisible(sessionId: string): boolean {
  const set = visibleConnections.get(sessionId);
  return !!set && set.size > 0;
}
