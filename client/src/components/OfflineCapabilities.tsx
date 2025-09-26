import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { CheckCircleIcon, XCircleIcon, ClockIcon } from '@heroicons/react/24/outline';

export const OfflineCapabilities: React.FC = () => {
  const { user } = useAuth();
  const [capabilities, setCapabilities] = useState({
    userData: false,
    attendanceData: false,
    offlineChanges: false,
    userPreferences: false,
    settings: false,
    cacheSize: '0KB'
  });

  useEffect(() => {
    // Check what data is available offline
    const hasUserData = !!localStorage.getItem('user');
    const hasAttendanceData = !!localStorage.getItem('attendance_cached_data');
    const offlineChanges = JSON.parse(localStorage.getItem('attendance_offline_changes') || '[]');
    const hasOfflineChanges = offlineChanges.length > 0;
    const hasUserPreferences = !!localStorage.getItem('preference_');
    const hasSettings = !!localStorage.getItem('appSettings');
    
    // Calculate approximate cache size
    const cacheSize = Math.round(
      JSON.stringify(localStorage).length / 1024
    );
    
    setCapabilities({
      userData: hasUserData,
      attendanceData: hasAttendanceData,
      offlineChanges: hasOfflineChanges,
      userPreferences: hasUserPreferences,
      settings: hasSettings,
      cacheSize: `${cacheSize}KB`
    });
  }, []);

  const getStatusIcon = (hasData: boolean) => {
    return hasData ? (
      <CheckCircleIcon className="h-5 w-5 text-green-500" />
    ) : (
      <XCircleIcon className="h-5 w-5 text-red-500" />
    );
  };

  const getStatusText = (hasData: boolean) => {
    return hasData ? 'Available' : 'Not Available';
  };

  const getStatusColor = (hasData: boolean) => {
    return hasData ? 'text-green-600' : 'text-red-600';
  };

  return (
    <div className="bg-white p-4 rounded-lg shadow border">
      <h3 className="text-lg font-semibold mb-4 flex items-center">
        <ClockIcon className="h-5 w-5 mr-2" />
        Offline Capabilities
      </h3>
      
      <div className="space-y-3">
        <div className="text-sm text-gray-600 mb-3">
          This shows what data is cached and available when offline:
        </div>
        
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {getStatusIcon(capabilities.userData)}
              <span>User Authentication</span>
            </div>
            <span className={`text-sm ${getStatusColor(capabilities.userData)}`}>
              {getStatusText(capabilities.userData)}
            </span>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {getStatusIcon(capabilities.attendanceData)}
              <span>Attendance Data</span>
            </div>
            <span className={`text-sm ${getStatusColor(capabilities.attendanceData)}`}>
              {getStatusText(capabilities.attendanceData)}
            </span>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {getStatusIcon(capabilities.offlineChanges)}
              <span>Offline Changes</span>
            </div>
            <span className={`text-sm ${getStatusColor(capabilities.offlineChanges)}`}>
              {getStatusText(capabilities.offlineChanges)}
            </span>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {getStatusIcon(capabilities.userPreferences)}
              <span>User Preferences</span>
            </div>
            <span className={`text-sm ${getStatusColor(capabilities.userPreferences)}`}>
              {getStatusText(capabilities.userPreferences)}
            </span>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {getStatusIcon(capabilities.settings)}
              <span>App Settings</span>
            </div>
            <span className={`text-sm ${getStatusColor(capabilities.settings)}`}>
              {getStatusText(capabilities.settings)}
            </span>
          </div>
        </div>
        
        <div className="pt-3 border-t">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium">Total Cache Size:</span>
            <span className="text-sm text-gray-600">{capabilities.cacheSize}</span>
          </div>
        </div>
        
        <div className="pt-2 text-xs text-gray-500">
          {capabilities.userData && capabilities.attendanceData ? (
            <span className="text-green-600">
              ✅ App is fully functional offline - you can view and modify attendance data
            </span>
          ) : (
            <span className="text-yellow-600">
              ⚠️ Limited offline functionality - some features may not work without server connection
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
