const APP_CACHE = "lews-app-v120";   // ✅ bump version to force refresh
const TILE_CACHE = "lews-tiles-v1";

const APP_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./sw.js",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",

  // ✅ cache sensor json once so offline has something
  "./scripts/sensor_data.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map(k => {
        if (k !== APP_CACHE && k !== TILE_CACHE) return caches.delete(k);
      })
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  const isOSMTile = url.hostname.includes("tile.openstreetmap.org");
  const isSensorJson = url.pathname.endsWith("/scripts/sensor_data.json");

  if (isOSMTile) {
    event.respondWith(cacheFirst(req, TILE_CACHE));
    return;
  }

  // ✅ sensor json should update live, but fallback offline
  if (isSensorJson) {
    event.respondWith(networkFirstStableKey(req, APP_CACHE));
    return;
  }

  // ✅ app assets cache-first
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

  const fresh = await fetch(req);
  cache.put(req, fresh.clone());
  return fresh;
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

/**
 * ✅ Stable-cache key version:
 * even if JS fetch uses cache-busters later, cache entry stays 1.
 */
async function networkFirstStableKey(req, cacheName) {
  const cache = await caches.open(cacheName);

  // strip query
  const cleanUrl = new URL(req.url);
  cleanUrl.search = "";
  const stableReq = new Request(cleanUrl.toString(), req);

  try {
    const fresh = await fetch(req);
    cache.put(stableReq, fresh.clone());
    return fresh;
  } catch {
    return await cache.match(stableReq);
  }
}
