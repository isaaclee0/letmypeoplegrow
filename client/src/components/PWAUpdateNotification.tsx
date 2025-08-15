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
    <div className="fixed bottom-4 right-4 z-50 max-w-sm w-full bg-white rounded-lg shadow-lg border border-gray-200 p-4">
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <InformationCircleIcon className="h-6 w-6 text-blue-500" />
        </div>
        <div className="ml-3 flex-1">
          <h3 className="text-sm font-medium text-gray-900">
            Update Available
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            A new version of Let My People Grow is available. Refresh to get the latest features and improvements.
          </p>
          <div className="mt-3 flex space-x-2">
            <button
              onClick={handleUpdate}
              className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            >
              <ArrowPathIcon className="h-4 w-4 mr-1" />
              Refresh Now
            </button>
            <button
              onClick={handleDismiss}
              className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm leading-4 font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            >
              Later
            </button>
          </div>
        </div>
        <div className="ml-4 flex-shrink-0 flex">
          <button
            onClick={handleDismiss}
            className="inline-flex text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default PWAUpdateNotification;
