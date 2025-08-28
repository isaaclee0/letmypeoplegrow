import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { register } from '../serviceWorker';

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

  useEffect(() => {
    // Skip service worker registration in development to avoid caching issues
    const isDevelopment = process.env.NODE_ENV === 'development' || 
                         window.location.hostname === 'localhost' ||
                         window.location.hostname.includes('127.0.0.1');
    
    if (isDevelopment) {
      console.log('🚫 Service worker registration disabled in development');
      return;
    }
    
    // Register service worker with update callbacks
    register({
      onUpdate: (registration) => {
        setUpdateAvailable(true);
        setShowUpdateNotification(true);
        
        // Store the waiting worker for later use
        if (registration.waiting) {
          setWaitingWorker(registration.waiting);
          
          // Automatically apply the update after a short delay
          setTimeout(() => {
            console.log('Auto-applying PWA update...');
            if (registration.waiting) {
              // Send message to service worker to skip waiting and activate
              registration.waiting.postMessage({ type: 'SKIP_WAITING' });
              
              // Add a small delay to let the service worker process the message
              setTimeout(() => {
                console.log('Reloading page after service worker update');
                window.location.reload();
              }, 500);
            }
          }, 2000); // 2 second delay to show the banner
        }
        
        console.log('PWA update available - auto-applying in 2 seconds');
      },
      onSuccess: (registration) => {
        console.log('PWA content is cached for offline use.');
      },
    });
  }, []);

  const performUpdate = () => {
    console.log('Performing PWA update...', { waitingWorker: !!waitingWorker });
    
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
      window.location.href = window.location.href;
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
    </PWAUpdateContext.Provider>
  );
};
