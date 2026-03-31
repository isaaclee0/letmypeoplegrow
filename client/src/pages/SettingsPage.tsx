import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { usersAPI, integrationsAPI, aiAPI, settingsAPI, visitorConfigAPI, takeoutAPI } from '../services/api';
import logger from '../utils/logger';
import { getChildBadgeStyles } from '../utils/colorUtils';
import BadgeIcon, { BADGE_ICON_OPTIONS, BadgeIconType } from '../components/icons/BadgeIcon';

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
  UserIcon,
  ArrowDownTrayIcon,
  BellIcon,
} from '@heroicons/react/24/outline';
import Modal from '../components/Modal';

const SettingsPage: React.FC = () => {
  const { user, updateUser } = useAuth();
  const [activeTab, setActiveTab] = useState<'general' | 'myinfo' | 'notifications' | 'integrations' | 'data'>('general');

  // My Info (profile) state
  const [profileFirstName, setProfileFirstName] = useState('');
  const [profileLastName, setProfileLastName] = useState('');
  const [profileEmail, setProfileEmail] = useState('');
  const [profileMobileNumber, setProfileMobileNumber] = useState('');
  const [profilePrimaryContactMethod, setProfilePrimaryContactMethod] = useState<'email' | 'sms'>('email');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState('');
  const [profileError, setProfileError] = useState('');

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
  const [aiProvider, setAiProvider] = useState<'openai' | 'anthropic' | 'grok'>('openai');
  const [aiSaving, setAiSaving] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAiDisconnectModal, setShowAiDisconnectModal] = useState(false);

  // Planning Center integration state
  const [planningCenterStatus, setPlanningCenterStatus] = useState<{
    enabled: boolean;
    connected: boolean;
    loading: boolean;
  }>({ enabled: false, connected: false, loading: true });
  const [planningCenterConnecting, setPlanningCenterConnecting] = useState(false);
  const [planningCenterError, setPlanningCenterError] = useState<string | null>(null);
  const [showPlanningCenterDisconnectModal, setShowPlanningCenterDisconnectModal] = useState(false);

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

  // Default badge state - child
  const [childBadgeText, setChildBadgeText] = useState<string>('');
  const [childBadgeColor, setChildBadgeColor] = useState<string>('#c5aefb');
  const [childBadgeIcon, setChildBadgeIcon] = useState<string>('person');

  // Default badge state - adult
  const [adultBadgeText, setAdultBadgeText] = useState<string>('');
  const [adultBadgeColor, setAdultBadgeColor] = useState<string>('');
  const [adultBadgeIcon, setAdultBadgeIcon] = useState<string>('');

  // Weekly review email state
  const [weeklyReviewEnabled, setWeeklyReviewEnabled] = useState(true);
  const [weeklyReviewDay, setWeeklyReviewDay] = useState<string | null>(null);
  const [weeklyReviewDetectedDay, setWeeklyReviewDetectedDay] = useState('Monday');
  const [weeklyReviewIncludeInsight, setWeeklyReviewIncludeInsight] = useState(true);
  const [weeklyReviewLastSent, setWeeklyReviewLastSent] = useState<string | null>(null);
  const [weeklyReviewLoading, setWeeklyReviewLoading] = useState(false);
  const [weeklyReviewSaving, setWeeklyReviewSaving] = useState(false);
  const [weeklyReviewTestSending, setWeeklyReviewTestSending] = useState(false);
  const [weeklyReviewSuccess, setWeeklyReviewSuccess] = useState('');
  const [weeklyReviewError, setWeeklyReviewError] = useState('');

  // Track original values to detect changes
  const [originalBadgeSettings, setOriginalBadgeSettings] = useState({
    childText: '',
    childColor: '#c5aefb',
    childIcon: 'person',
    adultText: '',
    adultColor: '',
    adultIcon: ''
  });

  const [defaultBadgeSaving, setDefaultBadgeSaving] = useState(false);
  const [defaultBadgeError, setDefaultBadgeError] = useState<string | null>(null);
  const [defaultBadgeSuccess, setDefaultBadgeSuccess] = useState(false);

  // Check if badge settings have unsaved changes
  const hasUnsavedBadgeChanges =
    childBadgeText !== originalBadgeSettings.childText ||
    childBadgeColor !== originalBadgeSettings.childColor ||
    childBadgeIcon !== originalBadgeSettings.childIcon ||
    adultBadgeText !== originalBadgeSettings.adultText ||
    adultBadgeColor !== originalBadgeSettings.adultColor ||
    adultBadgeIcon !== originalBadgeSettings.adultIcon;

  // Visitor config state
  const [visitorConfig, setVisitorConfig] = useState({
    localVisitorServiceLimit: 6,
    travellerVisitorServiceLimit: 2
  });
  const [visitorConfigLoading, setVisitorConfigLoading] = useState(false);
  const [visitorConfigSuccess, setVisitorConfigSuccess] = useState(false);

  const tabs = [
    { id: 'general', name: 'General', icon: PencilIcon },
    { id: 'myinfo', name: 'My Info', icon: UserIcon },
    ...(user?.role === 'admin' ? [{ id: 'notifications', name: 'Notifications', icon: BellIcon }] : []),
    ...(user?.role === 'admin' ? [{ id: 'integrations', name: 'Integrations', icon: LinkIcon }] : []),
    ...(user?.role === 'admin' ? [{ id: 'data', name: 'Data', icon: ArrowDownTrayIcon }] : []),
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
      // Clear cached preference so sync doesn't re-insert it
      localStorage.removeItem('preference_ai_config');
      // Reload so the sidebar removes the AI Insights nav item
      window.location.reload();
    } catch (error: any) {
      logger.error('Failed to disconnect AI:', error);
      setAiStatus(prev => ({ ...prev, loading: false }));
    }
  };

  // Fetch Planning Center status
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
      setPlanningCenterStatus({ enabled: true, connected: false, loading: false });
    } catch (error: any) {
      logger.error('Failed to disconnect Planning Center:', error);
      setPlanningCenterStatus(prev => ({ ...prev, loading: false }));
      setPlanningCenterError(error.response?.data?.error || 'Failed to disconnect.');
    }
  };

  // Fetch church settings on mount
  const fetchLocation = useCallback(async () => {
    try {
      const response = await settingsAPI.getAll();
      const settings = response.data.settings;
      if (settings?.location_name) {
        setLocationName(settings.location_name);
      }

      // Child badge settings
      const childText = settings?.default_badge_text || '';
      const childColor = settings?.child_flair_color || '#c5aefb';
      // Allow empty string for "None" - only default to 'person' if null/undefined
      const childIcon = settings?.default_child_badge_icon !== null && settings?.default_child_badge_icon !== undefined
        ? settings.default_child_badge_icon
        : 'person';
      setChildBadgeText(childText);
      setChildBadgeColor(childColor);
      setChildBadgeIcon(childIcon);

      // Adult badge settings
      const adultText = settings?.default_adult_badge_text || '';
      const adultColor = settings?.default_adult_badge_color || '';
      const adultIcon = settings?.default_adult_badge_icon || '';
      setAdultBadgeText(adultText);
      setAdultBadgeColor(adultColor);
      setAdultBadgeIcon(adultIcon);

      // Store original values for change detection
      setOriginalBadgeSettings({
        childText,
        childColor,
        childIcon,
        adultText,
        adultColor,
        adultIcon
      });
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

  // Save badge settings
  const handleSaveBadgeSettings = async () => {
    setDefaultBadgeError(null);
    setDefaultBadgeSuccess(false);
    setDefaultBadgeSaving(true);
    try {
      await settingsAPI.updateDefaultBadge({
        child_text: childBadgeText,
        child_color: childBadgeColor,
        child_icon: childBadgeIcon,
        adult_text: adultBadgeText,
        adult_color: adultBadgeColor,
        adult_icon: adultBadgeIcon
      });

      // Update original values to reflect saved state
      setOriginalBadgeSettings({
        childText: childBadgeText,
        childColor: childBadgeColor,
        childIcon: childBadgeIcon,
        adultText: adultBadgeText,
        adultColor: adultBadgeColor,
        adultIcon: adultBadgeIcon
      });

      setDefaultBadgeSuccess(true);
      setTimeout(() => setDefaultBadgeSuccess(false), 3000);
    } catch (error: any) {
      logger.error('Failed to save default badge:', error);
      setDefaultBadgeError(error.response?.data?.error || 'Failed to save badge settings.');
    } finally {
      setDefaultBadgeSaving(false);
    }
  };

  const handleResetChildBadge = () => {
    setChildBadgeText('');
    setChildBadgeColor('#c5aefb');
    setChildBadgeIcon('person');
  };

  const handleResetAdultBadge = () => {
    setAdultBadgeText('');
    setAdultBadgeColor('');
    setAdultBadgeIcon('');
  };

  // Handle URL parameters for tab selection and OAuth callbacks
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get('tab');
    if (tabParam && ['general', 'myinfo', 'notifications', 'integrations', 'data'].includes(tabParam)) {
      setActiveTab(tabParam as 'general' | 'myinfo' | 'notifications' | 'integrations' | 'data');
    }

    // Handle Planning Center OAuth callback
    const pcoSuccess = urlParams.get('pco_success');
    const pcoError = urlParams.get('pco_error');
    if (pcoSuccess === 'true') {
      setActiveTab('integrations');
      alert('Successfully connected to Planning Center!');
      fetchPlanningCenterStatus();
      window.history.replaceState({}, '', '/app/settings?tab=integrations');
    } else if (pcoError) {
      setActiveTab('integrations');
      setPlanningCenterError(decodeURIComponent(pcoError));
      window.history.replaceState({}, '', '/app/settings?tab=integrations');
    }
  }, [fetchPlanningCenterStatus]);

  // Load visitor config when general tab is active (visitor settings are in general)
  useEffect(() => {
    if (activeTab === 'general' && user?.role === 'admin') {
      visitorConfigAPI.getConfig().then(res => {
        setVisitorConfig(res.data);
      }).catch(err => {
        logger.error('Failed to load visitor config:', err);
      });
    }
  }, [activeTab, user?.role]);

  const saveVisitorConfig = async () => {
    setVisitorConfigLoading(true);
    setVisitorConfigSuccess(false);
    try {
      await visitorConfigAPI.updateConfig(visitorConfig);
      setVisitorConfigSuccess(true);
      setTimeout(() => setVisitorConfigSuccess(false), 3000);
    } catch (err) {
      logger.error('Failed to save visitor config:', err);
    } finally {
      setVisitorConfigLoading(false);
    }
  };

  // Load weekly review settings when notifications tab is active
  useEffect(() => {
    if (activeTab === 'notifications' && user?.role === 'admin') {
      setWeeklyReviewLoading(true);
      settingsAPI.getWeeklyReview().then(res => {
        setWeeklyReviewEnabled(res.data.enabled);
        setWeeklyReviewDay(res.data.day);
        setWeeklyReviewDetectedDay(res.data.detectedDay || 'Monday');
        setWeeklyReviewIncludeInsight(res.data.includeInsight);
        setWeeklyReviewLastSent(res.data.lastSent);
      }).catch(err => {
        logger.error('Failed to load weekly review settings:', err);
      }).finally(() => {
        setWeeklyReviewLoading(false);
      });
    }
  }, [activeTab, user?.role]);

  const saveWeeklyReview = async (updates: { enabled?: boolean; day?: string | null; includeInsight?: boolean }) => {
    setWeeklyReviewSaving(true);
    setWeeklyReviewSuccess('');
    setWeeklyReviewError('');
    try {
      await settingsAPI.updateWeeklyReview(updates);
      setWeeklyReviewSuccess('Settings saved');
      setTimeout(() => setWeeklyReviewSuccess(''), 3000);
    } catch (err: any) {
      setWeeklyReviewError(err.response?.data?.error || 'Failed to save settings');
    } finally {
      setWeeklyReviewSaving(false);
    }
  };

  const sendTestWeeklyReview = async () => {
    setWeeklyReviewTestSending(true);
    setWeeklyReviewSuccess('');
    setWeeklyReviewError('');
    try {
      const res = await settingsAPI.sendTestWeeklyReview();
      setWeeklyReviewSuccess(res.data.message || 'Test email sent!');
      setTimeout(() => setWeeklyReviewSuccess(''), 5000);
    } catch (err: any) {
      setWeeklyReviewError(err.response?.data?.error || 'Failed to send test email');
    } finally {
      setWeeklyReviewTestSending(false);
    }
  };

  // Data takeout state
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [churchName, setChurchName] = useState('');

  // Load church name when data tab is active
  useEffect(() => {
    if (activeTab === 'data' && user?.role === 'admin') {
      settingsAPI.getAll().then(res => {
        setChurchName(res.data.settings?.church_name || '');
      }).catch(err => {
        logger.error('Failed to load church name:', err);
      });
    }
  }, [activeTab, user?.role]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const response = await takeoutAPI.exportData();
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = `data-export-${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      logger.error('Export failed:', err);
      alert('Failed to export data. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await takeoutAPI.deleteChurch(deleteConfirmName);
      // Redirect to login after deletion
      window.location.href = '/login';
    } catch (err: any) {
      logger.error('Delete failed:', err);
      alert(err.response?.data?.error || 'Failed to delete organisation account. Please try again.');
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  // Load profile data when My Info tab is active
  useEffect(() => {
    if (activeTab === 'myinfo' && user) {
      setProfileFirstName(user.firstName || '');
      setProfileLastName(user.lastName || '');
      setProfileEmail(user.email || '');
      setProfileMobileNumber(user.mobileNumber || '');
      setProfilePrimaryContactMethod(user.primaryContactMethod);
    }
  }, [activeTab, user]);

  const handleProfileSave = async () => {
    if (!user) return;
    setProfileError('');
    setProfileSuccess('');

    if (!profileFirstName || !profileLastName) {
      setProfileError('First name and last name are required');
      return;
    }
    if (profilePrimaryContactMethod === 'email' && !profileEmail) {
      setProfileError('Email is required when primary contact method is email');
      return;
    }
    if (profilePrimaryContactMethod === 'sms' && !profileMobileNumber) {
      setProfileError('Mobile number is required when primary contact method is SMS');
      return;
    }
    if (!profileEmail && !profileMobileNumber) {
      setProfileError('Provide at least an email or a mobile number');
      return;
    }

    setProfileSaving(true);
    try {
      const payload = {
        firstName: profileFirstName,
        lastName: profileLastName,
        email: profileEmail === '' ? null : profileEmail,
        mobileNumber: profileMobileNumber === '' ? null : profileMobileNumber,
        primaryContactMethod: profilePrimaryContactMethod,
      };
      await usersAPI.updateMe(payload);
      updateUser({
        firstName: profileFirstName,
        lastName: profileLastName,
        email: profileEmail || undefined,
        mobileNumber: profileMobileNumber || undefined,
        primaryContactMethod: profilePrimaryContactMethod,
      });
      setProfileSuccess('Profile updated');
    } catch (err: any) {
      const serverErrors = err.response?.data?.errors;
      const message = err.response?.data?.error || (Array.isArray(serverErrors) && serverErrors[0]?.msg) || 'Failed to update profile';
      setProfileError(message);
    } finally {
      setProfileSaving(false);
    }
  };

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
      <div className="bg-white dark:bg-gray-800 shadow rounded-lg">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Manage your account settings and system preferences
          </p>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="-mb-px flex space-x-8 px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.id
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
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
              {/* Church Location */}
              {user?.role === 'admin' && (
                <div>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Location</h3>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    Set your organisation's location to enable weather and holiday-aware attendance predictions.
                  </p>

                  <div className="mt-4 bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                    {locationName && (
                      <div className="flex items-center mb-4 text-sm text-gray-900 dark:text-gray-100">
                        <MapPinIcon className="h-5 w-5 text-gray-400 mr-2 shrink-0" />
                        <span className="font-medium">{locationName}</span>
                      </div>
                    )}

                    <div className="relative" ref={locationDropdownRef}>
                      <label htmlFor="location-search" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
                          className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm pr-10"
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
                        <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg rounded-md border border-gray-200 dark:border-gray-700 max-h-60 overflow-auto">
                          {locationResults.map((result, idx) => (
                            <button
                              key={idx}
                              onClick={() => handleLocationSelect(result)}
                              className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 last:border-b-0 transition-colors"
                            >
                              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                {result.name}
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400">
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
                      <p className="mt-2 text-sm text-red-600 dark:text-red-400">{locationError}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Visitor Settings - admin only */}
              {user?.role === 'admin' && (
                <div>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Visitor Settings</h3>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    Configure how long visitors appear in recent visitor lists.
                  </p>

                  <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Local Visitor Limit
                        </label>
                        <input
                          type="number"
                          min="1"
                          max="52"
                          value={visitorConfig.localVisitorServiceLimit}
                          onChange={(e) => setVisitorConfig(prev => ({
                            ...prev,
                            localVisitorServiceLimit: parseInt(e.target.value) || 1
                          }))}
                          className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Consecutive absences before a local visitor is hidden from recent lists.
                        </p>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Traveller Visitor Limit
                        </label>
                        <input
                          type="number"
                          min="1"
                          max="52"
                          value={visitorConfig.travellerVisitorServiceLimit}
                          onChange={(e) => setVisitorConfig(prev => ({
                            ...prev,
                            travellerVisitorServiceLimit: parseInt(e.target.value) || 1
                          }))}
                          className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Consecutive absences before a traveller visitor is hidden from recent lists.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-end mt-6 space-x-3">
                      {visitorConfigSuccess && (
                        <span className="text-sm text-green-600 dark:text-green-400 flex items-center">
                          <CheckCircleIcon className="h-4 w-4 mr-1" />
                          Saved
                        </span>
                      )}
                      <button
                        onClick={saveVisitorConfig}
                        disabled={visitorConfigLoading}
                        className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                      >
                        {visitorConfigLoading ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Default Badge Settings */}
              {user?.role === 'admin' && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Default Badge Settings</h3>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                      Configure default badges for children and adults. Badges show an icon by default, with optional text.
                    </p>
                  </div>

                  {/* Child Badge Settings */}
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
                    <h4 className="text-md font-medium text-gray-900 dark:text-gray-100 mb-3">Default Child Badge</h4>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                      Select "None" to remove badges from children unless they have custom text.
                    </p>
                    <div className="space-y-4">
                      {/* Badge Icon */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Badge Icon</label>
                        <div className="grid grid-cols-6 gap-2">
                          <button
                            type="button"
                            onClick={() => setChildBadgeIcon('')}
                            disabled={defaultBadgeSaving}
                            className={`flex flex-col items-center justify-center p-2 rounded-md border-2 transition-all ${
                              !childBadgeIcon
                                ? 'border-primary-500 bg-primary-50'
                                : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                            title="None"
                          >
                            <XMarkIcon className="w-5 h-5 text-gray-400" />
                            <span className="text-xs mt-1 text-gray-600 dark:text-gray-400">None</span>
                          </button>
                          {BADGE_ICON_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => setChildBadgeIcon(option.value)}
                              disabled={defaultBadgeSaving}
                              className={`flex flex-col items-center justify-center p-2 rounded-md border-2 transition-all ${
                                childBadgeIcon === option.value
                                  ? 'border-primary-500 bg-primary-50'
                                  : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                              } disabled:opacity-50 disabled:cursor-not-allowed`}
                              title={option.label}
                            >
                              <BadgeIcon type={option.value as BadgeIconType} className="w-5 h-5 text-gray-700 dark:text-gray-300" />
                              <span className="text-xs mt-1 text-gray-600 dark:text-gray-400 truncate w-full text-center">{option.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Badge Text (Optional) */}
                      <div>
                        <label htmlFor="child-badge-text" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                          Badge Text (Optional)
                        </label>
                        <input
                          type="text"
                          id="child-badge-text"
                          value={childBadgeText}
                          onChange={(e) => setChildBadgeText(e.target.value)}
                          disabled={defaultBadgeSaving}
                          className="block w-full max-w-xs rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                          placeholder="Leave empty for icon only"
                          maxLength={50}
                        />
                      </div>

                      {/* Badge Color */}
                      <div>
                        <label htmlFor="child-badge-color" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                          Background Color
                        </label>
                        <div className="flex items-center space-x-3">
                          <input
                            type="color"
                            id="child-badge-color"
                            value={childBadgeColor}
                            onChange={(e) => setChildBadgeColor(e.target.value)}
                            disabled={defaultBadgeSaving}
                            className="h-10 w-20 rounded border border-gray-300 dark:border-gray-600 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                          <input
                            type="text"
                            value={childBadgeColor}
                            onChange={(e) => setChildBadgeColor(e.target.value)}
                            disabled={defaultBadgeSaving}
                            className="block w-32 rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed uppercase font-mono"
                            placeholder="#RRGGBB"
                            maxLength={7}
                          />
                          <button
                            type="button"
                            onClick={handleResetChildBadge}
                            disabled={defaultBadgeSaving}
                            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Reset
                          </button>
                        </div>
                      </div>

                      {/* Preview */}
                      {(childBadgeIcon || childBadgeText) && (
                        <div className="flex items-center space-x-2">
                          <span className="text-xs text-gray-700 dark:text-gray-300 font-medium">Preview:</span>
                          <span
                            className={`flex items-center space-x-1 shadow-sm ${
                              childBadgeText ? 'px-2 py-1 rounded-full' : 'w-6 h-6 justify-center rounded-full'
                            }`}
                            style={getChildBadgeStyles(childBadgeColor)}
                          >
                            {childBadgeIcon && (
                              <BadgeIcon type={childBadgeIcon as BadgeIconType} className="w-4 h-4 shrink-0" />
                            )}
                            {childBadgeText && (
                              <span className="text-xs font-medium whitespace-nowrap">{childBadgeText}</span>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Adult Badge Settings */}
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                    <h4 className="text-md font-medium text-gray-900 dark:text-gray-100 mb-3">Default Adult Badge (Optional)</h4>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                      By default, adults have no badge. You can optionally configure a default adult badge.
                    </p>
                    <div className="space-y-4">
                      {/* Badge Icon */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Badge Icon</label>
                        <div className="grid grid-cols-6 gap-2">
                          <button
                            type="button"
                            onClick={() => setAdultBadgeIcon('')}
                            disabled={defaultBadgeSaving}
                            className={`flex flex-col items-center justify-center p-2 rounded-md border-2 transition-all ${
                              !adultBadgeIcon
                                ? 'border-primary-500 bg-primary-50'
                                : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                            title="None"
                          >
                            <XMarkIcon className="w-5 h-5 text-gray-400" />
                            <span className="text-xs mt-1 text-gray-600 dark:text-gray-400">None</span>
                          </button>
                          {BADGE_ICON_OPTIONS.filter(option => option.value !== 'person').map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => setAdultBadgeIcon(option.value)}
                              disabled={defaultBadgeSaving}
                              className={`flex flex-col items-center justify-center p-2 rounded-md border-2 transition-all ${
                                adultBadgeIcon === option.value
                                  ? 'border-primary-500 bg-primary-50'
                                  : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                              } disabled:opacity-50 disabled:cursor-not-allowed`}
                              title={option.label}
                            >
                              <BadgeIcon type={option.value as BadgeIconType} className="w-5 h-5 text-gray-700 dark:text-gray-300" />
                              <span className="text-xs mt-1 text-gray-600 dark:text-gray-400 truncate w-full text-center">{option.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Badge Text (Optional) */}
                      {adultBadgeIcon && (
                        <div>
                          <label htmlFor="adult-badge-text" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                            Badge Text (Optional)
                          </label>
                          <input
                            type="text"
                            id="adult-badge-text"
                            value={adultBadgeText}
                            onChange={(e) => setAdultBadgeText(e.target.value)}
                            disabled={defaultBadgeSaving}
                            className="block w-full max-w-xs rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                            placeholder="Leave empty for icon only"
                            maxLength={50}
                          />
                        </div>
                      )}

                      {/* Badge Color */}
                      <div>
                        <label htmlFor="adult-badge-color" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                          Background Color
                        </label>
                        <div className="flex items-center space-x-3">
                          <input
                            type="color"
                            id="adult-badge-color"
                            value={adultBadgeColor || '#c5aefb'}
                            onChange={(e) => setAdultBadgeColor(e.target.value)}
                            disabled={defaultBadgeSaving}
                            className="h-10 w-20 rounded border border-gray-300 dark:border-gray-600 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                          <input
                            type="text"
                            value={adultBadgeColor}
                            onChange={(e) => setAdultBadgeColor(e.target.value)}
                            disabled={defaultBadgeSaving}
                            className="block w-32 rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed uppercase font-mono"
                            placeholder="#RRGGBB"
                            maxLength={7}
                          />
                          <button
                            type="button"
                            onClick={handleResetAdultBadge}
                            disabled={defaultBadgeSaving}
                            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Reset
                          </button>
                        </div>
                      </div>

                      {/* Preview */}
                      {adultBadgeIcon && (
                        <div className="flex items-center space-x-2">
                          <span className="text-xs text-gray-700 dark:text-gray-300 font-medium">Preview:</span>
                          <span
                            className={`flex items-center space-x-1 shadow-sm ${
                              adultBadgeText ? 'px-2 py-1 rounded-full' : 'w-6 h-6 justify-center rounded-full'
                            }`}
                            style={getChildBadgeStyles(adultBadgeColor || '#c5aefb')}
                          >
                            <BadgeIcon type={adultBadgeIcon as BadgeIconType} className="w-4 h-4 shrink-0" />
                            {adultBadgeText && (
                              <span className="text-xs font-medium whitespace-nowrap">{adultBadgeText}</span>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Save Button */}
                  {hasUnsavedBadgeChanges && (
                    <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                      <button
                        type="button"
                        onClick={handleSaveBadgeSettings}
                        disabled={defaultBadgeSaving}
                        className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {defaultBadgeSaving ? (
                          <>
                            <ArrowPathIcon className="h-4 w-4 animate-spin mr-2" />
                            Saving...
                          </>
                        ) : (
                          'Save Badge Settings'
                        )}
                      </button>
                    </div>
                  )}

                  {/* Status messages */}
                  {defaultBadgeSuccess && (
                    <p className="text-sm text-green-600 dark:text-green-400 flex items-center">
                      <CheckCircleIcon className="h-4 w-4 mr-1" />
                      Badge settings saved successfully!
                    </p>
                  )}

                  {defaultBadgeError && (
                    <p className="text-sm text-red-600 dark:text-red-400">{defaultBadgeError}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* My Info Tab */}
          {activeTab === 'myinfo' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">My Information</h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  Update your personal details and contact preferences.
                </p>
              </div>

              {profileError && (
                <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-400">{profileError}</div>
              )}
              {profileSuccess && (
                <div className="rounded-md bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-700 dark:text-green-400">{profileSuccess}</div>
              )}

              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">First Name</label>
                    <input className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={profileFirstName} onChange={e => setProfileFirstName(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Last Name</label>
                    <input className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={profileLastName} onChange={e => setProfileLastName(e.target.value)} />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Primary Contact Method</label>
                  <select className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={profilePrimaryContactMethod} onChange={e => setProfilePrimaryContactMethod(e.target.value as 'email' | 'sms')}>
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email (optional)</label>
                  <input type="email" className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={profileEmail} onChange={e => setProfileEmail(e.target.value)} />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Mobile Number (optional)</label>
                  <input type="tel" className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={profileMobileNumber} onChange={e => setProfileMobileNumber(e.target.value)} />
                </div>

                <div className="flex justify-end">
                  <button disabled={profileSaving} onClick={handleProfileSave} className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-60">
                    {profileSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>

              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                <dl className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Role</dt>
                    <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100 capitalize">
                      {user?.role?.replace('_', ' ')}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && user?.role === 'admin' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Email Notifications</h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  Configure automated email notifications for your organisation.
                </p>
              </div>

              {weeklyReviewLoading ? (
                <div className="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
              ) : (
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 space-y-6">
                  <div>
                    <h4 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-1">Weekly Gathering Review</h4>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                      A summary of attendance numbers, trends, and insights sent the morning after your main gathering day. Sent to admins and coordinators with email notifications enabled.
                    </p>

                    {/* Enable toggle */}
                    <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Enable weekly review email</div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={weeklyReviewEnabled}
                        onClick={() => {
                          const next = !weeklyReviewEnabled;
                          setWeeklyReviewEnabled(next);
                          saveWeeklyReview({ enabled: next });
                        }}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${weeklyReviewEnabled ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                      >
                        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${weeklyReviewEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                    </div>

                    {/* Send day */}
                    <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Send day</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">Auto-detected: {weeklyReviewDetectedDay}</div>
                      </div>
                      <select
                        value={weeklyReviewDay || ''}
                        onChange={(e) => {
                          const val = e.target.value || null;
                          setWeeklyReviewDay(val);
                          saveWeeklyReview({ day: val });
                        }}
                        className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-primary-500 focus:border-primary-500"
                      >
                        <option value="">Auto-detect</option>
                        <option value="Sunday">Sunday</option>
                        <option value="Monday">Monday</option>
                        <option value="Tuesday">Tuesday</option>
                        <option value="Wednesday">Wednesday</option>
                        <option value="Thursday">Thursday</option>
                        <option value="Friday">Friday</option>
                        <option value="Saturday">Saturday</option>
                      </select>
                    </div>

                    {/* Include insight toggle */}
                    <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Include AI insight</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">One free AI-generated insight per week</div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={weeklyReviewIncludeInsight}
                        onClick={() => {
                          const next = !weeklyReviewIncludeInsight;
                          setWeeklyReviewIncludeInsight(next);
                          saveWeeklyReview({ includeInsight: next });
                        }}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${weeklyReviewIncludeInsight ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                      >
                        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${weeklyReviewIncludeInsight ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                    </div>

                    {/* Test email button */}
                    <div className="pt-4 flex items-center gap-4">
                      <button
                        onClick={sendTestWeeklyReview}
                        disabled={weeklyReviewTestSending}
                        className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
                      >
                        {weeklyReviewTestSending ? 'Sending...' : 'Send Test Email'}
                      </button>
                      {weeklyReviewSuccess && (
                        <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
                          <CheckCircleIcon className="h-4 w-4" />
                          {weeklyReviewSuccess}
                        </span>
                      )}
                      {weeklyReviewError && (
                        <span className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
                          <ExclamationTriangleIcon className="h-4 w-4" />
                          {weeklyReviewError}
                        </span>
                      )}
                    </div>

                    {weeklyReviewLastSent && (
                      <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                        Last sent: {weeklyReviewLastSent}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'integrations' && user?.role === 'admin' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">External Integrations</h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  Connect your account with external services to enhance your management experience.
                </p>

                <div className="mt-6 space-y-6">
                  {/* Elvanto Integration */}
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                    {/* Connection Status Header */}
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center space-x-4">
                        <div className="shrink-0">
                          <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                            <svg className="w-6 h-6 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                            </svg>
                          </div>
                        </div>
                        <div>
                          <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">Elvanto</h4>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            Import people and families from your Elvanto account.
                          </p>
                          {elvantoStatus.connected && (
                            <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center">
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
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                                  <ShieldCheckIcon className="w-3 h-3 mr-1" />
                                  Connected
                                </span>
                                <button
                                  onClick={handleElvantoDisconnect}
                              className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                                >
                                  Disconnect
                                </button>
                              </>
                        ) : (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                                <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                                Not Connected
                              </span>
                        )}
                      </div>
                    </div>

                    {/* API Key Connection Form - Only show when not connected */}
                    {!elvantoStatus.connected && !elvantoStatus.loading && (
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
                        <div className="flex items-center justify-between mb-4">
                          <h5 className="text-md font-medium text-gray-900 dark:text-gray-100">Connect with API Key</h5>
                          <button
                            onClick={() => setShowApiKeyGuide(true)}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                          >
                            <InformationCircleIcon className="h-4 w-4 mr-1.5" />
                            How to get API Key
                          </button>
                        </div>
                        
                        <div className="space-y-4">
                          <div>
                            <label htmlFor="elvanto-api-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                              Elvanto API Key
                            </label>
                            <input
                              type="password"
                              id="elvanto-api-key"
                              value={elvantoApiKey}
                              onChange={(e) => setElvantoApiKey(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && handleElvantoConnect()}
                              className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                              placeholder="Paste your Elvanto API key here"
                            />
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                              Your API key is stored securely and only used to access your Elvanto data.
                            </p>
                          </div>

                          {/* Connection Error */}
                          {connectionError && (
                            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                              <div className="flex">
                                <ShieldExclamationIcon className="h-5 w-5 text-red-400 shrink-0" />
                                <div className="ml-2">
                                  <p className="text-sm text-red-700 dark:text-red-400">{connectionError}</p>
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

                    <div className="mt-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                      <div className="flex">
                        <div className="shrink-0">
                          <InformationCircleIcon className="h-5 w-5 text-blue-400" />
                        </div>
                        <div className="ml-3">
                          <h4 className="text-sm font-medium text-blue-800 dark:text-blue-300">What you'll get</h4>
                          <div className="mt-2 text-sm text-blue-700 dark:text-blue-400">
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
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                    {/* AI Status Header */}
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center space-x-4">
                        <div className="shrink-0">
                          <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
                            <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                            </svg>
                          </div>
                        </div>
                        <div>
                          <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">AI Insights</h4>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            Ask questions about your attendance data in plain language.
                          </p>
                          {aiStatus.configured && (
                            <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center">
                              <CheckCircleIcon className="w-3 h-3 mr-1" />
                              Connected via {aiStatus.provider === 'openai' ? 'OpenAI' : aiStatus.provider === 'anthropic' ? 'Anthropic' : 'Grok'}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        {aiStatus.loading ? (
                          <ArrowPathIcon className="w-5 h-5 animate-spin text-gray-400" />
                        ) : aiStatus.configured ? (
                          <>
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                              <ShieldCheckIcon className="w-3 h-3 mr-1" />
                              Connected
                            </span>
                            <button
                              onClick={() => setShowAiDisconnectModal(true)}
                              className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
                            >
                              Disconnect
                            </button>
                          </>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                            <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                            Not Connected
                          </span>
                        )}
                      </div>
                    </div>

                    {/* AI Config Form - Only show when not connected */}
                    {!aiStatus.configured && !aiStatus.loading && (
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
                        <h5 className="text-md font-medium text-gray-900 dark:text-gray-100 mb-4">Connect your AI provider</h5>
                        <div className="space-y-4">
                          <div>
                            <label htmlFor="ai-provider" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                              AI Provider
                            </label>
                            <select
                              id="ai-provider"
                              value={aiProvider}
                              onChange={(e) => setAiProvider(e.target.value as 'openai' | 'anthropic' | 'grok')}
                              className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                            >
                              <option value="openai">OpenAI (ChatGPT)</option>
                              <option value="anthropic">Anthropic (Claude)</option>
                              <option value="grok">xAI (Grok)</option>
                            </select>
                          </div>
                          <div>
                            <label htmlFor="ai-api-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                              API Key
                            </label>
                            <input
                              type="password"
                              id="ai-api-key"
                              value={aiApiKey}
                              onChange={(e) => setAiApiKey(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && handleAiConnect()}
                              className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                              placeholder={aiProvider === 'openai' ? 'sk-...' : aiProvider === 'anthropic' ? 'sk-ant-...' : 'xai-...'}
                            />
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                              {aiProvider === 'openai'
                                ? 'Get your key from platform.openai.com/api-keys'
                                : aiProvider === 'anthropic'
                                ? 'Get your key from console.anthropic.com/settings/keys'
                                : 'Get your key from console.x.ai'}
                            </p>
                          </div>

                          {aiError && (
                            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                              <div className="flex">
                                <ShieldExclamationIcon className="h-5 w-5 text-red-400 shrink-0" />
                                <div className="ml-2">
                                  <p className="text-sm text-red-700 dark:text-red-400">{aiError}</p>
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

                    <div className="mt-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-4">
                      <div className="flex">
                        <div className="shrink-0">
                          <InformationCircleIcon className="h-5 w-5 text-purple-400" />
                        </div>
                        <div className="ml-3">
                          <h4 className="text-sm font-medium text-purple-800 dark:text-purple-300">What you'll get</h4>
                          <div className="mt-2 text-sm text-purple-700 dark:text-purple-400">
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

                  {/* Planning Center Integration - Only show in dev mode */}
                  {import.meta.env.DEV && planningCenterStatus.enabled && (
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center space-x-4">
                        <div className="shrink-0">
                          <div className="w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                            <svg className="w-6 h-6 text-green-600" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                            </svg>
                          </div>
                        </div>
                        <div>
                          <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">Planning Center</h4>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            Connect to Planning Center Online to import people and check-ins.
                          </p>
                          {planningCenterStatus.connected && (
                            <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center">
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
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                              <ShieldCheckIcon className="w-3 h-3 mr-1" />
                              Connected
                            </span>
                            <button
                              onClick={() => setShowPlanningCenterDisconnectModal(true)}
                              className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                            >
                              Disconnect
                            </button>
                          </>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                            <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                            Not Connected
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Connection Form - Only show when not connected */}
                    {!planningCenterStatus.connected && !planningCenterStatus.loading && (
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
                        <h5 className="text-md font-medium text-gray-900 dark:text-gray-100 mb-4">Connect to Planning Center</h5>
                        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                          You'll be redirected to Planning Center to authorize access. We'll only access your people and check-in data.
                        </p>

                        {planningCenterError && (
                          <div className="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                            <div className="flex">
                              <ShieldExclamationIcon className="h-5 w-5 text-red-400 shrink-0" />
                              <div className="ml-2">
                                <p className="text-sm text-red-700 dark:text-red-400">{planningCenterError}</p>
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
                    )}

                    <div className="mt-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                      <div className="flex">
                        <div className="shrink-0">
                          <InformationCircleIcon className="h-5 w-5 text-green-400" />
                        </div>
                        <div className="ml-3">
                          <h4 className="text-sm font-medium text-green-800 dark:text-green-300">What you'll get</h4>
                          <div className="mt-2 text-sm text-green-700 dark:text-green-400">
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

          {activeTab === 'data' && user?.role === 'admin' && (
            <div className="space-y-6">
              {/* Export Section */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Export All Data</h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  Download all your data as CSV files in a ZIP archive. This includes members, families, attendance records, gatherings, and all other data.
                </p>
              </div>

              <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  The export includes all tables from your database. Sensitive fields (API keys) are automatically redacted.
                </p>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  <ArrowDownTrayIcon className="h-4 w-4 mr-2" />
                  {exporting ? 'Generating export...' : 'Download Data Export'}
                </button>
              </div>

              {/* Delete Section */}
              <div className="mt-10">
                <h3 className="text-lg font-medium text-red-900 dark:text-red-300">Delete Organisation Account</h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  Permanently delete your organisation account and all associated data. This action cannot be undone.
                </p>
              </div>

              <div className="border border-red-200 dark:border-red-800 rounded-lg p-6 bg-red-50 dark:bg-red-900/20">
                <div className="bg-white dark:bg-gray-800 border border-red-300 dark:border-red-700 rounded-md p-4 mb-4">
                  <p className="text-sm font-medium text-red-800 dark:text-red-300 mb-2">This will permanently:</p>
                  <ul className="text-sm text-red-700 dark:text-red-400 list-disc list-inside space-y-1">
                    <li>Delete all data (members, families, attendance, gatherings)</li>
                    <li>Remove all user accounts associated with this organisation</li>
                    <li>Log out all users immediately</li>
                  </ul>
                  <p className="text-sm font-bold text-red-800 dark:text-red-300 mt-2">This cannot be recovered. Please export your data first.</p>
                </div>

                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Type <span className="font-bold">{churchName}</span> to confirm:
                </label>
                <input
                  type="text"
                  value={deleteConfirmName}
                  onChange={(e) => setDeleteConfirmName(e.target.value)}
                  placeholder="Type organisation name here"
                  className="block w-full max-w-md rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:ring-red-500 focus:border-red-500 sm:text-sm mb-4"
                />
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={deleteConfirmName.trim() !== churchName.trim() || !churchName}
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Delete Organisation Account
                </button>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Delete Church Confirmation Modal */}
      <Modal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
      >
        <div className="p-6">
          <div className="flex justify-between items-start mb-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Are you absolutely sure?</h3>
            <button onClick={() => setShowDeleteConfirm(false)} className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300">
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-red-100 dark:bg-red-900/30 rounded-full">
            <ExclamationTriangleIcon className="h-8 w-8 text-red-600" />
          </div>

          <div className="text-center mb-6">
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
              This will permanently delete <span className="font-bold">{churchName}</span> and all its data.
            </p>
            <p className="text-sm text-red-600 dark:text-red-400 font-medium">
              This action cannot be undone.
            </p>
          </div>

          <div className="flex space-x-3">
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Yes, Delete Everything'}
            </button>
          </div>
        </div>
      </Modal>

      {/* API Key Setup Guide Modal */}
      <Modal
        isOpen={showApiKeyGuide}
        onClose={() => setShowApiKeyGuide(false)}
        className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">How to Get Your Elvanto API Key</h2>
            <button
              onClick={() => setShowApiKeyGuide(false)}
              className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 focus:outline-none"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          <div className="space-y-6">
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <p className="text-sm text-blue-800 dark:text-blue-300">
                Follow these simple steps to get your API key from Elvanto. You'll need admin access to your Elvanto account.
              </p>
            </div>

            {/* Step 1 */}
            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    1
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Log in to Elvanto</h3>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Go to <a href="https://www.elvanto.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline">elvanto.com</a> and log in with your admin account.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    2
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Go to Settings → Integrations</h3>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Click on <strong>Settings</strong> in the top menu, then select <strong>Integrations</strong> from the sidebar.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    3
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Find API Access</h3>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Look for <strong>API Access</strong> or <strong>Developer</strong> section. Click on it to view your API keys.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 4 */}
            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    4
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Copy Your API Key</h3>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Copy your API key and paste it into the field above. If you don't have one, you can generate a new key from this page.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
              <div className="flex">
                <InformationCircleIcon className="h-5 w-5 text-yellow-400 shrink-0" />
                <div className="ml-3">
                  <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-300">Keep Your API Key Secure</h4>
                  <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-400">
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
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Disconnect Elvanto
              </h3>
              <button
                onClick={() => setShowDisconnectModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-yellow-100 dark:bg-yellow-900/30 rounded-full">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600" />
            </div>
            
            <div className="text-center mb-6">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Are you sure you want to disconnect from Elvanto?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                This will stop syncing data between the services. You can reconnect at any time.
              </p>
            </div>
            
            <div className="flex space-x-3">
              <button
                onClick={() => setShowDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
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
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Disconnect AI
              </h3>
              <button
                onClick={() => setShowAiDisconnectModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-yellow-100 dark:bg-yellow-900/30 rounded-full">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600" />
            </div>

            <div className="text-center mb-6">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Are you sure you want to disconnect AI Insights?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Your API key will be removed. You can reconnect at any time.
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowAiDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 transition-colors"
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
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Disconnect Planning Center
              </h3>
              <button
                onClick={() => setShowPlanningCenterDisconnectModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-yellow-100 dark:bg-yellow-900/30 rounded-full">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600" />
            </div>

            <div className="text-center mb-6">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Are you sure you want to disconnect from Planning Center?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Your OAuth tokens will be removed. You can reconnect at any time.
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowPlanningCenterDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors"
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