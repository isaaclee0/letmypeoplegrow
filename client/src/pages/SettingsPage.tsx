import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { settingsAPI } from '../services/api';

import {
  PencilIcon,
  InformationCircleIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';

const SettingsPage: React.FC = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'general' | 'system' | 'privacy'>('general');
  // Commented out data access functionality for now
  // const [dataAccessEnabled, setDataAccessEnabled] = useState(false);
  // const [isUpdating, setIsUpdating] = useState(false);

  const tabs = [
    { id: 'general', name: 'General', icon: PencilIcon },
    { id: 'system', name: 'System Info', icon: InformationCircleIcon },
    { id: 'privacy', name: 'Data Privacy', icon: ShieldCheckIcon },
  ];

  // Commented out Data Access Control Functions for now
  /*
  const loadDataAccessSettings = useCallback(async () => {
    try {
      const response = await settingsAPI.getDataAccess();
      setDataAccessEnabled(response.data.dataAccessEnabled);
    } catch (err) {
      console.error('Failed to load data access settings:', err);
      // Default to disabled if we can't load the setting
      setDataAccessEnabled(false);
    }
  }, []);

  const updateDataAccess = async (enabled: boolean) => {
    try {
      setIsUpdating(true);
      await settingsAPI.updateDataAccess(enabled);
      setDataAccessEnabled(enabled);
      
      // You could add a success notification here
      console.log(`Data access ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      console.error('Failed to update data access setting:', err);
      // Revert the toggle if the update failed
      setDataAccessEnabled(!enabled);
    } finally {
      setIsUpdating(false);
    }
  };
  */

  // Commented out loading settings since we removed the functionality
  // useEffect(() => {
  //   loadDataAccessSettings();
  // }, [loadDataAccessSettings]);

  // Handle URL parameters for tab selection
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get('tab');
    if (tabParam && ['general', 'system', 'privacy'].includes(tabParam)) {
      setActiveTab(tabParam as 'general' | 'system' | 'privacy');
    }
  }, []);

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

              {/* Manual Update Section */}
              <div>
                <h3 className="text-lg font-medium text-gray-900">App Updates</h3>
                <p className="mt-1 text-sm text-gray-600">
                  Force check for app updates (useful for iOS devices).
                </p>
                
                <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <h4 className="text-sm font-medium text-blue-900">Manual Update Check</h4>
                      <p className="mt-1 text-sm text-blue-700">
                        If you're not seeing automatic updates, you can manually check for and apply updates here.
                      </p>
                    </div>
                    <div className="ml-4">
                      <button
                        onClick={() => window.location.reload()}
                        className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        <ArrowPathIcon className="h-4 w-4 mr-2" />
                        Refresh App
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'privacy' && (
            <div className="space-y-6">
              {user?.role !== 'admin' ? (
                <div className="text-center py-8">
                  <ShieldExclamationIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-medium text-gray-900">Admin Access Required</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Only administrators can manage data privacy settings.
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Data Access Control */}
                  <div className="p-6 border border-gray-200 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <h4 className="text-lg font-medium text-gray-900">External Data Access</h4>
                        <p className="mt-1 text-sm text-gray-600">
                          Control whether your church's attendance data can be accessed from external applications like Google Sheets.
                        </p>
                        <div className="mt-3">
                          <div className="flex items-center space-x-2">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                              <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                              Disabled
                            </span>
                            <span className="text-xs text-gray-500">
                              Data is only accessible within this application
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="ml-6">
                        <button
                          // onClick={() => updateDataAccess(!dataAccessEnabled)}
                          disabled={true} // Disabled as API is removed
                          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
                            // dataAccessEnabled ? 'bg-primary-600' : 'bg-gray-200'
                            'bg-gray-200' // Disabled as API is removed
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              // dataAccessEnabled ? 'translate-x-5' : 'translate-x-0'
                              'translate-x-0' // Disabled as API is removed
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Information Panel */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="flex">
                      <div className="flex-shrink-0">
                        <ShieldCheckIcon className="h-5 w-5 text-blue-400" />
                      </div>
                      <div className="ml-3">
                        <h3 className="text-sm font-medium text-blue-800">How This Works</h3>
                        <div className="mt-2 text-sm text-blue-700">
                          <p className="mb-2">
                            <strong>When Enabled:</strong> Your attendance data can be accessed by external applications 
                            (like Google Sheets) using simple HTTP requests. This allows for data integration and reporting.
                          </p>
                          <p className="mb-2">
                            <strong>When Disabled:</strong> All external access to your data is blocked. Data can only be 
                            viewed and managed within this application.
                          </p>
                          <p>
                            <strong>Security Note:</strong> When enabled, ensure that only trusted applications and users 
                            have access to your data endpoints.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                                     {/* Usage Instructions */}
                   {/* {dataAccessEnabled && (
                     <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                       <div className="flex">
                         <div className="flex-shrink-0">
                           <ShieldCheckIcon className="h-5 w-5 text-green-400" />
                         </div>
                         <div className="ml-3">
                           <h3 className="text-sm font-medium text-green-800">Data Access Enabled</h3>
                           <div className="mt-2 text-sm text-green-700">
                             <p className="mb-2">
                               Your data is now accessible from external applications. You can use the following endpoints:
                             </p>
                             <div className="bg-white p-3 rounded border">
                               <code className="text-xs font-mono">
                                 GET /api/importrange/attendance?church_id=YOUR_CHURCH_ID&startDate=2024-01-01&endDate=2024-12-31
                               </code>
                             </div>
                             <p className="mt-2">
                               For Google Sheets integration, use the IMPORTRANGE function with your domain URL and church ID.
                             </p>
                             <p className="mt-1 text-xs text-green-600">
                               <strong>Note:</strong> You'll need to provide your church ID as a parameter. Contact your administrator for this information.
                             </p>
                           </div>
                         </div>
                       </div>
                     </div>
                   )} */}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsPage; 