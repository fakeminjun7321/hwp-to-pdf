/* Service worker for 한글 문서 PDF 변환기 (HWP/HWPX/DOCX → PDF)
   Static, client-side PWA. No build step. */

'use strict';

const VERSION = 'v3';
const CACHE = 'hwp2pdf-' + VERSION;          // precached app shell
const RUNTIME = 'hwp2pdf-runtime-' + VERSION; // runtime cache for CDN/font assets

// App shell — relative URLs so it works under any base path (e.g. GitHub Pages subdir).
// Some files (./docx.js, ./exporters.js) may be authored by other agents in parallel
// and might not exist yet; allSettled tolerates per-item failures.
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './hwpx.js',
  './hwpeqn.js',
  './docx.js',
  './exporters.js',
  './manifest.webmanifest',
  './icon.svg'
];

// Cross-origin hosts we treat with stale-while-revalidate.
const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'esm.sh'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Per-item add so a single missing file never aborts the whole install.
    await Promise.allSettled(
      APP_SHELL.map((url) =>
        cache.add(new Request(url, { cache: 'reload' }))
      )
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE, RUNTIME]);
    const names = await caches.keys();
    await Promise.all(
      names.map((name) => (keep.has(name) ? undefined : caches.delete(name)))
    );
    await self.clients.claim();
  })());
});

function isCdnHost(hostname) {
  return CDN_HOSTS.some(
    (h) => hostname === h || hostname.endsWith('.' + h)
  );
}

// Network-first for navigations; fall back to cached app shell when offline.
async function handleNavigate(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(CACHE);
    const cached =
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      (await cache.match(request));
    if (cached) return cached;
    throw err;
  }
}

// Network-first for same-origin app files: online users always get the latest
// version (no stale-cache trap); the cache is the offline fallback.
async function handleSameOrigin(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    // 같은 오리진은 정상(200대) 응답만 캐시 — opaque/오류 응답이 오프라인 폴백을 오염시키지 않도록
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Stale-while-revalidate for CDN/font assets (tolerates opaque responses).
async function handleCdn(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);

  const fetchAndUpdate = fetch(request)
    .then((response) => {
      // Cache the clone unconditionally for opaque; for normal responses cache only OK ones.
      if (response && (response.type === 'opaque' || response.ok)) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    // Kick off the background refresh but serve the cached copy immediately.
    fetchAndUpdate;
    return cached;
  }

  const fresh = await fetchAndUpdate;
  if (fresh) return fresh;
  return fetch(request); // last-ditch attempt
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; let the browser deal with everything else.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  // Only http/https (ignore chrome-extension:, data:, etc.).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const sameOrigin = url.origin === self.location.origin;

  // Wrap every handler so any error falls back to a plain network fetch.
  const safe = (promise) =>
    promise.catch(() => fetch(request));

  if (request.mode === 'navigate' && sameOrigin) {
    event.respondWith(safe(handleNavigate(request)));
    return;
  }

  if (sameOrigin) {
    event.respondWith(safe(handleSameOrigin(request)));
    return;
  }

  if (isCdnHost(url.hostname)) {
    event.respondWith(safe(handleCdn(request)));
    return;
  }

  // Other cross-origin requests: do not intercept.
});
