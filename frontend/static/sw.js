// StreamVault Service Worker v7
// Caches static assets + TMDB API responses for 100k traffic
const CACHE_NAME = 'sv-v7';
const STATIC_ASSETS = ['/', '/index.html', '/all.js'];
const TMDB_IMG_HOST = 'image.tmdb.org';
const TMDB_API_HOST = 'api.themoviedb.org';
const IMG_CACHE = 'sv-img-v7';
const API_CACHE = 'sv-api-v7';
const IMG_CACHE_MAX = 300;
const API_CACHE_TTL = 5 * 60 * 1000; // 5min

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== IMG_CACHE && k !== API_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // TMDB images: cache-first, long TTL
  if (url.hostname === TMDB_IMG_HOST) {
    e.respondWith(cacheFirst(e.request, IMG_CACHE));
    return;
  }

  // TMDB API: network-first with short cache
  if (url.hostname === TMDB_API_HOST) {
    e.respondWith(networkFirstWithCache(e.request, API_CACHE));
    return;
  }

  // Static assets: cache-first
  if (STATIC_ASSETS.some(a => url.pathname === a || url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
    e.respondWith(cacheFirst(e.request, CACHE_NAME));
    return;
  }

  // Everything else: network only (iframes, embeds)
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return cached || new Response('', { status: 503 });
  }
}

async function networkFirstWithCache(request, cacheName) {
  try {
    const response = await fetch(request, { signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ error: 'offline' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}
