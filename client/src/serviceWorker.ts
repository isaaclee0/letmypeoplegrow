// Service Worker Registration for PWA Updates
// This file handles service worker registration and update notifications

const isLocalhost = Boolean(
  window.location.hostname === 'localhost' ||
    window.location.hostname === '[::1]' ||
    window.location.hostname.match(/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/)
);

// Detect iOS for specific handling
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

type Config = {
  onSuccess?: (registration: ServiceWorkerRegistration) => void;
  onUpdate?: (registration: ServiceWorkerRegistration) => void;
};

export function register(config?: Config) {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      const swUrl = '/sw.js';

      // Check if we're in development mode and skip service worker
      const isDevelopment = process.env.NODE_ENV === 'development' || 
                           window.location.hostname === 'localhost' ||
                           window.location.hostname.includes('127.0.0.1');
      
      if (isDevelopment) {
        console.log('🚫 Service worker registration disabled in development');
        return;
      }

      // Only unregister if there are existing registrations that might be problematic
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        if (registrations.length > 0) {
          console.log('Found existing service worker registrations:', registrations.length);
          
          // Check if any registration is for a different scope or has issues
          const problematicRegistrations = registrations.filter(reg => {
            // Keep registrations that are working properly
            return reg.active && reg.active.scriptURL.includes('sw.js');
          });
          
          if (problematicRegistrations.length > 0) {
            console.log('Unregistering problematic service workers:', problematicRegistrations.length);
            problematicRegistrations.forEach((registration) => {
              console.log('Unregistering service worker:', registration.scope);
              registration.unregister();
            });
          }
        }
        
        // Wait a moment for any unregistration to complete
        setTimeout(() => {
          if (isLocalhost) {
            // This is running on localhost. Let's check if a service worker still exists or not.
            checkValidServiceWorker(swUrl, config);

            // Add some additional logging to localhost, pointing developers to the
            // service worker/PWA documentation.
            navigator.serviceWorker.ready.then(() => {
              console.log(
                'This web app is being served cache-first by a service ' +
                  'worker. To learn more, visit https://bit.ly/CRA-PWA'
              );
            });
          } else {
            // Is not localhost. Just register service worker
            registerValidSW(swUrl, config);
          }
        }, 100);
      });
    });
  }
}

function registerValidSW(swUrl: string, config?: Config) {
  // Force cache bypass for all platforms
  const swOptions = { 
    updateViaCache: 'none',
    scope: '/'
  };

  navigator.serviceWorker
    .register(swUrl, swOptions)
    .then((registration) => {
      console.log('Service Worker registered successfully');
      
      // Check for updates immediately and force refresh
      registration.update().then(() => {
        console.log('Immediate update check completed');
        // Force another update check after a short delay
        setTimeout(() => {
          console.log('Second update check for aggressive cache busting');
          registration.update().catch((error) => {
            console.warn('Second update check failed:', error);
          });
        }, 1000);
      }).catch((error) => {
        console.warn('Immediate update check failed:', error);
      });
      
      // Set up update detection
      registration.onupdatefound = () => {
        console.log('Service Worker update found');
        const installingWorker = registration.installing;
        if (installingWorker == null) {
          return;
        }
        installingWorker.onstatechange = () => {
          console.log('Service Worker state changed:', installingWorker.state);
          if (installingWorker.state === 'installed') {
            if (navigator.serviceWorker.controller) {
              // At this point, the updated precached content has been fetched,
              // but the previous service worker will still serve the older
              // content until all client tabs are closed.
              console.log(
                'New content is available and will be used when all ' +
                  'tabs for this page are closed. See https://bit.ly/CRA-PWA.'
              );

              // Execute callback
              if (config && config.onUpdate) {
                config.onUpdate(registration);
              }
            } else {
              // At this point, everything has been precached.
              // It's the perfect time to display a
              // "Content is cached for offline use." message.
              console.log('Content is cached for offline use.');

              // Execute callback
              if (config && config.onSuccess) {
                config.onSuccess(registration);
              }
            }
          } else if (installingWorker.state === 'redundant') {
            console.log('Service Worker became redundant - no update needed');
            // Don't trigger any callbacks for redundant state
          }
        };
      };
      
      // More aggressive update checking - check every 30 minutes
      const updateInterval = 30 * 60 * 1000; // Check every 30 minutes (1,800,000ms)
      
      console.log(`Service worker update checks scheduled every ${updateInterval / (60 * 1000)} minutes`);
      
      setInterval(() => {
        console.log('Checking for service worker updates... (scheduled check)');
        registration.update();
      }, updateInterval);
      
      // Force update check on page visibility change (iOS specific)
      // Reduced frequency to avoid interfering with WebSocket real-time updates
      if (isIOS) {
        let lastVisibilityCheck = 0;
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) {
            const now = Date.now();
            // Only check for updates if it's been more than 2 minutes since last check
            if (now - lastVisibilityCheck > 120000) { // 2 minutes instead of 5 minutes
              console.log('Page became visible after 2+ minutes, checking for updates...');
              registration.update();
              lastVisibilityCheck = now;
            }
          }
        });
      }
    })
    .catch((error) => {
      console.error('Error during service worker registration:', error);
      
      // If registration fails, try to check if the service worker file exists
      fetch(swUrl, { method: 'HEAD' })
        .then(response => {
          if (response.ok) {
            console.log('Service worker file exists but registration failed');
          } else {
            console.error('Service worker file not found:', swUrl);
          }
        })
        .catch(fetchError => {
          console.error('Failed to check service worker file:', fetchError);
        });
    });
}

function checkValidServiceWorker(swUrl: string, config?: Config) {
  // Check if the service worker can be found. If it can't reload the page.
  fetch(swUrl, {
    headers: { 'Service-Worker': 'script' },
  })
    .then((response) => {
      // Ensure service worker exists, and that we really are getting a JS file.
      const contentType = response.headers.get('content-type');
      if (
        response.status === 404 ||
        (contentType != null && contentType.indexOf('javascript') === -1)
      ) {
        // No service worker found. Probably a different app. Reload the page.
        navigator.serviceWorker.ready.then((registration) => {
          registration.unregister().then(() => {
            window.location.reload();
          });
        });
      } else {
        // Service worker found. Proceed as normal.
        registerValidSW(swUrl, config);
      }
    })
    .catch(() => {
      console.log('No internet connection found. App is running in offline mode.');
    });
}

export function unregister() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => {
        registration.unregister();
      })
      .catch((error) => {
        console.error(error.message);
      });
  }
}
