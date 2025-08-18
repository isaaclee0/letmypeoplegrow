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
    // Register service worker with update callbacks
    register({
      onUpdate: (registration) => {
        setUpdateAvailable(true);
        setShowUpdateNotification(true);
        
        // Store the waiting worker for later use
        if (registration.waiting) {
          setWaitingWorker(registration.waiting);
        }
        
        // Don't automatically update - let user choose via notification
        console.log('PWA update available - showing notification');
      },
      onSuccess: (registration) => {
        console.log('PWA content is cached for offline use.');
      },
    });
  }, []);

  const performUpdate = () => {
    if (waitingWorker) {
      // Send message to service worker to skip waiting and activate
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      
      // Reload the page to use the new service worker
      window.location.reload();
    } else {
      // Fallback: just reload the page
      window.location.reload();
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
