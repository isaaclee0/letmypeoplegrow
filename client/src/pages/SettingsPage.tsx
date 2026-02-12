import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { integrationsAPI, aiAPI, settingsAPI } from '../services/api';
import logger from '../utils/logger';

import {
  PencilIcon,
  InformationCircleIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  ArrowPathIcon,
  LinkIcon,
  XMarkIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  LinkSlashIcon,
  MapPinIcon,
} from '@heroicons/react/24/outline';
import Modal from '../components/Modal';

const SettingsPage: React.FC = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'general' | 'system' | 'integrations'>('general');

  // Elvanto integration state
  const [elvantoStatus, setElvantoStatus] = useState<{
    configured: boolean;
    connected: boolean;
    elvantoAccount: string | null;
    loading: boolean;
    error?: string | null;
  }>({
    configured: false,
    connected: false,
    elvantoAccount: null,
    loading: true,
    error: null
  });

  // Elvanto API key input
  const [elvantoApiKey, setElvantoApiKey] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showApiKeyGuide, setShowApiKeyGuide] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);

  // AI integration state
  const [aiStatus, setAiStatus] = useState<{
    configured: boolean;
    provider: string | null;
    loading: boolean;
  }>({ configured: false, provider: null, loading: true });
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiProvider, setAiProvider] = useState<'openai' | 'anthropic'>('openai');
  const [aiSaving, setAiSaving] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAiDisconnectModal, setShowAiDisconnectModal] = useState(false);

  // Planning Center integration state
  const [planningCenterStatus, setPlanningCenterStatus] = useState<{
    enabled: boolean;
    connected: boolean;
    loading: boolean;
    error?: string | null;
  }>({ enabled: false, connected: false, loading: true, error: null });
  const [planningCenterConnecting, setPlanningCenterConnecting] = useState(false);
  const [planningCenterImporting, setPlanningCenterImporting] = useState(false);
  const [planningCenterError, setPlanningCenterError] = useState<string | null>(null);
  const [showPlanningCenterDisconnectModal, setShowPlanningCenterDisconnectModal] = useState(false);
  const [importCheckinsStartDate, setImportCheckinsStartDate] = useState('');
  const [importCheckinsEndDate, setImportCheckinsEndDate] = useState('');

  // Location state
  const [locationName, setLocationName] = useState<string | null>(null);
  const [locationSearch, setLocationSearch] = useState('');
  const [locationResults, setLocationResults] = useState<any[]>([]);
  const [locationSearching, setLocationSearching] = useState(false);
  const [locationSaving, setLocationSaving] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [showLocationDropdown, setShowLocationDropdown] = useState(false);
  const locationDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const locationDropdownRef = useRef<HTMLDivElement>(null);

  const tabs = [
    { id: 'general', name: 'General', icon: PencilIcon },
    { id: 'system', name: 'System Info', icon: InformationCircleIcon },
    { id: 'integrations', name: 'Integrations', icon: LinkIcon },
  ];

  // Fetch Elvanto integration status
  const fetchElvantoStatus = useCallback(async () => {
    try {
      const response = await integrationsAPI.getElvantoStatus();
      const connected = response.data.connected === true;
      setElvantoStatus({
        ...response.data,
        loading: false
      });
      // Update cache for Layout component
      localStorage.setItem('elvanto_connected', connected.toString());
    } catch (error) {
      logger.error('Failed to fetch Elvanto status:', error);
      setElvantoStatus(prev => ({ ...prev, loading: false }));
      // Update cache on error
      localStorage.setItem('elvanto_connected', 'false');
    }
  }, []);

  // Fetch AI status
  const fetchAiStatus = useCallback(async () => {
    try {
      const response = await aiAPI.getStatus();
      setAiStatus({ ...response.data, loading: false });
    } catch (error) {
      logger.error('Failed to fetch AI status:', error);
      setAiStatus(prev => ({ ...prev, loading: false }));
    }
  }, []);

  // Handle AI connect
  const handleAiConnect = async () => {
    if (!aiApiKey.trim()) {
      setAiError('Please enter your API key.');
      return;
    }
    try {
      setAiSaving(true);
      setAiError(null);
      await aiAPI.configure({ apiKey: aiApiKey.trim(), provider: aiProvider });
      setAiApiKey('');
      // Reload so the sidebar picks up the new AI Insights nav item
      window.location.reload();
    } catch (error: any) {
      logger.error('Failed to configure AI:', error);
      setAiError(error.response?.data?.error || error.response?.data?.details || 'Failed to connect. Please check your API key.');
    } finally {
      setAiSaving(false);
    }
  };

  // Handle AI disconnect
  const confirmAiDisconnect = async () => {
    setShowAiDisconnectModal(false);
    try {
      setAiStatus(prev => ({ ...prev, loading: true }));
      await aiAPI.disconnect();
      // Reload so the sidebar removes the AI Insights nav item
      window.location.reload();
    } catch (error: any) {
      logger.error('Failed to disconnect AI:', error);
      setAiStatus(prev => ({ ...prev, loading: false }));
    }
  };

  // Fetch Planning Center integration status
  const fetchPlanningCenterStatus = useCallback(async () => {
    try {
      const response = await integrationsAPI.getPlanningCenterStatus();
      setPlanningCenterStatus({
        enabled: response.data.enabled === true,
        connected: response.data.connected === true,
        loading: false
      });
    } catch (error) {
      logger.error('Failed to fetch Planning Center status:', error);
      setPlanningCenterStatus(prev => ({ ...prev, loading: false }));
    }
  }, []);

  // Handle Planning Center connect (OAuth flow)
  const handlePlanningCenterConnect = async () => {
    try {
      setPlanningCenterConnecting(true);
      setPlanningCenterError(null);
      const response = await integrationsAPI.authorizePlanningCenter();
      // Redirect to Planning Center OAuth page
      window.location.href = response.data.authUrl;
    } catch (error: any) {
      logger.error('Failed to authorize Planning Center:', error);
      setPlanningCenterError(error.response?.data?.error || 'Failed to start authorization.');
      setPlanningCenterConnecting(false);
    }
  };

  // Handle Planning Center disconnect
  const confirmPlanningCenterDisconnect = async () => {
    setShowPlanningCenterDisconnectModal(false);
    try {
      setPlanningCenterStatus(prev => ({ ...prev, loading: true }));
      await integrationsAPI.disconnectPlanningCenter();
      setPlanningCenterStatus({ connected: false, loading: false });
    } catch (error: any) {
      logger.error('Failed to disconnect Planning Center:', error);
      setPlanningCenterStatus(prev => ({ ...prev, loading: false }));
      setPlanningCenterError(error.response?.data?.error || 'Failed to disconnect.');
    }
  };

  // Handle Planning Center import people
  const handlePlanningCenterImportPeople = async () => {
    try {
      setPlanningCenterImporting(true);
      setPlanningCenterError(null);
      const response = await integrationsAPI.importPeopleFromPlanningCenter();
      alert(`Successfully imported ${response.data.imported} people from Planning Center!`);
    } catch (error: any) {
      logger.error('Failed to import people from Planning Center:', error);
      setPlanningCenterError(error.response?.data?.error || 'Failed to import people.');
    } finally {
      setPlanningCenterImporting(false);
    }
  };

  // Handle Planning Center import check-ins
  const handlePlanningCenterImportCheckins = async () => {
    if (!importCheckinsStartDate || !importCheckinsEndDate) {
      setPlanningCenterError('Please select both start and end dates.');
      return;
    }
    try {
      setPlanningCenterImporting(true);
      setPlanningCenterError(null);
      const response = await integrationsAPI.importCheckinsFromPlanningCenter({
        startDate: importCheckinsStartDate,
        endDate: importCheckinsEndDate
      });
      alert(`Successfully fetched ${response.data.checkins?.length || 0} check-ins from Planning Center!`);
      setImportCheckinsStartDate('');
      setImportCheckinsEndDate('');
    } catch (error: any) {
      logger.error('Failed to import check-ins from Planning Center:', error);
      setPlanningCenterError(error.response?.data?.error || 'Failed to import check-ins.');
    } finally {
      setPlanningCenterImporting(false);
    }
  };

  // Fetch church location on mount
  const fetchLocation = useCallback(async () => {
    try {
      const response = await settingsAPI.getAll();
      const settings = response.data.settings;
      if (settings?.location_name) {
        setLocationName(settings.location_name);
      }
    } catch (error) {
      // Non-critical, ignore
    }
  }, []);

  // Location search with debounce
  const handleLocationSearchChange = (value: string) => {
    setLocationSearch(value);
    setLocationError(null);

    if (locationDebounceRef.current) {
      clearTimeout(locationDebounceRef.current);
    }

    if (value.trim().length < 2) {
      setLocationResults([]);
      setShowLocationDropdown(false);
      return;
    }

    locationDebounceRef.current = setTimeout(async () => {
      try {
        setLocationSearching(true);
        const response = await settingsAPI.searchLocation(value.trim());
        setLocationResults(response.data.results || []);
        setShowLocationDropdown(true);
      } catch (error) {
        logger.error('Location search failed:', error);
        setLocationResults([]);
      } finally {
        setLocationSearching(false);
      }
    }, 300);
  };

  // Handle location selection
  const handleLocationSelect = async (result: any) => {
    try {
      setLocationSaving(true);
      setLocationError(null);
      setShowLocationDropdown(false);
      await settingsAPI.updateLocation({
        name: result.displayName,
        lat: result.lat,
        lng: result.lng
      });
      setLocationName(result.displayName);
      setLocationSearch('');
      setLocationResults([]);
    } catch (error: any) {
      logger.error('Failed to save location:', error);
      setLocationError(error.response?.data?.error || 'Failed to save location.');
    } finally {
      setLocationSaving(false);
    }
  };

  // Close location dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (locationDropdownRef.current && !locationDropdownRef.current.contains(e.target as Node)) {
        setShowLocationDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle URL parameters for tab selection and OAuth callbacks
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get('tab');
    if (tabParam && ['general', 'system', 'integrations'].includes(tabParam)) {
      setActiveTab(tabParam as 'general' | 'system' | 'integrations');
    }

    // Handle Planning Center OAuth callback
    const pcoSuccess = urlParams.get('pco_success');
    const pcoError = urlParams.get('pco_error');
    if (pcoSuccess === 'true') {
      alert('Successfully connected to Planning Center!');
      fetchPlanningCenterStatus();
      // Clean up URL
      window.history.replaceState({}, '', '/settings?tab=integrations');
    } else if (pcoError) {
      setPlanningCenterError(decodeURIComponent(pcoError));
      // Clean up URL
      window.history.replaceState({}, '', '/settings?tab=integrations');
    }
  }, [fetchPlanningCenterStatus]);

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

  // Handle Elvanto connect with API key
  const handleElvantoConnect = async () => {
    if (!elvantoApiKey.trim()) {
      setConnectionError('Please enter your Elvanto API key.');
      return;
    }

    try {
      setSavingConfig(true);
      setConnectionError(null);
      await integrationsAPI.connectElvanto(elvantoApiKey.trim());
      setElvantoApiKey(''); // Clear the input
      await fetchElvantoStatus(); // Refresh status (this will update cache)
    } catch (error: any) {
      logger.error('Failed to connect Elvanto:', error);
      setConnectionError(error.response?.data?.error || 'Failed to connect. Please check your API key.');
      // Update cache on error
      localStorage.setItem('elvanto_connected', 'false');
    } finally {
      setSavingConfig(false);
    }
  };

  // Handle Elvanto disconnect
  const handleElvantoDisconnect = async () => {
    setShowDisconnectModal(true);
  };

  const confirmDisconnect = async () => {
    setShowDisconnectModal(false);
    
    try {
      console.log('🔌 [CLIENT] Starting Elvanto disconnect...');
      setElvantoStatus(prev => ({ ...prev, loading: true }));
      
      // CRITICAL: Clear all Elvanto-related localStorage items to prevent re-sync
      // The userPreferences service syncs localStorage items with prefix "preference_" to database
      console.log('🔌 [CLIENT] Clearing Elvanto localStorage items...');
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.includes('elvanto') || key.includes('Elvanto'))) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => {
        console.log(`🔌 [CLIENT] Removing localStorage key: ${key}`);
        localStorage.removeItem(key);
      });
      
      // Also clear the elvanto_connected status
      localStorage.setItem('elvanto_connected', 'false');
      
      setElvantoStatus({
        configured: false,
        connected: false,
        elvantoAccount: null,
        loading: false,
        error: null
      });
      
      // Perform the disconnect
      console.log('🔌 [CLIENT] Calling disconnectElvanto API...');
      const disconnectResponse = await integrationsAPI.disconnectElvanto();
      console.log('🔌 [CLIENT] Disconnect API response:', disconnectResponse);
      
      // Verify the disconnect by checking status after a brief delay
      // This ensures the database transaction has committed
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Refresh status to confirm disconnect (this should return disconnected)
      const statusResponse = await integrationsAPI.getElvantoStatus();
      const connected = statusResponse.data.connected === true;
      
      console.log('🔌 [CLIENT] Status check after disconnect:', {
        connected,
        configured: statusResponse.data.configured,
        fullResponse: statusResponse.data
      });
      
      // Update state based on actual API response
      setElvantoStatus({
        ...statusResponse.data,
        loading: false
      });
      localStorage.setItem('elvanto_connected', connected.toString());
      
      // If still showing as connected, something went wrong
      if (connected) {
        console.error('🔌 [CLIENT] ERROR: Status still shows connected after disconnect!', statusResponse.data);
        logger.error('Elvanto disconnect may have failed - status still shows connected', statusResponse.data);
        // Force disconnected state
        setElvantoStatus({
          configured: false,
          connected: false,
          elvantoAccount: null,
          loading: false,
          error: 'Disconnect may have failed. Please try again.'
        });
        localStorage.setItem('elvanto_connected', 'false');
      } else {
        console.log('🔌 [CLIENT] Successfully disconnected - status confirmed');
        // Refresh the page to remove the "Import from Elvanto" menu option
        window.location.reload();
      }
    } catch (error: any) {
      console.error('🔌 [CLIENT] Disconnect error:', error);
      console.error('🔌 [CLIENT] Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        config: error.config
      });
      logger.error('Failed to disconnect Elvanto:', error);
      // Update cache and status on error
      localStorage.setItem('elvanto_connected', 'false');
      setElvantoStatus(prev => ({
        ...prev,
        connected: false,
        configured: false,
        loading: false,
        error: error.response?.data?.error || 'Failed to disconnect Elvanto'
      }));
    }
  };

  // Load Elvanto + AI + Planning Center status + location on mount
  useEffect(() => {
    fetchElvantoStatus();
    fetchAiStatus();
    fetchPlanningCenterStatus();
    fetchLocation();
  }, [fetchElvantoStatus, fetchAiStatus, fetchPlanningCenterStatus, fetchLocation]);

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
                  </dl>
                </div>
              </div>

              {/* Church Location */}
              {user?.role === 'admin' && (
                <div>
                  <h3 className="text-lg font-medium text-gray-900">Church Location</h3>
                  <p className="mt-1 text-sm text-gray-600">
                    Set your church's location to enable weather and holiday-aware attendance predictions.
                  </p>

                  <div className="mt-4 bg-gray-50 rounded-lg p-4">
                    {locationName && (
                      <div className="flex items-center mb-4 text-sm text-gray-900">
                        <MapPinIcon className="h-5 w-5 text-gray-400 mr-2 flex-shrink-0" />
                        <span className="font-medium">{locationName}</span>
                      </div>
                    )}

                    <div className="relative" ref={locationDropdownRef}>
                      <label htmlFor="location-search" className="block text-sm font-medium text-gray-700">
                        {locationName ? 'Change location' : 'Search for your city'}
                      </label>
                      <div className="mt-1 relative">
                        <input
                          type="text"
                          id="location-search"
                          value={locationSearch}
                          onChange={(e) => handleLocationSearchChange(e.target.value)}
                          onFocus={() => {
                            if (locationResults.length > 0) setShowLocationDropdown(true);
                          }}
                          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm pr-10"
                          placeholder="e.g. Sydney, London, New York..."
                          disabled={locationSaving}
                        />
                        {locationSearching && (
                          <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                            <ArrowPathIcon className="h-4 w-4 animate-spin text-gray-400" />
                          </div>
                        )}
                      </div>

                      {/* Dropdown results */}
                      {showLocationDropdown && locationResults.length > 0 && (
                        <div className="absolute z-10 mt-1 w-full bg-white shadow-lg rounded-md border border-gray-200 max-h-60 overflow-auto">
                          {locationResults.map((result, idx) => (
                            <button
                              key={idx}
                              onClick={() => handleLocationSelect(result)}
                              className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0 transition-colors"
                            >
                              <div className="text-sm font-medium text-gray-900">
                                {result.name}
                              </div>
                              <div className="text-xs text-gray-500">
                                {[result.admin1, result.country].filter(Boolean).join(', ')}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {locationSaving && (
                      <p className="mt-2 text-sm text-primary-600 flex items-center">
                        <ArrowPathIcon className="h-4 w-4 animate-spin mr-1" />
                        Saving location...
                      </p>
                    )}

                    {locationError && (
                      <p className="mt-2 text-sm text-red-600">{locationError}</p>
                    )}
                  </div>
                </div>
              )}
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

          {activeTab === 'integrations' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900">External Integrations</h3>
                <p className="mt-1 text-sm text-gray-600">
                  Connect your account with external services to enhance your church management experience.
                </p>

                <div className="mt-6 space-y-6">
                  {/* Elvanto Integration */}
                  <div className="border border-gray-200 rounded-lg p-6">
                    {/* Connection Status Header */}
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center space-x-4">
                        <div className="flex-shrink-0">
                          <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                            <svg className="w-6 h-6 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                            </svg>
                          </div>
                        </div>
                        <div>
                          <h4 className="text-lg font-medium text-gray-900">Elvanto</h4>
                          <p className="text-sm text-gray-600">
                            Import people and families from your Elvanto account.
                          </p>
                          {elvantoStatus.connected && (
                            <p className="text-xs text-green-600 mt-1 flex items-center">
                              <CheckCircleIcon className="w-3 h-3 mr-1" />
                              {elvantoStatus.elvantoAccount || 'Connected'}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        {elvantoStatus.loading ? (
                          <ArrowPathIcon className="w-5 h-5 animate-spin text-gray-400" />
                        ) : elvantoStatus.connected ? (
                              <>
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  <ShieldCheckIcon className="w-3 h-3 mr-1" />
                                  Connected
                                </span>
                                <button
                                  onClick={handleElvantoDisconnect}
                              className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                                >
                                  Disconnect
                                </button>
                              </>
                        ) : (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                                <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                                Not Connected
                              </span>
                        )}
                      </div>
                    </div>

                    {/* API Key Connection Form - Only show when not connected */}
                    {!elvantoStatus.connected && !elvantoStatus.loading && (
                      <div className="border-t border-gray-200 pt-6">
                        <div className="flex items-center justify-between mb-4">
                          <h5 className="text-md font-medium text-gray-900">Connect with API Key</h5>
                          <button
                            onClick={() => setShowApiKeyGuide(true)}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                          >
                            <InformationCircleIcon className="h-4 w-4 mr-1.5" />
                            How to get API Key
                          </button>
                        </div>
                        
                        <div className="space-y-4">
                          <div>
                            <label htmlFor="elvanto-api-key" className="block text-sm font-medium text-gray-700">
                              Elvanto API Key
                            </label>
                            <input
                              type="password"
                              id="elvanto-api-key"
                              value={elvantoApiKey}
                              onChange={(e) => setElvantoApiKey(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && handleElvantoConnect()}
                              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                              placeholder="Paste your Elvanto API key here"
                            />
                            <p className="mt-1 text-xs text-gray-500">
                              Your API key is stored securely and only used to access your Elvanto data.
                            </p>
                          </div>

                          {/* Connection Error */}
                          {connectionError && (
                            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                              <div className="flex">
                                <ShieldExclamationIcon className="h-5 w-5 text-red-400 flex-shrink-0" />
                                <div className="ml-2">
                                  <p className="text-sm text-red-700">{connectionError}</p>
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="flex justify-end">
                            <button
                              onClick={handleElvantoConnect}
                              disabled={savingConfig || !elvantoApiKey.trim()}
                              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {savingConfig ? (
                                <>
                                  <ArrowPathIcon className="h-4 w-4 mr-2 animate-spin" />
                                  Connecting...
                                </>
                              ) : (
                                <>
                                  <LinkIcon className="h-4 w-4 mr-2" />
                                  Connect
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex">
                        <div className="flex-shrink-0">
                          <InformationCircleIcon className="h-5 w-5 text-blue-400" />
                        </div>
                        <div className="ml-3">
                          <h4 className="text-sm font-medium text-blue-800">What you'll get</h4>
                          <div className="mt-2 text-sm text-blue-700">
                            <ul className="list-disc list-inside space-y-1">
                              <li>Sync people data between systems</li>
                              <li>Automated attendance tracking</li>
                              <li>Seamless integration with your existing workflow</li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* AI Insights Integration */}
                  <div className="border border-gray-200 rounded-lg p-6">
                    {/* AI Status Header */}
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center space-x-4">
                        <div className="flex-shrink-0">
                          <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                            <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                            </svg>
                          </div>
                        </div>
                        <div>
                          <h4 className="text-lg font-medium text-gray-900">AI Insights</h4>
                          <p className="text-sm text-gray-600">
                            Ask questions about your attendance data in plain language.
                          </p>
                          {aiStatus.configured && (
                            <p className="text-xs text-green-600 mt-1 flex items-center">
                              <CheckCircleIcon className="w-3 h-3 mr-1" />
                              Connected via {aiStatus.provider === 'openai' ? 'OpenAI' : 'Anthropic'}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        {aiStatus.loading ? (
                          <ArrowPathIcon className="w-5 h-5 animate-spin text-gray-400" />
                        ) : aiStatus.configured ? (
                          <>
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              <ShieldCheckIcon className="w-3 h-3 mr-1" />
                              Connected
                            </span>
                            <button
                              onClick={() => setShowAiDisconnectModal(true)}
                              className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
                            >
                              Disconnect
                            </button>
                          </>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                            <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                            Not Connected
                          </span>
                        )}
                      </div>
                    </div>

                    {/* AI Config Form - Only show when not connected */}
                    {!aiStatus.configured && !aiStatus.loading && (
                      <div className="border-t border-gray-200 pt-6">
                        <h5 className="text-md font-medium text-gray-900 mb-4">Connect your AI provider</h5>
                        <div className="space-y-4">
                          <div>
                            <label htmlFor="ai-provider" className="block text-sm font-medium text-gray-700">
                              AI Provider
                            </label>
                            <select
                              id="ai-provider"
                              value={aiProvider}
                              onChange={(e) => setAiProvider(e.target.value as 'openai' | 'anthropic')}
                              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                            >
                              <option value="openai">OpenAI (ChatGPT)</option>
                              <option value="anthropic">Anthropic (Claude)</option>
                            </select>
                          </div>
                          <div>
                            <label htmlFor="ai-api-key" className="block text-sm font-medium text-gray-700">
                              API Key
                            </label>
                            <input
                              type="password"
                              id="ai-api-key"
                              value={aiApiKey}
                              onChange={(e) => setAiApiKey(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && handleAiConnect()}
                              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                              placeholder={aiProvider === 'openai' ? 'sk-...' : 'sk-ant-...'}
                            />
                            <p className="mt-1 text-xs text-gray-500">
                              {aiProvider === 'openai'
                                ? 'Get your key from platform.openai.com/api-keys'
                                : 'Get your key from console.anthropic.com/settings/keys'}
                            </p>
                          </div>

                          {aiError && (
                            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                              <div className="flex">
                                <ShieldExclamationIcon className="h-5 w-5 text-red-400 flex-shrink-0" />
                                <div className="ml-2">
                                  <p className="text-sm text-red-700">{aiError}</p>
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="flex justify-end">
                            <button
                              onClick={handleAiConnect}
                              disabled={aiSaving || !aiApiKey.trim()}
                              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {aiSaving ? (
                                <>
                                  <ArrowPathIcon className="h-4 w-4 mr-2 animate-spin" />
                                  Validating...
                                </>
                              ) : (
                                <>
                                  <LinkIcon className="h-4 w-4 mr-2" />
                                  Connect
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="mt-4 bg-purple-50 border border-purple-200 rounded-lg p-4">
                      <div className="flex">
                        <div className="flex-shrink-0">
                          <InformationCircleIcon className="h-5 w-5 text-purple-400" />
                        </div>
                        <div className="ml-3">
                          <h4 className="text-sm font-medium text-purple-800">What you'll get</h4>
                          <div className="mt-2 text-sm text-purple-700">
                            <ul className="list-disc list-inside space-y-1">
                              <li>Ask questions about attendance in plain English</li>
                              <li>Get insights on attendance trends and patterns</li>
                              <li>Identify people who may need pastoral follow-up</li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Planning Center Integration - Only show if enabled */}
                  {planningCenterStatus.enabled && (
                  <div className="border border-gray-200 rounded-lg p-6">
                    {/* Connection Status Header */}
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center space-x-4">
                        <div className="flex-shrink-0">
                          <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                            <svg className="w-6 h-6 text-green-600" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                            </svg>
                          </div>
                        </div>
                        <div>
                          <h4 className="text-lg font-medium text-gray-900">Planning Center</h4>
                          <p className="text-sm text-gray-600">
                            Import people and check-ins from Planning Center Online.
                          </p>
                          {planningCenterStatus.connected && (
                            <p className="text-xs text-green-600 mt-1 flex items-center">
                              <CheckCircleIcon className="w-3 h-3 mr-1" />
                              Connected
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        {planningCenterStatus.loading ? (
                          <ArrowPathIcon className="w-5 h-5 animate-spin text-gray-400" />
                        ) : planningCenterStatus.connected ? (
                          <>
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              <ShieldCheckIcon className="w-3 h-3 mr-1" />
                              Connected
                            </span>
                            <button
                              onClick={() => setShowPlanningCenterDisconnectModal(true)}
                              className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                            >
                              Disconnect
                            </button>
                          </>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                            <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                            Not Connected
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Connection/Import Form */}
                    {!planningCenterStatus.loading && (
                      <div className="border-t border-gray-200 pt-6">
                        {!planningCenterStatus.connected ? (
                          <div>
                            <h5 className="text-md font-medium text-gray-900 mb-4">Connect to Planning Center</h5>
                            <p className="text-sm text-gray-600 mb-4">
                              You'll be redirected to Planning Center to authorize access. We'll only access your people and check-in data.
                            </p>

                            {planningCenterError && (
                              <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3">
                                <div className="flex">
                                  <ShieldExclamationIcon className="h-5 w-5 text-red-400 flex-shrink-0" />
                                  <div className="ml-2">
                                    <p className="text-sm text-red-700">{planningCenterError}</p>
                                  </div>
                                </div>
                              </div>
                            )}

                            <div className="flex justify-end">
                              <button
                                onClick={handlePlanningCenterConnect}
                                disabled={planningCenterConnecting}
                                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {planningCenterConnecting ? (
                                  <>
                                    <ArrowPathIcon className="h-4 w-4 mr-2 animate-spin" />
                                    Connecting...
                                  </>
                                ) : (
                                  <>
                                    <LinkIcon className="h-4 w-4 mr-2" />
                                    Connect Planning Center
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-6">
                            <h5 className="text-md font-medium text-gray-900">Import Data</h5>

                            {planningCenterError && (
                              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                                <div className="flex">
                                  <ShieldExclamationIcon className="h-5 w-5 text-red-400 flex-shrink-0" />
                                  <div className="ml-2">
                                    <p className="text-sm text-red-700">{planningCenterError}</p>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Import People */}
                            <div className="bg-gray-50 rounded-lg p-4">
                              <h6 className="text-sm font-medium text-gray-900 mb-2">Import People</h6>
                              <p className="text-sm text-gray-600 mb-3">
                                Import all people from Planning Center, grouped by household.
                              </p>
                              <button
                                onClick={handlePlanningCenterImportPeople}
                                disabled={planningCenterImporting}
                                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {planningCenterImporting ? (
                                  <>
                                    <ArrowPathIcon className="h-4 w-4 mr-2 animate-spin" />
                                    Importing...
                                  </>
                                ) : (
                                  'Import People'
                                )}
                              </button>
                            </div>

                            {/* Import Check-ins */}
                            <div className="bg-gray-50 rounded-lg p-4">
                              <h6 className="text-sm font-medium text-gray-900 mb-2">Import Check-ins</h6>
                              <p className="text-sm text-gray-600 mb-3">
                                Fetch check-in data for a date range.
                              </p>
                              <div className="grid grid-cols-2 gap-3 mb-3">
                                <div>
                                  <label htmlFor="checkins-start-date" className="block text-xs font-medium text-gray-700 mb-1">
                                    Start Date
                                  </label>
                                  <input
                                    type="date"
                                    id="checkins-start-date"
                                    value={importCheckinsStartDate}
                                    onChange={(e) => setImportCheckinsStartDate(e.target.value)}
                                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-green-500 focus:ring-green-500 text-sm"
                                  />
                                </div>
                                <div>
                                  <label htmlFor="checkins-end-date" className="block text-xs font-medium text-gray-700 mb-1">
                                    End Date
                                  </label>
                                  <input
                                    type="date"
                                    id="checkins-end-date"
                                    value={importCheckinsEndDate}
                                    onChange={(e) => setImportCheckinsEndDate(e.target.value)}
                                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-green-500 focus:ring-green-500 text-sm"
                                  />
                                </div>
                              </div>
                              <button
                                onClick={handlePlanningCenterImportCheckins}
                                disabled={planningCenterImporting || !importCheckinsStartDate || !importCheckinsEndDate}
                                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {planningCenterImporting ? (
                                  <>
                                    <ArrowPathIcon className="h-4 w-4 mr-2 animate-spin" />
                                    Importing...
                                  </>
                                ) : (
                                  'Import Check-ins'
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-4">
                      <div className="flex">
                        <div className="flex-shrink-0">
                          <InformationCircleIcon className="h-5 w-5 text-green-400" />
                        </div>
                        <div className="ml-3">
                          <h4 className="text-sm font-medium text-green-800">What you'll get</h4>
                          <div className="mt-2 text-sm text-green-700">
                            <ul className="list-disc list-inside space-y-1">
                              <li>Import people with household grouping</li>
                              <li>Sync check-in data for attendance tracking</li>
                              <li>Seamless integration with Planning Center Online</li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* API Key Setup Guide Modal */}
      <Modal
        isOpen={showApiKeyGuide}
        onClose={() => setShowApiKeyGuide(false)}
        className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-gray-900">How to Get Your Elvanto API Key</h2>
            <button
              onClick={() => setShowApiKeyGuide(false)}
              className="text-gray-400 hover:text-gray-500 focus:outline-none"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          <div className="space-y-6">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-800">
                Follow these simple steps to get your API key from Elvanto. You'll need admin access to your Elvanto account.
              </p>
            </div>

            {/* Step 1 */}
            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    1
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900">Log in to Elvanto</h3>
                  <p className="mt-2 text-sm text-gray-600">
                    Go to <a href="https://www.elvanto.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline">elvanto.com</a> and log in with your admin account.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    2
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900">Go to Settings → Integrations</h3>
                  <p className="mt-2 text-sm text-gray-600">
                    Click on <strong>Settings</strong> in the top menu, then select <strong>Integrations</strong> from the sidebar.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    3
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900">Find API Access</h3>
                  <p className="mt-2 text-sm text-gray-600">
                    Look for <strong>API Access</strong> or <strong>Developer</strong> section. Click on it to view your API keys.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 4 */}
            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    4
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900">Copy Your API Key</h3>
                  <p className="mt-2 text-sm text-gray-600">
                    Copy your API key and paste it into the field above. If you don't have one, you can generate a new key from this page.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="flex">
                <InformationCircleIcon className="h-5 w-5 text-yellow-400 flex-shrink-0" />
                <div className="ml-3">
                  <h4 className="text-sm font-medium text-yellow-800">Keep Your API Key Secure</h4>
                  <p className="mt-1 text-sm text-yellow-700">
                    Your API key provides access to your Elvanto data. Keep it private and don't share it publicly.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => setShowApiKeyGuide(false)}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Elvanto Disconnect Confirmation Modal */}
      <Modal
        isOpen={showDisconnectModal}
        onClose={() => setShowDisconnectModal(false)}
      >
        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                Disconnect Elvanto
              </h3>
              <button
                onClick={() => setShowDisconnectModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-yellow-100 rounded-full">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600" />
            </div>
            
            <div className="text-center mb-6">
              <p className="text-sm text-gray-600 mb-2">
                Are you sure you want to disconnect from Elvanto?
              </p>
              <p className="text-sm text-gray-500">
                This will stop syncing data between the services. You can reconnect at any time.
              </p>
            </div>
            
            <div className="flex space-x-3">
              <button
                onClick={() => setShowDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDisconnect}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
              >
                <LinkSlashIcon className="h-4 w-4 mr-2" />
                Disconnect
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* AI Disconnect Confirmation Modal */}
      <Modal
        isOpen={showAiDisconnectModal}
        onClose={() => setShowAiDisconnectModal(false)}
      >
        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                Disconnect AI
              </h3>
              <button
                onClick={() => setShowAiDisconnectModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-yellow-100 rounded-full">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600" />
            </div>

            <div className="text-center mb-6">
              <p className="text-sm text-gray-600 mb-2">
                Are you sure you want to disconnect AI Insights?
              </p>
              <p className="text-sm text-gray-500">
                Your API key will be removed. You can reconnect at any time.
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowAiDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmAiDisconnect}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
              >
                <LinkSlashIcon className="h-4 w-4 mr-2" />
                Disconnect
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Planning Center Disconnect Confirmation Modal */}
      <Modal
        isOpen={showPlanningCenterDisconnectModal}
        onClose={() => setShowPlanningCenterDisconnectModal(false)}
      >
        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                Disconnect Planning Center
              </h3>
              <button
                onClick={() => setShowPlanningCenterDisconnectModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-yellow-100 rounded-full">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600" />
            </div>

            <div className="text-center mb-6">
              <p className="text-sm text-gray-600 mb-2">
                Are you sure you want to disconnect from Planning Center?
              </p>
              <p className="text-sm text-gray-500">
                Your OAuth tokens will be removed. You can reconnect at any time.
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowPlanningCenterDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmPlanningCenterDisconnect}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
              >
                <LinkSlashIcon className="h-4 w-4 mr-2" />
                Disconnect
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default SettingsPage; 