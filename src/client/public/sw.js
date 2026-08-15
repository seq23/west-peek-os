/*
 * West Peek OS service worker (P20, GAP-20).
 *
 * Deliberately small and deliberately honest:
 *
 * - The APP SHELL is cached so the operator can open the app on a bad connection and see a real
 *   interface instead of a browser error.
 * - `/api/*` is NEVER cached. Institutional state is never served stale from a device: a request
 *   that cannot reach the server fails, and the UI says it is offline. A cached approval count or
 *   a cached portfolio alert would be a lie with a timestamp on it.
 * - There is no background sync and no push handler, because no push service is configured. When
 *   one exists, it belongs here — pretending otherwise would put a dead feature in the manifest.
 */

const CACHE = "wpos-shell-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg", "/wp-mark.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Institutional state is never served from cache.
  if (url.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/index.html").then((r) => r ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response.ok && url.origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
    }),
  );
});
