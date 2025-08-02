import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { reportsAPI, gatheringsAPI, settingsAPI, GatheringType } from '../services/api';
import { 
  ChartBarIcon, 
  UsersIcon, 
  ArrowTrendingUpIcon,
  CalendarIcon,
  ArrowDownTrayIcon,
  ComputerDesktopIcon,
  XMarkIcon
} from '@heroicons/react/24/outline';

const ReportsPage: React.FC = () => {
  const { user } = useAuth();
  const [gatherings, setGatherings] = useState<GatheringType[]>([]);
  const [selectedGathering, setSelectedGathering] = useState<GatheringType | null>(null);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [metrics, setMetrics] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [dataAccessEnabled, setDataAccessEnabled] = useState(false);
  const [showSpreadsheetInstructions, setShowSpreadsheetInstructions] = useState(false);

  // Get the current domain for integration examples
  const getCurrentDomain = () => {
    return window.location.origin;
  };

  // Get the church ID for integration examples
  const getChurchId = () => {
    return user?.church_id || 'YOUR_CHURCH_ID';
  };

  // Get current year for date examples
  const getCurrentYear = () => {
    return new Date().getFullYear();
  };

  // Get default gathering ID for integration examples
  const getDefaultGatheringId = () => {
    return gatherings.length > 0 ? gatherings[0].id : 1;
  };

  // Check if user has access to reports
  const hasReportsAccess = user?.role === 'admin' || user?.role === 'coordinator';

  // Initialize default date range (last 4 weeks)
  useEffect(() => {
    const today = new Date();
    const fourWeeksAgo = new Date(today);
    fourWeeksAgo.setDate(today.getDate() - 28);
    
    setEndDate(today.toISOString().split('T')[0]);
    setStartDate(fourWeeksAgo.toISOString().split('T')[0]);
  }, []);

  const loadGatherings = useCallback(async () => {
    try {
      const response = await gatheringsAPI.getAll();
      const userGatherings = response.data.gatherings.filter((g: GatheringType) => 
        user?.gatheringAssignments?.some((assignment: any) => assignment.id === g.id)
      );
      setGatherings(userGatherings);
      
      // Default to first gathering if available
      if (userGatherings.length > 0 && !selectedGathering) {
        setSelectedGathering(userGatherings[0]);
      }
    } catch (err) {
      setError('Failed to load gatherings');
    }
  }, [user?.gatheringAssignments, selectedGathering]);

  const loadDataAccessSettings = useCallback(async () => {
    try {
      const response = await settingsAPI.getDataAccess();
      setDataAccessEnabled(response.data.dataAccessEnabled);
    } catch (err) {
      console.error('Failed to load data access settings:', err);
      setDataAccessEnabled(false);
    }
  }, []);

  const loadMetrics = useCallback(async () => {
    if (!selectedGathering || !startDate || !endDate) return;
    
    setIsLoading(true);
    try {
      const params = {
        gatheringTypeId: selectedGathering.id,
        startDate,
        endDate
      };
      const response = await reportsAPI.getDashboard(params);
      setMetrics(response.data.metrics);
    } catch (err) {
      setError('Failed to load metrics');
    } finally {
      setIsLoading(false);
    }
  }, [selectedGathering?.id, startDate, endDate]);

  useEffect(() => {
    if (hasReportsAccess) {
      loadGatherings();
      loadDataAccessSettings();
    }
  }, [hasReportsAccess, loadGatherings, loadDataAccessSettings]);

  useEffect(() => {
    if (hasReportsAccess && selectedGathering && startDate && endDate) {
      loadMetrics();
    }
  }, [selectedGathering, startDate, endDate, hasReportsAccess, loadMetrics]);

  const quickDateOptions = [
    { 
      label: 'Last 4 weeks', 
      getDates: () => {
        const today = new Date();
        const fourWeeksAgo = new Date(today);
        fourWeeksAgo.setDate(today.getDate() - 28);
        return {
          start: fourWeeksAgo.toISOString().split('T')[0],
          end: today.toISOString().split('T')[0]
        };
      }
    },
    { 
      label: 'Last 8 weeks', 
      getDates: () => {
        const today = new Date();
        const eightWeeksAgo = new Date(today);
        eightWeeksAgo.setDate(today.getDate() - 56);
        return {
          start: eightWeeksAgo.toISOString().split('T')[0],
          end: today.toISOString().split('T')[0]
        };
      }
    },
    { 
      label: 'Last 3 months', 
      getDates: () => {
        const today = new Date();
        const threeMonthsAgo = new Date(today);
        threeMonthsAgo.setMonth(today.getMonth() - 3);
        return {
          start: threeMonthsAgo.toISOString().split('T')[0],
          end: today.toISOString().split('T')[0]
        };
      }
    },
    { 
      label: 'Last 6 months', 
      getDates: () => {
        const today = new Date();
        const sixMonthsAgo = new Date(today);
        sixMonthsAgo.setMonth(today.getMonth() - 6);
        return {
          start: sixMonthsAgo.toISOString().split('T')[0],
          end: today.toISOString().split('T')[0]
        };
      }
    },
    { 
      label: 'Year to date', 
      getDates: () => {
        const today = new Date();
        const startOfYear = new Date(today.getFullYear(), 0, 1);
        return {
          start: startOfYear.toISOString().split('T')[0],
          end: today.toISOString().split('T')[0]
        };
      }
    }
  ];

  const handleQuickDateSelect = (option: any) => {
    const dates = option.getDates();
    setStartDate(dates.start);
    setEndDate(dates.end);
  };

  const handleExportData = async () => {
    if (!selectedGathering || !startDate || !endDate) {
      setError('Please select a gathering and date range before exporting');
      return;
    }

    try {
      setIsLoading(true);
      const params = {
        gatheringTypeId: selectedGathering.id,
        startDate,
        endDate
      };
      
      const response = await reportsAPI.exportData(params);
      
      // Create and download the file
      const blob = new Blob([response.data], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance-report-${selectedGathering.name}-${startDate}-to-${endDate}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      setError('');
    } catch (err) {
      setError('Failed to export data');
    } finally {
      setIsLoading(false);
    }
  };

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
            <div className="flex space-x-3">
              {dataAccessEnabled && (
                <button 
                  onClick={() => setShowSpreadsheetInstructions(true)}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                >
                  <ComputerDesktopIcon className="h-4 w-4 mr-2" />
                  Spreadsheet Access
                </button>
              )}
              <button 
                onClick={handleExportData}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
              >
                <ArrowDownTrayIcon className="h-4 w-4 mr-2" />
                Export Data
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Date Range Selection */}
            <div>
              <label htmlFor="date-range" className="block text-sm font-medium text-gray-700">
                Date Range
              </label>
              <div className="mt-1 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center sm:space-x-2 space-y-2 sm:space-y-0">
                  <input
                    type="date"
                    id="start-date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    max={new Date().toISOString().split('T')[0]}
                    className="block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm rounded-md"
                  />
                  <span className="text-gray-500 text-center sm:text-left">to</span>
                  <input
                    type="date"
                    id="end-date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    max={new Date().toISOString().split('T')[0]}
                    className="block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm rounded-md"
                  />
                </div>
                <div>
                  <label htmlFor="quick-dates" className="block text-sm font-medium text-gray-700">
                    Quick Select
                  </label>
                  <select
                    id="quick-dates"
                    onChange={(e) => {
                      const option = quickDateOptions.find(opt => opt.label === e.target.value);
                      if (option) handleQuickDateSelect(option);
                    }}
                    className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm rounded-md"
                  >
                    <option value="">Choose a preset...</option>
                    {quickDateOptions.map((option) => (
                      <option key={option.label} value={option.label}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
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
                  const gathering = gatherings.find((g: GatheringType) => g.id === parseInt(e.target.value));
                  setSelectedGathering(gathering || null);
                }}
                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm rounded-md"
              >
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


      {/* Spreadsheet Instructions Modal */}
      {showSpreadsheetInstructions && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 max-w-4xl shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-medium text-gray-900">Spreadsheet Integration Instructions</h3>
                <button
                  onClick={() => setShowSpreadsheetInstructions(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="space-y-6">
                {/* Google Sheets Instructions */}
                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="text-md font-medium text-gray-900 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/>
                    </svg>
                    Google Sheets
                  </h4>
                  <div className="space-y-3">
                    <p className="text-sm text-gray-600">
                      Use the IMPORTDATA function to automatically import your attendance data:
                    </p>
                    
                    {/* Test Endpoints */}
                    <div className="bg-yellow-50 border border-yellow-200 rounded p-3">
                      <p className="text-sm font-medium text-yellow-800 mb-2">Test First (Recommended):</p>
                      <div className="space-y-2">
                        <div>
                          <code className="text-xs font-mono bg-white p-1 rounded">
                            =IMPORTDATA("{getCurrentDomain()}/api/public-csv")
                          </code>
                        </div>
                        <div>
                          <code className="text-xs font-mono bg-white p-1 rounded">
                            =IMPORTDATA("{getCurrentDomain()}/api/simple-test")
                          </code>
                        </div>
                        <div>
                          <code className="text-xs font-mono bg-white p-1 rounded">
                            =IMPORTDATA("{getCurrentDomain()}/api/sheets-test")
                          </code>
                        </div>
                        <div>
                          <code className="text-xs font-mono bg-white p-1 rounded">
                            =IMPORTDATA("{getCurrentDomain()}/api/importrange/test")
                          </code>
                        </div>
                        <div>
                          <code className="text-xs font-mono bg-white p-1 rounded">
                            =IMPORTDATA("{getCurrentDomain()}/api/importrange/public-attendance")
                          </code>
                        </div>
                      </div>
                    </div>
                    
                    {/* Production Endpoint */}
                    <div className="bg-gray-50 p-3 rounded border">
                      <p className="text-sm font-medium text-gray-700 mb-2">Production (with authentication):</p>
                      <code className="text-sm font-mono">
                        =IMPORTDATA("{getCurrentDomain()}/api/importrange/attendance?church_id={getChurchId()}&gatheringTypeId={getDefaultGatheringId()}&startDate={getCurrentYear()}-01-01&endDate={getCurrentYear()}-12-31")
                      </code>
                    </div>
                    
                    <div className="text-xs text-gray-500">
                      <p><strong>Note:</strong> The domain, church ID, and gathering type are automatically set to your current location and church.</p>
                      <p><strong>Data format:</strong> The data format matches the CSV export from the Reports page.</p>
                      <p><strong>Gathering type:</strong> Currently set to "{gatherings.length > 0 ? gatherings[0].name : 'Default'}" (ID: {getDefaultGatheringId()}).</p>
                      <p><strong>IMPORTDATA:</strong> This function automatically imports CSV data from the URL. No additional parameters needed.</p>
                      <p><strong>Troubleshooting:</strong> If the production endpoint doesn't work, try the test endpoints first.</p>
                    </div>
                  </div>
                </div>

                {/* Excel Instructions */}
                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="text-md font-medium text-gray-900 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1v5h5v10H6V3h7z"/>
                    </svg>
                    Microsoft Excel
                  </h4>
                  <div className="space-y-3">
                    <p className="text-sm text-gray-600">
                      Use Excel's Power Query to import data from the web:
                    </p>
                    <ol className="text-sm text-gray-600 list-decimal list-inside space-y-1">
                      <li>Go to <strong>Data</strong> → <strong>Get Data</strong> → <strong>From Web</strong></li>
                      <li>Enter the URL: <code className="bg-gray-100 px-1 rounded">{getCurrentDomain()}/api/importrange/attendance?church_id={getChurchId()}&gatheringTypeId={getDefaultGatheringId()}&startDate={getCurrentYear()}-01-01&endDate={getCurrentYear()}-12-31</code></li>
                      <li>Click <strong>OK</strong> and follow the import wizard</li>
                      <li>Set up automatic refresh if desired</li>
                    </ol>
                  </div>
                </div>

                {/* Numbers Instructions */}
                <div className="border border-gray-200 rounded-lg p-4">
                  <h4 className="text-md font-medium text-gray-900 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
                    </svg>
                    Apple Numbers
                  </h4>
                  <div className="space-y-3">
                    <p className="text-sm text-gray-600">
                      Use Numbers' web data import feature:
                    </p>
                    <ol className="text-sm text-gray-600 list-decimal list-inside space-y-1">
                      <li>Go to <strong>Insert</strong> → <strong>Chart</strong> → <strong>Web Data</strong></li>
                      <li>Enter the URL: <code className="bg-gray-100 px-1 rounded">{getCurrentDomain()}/api/importrange/attendance?church_id={getChurchId()}&gatheringTypeId={getDefaultGatheringId()}&startDate={getCurrentYear()}-01-01&endDate={getCurrentYear()}-12-31</code></li>
                      <li>Choose <strong>CSV</strong> as the data format</li>
                      <li>Click <strong>Import</strong> to add the data</li>
                    </ol>
                  </div>
                </div>

                {/* General Information */}
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-blue-900 mb-2">Important Information</h4>
                  <ul className="text-sm text-blue-700 space-y-1">
                    <li>• Data access must be enabled in Settings → Data Privacy</li>
                    <li>• The domain and church ID are automatically detected</li>
                    <li>• Data is updated in real-time when accessed</li>
                    <li>• Date ranges can be customized in the URL parameters</li>
                    <li>• For security, access is limited to your church's data only</li>
                  </ul>
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={() => setShowSpreadsheetInstructions(false)}
                  className="px-4 py-2 bg-gray-300 text-gray-700 rounded-md hover:bg-gray-400"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReportsPage; 