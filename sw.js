// MiniMiz — service worker
// Keep the app shell available offline while preferring the latest deployed HTML.
// API calls, Supabase, and cross-origin CDN requests are never cached.

const CACHE_NAME = "minimiz-shell-v6";
const SHELL_FILES = [
  "./index.html",
  "./manifest.json",
  "./favicon-32.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, Supabase, or cross-origin CDN requests.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Always try the deployed page first. This prevents an old cached HTML shell
  // from keeping users on outdated app code after a release.
  const isAppPage = event.request.mode === "navigate" || url.pathname.endsWith("/index.html");
  if (isAppPage) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(event.request)) || (await caches.match("./index.html"));
      }
    })());
    return;
  }

  // Other same-origin assets use stale-while-revalidate for fast repeat visits.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
