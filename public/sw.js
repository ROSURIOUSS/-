// Офлайн-оболочка: интерфейс и обложки кэшируются, API — всегда из сети.
const CACHE = 'loria-v7';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/art/world-ash.jpg',
  '/art/world-neon.jpg',
  '/art/world-space.jpg',
  '/art/world-noir.jpg',
  '/art/hero-soldier.jpg',
  '/art/hero-thief.jpg',
  '/art/hero-scholar.jpg',
  '/art/hero-speaker.jpg',
  '/art/hero-medic.jpg',
  '/art/world-forest.jpg',
  '/art/world-waste.jpg',
  '/art/world-tide.jpg',
  '/art/world-rail.jpg',
  '/art/world-court.jpg',
  '/art/hero-hunter.jpg',
  '/art/hero-smuggler.jpg',
  '/art/hero-priest.jpg',
  '/art/hero-engineer.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // статика: сначала кэш, потом сеть (и обновляем кэш)
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
