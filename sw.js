/* Deki CRM — Service Worker (PWA)
   Đường dẫn TƯƠNG ĐỐI để hoạt động cả khi deploy dưới subpath /b/<id>/.
   - App shell precache (offline mở được khung app)
   - Trang (navigate): network-first, fallback khung app đã cache
   - .../api/...: luôn network (dữ liệu phải mới)
   - Asset tĩnh + CDN: stale-while-revalidate
*/
const VERSION = 'deki-v3';
// Tương đối với vị trí sw.js (scope) — đúng cả root lẫn subpath
const SHELL = [
  './',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './deki-icon-white.png',
];
const START = new URL('./', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // chỉ xử lý GET
  const url = new URL(req.url);

  // API: luôn lấy từ mạng, không đụng cache (path-agnostic vì có thể nằm dưới subpath)
  if (url.pathname.includes('/api/')) return;

  // Điều hướng trang: network-first, offline thì trả khung app đã cache
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(START, { ignoreSearch: true }).then((r) => r || caches.match(req)))
    );
    return;
  }

  // Còn lại (asset tĩnh + CDN): stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
