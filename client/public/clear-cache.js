// Manual cache clearing script
// This can be loaded to force clear all caches

(function() {
    console.log('🧹 Starting aggressive cache clearing...');
    
    // Clear all caches
    if ('caches' in window) {
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.map(function(cacheName) {
                    console.log('Deleting cache:', cacheName);
                    return caches.delete(cacheName);
                })
            );
        }).then(function() {
            console.log('✅ All caches cleared');
        });
    }
    
    // Unregister all service workers
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
            registrations.forEach(function(registration) {
                console.log('Unregistering service worker:', registration.scope);
                registration.unregister();
            });
        });
    }
    
    // Clear localStorage and sessionStorage
    try {
        localStorage.clear();
        sessionStorage.clear();
        console.log('✅ Local storage cleared');
    } catch (e) {
        console.warn('Could not clear local storage:', e);
    }
    
    // Force reload after a short delay
    setTimeout(function() {
        console.log('🔄 Reloading page...');
        window.location.reload(true);
    }, 1000);
})();
