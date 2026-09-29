// __TITLE__'s service worker. It makes the game installable on phones and
// desktops, and shows offline.html instead of the browser's error page when
// there's no connection. Everything else goes straight to the network, so a
// deploy is live on the next visit. Bump OFFLINE_CACHE if offline.html or the
// files it uses change.
const OFFLINE_CACHE = 'offline-v1';
const OFFLINE_FILES = ['/offline.html', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(OFFLINE_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== OFFLINE_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cache = await caches.open(OFFLINE_CACHE);
    return (await cache.match('/offline.html')) || Response.error();
  }));
});
