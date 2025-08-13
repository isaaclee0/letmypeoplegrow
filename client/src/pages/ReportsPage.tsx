import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { reportsAPI, gatheringsAPI, settingsAPI, GatheringType, attendanceAPI } from '../services/api';
import { 
  ChartBarIcon, 
  UsersIcon, 
  ArrowTrendingUpIcon,
  ArrowDownTrayIcon
} from '@heroicons/react/24/outline';
import 'chart.js/auto';
import { Bar } from 'react-chartjs-2';

const ReportsPage: React.FC = () => {
  const { user } = useAuth();
  const [gatherings, setGatherings] = useState<GatheringType[]>([]);
  const [selectedGathering, setSelectedGathering] = useState<GatheringType | null>(null);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [metrics, setMetrics] = useState<any>(null);
  // Removed YoY and monthly visitors; charts now reflect selected period only
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [absenceList, setAbsenceList] = useState<Array<{ individualId: number; firstName: string; lastName: string; streak: number }>>([]);
  const [recentVisitors, setRecentVisitors] = useState<Array<{ key: string; name: string; count: number }>>([]);
  const [showAllAbsences, setShowAllAbsences] = useState(false);
  const [showAllVisitors, setShowAllVisitors] = useState(false);
  // DISABLED: External data access feature is currently disabled
  // const [dataAccessEnabled, setDataAccessEnabled] = useState(false);

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

  // DISABLED: External data access feature is currently disabled
  // const loadDataAccessSettings = useCallback(async () => {
  //   try {
  //     const response = await settingsAPI.getDataAccess();
  //     // setDataAccessEnabled(response.data.dataAccessEnabled); // This line is commented out
  //   } catch (err) {
  //     console.error('Failed to load data access settings:', err);
  //     // setDataAccessEnabled(false); // This line is commented out
  //   }
  // }, []);

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

  // Load recent session details to derive absence streaks and recent visitors
  const loadAbsenceAndVisitorDetails = useCallback(async () => {
    if (!selectedGathering || !metrics?.attendanceData) return;
    setIsLoadingDetails(true);
    try {
      const sessionDatesDesc: string[] = [...metrics.attendanceData]
        .map((s: any) => s.date)
        .sort((a: string, b: string) => b.localeCompare(a));
      const MAX_SESSIONS = 12;
      const limitedDates = sessionDatesDesc.slice(0, MAX_SESSIONS);

      const responses = await Promise.all(
        limitedDates.map((d: string) => attendanceAPI.get(selectedGathering.id, d))
      );

      type RegularEntry = { firstName: string; lastName: string; statuses: boolean[] };
      const regularMap = new Map<number, RegularEntry>();
      const visitorCounts = new Map<string, { name: string; count: number }>();
      const now = new Date();

      responses.forEach((resp: any, idx: number) => {
        const data = resp.data as { attendanceList?: any[]; visitors?: any[] };
        const sessionDateStr = limitedDates[idx];
        const sessionDate = new Date(sessionDateStr);
        const withinSixWeeks = (now.getTime() - sessionDate.getTime()) / (1000 * 60 * 60 * 24) <= 42;

        const list = data.attendanceList || [];
        list.forEach((ind: any) => {
          if (typeof ind.id !== 'number') return;
          const existing: RegularEntry = regularMap.get(ind.id) || { firstName: ind.firstName, lastName: ind.lastName, statuses: [] as boolean[] };
          existing.statuses.push(!!ind.present);
          regularMap.set(ind.id, existing);
        });

        if (withinSixWeeks) {
          const visitors = data.visitors || [];
          visitors.forEach((v: any) => {
            if (!v.present) return;
            const key = v.id ? `id:${v.id}` : `name:${v.name || 'Visitor'}`;
            const name = v.name || 'Visitor';
            const existing = visitorCounts.get(key) || { name, count: 0 };
            existing.count += 1;
            visitorCounts.set(key, existing);
          });
        }
      });

      const absenceArr: Array<{ individualId: number; firstName: string; lastName: string; streak: number }> = [];
      Array.from(regularMap.entries()).forEach(([id, entry]) => {
        let streak = 0;
        for (const present of entry.statuses) {
          if (present) break;
          streak += 1;
        }
        if (streak >= 2) {
          absenceArr.push({ individualId: id, firstName: entry.firstName, lastName: entry.lastName, streak });
        }
      });
      absenceArr.sort((a, b) => (b.streak - a.streak) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
      setAbsenceList(absenceArr);

      const visitorsArr = Array.from(visitorCounts.entries())
        .map(([key, val]) => ({ key, name: val.name, count: val.count }))
        .filter((v) => v.count >= 2)
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
      setRecentVisitors(visitorsArr);
      setShowAllAbsences(false);
      setShowAllVisitors(false);
    } catch (e) {
      // ignore
    } finally {
      setIsLoadingDetails(false);
    }
  }, [selectedGathering?.id, metrics?.attendanceData]);

  // Removed YoY metrics logic

  const getMonthKey = (dateStr: string) => {
    const d = new Date(dateStr);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  };

  const listMonthsInclusive = (startIso: string, endIso: string) => {
    const startD = new Date(startIso + 'T00:00:00');
    startD.setDate(1);
    const endD = new Date(endIso + 'T00:00:00');
    endD.setDate(1);
    const months: string[] = [];
    const cursor = new Date(startD);
    while (cursor <= endD) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, '0');
      months.push(`${y}-${m}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return months;
  };

  // Utility: simple moving average for trend lines
  const movingAverage = (values: number[], windowSize: number) => {
    if (windowSize <= 1) return values;
    const result: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - windowSize + 1);
      const slice = values.slice(start, i + 1);
      const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
      result.push(Math.round(avg));
    }
    return result;
  };

  // Removed old monthly visitors loader

  // Load recent session details to derive absence streaks and recent visitors
  // duplicate removed

  useEffect(() => {
    if (hasReportsAccess) {
      loadGatherings();
      // loadDataAccessSettings(); // This line is commented out
    }
  }, [hasReportsAccess, loadGatherings]); // Removed loadDataAccessSettings from dependency array

  useEffect(() => {
    if (!hasReportsAccess || !selectedGathering || !startDate || !endDate) return;
    loadMetrics();
  }, [selectedGathering, startDate, endDate, hasReportsAccess, loadMetrics]);

  useEffect(() => {
    if (!hasReportsAccess || !selectedGathering || !metrics?.attendanceData?.length) return;
    loadAbsenceAndVisitorDetails();
  }, [hasReportsAccess, selectedGathering, metrics?.attendanceData, loadAbsenceAndVisitorDetails]);

  // Attendance chart based on selected period sessions
  const formatShortDate = (isoDate: string) => {
    try {
      const d = new Date(isoDate);
      if (isNaN(d.getTime())) return isoDate;
      const day = String(d.getDate()).padStart(2, '0');
      const month = d.toLocaleString(undefined, { month: 'short' });
      const year = String(d.getFullYear()).slice(-2);
      return `${day} ${month} ${year}`;
    } catch {
      return isoDate;
    }
  };

  const attendanceChartLabels = useMemo(() => {
    if (!metrics?.attendanceData) return [] as string[];
    const dates = [...metrics.attendanceData.map((s: any) => s.date)].sort((a: string, b: string) => a.localeCompare(b));
    return dates.map(formatShortDate);
  }, [metrics?.attendanceData]);

  const attendanceChartData = useMemo(() => {
    if (!metrics?.attendanceData) return { labels: [], datasets: [] };
    const byDate: Record<string, number> = {};
    metrics.attendanceData.forEach((s: any) => {
      byDate[formatShortDate(s.date)] = s.present || 0;
    });
    const bars = attendanceChartLabels.map((d) => byDate[d] ?? 0);
    const trend = movingAverage(bars, Math.min(3, Math.max(2, Math.floor(bars.length / 4) || 2)));
    return {
      labels: attendanceChartLabels,
      datasets: [
        {
          type: 'bar' as const,
          label: 'Attendance',
          data: bars,
          backgroundColor: 'rgba(37, 99, 235, 0.6)'
        },
        {
          type: 'line' as const,
          label: 'Trend',
          data: trend,
          borderColor: 'rgba(16, 185, 129, 1)',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.3,
          fill: false,
          pointRadius: 0,
          borderWidth: 2,
        }
      ]
    };
  }, [metrics?.attendanceData, attendanceChartLabels]);

  // Visitors stacked bars (local vs traveller) over selected period
  const visitorsChartLabels = useMemo(() => attendanceChartLabels, [attendanceChartLabels]);

  const visitorsChartData = useMemo(() => {
    if (!metrics?.attendanceData) return { labels: [], datasets: [] };
    const local = metrics.attendanceData
      .slice()
      .sort((a: any, b: any) => a.date.localeCompare(b.date))
      .map((s: any) => s.visitorsLocal || 0);
    const traveller = metrics.attendanceData
      .slice()
      .sort((a: any, b: any) => a.date.localeCompare(b.date))
      .map((s: any) => s.visitorsTraveller || 0);
    return {
      labels: visitorsChartLabels,
      datasets: [
        {
          type: 'bar' as const,
          label: 'Local Visitors',
          data: local,
          backgroundColor: 'rgba(59, 130, 246, 0.7)'
        },
        {
          type: 'bar' as const,
          label: 'Traveller Visitors',
          data: traveller,
          backgroundColor: 'rgba(234, 88, 12, 0.7)'
        },
      ]
    };
  }, [metrics?.attendanceData, visitorsChartLabels]);

  const loadAttendanceDetails = useCallback(async () => {
    if (!selectedGathering || !metrics?.attendanceData) return;
    setIsLoadingDetails(true);
    try {
      const sessionDatesDesc: string[] = [...metrics.attendanceData]
        .map((s: any) => s.date)
        .sort((a: string, b: string) => b.localeCompare(a));
      const MAX_SESSIONS = 12;
      const limitedDates = sessionDatesDesc.slice(0, MAX_SESSIONS);

      const responses = await Promise.all(
        limitedDates.map((d: string) => attendanceAPI.get(selectedGathering.id, d))
      );

      type RegularEntry = { firstName: string; lastName: string; statuses: boolean[] };
      const regularMap = new Map<number, RegularEntry>();
      const visitorCounts = new Map<string, { name: string; count: number }>();
      const now = new Date();

      responses.forEach((resp: any, idx: number) => {
        const data = resp.data as { attendanceList?: any[]; visitors?: any[] };
        const sessionDateStr = limitedDates[idx];
        const sessionDate = new Date(sessionDateStr);
        const withinSixWeeks = (now.getTime() - sessionDate.getTime()) / (1000 * 60 * 60 * 24) <= 42;

        const list = data.attendanceList || [];
        list.forEach((ind: any) => {
          if (typeof ind.id !== 'number') return;
          const existing: RegularEntry = regularMap.get(ind.id) || { firstName: ind.firstName, lastName: ind.lastName, statuses: [] as boolean[] };
          existing.statuses.push(Boolean(ind.present));
          regularMap.set(ind.id, existing);
        });

        if (withinSixWeeks) {
          const visitors = data.visitors || [];
          visitors.forEach((v: any) => {
            if (!v.present) return;
            const key = v.id ? `id:${v.id}` : `name:${v.name || 'Visitor'}`;
            const name = v.name || 'Visitor';
            const existing = visitorCounts.get(key) || { name, count: 0 };
            existing.count += 1;
            visitorCounts.set(key, existing);
          });
        }
      });

      const absenceArr: Array<{ individualId: number; firstName: string; lastName: string; streak: number }> = [];
      Array.from(regularMap.entries()).forEach(([id, entry]) => {
        let streak = 0;
        for (const present of entry.statuses) {
          if (present) break;
          streak += 1;
        }
        if (streak >= 2) {
          absenceArr.push({ individualId: id, firstName: entry.firstName, lastName: entry.lastName, streak });
        }
      });
      absenceArr.sort((a, b) => (b.streak - a.streak) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
      setAbsenceList(absenceArr);

      const visitorsArr = Array.from(visitorCounts.entries()).map(([key, val]) => ({ key, name: val.name, count: val.count }))
        .filter((v) => v.count >= 2)
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
      setRecentVisitors(visitorsArr);
    } catch (e) {
      // ignore
    } finally {
      setIsLoadingDetails(false);
    }
  }, [selectedGathering?.id, metrics?.attendanceData]);

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
      setError('');
      
      const params = {
        gatheringTypeId: selectedGathering.id,
        startDate,
        endDate
      };
      
      console.log('Exporting data with params:', params);
      
      const response = await reportsAPI.exportData(params);
      
      console.log('Export response received:', response);
      
      // Check if response has data
      if (!response.data) {
        throw new Error('No data received from server');
      }
      
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
      
      console.log('File download initiated successfully');
      
    } catch (err: any) {
      console.error('Export error:', err);
      console.error('Error response:', err.response);
      
      let errorMessage = 'Failed to export data';
      
      if (err.response?.data?.error) {
        errorMessage = err.response.data.error;
      } else if (err.message) {
        errorMessage = err.message;
      }
      
      setError(errorMessage);
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
              {/* Commented out Spreadsheet Access functionality for now
              {dataAccessEnabled && (
                <button 
                  onClick={() => setShowSpreadsheetInstructions(true)}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                >
                  <ComputerDesktopIcon className="h-4 w-4 mr-2" />
                  Spreadsheet Access
                </button>
              )}
              */}
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

        {/* Removed Total Sessions tile */}

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <UsersIcon className="h-6 w-6 text-gray-400" />
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Total Regular Attenders
                  </dt>
                  <dd className="text-lg font-medium text-gray-900">
                    {isLoading ? '...' : (metrics?.totalRegulars ?? metrics?.totalIndividuals ?? 0)}
                  </dd>
                  <dt className="mt-1 text-xs font-medium text-gray-500 truncate">
                    Added in selected period
                  </dt>
                  <dd className="text-sm text-gray-700">
                    {isLoading ? '...' : (metrics?.addedRegularsInPeriod || 0)}
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
        {/* Attendance over selected period (per session) with trend line */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">Attendance Over Selected Period</h3>
            <div className="mt-6">
              {isLoading ? (
                <div className="flex justify-center items-center h-64">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
                </div>
              ) : attendanceChartLabels.length > 0 ? (
                <Bar
                  data={attendanceChartData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                      x: { stacked: false, grid: { display: false } },
                      y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } }
                    },
                    plugins: {
                      legend: { position: 'top' as const },
                      tooltip: { mode: 'index' as const, intersect: false }
                    }
                  }}
                  height={300}
                />
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

        {/* Visitors over selected period (stacked local vs traveller) */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">Visitors Over Selected Period</h3>
            <div className="mt-6">
              {visitorsChartLabels.length > 0 ? (
                <Bar
                  data={visitorsChartData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                      x: { stacked: true, grid: { display: false } },
                      y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } }
                    },
                    plugins: {
                      legend: { position: 'top' as const },
                      tooltip: { mode: 'index' as const, intersect: false }
                    }
                  }}
                  height={300}
                />
              ) : (
                <div className="flex justify-center items-center h-64">
                  <div className="text-gray-500">
                    <ChartBarIcon className="h-12 w-12 mx-auto mb-4" />
                    <p className="text-sm">No visitor data available for the selected period</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Absence and Recent Visitors Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Regulars Absent Panel */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">Regulars With Recent Absences</h3>
            <p className="mt-1 text-sm text-gray-500">Based on consecutive absences in the latest sessions for this gathering.</p>
            <div className="mt-4">
              {isLoadingDetails ? (
                <div className="flex justify-center items-center h-40">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
                </div>
              ) : absenceList.length === 0 ? (
                <div className="text-sm text-gray-500">No concerning absences right now.</div>
              ) : (
                <>
                <ul className="divide-y divide-gray-200">
                  {(showAllAbsences ? absenceList : absenceList.slice(0, 5)).map((p) => {
                    const base = 'px-3 py-2 flex items-center justify-between';
                    const color = p.streak >= 3 ? 'bg-orange-200' : 'bg-orange-100';
                    return (
                      <li key={p.individualId} className={`${base} ${color} rounded`}> 
                        <span className="font-medium text-gray-900">{p.firstName} {p.lastName}</span>
                        <span className="text-sm text-gray-700">Missed {p.streak} {p.streak === 1 ? 'service' : 'services'} in a row</span>
                      </li>
                    );
                  })}
                </ul>
                {absenceList.length > 5 && (
                  <div className="mt-3 text-right">
                    <button
                      type="button"
                      onClick={() => setShowAllAbsences((v) => !v)}
                      className="text-sm font-medium text-primary-600 hover:text-primary-700"
                    >
                      {showAllAbsences ? 'Show less' : `Show all (${absenceList.length})`}
                    </button>
                  </div>
                )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Recent Visitors Panel */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">Recent Visitors (last 6 weeks)</h3>
            <p className="mt-1 text-sm text-gray-500">Shows how many times a visitor has attended this gathering.</p>
            <div className="mt-4">
              {isLoadingDetails ? (
                <div className="flex justify-center items-center h-40">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
                </div>
              ) : recentVisitors.length === 0 ? (
                <div className="text-sm text-gray-500">No recent visitors yet.</div>
              ) : (
                <>
                <ul className="divide-y divide-gray-200">
                  {(showAllVisitors ? recentVisitors : recentVisitors.slice(0, 5)).map((v) => {
                    const base = 'px-3 py-2 flex items-center justify-between';
                    const color = v.count >= 3 ? 'bg-green-200' : 'bg-green-100';
                    return (
                      <li key={v.key} className={`${base} ${color} rounded`}>
                        <span className="font-medium text-gray-900">{v.name}</span>
                        <span className="text-sm text-gray-700">Attended {v.count} {v.count === 1 ? 'time' : 'times'}</span>
                      </li>
                    );
                  })}
                </ul>
                {recentVisitors.length > 5 && (
                  <div className="mt-3 text-right">
                    <button
                      type="button"
                      onClick={() => setShowAllVisitors((v) => !v)}
                      className="text-sm font-medium text-primary-600 hover:text-primary-700"
                    >
                      {showAllVisitors ? 'Show less' : `Show all (${recentVisitors.length})`}
              </button>
                  </div>
                )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Commented out Spreadsheet Instructions Modal for now - CSV export is sufficient */}
    </div>
  );
};

export default ReportsPage; 