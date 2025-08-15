#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Generate a service worker with cache busting
const generateServiceWorker = () => {
  const timestamp = Date.now();
  const cacheName = `let-my-people-grow-v${timestamp}`;
  
  const swContent = `// Service Worker for Let My People Grow PWA
// Generated on ${new Date().toISOString()}
// This handles caching and update notifications

const CACHE_NAME = '${cacheName}';
const urlsToCache = [
  '/',
  '/manifest.json',
  '/favicon.ico',
  '/logo192.png',
  '/logo512.png'
];

// Install event - cache resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache:', CACHE_NAME);
        return cache.addAll(urlsToCache);
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
            });

          return response;
        });
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheName.startsWith('let-my-people-grow-v')) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
`;

  return swContent;
};

// Write the service worker to the public directory
const writeServiceWorker = () => {
  const swContent = generateServiceWorker();
  const swPath = path.join(__dirname, '../public/sw.js');
  
  fs.writeFileSync(swPath, swContent);
  console.log('Service worker generated:', swPath);
};

// Run the script
writeServiceWorker();
