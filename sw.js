/* AgentControl — Service Worker
 * Network-first pour HTML/JS (évite les bugs de cache obsolète)
 * Cache-first pour images / assets statiques
 */
const CACHE = 'agentcontrol-v4';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './QR_p1_Point_Relais_Cocody.png',
  './QR_p2_Point_Relais_Plateau.png',
  './QR_p3_Point_Relais_Yopougon.png',
  './QR_p4_Point_Relais_Bouake_Centre.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const url of ASSETS) {
        try {
          await cache.add(url);
        } catch (e) {
          console.warn('SW cache skip', url, e);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Ne pas intercepter l'API serveur
  if (url.pathname.includes('/api/')) return;

  const isAppShell =
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('index.html');

  if (isAppShell) {
    // Network first pour toujours avoir le code à jour
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // Cache first pour le reste (images…)
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
