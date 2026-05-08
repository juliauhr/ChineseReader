const CACHE_NAME = 'chinese-reader-v2';
const urlsToCache = [
  '/WordSwap/',
  '/WordSwap/index.html',
  '/WordSwap/styles.css',
  '/WordSwap/app.js',
  '/WordSwap/manifest.json'
];

// Install service worker and cache files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

// Fetch from cache first, then network
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => response || fetch(event.request))
  );
});

// Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {  // Fixed: was missing quotes around the string literal
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
