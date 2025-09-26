import React, { useState, useEffect } from 'react';
import LoadingSpinner from './LoadingSpinner';

interface WebSocketLoadingScreenProps {
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  isConnected: boolean;
  onOfflineMode: () => void;
}

const WebSocketLoadingScreen: React.FC<WebSocketLoadingScreenProps> = ({ 
  connectionStatus, 
  isConnected,
  onOfflineMode
}) => {
  const [showOfflineOption, setShowOfflineOption] = useState(false);
  const [connectionStartTime] = useState(Date.now());

  // Show offline option after 5 seconds of connection attempts
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!isConnected && (connectionStatus === 'connecting' || connectionStatus === 'error')) {
        setShowOfflineOption(true);
      }
    }, 5000); // 5 seconds

    return () => clearTimeout(timer);
  }, [isConnected, connectionStatus]);

  const getLoadingMessage = () => {
    switch (connectionStatus) {
      case 'connecting':
        return 'Connecting to live updates...';
      case 'connected':
        return 'Connected! Loading app...';
      case 'error':
        return 'Connection failed. Retrying...';
      case 'disconnected':
      default:
        return 'Initializing connection...';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-start justify-center pt-32">
      <div className="text-center max-w-md mx-auto px-4">
        <div className="mb-6">
          <LoadingSpinner size="large" />
        </div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">
          {getLoadingMessage()}
        </h2>
        <p className="text-gray-600 mb-6">
          Please wait while we establish a secure connection for live updates.
        </p>
        
        {showOfflineOption && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-yellow-800 mb-3">
              Unable to connect to the server. You can continue in offline mode using cached data, but you won't receive live updates.
            </p>
            <button
              onClick={onOfflineMode}
              className="bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
            >
              Continue in Offline Mode
            </button>
          </div>
        )}
        
        {connectionStatus === 'error' && !showOfflineOption && (
          <p className="text-sm text-red-600 mt-2">
            If this continues, please refresh the page.
          </p>
        )}
      </div>
    </div>
  );
};

export default WebSocketLoadingScreen;
