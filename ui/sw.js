const APP_CACHE = "lews-app-v4";
const TILE_CACHE = "lews-tiles-v1";

const APP_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./data.json",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  const isOSMTile = url.hostname.includes("tile.openstreetmap.org");

  if (isOSMTile) {
    event.respondWith(cacheFirst(req, TILE_CACHE));
    return;
  }

  if (url.origin === location.origin) {
    event.respondWith(cacheFirst(req, APP_CACHE));
    return;
  }

  event.respondWith(networkFirst(req, APP_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    const fresh = await fetch(req);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    return cached;
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    return await cache.match(req);
  }
}
