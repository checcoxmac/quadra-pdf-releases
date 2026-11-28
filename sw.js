/* Quadra PDF PWA Service Worker — offline completo dopo il primo avvio */
const CACHE_PREFIX = 'quadra-pdf-web-';
let ACTIVE_CACHE = `${CACHE_PREFIX}v1`;

async function precacheFromManifest() {
  try {
    const manifestUrl = new URL('./precache-manifest.json', self.registration.scope).href;
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (!res.ok) return;
    const manifestClone = res.clone();
    const data = await res.json();
    const version = String(data.version || 'v1');
    ACTIVE_CACHE = `${CACHE_PREFIX}${version}`;
    const cache = await caches.open(ACTIVE_CACHE);
    await cache.put(manifestUrl, manifestClone);
    const urls = Array.isArray(data.assets) ? data.assets : [];
    const baseSet = new Set(['./', './index.html', ...urls]);
    const resolved = Array.from(baseSet).map((u) => new URL(u, self.registration.scope).href);

    // Scarica in piccoli lotti per non saturare Safari Mobile su file WASM/OpenCV grandi
    const batchSize = 6;
    for (let i = 0; i < resolved.length; i += batchSize) {
      const slice = resolved.slice(i, i + batchSize);
      await Promise.all(
        slice.map(async (url) => {
          try {
            const existing = await cache.match(url);
            if (!existing) {
              const r = await fetch(url, { cache: 'reload' });
              if (r && r.ok) await cache.put(url, r);
            }
          } catch {
            // Non blocca installazione se un singolo asset opzionale non risponde
          }
        }),
      );
    }
  } catch {
    // Fallback offline silenzioso
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheFromManifest());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const manifestUrl = new URL('./precache-manifest.json', self.registration.scope).href;
        const cachedManifest = await caches.match(manifestUrl);
        if (cachedManifest) {
          const data = await cachedManifest.json();
          if (data?.version) ACTIVE_CACHE = `${CACHE_PREFIX}${data.version}`;
        }
      } catch {
        // keep default
      }
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== ACTIVE_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let reqUrl;
  try {
    reqUrl = new URL(req.url);
  } catch {
    return;
  }

  // Solo stessa origine: zero richieste esterne
  if (reqUrl.origin !== self.location.origin) return;

  // Ignora precache-manifest durante controllo aggiornamenti per vedere nuove build
  if (reqUrl.pathname.endsWith('precache-manifest.json')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req)),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const net = await fetch(req);
          if (net && net.ok) {
            const cache = await caches.open(ACTIVE_CACHE);
            cache.put(req, net.clone()).catch(() => {});
            return net;
          }
        } catch {
          // Offline navigation fallback
        }
        const indexFallback = new URL('./index.html', self.registration.scope).href;
        return (await caches.match(req)) || (await caches.match(indexFallback)) || Response.error();
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const net = await fetch(req);
        if (net && net.ok && reqUrl.protocol.startsWith('http')) {
          const cache = await caches.open(ACTIVE_CACHE);
          cache.put(req, net.clone()).catch(() => {});
        }
        return net;
      } catch {
        return Response.error();
      }
    })(),
  );
});
