import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useKiosk } from '../contexts/KioskContext';
import { useWebSocket } from '../contexts/WebSocketContext';
import { usePWAUpdate } from '../contexts/PWAUpdateContext';
import { getFormattedVersion } from '../utils/version';
import { integrationsAPI, aiAPI, gatheringsAPI } from '../services/api';
import logger from '../utils/logger';
import {
  Bars3Icon,
  BellIcon,
  ChartBarIcon,
  ClipboardDocumentListIcon,
  HomeIcon,
  UserCircleIcon,
  UserGroupIcon,
  UsersIcon,
  XMarkIcon,
  PencilIcon,
  ArrowRightOnRectangleIcon,
  ArrowPathIcon,
  ArrowDownTrayIcon,
  SparklesIcon,
  ComputerDesktopIcon,
} from '@heroicons/react/24/outline';

const Layout: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [elvantoConnected, setElvantoConnected] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [kioskAvailable, setKioskAvailable] = useState(false);
  const { user, logout } = useAuth();
  const kioskCtx = useKiosk();
  const { isOfflineMode, connectionStatus } = useWebSocket();
  const { updateAvailable, performUpdate } = usePWAUpdate();
  const isOffline = isOfflineMode || connectionStatus === 'offline';
  const location = useLocation();
  const navigate = useNavigate();
  const notificationsRef = useRef<HTMLDivElement>(null);

  // Load Elvanto connection status from cache immediately, then fetch from API
  useEffect(() => {
    if (user?.role !== 'admin') {
      setElvantoConnected(false);
      return;
    }

    // Load from cache immediately to prevent flash
    const cachedStatus = localStorage.getItem('elvanto_connected');
    if (cachedStatus !== null) {
      setElvantoConnected(cachedStatus === 'true');
    }

    // Fetch fresh status from API in the background
    const fetchElvantoStatus = async () => {
      try {
        const response = await integrationsAPI.getElvantoStatus();
        const connected = response.data.connected === true;
        setElvantoConnected(connected);
        // Update cache
        localStorage.setItem('elvanto_connected', connected.toString());
      } catch (error) {
        logger.error('Failed to fetch Elvanto status:', error);
        const connected = false;
        setElvantoConnected(connected);
        localStorage.setItem('elvanto_connected', connected.toString());
      }
    };

    fetchElvantoStatus();
  }, [user?.role]);

  // Load AI configuration status
  useEffect(() => {
    // Load from cache immediately
    const cached = localStorage.getItem('ai_configured');
    if (cached !== null) {
      setAiConfigured(cached === 'true');
    }

    const fetchAiStatus = async () => {
      try {
        const response = await aiAPI.getStatus();
        const configured = response.data.configured === true;
        setAiConfigured(configured);
        localStorage.setItem('ai_configured', configured.toString());
      } catch (error) {
        logger.error('Failed to fetch AI status:', error);
        setAiConfigured(false);
        localStorage.setItem('ai_configured', 'false');
      }
    };

    fetchAiStatus();
  }, []);

  // Load kiosk availability (any gathering has kiosk_enabled)
  useEffect(() => {
    const cached = localStorage.getItem('kiosk_available');
    if (cached !== null) {
      setKioskAvailable(cached === 'true');
    }

    const fetchKioskStatus = async () => {
      try {
        const response = await gatheringsAPI.getAll();
        const gatherings = response.data.gatherings || [];
        const hasKiosk = gatherings.some((g: any) => g.kioskEnabled);
        setKioskAvailable(hasKiosk);
        localStorage.setItem('kiosk_available', hasKiosk.toString());
      } catch (error) {
        // Non-critical
      }
    };

    fetchKioskStatus();
  }, []);

  // Close notifications when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    };

    if (showNotifications) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showNotifications]);

  const navigation = user?.role === 'attendance_taker' ? [
    { name: 'Attendance', href: '/app/attendance', icon: ClipboardDocumentListIcon },
  ] : [
    { name: 'Attendance', href: '/app/attendance', icon: ClipboardDocumentListIcon },
    { name: 'People', href: '/app/people', icon: UsersIcon },
    { name: 'Gatherings', href: '/app/gatherings', icon: UserGroupIcon },
    ...(user?.role === 'admin' || user?.role === 'coordinator' ? [
      { name: 'Users', href: '/app/users', icon: UserCircleIcon }
    ] : []),
    { name: 'Reports', href: '/app/reports', icon: ChartBarIcon },
    ...(aiConfigured && user?.role === 'admin' ? [
      { name: 'AI Insights', href: '/app/ai-insights', icon: SparklesIcon }
    ] : []),
    ...(kioskAvailable ? [
      { name: 'Kiosk', href: '/app/kiosk', icon: ComputerDesktopIcon }
    ] : []),
    ...(user?.role === 'admin' && elvantoConnected ? [
      { name: 'Import from Elvanto', href: '/app/elvanto-import', icon: ArrowDownTrayIcon }
    ] : []),
    { name: 'Settings', href: '/app/settings', icon: PencilIcon },
  ];

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const handleMyProfile = () => {
    setSidebarOpen(false);
    navigate('/app/profile');
  };

  // Kiosk locked mode: hide sidebar and top bar entirely
  // Uses fixed positioning to prevent iOS Safari from scrolling the body when inputs are focused
  if (kioskCtx.isLocked) {
    return (
      <div className="fixed inset-0 bg-gradient-to-br from-primary-50 to-secondary-50 overflow-hidden">
        <main className="h-full overflow-y-auto overscroll-none focus:outline-none">
          <div className="py-6">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gradient-to-br from-primary-50 to-secondary-50">
      {/* Update notification bar removed with migrations */}
      
      <div className="flex overflow-hidden h-full">
        {/* Mobile sidebar */}
      <div className={`fixed inset-0 flex z-40 md:hidden ${sidebarOpen ? '' : 'hidden'}`}>
        <div className="fixed inset-0 bg-primary-900 bg-opacity-75" onClick={() => setSidebarOpen(false)} />
        <div className="relative flex-1 flex flex-col max-w-xs w-full bg-primary-500">
          <div className="absolute top-0 right-0 -mr-12 pt-2">
            <button
              className="ml-1 flex items-center justify-center h-10 w-10 rounded-full focus:outline-none focus:ring-2 focus:ring-inset focus:ring-secondary-300"
              onClick={() => setSidebarOpen(false)}
            >
              <XMarkIcon className="h-6 w-6 text-white" />
            </button>
          </div>
          <div className="flex-1 h-0 pt-5 pb-4 overflow-y-auto flex flex-col">
            {/* User Profile Section */}
            <div className="px-4 py-3 border-b border-primary-400">
              <div className="flex items-center">
                <UserCircleIcon className="h-10 w-10 text-white" />
                <div className="ml-3">
                  <p className="text-sm font-medium text-white">{user?.firstName} {user?.lastName}</p>
                  <p className="text-xs text-primary-200 capitalize">{user?.role?.replace('_', ' ')}</p>
                </div>
              </div>
            </div>

            {/* Navigation */}
            <nav className="flex-1 px-2 space-y-1 mt-4">
              {navigation.map((item) => (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`${
                    location.pathname === item.href
                      ? 'bg-secondary-500 text-white shadow-md'
                      : 'text-white hover:bg-primary-600 hover:text-white'
                  } group flex items-center px-2 py-2 text-base font-medium rounded-md transition-colors duration-200`}
                  onClick={() => setSidebarOpen(false)}
                >
                  <item.icon className="mr-4 h-6 w-6" />
                  {item.name}
                </Link>
              ))}
            </nav>

            {/* Profile Actions */}
            <div className="px-2 space-y-1 mt-4">
              <button
                onClick={handleMyProfile}
                className="w-full text-white hover:bg-primary-600 hover:text-white group flex items-center px-2 py-2 text-base font-medium rounded-md transition-colors duration-200"
              >
                <UserCircleIcon className="mr-4 h-6 w-6" />
                My Profile
              </button>
              <button
                onClick={handleLogout}
                className="w-full text-white hover:bg-primary-600 hover:text-white group flex items-center px-2 py-2 text-base font-medium rounded-md transition-colors duration-200"
              >
                <ArrowRightOnRectangleIcon className="mr-4 h-6 w-6" />
                Logout
              </button>
            </div>

            {/* Logo at bottom */}
            <div className="flex-shrink-0 flex flex-col items-center px-4 py-6">
              <img
                className="w-3/4 aspect-square object-contain mb-3"
                src="/logo-white-transparent.png"
                alt="Let My People Grow"
              />
              <div className="text-center">
                <div className="text-white font-title font-bold text-lg leading-tight tracking-normal">
                  LET MY PEOPLE
                </div>
                <div className="text-white font-title font-bold text-3xl leading-tight tracking-wide">
                  GROW
                </div>
              </div>
              {/* Version and offline status */}
              <div className="mt-4 text-center">
                <span className="text-white text-xs opacity-60">{getFormattedVersion()}</span>
                {isOffline && (
                  <div className="mt-1.5 flex items-center justify-center space-x-1.5">
                    <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                    <span className="text-amber-200 text-xs">Offline</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Desktop sidebar */}
      <div className="hidden md:flex md:flex-shrink-0">
        <div className="flex flex-col w-64">
          <div className="flex flex-col h-0 flex-1 border-r border-primary-700 bg-primary-500">
                        <div className="flex-1 flex flex-col pt-5 pb-4 overflow-y-auto">
              <nav className="flex-1 px-2 bg-primary-500 space-y-1">
                {navigation.map((item) => (
                  <Link
                    key={item.name}
                    to={item.href}
                    className={`${
                      location.pathname === item.href
                        ? 'bg-secondary-500 text-white shadow-md'
                        : 'text-white hover:bg-primary-600 hover:text-white'
                    } group flex items-center px-2 py-2 text-sm font-medium rounded-md transition-colors duration-200`}
                  >
                    <item.icon className="mr-3 h-6 w-6" />
                    {item.name}
                  </Link>
                ))}
              </nav>
              {/* Profile Actions - Desktop */}
              <div className="px-2 space-y-1 mt-2 hidden md:block">
                <button
                  onClick={handleMyProfile}
                  className="w-full text-white hover:bg-primary-600 hover:text-white group flex items-center px-2 py-2 text-sm font-medium rounded-md transition-colors duration-200"
                >
                  <UserCircleIcon className="mr-3 h-6 w-6" />
                  My Profile
                </button>
                <button
                  onClick={handleLogout}
                  className="w-full text-white hover:bg-primary-600 hover:text-white group flex items-center px-2 py-2 text-sm font-medium rounded-md transition-colors duration-200"
                >
                  <ArrowRightOnRectangleIcon className="mr-3 h-6 w-6" />
                  Logout
                </button>
              </div>
              {/* Logo at bottom */}
              <div className="flex-shrink-0 flex flex-col items-center px-4 py-6">
                <img
                  className="w-3/4 aspect-square object-contain mb-3"
                  src="/logo-white-transparent.png"
                  alt="Let My People Grow"
                />
                <div className="text-center">
                  <div className="text-white font-title font-bold text-lg leading-tight tracking-normal">
                    LET MY PEOPLE
                  </div>
                  <div className="text-white font-title font-bold text-3xl leading-tight tracking-wide">
                    GROW
                  </div>
                </div>
                {/* Version and offline status */}
                <div className="mt-4 text-center">
                  <span className="text-white text-xs opacity-60">{getFormattedVersion()}</span>
                  {isOffline && (
                    <div className="mt-1.5 flex items-center justify-center space-x-1.5">
                      <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                      <span className="text-amber-200 text-xs">Offline</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-col w-0 flex-1 overflow-hidden">
        {/* Top bar */}
        <div className="relative z-10 flex-shrink-0 flex h-16 bg-white shadow-lg">
          <button
            className="px-4 border-r border-primary-200 text-primary-600 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500 md:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Bars3Icon className="h-6 w-6" />
          </button>
          <div className="flex-1 px-4 flex justify-between">
            <div className="flex-1 flex">
              <div className="w-full flex md:ml-0">
                <div className="relative w-full text-gray-400 focus-within:text-gray-600">
                  <div className="absolute inset-y-0 left-0 flex items-center">
                    <h2 className="text-lg font-bold text-primary-700 ml-2 font-title">
                      {navigation.find(item => item.href === location.pathname)?.name || 'Attendance'}
                    </h2>
                  </div>
                </div>
              </div>
            </div>
            <div className="ml-4 flex items-center md:ml-6">

              {/* Notifications - show for all users, includes app updates */}
              <div className="relative" ref={notificationsRef}>
                <button 
                  onClick={() => setShowNotifications(!showNotifications)}
                  className="ml-2 bg-white p-1 rounded-full text-primary-400 hover:text-primary-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors duration-200"
                  title="Notifications"
                >
                  <BellIcon className="h-6 w-6" />
                  {/* Show notification badge if there are updates or user notifications */}
                  {(updateAvailable || (user?.unreadNotifications && user.unreadNotifications > 0)) && (
                    <span className="absolute -top-1 -right-1 h-3 w-3 bg-red-500 rounded-full animate-pulse"></span>
                  )}
                </button>

                {/* Notifications Dropdown */}
                {showNotifications && (
                  <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
                    <div className="p-4">
                      <h3 className="text-lg font-medium text-gray-900 mb-3">Notifications</h3>
                      
                      {/* App Update Notification */}
                      {updateAvailable && (
                        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                          <div className="flex items-start">
                            <ArrowPathIcon className="h-5 w-5 text-blue-600 mt-0.5 mr-3 flex-shrink-0" />
                            <div className="flex-1">
                              <h4 className="text-sm font-medium text-blue-900">App Update Available</h4>
                              <p className="text-sm text-blue-700 mt-1">
                                A new version of the app is ready. Click to update now.
                              </p>
                              <button
                                onClick={() => {
                                  setShowNotifications(false);
                                  performUpdate();
                                }}
                                className="mt-2 inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                              >
                                <ArrowPathIcon className="h-3 w-3 mr-1" />
                                Update Now
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Regular Notifications - only show for non-attendance takers */}
                      {user?.role !== 'attendance_taker' && (
                        <div>
                          {user?.unreadNotifications && user.unreadNotifications > 0 ? (
                            <div className="text-sm text-gray-600">
                              You have {user.unreadNotifications} unread notification{user.unreadNotifications !== 1 ? 's' : ''}.
                            </div>
                          ) : (
                            <div className="text-sm text-gray-500">
                              No new notifications.
                            </div>
                          )}
                        </div>
                      )}

                      {/* Show message for attendance takers when no updates */}
                      {user?.role === 'attendance_taker' && !updateAvailable && (
                        <div className="text-sm text-gray-500">
                          No notifications.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Profile dropdown removed on desktop (moved to sidebar) */}
            </div>
          </div>
        </div>

        {/* Page content */}
        <main className="flex-1 relative overflow-y-auto focus:outline-none">
          <div className="py-6">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
      </div>

    </div>
  );
};

export default Layout; 