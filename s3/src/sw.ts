// Service Worker for offline-first POS Ledger PWA
// [base-T2] ADR-1: Service Worker from day one
// HR-1: No network calls in display paths (all data from IndexedDB via LedgerStore)

const CACHE_PREFIX = 'pos-ledger';
const CACHE_VERSION = '1';
const CACHE_NAME = `${CACHE_PREFIX}-v${CACHE_VERSION}`;

// Assets to precache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/app.js',
  '/app-shell.js',
  '/main.js',
];

declare const self: ServiceWorkerGlobalScope;

// Install: precache essential assets
self.addEventListener('install', (event: ExtendableEvent) => {
  console.log('[SW] Installing service worker...');
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      console.log('[SW] Precaching assets:', PRECACHE_URLS);

      try {
        await cache.addAll(PRECACHE_URLS);
        console.log('[SW] Precache complete');
        // Skip waiting to activate immediately
        await self.skipWaiting();
      } catch (err) {
        console.warn('[SW] Some precache assets failed, continuing anyway:', err);
        // Don't fail install if some assets missing - app works offline from IndexedDB
        await self.skipWaiting();
      }
    })()
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event: ExtendableEvent) => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
      // Take control of all pages immediately
      await self.clients.claim();
      console.log('[SW] Activation complete');
    })()
  );
});

// Fetch: network-first for some assets, cache-first for others, offline-fallback
self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  const { url } = request;

  // Skip non-GET requests and chrome extensions
  if (request.method !== 'GET' || url.startsWith('chrome-extension://')) {
    return;
  }

  // Block all network requests for display paths (HR-1)
  // All data comes through LedgerStore which uses IndexedDB
  // Network is only allowed for backup/restore operations ([base-T15])

  // For HTML/JS/CSS: cache-first (App Shell architecture)
  if (
    url.endsWith('.html') ||
    url.endsWith('.js') ||
    url.endsWith('.css') ||
    url.endsWith('manifest.json') ||
    url.includes('app-shell')
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // For other assets (images, fonts, etc): cache-first with network fallback
  if (
    url.includes('/assets/') ||
    url.match(/\.(png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/)
  ) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // For data API calls: these should NOT reach network
  // LedgerStore enforces access through IndexedDB only (HR-1)
  // If a request reaches here, it's an error - return offline response
  if (url.includes('/api/') || url.includes('/data/')) {
    console.warn('[SW] Blocking network request - use LedgerStore instead:', url);
    event.respondWith(offlineResponse());
    return;
  }

  // Default: cache-first
  event.respondWith(cacheFirst(request));
});

// Cache-first: return cached version, fallback to network
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      // Don't cache if it's a 3xx or 4xx response
      if (response.status >= 200 && response.status < 300) {
        cache.put(request, response.clone());
      }
    }
    return response;
  } catch (err) {
    console.log('[SW] Fetch failed for', request.url, '- returning offline fallback');
    return offlineResponse();
  }
}

// Stale-while-revalidate: return cached, update in background
async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached || offlineResponse());

  return cached || fetchPromise;
}

// Offline response: returns minimal HTML for offline mode
function offlineResponse(): Response {
  return new Response(
    `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Offline</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body dir="rtl">
        <h1>بلا اتصال بالإنترنت</h1>
        <p>التطبيق يعمل بلا اتصال. البيانات محفوظة محلياً.</p>
      </body>
    </html>`,
    {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    }
  );
}

// Background sync for backup/restore (if [base-T15] requests it)
self.addEventListener('sync', (event: any) => {
  if (event.tag === 'sync-backup') {
    console.log('[SW] Background sync: backup requested');
    event.waitUntil(
      (async () => {
        try {
          // This will be handled by [base-T15] implementation
          // Service Worker just queues the request offline, actual backup logic is in the app
          console.log('[SW] Backup sync triggered');
        } catch (err) {
          console.error('[SW] Backup sync failed:', err);
        }
      })()
    );
  }
});

export {};
