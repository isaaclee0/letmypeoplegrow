import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { reportsAPI, gatheringsAPI, GatheringType } from '../services/api';
import { 
  ChartBarIcon, 
  UsersIcon, 
  ArrowTrendingUpIcon,
  CalendarIcon,
  ArrowDownTrayIcon
} from '@heroicons/react/24/outline';

const ReportsPage: React.FC = () => {
  const { user } = useAuth();
  const [gatherings, setGatherings] = useState<GatheringType[]>([]);
  const [selectedGathering, setSelectedGathering] = useState<GatheringType | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState('4');
  const [metrics, setMetrics] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Check if user has access to reports
  const hasReportsAccess = user?.role === 'admin' || user?.role === 'coordinator';

  useEffect(() => {
    if (hasReportsAccess) {
      loadGatherings();
    }
  }, [hasReportsAccess]);

  useEffect(() => {
    if (hasReportsAccess && (selectedGathering || selectedPeriod)) {
      loadMetrics();
    }
  }, [selectedGathering, selectedPeriod, hasReportsAccess]);

  const loadGatherings = async () => {
    try {
      const response = await gatheringsAPI.getAll();
      const userGatherings = response.data.gatherings.filter((g: GatheringType) => 
        user?.gatheringAssignments?.some(assignment => assignment.id === g.id)
      );
      setGatherings(userGatherings);
    } catch (err) {
      setError('Failed to load gatherings');
    }
  };

  const loadMetrics = async () => {
    setIsLoading(true);
    try {
      const params = {
        gatheringTypeId: selectedGathering?.id,
        weeks: parseInt(selectedPeriod)
      };
      const response = await reportsAPI.getDashboard(params);
      setMetrics(response.data.metrics);
    } catch (err) {
      setError('Failed to load metrics');
    } finally {
      setIsLoading(false);
    }
  };

  const periodOptions = [
    { value: '4', label: 'Last 4 weeks' },
    { value: '8', label: 'Last 8 weeks' },
    { value: '12', label: 'Last 3 months' },
    { value: '24', label: 'Last 6 months' },
    { value: '52', label: 'Year to date' },
  ];

  if (!hasReportsAccess) {
    return (
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6 text-center">
          <ChartBarIcon className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900">Access Restricted</h3>
          <p className="mt-1 text-sm text-gray-500">
            You don't have permission to view reports. Contact your administrator for access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Reports & Analytics</h1>
              <p className="mt-1 text-sm text-gray-500">
                View attendance trends and insights
              </p>
            </div>
            <button className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500">
              <ArrowDownTrayIcon className="h-4 w-4 mr-2" />
              Export Data
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Period Selection */}
            <div>
              <label htmlFor="period" className="block text-sm font-medium text-gray-700">
                Time Period
              </label>
              <select
                id="period"
                value={selectedPeriod}
                onChange={(e) => setSelectedPeriod(e.target.value)}
                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm rounded-md"
              >
                {periodOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Gathering Selection */}
            <div>
              <label htmlFor="gathering" className="block text-sm font-medium text-gray-700">
                Gathering Type
              </label>
              <select
                id="gathering"
                value={selectedGathering?.id || ''}
                onChange={(e) => {
                  const gathering = gatherings.find(g => g.id === parseInt(e.target.value));
                  setSelectedGathering(gathering || null);
                }}
                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm rounded-md"
              >
                <option value="">All gatherings</option>
                {gatherings.map((gathering) => (
                  <option key={gathering.id} value={gathering.id}>
                    {gathering.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4">
          <div className="text-sm text-red-700">{error}</div>
        </div>
      )}

      {/* Key Metrics */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <UsersIcon className="h-6 w-6 text-gray-400" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Average Attendance
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {isLoading ? '...' : (metrics?.averageAttendance || 0)}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <ArrowTrendingUpIcon className="h-6 w-6 text-gray-400" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Growth Rate
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {isLoading ? '...' : `${metrics?.growthRate || 0}%`}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <CalendarIcon className="h-6 w-6 text-gray-400" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Total Sessions
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {isLoading ? '...' : (metrics?.totalSessions || 0)}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <UsersIcon className="h-6 w-6 text-gray-400" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Total Individuals
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {isLoading ? '...' : (metrics?.totalIndividuals || 0)}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <UsersIcon className="h-6 w-6 text-gray-400" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Total Absences
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {isLoading ? '...' : (metrics?.totalAbsent || 0)}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Attendance Trend Chart */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              Attendance Trend
            </h3>
            <div className="mt-6">
              {isLoading ? (
                <div className="flex justify-center items-center h-64">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
                </div>
              ) : metrics?.attendanceData && metrics.attendanceData.length > 0 ? (
                <div className="space-y-4">
                  {metrics.attendanceData.slice(0, 8).map((session: any, index: number) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-900">
                          {new Date(session.date).toLocaleDateString()}
                        </div>
                        <div className="text-sm text-gray-500">
                          {session.present} present, {session.absent} absent
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-semibold text-primary-600">
                          {session.present}
                        </div>
                        <div className="text-xs text-gray-500">
                          of {session.total}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex justify-center items-center h-64">
                  <div className="text-gray-500">
                    <ChartBarIcon className="h-12 w-12 mx-auto mb-4" />
                    <p className="text-sm">No attendance data available for the selected period</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Visitor Analysis */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              Visitor Analysis
            </h3>
            <div className="mt-6">
              {isLoading ? (
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
              ) : (
                <p className="text-sm text-gray-500">Total visitors in period: {metrics?.totalVisitors || 0} (placeholder)</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Detailed Reports Section */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900">
            Detailed Reports
          </h3>
          <div className="mt-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <button className="p-4 border border-gray-300 rounded-lg hover:border-gray-400 text-left">
                <h4 className="font-medium text-gray-900">Attendance Summary</h4>
                <p className="text-sm text-gray-500 mt-1">
                  Comprehensive attendance data export
                </p>
              </button>
              <button className="p-4 border border-gray-300 rounded-lg hover:border-gray-400 text-left">
                <h4 className="font-medium text-gray-900">Visitor Report</h4>
                <p className="text-sm text-gray-500 mt-1">
                  Visitor patterns and follow-up data
                </p>
              </button>
              <button className="p-4 border border-gray-300 rounded-lg hover:border-gray-400 text-left">
                <h4 className="font-medium text-gray-900">Family Analytics</h4>
                <p className="text-sm text-gray-500 mt-1">
                  Family participation insights
                </p>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReportsPage; 