import React, { useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useDebug } from '../contexts/DebugContext';
import UpdateNotificationBar from './UpdateNotificationBar';
import DebugPanel from './DebugPanel';
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
  WrenchScrewdriverIcon,
  BugAntIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';

const Layout: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, logout } = useAuth();
  const { isDebugMode, toggleDebugMode } = useDebug();
  const location = useLocation();
  const navigate = useNavigate();

  const navigation = user?.role === 'attendance_taker' ? [
    { name: 'Attendance', href: '/app/attendance', icon: ClipboardDocumentListIcon },
    { name: 'Settings', href: '/app/settings', icon: Cog6ToothIcon },
  ] : [
    { name: 'Dashboard', href: '/app/dashboard', icon: HomeIcon },
    { name: 'Attendance', href: '/app/attendance', icon: ClipboardDocumentListIcon },
    { name: 'People', href: '/app/people', icon: UsersIcon },
    { name: 'Gatherings', href: '/app/gatherings', icon: UserGroupIcon },
    ...(user?.role === 'admin' || user?.role === 'coordinator' ? [
      { name: 'Users', href: '/app/users', icon: UserCircleIcon }
    ] : []),
    { name: 'Reports', href: '/app/reports', icon: ChartBarIcon },
    ...(user?.role === 'admin' ? [
      { name: 'Migrations', href: '/app/migrations', icon: WrenchScrewdriverIcon }
    ] : []),
    { name: 'Settings', href: '/app/settings', icon: Cog6ToothIcon },
  ];

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="h-screen bg-gradient-to-br from-primary-50 to-secondary-50">
      {/* Update notification bar */}
      <UpdateNotificationBar />
      
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
            <nav className="flex-1 px-2 space-y-1">
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
            {/* Logo at bottom */}
            <div className="flex-shrink-0 flex justify-center px-4 py-6">
              <img
                className="w-3/4 aspect-square object-contain"
                src="/logo.png"
                alt="Let My People Grow"
              />
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
              {/* Logo at bottom */}
              <div className="flex-shrink-0 flex justify-center px-4 py-6">
                <img
                  className="w-3/4 aspect-square object-contain"
                  src="/logo.png"
                  alt="Let My People Grow"
                />
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
                      {navigation.find(item => item.href === location.pathname)?.name || 'Dashboard'}
                    </h2>
                  </div>
                </div>
              </div>
            </div>
            <div className="ml-4 flex items-center md:ml-6">
              {/* Debug Toggle - only show for non-attendance takers */}
              {user?.role !== 'attendance_taker' && (
                <button 
                  onClick={toggleDebugMode}
                  className={`p-1 rounded-full transition-colors duration-200 ${
                    isDebugMode 
                      ? 'bg-red-100 text-red-600 hover:bg-red-200' 
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                  title={isDebugMode ? 'Disable Debug Mode' : 'Enable Debug Mode'}
                >
                  <BugAntIcon className="h-5 w-5" />
                </button>
              )}

              {/* Notifications - only show for non-attendance takers */}
              {user?.role !== 'attendance_taker' && (
                <button className="ml-2 bg-white p-1 rounded-full text-primary-400 hover:text-primary-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors duration-200">
                  <BellIcon className="h-6 w-6" />
                  {user?.unreadNotifications && user.unreadNotifications > 0 && (
                    <span className="absolute -mt-2 -mr-1 px-2 py-1 text-xs leading-none text-white bg-secondary-500 rounded-full">
                      {user.unreadNotifications}
                    </span>
                  )}
                </button>
              )}

              {/* Profile dropdown */}
              <div className="ml-3 relative">
                <div className="flex items-center">
                  <UserCircleIcon className="h-8 w-8 text-primary-400" />
                  <div className="ml-2">
                    <p className="text-sm font-medium text-primary-700">{user?.firstName} {user?.lastName}</p>
                    <p className="text-xs text-primary-500 capitalize">{user?.role?.replace('_', ' ')}</p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="ml-4 text-sm text-primary-600 hover:text-secondary-600 focus:outline-none transition-colors duration-200 font-medium"
                  >
                    Logout
                  </button>
                </div>
              </div>
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
      
      {/* Debug Panel - only show for non-attendance takers */}
      {user?.role !== 'attendance_taker' && <DebugPanel />}
    </div>
  );
};

export default Layout; 