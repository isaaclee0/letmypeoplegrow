import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { 
  UserGroupIcon, 
  ClipboardDocumentListIcon, 
  ChartBarIcon,
  CalendarIcon,
  UserCircleIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  UserPlusIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon
} from '@heroicons/react/24/outline';

const DashboardPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [weekendStats, setWeekendStats] = useState({
    lastWeekend: 0,
    previousWeekend: 0,
    percentageChange: 0
  });
  const [visitorStats, setVisitorStats] = useState({
    totalVisitors: 0,
    returningVisitors: 0,
    returningPercentage: 0,
    visitorHealth: 0,
    threeMonthAverage: 0
  });
  const [recentActivities, setRecentActivities] = useState<Array<{
    id: string;
    user: string;
    action: string;
    target: string;
    serviceType?: string;
    serviceDate?: string;
    actionCount?: number;
    timestamp: string;
    rawAction: string;
  }>>([]);

  // Mock data - in a real app, this would come from an API
  useEffect(() => {
    const fetchData = async () => {
    // Simulate fetching weekend attendance data
    const mockData = {
      lastWeekend: 127,
      previousWeekend: 115,
    };
    
    const percentageChange = mockData.previousWeekend > 0 
      ? ((mockData.lastWeekend - mockData.previousWeekend) / mockData.previousWeekend) * 100
      : 0;
    
    setWeekendStats({
      lastWeekend: mockData.lastWeekend,
      previousWeekend: mockData.previousWeekend,
      percentageChange
    });

    // Simulate fetching visitor data
    const mockVisitorData = {
      totalVisitors: 23,
      returningVisitors: 18,
      totalRegularAttenders: 104, // Total regular attenders (whether present or not)
      threeMonthAverage: 18.5, // Average visitors per week over past 3 months
    };
    
    const returningPercentage = mockVisitorData.totalVisitors > 0 
      ? (mockVisitorData.returningVisitors / mockVisitorData.totalVisitors) * 100
      : 0;
    
    // Calculate visitor health: target is 1 visitor per regular attender per year
    // Using 3-month average compared to total regular attenders (whether present or not)
    const targetVisitorsPerWeek = mockVisitorData.totalRegularAttenders / 52;
    const visitorHealth = targetVisitorsPerWeek > 0 
      ? ((mockVisitorData.threeMonthAverage - targetVisitorsPerWeek) / targetVisitorsPerWeek) * 100
      : 0;
    
    setVisitorStats({
      totalVisitors: mockVisitorData.totalVisitors,
      returningVisitors: mockVisitorData.returningVisitors,
      returningPercentage,
      visitorHealth,
      threeMonthAverage: mockVisitorData.threeMonthAverage
    });

    // Fetch recent activities from API
    try {
      const response = await api.get('/activities/recent?limit=10');
      setRecentActivities(response.data);
    } catch (error) {
      console.error('Error fetching recent activities:', error);
    }
    };
    
    fetchData();
  }, []);

  const formatTimeAgo = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diffInSeconds < 60) return 'just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    return `${Math.floor(diffInSeconds / 86400)}d ago`;
  };

  const getActivityIcon = (rawAction: string) => {
    switch (rawAction) {
      case 'RECORD_ATTENDANCE':
      case 'ADD_VISITOR':
      case 'ADD_REGULAR_ATTENDEE':
        return { icon: PencilIcon, color: 'text-blue-600' };
      case 'SEND_INVITATION':
      case 'RESEND_INVITATION':
        return { icon: PlusIcon, color: 'text-green-600' };
      case 'CANCEL_INVITATION':
      case 'DELETE_USER':
        return { icon: TrashIcon, color: 'text-red-600' };
      case 'CREATE_USER':
      case 'UPDATE_USER':
      case 'ASSIGN_USER_GATHERINGS':
        return { icon: PencilIcon, color: 'text-blue-600' };
      case 'CSV_UPLOAD':
      case 'COPY_PASTE_IMPORT':
        return { icon: ClipboardDocumentListIcon, color: 'text-purple-600' };
      case 'MASS_ASSIGN_TO_SERVICE':
      case 'MASS_REMOVE_FROM_SERVICE':
        return { icon: UserGroupIcon, color: 'text-indigo-600' };
      case 'ONBOARDING_CHURCH_INFO':
      case 'ONBOARDING_CREATE_GATHERING':
      case 'ONBOARDING_DELETE_GATHERING':
      case 'ONBOARDING_UPLOAD_CSV':
      case 'ONBOARDING_IMPORT_PASTE':
      case 'ONBOARDING_COMPLETE':
        return { icon: CalendarIcon, color: 'text-orange-600' };
      default:
        return { icon: EyeIcon, color: 'text-gray-600' };
    }
  };

  const stats = [
    {
      name: 'Last Weekend Attendance',
      value: weekendStats.lastWeekend,
      subtitle: `${weekendStats.percentageChange >= 0 ? '+' : ''}${weekendStats.percentageChange.toFixed(1)}% from previous`,
      icon: UserGroupIcon,
      color: 'bg-blue-500',
      trend: weekendStats.percentageChange > 0 ? 'up' : weekendStats.percentageChange < 0 ? 'down' : 'neutral',
      trendColor: weekendStats.percentageChange > 0 ? 'text-green-600' : weekendStats.percentageChange < 0 ? 'text-red-600' : 'text-gray-500'
    },
    {
      name: 'Weekend Visitors',
      value: visitorStats.totalVisitors,
      subtitle: `${visitorStats.returningPercentage.toFixed(0)}% returning • ${visitorStats.visitorHealth >= 0 ? '+' : ''}${visitorStats.visitorHealth.toFixed(0)}% vs healthy target (3mo avg)`,
      icon: UserPlusIcon,
      color: 'bg-green-500',
      trend: visitorStats.visitorHealth > 0 ? 'up' : visitorStats.visitorHealth < 0 ? 'down' : 'neutral',
      trendColor: visitorStats.visitorHealth > 0 ? 'text-green-600' : visitorStats.visitorHealth < 0 ? 'text-red-600' : 'text-gray-500'
    },
  ];

  return (
    <div className="space-y-6">
      {/* Welcome Header */}
      <div className="bg-white overflow-hidden shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h1 className="text-2xl font-bold text-gray-900">
            Welcome back, {user?.firstName}!
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Here's what's happening with Let My People Grow - your church attendance tracking and reporting system.
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {stats.map((stat) => (
          <div key={stat.name} className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <div className={`${stat.color} p-3 rounded-md`}>
                    <stat.icon className="h-6 w-6 text-white" aria-hidden="true" />
                  </div>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">
                      {stat.name}
                    </dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {stat.value}
                    </dd>
                    {stat.subtitle && (
                      <dd className="flex items-center text-sm">
                        <span className={stat.trendColor}>
                          {stat.trend === 'up' && <ArrowUpIcon className="h-4 w-4 mr-1" />}
                          {stat.trend === 'down' && <ArrowDownIcon className="h-4 w-4 mr-1" />}
                          {stat.subtitle}
                        </span>
                      </dd>
                    )}
                  </dl>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900">
            Quick Actions
          </h3>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <button className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary-500 rounded-lg border border-gray-300 hover:border-gray-400">
              <div>
                <span className="rounded-lg inline-flex p-3 bg-primary-50 text-primary-600 ring-4 ring-white">
                  <ClipboardDocumentListIcon className="h-6 w-6" aria-hidden="true" />
                </span>
              </div>
              <div className="mt-8">
                <h3 className="text-lg font-medium">
                  <span className="absolute inset-0" aria-hidden="true" />
                  Take Attendance
                </h3>
                <p className="mt-2 text-sm text-gray-500">
                  Record attendance for today's gathering
                </p>
              </div>
            </button>

            <button className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary-500 rounded-lg border border-gray-300 hover:border-gray-400">
              <div>
                <span className="rounded-lg inline-flex p-3 bg-green-50 text-green-600 ring-4 ring-white">
                  <ChartBarIcon className="h-6 w-6" aria-hidden="true" />
                </span>
              </div>
              <div className="mt-8">
                <h3 className="text-lg font-medium">
                  <span className="absolute inset-0" aria-hidden="true" />
                  View Reports
                </h3>
                <p className="mt-2 text-sm text-gray-500">
                  Analyze attendance trends and patterns
                </p>
              </div>
            </button>

            {(user?.role === 'admin' || user?.role === 'coordinator') && (
              <button 
                onClick={() => navigate('/app/gatherings')}
                className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary-500 rounded-lg border border-gray-300 hover:border-gray-400"
              >
                <div>
                  <span className="rounded-lg inline-flex p-3 bg-purple-50 text-purple-600 ring-4 ring-white">
                    <UserGroupIcon className="h-6 w-6" aria-hidden="true" />
                  </span>
                </div>
                <div className="mt-8">
                  <h3 className="text-lg font-medium">
                    <span className="absolute inset-0" aria-hidden="true" />
                    Manage Gatherings
                  </h3>
                  <p className="mt-2 text-sm text-gray-500">
                    Manage gatherings and their members
                  </p>
                </div>
              </button>
            )}

            {(user?.role === 'admin' || user?.role === 'coordinator') && (
              <button 
                onClick={() => navigate('/app/users')}
                className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary-500 rounded-lg border border-gray-300 hover:border-gray-400"
              >
                <div>
                  <span className="rounded-lg inline-flex p-3 bg-indigo-50 text-indigo-600 ring-4 ring-white">
                    <UserCircleIcon className="h-6 w-6" aria-hidden="true" />
                  </span>
                </div>
                <div className="mt-8">
                  <h3 className="text-lg font-medium">
                    <span className="absolute inset-0" aria-hidden="true" />
                    Manage Users
                  </h3>
                  <p className="mt-2 text-sm text-gray-500">
                    Invite and manage users and permissions
                  </p>
                </div>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900">
            Recent Activity
          </h3>
          <div className="mt-6 flow-root">
            {recentActivities.length > 0 ? (
              <ul role="list" className="divide-y divide-gray-200">
                {recentActivities.map((activity) => {
                  const { icon: ActivityIcon, color } = getActivityIcon(activity.rawAction);
                  return (
                    <li key={activity.id} className="py-3 flex">
                      <div className="flex-shrink-0">
                        <div className="flex items-center justify-center h-8 w-8 rounded-full bg-gray-100">
                          <ActivityIcon className={`h-5 w-5 ${color}`} aria-hidden="true" />
                        </div>
                      </div>
                      <div className="ml-3 flex-1">
                        <p className="text-sm font-medium text-gray-900">
                          {activity.user}
                        </p>
                                              <p className="text-sm text-gray-500">
                        {activity.action} {activity.target}
                        {activity.serviceType && ` in ${activity.serviceType}`}
                        {activity.serviceDate && ` for ${activity.serviceDate}`}
                        {activity.actionCount && activity.actionCount > 1 && ` (${activity.actionCount} updates)`}
                        <span className="mx-1">•</span>
                        {formatTimeAgo(activity.timestamp)}
                      </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="text-sm text-gray-500 text-center py-8">
                No recent activity to display.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardPage; 