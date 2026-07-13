// Minimal offline shell so the app is installable and launches without a
// network. Cache-first for the static assets; everything else falls through.
// Bump this on every deploy so clients drop the old cached assets (the worker
// deletes non-matching caches on activate). Cache-first won't update otherwise.
const CACHE = "museum-companion-v2";
const ASSETS = [
  ".",
  "index.html",
  "styles.css",
  "app.js",
  "api.js",
  "icon.svg",
  "manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
