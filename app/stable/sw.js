// Stable channel: caches are "liftiq-app-vN"; activate() only deletes older caches with this prefix.
// The release tool bumps N on every release (never edit by hand).
const CACHE_PREFIX = "liftiq-app-";
const CACHE_NAME = "liftiq-app-v12";
// Exercise previews (open dataset media, see docs/EXERCISE_DATA.md) get their own runtime cache, derived from the
// channel prefix so the release tool needs no change. Only these hosts and only the dataset's path are cached.
const MEDIA_CACHE = CACHE_PREFIX + "media-v1";
const MEDIA_HOSTS = ["cdn.jsdelivr.net", "raw.githubusercontent.com"];
const MEDIA_PATH = /\/hasaneyldrm\/exercises-dataset[@/][0-9a-f]{40}\/(images|videos)\//;
const MEDIA_MAX_ENTRIES = 200;
const APP_FILES = ["./", "./index.html", "./styles.css", "./channel.js", "./app.js", "./protocol.js", "./packet-stats.js", "./session.js", "./raw-protocol.js", "./raw-session.js", "./ble.js", "./vendor/liftiq-sensor/index.js", "./vendor/liftiq-sensor/protocol.js", "./vendor/liftiq-sensor/raw-protocol.js", "./vendor/liftiq-sensor/packet-stats.js", "./vendor/liftiq-sensor/session.js", "./vendor/liftiq-sensor/ready-check.js", "./vendor/liftiq-sensor/analysis/pulses.js", "./vendor/liftiq-sensor/analysis/live-counter.js", "./vendor/liftiq-sensor/ble-client.js", "./vendor/liftiq-sensor/web-bluetooth-transport.js", "./storage.js", "./chart.js", "./ui.js", "./wakelock.js", "./exercises.js", "./exercise-db.js", "./exercise-media.js", "./set-format.js", "./workout.js", "./workout-storage.js", "./train-view.js", "./pulse-chart.js", "./rest-alert.js", "./analysis/pulses.js", "./analysis/live-counter.js", "./ready-check.js", "./photos.js", "./dev-tools.js", "./assets/machines/credits.json", "./assets/machines/cable-station.jpg", "./assets/machines/lat-pulldown.jpg", "./assets/machines/leg-extension.jpg", "./assets/machines/cable-fly.jpg", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME && name !== MEDIA_CACHE).map((name) => caches.delete(name)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    if (MEDIA_HOSTS.includes(requestUrl.hostname) && MEDIA_PATH.test(requestUrl.href)) event.respondWith(mediaResponse(event));
    return; // everything else cross-origin: not intercepted
  }
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

// Stale-while-revalidate for the dataset media. Opaque responses are allowed; a failure with nothing cached is a
// network error, which the page handles (fallback URL, then pictogram). Never throws into the app shell.
async function mediaResponse(event) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request).then(async (response) => {
    if (response.ok || response.type === "opaque") {
      await cache.put(event.request, response.clone());
      const keys = await cache.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - MEDIA_MAX_ENTRIES))) await cache.delete(key); // oldest first
    }
    return response;
  }).catch(() => Response.error());
  if (cached) { event.waitUntil(refresh); return cached; }
  return refresh;
}
