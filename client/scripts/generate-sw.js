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

// Minimal offline fallback page (inlined so it works even with empty cache)
const OFFLINE_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#9B51E0"><title>Let My People Grow</title><style>body{margin:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh}.c{text-align:center;padding:2rem}h2{color:#374151;margin-bottom:.5rem}p{color:#6B7280;font-size:14px;margin-bottom:1.5rem}button{background:#9B51E0;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer}button:active{background:#7C3AED}</style></head><body><div class="c"><h2>Unable to Load</h2><p>Please check your internet connection and try again.</p><button onclick="location.reload()">Retry</button></div></body></html>';

// Install event - cache shell resources
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...', CACHE_NAME, 'Version:', APP_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache:', CACHE_NAME);
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting())
      .catch((error) => {
        console.warn('Precache failed, staying as waiting worker:', error);
        // Do NOT call skipWaiting — old SW keeps serving from its cache
      })
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
      }).then((response) => {
        // If both cache and network failed, serve an inline offline page
        // This prevents the white screen on iOS when the PWA is reopened offline
        if (!response) {
          return new Response(OFFLINE_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return response;
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
        }).catch(() => {
          // Asset not in cache and network failed — return a proper error
          // so the browser doesn't hang silently
          return new Response('', { status: 504, statusText: 'Offline' });
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
