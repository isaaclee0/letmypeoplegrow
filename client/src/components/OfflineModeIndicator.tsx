import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useAuth } from '../contexts/AuthContext';
import { useKiosk } from '../contexts/KioskContext';
import { WifiIcon, ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

export const OfflineModeIndicator: React.FC = () => {
  const { isOfflineMode, connectionStatus, retryConnection } = useWebSocket();
  const { user } = useAuth();
  const kioskCtx = useKiosk();
  const [showDetails, setShowDetails] = useState(false);
  const [cachedDataInfo, setCachedDataInfo] = useState({
    hasUserData: false,
    hasAttendanceData: false,
    hasGatheringsData: false,
    hasOfflineChanges: false,
    cacheSize: '0KB'
  });

  useEffect(() => {
    if (isOfflineMode || connectionStatus === 'offline') {
      // Check what data is available offline
      const hasUserData = !!localStorage.getItem('user');
      const hasAttendanceData = !!localStorage.getItem('attendance_cached_data');
      const hasGatheringsData = !!localStorage.getItem('gatherings_cached_data');
      const offlineChanges = JSON.parse(localStorage.getItem('attendance_offline_changes') || '[]');
      const hasOfflineChanges = offlineChanges.length > 0;
      
      // Calculate approximate cache size
      const cacheSize = Math.round(
        JSON.stringify(localStorage).length / 1024
      );
      
      setCachedDataInfo({
        hasUserData,
        hasAttendanceData,
        hasGatheringsData,
        hasOfflineChanges,
        cacheSize: `${cacheSize}KB`
      });
    }
  }, [isOfflineMode, connectionStatus]);

  // Hide in kiosk locked mode - kiosk handles its own offline behavior silently
  if (kioskCtx.isLocked) {
    return null;
  }

  if (!isOfflineMode && connectionStatus !== 'offline') {
    return null;
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-yellow-500 text-yellow-900 px-4 py-2 text-center text-sm font-medium">
      <div className="flex items-center justify-center space-x-2">
        <WifiIcon className="h-4 w-4" />
        <span>Offline Mode - Using cached data</span>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="ml-2 inline-flex items-center px-2 py-1 text-xs font-medium text-yellow-900 bg-yellow-200 rounded hover:bg-yellow-300 transition-colors"
        >
          {showDetails ? 'Hide' : 'Details'}
        </button>
        <button
          onClick={retryConnection}
          className="ml-2 inline-flex items-center px-2 py-1 text-xs font-medium text-yellow-900 bg-yellow-200 rounded hover:bg-yellow-300 transition-colors"
        >
          <ArrowPathIcon className="h-3 w-3 mr-1" />
          Retry
        </button>
      </div>
      
      {showDetails && (
        <div className="mt-2 text-xs text-yellow-800 bg-yellow-100 rounded p-2">
          <div className="grid grid-cols-2 gap-2 text-left">
            <div className="flex items-center space-x-1">
              {cachedDataInfo.hasUserData ? (
                <CheckCircleIcon className="h-3 w-3 text-green-600" />
              ) : (
                <ExclamationTriangleIcon className="h-3 w-3 text-red-600" />
              )}
              <span>User Data</span>
            </div>
            <div className="flex items-center space-x-1">
              {cachedDataInfo.hasAttendanceData ? (
                <CheckCircleIcon className="h-3 w-3 text-green-600" />
              ) : (
                <ExclamationTriangleIcon className="h-3 w-3 text-red-600" />
              )}
              <span>Attendance Data</span>
            </div>
            <div className="flex items-center space-x-1">
              {cachedDataInfo.hasGatheringsData ? (
                <CheckCircleIcon className="h-3 w-3 text-green-600" />
              ) : (
                <ExclamationTriangleIcon className="h-3 w-3 text-red-600" />
              )}
              <span>Gatherings Data</span>
            </div>
            <div className="flex items-center space-x-1">
              {cachedDataInfo.hasOfflineChanges ? (
                <CheckCircleIcon className="h-3 w-3 text-green-600" />
              ) : (
                <ExclamationTriangleIcon className="h-3 w-3 text-red-600" />
              )}
              <span>Offline Changes</span>
            </div>
            <div className="flex items-center space-x-1">
              <span>Cache: {cachedDataInfo.cacheSize}</span>
            </div>
          </div>
          <div className="mt-1 text-center">
            <span className="text-yellow-700">
              {cachedDataInfo.hasUserData && cachedDataInfo.hasAttendanceData && cachedDataInfo.hasGatheringsData
                ? "✅ App fully functional offline" 
                : "⚠️ Limited functionality offline"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
