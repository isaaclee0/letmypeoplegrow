import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useDebug } from '../contexts/DebugContext';
import {
  Cog6ToothIcon,
  BugAntIcon,
  InformationCircleIcon,
  ExclamationTriangleIcon,
  CheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

const SettingsPage: React.FC = () => {
  const { user } = useAuth();
  const { isDebugMode, toggleDebugMode, logs, clearLogs } = useDebug();
  const [activeTab, setActiveTab] = useState<'general' | 'debug' | 'system'>('general');

  const tabs = [
    { id: 'general', name: 'General', icon: Cog6ToothIcon },
    { id: 'debug', name: 'Debug', icon: BugAntIcon },
    { id: 'system', name: 'System Info', icon: InformationCircleIcon },
  ];

  const getSystemInfo = () => {
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      windowSize: `${window.innerWidth}x${window.innerHeight}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      currentTime: new Date().toISOString(),
    };
  };

  const systemInfo = getSystemInfo();

  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white shadow rounded-lg">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="mt-1 text-sm text-gray-600">
            Manage your account settings and system preferences
          </p>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8 px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.id
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <tab.icon className="inline-block w-5 h-5 mr-2" />
                {tab.name}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'general' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900">User Information</h3>
                <div className="mt-4 bg-gray-50 rounded-lg p-4">
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Name</dt>
                      <dd className="mt-1 text-sm text-gray-900">
                        {user?.firstName} {user?.lastName}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Email</dt>
                      <dd className="mt-1 text-sm text-gray-900">{user?.email}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Role</dt>
                      <dd className="mt-1 text-sm text-gray-900 capitalize">
                        {user?.role?.replace('_', ' ')}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Default Gathering</dt>
                      <dd className="mt-1 text-sm text-gray-900">
                        {user?.defaultGatheringId ? `ID: ${user.defaultGatheringId}` : 'Not set'}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'debug' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900">Debug Mode</h3>
                <p className="mt-1 text-sm text-gray-600">
                  Enable debug mode to see detailed logs and system information for troubleshooting.
                </p>
                
                <div className="mt-4 flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <div className="flex items-center">
                    <BugAntIcon className="h-5 w-5 text-gray-400 mr-3" />
                    <div>
                      <p className="text-sm font-medium text-gray-900">Debug Mode</p>
                      <p className="text-sm text-gray-500">
                        {isDebugMode ? 'Enabled' : 'Disabled'}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={toggleDebugMode}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      isDebugMode ? 'bg-red-600' : 'bg-gray-200'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        isDebugMode ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {isDebugMode && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-medium text-gray-900">Debug Logs</h4>
                      <button
                        onClick={clearLogs}
                        className="text-sm text-red-600 hover:text-red-800"
                      >
                        Clear Logs
                      </button>
                    </div>
                    <div className="bg-gray-900 text-green-400 p-4 rounded-lg max-h-64 overflow-y-auto font-mono text-xs">
                      {logs.length === 0 ? (
                        <p>No logs yet. Perform some actions to see debug information.</p>
                      ) : (
                        logs.slice(-20).map((log) => (
                          <div key={log.id} className="mb-1">
                            <span className="text-gray-500">
                              {log.timestamp.toLocaleTimeString()}
                            </span>
                            <span className="ml-2 text-blue-400">[{log.category}]</span>
                            <span className="ml-2">{log.message}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <div className="flex">
                  <ExclamationTriangleIcon className="h-5 w-5 text-yellow-400" />
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-yellow-800">
                      Debug Mode Warning
                    </h3>
                    <div className="mt-2 text-sm text-yellow-700">
                      <p>
                        Debug mode is intended for troubleshooting only. It may expose sensitive information 
                        and should be disabled in production environments.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900">System Information</h3>
                <p className="mt-1 text-sm text-gray-600">
                  Technical details about your browser and system environment.
                </p>
                
                <div className="mt-4 bg-gray-50 rounded-lg p-4">
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
                    {Object.entries(systemInfo).map(([key, value]) => (
                      <div key={key}>
                        <dt className="text-sm font-medium text-gray-500">
                          {key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                        </dt>
                        <dd className="mt-1 text-sm text-gray-900 break-all">
                          {typeof value === 'boolean' ? (
                            <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                              value 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-red-100 text-red-800'
                            }`}>
                              {value ? (
                                <CheckIcon className="w-3 h-3 mr-1" />
                              ) : (
                                <XMarkIcon className="w-3 h-3 mr-1" />
                              )}
                              {value ? 'Yes' : 'No'}
                            </span>
                          ) : (
                            value
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsPage; 