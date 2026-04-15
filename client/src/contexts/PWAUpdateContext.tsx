import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { register } from '../serviceWorker';
import { LoadingOverlay, useLoadingOverlay } from '../components/LoadingOverlay';

interface PWAUpdateContextType {
  updateAvailable: boolean;
  showUpdateNotification: boolean;
  performUpdate: () => void;
}

const PWAUpdateContext = createContext<PWAUpdateContextType | undefined>(undefined);

export const usePWAUpdate = () => {
  const context = useContext(PWAUpdateContext);
  if (context === undefined) {
    throw new Error('usePWAUpdate must be used within a PWAUpdateProvider');
  }
  return context;
};

interface PWAUpdateProviderProps {
  children: ReactNode;
}

export const PWAUpdateProvider: React.FC<PWAUpdateProviderProps> = ({ children }) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [showUpdateNotification, setShowUpdateNotification] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const { isLoading, showLoading, hideLoading } = useLoadingOverlay();

  useEffect(() => {
    // Skip service worker registration in development to avoid caching issues
    const isDevelopment = process.env.NODE_ENV === 'development' || 
                         window.location.hostname === 'localhost' ||
                         window.location.hostname.includes('127.0.0.1');
    
    // Check if we should disable service worker due to caching issues
    const disableServiceWorker = localStorage.getItem('disable-service-worker') === 'true';
    
    if (isDevelopment || disableServiceWorker) {
      console.log('🚫 Service worker registration disabled:', isDevelopment ? 'development mode' : 'manually disabled');
      
      // Clear any existing service workers in development
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then((registrations) => {
          registrations.forEach((registration) => {
            console.log('Unregistering service worker in development:', registration.scope);
            registration.unregister();
          });
        });
      }
      
      return;
    }
    
    // Register service worker with update callbacks
    register({
      onUpdate: (registration) => {
        setUpdateAvailable(true);
        setShowUpdateNotification(true);

        // Show loading overlay immediately — the controllerchange listener in
        // serviceWorker.ts handles the reload for the normal case where the SW
        // called skipWaiting() during install and has already activated.
        console.log('PWA update detected - showing loading overlay');
        showLoading('Updating app...', false);

        // Fallback: if the SW is still in the waiting state (skipWaiting failed
        // during install), send the message manually and force a reload.
        if (registration.waiting) {
          setWaitingWorker(registration.waiting);
          setTimeout(() => {
            console.log('Auto-applying PWA update via waiting worker...');
            if (registration.waiting) {
              registration.waiting.postMessage({ type: 'SKIP_WAITING' });
              setTimeout(() => {
                console.log('Reloading page after service worker update');
                window.location.reload();
              }, 500);
            }
          }, 1000);
        }
      },
      onSuccess: (registration) => {
        console.log('PWA content is cached for offline use.');
      },
    });
  }, []);

  const performUpdate = () => {
    console.log('Performing PWA update...', { waitingWorker: !!waitingWorker });
    showLoading('Updating app...', false);
    
    if (waitingWorker) {
      // Send message to service worker to skip waiting and activate
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      
      // Add a small delay to let the service worker process the message
      setTimeout(() => {
        console.log('Reloading page after service worker update');
        window.location.reload();
      }, 500);
    } else {
      // Fallback: force a hard refresh to bypass cache
      console.log('No waiting worker, forcing hard refresh');
      // Use replace to avoid adding to browser history
      window.location.replace(window.location.href);
    }
  };

  const value: PWAUpdateContextType = {
    updateAvailable,
    showUpdateNotification,
    performUpdate,
  };

  return (
    <PWAUpdateContext.Provider value={value}>
      {children}
      <LoadingOverlay 
        isLoading={isLoading} 
        message="Updating app..."
      />
    </PWAUpdateContext.Provider>
  );
};
