// App-shell cache so the page still opens (with stale data) if offline.
// Network-first: every request tries the real network first, so updates are
// always visible when online (the normal case) — only falls back to the
// cached copy if the network request actually fails. A cache-first strategy
// here would silently keep serving old code forever after every deploy,
// which is exactly the bug this replaced.
const CACHE_NAME = 'hero-tasks-shell-v2';
const SHELL_FILES = ['/', '/index.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API calls — always go to the network for real data.
  if (url.pathname.includes('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
