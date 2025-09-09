// Service Worker for Let My People Grow PWA
// Generated on 2025-09-09T20:33:00.576Z
// App Version: 1.1.3
// This handles caching and update notifications

const CACHE_NAME = 'let-my-people-grow-v1.1.3-1757449980576';
const APP_VERSION = '1.1.3';
const urlsToCache = [
  '/',
  '/manifest.json',
  '/favicon.ico',
  '/logo192.png',
  '/logo512.png'
];

// Install event - cache resources
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...', CACHE_NAME, 'Version:', APP_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache:', CACHE_NAME);
        return cache.addAll(urlsToCache).catch((error) => {
          console.warn('Failed to cache some resources:', error);
          // Continue with installation even if some resources fail to cache
          return Promise.resolve();
        });
      })
      .then(() => {
        // Force activation for iOS Safari
        return self.skipWaiting();
      })
  );
});

// Fetch event - serve from cache if available
self.addEventListener('fetch', (event) => {
  // Skip API requests and other non-GET requests
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Return cached version or fetch from network
        if (response) {
          return response;
        }
        
        return fetch(event.request).then((response) => {
          // Don't cache if not a valid response
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }

          // Clone the response
          const responseToCache = response.clone();

          caches.open(CACHE_NAME)
            .then((cache) => {
              cache.put(event.request, responseToCache);
            })
            .catch((error) => {
              console.warn('Failed to cache response:', error);
            });

          return response;
        }).catch((error) => {
          console.warn('Fetch failed:', error);
          // Return a fallback response or let the browser handle it
          return new Response('Network error', { status: 503 });
        });
      })
  );
});

// Activate event - clean up old caches and take control immediately
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...', CACHE_NAME, 'Version:', APP_VERSION);
  event.waitUntil(
    Promise.all([
      // Clean up old caches
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            // Delete all caches except the current one
            if (cacheName !== CACHE_NAME) {
              console.log('Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      }),
      // Take control immediately for iOS Safari
      self.clients.claim()
    ])
  );
});

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('Received SKIP_WAITING message');
    self.skipWaiting();
  }
});

// Additional iOS Safari optimizations
self.addEventListener('beforeinstallprompt', (event) => {
  console.log('Before install prompt');
});

// Force update check on every page load for iOS
self.addEventListener('fetch', (event) => {
  // Check for updates on navigation requests
  if (event.request.mode === 'navigate') {
    event.waitUntil(
      fetch(event.request).then((response) => {
        // If we get a new response, it might indicate an update
        if (response && response.status === 200) {
          // Check if we need to update
          self.registration.update();
        }
      }).catch(() => {
        // Ignore fetch errors for update checks
      })
    );
  }
});
