import React, { useState } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { simulateConnectionIssue, restoreConnection, isConnectionSimulationActive } from '../utils/connectionSimulator';
import { WifiIcon, ExclamationTriangleIcon, CheckCircleIcon } from '@heroicons/react/24/outline';

export const ConnectionTestPanel: React.FC = () => {
  const { connectionStatus, isOfflineMode, isConnected, retryConnection, getConnectionStats } = useWebSocket();
  const [isSimulatingDelay, setIsSimulatingDelay] = useState(false);

  const simulateConnectionDelay = () => {
    setIsSimulatingDelay(true);
    
    // Simulate a connection issue for 15 seconds
    simulateConnectionIssue(15000);
    
    // Reset UI state after simulation
    setTimeout(() => {
      setIsSimulatingDelay(false);
    }, 15000);
  };

  const stopSimulation = () => {
    restoreConnection();
    setIsSimulatingDelay(false);
  };

  const getStatusIcon = () => {
    if (isOfflineMode) {
      return <ExclamationTriangleIcon className="h-5 w-5 text-yellow-500" />;
    } else if (isConnected) {
      return <CheckCircleIcon className="h-5 w-5 text-green-500" />;
    } else {
      return <WifiIcon className="h-5 w-5 text-gray-500" />;
    }
  };

  const getStatusColor = () => {
    if (isOfflineMode) return 'text-yellow-600';
    if (isConnected) return 'text-green-600';
    return 'text-gray-600';
  };

  const stats = getConnectionStats();

  return (
    <div className="bg-white p-4 rounded-lg shadow border">
      <h3 className="text-lg font-semibold mb-4 flex items-center">
        {getStatusIcon()}
        <span className={`ml-2 ${getStatusColor()}`}>
          Connection Status: {connectionStatus.toUpperCase()}
        </span>
      </h3>
      
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="font-medium">Connected:</span>
            <span className={`ml-2 ${isConnected ? 'text-green-600' : 'text-red-600'}`}>
              {isConnected ? 'Yes' : 'No'}
            </span>
          </div>
          <div>
            <span className="font-medium">Offline Mode:</span>
            <span className={`ml-2 ${isOfflineMode ? 'text-yellow-600' : 'text-gray-600'}`}>
              {isOfflineMode ? 'Yes' : 'No'}
            </span>
          </div>
          <div>
            <span className="font-medium">Socket ID:</span>
            <span className="ml-2 text-gray-600 font-mono text-xs">
              {stats.socketId || 'None'}
            </span>
          </div>
          <div>
            <span className="font-medium">Room:</span>
            <span className="ml-2 text-gray-600">
              {stats.room || 'None'}
            </span>
          </div>
        </div>

        <div className="pt-3 border-t">
          <div className="flex space-x-2">
            <button
              onClick={retryConnection}
              disabled={isSimulatingDelay}
              className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Retry Connection
            </button>
            
            <button
              onClick={isSimulatingDelay ? stopSimulation : simulateConnectionDelay}
              className={`px-3 py-1 text-sm rounded ${
                isSimulatingDelay 
                  ? 'bg-red-500 text-white hover:bg-red-600' 
                  : 'bg-yellow-500 text-white hover:bg-yellow-600'
              }`}
            >
              {isSimulatingDelay ? 'Stop Simulation' : 'Simulate Delay'}
            </button>
          </div>
          
          {isSimulatingDelay && (
            <p className="text-xs text-yellow-600 mt-2">
              Simulating connection delay - offline mode should activate after 10 seconds
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
