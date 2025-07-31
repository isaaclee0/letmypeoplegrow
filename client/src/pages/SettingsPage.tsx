import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiKeysAPI } from '../services/api';
import {
  Cog6ToothIcon,
  InformationCircleIcon,
  CheckIcon,
  XMarkIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline';

const SettingsPage: React.FC = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'general' | 'system' | 'api'>('general');
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [newApiKey, setNewApiKey] = useState<any>(null);
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const [apiAccessEnabled, setApiAccessEnabled] = useState(false);

  const tabs = [
    { id: 'general', name: 'General', icon: Cog6ToothIcon },
    { id: 'system', name: 'System Info', icon: InformationCircleIcon },
    { id: 'api', name: 'API Access', icon: KeyIcon },
  ];

  // API Key Management Functions
  const loadApiKeys = useCallback(async () => {
    try {
      const response = await apiKeysAPI.getAll();
      setApiKeys(response.data.apiKeys);
      setApiAccessEnabled(response.data.apiKeys.length > 0);
    } catch (err) {
      console.error('Failed to load API keys:', err);
    }
  }, []);

  const createApiKey = async (keyName: string) => {
    try {
      setIsCreatingKey(true);
      const response = await apiKeysAPI.create({
        keyName,
        permissions: ['read_attendance', 'read_reports']
      });
      setNewApiKey(response.data.apiKey);
      loadApiKeys();
    } catch (err) {
      console.error('Failed to create API key:', err);
    } finally {
      setIsCreatingKey(false);
    }
  };

  const deleteApiKey = async (keyId: number) => {
    if (!window.confirm('Are you sure you want to delete this API key? This action cannot be undone.')) {
      return;
    }

    try {
      await apiKeysAPI.delete(keyId);
      loadApiKeys();
    } catch (err) {
      console.error('Failed to delete API key:', err);
    }
  };

  const activateApiAccess = async () => {
    try {
      setIsActivating(true);
      // Create a default API key to enable access
      const response = await apiKeysAPI.create({
        keyName: 'Default API Key',
        permissions: ['read_attendance', 'read_reports']
      });
      setShowActivationModal(false);
      setApiAccessEnabled(true);
      loadApiKeys();
    } catch (err: any) {
      console.error('Failed to activate API access:', err);
      window.alert('Failed to activate API access');
    } finally {
      setIsActivating(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // You could add a toast notification here
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Load API keys when component mounts (for admins)
  useEffect(() => {
    if (user?.role === 'admin') {
      loadApiKeys();
    }
  }, [user?.role, loadApiKeys]);

  // Handle URL parameters for tab selection
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get('tab');
    if (tabParam && ['general', 'system', 'api'].includes(tabParam)) {
      setActiveTab(tabParam as 'general' | 'system' | 'api');
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

          {activeTab === 'api' && (
            <div className="space-y-6">
              {user?.role !== 'admin' ? (
                <div className="text-center py-8">
                  <KeyIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-medium text-gray-900">Admin Access Required</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Only administrators can manage API keys for Google Sheets integration.
                  </p>
                </div>
              ) : !apiAccessEnabled ? (
                <div className="text-center py-8">
                  <KeyIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-medium text-gray-900">API Access Not Enabled</h3>
                  <p className="mt-1 text-sm text-gray-500 mb-4">
                    Enable API access to create keys for Google Sheets integration.
                  </p>
                  <button
                    onClick={() => setShowActivationModal(true)}
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                  >
                    <KeyIcon className="h-4 w-4 mr-2" />
                    Enable API Access
                  </button>
                </div>
              ) : (
                <>
                  {/* Create New API Key */}
                  <div className="p-4 border border-gray-200 rounded-lg">
                    <h4 className="text-md font-medium text-gray-900 mb-3">Create New API Key</h4>
                    <div className="flex gap-3">
                      <input
                        type="text"
                        placeholder="Enter key name (e.g., 'Google Sheets Access')"
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-primary-500 focus:border-primary-500"
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') {
                            const input = e.target as HTMLInputElement;
                            if (input.value.trim()) {
                              createApiKey(input.value.trim());
                              input.value = '';
                            }
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          const input = document.querySelector('input[placeholder*="key name"]') as HTMLInputElement;
                          if (input?.value.trim()) {
                            createApiKey(input.value.trim());
                            input.value = '';
                          }
                        }}
                        disabled={isCreatingKey}
                        className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                      >
                        <PlusIcon className="h-4 w-4 mr-2" />
                        {isCreatingKey ? 'Creating...' : 'Create Key'}
                      </button>
                    </div>
                  </div>

                  {/* New API Key Display */}
                  {newApiKey && (
                    <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                      <h4 className="text-md font-medium text-green-900 mb-2">New API Key Created</h4>
                      <p className="text-sm text-green-700 mb-3">
                        Your API key is ready to use. Copy it below:
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 bg-white border border-green-300 rounded text-sm font-mono">
                          {newApiKey.apiKey}
                        </code>
                        <button
                          onClick={() => copyToClipboard(newApiKey.apiKey)}
                          className="px-3 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-700"
                        >
                          <ClipboardDocumentIcon className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded">
                        <h5 className="text-sm font-medium text-blue-900 mb-2">Google Sheets Formula</h5>
                        <p className="text-xs text-blue-700 mb-2">Copy this formula directly into Google Sheets:</p>
                        <code className="block px-3 py-2 bg-white border border-blue-300 rounded text-xs font-mono">
                          =IMPORTRANGE("https://your-domain.com/api/importrange/attendance?api_key={newApiKey.apiKey}&startDate=2024-01-01&endDate=2024-12-31", "attendance")
                        </code>
                        <button
                          onClick={() => copyToClipboard(`=IMPORTRANGE("https://your-domain.com/api/importrange/attendance?api_key=${newApiKey.apiKey}&startDate=2024-01-01&endDate=2024-12-31", "attendance")`)}
                          className="mt-2 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                          Copy Formula
                        </button>
                      </div>
                    </div>
                  )}

                  {/* API Keys List */}
                  <div>
                    <h4 className="text-md font-medium text-gray-900 mb-3">Your API Keys</h4>
                    {apiKeys.length === 0 ? (
                      <p className="text-sm text-gray-500">No API keys created yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {apiKeys.map((key) => (
                          <div key={key.id} className="p-4 border border-gray-200 rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                              <h5 className="font-medium text-gray-900">{key.key_name}</h5>
                              <button
                                onClick={() => deleteApiKey(key.id)}
                                className="text-red-600 hover:text-red-800"
                              >
                                <TrashIcon className="h-4 w-4" />
                              </button>
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-300 rounded text-sm font-mono">
                                  {key.api_key}
                                </code>
                                <button
                                  onClick={() => copyToClipboard(key.api_key)}
                                  className="px-3 py-2 text-sm bg-gray-600 text-white rounded hover:bg-gray-700"
                                >
                                  <ClipboardDocumentIcon className="h-4 w-4" />
                                </button>
                              </div>
                              <div className="flex items-center gap-2 text-xs text-gray-500">
                                <span>Created: {new Date(key.created_at).toLocaleDateString()}</span>
                                {key.last_used_at && (
                                  <span>• Last used: {new Date(key.last_used_at).toLocaleString()}</span>
                                )}
                              </div>
                              <div className="p-3 bg-blue-50 border border-blue-200 rounded">
                                <h6 className="text-xs font-medium text-blue-900 mb-1">Google Sheets Formula</h6>
                                <code className="block px-2 py-1 bg-white border border-blue-300 rounded text-xs font-mono">
                                  =IMPORTRANGE("https://your-domain.com/api/importrange/attendance?api_key={key.api_key}&startDate=2024-01-01&endDate=2024-12-31", "attendance")
                                </code>
                                <button
                                  onClick={() => copyToClipboard(`=IMPORTRANGE("https://your-domain.com/api/importrange/attendance?api_key=${key.api_key}&startDate=2024-01-01&endDate=2024-12-31", "attendance")`)}
                                  className="mt-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                                >
                                  Copy Formula
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Activation Modal */}
      {showActivationModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Enable API Access</h3>
              <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 mb-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-yellow-800">Security Warning</h3>
                    <div className="mt-2 text-sm text-yellow-700">
                      <p>
                        Enabling API access will create API keys that can be used to access your church's attendance data. 
                        Anyone with these keys will be able to retrieve your data through Google Sheets or other applications.
                      </p>
                      <p className="mt-2">
                        <strong>Only enable this if you understand the security implications and trust the users who will have access to these keys.</strong>
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <p className="text-sm text-gray-600 mb-4">
                Are you sure you want to enable API access for Google Sheets integration? 
                This will create a default API key that you can use immediately.
              </p>
              <div className="flex gap-3 mt-4">
                <button
                  onClick={activateApiAccess}
                  disabled={isActivating}
                  className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50"
                >
                  {isActivating ? 'Enabling...' : 'Yes, Enable API Access'}
                </button>
                <button
                  onClick={() => setShowActivationModal(false)}
                  className="flex-1 px-4 py-2 bg-gray-300 text-gray-700 rounded-md hover:bg-gray-400"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsPage; 