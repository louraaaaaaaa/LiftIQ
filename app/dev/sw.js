// Dev channel: the "liftiq-dev-" prefix can never match the stable app's "liftiq-app-" caches,
// and activate() only ever deletes caches that carry this channel's own prefix. The release
// tool rewrites both constants (prefix "liftiq-app-") when it builds the stable app.
const CACHE_PREFIX = "liftiq-dev-";
const CACHE_NAME = "liftiq-dev-v1";
const APP_FILES = ["./", "./index.html", "./styles.css", "./channel.js", "./app.js", "./protocol.js", "./packet-stats.js", "./session.js", "./raw-protocol.js", "./raw-session.js", "./ble.js", "./storage.js", "./chart.js", "./ui.js", "./wakelock.js", "./manifest.webmanifest", "./icon-dev.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request).then((cached) => {
      if (cached) return cached;
      throw new Error("This page is not available offline.");
    }))
  );
});
