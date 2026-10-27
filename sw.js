// Network-first service worker: always tries fresh files/data, falls back to the last copy when offline.
const CACHE = 'pairlab-v8';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'live.js', 'sim.js', 'manifest.webmanifest', 'icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.pathname.endsWith('data.json') ? new Request(url.origin + url.pathname) : e.request;
  e.respondWith(
    fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); return res; })
      .catch(() => caches.match(key).then((r) => r || caches.match('index.html')))
  );
});
