import React from 'react';
import { ArrowPathIcon } from '@heroicons/react/24/outline';

interface PWAUpdateNotificationProps {
  onUpdate: () => void;
}

const PWAUpdateNotification: React.FC<PWAUpdateNotificationProps> = ({ onUpdate }) => {
  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-blue-600 text-white shadow-lg">
      <div className="max-w-7xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <ArrowPathIcon className="h-5 w-5 mr-2" />
            <span className="text-sm font-medium">
              New version available. Refreshing to update...
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PWAUpdateNotification;
