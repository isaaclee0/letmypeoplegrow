#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Generate a service worker with cache busting
const generateServiceWorker = () => {
  const timestamp = Date.now();
  
  // Get the current version from VERSION file (single source of truth)
  let currentVersion;
  
  // Try multiple locations for VERSION file (local dev vs Docker build)
  const possiblePaths = [
    path.join(__dirname, '../../VERSION'),      // Local development: client/scripts -> project root
    path.join(__dirname, '../VERSION'),         // Docker build: /app/scripts -> /app/VERSION
    path.join(process.cwd(), 'VERSION'),        // Current working directory
  ];
  
  for (const versionPath of possiblePaths) {
    try {
      currentVersion = fs.readFileSync(versionPath, 'utf8').trim();
      console.log(`Read version from VERSION file: ${currentVersion} (${versionPath})`);
      break;
    } catch (error) {
      // Try next path
    }
  }
  
  if (!currentVersion) {
    console.error('ERROR: Could not read VERSION file from any of these locations:');
    possiblePaths.forEach(p => console.error(`  - ${p}`));
    console.error('Please ensure VERSION file exists in the project root.');
    process.exit(1);
  }
  
  const cacheName = `let-my-people-grow-v${currentVersion}-${timestamp}`;
  
  const swContent = `// Service Worker for Let My People Grow PWA
// Generated on ${new Date().toISOString()}
// App Version: ${currentVersion}
// Build Timestamp: ${timestamp}
// This handles caching and update notifications

const CACHE_NAME = '${cacheName}';
const APP_VERSION = '${currentVersion}';
const urlsToCache = [
  '/',
  '/manifest.json',
  '/favicon.ico',
  '/logo192.png',
  '/logo512.png'
];

// Helper: is this a Vite hashed asset? (e.g. /assets/index-BK91X8Ex.js)
function isHashedAsset(url) {
  return url.pathname.match(/\\/assets\\/.*-[a-zA-Z0-9]{8,}\\.(js|css)$/);
}

// Install event - cache shell resources
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...', CACHE_NAME, 'Version:', APP_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache:', CACHE_NAME);
        return cache.addAll(urlsToCache).catch((error) => {
          console.warn('Failed to cache some resources:', error);
          return Promise.resolve();
        });
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches and take control immediately
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...', CACHE_NAME, 'Version:', APP_VERSION);
  event.waitUntil(
    Promise.all([
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((name) => {
            if (name !== CACHE_NAME) {
              console.log('Deleting old cache:', name);
              return caches.delete(name);
            }
          })
        );
      }),
      self.clients.claim()
    ])
  );
});

// Single fetch handler with optimised caching strategies
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET and API requests entirely
  if (request.method !== 'GET' || request.url.includes('/api/') || request.url.includes('/socket.io/')) {
    return;
  }

  // Never cache the service worker itself
  if (request.url.includes('/sw.js')) {
    return;
  }

  const url = new URL(request.url);

  // ── HTML / Navigation: stale-while-revalidate ──
  // Serve cached index.html instantly, update in background.
  // Safe because HTML only references hashed JS/CSS — stale HTML still works.
  if (request.destination === 'document' || request.mode === 'navigate') {
    event.respondWith(
      caches.match('/').then((cached) => {
        const networkFetch = fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', clone));
            // Check for SW updates on navigation (replaces duplicate listener)
            self.registration.update();
          }
          return response;
        }).catch(() => cached);

        // Return cached immediately if available, otherwise wait for network
        return cached || networkFetch;
      })
    );
    return;
  }

  // ── Hashed JS/CSS bundles: cache-first (immutable) ──
  // Vite hashes the content into the filename — if the file is in cache, it's correct.
  // No background revalidation needed; new versions get new filenames.
  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // ── Static assets (images, fonts, manifest): cache-first with background update ──
  const isStaticAsset = url.pathname.match(/\\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp)$/);
  const isManifest = url.pathname.includes('manifest.json');
  if (isStaticAsset || isManifest) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() => cached);

        return cached || networkFetch;
      })
    );
    return;
  }

  // ── Everything else: network-first with cache fallback ──
  event.respondWith(
    fetch(request).then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('Received SKIP_WAITING message');
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
