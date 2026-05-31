// =============================================================================
//  Spacer's Business Club — Service Worker (Sprint F)
// =============================================================================
//
//  Stratégies :
//  - Assets statiques (HTML, CSS, JS, images, fonts) : cache-first
//  - API (/api/*)                                     : network-first
//  - Pages d'auth (login, activate, reset)            : network-first (toujours frais)
//
//  Mise à jour : à chaque déploiement, change CACHE_VERSION pour invalider l'ancien.
// =============================================================================

const CACHE_VERSION = 'bc-v2-2026-05-pilote';
const STATIC_CACHE  = `bc-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `bc-runtime-${CACHE_VERSION}`;

// Assets à pré-charger immédiatement à l'installation
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/manifest-pilote.webmanifest',
  '/favicon.svg',
  '/icon-bc.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-pilote.svg',
  '/icon-pilote-192.png',
  '/icon-pilote-512.png',
];

// -----------------------------------------------------------------------------
// INSTALL — pré-cache des assets essentiels
// -----------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(err => {
        // Tolère les échecs partiels (ex. icon manquant) sans bloquer l'install
        console.warn('[SW] pre-cache partiel:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

// -----------------------------------------------------------------------------
// ACTIVATE — nettoie les anciens caches
// -----------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => k.startsWith('bc-') && !k.endsWith(CACHE_VERSION))
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// -----------------------------------------------------------------------------
// FETCH — routage par type de requête
// -----------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Ignore les requêtes non-GET et cross-origin (CDN fonts, Supabase, etc.)
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // API : network-first (toujours frais, fallback cache si offline)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Pages d'auth : network-first (les tokens du hash changent à chaque visite)
  if (url.pathname === '/activate' || url.pathname === '/login' || url.pathname === '/reset') {
    event.respondWith(networkFirst(req));
    return;
  }

  // Page partenaire racine : network-first (données live)
  if (url.pathname === '/' || url.pathname === '/pilote' || url.pathname === '/pilote/') {
    event.respondWith(networkFirst(req));
    return;
  }

  // Tout le reste (assets statiques) : cache-first
  event.respondWith(cacheFirst(req));
});

// -----------------------------------------------------------------------------
// STRATÉGIES
// -----------------------------------------------------------------------------
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    return new Response('Hors ligne', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok && req.method === 'GET') {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    // Offline : tenter le cache
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'Hors ligne', detail: 'Connexion requise' }),
      { status: 503, headers: { 'Content-Type': 'application/json;charset=utf-8' } }
    );
  }
}

// -----------------------------------------------------------------------------
// MESSAGE — pour forcer un skip-waiting depuis le frontend (mise à jour)
// -----------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
