#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Generate a service worker with cache busting
const generateServiceWorker = () => {
  const timestamp = Date.now();
  
  // Get the current version from package.json
  let currentVersion = '0.9.6'; // fallback
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    currentVersion = packageJson.version;
  } catch (error) {
    console.warn('Could not read package.json for version, using fallback');
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
  '/manifest.json',
  '/favicon.ico',
  '/logo192.png',
  '/logo512.png'
];

// Install event - cache resources
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...', CACHE_NAME, 'Version:', APP_VERSION);
  
  // Force update check immediately after installation
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache:', CACHE_NAME);
        return cache.addAll(urlsToCache).catch((error) => {
          console.warn('Failed to cache some resources:', error);
          return Promise.resolve();
        });
      })
      .then(() => {
        // Force activation for iOS Safari
        return self.skipWaiting();
      })
      .then(() => {
        // Check for updates immediately after installation
        console.log('Checking for service worker updates after installation...');
        return self.registration.update();
      })
  );
});

// Fetch event - serve from cache if available
self.addEventListener('fetch', (event) => {
  // Skip API requests and other non-GET requests
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) {
    return;
  }

  // For HTML files (including index.html), always fetch from network first
  if (event.request.destination === 'document' || event.request.url.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Don't cache HTML files - always get fresh version
          console.log('Fetching fresh HTML:', event.request.url);
          return response;
        })
        .catch((error) => {
          console.warn('HTML fetch failed, trying cache:', error);
          return caches.match(event.request);
        })
    );
    return;
  }

  // For service worker file, never cache
  if (event.request.url.includes('/sw.js')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          console.log('Fetching fresh service worker:', event.request.url);
          return response;
        })
    );
    return;
  }

  // Smart caching strategy for different types of assets
  const url = new URL(event.request.url);
  const isStaticAsset = url.pathname.match(/\\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/);
  const isManifest = url.pathname.includes('manifest.json');
  const isLogo = url.pathname.includes('logo') || url.pathname.includes('favicon');

  if (isStaticAsset || isManifest || isLogo) {
    // For static assets, use cache-first strategy for better performance
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          if (response) {
            console.log('Serving static asset from cache:', url.pathname);
            
            // Update cache in background for stale-while-revalidate
            fetch(event.request)
              .then((freshResponse) => {
                if (freshResponse && freshResponse.status === 200) {
                  const responseToCache = freshResponse.clone();
                  caches.open(CACHE_NAME)
                    .then((cache) => {
                      cache.put(event.request, responseToCache);
                      console.log('Updated static asset cache:', url.pathname);
                    });
                }
              })
              .catch(() => {
                // Ignore background update failures
              });
            
            return response;
          }
          
          // If not in cache, fetch and cache
          return fetch(event.request)
            .then((response) => {
              if (response && response.status === 200) {
                const responseToCache = response.clone();
                caches.open(CACHE_NAME)
                  .then((cache) => {
                    cache.put(event.request, responseToCache);
                    console.log('Cached static asset:', url.pathname);
                  });
              }
              return response;
            });
        })
        .catch((error) => {
          console.warn('Static asset fetch failed:', error);
          return new Response('Asset not available', { status: 404 });
        })
    );
  } else {
    // For other assets, use network-first strategy
    event.respondWith(
      fetch(event.request)
        .then((response) => {
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
        })
        .catch((error) => {
          console.warn('Fetch failed, trying cache:', error);
          // If network fails, try cache as fallback
          return caches.match(event.request);
        })
    );
  }
});

// Activate event - clean up old caches and take control immediately
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...', CACHE_NAME, 'Version:', APP_VERSION);
  event.waitUntil(
    Promise.all([
      // Clean up old caches more aggressively
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            // Delete all caches that don't match our current version pattern
            if (!cacheName.includes('let-my-people-grow-v') || cacheName !== CACHE_NAME) {
              console.log('Deleting old/foreign cache:', cacheName);
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

// Force update check on every page load and navigation
self.addEventListener('fetch', (event) => {
  // Check for updates on navigation requests
  if (event.request.mode === 'navigate') {
    event.waitUntil(
      fetch(event.request).then((response) => {
        // If we get a new response, it might indicate an update
        if (response && response.status === 200) {
          // Check if we need to update
          console.log('Navigation detected, checking for service worker updates...');
          self.registration.update();
        }
      }).catch(() => {
        // Ignore fetch errors for update checks
      })
    );
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
