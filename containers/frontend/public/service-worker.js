const CACHE_NAME = 'rv-cache-__GIT_SHA__';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/css/main.css',
    '/css/theme.css',
    '/js/app.js',
    '/js/router.js',
    '/js/api.js',
    '/js/notifications.js',
    '/js/components/airquality-display.js',
    '/js/components/brightness-modal.js',
    '/js/components/energy-display.js',
    '/js/components/gnss-details.js',
    '/js/components/level-indicator.js',
    '/js/components/plateau-status.js',
    '/js/components/light-button.js',
    '/js/components/map-display.js',
    '/js/components/nav-bar.js',
    '/js/components/thermostat.js',
    '/js/components/water-tanks.js',
    '/js/pages/airquality.js',
    '/js/pages/energy.js',
    '/js/pages/home.js',
    '/js/pages/login.js',
    '/js/pages/map.js',
    '/js/pages/settings.js',
    '/js/pages/trailer.js',
    '/js/pages/water.js',
    '/js/pages/wizard.js',
    '/js/pages/config.js',
    '/js/pages/deployments.js',
    '/js/pages/playbill.js',
    '/js/pages/peregrine.js',
    '/js/pages/playbill/radio.js',
    '/js/pages/playbill/volume.js',
    '/js/pages/playbill/remote.js',
    '/js/pages/playbill/youtube.js',
    '/docs/playbill-youtube-setup.html',
    '/apple-touch-icon.png',
    '/icons/icon-180.png',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/logo-color.svg',
    '/icons/logo-white.svg'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('Service Worker: Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Service Worker: Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                console.log('Service Worker: Installed');
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('Service Worker: Install failed', error);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('Service Worker: Activating...');
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== CACHE_NAME) {
                            console.log('Service Worker: Deleting old cache', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => {
                console.log('Service Worker: Activated');
                return self.clients.claim();
            })
    );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Skip API and WebSocket requests - always go to network
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
        return;
    }

    // Network-first strategy: try the network, fall back to cache when offline
    event.respondWith(
        fetch(request)
            .then((networkResponse) => {
                if (networkResponse.ok) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME)
                        .then((cache) => cache.put(request, responseToCache));
                }
                return networkResponse;
            })
            .catch(() => {
                return caches.match(request)
                    .then((cachedResponse) => {
                        if (cachedResponse) {
                            return cachedResponse;
                        }
                        // Offline fallback for navigation requests
                        if (request.mode === 'navigate') {
                            return caches.match('/index.html');
                        }
                        return new Response('Network error', {
                            status: 408,
                            headers: { 'Content-Type': 'text/plain' }
                        });
                    });
            })
    );
});

// Handle messages from main thread
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    if (event.data && event.data.type === 'CLIENTS_CLAIM') {
        self.clients.claim();
    }
});

// Focus the PWA (or open it) when the user taps an alarm notification.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetPath = (event.notification.data && event.notification.data.url) || '/#alarms';
    event.waitUntil((async () => {
        const clientsList = await self.clients.matchAll({
            type: 'window',
            includeUncontrolled: true,
        });
        for (const client of clientsList) {
            if ('focus' in client) {
                try {
                    if ('navigate' in client) await client.navigate(targetPath);
                } catch (_) { /* cross-origin nav guard; ignore */ }
                return client.focus();
            }
        }
        if (self.clients.openWindow) {
            return self.clients.openWindow(targetPath);
        }
    })());
});
