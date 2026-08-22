// Registration-only service worker. Its sole job is to exist so
// registration.showNotification() is available — Safari (desktop and
// iOS) requires notifications go through a service worker; it doesn't
// support the plain `new Notification()` constructor called from page
// script. See notifications.ts for the page-side half.
//
// No fetch/push handling: this app doesn't do offline caching or real
// Web Push (notifications only fire while the page is alive and asks
// for one), so there's nothing else for this worker to do. Kept as
// plain JS, not bundled with the rest of the app — it must be servable
// at its own URL for registration to work.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
