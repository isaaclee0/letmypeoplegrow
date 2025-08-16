import React, { useState, useEffect } from 'react';
import { 
  ArrowPathIcon, 
  XMarkIcon,
  InformationCircleIcon 
} from '@heroicons/react/24/outline';

interface PWAUpdateNotificationProps {
  onUpdate: () => void;
  onDismiss: () => void;
}

const PWAUpdateNotification: React.FC<PWAUpdateNotificationProps> = ({ 
  onUpdate, 
  onDismiss 
}) => {
  const [isVisible, setIsVisible] = useState(true);

  const handleDismiss = () => {
    setIsVisible(false);
    onDismiss();
  };

  const handleUpdate = () => {
    onUpdate();
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-blue-600 text-white shadow-lg">
      <div className="max-w-7xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <InformationCircleIcon className="h-5 w-5 mr-2" />
            <div>
              <h3 className="text-sm font-medium">
                App Update Available
              </h3>
              <p className="text-xs opacity-90">
                A new version is ready. Refresh to get the latest features and improvements.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={handleUpdate}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-blue-600 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-white"
            >
              <ArrowPathIcon className="h-4 w-4 mr-1" />
              Update Now
            </button>
            <button
              onClick={handleDismiss}
              className="inline-flex text-white hover:text-gray-200 focus:outline-none focus:ring-2 focus:ring-white"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PWAUpdateNotification;
