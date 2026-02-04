const CACHE_NAME = 'semspec-v1';

// Pages essentielles à mettre en cache
const PRECACHE_URLS = [
    '/offline.html'
];

// Installation : mettre en cache la page offline
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

// Activation : nettoyer les anciens caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => 
            Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// Stratégie : Network First, fallback sur cache
// On essaie toujours le réseau d'abord (données fraîches)
// Si hors ligne, on affiche la page offline
self.addEventListener('fetch', event => {
    // Ignorer les requêtes non-GET
    if (event.request.method !== 'GET') return;
    
    // Ignorer les requêtes API (toujours réseau)
    if (event.request.url.includes('/api/')) return;
    
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Mettre en cache les pages HTML visitées
                if (response.ok && event.request.url.match(/\.(html|css|js|png|jpg|svg)$/)) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Hors ligne : essayer le cache, sinon page offline
                return caches.match(event.request)
                    .then(cached => {
                        if (cached) return cached;
                        // Si c'est une page HTML, afficher offline
                        if (event.request.headers.get('accept').includes('text/html')) {
                            return caches.match('/offline.html');
                        }
                    });
            })
    );
});
