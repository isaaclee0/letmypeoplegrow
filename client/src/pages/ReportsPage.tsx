import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { reportsAPI, gatheringsAPI, settingsAPI, GatheringType, attendanceAPI } from '../services/api';
import { userPreferences } from '../services/userPreferences';
import logger from '../utils/logger';
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
  const [selectedGatherings, setSelectedGatherings] = useState<GatheringType[]>([]);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [metrics, setMetrics] = useState<any>(null);
  const [gatheringNames, setGatheringNames] = useState<Record<number, string>>({});
  // Removed YoY and monthly visitors; charts now reflect selected period only
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingGatherings, setIsLoadingGatherings] = useState(true);
  const [error, setError] = useState('');
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [absenceList, setAbsenceList] = useState<Array<{ individualId: number; firstName: string; lastName: string; familyId?: number | null; familyName?: string | null; streak: number }>>([]);
  const [groupedAbsences, setGroupedAbsences] = useState<Array<{ key: string; name: string; streak: number }>>([]);
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

  // Check if the selected gathering is a headcount gathering
  const isHeadcountGathering = selectedGathering?.attendanceType === 'headcount';
  
  // Check if we have multiple gatherings selected
  const hasMultipleGatherings = selectedGatherings.length > 1;
  
  // Check if we have mixed gathering types (both headcount and standard)
  const hasMixedGatheringTypes = selectedGatherings.length > 0 && 
    selectedGatherings.some(g => g.attendanceType === 'headcount') && 
    selectedGatherings.some(g => g.attendanceType === 'standard');
  
  // Determine if we should show visitor information
  const shouldShowVisitorInfo = hasMixedGatheringTypes || 
    (selectedGatherings.length === 1 && selectedGatherings[0].attendanceType === 'standard') ||
    (!hasMultipleGatherings && selectedGathering?.attendanceType === 'standard');

  // Initialize default date range (last 4 weeks) and load from preferences
  useEffect(() => {
    const initializeReportsData = async () => {
      // Try to load from preferences first
      const lastViewed = await userPreferences.getReportsLastViewed();
      
      if (lastViewed) {
        setStartDate(lastViewed.startDate);
        setEndDate(lastViewed.endDate);
        // selectedGatherings will be set after gatherings are loaded
      } else {
        // Default to last 4 weeks
        const today = new Date();
        const fourWeeksAgo = new Date(today);
        fourWeeksAgo.setDate(today.getDate() - 28);
        
        setEndDate(today.toISOString().split('T')[0]);
        setStartDate(fourWeeksAgo.toISOString().split('T')[0]);
      }
    };
    
    initializeReportsData();
  }, []);

  // Save current reports state to preferences
  const saveReportsPreferences = useCallback(async () => {
    if (selectedGatherings.length > 0 && startDate && endDate) {
      try {
        await userPreferences.setReportsLastViewed(
          selectedGatherings.map(g => g.id),
          startDate,
          endDate
        );
      } catch (error) {
        logger.warn('Failed to save reports preferences:', error);
      }
    }
  }, [selectedGatherings, startDate, endDate]);

  const loadGatherings = useCallback(async () => {
    try {
      setIsLoadingGatherings(true);
      const response = await gatheringsAPI.getAll();
      const userGatherings: GatheringType[] = response.data.gatherings.filter((g: GatheringType) => 
        user?.gatheringAssignments?.some((assignment: any) => assignment.id === g.id)
      );
      // Apply saved order preference
      let ordered = userGatherings;
      try {
        const savedOrder = await userPreferences.getGatheringOrder();
        if (savedOrder?.order) {
          const orderIds: number[] = savedOrder.order;
          const idToItem = new Map<number, GatheringType>(userGatherings.map((i: GatheringType) => [i.id, i] as const));
          const temp: GatheringType[] = [];
          orderIds.forEach((id: number) => { const it = idToItem.get(id); if (it) temp.push(it); });
          userGatherings.forEach((i: GatheringType) => { if (!orderIds.includes(i.id)) temp.push(i); });
          ordered = temp;
        }
      } catch (e) {
        logger.warn('Failed to load gathering order for reports:', e);
      }
      setGatherings(ordered);
      
      // Default to first gathering if available
      if (ordered.length > 0 && !selectedGathering) {
        // Prefer explicitly saved default id
        const savedDefaultId = user?.id ? localStorage.getItem(`user_${user.id}_default_gathering_id`) : null;
        if (savedDefaultId) {
          const idNum = parseInt(savedDefaultId, 10);
          const found = ordered.find((g: GatheringType) => g.id === idNum) || null;
          setSelectedGathering(found || ordered[0]);
        } else {
          setSelectedGathering(ordered[0]);
        }
      }
      
      // Initialize selectedGatherings with the default gathering or from preferences
      if (ordered.length > 0 && selectedGatherings.length === 0) {
        // Try to restore from preferences first
        const lastViewed = await userPreferences.getReportsLastViewed();
        
        if (lastViewed && lastViewed.selectedGatherings.length > 0) {
          // Restore selected gatherings from preferences
          const restoredGatherings = lastViewed.selectedGatherings
            .map(id => ordered.find(g => g.id === id))
            .filter(Boolean) as GatheringType[];
          
          if (restoredGatherings.length > 0) {
            setSelectedGatherings(restoredGatherings);
            // Also set the first one as selectedGathering for single gathering logic
            setSelectedGathering(restoredGatherings[0]);
            return;
          }
        }
        
        // Fallback to default gathering
        const defaultGathering = selectedGathering || ordered[0];
        setSelectedGatherings([defaultGathering]);
      }
    } catch (err) {
      setError('Failed to load gatherings');
    } finally {
      setIsLoadingGatherings(false);
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
    if (selectedGatherings.length === 0 || !startDate || !endDate) return;
    
    setIsLoading(true);
    try {
      const params = {
        gatheringTypeIds: selectedGatherings.map(g => g.id),
        startDate,
        endDate
      };
      const response = await reportsAPI.getDashboard(params);
      setMetrics(response.data.metrics);
      setGatheringNames(response.data.gatheringNames || {});
    } catch (err) {
      setError('Failed to load metrics');
    } finally {
      setIsLoading(false);
    }
  }, [selectedGatherings, startDate, endDate]);

  // Load recent session details to derive absence streaks and recent visitors
  const loadAbsenceAndVisitorDetails = useCallback(async () => {
    if (selectedGatherings.length === 0 || !metrics?.attendanceData) return;
    setIsLoadingDetails(true);
    try {
      const sessionDatesDesc: string[] = [...metrics.attendanceData]
        .map((s: any) => s.date)
        .sort((a: string, b: string) => b.localeCompare(a));
      const MAX_SESSIONS = 12;
      const limitedDates = sessionDatesDesc.slice(0, MAX_SESSIONS);

      const responses = await Promise.all(
        limitedDates.flatMap((d: string) => 
          selectedGatherings.map(g => attendanceAPI.get(g.id, d))
        )
      );

      type RegularEntry = { firstName: string; lastName: string; familyId?: number | null; familyName?: string | null; statuses: boolean[] };
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
           const existing: RegularEntry = regularMap.get(ind.id) || { firstName: ind.firstName, lastName: ind.lastName, familyId: (ind as any).familyId ?? null, familyName: (ind as any).familyName ?? null, statuses: [] as boolean[] };
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

      const absenceArr: Array<{ individualId: number; firstName: string; lastName: string; familyId?: number | null; familyName?: string | null; streak: number }> = [];
      Array.from(regularMap.entries()).forEach(([id, entry]) => {
        let streak = 0;
        for (const present of entry.statuses) {
          if (present) break;
          streak += 1;
        }
        if (streak >= 2) {
          absenceArr.push({ individualId: id, firstName: entry.firstName, lastName: entry.lastName, familyId: entry.familyId ?? null, familyName: entry.familyName ?? null, streak });
        }
      });
      absenceArr.sort((a, b) => (b.streak - a.streak) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
      setAbsenceList(absenceArr);

      // Group absences by family ONLY if every member of the family is absent (streak >= 2)
      const grouped: Array<{ key: string; name: string; streak: number }> = [];
      const absentById = new Map<number, number>();
      absenceArr.forEach(a => absentById.set(a.individualId, a.streak));

      // Build family membership from regularMap (covers all assigned members)
      const familyMembers = new Map<number, { familyName: string | null; memberIds: number[] }>();
      for (const [id, entry] of regularMap.entries()) {
        const famId = (entry.familyId ?? null) as number | null;
        const famName = (entry.familyName ?? null) as string | null;
        if (famId) {
          const current = familyMembers.get(famId) || { familyName: famName, memberIds: [] };
          if (!current.memberIds.includes(id)) current.memberIds.push(id);
          // Preserve first seen family name
          if (!current.familyName && famName) current.familyName = famName;
          familyMembers.set(famId, current);
        }
      }

      // Helper to format family label from stored familyName ("SURNAME, A & B" -> "Surname family")
      const formatFamilyLabel = (famName?: string | null) => {
        if (!famName || !famName.trim()) return 'Family';
        const parts = famName.split(',');
        const surnameRaw = (parts[0] || famName).trim();
        const proper = surnameRaw.charAt(0).toUpperCase() + surnameRaw.slice(1).toLowerCase();
        return `${proper} family`;
      };

      // Determine families where all members are absent (streak >= 2)
      const groupedMemberIds = new Set<number>();
      for (const [famId, meta] of familyMembers.entries()) {
        if (meta.memberIds.length <= 1) continue; // only group true families
        let allAbsent = true;
        let minStreak = Number.MAX_SAFE_INTEGER;
        for (const memberId of meta.memberIds) {
          const st = absentById.get(memberId) || 0;
          if (st < 2) { // fewer than threshold => not all absent
            allAbsent = false;
            break;
          }
          if (st < minStreak) minStreak = st;
        }
        if (allAbsent && minStreak !== Number.MAX_SAFE_INTEGER) {
          meta.memberIds.forEach(id => groupedMemberIds.add(id));
          grouped.push({ key: `fam:${famId}`, name: formatFamilyLabel(meta.familyName), streak: minStreak });
        }
      }

      // Add remaining individuals who are absent but not part of a fully-absent family
      absenceArr.forEach(a => {
        if (!groupedMemberIds.has(a.individualId)) {
          grouped.push({ key: `ind:${a.individualId}`, name: `${a.firstName} ${a.lastName}`, streak: a.streak });
        }
      });

      grouped.sort((a, b) => (b.streak - a.streak) || a.name.localeCompare(b.name));
      setGroupedAbsences(grouped);

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
  }, [selectedGatherings, metrics?.attendanceData]);

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
    if (!hasReportsAccess || selectedGatherings.length === 0 || !startDate || !endDate) return;
    loadMetrics();
  }, [selectedGatherings, startDate, endDate, hasReportsAccess, loadMetrics]);

  useEffect(() => {
    if (!hasReportsAccess || selectedGatherings.length === 0 || !metrics?.attendanceData?.length) return;
    loadAbsenceAndVisitorDetails();
  }, [hasReportsAccess, selectedGatherings, metrics?.attendanceData, loadAbsenceAndVisitorDetails]);

  // Save preferences when selections change
  useEffect(() => {
    if (selectedGatherings.length > 0 && startDate && endDate) {
      saveReportsPreferences();
    }
  }, [selectedGatherings, startDate, endDate, saveReportsPreferences]);

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
    // Get unique dates and sort them
    const uniqueDates = [...new Set(metrics.attendanceData.map((s: any) => s.date))].sort((a: string, b: string) => a.localeCompare(b));
    return uniqueDates.map(formatShortDate);
  }, [metrics?.attendanceData]);

  const attendanceChartData = useMemo(() => {
    if (!metrics?.attendanceData) return { labels: [], datasets: [] };
    
    // Get unique dates in the same order as attendanceChartLabels
    const uniqueDates = [...new Set(metrics.attendanceData.map((s: any) => s.date))].sort((a: string, b: string) => a.localeCompare(b));
    
    // Group data by date and gathering
    const byDate: Record<string, Record<number, number>> = {};
    metrics.attendanceData.forEach((s: any) => {
      const value = s.present_individuals || s.present || 0;
      const numericValue = typeof value === 'string' ? parseInt(value, 10) : value;
      
      if (!byDate[s.date]) {
        byDate[s.date] = {};
      }
      byDate[s.date][s.gatheringId as number] = numericValue;
    });

    // Generate datasets for each gathering
    const datasets: any[] = [];
    const gatheringIds: number[] = Array.from(new Set(metrics.attendanceData.map((s: any) => s.gatheringId)));
    
    // Define colors for different gatherings - blue for first, orange for second
    const colors = [
      'rgba(37, 99, 235, 0.6)',   // Blue (first gathering - bottom of stack)
      'rgba(249, 115, 22, 0.6)',  // Orange-500 (second gathering - on top)
      'rgba(16, 185, 129, 0.6)',  // Green
      'rgba(139, 92, 246, 0.6)',  // Purple
      'rgba(236, 72, 153, 0.6)',  // Pink
      'rgba(6, 182, 212, 0.6)',   // Cyan
      'rgba(34, 197, 94, 0.6)',   // Emerald
      'rgba(245, 158, 11, 0.6)',  // Yellow
    ];

    gatheringIds.forEach((gatheringId: number, index) => {
      const gatheringName = gatheringNames[gatheringId] || `Gathering ${gatheringId}`;
      const data = uniqueDates.map((date: string) => {
        return byDate[date]?.[gatheringId] || 0;
      });
      
      datasets.push({
        type: 'bar' as const,
        label: gatheringName,
        data: data,
        backgroundColor: colors[index % colors.length],
        borderColor: colors[index % colors.length].replace('0.6', '1'),
        borderWidth: 1
      });
    });

    // Calculate trend line from total values
    const totalBars = uniqueDates.map((date: string) => {
      return Object.values(byDate[date] || {} as Record<number, number>).reduce((sum: number, val: number) => sum + val, 0);
    });
    const trend = movingAverage(totalBars as number[], Math.min(3, Math.max(2, Math.floor(totalBars.length / 4) || 2)));
    
    datasets.push({
      type: 'line' as const,
      label: 'Trend',
      data: trend,
      borderColor: 'rgba(16, 185, 129, 1)',
      backgroundColor: 'rgba(16, 185, 129, 0.1)',
      tension: 0.3,
      fill: false,
      pointRadius: 0,
      borderWidth: 2,
    });

    return {
      labels: attendanceChartLabels,
      datasets: datasets
    };
  }, [metrics?.attendanceData, attendanceChartLabels, gatheringNames]);

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
    if (selectedGatherings.length === 0 || !metrics?.attendanceData) return;
    setIsLoadingDetails(true);
    try {
      const sessionDatesDesc: string[] = [...metrics.attendanceData]
        .map((s: any) => s.date)
        .sort((a: string, b: string) => b.localeCompare(a));
      const MAX_SESSIONS = 12;
      const limitedDates = sessionDatesDesc.slice(0, MAX_SESSIONS);

      const responses = await Promise.all(
        limitedDates.flatMap((d: string) => 
          selectedGatherings.map(g => attendanceAPI.get(g.id, d))
        )
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
  }, [selectedGatherings, metrics?.attendanceData]);

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
    if (selectedGatherings.length === 0 || !startDate || !endDate) {
      setError('Please select at least one gathering and date range before exporting');
      return;
    }

    try {
      setIsLoading(true);
      setError('');
      
      const params = {
        gatheringTypeIds: selectedGatherings.map(g => g.id),
        startDate,
        endDate
      };
      
      logger.log('Exporting data with params:', params);
      
      const response = await reportsAPI.exportData(params);
      
      logger.log('Export response received:', response);
      
      // Check if response has data
      if (!response.data) {
        throw new Error('No data received from server');
      }
      
      // Create and download the file
      const blob = new Blob([response.data], { type: 'text/tab-separated-values' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const gatheringNames = selectedGatherings.map(g => g.name).join('-');
      a.download = `attendance-report-${gatheringNames}-${startDate}-to-${endDate}.tsv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      logger.log('File download initiated successfully');
      
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
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Gathering Types
              </label>
              <div className="space-y-2 max-h-40 overflow-y-auto border border-gray-300 rounded-md p-3">
                {gatherings.map((gathering) => (
                  <label key={gathering.id} className="flex items-center">
                    <input
                      type="checkbox"
                      checked={selectedGatherings.some(g => g.id === gathering.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedGatherings([...selectedGatherings, gathering]);
                        } else {
                          setSelectedGatherings(selectedGatherings.filter(g => g.id !== gathering.id));
                        }
                      }}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700">
                      {gathering.name}
                      <span className={`ml-1 text-xs px-2 py-1 rounded-full ${
                        gathering.attendanceType === 'headcount' 
                          ? 'bg-blue-100 text-blue-800' 
                          : 'bg-green-100 text-green-800'
                      }`}>
                        {gathering.attendanceType === 'headcount' ? 'Headcount' : 'Standard'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {isLoadingGatherings ? (
                <div className="mt-1 flex items-center text-sm text-gray-500">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-600 mr-2"></div>
                  Loading gatherings...
                </div>
              ) : selectedGatherings.length === 0 ? (
                <p className="mt-1 text-sm text-red-600">Please select at least one gathering</p>
              ) : null}
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
                    {hasMultipleGatherings 
                      ? (hasMixedGatheringTypes ? 'Average Combined' : isHeadcountGathering ? 'Average Headcount' : 'Average Attendance')
                      : (isHeadcountGathering ? 'Average Headcount' : 'Average Attendance')
                    }
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

        {shouldShowVisitorInfo && (
          <>
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
          </>
        )}
      </div>

      {/* Charts Section */}
      <div className={`grid grid-cols-1 gap-6 ${!shouldShowVisitorInfo ? 'lg:grid-cols-1' : 'lg:grid-cols-2'}`}>
        {/* Attendance over selected period (per session) with trend line */}
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              {hasMultipleGatherings 
                ? `${hasMixedGatheringTypes ? 'Combined Attendance & Headcount' : isHeadcountGathering ? 'Combined Headcount' : 'Combined Attendance'} Over Selected Period`
                : isHeadcountGathering ? 'Headcount Over Selected Period' : 'Attendance Over Selected Period'
              }
            </h3>
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
                      x: { stacked: hasMultipleGatherings, grid: { display: false } },
                      y: { 
                        stacked: hasMultipleGatherings,
                        beginAtZero: true, 
                        grid: { color: 'rgba(0,0,0,0.05)' } 
                      }
                    },
                    plugins: {
                      legend: { 
                        position: 'top' as const,
                        display: true
                      },
                      tooltip: { 
                        mode: hasMultipleGatherings ? 'index' as const : 'nearest' as const, 
                        intersect: false 
                      }
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

        {/* Visitors over selected period (stacked local vs traveller) - Hidden for headcount-only gatherings */}
        {shouldShowVisitorInfo && (
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
        )}
      </div>

      {/* Absence and Recent Visitors Panels - Hidden for headcount-only gatherings */}
      {shouldShowVisitorInfo && (
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
                 ) : groupedAbsences.length === 0 ? (
                  <div className="text-sm text-gray-500">No concerning absences right now.</div>
                ) : (
                  <>
                  <ul className="divide-y divide-gray-200">
                    {(showAllAbsences ? groupedAbsences : groupedAbsences.slice(0, 5)).map((g) => {
                      const base = 'px-3 py-2 flex items-center justify-between';
                      const color = g.streak >= 3 ? 'bg-orange-200' : 'bg-orange-100';
                      return (
                        <li key={g.key} className={`${base} ${color} rounded`}>
                          <span className="font-medium text-gray-900">{g.name}</span>
                          <span className="text-sm text-gray-700">Missed {g.streak} {g.streak === 1 ? 'service' : 'services'} in a row</span>
                        </li>
                      );
                    })}
                  </ul>
                   {groupedAbsences.length > 5 && (
                    <div className="mt-3 text-right">
                      <button
                        type="button"
                        onClick={() => setShowAllAbsences((v) => !v)}
                        className="text-sm font-medium text-primary-600 hover:text-primary-700"
                      >
                         {showAllAbsences ? 'Show less' : `Show all (${groupedAbsences.length})`}
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
      )}

      {/* Commented out Spreadsheet Instructions Modal for now - CSV export is sufficient */}
    </div>
  );
};

export default ReportsPage; 