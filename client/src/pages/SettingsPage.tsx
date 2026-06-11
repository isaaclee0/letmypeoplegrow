import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import IntegrationsTab from '../components/integrations/IntegrationsTab';
import { usersAPI, settingsAPI, visitorConfigAPI, takeoutAPI, aiAPI } from '../services/api';
import WeeklyReviewGuidanceWizard from '../components/WeeklyReviewGuidanceWizard';
import logger from '../utils/logger';
import { getChildBadgeStyles } from '../utils/colorUtils';
import BadgeIcon, { BADGE_ICON_OPTIONS, BadgeIconType } from '../components/icons/BadgeIcon';

import {
  PencilIcon,
  ArrowPathIcon,
  LinkIcon,
  XMarkIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
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
  const [caregiverAbsenceThreshold, setCaregiverAbsenceThreshold] = useState(3);
  const [weeklyReviewLastSent, setWeeklyReviewLastSent] = useState<string | null>(null);
  const [weeklyReviewLoading, setWeeklyReviewLoading] = useState(false);
  const [weeklyReviewSaving, setWeeklyReviewSaving] = useState(false);
  const [weeklyReviewTestSending, setWeeklyReviewTestSending] = useState(false);
  const [weeklyReviewSuccess, setWeeklyReviewSuccess] = useState('');
  const [weeklyReviewError, setWeeklyReviewError] = useState('');
  const [guidanceWizardOpen, setGuidanceWizardOpen] = useState(false);
  const [guidanceSet, setGuidanceSet] = useState(false);
  const [caregiverDigestTestSending, setCaregiverDigestTestSending] = useState(false);
  const [caregiverDigestSuccess, setCaregiverDigestSuccess] = useState('');
  const [caregiverDigestError, setCaregiverDigestError] = useState('');

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

    // Handle Planning Center OAuth callback: just open the Integrations tab.
    // IntegrationsTab reads pco_success/pco_error itself, opens the panel, and cleans the URL.
    if (urlParams.get('pco_success') === 'true' || urlParams.get('pco_error')) {
      setActiveTab('integrations');
    }
  }, []);

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
        setCaregiverAbsenceThreshold(res.data.caregiverAbsenceThreshold ?? 3);
      }).catch(err => {
        logger.error('Failed to load weekly review settings:', err);
      }).finally(() => {
        setWeeklyReviewLoading(false);
      });
      aiAPI.getWeeklyGuidance().then(res => {
        setGuidanceSet(!!res.data?.guidance);
      }).catch(() => {
        // Non-critical — ignore errors loading guidance status
      });
    }
  }, [activeTab, user?.role]);

  const saveWeeklyReview = async (updates: { enabled?: boolean; day?: string | null; includeInsight?: boolean; caregiverAbsenceThreshold?: number }) => {
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

  const sendTestCaregiverDigest = async () => {
    setCaregiverDigestTestSending(true);
    setCaregiverDigestSuccess('');
    setCaregiverDigestError('');
    try {
      const res = await settingsAPI.sendTestCaregiverDigest();
      setCaregiverDigestSuccess(res.data.message || 'Caregiver digest sent!');
      setTimeout(() => setCaregiverDigestSuccess(''), 6000);
    } catch (err: any) {
      setCaregiverDigestError(err.response?.data?.error || 'Failed to send caregiver digest');
    } finally {
      setCaregiverDigestTestSending(false);
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

  // Load location on mount
  useEffect(() => {
    fetchLocation();
  }, [fetchLocation]);

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

                    {/* AI insight guidance */}
                    <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-700">
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">AI insight guidance</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {guidanceSet
                            ? 'Configured — the weekly insight uses your church context.'
                            : 'Not set up yet — help the AI understand your gatherings.'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setGuidanceWizardOpen(true)}
                        className="ml-4 shrink-0 inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                      >
                        {guidanceSet ? 'Edit' : 'Set up'}
                      </button>
                    </div>

                    {/* Caregiver absence threshold */}
                    <div className="flex items-center justify-between py-3 border-t border-gray-100 dark:border-gray-700">
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Caregiver notification threshold</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Send caregiver digest emails when someone has missed this many services in a row</div>
                      </div>
                      <div className="flex items-center gap-2 ml-4 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.max(1, caregiverAbsenceThreshold - 1);
                            setCaregiverAbsenceThreshold(next);
                            saveWeeklyReview({ caregiverAbsenceThreshold: next });
                          }}
                          className="w-7 h-7 flex items-center justify-center rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm font-bold disabled:opacity-40"
                          disabled={caregiverAbsenceThreshold <= 1}
                        >−</button>
                        <span className="w-6 text-center text-sm font-semibold text-gray-900 dark:text-gray-100">{caregiverAbsenceThreshold}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.min(20, caregiverAbsenceThreshold + 1);
                            setCaregiverAbsenceThreshold(next);
                            saveWeeklyReview({ caregiverAbsenceThreshold: next });
                          }}
                          className="w-7 h-7 flex items-center justify-center rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm font-bold disabled:opacity-40"
                          disabled={caregiverAbsenceThreshold >= 20}
                        >+</button>
                      </div>
                    </div>

                    {/* Test email buttons */}
                    <div className="pt-4 flex flex-wrap items-center gap-3">
                      <button
                        onClick={sendTestWeeklyReview}
                        disabled={weeklyReviewTestSending}
                        className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
                      >
                        {weeklyReviewTestSending ? 'Sending...' : 'Send Test Weekly Review'}
                      </button>
                      <button
                        onClick={sendTestCaregiverDigest}
                        disabled={caregiverDigestTestSending}
                        className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
                      >
                        {caregiverDigestTestSending ? 'Sending...' : 'Send Test Caregiver Digest'}
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
                      {caregiverDigestSuccess && (
                        <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
                          <CheckCircleIcon className="h-4 w-4" />
                          {caregiverDigestSuccess}
                        </span>
                      )}
                      {caregiverDigestError && (
                        <span className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
                          <ExclamationTriangleIcon className="h-4 w-4" />
                          {caregiverDigestError}
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
            <IntegrationsTab />
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

      <WeeklyReviewGuidanceWizard
        isOpen={guidanceWizardOpen}
        onClose={() => setGuidanceWizardOpen(false)}
        onSaved={() => setGuidanceSet(true)}
      />

    </div>
  );
};

export default SettingsPage;