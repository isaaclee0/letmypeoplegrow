import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useWebSocket } from '../contexts/WebSocketContext';
import { WifiIcon, ExclamationTriangleIcon, CheckCircleIcon } from '@heroicons/react/24/outline';

export const OfflineStatus: React.FC = () => {
  const { user, isLoading: authLoading } = useAuth();
  const { isOfflineMode, connectionStatus, isConnected } = useWebSocket();
  const [networkStatus, setNetworkStatus] = useState<'online' | 'offline'>('online');

  useEffect(() => {
    const handleOnline = () => setNetworkStatus('online');
    const handleOffline = () => setNetworkStatus('offline');

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const getStatusIcon = () => {
    if (isOfflineMode) {
      return <ExclamationTriangleIcon className="h-5 w-5 text-yellow-500" />;
    } else if (isConnected) {
      return <CheckCircleIcon className="h-5 w-5 text-green-500" />;
    } else {
      return <WifiIcon className="h-5 w-5 text-gray-500" />;
    }
  };

  const getStatusText = () => {
    if (isOfflineMode) {
      return 'Offline Mode (Using Cached Data)';
    } else if (isConnected) {
      return 'Connected';
    } else if (connectionStatus === 'connecting') {
      return 'Connecting...';
    } else {
      return 'Disconnected';
    }
  };

  const getStatusColor = () => {
    if (isOfflineMode) return 'text-yellow-600';
    if (isConnected) return 'text-green-600';
    if (connectionStatus === 'connecting') return 'text-blue-600';
    return 'text-red-600';
  };

  if (authLoading) {
    return (
      <div className="bg-white p-4 rounded-lg shadow border">
        <div className="flex items-center space-x-2">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
          <span className="text-sm text-gray-600">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white p-4 rounded-lg shadow border">
      <h3 className="text-lg font-semibold mb-4 flex items-center">
        {getStatusIcon()}
        <span className={`ml-2 ${getStatusColor()}`}>
          {getStatusText()}
        </span>
      </h3>
      
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600">User:</span>
          <span className={user ? 'text-green-600' : 'text-red-600'}>
            {user ? user.email : 'Not logged in'}
          </span>
        </div>
        
        <div className="flex justify-between">
          <span className="text-gray-600">Network:</span>
          <span className={networkStatus === 'online' ? 'text-green-600' : 'text-red-600'}>
            {networkStatus === 'online' ? 'Online' : 'Offline'}
          </span>
        </div>
        
        <div className="flex justify-between">
          <span className="text-gray-600">WebSocket:</span>
          <span className={isConnected ? 'text-green-600' : 'text-red-600'}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        
        <div className="flex justify-between">
          <span className="text-gray-600">Offline Mode:</span>
          <span className={isOfflineMode ? 'text-yellow-600' : 'text-gray-600'}>
            {isOfflineMode ? 'Active' : 'Inactive'}
          </span>
        </div>
      </div>
      
      {isOfflineMode && (
        <div className="mt-3 p-2 bg-yellow-50 rounded text-xs text-yellow-800">
          <strong>Offline Mode Active:</strong> The app is using cached data. 
          Changes will be synced when the connection is restored.
        </div>
      )}
    </div>
  );
};
