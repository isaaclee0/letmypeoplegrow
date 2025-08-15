import React from 'react';
import { usePWAUpdate } from '../contexts/PWAUpdateContext';

const PWAUpdateTest: React.FC = () => {
  const { updateAvailable, showUpdateNotification, dismissUpdate, performUpdate } = usePWAUpdate();

  const simulateUpdate = () => {
    // This simulates a service worker update for testing
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((registration) => {
        if (registration && registration.waiting) {
          // Force the update notification
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    }
  };

  return (
    <div className="fixed top-4 left-4 z-50 bg-white rounded-lg shadow-lg border border-gray-200 p-4 max-w-sm">
      <h3 className="text-sm font-medium text-gray-900 mb-2">PWA Update Test</h3>
      <div className="space-y-2 text-xs">
        <div>Update Available: {updateAvailable ? 'Yes' : 'No'}</div>
        <div>Show Notification: {showUpdateNotification ? 'Yes' : 'No'}</div>
        <div className="flex space-x-2">
          <button
            onClick={simulateUpdate}
            className="px-2 py-1 bg-blue-500 text-white rounded text-xs"
          >
            Simulate Update
          </button>
          <button
            onClick={performUpdate}
            className="px-2 py-1 bg-green-500 text-white rounded text-xs"
          >
            Force Update
          </button>
        </div>
      </div>
    </div>
  );
};

export default PWAUpdateTest;
