// Service worker. Two jobs: exist so registration.showNotification() is
// available (Safari, desktop and iOS, requires notifications go through
// a service worker rather than the plain `new Notification()`
// constructor), and handle real Web Push deliveries so a turn-end
// notification can reach the user even when the app isn't running at
// all (see notifications.ts's subscribeForPush and the server-side
// turn-notify-callback.ts). No offline caching — the fetch handler
// below is a pure passthrough, kept only because Chrome's install
// prompt won't show without one. Kept as plain JS, not bundled with the
// rest of the app — it must be servable at its own URL for registration
// to work.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Chrome's install-eligibility check wants a fetch handler present,
// even though this worker does no offline caching; without one, the
// install prompt doesn't show. Registering the listener is enough — it
// deliberately does NOT call respondWith, so every request falls
// through to the network exactly as if no service worker existed.
//
// This used to be `event.respondWith(fetch(event.request))`, described
// as a pure passthrough. It isn't: respondWith makes the worker the
// responder, so a rejected fetch becomes a synthetic network-error
// response plus an uncaught rejection in the worker, instead of the
// ordinary failure the caller already handles. Any moment the server
// is briefly unreachable (an extension restart, a dropped tailnet
// link) surfaced as a hard ERR_FAILED and console noise rather than a
// retryable poll error.
self.addEventListener("fetch", () => {});

// Payload shape is whatever turn-notify-callback.ts's sendPushToAll
// sends: { title, body, url, tag }. No push subscription rides through
// here without going through that server-side path first, so the
// shape is trusted rather than re-validated field by field.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload; fall through to the defaults below.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Hydra", {
      body: data.body || "Turn finished.",
      tag: data.tag,
      data: { url: data.url || "/" },
    }),
  );
});

// A notification is owned by the worker, not the page that created it,
// so bringing the tab to front on click has to happen here rather than
// via a plain onclick back in page script.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            if ("navigate" in client) {
              client.navigate(url).catch(() => {});
            }
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
        return undefined;
      }),
  );
});
