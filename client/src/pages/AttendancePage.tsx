import React, { useState, useEffect, useMemo, useCallback, useRef, useDeferredValue, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { format, addWeeks, startOfWeek, addDays, isBefore, startOfDay, parseISO } from 'date-fns';
import { useAuth } from '../contexts/AuthContext';
import { gatheringsAPI, attendanceAPI, authAPI, familiesAPI, individualsAPI, visitorConfigAPI, GatheringType, Individual, Visitor } from '../services/api';
import AttendanceDatePicker from '../components/AttendanceDatePicker';
import { useToast } from '../components/ToastContainer';
import ActiveUsersIndicator from '../components/ActiveUsersIndicator';
import { generateFamilyName } from '../utils/familyNameUtils';
import { validatePerson, validateMultiplePeople } from '../utils/validationUtils';
import { getWebSocketMode } from '../utils/constants';
import { useWebSocket } from '../contexts/WebSocketContext';
import { userPreferences, PREFERENCE_KEYS } from '../services/userPreferences';
import HeadcountAttendanceInterface from '../components/HeadcountAttendanceInterface';
import logger from '../utils/logger';
import { useBadgeSettings } from '../hooks/useBadgeSettings';
import { 
  CalendarIcon, 
  PlusIcon, 
  UserGroupIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  StarIcon,
  XMarkIcon,
  PencilIcon,
  EllipsisHorizontalIcon,
  ChevronUpIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline';
import { Bars3Icon } from '@heroicons/react/24/outline';
import BadgeIcon, { BadgeIconType } from '../components/icons/BadgeIcon';

interface PersonForm {
  firstName: string;
  lastName: string;
  fillLastNameFromAbove: boolean;
  isChild?: boolean;
}

interface VisitorFormState {
  personType: 'local_visitor' | 'traveller_visitor';
  notes: string;
  persons: PersonForm[];
  autoFillSurname: boolean;
  familyName: string;
}

const AttendancePage: React.FC = () => {
  const { user, updateUser, refreshUserData } = useAuth();
  const { showSuccess, showToast } = useToast();
  const navigate = useNavigate();
  const { getBadgeInfo, isLoading: badgeSettingsLoading } = useBadgeSettings();
  // Initialize selectedDate to today - will be updated by gathering selection logic
  const [selectedDate, setSelectedDate] = useState(() => {
    logger.log('📅 Initializing selectedDate to today:', format(new Date(), 'yyyy-MM-dd'));
    return format(new Date(), 'yyyy-MM-dd');
  });
  const [selectedGathering, setSelectedGathering] = useState<GatheringType | null>(null);
  const [gatherings, setGatherings] = useState<GatheringType[]>([]);
  const [isLoadingGatherings, setIsLoadingGatherings] = useState(true);
  const [attendanceList, setAttendanceList] = useState<Individual[]>([]);
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [headcountValue, setHeadcountValue] = useState<number>(0);
  const [headcountFullscreen, setHeadcountFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [isPending, startTransition] = useTransition();
  // Refs to avoid stale closures and reduce heavy deps in effects
  const attendanceListRef = useRef<Individual[]>([]);
  const visitorsRef = useRef<Visitor[]>([]);
  const lastUserModificationRef = useRef<{ [key: number]: number }>({});
  // Maps to minimize re-render scope for attendance toggles
  const [presentById, setPresentById] = useState<Record<number, boolean>>({});
  const [savingById, setSavingById] = useState<Record<number, boolean>>({});
  const presentByIdRef = useRef<Record<number, boolean>>({});
  
  // Offline storage for pending attendance changes - declared early to avoid initialization order issues
  const [pendingChanges, setPendingChanges] = useState<Array<{
    individualId: number;
    present: boolean;
    timestamp: number;
    gatheringId: number;
    date: string;
  }>>([]);
  
  const [isSyncing, setIsSyncing] = useState(false);
  
  // Trigger for refreshing regular attendance data (similar to how visitors work)
  const [attendanceRefreshTrigger, setAttendanceRefreshTrigger] = useState(0);

  // Time sync for conflict detection
  const [serverTimeOffset, setServerTimeOffset] = useState(0); // Difference between server and client time
  const [attendanceTimestamps, setAttendanceTimestamps] = useState<Record<number, number>>({}); // Track when each record was changed

  // Helper functions for localStorage (legacy support)
  const saveLastViewed = async (gatheringId: number, date: string) => {
    const lastViewed = {
      gatheringId,
      date,
      timestamp: Date.now()
    };
    
    // Save to localStorage for immediate access
    localStorage.setItem('attendance_last_viewed', JSON.stringify(lastViewed));
    
    // Also save to user preferences system (both general and gathering-specific)
    try {
      await userPreferences.setAttendanceLastViewed(gatheringId, date);
      await userPreferences.setAttendanceGatheringDate(gatheringId, date);
    } catch (e) {
      logger.warn('Failed to save last viewed to user preferences:', e);
    }
  };

  // Keep refs in sync for WebSocket handler
  useEffect(() => {
    presentByIdRef.current = presentById;
  }, [presentById]);

  // Helper function to sync presentById with attendanceList (similar to visitor system)
  // This ensures consistent state management between regular attenders and visitors
  const syncPresentByIdWithAttendanceList = useCallback((attendanceData: any[]) => {
    if (!attendanceData || attendanceData.length === 0) return {};
    
    const newPresentById: Record<number, boolean> = {};
    attendanceData.forEach((person: any) => {
      if (person.id) {
        newPresentById[person.id] = Boolean(person.present);
      }
    });
    return newPresentById;
  }, []);

  // REMOVED: This useEffect was causing the first-load issue by overwriting server data
  // with potentially stale attendanceList data. Regular attenders now work like visitors
  // with direct server data initialization in loadAttendanceData().
  // 
  // The visitor system works correctly because it doesn't have this conflicting useEffect.
  // We should rely on direct server data initialization for both types.

  // Critical: Clear presentById when date or gathering changes to prevent cross-date contamination
  const prevDateRef = useRef<string | null>(null);
  const prevGatheringRef = useRef<number | null>(null);
  
  useEffect(() => {
    // Only clear if we're actually switching to a different date/gathering
    const dateChanged = prevDateRef.current !== null && prevDateRef.current !== selectedDate;
    const gatheringChanged = prevGatheringRef.current !== null && prevGatheringRef.current !== selectedGathering?.id;
    
    if (dateChanged || gatheringChanged) {
      logger.log('🧹 Date/gathering switched, clearing presentById state:', {
        from: { date: prevDateRef.current, gathering: prevGatheringRef.current },
        to: { date: selectedDate, gathering: selectedGathering?.id }
      });
      
      // Clear presentById when switching to a different date/gathering
      setPresentById({});
      presentByIdRef.current = {};
      
      // Also clear visitor attendance for consistency
      setVisitorAttendance({});
    }
    
    // Update refs for next comparison
    prevDateRef.current = selectedDate;
    prevGatheringRef.current = selectedGathering?.id || null;
  }, [selectedDate, selectedGathering?.id]); // Removed presentById - only react to date/gathering changes

  // Load cached data immediately on component mount for better UX during navigation
  useEffect(() => {
    // Check for cached data on mount
    
    const cachedData = localStorage.getItem('attendance_cached_data');
    
    if (!cachedData) {
      logger.log('❌ No cached attendance data found in localStorage');
      return;
    }
    
    try {
      const parsed = JSON.parse(cachedData);
      const cacheAge = Date.now() - (parsed.timestamp || 0);
      const isStale = cacheAge > 120000; // 2 minutes - more conservative for PWA reliability
      
      // Found cached data
      
      // Note: Cached attendance data is now loaded by dedicated effects
      if (isStale) {
        // Cache is stale, will load fresh data
      } else if (!parsed.attendanceList?.length) {
        // Cache exists but no attendance data
      }
    } catch (err) {
      console.error('❌ Failed to parse cached attendance data on mount:', err);
    }
  }, []); // Run only once on mount
  
  const getLastViewed = async () => {
    try {
      // First try the new user preferences system
      const lastViewed = await userPreferences.getAttendanceLastViewed();
      if (lastViewed) {
        // Only use if less than 24 hours old
        if (Date.now() - lastViewed.timestamp < 24 * 60 * 60 * 1000) {
          return { gatheringId: lastViewed.gatheringId, date: lastViewed.date };
        }
      }
      
      // Fallback to localStorage for backward compatibility
      const saved = localStorage.getItem('attendance_last_viewed');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Only use if less than 24 hours old
        if (Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
          return { gatheringId: parsed.gatheringId, date: parsed.date };
        }
      }
    } catch (e) {
      logger.warn('Failed to parse last viewed data:', e);
    }
    return null;
  };
  
  // Helper function to get date status
  const getDateStatus = (date: string) => {
    const today = format(new Date(), 'yyyy-MM-dd');
    const selectedDateTime = new Date(date).getTime();
    const todayTime = new Date(today).getTime();
    
    if (selectedDateTime < todayTime) {
      const daysDiff = Math.floor((todayTime - selectedDateTime) / (1000 * 60 * 60 * 24));
      return { type: 'past', daysDiff };
    } else if (selectedDateTime > todayTime) {
      const daysDiff = Math.floor((selectedDateTime - todayTime) / (1000 * 60 * 60 * 24));
      return { type: 'future', daysDiff };
    } else {
      return { type: 'today', daysDiff: 0 };
    }
  };

  // Lock edits for attendance takers if selected date is 14+ days in the past
  const isAttendanceLocked = useMemo(() => {
    if (user?.role !== 'attendance_taker' || !selectedDate) return false;
    const status = getDateStatus(selectedDate);
    return status.type === 'past' && status.daysDiff >= 14;
  }, [user?.role, selectedDate]);


  const handleGroupByFamilyChange = useCallback((checked: boolean) => {
    setGroupByFamily(checked);
    // Save the setting for this gathering with improved localStorage handling
    if (!selectedGathering) return; // Guard for no selectedGathering
    
    try {
      localStorage.setItem(`gathering_${selectedGathering.id}_groupByFamily`, JSON.stringify(checked));
    } catch (error) {
      logger.warn('Failed to save groupByFamily setting to localStorage:', error);
    }
  }, [selectedGathering]);

  // Helper function to find the nearest date (closest to today)
  const findNearestDate = useCallback((dates: string[]) => {
    if (dates.length === 0) return null;
    
    const today = format(new Date(), 'yyyy-MM-dd');
    const todayTime = new Date(today).getTime();
    
    let nearestDate = dates[0];
    let minDiff = Math.abs(new Date(nearestDate).getTime() - todayTime);
    
    for (const date of dates) {
      const dateTime = new Date(date).getTime();
      const diff = Math.abs(dateTime - todayTime);
      
      if (diff < minDiff) {
        minDiff = diff;
        nearestDate = date;
      }
    }
    
    return nearestDate;
  }, []);

  const [groupByFamily, setGroupByFamily] = useState(true);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const datePickerRef = useRef<HTMLDivElement>(null);
  const [showAddVisitorModal, setShowAddVisitorModal] = useState(false);
  const [isEditingVisitor, setIsEditingVisitor] = useState(false);
  const [editingVisitorData, setEditingVisitorData] = useState<{
    visitorId: number;
    familyId: number;
    familyName: string;
    selectedMemberIndex?: number;
  } | null>(null);
  const [lastUserModification, setLastUserModification] = useState<{ [key: number]: number }>({});
  
  // Tab slider drag state
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [showRightFade, setShowRightFade] = useState(true);
  const [showDesktopRightFade, setShowDesktopRightFade] = useState(true);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showDesktopLeftFade, setShowDesktopLeftFade] = useState(false);
  const tabSliderRef = useRef<HTMLDivElement>(null);
  const desktopTabSliderRef = useRef<HTMLDivElement>(null);
  
  // Performance optimization refs
  const animationFrameRef = useRef<number | null>(null);
  const lastTouchTimeRef = useRef<number>(0);
  const touchThrottleDelay = 16; // ~60fps

  const [visitorAttendance, setVisitorAttendance] = useState<{ [key: number]: boolean }>({});
  const [isSubmittingVisitor, setIsSubmittingVisitor] = useState(false);
  const [activeStatBubble, setActiveStatBubble] = useState<string | null>(null);
  
  // Smart truncation function for gathering names
  const getSmartTruncatedName = useCallback((name: string, allNames: string[], maxLength: number = 17) => {
    if (name.length <= maxLength) return name;
    
    // Find other names that start similarly
    const similarNames = allNames.filter(n => n !== name && n.toLowerCase().startsWith(name.toLowerCase().substring(0, Math.min(10, name.length))));
    
    if (similarNames.length === 0) {
      // No similar names, use simple truncation
      return `${name.substring(0, maxLength - 3)}...`;
    }
    
    // Find the shortest common prefix
    let commonPrefix = '';
    const shortestSimilar = similarNames.reduce((shortest, current) => 
      current.length < shortest.length ? current : shortest
    );
    
    for (let i = 0; i < Math.min(name.length, shortestSimilar.length); i++) {
      if (name[i].toLowerCase() === shortestSimilar[i].toLowerCase()) {
        commonPrefix += name[i];
      } else {
        break;
      }
    }
    
    // If common prefix is long, show the end part instead
    if (commonPrefix.length > 8) {
      const endPart = name.substring(name.length - (maxLength - 3));
      return `...${endPart}`;
    }
    
    // Otherwise, show the beginning with ellipsis
    return `${name.substring(0, maxLength - 3)}...`;
  }, []);
  
  // WebSocket integration with environment-based configuration
  // Use global WebSocket context for attendance updates
  const {
    socket,
    isConnected: isWebSocketConnected,
    connectionStatus,
    isOfflineMode,
    sendAttendanceUpdate,
    sendHeadcountUpdate,
    loadAttendanceData: loadAttendanceDataWebSocket,
    onAttendanceUpdate,
    onVisitorUpdate,
    onReconnect
  } = useWebSocket();
  const webSocketMode = useMemo(() => getWebSocketMode(), []);
  const useWebSocketForUpdates = webSocketMode.enabled;

  // Connection debugging disabled to reduce console noise

  // Helper function to get connection status styling
  const getConnectionStatusStyle = () => {
    // If WebSocket is disabled via environment variable, show API mode
    if (!webSocketMode.enabled) {
      return {
        containerClass: 'bg-blue-100 text-blue-800 border border-blue-200',
        dotClass: 'bg-blue-500',
        label: 'API Mode',
        tooltip: 'Using REST API for updates (WebSocket disabled)'
      };
    }

    switch (connectionStatus) {
      case 'connected':
        return {
          containerClass: 'bg-green-100 text-green-800 border border-green-200',
          dotClass: 'bg-green-500',
          label: pendingChanges.length > 0 
            ? isSyncing 
              ? `Syncing ${pendingChanges.length}...`
              : `${pendingChanges.length} Pending`
            : 'Connected',
          tooltip: pendingChanges.length > 0 
            ? `Connected - Syncing ${pendingChanges.length} offline changes...`
            : 'Connected - Real-time updates active'
        };
      case 'connecting':
        return {
          containerClass: 'bg-green-50 text-green-600 border border-green-200 connection-pulse',
          dotClass: 'bg-green-400',
          label: 'Connecting...',
          tooltip: 'Connecting to real-time updates...'
        };
      case 'error':
        return {
          containerClass: 'bg-red-100 text-red-800 border border-red-200',
          dotClass: 'bg-red-500',
          label: webSocketMode.fallbackAllowed ? 'Using API Fallback' : 'Connection Error',
          tooltip: webSocketMode.fallbackAllowed 
            ? 'WebSocket connection failed - Using REST API for updates'
            : 'Connection failed - Please refresh the page'
        };
      case 'offline':
        return {
          containerClass: 'bg-yellow-100 text-yellow-800 border border-yellow-200',
          dotClass: 'bg-yellow-500',
          label: pendingChanges.length > 0 
            ? `${pendingChanges.length} Pending` 
            : 'Offline Mode',
          tooltip: pendingChanges.length > 0
            ? `Offline - ${pendingChanges.length} changes saved locally`
            : 'Offline mode - Using cached data'
        };
      case 'disconnected':
      default:
        const hasApiFailback = webSocketMode.fallbackAllowed;
        const label = pendingChanges.length > 0 
          ? `${pendingChanges.length} Pending` 
          : hasApiFailback 
            ? 'API Mode' 
            : 'Offline';
        const tooltip = pendingChanges.length > 0
          ? `Disconnected - ${pendingChanges.length} changes saved locally`
          : hasApiFailback
            ? 'WebSocket disconnected - Using REST API for updates'
            : 'Offline - Changes will be saved locally';
            
        return {
          containerClass: hasApiFailback 
            ? 'bg-yellow-100 text-yellow-800 border border-yellow-200'
            : 'bg-red-100 text-red-800 border border-red-200',
          dotClass: hasApiFailback ? 'bg-yellow-500' : 'bg-red-500',
          label,
          tooltip
        };
    }
  };


  // Add state for recent visitors
  const [recentVisitors, setRecentVisitors] = useState<Visitor[]>([]);
  const [showRecentVisitors, setShowRecentVisitors] = useState(false);
  const [allVisitors, setAllVisitors] = useState<Visitor[]>([]);
  // Keep a raw pool of recent visitors (without 6-week filter) for search visibility
  const [allRecentVisitorsPool, setAllRecentVisitorsPool] = useState<Visitor[]>([]);
  // Church-wide, all-time people including visitors and regular members (for "Add People From Church" section)
  const [allChurchVisitors, setAllChurchVisitors] = useState<Visitor[]>([]);
  const [isLoadingAllVisitors, setIsLoadingAllVisitors] = useState(false);
  const [showAllVisitorsSection, setShowAllVisitorsSection] = useState(false);

  // Keep refs in sync
  useEffect(() => { attendanceListRef.current = attendanceList; }, [attendanceList]);
  useEffect(() => { visitorsRef.current = visitors; }, [visitors]);
  useEffect(() => { lastUserModificationRef.current = lastUserModification; }, [lastUserModification]);

  const [visitorForm, setVisitorForm] = useState<VisitorFormState>({
    personType: 'local_visitor',
    notes: '',
    persons: [{
      firstName: '',
      lastName: '',
      fillLastNameFromAbove: false,
      isChild: false
    }],
    autoFillSurname: false,
    familyName: ''
  });

  // Handle click outside to close date picker and gathering dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (datePickerRef.current && !datePickerRef.current.contains(event.target as Node)) {
        setShowDatePicker(false);
      }
    };

    if (showDatePicker) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDatePicker]);

  // Dismiss stat breakdown bubble on outside click
  useEffect(() => {
    if (!activeStatBubble) return;
    const handler = () => setActiveStatBubble(null);
    // Use setTimeout so the current click doesn't immediately close it
    const id = setTimeout(() => document.addEventListener('click', handler), 0);
    return () => { clearTimeout(id); document.removeEventListener('click', handler); };
  }, [activeStatBubble]);


  // Tab slider drag handlers
  const handleMouseDown = (e: React.MouseEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    setIsDragging(true);
    setStartX(e.pageX - sliderRef.current.offsetLeft);
    setScrollLeft(sliderRef.current.scrollLeft);
    sliderRef.current.style.cursor = 'grabbing';
  };

  const handleMouseLeave = (sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    setIsDragging(false);
    sliderRef.current.style.cursor = 'grab';
  };

  const handleMouseUp = (sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    setIsDragging(false);
    sliderRef.current.style.cursor = 'grab';
  };

  const handleMouseMove = (e: React.MouseEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!isDragging || !sliderRef.current) return;
    e.preventDefault();
    const x = e.pageX - sliderRef.current.offsetLeft;
    const walk = (x - startX) * 2; // Scroll speed multiplier
    sliderRef.current.scrollLeft = scrollLeft - walk;
  };

  // Optimized touch handlers for mobile with better performance
  const handleTouchStart = (e: React.TouchEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    
    // Cancel any pending animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    setIsDragging(true);
    setStartX(e.touches[0].pageX - sliderRef.current.offsetLeft);
    setScrollLeft(sliderRef.current.scrollLeft);
    lastTouchTimeRef.current = Date.now();
  };

  const handleTouchMove = (e: React.TouchEvent, sliderRef: React.RefObject<HTMLDivElement>) => {
    if (!isDragging || !sliderRef.current) return;
    
    // Throttle touch events for better performance
    const now = Date.now();
    if (now - lastTouchTimeRef.current < touchThrottleDelay) {
      return;
    }
    lastTouchTimeRef.current = now;
    
    e.preventDefault();
    
    // Use requestAnimationFrame for smooth scrolling
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    
    animationFrameRef.current = requestAnimationFrame(() => {
      if (!sliderRef.current) return;
      const x = e.touches[0].pageX - sliderRef.current.offsetLeft;
      const walk = (x - startX) * 2;
      sliderRef.current.scrollLeft = scrollLeft - walk;
    });
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    
    // Clean up animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  // Cleanup animation frames on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Check scroll position and update fade indicators
  const checkScrollPosition = (sliderRef: React.RefObject<HTMLDivElement>, isMobile: boolean) => {
    if (!sliderRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = sliderRef.current;
    const isAtEnd = scrollLeft + clientWidth >= scrollWidth - 5; // 5px tolerance
    const isAtStart = scrollLeft <= 5; // 5px tolerance
    
    if (isMobile) {
      setShowRightFade(!isAtEnd);
      setShowLeftFade(!isAtStart);
    } else {
      setShowDesktopRightFade(!isAtEnd);
      setShowDesktopLeftFade(!isAtStart);
    }
  };

  // Compute valid dates for any gathering (pure function, no state dependency)
  const computeValidDatesForGathering = useCallback((gathering: GatheringType): string[] => {
    if (!gathering) return [];

    if (gathering.attendanceType === 'headcount' && gathering.customSchedule) {
      const customSchedule = gathering.customSchedule;
      const dates: string[] = [];

      if (customSchedule.type === 'one_off') {
        dates.push(customSchedule.startDate);
      } else if (customSchedule.type === 'recurring' && customSchedule.pattern) {
        const pattern = customSchedule.pattern;
        const scheduleStart = parseISO(customSchedule.startDate);
        const scheduleEnd = customSchedule.endDate ? parseISO(customSchedule.endDate) : addWeeks(new Date(), 4);
        
        if (pattern.frequency === 'daily') {
          if (pattern.customDates && pattern.customDates.length > 0) {
            dates.push(...pattern.customDates);
          } else {
            let currentDate = scheduleStart;
            while (isBefore(currentDate, scheduleEnd)) {
              dates.push(format(currentDate, 'yyyy-MM-dd'));
              currentDate = addDays(currentDate, pattern.interval || 1);
            }
          }
        } else if (pattern.frequency === 'weekly') {
          const dayMap: { [key: string]: number } = {
            'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
            'Thursday': 4, 'Friday': 5, 'Saturday': 6
          };
          
          if (pattern.daysOfWeek && pattern.daysOfWeek.length > 0) {
            const targetDays = pattern.daysOfWeek.map(day => dayMap[day]).filter(day => day !== undefined);
            let currentDate = scheduleStart;
            while (isBefore(currentDate, scheduleEnd)) {
              const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
              for (const targetDay of targetDays) {
                const eventDate = addDays(weekStart, targetDay);
                if (isBefore(eventDate, scheduleEnd) && !isBefore(eventDate, scheduleStart)) {
                  dates.push(format(eventDate, 'yyyy-MM-dd'));
                }
              }
              currentDate = addWeeks(currentDate, pattern.interval || 1);
            }
          }
        } else if (pattern.frequency === 'biweekly') {
          const dayMap: { [key: string]: number } = {
            'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
            'Thursday': 4, 'Friday': 5, 'Saturday': 6
          };
          
          if (pattern.daysOfWeek && pattern.daysOfWeek.length > 0) {
            const targetDays = pattern.daysOfWeek.map(day => dayMap[day]).filter(day => day !== undefined);
            let currentDate = scheduleStart;
            let weekCount = 0;
            while (isBefore(currentDate, scheduleEnd)) {
              if (weekCount % 2 === 0) {
                const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
                for (const targetDay of targetDays) {
                  const eventDate = addDays(weekStart, targetDay);
                  if (isBefore(eventDate, scheduleEnd) && !isBefore(eventDate, scheduleStart)) {
                    dates.push(format(eventDate, 'yyyy-MM-dd'));
                  }
                }
              }
              currentDate = addWeeks(currentDate, 1);
              weekCount++;
            }
          }
        } else if (pattern.frequency === 'monthly') {
          if (pattern.dayOfMonth) {
            let currentDate = scheduleStart;
            while (isBefore(currentDate, scheduleEnd)) {
              const eventDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), pattern.dayOfMonth);
              if (isBefore(eventDate, scheduleEnd) && !isBefore(eventDate, scheduleStart)) {
                dates.push(format(eventDate, 'yyyy-MM-dd'));
              }
              currentDate = addWeeks(currentDate, 4);
            }
          }
        }
      }

      return dates.sort((a, b) => b.localeCompare(a));
    }

    const dayMap: { [key: string]: number } = {
      'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
      'Thursday': 4, 'Friday': 5, 'Saturday': 6
    };

    const targetDay = dayMap[gathering.dayOfWeek];
    if (targetDay === undefined || gathering.dayOfWeek === null) return [];

    const dates: string[] = [];
    const today = startOfDay(new Date());
    const rangeStart = addWeeks(today, -26);
    const rangeEnd = addWeeks(today, 4);

    let currentDate = startOfWeek(rangeStart, { weekStartsOn: 0 });
    currentDate = addDays(currentDate, targetDay);

    while (isBefore(currentDate, rangeEnd)) {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      
      let shouldInclude = true;
      if (gathering.frequency === 'biweekly') {
        const weekDiff = Math.floor((currentDate.getTime() - rangeStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
        shouldInclude = weekDiff % 2 === 0;
      } else if (gathering.frequency === 'monthly') {
        const firstOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
        let firstTargetDay = addDays(startOfWeek(firstOfMonth, { weekStartsOn: 0 }), targetDay);
        if (firstTargetDay.getMonth() !== currentDate.getMonth()) {
          firstTargetDay = addWeeks(firstTargetDay, 1);
        }
        shouldInclude = format(currentDate, 'yyyy-MM-dd') === format(firstTargetDay, 'yyyy-MM-dd');
      }

      if (shouldInclude) {
        dates.push(dateStr);
      }
      
      currentDate = addWeeks(currentDate, 1);
    }

    return dates.sort((a, b) => b.localeCompare(a));
  }, []);

  // validDates memo uses the extracted function
  const validDates = useMemo(() => {
    if (!selectedGathering) return [];
    return computeValidDatesForGathering(selectedGathering);
  }, [selectedGathering, computeValidDatesForGathering]);

  // Navigation functions for gathering dates
  const navigateToNextDate = useCallback(() => {
    if (!selectedDate || validDates.length === 0) return;
    
    const currentIndex = validDates.indexOf(selectedDate);
    if (currentIndex > 0) {
      const nextDate = validDates[currentIndex - 1]; // Next date is at lower index (newer dates first)
      logger.log('📅 Navigating to next date:', nextDate);
      setSelectedDate(nextDate);
    }
  }, [selectedDate, validDates]);

  const navigateToPreviousDate = useCallback(() => {
    if (!selectedDate || validDates.length === 0) return;
    
    const currentIndex = validDates.indexOf(selectedDate);
    if (currentIndex < validDates.length - 1) {
      const prevDate = validDates[currentIndex + 1]; // Previous date is at higher index (older dates first)
      logger.log('📅 Navigating to previous date:', prevDate);
      setSelectedDate(prevDate);
    }
  }, [selectedDate, validDates]);

  // Check if navigation buttons should be enabled
  const canNavigateNext = useMemo(() => {
    if (!selectedDate || validDates.length === 0) return false;
    const currentIndex = validDates.indexOf(selectedDate);
    return currentIndex > 0; // Can go to next (newer) date if not at the newest
  }, [selectedDate, validDates]);

  const canNavigatePrevious = useMemo(() => {
    if (!selectedDate || validDates.length === 0) return false;
    const currentIndex = validDates.indexOf(selectedDate);
    return currentIndex < validDates.length - 1; // Can go to previous (older) date if not at the oldest
  }, [selectedDate, validDates]);

  // Refresh user data on component mount to get latest gathering assignments
  // Manual refresh function for gatherings
  const refreshGatherings = useCallback(async () => {
    if (!user) return;
    
    try {
      const response = await gatheringsAPI.getAll();
      // All users (including admins) only see their assigned gatherings
      // Admins can assign themselves to any gathering they want to see
      const userGatherings = response.data.gatherings.filter((g: GatheringType) => 
        user?.gatheringAssignments?.some((assignment: GatheringType) => assignment.id === g.id)
      );
      setGatherings(userGatherings);
      
      // Cache the full gatherings data for offline use
      const cacheData = {
        gatherings: response.data.gatherings,
        timestamp: Date.now()
      };
      localStorage.setItem('gatherings_cached_data', JSON.stringify(cacheData));
      logger.log('💾 Cached gatherings data for offline use (refresh)');
    } catch (err) {
      logger.error('❌ Failed to refresh gatherings:', err);
      setError('Failed to refresh gatherings');
    }
  }, [user]);

  // Sync time with server for conflict detection
  const syncTimeWithServer = useCallback(async () => {
    try {
      const clientTime = Date.now();
      const response = await authAPI.getServerTime();
      const serverTime = response.data.serverTime;
      const offset = serverTime - clientTime;
      setServerTimeOffset(offset);
      logger.log('⏰ Time synced with server', { offset: offset + 'ms', serverTime, clientTime });
    } catch (error) {
      logger.warn('Failed to sync time with server:', error);
      setServerTimeOffset(0); // Fallback to no offset
    }
  }, []);

  useEffect(() => {
    const refreshUserDataOnMount = async () => {
      try {
        await refreshUserData();
      } catch (error) {
        logger.warn('Failed to refresh user data on mount:', error);
      }
    };

    refreshUserDataOnMount();
    syncTimeWithServer(); // Sync time on mount
  }, [syncTimeWithServer]); // Run only on mount

  // Auto-refresh gatherings when user data changes (including gathering assignments)
  useEffect(() => {
    if (user) {
      refreshGatherings();
    }
  }, [user?.gatheringAssignments, refreshGatherings]);

  // Load gatherings when user data is available (CACHE-FIRST approach)
  useEffect(() => {
    const loadGatherings = async () => {
      if (!user) return; // Wait for user data to be available
      setIsLoadingGatherings(true);

      // STEP 1: Try to load from cache immediately for instant UI
      let loadedFromCache = false;
      try {
        const cachedGatherings = localStorage.getItem('gatherings_cached_data');
        if (cachedGatherings) {
            const parsedCached = JSON.parse(cachedGatherings);
          const cacheAge = Date.now() - parsedCached.timestamp;
          const ageInHours = cacheAge / (1000 * 60 * 60);
          
          // Use cache if less than 7 days old
          if (ageInHours < 168) { // 7 days = 168 hours
              // Filter cached gatherings by user's assignments
              const userGatherings = parsedCached.gatherings.filter((g: GatheringType) => 
                user?.gatheringAssignments?.some((assignment: GatheringType) => assignment.id === g.id)
              );
              setGatherings(userGatherings);
            
            // IMPORTANT: Also select a gathering from cache to prevent "No valid dates" flash
            if (userGatherings.length > 0 && !selectedGathering) {
              // Try to use cached attendance data to select the right gathering
              try {
                const cachedAttendance = localStorage.getItem('attendance_cached_data');
                if (cachedAttendance) {
                  const parsed = JSON.parse(cachedAttendance);
                  const cachedGathering = userGatherings.find((g: GatheringType) => g.id === parsed.gatheringId);
                  if (cachedGathering) {
                    setSelectedGathering(cachedGathering);
                    logger.log('⚡ Selected gathering from cache:', cachedGathering.name);
                  } else {
                    // Fallback to first gathering
                    setSelectedGathering(userGatherings[0]);
                  }
                } else {
                  // No cached attendance, use first gathering
                  setSelectedGathering(userGatherings[0]);
            }
          } catch (e) {
                // On error, just use first gathering
                setSelectedGathering(userGatherings[0]);
              }
            }
            
            loadedFromCache = true;
            logger.log('⚡ Loaded gatherings from cache immediately');
            setIsLoadingGatherings(false); // Has data to show, hide loading
          }
        }
      } catch (e) {
        logger.warn('Failed to parse cached gatherings:', e);
      }

      // STEP 2: Fetch fresh data from server (always, even if cache loaded)
      try {
        const response = await gatheringsAPI.getAll();
        // All users (including admins) only see their assigned gatherings
        // Admins can assign themselves to any gathering they want to see
        const userGatherings = response.data.gatherings.filter((g: GatheringType) => 
          user?.gatheringAssignments?.some((assignment: GatheringType) => assignment.id === g.id)
        );
        setGatherings(userGatherings);
        
        // Cache the full gatherings data for offline use
        const cacheData = {
          gatherings: response.data.gatherings,
          timestamp: Date.now()
        };
        localStorage.setItem('gatherings_cached_data', JSON.stringify(cacheData));
        logger.log('💾 Cached gatherings data for offline use');
        
        // Set default gathering honoring saved order and default preference
        if (userGatherings.length > 0) {
          // Try to get last viewed from user preferences first, then fallback to localStorage
          let lastViewed = null;
          try {
            lastViewed = await userPreferences.getAttendanceLastViewed();
          } catch (e) {
            logger.warn('Failed to get last viewed from user preferences, falling back to localStorage:', e);
            lastViewed = getLastViewed();
          }
          
          let gatheringToSelect: GatheringType | null = null;

          // Try last viewed first
          if (lastViewed) {
            gatheringToSelect = userGatherings.find((g: GatheringType) => g.id === lastViewed.gatheringId) || null;
          }

          // Apply saved order
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
            logger.warn('Failed to load gathering order in loadGatherings:', e);
          }

          // Saved default id overrides if available
          if (!gatheringToSelect && user?.id) {
            const savedDefaultId = localStorage.getItem(`user_${user.id}_default_gathering_id`);
            if (savedDefaultId) {
              const idNum = parseInt(savedDefaultId, 10);
              gatheringToSelect = ordered.find((g: GatheringType) => g.id === idNum) || userGatherings.find((g: GatheringType) => g.id === idNum) || null;
            }
          }

          // Check if we have cached data that should influence our gathering/date selection
          const cachedData = localStorage.getItem('attendance_cached_data');
          let finalGatheringToSelect = gatheringToSelect || ordered[0] || userGatherings[0];
          
          // Final gathering selection complete
          
          if (cachedData && !gatheringToSelect) {
            try {
              const parsed = JSON.parse(cachedData);
              const cacheAge = Date.now() - (parsed.timestamp || 0);
              const isStale = cacheAge > 120000; // 2 minutes - more conservative for PWA reliability
              
              if (!isStale && parsed.gatheringId && parsed.attendanceList?.length > 0) {
                const cachedGathering = userGatherings.find((g: GatheringType) => g.id === parsed.gatheringId);
                if (cachedGathering) {
                  logger.log('🎯 Using gathering from cache for consistency:', {
                    gatheringId: parsed.gatheringId,
                    gatheringName: cachedGathering.name,
                    date: parsed.date
                  });
                  finalGatheringToSelect = cachedGathering;
                  // We'll set the date in the next effect when validDates is calculated
                }
              }
            } catch (err) {
              console.error('Failed to parse cached data for gathering selection:', err);
            }
          }
          
          setSelectedGathering(finalGatheringToSelect);
        }
        setIsLoadingGatherings(false);
        logger.log('✅ Fresh gatherings loaded from server and cached');
      } catch (err) {
        console.error('Failed to load fresh gatherings:', err);
        setIsLoadingGatherings(false);
        // If we already loaded from cache, just log the error
        if (loadedFromCache) {
          logger.warn('⚠️ Could not refresh gatherings from server, using cached data');
          // Don't set error - user already has working UI from cache
        } else {
        setError('Failed to load gatherings');
        }
      }
    };

    loadGatherings();
  }, [user, user?.gatheringAssignments, isOfflineMode]); // Re-run when user data, gathering assignments, or offline mode changes

  // Synchronously determine the best date for a gathering.
  // Uses localStorage (fast) to avoid the async race condition that caused stale data.
  const pickDateForGathering = useCallback((gathering: GatheringType, dates: string[]): string | null => {
    if (dates.length === 0) return null;

    // 1. Check localStorage cache for this gathering
    try {
      const cachedData = localStorage.getItem('attendance_cached_data');
      if (cachedData) {
        const parsed = JSON.parse(cachedData);
        const cacheAge = Date.now() - (parsed.timestamp || 0);
        if (cacheAge < 24 * 60 * 60 * 1000 && parsed.gatheringId === gathering.id && dates.includes(parsed.date)) {
          return parsed.date;
        }
      }
    } catch { /* ignore */ }

    // 2. Check per-gathering last-viewed date from localStorage
    try {
      const stored = localStorage.getItem(`preference_${PREFERENCE_KEYS.ATTENDANCE_GATHERING_DATES}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        const lastDate = parsed?.[gathering.id];
        if (lastDate && dates.includes(lastDate)) {
          return lastDate;
        }
      }
    } catch { /* ignore */ }

    // 3. Fall back to nearest date to today
    return findNearestDate(dates);
  }, [findNearestDate]);

  // Set date when validDates change (initial mount, or if gathering schedule is updated externally).
  // Gathering switches are handled synchronously in handleGatheringChange, so this effect
  // only acts as a safety net: if the current selectedDate isn't in validDates, pick a new one.
  useEffect(() => {
    if (!selectedGathering || validDates.length === 0) return;
    if (validDates.includes(selectedDate)) return; // already valid, nothing to do

    const date = pickDateForGathering(selectedGathering, validDates);
    if (date) {
      setSelectedDate(date);
    }
  }, [validDates, selectedGathering, selectedDate, pickDateForGathering]);

  // Handle gathering changes: compute date synchronously, then set both states in one batch
  const handleGatheringChange = useCallback((gathering: GatheringType) => {
    logger.log(`🏛️ Switching to gathering: ${gathering.name} (ID: ${gathering.id})`);
    
    lastUserModificationRef.current = {};
    
    // Compute the correct date BEFORE setting state so both update in one React batch
    const dates = computeValidDatesForGathering(gathering);
    const date = pickDateForGathering(gathering, dates);

    // React 18 batches these — one render with both correct values, no stale-date race
    setSelectedGathering(gathering);
    if (date) {
      setSelectedDate(date);
    }
    setHeadcountValue(0);
    setIsLoading(true);
  }, [computeValidDatesForGathering, pickDateForGathering]);

  // Load attendance data when date or gathering changes
  // Sync gathering-specific UI settings when gathering or date changes
  useEffect(() => {
    if (!selectedGathering || !selectedDate) return;
    if (validDates.length > 0 && !validDates.includes(selectedDate)) return;

    // Load the last used group by family setting for this gathering
    const lastSetting = localStorage.getItem(`gathering_${selectedGathering.id}_groupByFamily`);
    if (lastSetting !== null) {
      setGroupByFamily(lastSetting === 'true');
    } else {
      setGroupByFamily(true);
    }
  }, [selectedGathering, selectedDate, validDates]);

  // WebSocket real-time updates handle all data synchronization now
  // No need for visibility-based refreshes that cause issues on mobile PWA

  // Load recent visitors when gathering changes
  // REMOVED: This is now loaded by the combined /full endpoint
  // useEffect(() => {
  //   const loadRecentVisitors = async () => {
  //     if (!selectedGathering) return;
  //
  //     try {
  //       const response = await attendanceAPI.getRecentVisitors(selectedGathering.id);
  //       setRecentVisitors(response.data.visitors || []);
  //       setAllRecentVisitorsPool(response.data.visitors || []);
  //     } catch (err) {
  //       console.error('Failed to load recent visitors:', err);
  //     }
  //   };
  //
  //   loadRecentVisitors();
  // }, [selectedGathering]);

  // REMOVED: This is now loaded by the combined /full endpoint
  // useEffect(() => {
  //   const loadAllChurchPeople = async () => {
  //     try {
  //       setIsLoadingAllVisitors(true);
  //       const response = await attendanceAPI.getAllPeople();
  //       setAllChurchVisitors(response.data.visitors || []); // Keep using same state var for compatibility
  //     } catch (err) {
  //       console.error('Failed to load all church people:', err);
  //     } finally {
  //       setIsLoadingAllVisitors(false);
  //     }
  //   };
  //   loadAllChurchPeople();
  // }, []);

  // REMOVED: This is now loaded by the combined /full endpoint
  // The /full endpoint provides visitors, recentVisitors, and allChurchPeople in one call

  // Load regular attendance data when gathering or date changes (CACHE-FIRST approach)
  useEffect(() => {
    // Track if this effect has been cancelled (user changed date/gathering before fetch completed)
    let isCancelled = false;
    
    // Capture current values to check against after async operations
    const currentGatheringId = selectedGathering?.id;
    const currentDate = selectedDate;
    
    const loadRegularAttendance = async () => {
      if (!selectedGathering || !selectedDate) {
        return;
      }
      
      // Don't load if we don't have valid dates yet (date selection still in progress)
      if (validDates.length === 0) {
        return;
      }
      
      // Don't load if the selected date is not in the valid dates (date selection still in progress)
      if (!validDates.includes(selectedDate)) {
        return;
      }
      
      // STEP 1: Load from cache immediately for instant UI (if available)
      let loadedFromCache = false;
      try {
        const cachedData = localStorage.getItem('attendance_cached_data');
        if (cachedData) {
          const parsed = JSON.parse(cachedData);
          const cacheAge = Date.now() - (parsed.timestamp || 0);
          const isRelevantCache = parsed.gatheringId === selectedGathering.id && parsed.date === selectedDate;
          
          if (isRelevantCache && cacheAge < 7 * 24 * 60 * 60 * 1000) { // Cache valid for 7 days
            logger.log('⚡ Loading from cache immediately for instant UI');
            setAttendanceList(parsed.attendanceList || []);
            setVisitors(parsed.visitors || []);
            
            // Initialize presentById from cached data
            const cachedPresentById = syncPresentByIdWithAttendanceList(parsed.attendanceList || []);
            setPresentById(cachedPresentById);
            presentByIdRef.current = cachedPresentById;
            
            loadedFromCache = true;
            setIsLoading(false); // UI is ready with cached data
            logger.log(`✅ Cache loaded (${cacheAge < 60000 ? 'fresh' : 'stale, will refresh'})`);
          }
        }
      } catch (cacheErr) {
        console.error('Failed to load from cache:', cacheErr);
      }
      
      // STEP 2: Fetch fresh data from server (always, even if cache loaded)
      try {
        // Only show loading spinner if we didn't load from cache
        if (!loadedFromCache) {
          setIsLoading(true);
        }

        // Try WebSocket first if connected, fall back to REST API
        let response;

        // If WebSocket is connecting (not yet connected), wait briefly before falling back to API
        if (!isWebSocketConnected && connectionStatus === 'connecting' && loadedFromCache) {
          logger.log('⏳ WebSocket connecting, waiting briefly (cache already shown)...');
          await new Promise(resolve => setTimeout(resolve, 1500)); // Wait 1.5s for connection
        }

        if (isWebSocketConnected) {
          try {
            response = await loadAttendanceDataWebSocket(selectedGathering.id, selectedDate);
            // WebSocket only returns attendanceList + gathering-assigned visitors.
            // Fetch supplementary data (recentVisitors, allChurchPeople) via REST
            // so the visitor list is consistent regardless of data path.
            try {
              const [recentRes, allPeopleRes] = await Promise.all([
                attendanceAPI.getRecentVisitors(selectedGathering.id),
                attendanceAPI.getAllPeople(),
              ]);
              response.recentVisitors = recentRes.data.visitors || [];
              response.allChurchPeople = allPeopleRes.data.visitors || [];
              setRecentVisitors(response.recentVisitors);
              setAllRecentVisitorsPool(response.recentVisitors);
              setAllChurchVisitors(response.allChurchPeople);
              setIsLoadingAllVisitors(false);
            } catch (supplementaryErr) {
              logger.warn('⚠️ Failed to fetch supplementary visitor data:', supplementaryErr);
            }
          } catch (wsError) {
            logger.warn(`⚠️ WebSocket failed, falling back to REST API:`, wsError);
            throw wsError; // Re-throw to trigger REST API fallback
          }
        } else {
          // OPTIMIZED: Use /full endpoint to get all data in one call
          const apiResponse = await attendanceAPI.getFull(selectedGathering.id, selectedDate);
          response = apiResponse.data;

          // Extract additional data from the combined response
          if (response.recentVisitors) {
            setRecentVisitors(response.recentVisitors);
            setAllRecentVisitorsPool(response.recentVisitors);
          }
          if (response.allChurchPeople) {
            setAllChurchVisitors(response.allChurchPeople);
            setIsLoadingAllVisitors(false);
          }
        }

        // CRITICAL: Check if this request is still relevant before updating state
        // This prevents race conditions when user changes date quickly
        if (isCancelled) {
          logger.log('🚫 Ignoring stale response - date/gathering changed during fetch');
          return;
        }
        
        // Update UI with fresh server data
        setAttendanceList(response.attendanceList || []);

        // Normalize visitors from any source (WebSocket or REST) to a consistent format
        const normalizeVisitor = (v: any) => {
          const isLocal = v.visitorType === 'potential_regular' ||
            v.people_type === 'local_visitor' ||
            v.familyType === 'local_visitor';
          return {
            ...v,
            name: v.name || `${v.firstName || ''} ${v.lastName || ''}`.trim() || 'Unknown',
            visitorType: v.visitorType || (isLocal ? 'potential_regular' : 'temporary_other'),
            visitorFamilyGroup: v.visitorFamilyGroup || (v.familyId ? String(v.familyId) : undefined),
          };
        };

        setVisitors((response.visitors || []).map(normalizeVisitor));

        // Initialize visitor state for BOTH WebSocket and REST API paths
        // This ensures the visitor section renders immediately regardless of data source
        if (response.visitors) {
          const currentVisitors = (response.visitors || []).map(normalizeVisitor);
          const recentVisitorsList = response.recentVisitors || [];
          const currentVisitorIds = new Set(currentVisitors.map((v: Visitor) => v.id));
          const combinedVisitors = [
            ...currentVisitors,
            ...recentVisitorsList.filter((v: Visitor) => !currentVisitorIds.has(v.id))
          ];

          setAllVisitors(combinedVisitors);

          // Initialize visitor attendance state
          const presentVisitorIds = new Set(currentVisitors.filter((cv: any) => cv.present).map((cv: any) => cv.id));
          const initialVisitorAttendance: { [key: number]: boolean } = {};
          combinedVisitors.forEach((visitor: Visitor) => {
            if (visitor.id) {
              initialVisitorAttendance[visitor.id] = presentVisitorIds.has(visitor.id);
            }
          });
          setVisitorAttendance(initialVisitorAttendance);
        }
        
        // Initialize presentById from server data directly
        const serverPresentById = syncPresentByIdWithAttendanceList(response.attendanceList || []);
        
        // Apply any pending offline changes for this exact gathering/date
        const currentPendingChanges = JSON.parse(localStorage.getItem('attendance_offline_changes') || '[]');
        currentPendingChanges.forEach((change: any) => {
          if (change.gatheringId === currentGatheringId && change.date === currentDate) {
            serverPresentById[change.individualId] = change.present;
          }
        });
        
        setPresentById(serverPresentById);
        presentByIdRef.current = serverPresentById;
        
        // Cache the fresh attendance data
        const attendanceListForCache = (response.attendanceList || []).map((person: any) => {
          const finalPresent = serverPresentById[person.id] ?? person.present;
          return { ...person, present: finalPresent };
        });
        
        const cacheData = {
          gatheringId: currentGatheringId,
          date: currentDate,
          attendanceList: attendanceListForCache,
          visitors: response.visitors || [],
          timestamp: Date.now(),
          hasPendingChanges: pendingChanges.some(change => 
            change.gatheringId === currentGatheringId && change.date === currentDate
          )
        };
        localStorage.setItem('attendance_cached_data', JSON.stringify(cacheData));
        
        logger.log('✅ Fresh data loaded from server and cached');
        setError('');
        
        // Only persist last-viewed after a successful load with a validated date
        saveLastViewed(currentGatheringId!, currentDate);
        
      } catch (err) {
        // Check if cancelled before handling error
        if (isCancelled) {
          logger.log('🚫 Ignoring error from stale request - date/gathering changed');
          return;
        }
        
        console.error('Failed to load fresh attendance data:', err);
        
        // If we already loaded from cache, just show a subtle error
        if (loadedFromCache) {
          logger.warn('⚠️ Could not refresh from server, using cached data');
          // Don't set error - user already has working UI from cache
        } else {
          // No cache and server failed - try one more time to load from cache
        try {
          const cachedData = localStorage.getItem('attendance_cached_data');
          if (cachedData) {
            const parsed = JSON.parse(cachedData);
            if (parsed.gatheringId === currentGatheringId && parsed.date === currentDate) {
                logger.log('📦 Loading attendance data from cache due to server error');
              setAttendanceList(parsed.attendanceList || []);
              setVisitors(parsed.visitors || []);
              
              // Initialize presentById from cached data
              const cachedPresentById = syncPresentByIdWithAttendanceList(parsed.attendanceList || []);
              setPresentById(cachedPresentById);
              presentByIdRef.current = cachedPresentById;
              
              setError('Using cached data - server unavailable');
              return; // Exit early since we have cached data
            }
          }
        } catch (cacheErr) {
          console.error('Failed to load from cache:', cacheErr);
        }
        
        setError('Failed to load attendance data');
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    loadRegularAttendance();
    
    // Cleanup function - cancel any in-flight requests when dependencies change
    return () => {
      isCancelled = true;
    };
  }, [selectedGathering, selectedDate, isWebSocketConnected, loadAttendanceDataWebSocket, attendanceRefreshTrigger, validDates]);

  // Refresh data when WebSocket reconnects (device woke up, network restored, etc.)
  useEffect(() => {
    return onReconnect(() => {
      setAttendanceRefreshTrigger(prev => prev + 1);
    });
  }, [onReconnect]);

  // Function to quickly add a recent visitor
  const quickAddRecentVisitor = async (recentVisitor: Visitor) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    if (!selectedGathering) return;
    
    try {
      // Parse the visitor name to extract people
      const nameParts = recentVisitor.name.trim().split(' & ');
      const people = nameParts.map(namePart => {
        const personParts = namePart.trim().split(' ');
        const firstName = personParts[0] || '';
        const lastName = personParts.slice(1).join(' ') || '';
        return {
          firstName: firstName || 'Unknown',
          lastName: lastName || 'Unknown',
          firstUnknown: false,
          lastUnknown: lastName === '',
          isChild: false
        };
      });

      // Add as visitor using the new system
      // First create the visitor family
      const familyName = generateFamilyName(convertToUtilityFormat(people)) || 'Visitor Family';
      const familyResponse = await familiesAPI.createVisitorFamily({
        familyName,
        peopleType: recentVisitor.visitorType === 'potential_regular' ? 'local_visitor' : 'traveller_visitor',
        notes: recentVisitor.notes,
        people
      });
      
      // Then add the family to the service
      const response = await attendanceAPI.addVisitorFamilyToService(
        selectedGathering.id, 
        selectedDate, 
        familyResponse.data.familyId
      );

      showSuccess(`Added ${recentVisitor.name} from recent visitors`);
      
      // Reload attendance data and related visitor data to ensure immediate visibility
      setAttendanceRefreshTrigger(prev => prev + 1);
      
      // Also refresh recent visitors and all church people to ensure newly added visitors appear immediately
      if (selectedGathering) {
        try {
          // Refresh recent visitors for this gathering
          const recentResponse = await attendanceAPI.getRecentVisitors(selectedGathering.id);
          setRecentVisitors(recentResponse.data.visitors || []);
          setAllRecentVisitorsPool(recentResponse.data.visitors || []);
          
          // Refresh all church people to include the newly added visitor
          const allPeopleResponse = await attendanceAPI.getAllPeople();
          setAllChurchVisitors(allPeopleResponse.data.visitors || []);
          
          logger.log('✅ Refreshed all visitor data after adding recent visitor');
        } catch (refreshErr) {
          logger.warn('⚠️ Failed to refresh some visitor data:', refreshErr);
          // Don't throw error since the main operation succeeded
        }
      }
    } catch (err: any) {
      console.error('Failed to add recent visitor:', err);
      setError(err.response?.data?.error || 'Failed to add recent visitor');
    }
  };

  // Simple queue to serialize attendance writes per individual and reduce API thrash
  const pendingWritesRef = useRef<Map<number, Promise<void>>>(new Map());

  // Helper function to send attendance updates based on configuration
  const sendAttendanceChange = async (
    gatheringId: number,
    date: string,
    records: Array<{ individualId: number; present: boolean }>
  ) => {
    logger.log('🔍 sendAttendanceChange called:', {
      webSocketModeEnabled: webSocketMode.enabled,
      webSocketMode,
      isWebSocketConnected,
      gatheringId,
      date,
      recordsCount: records.length
    });

    // Add timestamps to records for conflict detection
    const recordsWithTimestamps = records.map(record => ({
      ...record,
      clientTimestamp: attendanceTimestamps[record.individualId] || (Date.now() + serverTimeOffset)
    }));

    let response;

    if (!webSocketMode.enabled) {
      logger.log('📡 Using REST API (WebSocket disabled)');
      // WebSocket disabled - use API directly
      response = await attendanceAPI.record(gatheringId, date, {
        attendanceRecords: recordsWithTimestamps,
        visitors: []
      });
      return response.data;
    }

    // Check if WebSocket is available and connected
    const shouldUseWebSocket = isWebSocketConnected && connectionStatus === 'connected';

    if (!shouldUseWebSocket && webSocketMode.fallbackAllowed) {
      logger.log('📡 WebSocket not available, using REST API fallback');
      response = await attendanceAPI.record(gatheringId, date, {
        attendanceRecords: recordsWithTimestamps,
        visitors: []
      });
      return response.data;
    }

    // WebSocket enabled and connected - try WebSocket first
    try {
      const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
      logger.log(`🔌 [${isPWA ? 'PWA' : 'Browser'}] Attempting to send attendance via WebSocket:`, {
        gatheringId,
        date,
        recordsCount: records.length,
        isPWAMode: isPWA,
        connectionStatus
      });
      await sendAttendanceUpdate(gatheringId, date, recordsWithTimestamps);
      logger.log(`🔌 [${isPWA ? 'PWA' : 'Browser'}] Successfully sent attendance via WebSocket`);
      return null; // WebSocket doesn't return response data
    } catch (wsError) {
      if (webSocketMode.fallbackAllowed) {
        logger.warn(`⚠️ WebSocket failed, falling back to API:`, wsError);
        response = await attendanceAPI.record(gatheringId, date, {
          attendanceRecords: recordsWithTimestamps,
          visitors: []
        });
        logger.log(`✅ Successfully saved attendance via API fallback`);
        return response.data;
      } else {
        // Pure WebSocket mode - no fallback allowed
        console.error(`❌ WebSocket failed in pure mode:`, wsError);
        throw new Error('WebSocket connection failed. Please check your connection and try again.');
      }
    }
  };

  const toggleAttendance = async (individualId: number) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    
    // Prevent rapid double-clicks
    if (savingById[individualId]) {
      logger.log(`⚠️ Already saving attendance for ${individualId}, ignoring duplicate click`);
      return;
    }

    // Add additional debug logging to track duplicate calls
    logger.log(`🔄 Toggling attendance for individual ${individualId} at ${Date.now()}`);
    
    // Track recent toggle calls to prevent duplicates
    const recentToggles = (window as any)._recentToggles || new Map();
    const now = Date.now();
    const lastToggle = recentToggles.get(individualId) || 0;
    
    if (now - lastToggle < 500) { // Prevent toggles within 500ms
      logger.log(`⚠️ Duplicate toggle detected for ${individualId}, ignoring (${now - lastToggle}ms ago)`);
      console.trace('Duplicate toggle call stack:');
      return;
    }
    
    recentToggles.set(individualId, now);
    // Clean up old entries
    for (const [id, timestamp] of recentToggles.entries()) {
      if (now - timestamp > 2000) {
        recentToggles.delete(id);
      }
    }
    (window as any)._recentToggles = recentToggles;
    
    const person = attendanceListRef.current.find(p => p.id === individualId);
    logger.log(`🔄 Toggling attendance for ${person?.firstName} ${person?.lastName} (ID: ${individualId})`);
    
    setLastUserModification(prev => ({ ...prev, [individualId]: now }));
    // Track timestamp for conflict detection (adjusted for server time)
    const clientTimestamp = Date.now() + serverTimeOffset;
    setAttendanceTimestamps(prev => ({ ...prev, [individualId]: clientTimestamp }));
    // Compute new present using refs to avoid stale state reads
    const currentPresent = (presentByIdRef.current[individualId] ?? attendanceListRef.current.find(p => p.id === individualId)?.present) ?? false;
    const newPresent = !currentPresent;

    logger.log(`📊 Attendance change: ${currentPresent} → ${newPresent} for gathering ${selectedGathering?.id} on ${selectedDate}`);

    // Batch optimistic updates to prevent race conditions
    startTransition(() => {
      setSavingById(prev => ({ ...prev, [individualId]: true }));
      setPresentById(prev => ({ ...prev, [individualId]: newPresent }));
    });

    if (!selectedGathering || !selectedDate) {
      console.error('❌ Missing gathering or date context');
      setSavingById(prev => ({ ...prev, [individualId]: false }));
      return;
    }

    // Check if we're online or offline
    if (!isWebSocketConnected) {
      // Offline mode - save to local storage
      logger.log('📱 Offline mode - saving to local storage');
      saveToOfflineStorage({
        individualId,
        present: newPresent,
        gatheringId: selectedGathering.id,
        date: selectedDate
      });
      setSavingById(prev => ({ ...prev, [individualId]: false }));
      return;
    }

    // Online mode - send via configured method (WebSocket, API, or WebSocket with fallback)
    const run = async () => {
      try {
        logger.log(`💾 Saving attendance record:`, {
          gatheringId: selectedGathering.id,
          date: selectedDate,
          individualId,
          present: newPresent,
          personName: `${person?.firstName} ${person?.lastName}`
        });

        const response = await sendAttendanceChange(selectedGathering.id, selectedDate, [
          { individualId, present: newPresent }
        ]);

        // Check for conflicts and auto-refresh if needed
        if (response && response.hasConflicts && response.skippedRecords?.length > 0) {
          logger.log('⚠️ Conflicts detected, refreshing attendance data:', response.skippedRecords);
          // Trigger refresh to get latest data
          setAttendanceRefreshTrigger(prev => prev + 1);
          // Show notification to user
          setError(`Attendance updated by another user. Refreshing...`);
          setTimeout(() => setError(''), 3000); // Clear message after 3 seconds
        }

        setSavingById(prev => ({ ...prev, [individualId]: false }));
      } catch (err) {
        console.error(`❌ Failed to save attendance change for ${person?.firstName} ${person?.lastName}:`, err);
        setError(err instanceof Error ? err.message : 'Failed to save change');
        setSavingById(prev => ({ ...prev, [individualId]: false }));
        setPresentById(prev => ({ ...prev, [individualId]: currentPresent }));
      } finally {
        pendingWritesRef.current.delete(individualId);
      }
    };
    const current = pendingWritesRef.current.get(individualId);
    const p = current ? current.then(run) : run();
    pendingWritesRef.current.set(individualId, Promise.resolve(p));
  };

  const toggleAllFamily = async (familyId: number) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    logger.log('=== TOGGLE ALL FAMILY DEBUG ===');
    logger.log('Toggling all family attendance for family:', familyId);
    logger.log('Total attendance list length:', attendanceList.length);
    
    // Debug: Show all families in the attendance list
    const allFamilies = attendanceList.reduce((acc, person) => {
      if (person.familyId) {
        if (!acc[person.familyId]) {
          acc[person.familyId] = [];
        }
        acc[person.familyId].push(person);
      }
      return acc;
    }, {} as Record<number, Individual[]>);
    
    logger.log('All families in attendance list:', Object.keys(allFamilies).map(familyId => ({
      familyId: parseInt(familyId),
      memberCount: allFamilies[parseInt(familyId)].length,
      members: allFamilies[parseInt(familyId)].map(p => ({ id: p.id, name: `${p.firstName} ${p.lastName}`, present: p.present }))
    })));
    
    // Family operation flags removed - no longer needed without polling
    
    // Get family members from attendance list
    const familyMembers = attendanceList.filter(person => person.familyId === familyId);
    const familyMemberIds = familyMembers.map(person => person.id);
    
    logger.log('Family members found:', familyMembers.length);
    logger.log('Family member IDs:', familyMemberIds);
    logger.log('Family members details:', familyMembers.map(p => ({ id: p.id, name: `${p.firstName} ${p.lastName}`, familyId: p.familyId, present: p.present })));
    
    // Count how many family members are currently present using current state
    // Use presentById state first, fallback to attendanceList.present if not in presentById
    const presentCount = familyMemberIds.filter(id => {
      const presentInState = presentById[id];
      if (presentInState !== undefined) {
        logger.log(`Person ${id}: present in state = ${presentInState}`);
        return presentInState;
      }
      // Fallback to attendanceList if not in presentById
      const person = familyMembers.find(p => p.id === id);
      const fallbackPresent = person ? Boolean(person.present) : false;
      logger.log(`Person ${id}: fallback present = ${fallbackPresent} (from attendanceList)`);
      return fallbackPresent;
    }).length;
    
    // If any are present, uncheck all. Otherwise, check all
    const shouldCheckAll = presentCount === 0;
    logger.log('Family members present:', presentCount, 'Should check all:', shouldCheckAll);
    logger.log('Current presentById state:', presentById);
    logger.log('=== END TOGGLE ALL FAMILY DEBUG ===');
    
    if (!selectedGathering || !selectedDate) {
      // Family operation flag clearing removed - no longer needed
      return;
    }

    // Track user modifications for all family members
    const now = Date.now();
    setLastUserModification(prev => {
      const updated = { ...prev };
      familyMemberIds.forEach(id => {
        updated[id] = now;
      });
      return updated;
    });

    // Update local state using presentById (consistent with individual toggles)
    setSavingById(prev => {
      const updated = { ...prev };
      familyMemberIds.forEach(id => {
        updated[id] = true;
      });
      return updated;
    });
    
    setPresentById(prev => {
      const updated = { ...prev };
      familyMemberIds.forEach(id => {
        updated[id] = shouldCheckAll;
      });
      return updated;
    });

    try {
      // Create attendance records for all family members
      const familyAttendanceRecords = familyMembers.map(person => ({
        individualId: person.id,
        present: shouldCheckAll
      }));

      logger.log('Sending attendance records:', familyAttendanceRecords);

      await sendAttendanceChange(selectedGathering.id, selectedDate, familyAttendanceRecords);

      // Clear saving state
      setSavingById(prev => {
        const updated = { ...prev };
        familyMemberIds.forEach(id => {
          updated[id] = false;
        });
        return updated;
      });
    } catch (err) {
      console.error('Failed to save family attendance change:', err);
      setError('Failed to save family changes');
      // Revert on error - restore previous state
      setSavingById(prev => {
        const updated = { ...prev };
        familyMemberIds.forEach(id => {
          updated[id] = false;
        });
        return updated;
      });
      setPresentById(prev => {
        const updated = { ...prev };
        familyMemberIds.forEach(id => {
          updated[id] = !shouldCheckAll; // Revert to previous state
        });
        return updated;
      });
    } finally {
      // Clear family operation flag after a short delay to allow state to settle
      // Family operation completion tracking removed - no longer needed without polling
    }
  };

  // Family operation tracking removed - no longer needed without polling

  // Handle WebSocket events using global context
  useEffect(() => {
    if (!isWebSocketConnected || !selectedGathering || !selectedDate) {
      return;
    }

    const handleAttendanceUpdated = (data: any) => {
      // Only process updates for the current gathering and date
      if (data.gatheringId === selectedGathering.id && data.date === selectedDate) {
        // Received attendance update via WebSocket
        // Handle standard attendance updates
        if (data.records) {
          // Update attendance records and presentById state (like visitor system)
          setAttendanceList(prev => prev.map(person => {
            const matchingRecord = data.records.find((record: any) => record.individualId === person.id);
            if (matchingRecord) {
              return { ...person, present: matchingRecord.present };
            }
            return person;
          }));
          
          // Update presentById state for immediate UI updates
          setPresentById(prev => {
            const newPresentById = { ...prev };
            data.records.forEach((record: any) => {
              newPresentById[record.individualId] = record.present;
            });
            return newPresentById;
          });
        }
        
        // Handle full refresh updates
        if (data.attendanceList) {
          setAttendanceList(data.attendanceList);
          // Update presentById state
          const newPresentById: { [key: number]: boolean } = {};
          data.attendanceList.forEach((person: any) => {
            newPresentById[person.id] = person.present;
          });
          setPresentById(newPresentById);
        }
        
        // Handle visitor updates
        if (data.visitors) {
          setVisitors(data.visitors);
        }
      }
    };

    const handleVisitorUpdated = (data: any) => {
      // Only process updates for the current gathering and date
      if (data.gatheringId === selectedGathering.id && data.date === selectedDate) {
        logger.log('🔌 [WEBSOCKET] Received visitor update:', data);
        setVisitors(data.visitors);
      }
    };

    // Subscribe to WebSocket events
    const unsubscribeAttendance = onAttendanceUpdate(handleAttendanceUpdated);
    const unsubscribeVisitor = onVisitorUpdate(handleVisitorUpdated);

    return () => {
      unsubscribeAttendance();
      unsubscribeVisitor();
    };
  }, [selectedGathering, selectedDate, isWebSocketConnected, onAttendanceUpdate, onVisitorUpdate]);

  // Refresh gatherings and sync time when WebSocket reconnects (user might have been assigned/unassigned while offline)
  useEffect(() => {
    if (isWebSocketConnected && user) {
      refreshGatherings();
      syncTimeWithServer(); // Re-sync time on reconnect to handle clock drift
    }
  }, [isWebSocketConnected, user?.id, refreshGatherings, syncTimeWithServer]);

  // WebSocket attendance updates using global context
  const attendanceWebSocket = {
    isConnected: isWebSocketConnected,
    isInRoom: false, // Room system is disabled, using church-based broadcasting
    connectionStatus: connectionStatus,
    roomName: null,
    lastUpdate: null,
    userActivity: [], // No active users tracking in simplified WebSocket
    joinRoom: () => {}, // Room system disabled
    leaveRoom: () => {}, // Room system disabled
    forceReconnect: () => {
      if (socket) {
        socket.disconnect();
        socket.connect();
      }
    }
  };

  // Polling is permanently disabled in favor of WebSocket real-time updates
  useEffect(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, []);

  // Clean up old modification timestamps (older than 60 seconds)
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      setLastUserModification(prev => {
        const cleaned = { ...prev };
        Object.keys(cleaned).forEach(key => {
          const id = parseInt(key);
          if (now - cleaned[id] > 60000) { // 60 seconds - increased from 30
            delete cleaned[id];
          }
        });
        return cleaned;
      });
    }, 60000); // Clean up every 60 seconds - increased from 30

    return () => clearInterval(cleanupInterval);
  }, []);



  // Handle add visitor
  const handleAddVisitor = async () => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    // Set default person type based on user role
    const defaultPersonType = user?.role === 'admin' || user?.role === 'coordinator' ? 'local_visitor' : 'local_visitor';
    setVisitorForm({
      personType: defaultPersonType,
      notes: '',
      persons: [{
        firstName: '',
        lastName: '',
        fillLastNameFromAbove: false,
        isChild: false
      }],
      autoFillSurname: false,
      familyName: ''
    });
    setIsEditingVisitor(false);
    setEditingVisitorData(null);
    setShowAddVisitorModal(true);
  };

  // Handle edit visitor
  const handleEditVisitor = (visitor: any, memberIndex?: number) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    
    // Find the family group this visitor belongs to
    const familyGroup = filteredGroupedVisitors.find((group: any) => 
      group.members.some((member: any) => member.id === visitor.id)
    );
    
    if (!familyGroup) {
      setError('Could not find visitor family group');
      return;
    }

    // Convert visitor data to form format, preserving isChild from DB
    const persons = familyGroup.members.map((member: any) => {
      const nameParts = member.name.trim().split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      
      return {
        firstName,
        lastName,
        fillLastNameFromAbove: false,
        isChild: Boolean(member.isChild)
      };
    });

    // Determine person type from visitor type
    const personType = visitor.visitorType === 'potential_regular' ? 'local_visitor' : 'traveller_visitor';

    setVisitorForm({
      personType,
      notes: familyGroup.members[0]?.notes || '',
      persons,
      autoFillSurname: false,
      familyName: familyGroup.familyName || ''
    });

    setIsEditingVisitor(true);
    setEditingVisitorData({
      visitorId: visitor.id,
      familyId: visitor.familyId || familyGroup.members[0]?.familyId || 0,
      familyName: familyGroup.familyName || '',
      selectedMemberIndex: memberIndex
    });
    setShowAddVisitorModal(true);
  };



  // Add functions to manage persons array
  const addPerson = () => {
    setVisitorForm(prev => {
      const newPerson: PersonForm = { 
        firstName: '', 
        lastName: '', 
        fillLastNameFromAbove: true,
        isChild: false
      };
      
      // Auto-fill surname from first person if they have one
      if (prev.persons.length > 0) {
        const firstPerson = prev.persons[0];
        if (firstPerson.lastName && firstPerson.lastName.trim()) {
          newPerson.lastName = firstPerson.lastName;
        }
      }
      
      return {
        ...prev,
        persons: [...prev.persons, newPerson]
      };
    });
  };

  const removePerson = (index: number) => {
    setVisitorForm(prev => ({
      ...prev,
      persons: prev.persons.filter((_, i) => i !== index)
    }));
  };

  const updatePerson = (index: number, updates: Partial<PersonForm>) => {
    setVisitorForm(prev => {
      const newPersons = [...prev.persons];
      newPersons[index] = { ...newPersons[index], ...updates };
      
      // Handle fill from above checkbox
      if (updates.fillLastNameFromAbove !== undefined) {
        if (updates.fillLastNameFromAbove && index > 0) {
          // Fill from first person's last name (only if they have one)
          const firstPerson = newPersons[0];
          if (firstPerson.lastName && firstPerson.lastName.trim()) {
            newPersons[index].lastName = firstPerson.lastName;
          }
        }
        // If unchecking fill from above, don't clear the name (let user decide)
      }
      
      // If updating first person's last name, update all others who have fillLastNameFromAbove checked
      if (index === 0 && updates.lastName !== undefined) {
        for (let i = 1; i < newPersons.length; i++) {
          if (newPersons[i].fillLastNameFromAbove) {
            newPersons[i].lastName = updates.lastName || '';
          }
        }
      }
      
      return { ...prev, persons: newPersons };
    });
  };

  const handleSubmitVisitor = async () => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    if (!selectedGathering) return;
    if (isSubmittingVisitor) return; // Prevent double-clicks
    
    setIsSubmittingVisitor(true);
    try {
      // Validate form
      for (const person of visitorForm.persons) {
        if (!person.firstName.trim()) {
          setError('First name is required for all persons');
          return;
        }
        // Last name is optional - can be empty
      }

      // Build people array - use empty string for missing surnames (not 'Unknown')
      const people = visitorForm.persons.map(person => ({
        firstName: person.firstName.trim(),
        lastName: person.lastName.trim(),
        firstUnknown: false,
        lastUnknown: !person.lastName.trim(),
        isChild: person.isChild || false
      }));

      const notes = visitorForm.notes.trim();

      let response;

      if (isEditingVisitor && editingVisitorData) {
        // Edit existing visitor family - use proper update APIs instead of updateVisitor
        const familyName = visitorForm.familyName.trim() || generateFamilyName(convertToUtilityFormat(people)) || 'Visitor Family';
        
        // Update the visitor family in People system (only if family name is provided)
        if (familyName) {
          await familiesAPI.update(editingVisitorData.familyId, {
            familyName,
            familyType: visitorForm.personType
          });
        } else {
          // Just update the family type if no name change
          await familiesAPI.update(editingVisitorData.familyId, {
            familyType: visitorForm.personType
          });
        }

        // Update ALL family members to have the same people_type (fix for mixed visitor types)
        const personType = visitorForm.personType === 'local_visitor' ? 'local_visitor' : 'traveller_visitor';
        
        // Get all individuals to find family members
        const allIndividualsResponse = await individualsAPI.getAll();
        const allIndividuals = allIndividualsResponse.data.people || [];
        
        // Find all family members and update their people_type to match the family type
        // Use Number() to ensure consistent comparison (WebSocket may return BigInt IDs)
        const editFamilyId = Number(editingVisitorData.familyId);
        const familyMembers = allIndividuals.filter((ind: any) => Number(ind.familyId) === editFamilyId);
        
        // Update each existing family member's people_type, names, and isChild
        const updatePromises = familyMembers.map(async (member: any, index: number) => {
          const formPerson = people[index];
          return individualsAPI.update(member.id, {
            firstName: formPerson ? formPerson.firstName : member.firstName,
            lastName: formPerson ? formPerson.lastName : member.lastName,
            familyId: editingVisitorData.familyId,
            peopleType: personType,
            isChild: formPerson ? formPerson.isChild : Boolean(member.isChild)
          });
        });
        
        await Promise.all(updatePromises);
        
        // Create new individuals for any additional people added to the form
        const newPeopleCount = people.length - familyMembers.length;
        let createdIndividuals: any[] = [];
        
        if (newPeopleCount > 0) {
          const newPeople = people.slice(familyMembers.length);
          const createPromises = newPeople.map(async (person) => {
            return individualsAPI.create({
              firstName: person.firstName,
              lastName: person.lastName,
              familyId: editingVisitorData.familyId,
              peopleType: personType,
              isChild: person.isChild
            });
          });
          
          const createResults = await Promise.all(createPromises);
          createdIndividuals = createResults.map(r => r.data);
          
          // Add the new individuals to the current service attendance
          if (selectedGathering && selectedDate) {
            const addToServicePromises = createdIndividuals.map(async (individual) => {
              return attendanceAPI.addIndividualToService(
                selectedGathering.id,
                selectedDate,
                individual.id
              );
            });
            await Promise.all(addToServicePromises);
          }
        }
        
        const totalMembers = familyMembers.length + createdIndividuals.length;
        response = { data: { message: 'Visitor family updated successfully', individuals: [...familyMembers, ...createdIndividuals].map((m: any) => ({ id: m.id, firstName: m.firstName, lastName: m.lastName })) } };
        
        if (newPeopleCount > 0) {
          showSuccess(`Visitor family updated: ${newPeopleCount} new member${newPeopleCount !== 1 ? 's' : ''} added (${totalMembers} total)`);
        } else {
          showSuccess(`Visitor family updated successfully (${totalMembers} member${totalMembers !== 1 ? 's' : ''})`);
        }
      } else {
        // Create new visitor family in People system and add to service
        const familyName = visitorForm.familyName.trim() || generateFamilyName(convertToUtilityFormat(people)) || 'Visitor Family';
        
        // Create visitor family in People system
        const familyResponse = await familiesAPI.createVisitorFamily({
          familyName,
          peopleType: visitorForm.personType,
          notes: notes ? notes : undefined,
          people
        });
        
        // Add the family to the current service
        response = await attendanceAPI.addVisitorFamilyToService(
          selectedGathering.id, 
          selectedDate, 
          familyResponse.data.familyId
        );

        // Show success toast
        if (response.data.individuals && response.data.individuals.length > 0) {
          const names = response.data.individuals.map((ind: { firstName: string; lastName: string }) => `${ind.firstName} ${ind.lastName}`).join(', ');
          showSuccess(`Added as visitor family: ${names}`);
        } else {
          showSuccess('Added successfully');
        }
      }

      // Reload attendance data and related visitor data to ensure immediate visibility
      setAttendanceRefreshTrigger(prev => prev + 1);
      
      // Also refresh recent visitors and all church people to ensure new visitors appear immediately
      if (selectedGathering) {
        try {
          // Refresh recent visitors for this gathering
          const recentResponse = await attendanceAPI.getRecentVisitors(selectedGathering.id);
          setRecentVisitors(recentResponse.data.visitors || []);
          setAllRecentVisitorsPool(recentResponse.data.visitors || []);
          
          // Refresh all church people to include the newly added visitor
          const allPeopleResponse = await attendanceAPI.getAllPeople();
          setAllChurchVisitors(allPeopleResponse.data.visitors || []);
          
          logger.log('✅ Refreshed all visitor data after visitor operation');
        } catch (refreshErr) {
          logger.warn('⚠️ Failed to refresh some visitor data:', refreshErr);
          // Don't throw error since the main operation succeeded
        }
      }
      
      // Reset form and close modal
      setVisitorForm({
        personType: 'local_visitor',
        notes: '',
        persons: [{
          firstName: '',
          lastName: '',
          fillLastNameFromAbove: false,
          isChild: false
        }],
        autoFillSurname: false,
        familyName: ''
      });
      setIsEditingVisitor(false);
      setEditingVisitorData(null);
      setShowAddVisitorModal(false);
      setError('');
    } catch (err: any) {
      console.error('Failed to save visitor:', err);
      setError(err.response?.data?.error || 'Failed to save visitor');
    } finally {
      setIsSubmittingVisitor(false);
    }
  };



  // Group attendees by family and filter based on search term (memoized)
  const groupedAttendees = useMemo(() => {
    const groups: any = {};
    attendanceList.forEach(person => {
      if (groupByFamily && person.familyId) {
        const familyKey = `family_${person.familyId}`;
        if (!groups[familyKey]) {
          groups[familyKey] = {
            family_id: person.familyId,
            familyName: person.familyName,
            members: [] as Individual[],
          };
        }
        groups[familyKey].members.push(person);
      } else {
        const individualGroupKey = 'individuals';
        if (!groups[individualGroupKey]) {
          groups[individualGroupKey] = {
            family_id: null,
            familyName: null,
            members: [] as Individual[],
          };
        }
        groups[individualGroupKey].members.push(person);
      }
    });
    return groups;
  }, [attendanceList, groupByFamily]);

  // Group visitors helper, accepts any input array
  const groupVisitors = useCallback((visitorsInput: Visitor[]) => {
    if (!groupByFamily) {
      return [{ familyId: null, familyName: null, members: visitorsInput, isFamily: false, groupKey: 'ungrouped' }];
    }

    const grouped: { [key: string]: { familyId: number | null; familyName: string | null; members: Visitor[]; isFamily: boolean; groupKey: string; firstSeenIndex: number } } = {};

    visitorsInput.forEach((visitor, index) => {
      const visitorId = visitor.id || `temp_${index}`;
      const groupKey = visitor.visitorFamilyGroup || visitor.familyId ? `family_${visitor.visitorFamilyGroup || visitor.familyId}` : `individual_${visitorId}`;
      if (!grouped[groupKey]) {
        const isFamily = !!visitor.visitorFamilyGroup;
        // Prefer server-provided familyName to avoid heuristic mismatches
        let familyName: string | null = null;
        if (isFamily) {
          familyName = visitor.familyName || null;
        }
        if (!familyName) {
          // Fallbacks only when no server family name is available
          const parts = visitor.name.trim().split(' ');
          const firstName = parts[0] || 'Unknown';
          const lastName = parts.slice(1).join(' ');
          familyName = lastName && lastName !== 'Unknown' ? `${lastName.toUpperCase()}, ${firstName}` : (firstName && firstName !== 'Unknown' ? firstName : 'Visitor Family');
        }
        const computedFamilyId = isFamily
          ? (visitor.visitorFamilyGroup ? Number(visitor.visitorFamilyGroup) : (visitor.familyId ?? null))
          : (visitor.familyId ?? null);
        grouped[groupKey] = { 
          familyId: computedFamilyId, 
          familyName, 
          members: [], 
          isFamily, 
          groupKey,
          firstSeenIndex: index // Track when this family was first seen to preserve order
        };
      }
      grouped[groupKey].members.push(visitor);
    });
    
    // Sort groups by firstSeenIndex to preserve the order families were first encountered
    // and sort members within each family by their original order in the input array
    const sortedGroups = Object.values(grouped)
      .sort((a, b) => a.firstSeenIndex - b.firstSeenIndex)
      .map(group => {
        // Sort family members: adults first, then by original order
        const sortedMembers = group.members.sort((a, b) => {
          const aChild = a.isChild ? 1 : 0;
          const bChild = b.isChild ? 1 : 0;
          if (aChild !== bChild) return aChild - bChild;
          const indexA = visitorsInput.findIndex(v => v.id === a.id);
          const indexB = visitorsInput.findIndex(v => v.id === b.id);
          return indexA - indexB;
        });
        
        // Remove the firstSeenIndex property before returning
        const { firstSeenIndex, ...groupWithoutIndex } = group;
        return { ...groupWithoutIndex, members: sortedMembers };
      });
    
    return sortedGroups;
  }, [groupByFamily]);

  // Build displayed recent visitors groups: only show visitors who have attended within configured service limits
  const displayedGroupedVisitors = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    
    if (search) {
      // When searching, include all recent visitors (even those outside service limits)
      const poolMap = new Map<number | string, Visitor>();
      allRecentVisitorsPool.forEach(v => { if (v.id) poolMap.set(v.id, v); });
      allVisitors.forEach(v => { if (v.id) poolMap.set(v.id, v); });
      const filtered = Array.from(poolMap.values()).filter(v => v.name.toLowerCase().includes(search));
      return groupVisitors(filtered);
    }
    
    // When not searching, preserve the original order of all visitors
    // Don't separate by attendance status to avoid reordering family members
    const poolMap = new Map<number | string, Visitor>();
    
    // Add all recent visitors first (preserving their original order)
    allRecentVisitorsPool.forEach(v => { if (v.id) poolMap.set(v.id, v); });
    
    // Add all current visitors, but only if they're not already in the pool
    // This preserves the order while ensuring we have the most up-to-date data
    allVisitors.forEach(v => { if (v.id) poolMap.set(v.id, v); });
    
    const allVisitorsInOrder = Array.from(poolMap.values());
    return groupVisitors(allVisitorsInOrder);
  }, [searchTerm, allRecentVisitorsPool, allVisitors, groupVisitors]);

  // Filter families based on search term and sort members (memoized)
  const filteredGroupedAttendees = useMemo(() => {
    const groups = Object.values(groupedAttendees) as any[];
    const filtered = groups.filter((group: any) => {
      if (!searchTerm.trim()) return true;
      const searchLower = searchTerm.toLowerCase();
      return group.members.some((member: Individual) => {
        const fullName = `${member.firstName} ${member.lastName}`.toLowerCase();
        return fullName.includes(searchLower);
      });
    });
    filtered.forEach((group: any) => {
      group.members = [...group.members].sort((a: Individual, b: Individual) => {
        const aChild = a.isChild ? 1 : 0;
        const bChild = b.isChild ? 1 : 0;
        if (aChild !== bChild) return aChild - bChild;
        const lastNameComparison = a.lastName.localeCompare(b.lastName);
        if (lastNameComparison !== 0) return lastNameComparison;
        return a.firstName.localeCompare(b.firstName);
      });
    });
    return filtered;
  }, [groupedAttendees, searchTerm]);

  const filteredGroupedVisitors = displayedGroupedVisitors;

  // Group church-wide people who are NOT currently visible in this gathering
  const groupedAllChurchVisitors = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    
    // Get IDs of people already visible in current gathering (attendees + recent visitors)
    const currentlyVisibleIds = new Set([
      ...attendanceList.map(person => person.id),
      ...allRecentVisitorsPool.map(visitor => visitor.id)
    ]);
    
    // Filter to show only church people NOT currently visible in this gathering
    const availableChurchPeople = allChurchVisitors.filter(person => 
      !currentlyVisibleIds.has(person.id) && 
      (search === '' || person.name.toLowerCase().includes(search))
    );
    
    return groupVisitors(availableChurchPeople);
  }, [allChurchVisitors, attendanceList, allRecentVisitorsPool, searchTerm, groupVisitors]);

  // Sort members within each group: adults first, then by name
  filteredGroupedAttendees.forEach((group: any) => {
    group.members.sort((a: Individual, b: Individual) => {
      const aChild = a.isChild ? 1 : 0;
      const bChild = b.isChild ? 1 : 0;
      if (aChild !== bChild) return aChild - bChild;
      const lastNameComparison = a.lastName.localeCompare(b.lastName);
      if (lastNameComparison !== 0) return lastNameComparison;
      return a.firstName.localeCompare(b.firstName);
    });
  });

  // Add toggle function for visitors
  const toggleVisitorAttendance = async (visitorId: number) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    
    // Track user modification
    const now = Date.now();
    setLastUserModification(prev => ({ ...prev, [visitorId]: now }));
    
    // Get the new present value before the toggle
    const newPresent = !visitorAttendance[visitorId];
    
    // Optimistic toggle
    setVisitorAttendance(prev => ({
      ...prev,
      [visitorId]: newPresent
    }));

    if (!selectedGathering || !selectedDate) return;

    // Check if we're online or offline (same logic as regular attendance)
    if (!isWebSocketConnected) {
      // Offline mode - save to local storage
      logger.log('📱 Offline mode - saving visitor change to local storage');
      saveToOfflineStorage({
        individualId: visitorId,
        present: newPresent,
        gatheringId: selectedGathering.id,
        date: selectedDate
      });
      return;
    }

    // Online mode - send via configured method
    try {
      await sendAttendanceChange(selectedGathering.id, selectedDate, [
        { individualId: visitorId, present: newPresent }
      ]);
      
      // Update visitors array present status
      setVisitors(prev => prev.map(v => v.id === visitorId ? { ...v, present: newPresent } : v));
    } catch (err) {
      console.error('Failed to save visitor attendance change:', err);
      setError(err instanceof Error ? err.message : 'Failed to save change');
      // Revert on error
      setVisitorAttendance(prev => ({
        ...prev,
        [visitorId]: !newPresent
      }));
    }
  };

  // Add toggle all family function for visitors
  const toggleAllVisitorFamily = async (familyGroup: number | string) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    
    // Family operation flags removed - no longer needed without polling
    
    const familyVisitors = allVisitors.filter(visitor => visitor.visitorFamilyGroup === familyGroup);
    const familyVisitorIds = familyVisitors.map(visitor => visitor.id).filter((id): id is number => id !== undefined);
    
    // Count how many family members are currently present
    const presentCount = familyVisitorIds.filter(id => visitorAttendance[id]).length;
    
    // If 2 or more are present, uncheck all. Otherwise, check all
    const shouldCheckAll = presentCount < 2;
    
    // Track user modifications for all family members
    const now = Date.now();
    setLastUserModification(prev => {
      const updated = { ...prev };
      familyVisitorIds.forEach(id => {
        updated[id] = now;
      });
      return updated;
    });
    
    // Optimistic update
    setVisitorAttendance(prev => {
      const updated = { ...prev };
      familyVisitorIds.forEach(id => {
        updated[id] = shouldCheckAll;
      });
      return updated;
    });

    if (!selectedGathering || !selectedDate) {
      return;
    }

    // Check if we're online or offline
    if (!isWebSocketConnected) {
      // Offline mode - save each family member change to local storage
      logger.log('📱 Offline mode - saving visitor family changes to local storage');
      familyVisitorIds.forEach(visitorId => {
        saveToOfflineStorage({
          individualId: visitorId,
          present: shouldCheckAll,
          gatheringId: selectedGathering.id,
          date: selectedDate
        });
      });
      return;
    }

    // Online mode - send via configured method
    try {
      const familyAttendanceRecords = familyVisitorIds.map(id => ({ individualId: id, present: shouldCheckAll }));
      
      await sendAttendanceChange(selectedGathering.id, selectedDate, familyAttendanceRecords);
      
      // Update visitors array present status
      setVisitors(prev => prev.map(v => familyVisitorIds.includes(v.id) ? { ...v, present: shouldCheckAll } : v));
    } catch (err) {
      console.error('Failed to save visitor family attendance change:', err);
      setError(err instanceof Error ? err.message : 'Failed to save family changes');
      // Revert on error
      setVisitorAttendance(prev => {
        const updated = { ...prev };
        familyVisitorIds.forEach(id => {
          updated[id] = !shouldCheckAll;
        });
        return updated;
      });
    }
  };

  // Add entire visitor family from All Visitors section to the current service
  const addVisitorFamilyFromAll = async (familyId?: number | null) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    if (!selectedGathering || !selectedDate || !familyId) return;
    try {
      const response = await attendanceAPI.addVisitorFamilyToService(selectedGathering.id, selectedDate, familyId);
      showSuccess('Added visitor family to this service');
      
      // Reload attendance data and related visitor data to ensure immediate visibility
      setAttendanceRefreshTrigger(prev => prev + 1);
      
      // Also refresh recent visitors and all church people to ensure newly added visitors appear immediately
      try {
        // Refresh recent visitors for this gathering
        const recentResponse = await attendanceAPI.getRecentVisitors(selectedGathering.id);
        setRecentVisitors(recentResponse.data.visitors || []);
        setAllRecentVisitorsPool(recentResponse.data.visitors || []);
        
        // Refresh all church people to reflect the change
        const allPeopleResponse = await attendanceAPI.getAllPeople();
        setAllChurchVisitors(allPeopleResponse.data.visitors || []);
        
        logger.log('✅ Refreshed all visitor data after adding visitor family from all church people');
      } catch (refreshErr) {
        logger.warn('⚠️ Failed to refresh some visitor data:', refreshErr);
        // Don't throw error since the main operation succeeded
      }
    } catch (err: any) {
      console.error('Failed to add visitor family from All Visitors:', err);
      setError(err.response?.data?.error || 'Failed to add visitor family');
    }
  };

  // Add individual person from All People section to the current service
  const addIndividualFromAll = async (personId: number, personName: string) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    if (!selectedGathering || !selectedDate || !personId) return;
    
    logger.log('🔍 Adding individual to service:', {
      personId,
      personName,
      gatheringId: selectedGathering.id,
      date: selectedDate
    });
    
    try {
      // Add just this individual by creating a temporary single-person request
      const response = await attendanceAPI.addIndividualToService(selectedGathering.id, selectedDate, personId);
      logger.log('✅ Successfully added individual:', response.data);
      showSuccess(`Added ${personName} to this service`);
      
      // Reload attendance data and related visitor data to ensure immediate visibility
      setAttendanceRefreshTrigger(prev => prev + 1);
      
      // Also refresh recent visitors and all church people to ensure newly added person appears immediately
      try {
        // Refresh recent visitors for this gathering
        const recentResponse = await attendanceAPI.getRecentVisitors(selectedGathering.id);
        setRecentVisitors(recentResponse.data.visitors || []);
        setAllRecentVisitorsPool(recentResponse.data.visitors || []);
        
        // Refresh all church people to reflect the change
        const allPeopleResponse = await attendanceAPI.getAllPeople();
        setAllChurchVisitors(allPeopleResponse.data.visitors || []);
        
        logger.log('✅ Refreshed all visitor data after adding individual from all church people');
      } catch (refreshErr) {
        logger.warn('⚠️ Failed to refresh some visitor data:', refreshErr);
        // Don't throw error since the main operation succeeded
      }
    } catch (err: any) {
      console.error('❌ Failed to add individual from All People:', err);
      logger.error('Error details:', {
        message: err.message,
        response: err.response?.data,
        status: err.response?.status
      });
      setError(err.response?.data?.error || err.message || 'Failed to add person');
    }
  };

  // Helper function to count actual number of people in visitor records
  const getVisitorPeopleCount = useMemo(() => {
    // Count only visitors that are marked as present
    return allVisitors.filter((visitor) => {
      return visitor.id && visitorAttendance[visitor.id];
    }).length;
  }, [allVisitors, visitorAttendance]);

  // Adult/child breakdown for attendance summary bubbles
  const attendanceBreakdown = useMemo(() => {
    // Regular attendees breakdown
    const regularPresent = attendanceList.filter(p => presentById[p.id] ?? p.present);
    const regularAdults = regularPresent.filter(p => !p.isChild).length;
    const regularChildren = regularPresent.filter(p => p.isChild).length;

    const regularAbsent = attendanceList.filter(p => !(presentById[p.id] ?? p.present));
    const absentAdults = regularAbsent.filter(p => !p.isChild).length;
    const absentChildren = regularAbsent.filter(p => p.isChild).length;

    // Visitor breakdown
    const presentVisitors = allVisitors.filter(v => v.id && visitorAttendance[v.id!]);
    const visitorAdults = presentVisitors.filter(v => !v.isChild).length;
    const visitorChildren = presentVisitors.filter(v => v.isChild).length;

    return {
      regular: { adults: regularAdults, children: regularChildren },
      visitors: { adults: visitorAdults, children: visitorChildren },
      absent: { adults: absentAdults, children: absentChildren },
      total: { adults: regularAdults + visitorAdults, children: regularChildren + visitorChildren },
    };
  }, [attendanceList, presentById, allVisitors, visitorAttendance]);

  // Memoized family name computation for visitor form
  const computedVisitorFamilyName = useMemo(() => {
    const validMembers = visitorForm.persons.filter(member => 
      member.firstName.trim()
    );
    
    if (validMembers.length === 0) return '';
    
    return generateFamilyName(validMembers.map(person => ({
      firstName: person.firstName.trim(),
      lastName: person.lastName.trim(),
      lastUnknown: !person.lastName.trim(),
      isChild: person.isChild || false
    })));
  }, [visitorForm.persons]);

  // Helper function to get the appropriate modal title
  const getAddModalTitle = () => {
    if (isEditingVisitor) {
      const totalPeople = visitorForm.persons.length;
      if (totalPeople === 1) {
        return 'Edit Visitor';
      } else {
        return `Edit Visitors (${totalPeople})`;
      }
    } else {
      const totalPeople = visitorForm.persons.length;
      if (totalPeople === 1) {
        return 'Add Visitor';
      } else {
        return `Add Visitors (${totalPeople})`;
      }
    }
  };

  // Helper function to get the appropriate button text
  const getAddButtonText = () => {
    if (isEditingVisitor) {
      return 'Save Changes';
    } else {
      const totalPeople = visitorForm.persons.length;
      if (totalPeople === 1) {
        return 'Add Visitor';
      } else {
        return 'Add Visitors';
      }
    }
  };

  // Helper function to check if a visitor should be highlighted
  const shouldHighlightVisitor = (visitor: any, memberIndex?: number) => {
    if (!isEditingVisitor || !editingVisitorData) return false;
    
    // If we're editing a specific member, highlight that member
    if (editingVisitorData.selectedMemberIndex !== undefined && memberIndex !== undefined) {
      return memberIndex === editingVisitorData.selectedMemberIndex;
    }
    
    // Otherwise, highlight if this visitor matches the one being edited
    return visitor.id === editingVisitorData.visitorId;
  };

  // Helper function to generate family name from people array
  // Helper function to convert AttendancePage person format to utility format
  const convertToUtilityFormat = (people: Array<{
    firstName: string;
    lastName: string;
    firstUnknown: boolean;
    lastUnknown: boolean;
    isChild: boolean;
  }>) => {
    return people.map(person => ({
      firstName: person.firstName && person.firstName !== 'Unknown' ? person.firstName : '',
      lastName: !person.lastUnknown && person.lastName && person.lastName !== 'Unknown' ? person.lastName : '',
      firstUnknown: person.firstUnknown,
      lastUnknown: person.lastUnknown,
      isChild: person.isChild
    }));
  };



  // Gatherings order management (drag & drop) with localStorage persistence
  const [isReorderMode, setIsReorderMode] = useState(false);
  const [orderedGatherings, setOrderedGatherings] = useState<GatheringType[]>([]);
  const draggingGatheringId = useRef<number | null>(null);
  const [showReorderModal, setShowReorderModal] = useState(false);
  const [reorderList, setReorderList] = useState<GatheringType[]>([]);
  const dragIndexRef = useRef<number | null>(null);

  // Add scroll event listeners for fade indicators
  useEffect(() => {
    const handleScroll = () => {
      checkScrollPosition(tabSliderRef, true);
      checkScrollPosition(desktopTabSliderRef, false);
    };

    const mobileSlider = tabSliderRef.current;
    const desktopSlider = desktopTabSliderRef.current;

    if (mobileSlider) {
      mobileSlider.addEventListener('scroll', handleScroll);
    }
    if (desktopSlider) {
      desktopSlider.addEventListener('scroll', handleScroll);
    }

    // Initial check
    handleScroll();

    return () => {
      if (mobileSlider) {
        mobileSlider.removeEventListener('scroll', handleScroll);
      }
      if (desktopSlider) {
        desktopSlider.removeEventListener('scroll', handleScroll);
      }
    };
  }, [gatherings, orderedGatherings]);

  // Helper functions for responsive grid layout
  const getPersonDisplayName = (person: any, familyName?: string) => {
    // For visitors with .name property
    if (person.name) {
      const parts = person.name.trim().split(' ');
      const firstName = parts[0];
      const lastName = parts.slice(1).join(' ');
      
      if (familyName) {
        // Check if family name has no surname (no comma means first names only)
        const hasSurnameInFamilyName = familyName.includes(',');
        
        if (!hasSurnameInFamilyName) {
          // Family has no surname - show only first name
          return firstName;
        }
        
        // Family has surname - extract and compare
        const familySurname = familyName.split(',')[0]?.trim().toLowerCase();
        
        // Only hide surname if it matches the family surname and is not empty/unknown
        if (lastName && lastName.toLowerCase() !== 'unknown' && lastName.trim() && familySurname === lastName.toLowerCase()) {
          return firstName;
        }
      }
      
      // If no family name or surname doesn't match, check if person has no surname
      if (!lastName || lastName.toLowerCase() === 'unknown' || !lastName.trim()) {
        return firstName;
      }
      
      return person.name;
    }
    
    // For regular attendees with firstName/lastName
    if (familyName) {
      // Check if family name has no surname (no comma means first names only)
      const hasSurnameInFamilyName = familyName.includes(',');
      
      if (!hasSurnameInFamilyName) {
        // Family has no surname - show only first name
        return person.firstName || '';
      }
      
      // Family has surname - extract and compare
      const familySurname = familyName.split(',')[0]?.trim().toLowerCase();
      const personSurname = person.lastName?.toLowerCase() || '';
      
      // Only hide surname if it matches the family surname and is not empty/unknown
      if (personSurname && personSurname !== 'unknown' && familySurname === personSurname) {
        return person.firstName;
      }
    }
    
    // If person has no surname, show only first name
    if (!person.lastName || person.lastName.toLowerCase() === 'unknown' || !person.lastName.trim()) {
      return person.firstName || '';
    }
    
    return `${person.firstName || ''} ${person.lastName || ''}`.trim();
  };

  const shouldUseWideLayout = (name: string) => {
    // Names longer than 20 characters or containing very long individual words
    return name.length > 20 || name.split(' ').some(word => word.length > 15);
  };

  // Offline storage functions
  const saveToOfflineStorage = useCallback((change: {
    individualId: number;
    present: boolean;
    gatheringId: number;
    date: string;
  }) => {
    const offlineChanges = JSON.parse(localStorage.getItem('attendance_offline_changes') || '[]');
    const newChange = {
      ...change,
      timestamp: Date.now()
    };
    
    // Remove any existing change for this individual in this gathering/date
    const filteredChanges = offlineChanges.filter((c: any) => 
      !(c.individualId === change.individualId && 
        c.gatheringId === change.gatheringId && 
        c.date === change.date)
    );
    
    const updatedChanges = [...filteredChanges, newChange];
    localStorage.setItem('attendance_offline_changes', JSON.stringify(updatedChanges));
    setPendingChanges(updatedChanges);
    
    logger.log('💾 Saved to offline storage:', newChange);
  }, []);

  const syncOfflineChanges = useCallback(async () => {
    if (!isWebSocketConnected || pendingChanges.length === 0) return;
    
    setIsSyncing(true);
    logger.log('🔄 Syncing offline changes:', pendingChanges.length, 'changes');
    
    try {
      // Group changes by gathering and date
      const changesByGathering: { [key: string]: Array<{ individualId: number; present: boolean }> } = {};
      
      pendingChanges.forEach(change => {
        const key = `${change.gatheringId}|${change.date}`;
        if (!changesByGathering[key]) {
          changesByGathering[key] = [];
        }
        changesByGathering[key].push({
          individualId: change.individualId,
          present: change.present
        });
      });

      // Sync each group of changes
      for (const [key, changes] of Object.entries(changesByGathering)) {
        const [gatheringId, date] = key.split('|');
        
        logger.log(`🔄 Syncing ${changes.length} changes for gathering ${gatheringId} on ${date}:`, changes);
        
        try {
          await sendAttendanceChange(parseInt(gatheringId), date, changes);
          logger.log(`✅ Successfully synced ${changes.length} changes for gathering ${gatheringId} on ${date}`);
        } catch (syncError) {
          console.error(`❌ Failed to sync changes for gathering ${gatheringId} on ${date}:`, syncError);
          throw syncError; // Re-throw to trigger the outer catch block
        }
      }

      // Clear offline storage only if all syncs succeeded
      localStorage.removeItem('attendance_offline_changes');
      setPendingChanges([]);
      setError(''); // Clear any lingering error messages
      logger.log('✅ All offline changes synced successfully');
      
    } catch (error) {
      console.error('❌ Failed to sync offline changes:', error);
      
      // If changes are old (more than 1 hour), clear them instead of retrying
      const now = Date.now();
      const oldChanges = pendingChanges.filter(change => {
        const ageInMinutes = (now - change.timestamp) / (1000 * 60);
        return ageInMinutes > 60; // Changes older than 1 hour
      });
      
      if (oldChanges.length > 0) {
        logger.log('🧹 Clearing old failed changes:', oldChanges.length);
        localStorage.removeItem('attendance_offline_changes');
        setPendingChanges([]);
        setError(''); // Clear error since we're giving up on old changes
      } else {
        setError('Failed to sync offline changes. They will be retried when connection is restored.');
        // Don't clear pending changes on error - they'll be retried
      }
    } finally {
      setIsSyncing(false);
    }
  }, [isWebSocketConnected, pendingChanges]);

  // Load offline changes and cached attendance data on component mount
  useEffect(() => {
    // Clear any lingering error messages on component mount
    setError('');
    
    const offlineChanges = JSON.parse(localStorage.getItem('attendance_offline_changes') || '[]');
    
    // Clear any old offline changes that might have invalid date formats or are too old
    const now = Date.now();
    const validChanges = offlineChanges.filter((change: any) => {
      // Check if the date format is valid (should be YYYY-MM-DD)
      if (!change.date || !/^\d{4}-\d{2}-\d{2}$/.test(change.date)) {
        logger.log('🧹 Clearing invalid date format:', change.date);
        return false;
      }
      
      // Check age (keep changes less than 24 hours old)
      const ageInHours = (now - change.timestamp) / (1000 * 60 * 60);
      if (ageInHours >= 24) {
        logger.log('🧹 Clearing old change:', change);
        return false;
      }
      
      return true;
    });
    
    if (validChanges.length !== offlineChanges.length) {
      logger.log('🧹 Cleared stale offline changes:', offlineChanges.length - validChanges.length);
      localStorage.setItem('attendance_offline_changes', JSON.stringify(validChanges));
    }
    
    setPendingChanges(validChanges);
    // Loaded offline changes
    
    // Note: Cached attendance data is now loaded by dedicated effects
  }, [selectedGathering?.id, selectedDate]);

  // Clear error on component unmount to prevent stale state
  useEffect(() => {
    return () => {
      setError('');
    };
  }, []);

  // Sync offline changes when connection is restored
  useEffect(() => {
    if (isWebSocketConnected) {
      if (pendingChanges.length > 0) {
        syncOfflineChanges();
      } else {
        // Clear any lingering error messages when connection is restored
        setError('');
      }
    }
  }, [isWebSocketConnected, pendingChanges.length, syncOfflineChanges]);

  const loadSavedOrder = useCallback(async (items: GatheringType[]) => {
    if (!user?.id) return items;
    try {
      const savedOrder = await userPreferences.getGatheringOrder();
      if (!savedOrder?.order) return items;
      
      const orderIds: number[] = savedOrder.order;
      const idToItem = new Map(items.map(i => [i.id, i]));
      const ordered: GatheringType[] = [];
      orderIds.forEach(id => {
        const item = idToItem.get(id);
        if (item) ordered.push(item);
      });
      items.forEach(i => { if (!orderIds.includes(i.id)) ordered.push(i); });
      return ordered;
    } catch (e) {
      logger.warn('Failed to load saved gathering order', e);
      return items;
    }
  }, [user?.id]);

  useEffect(() => {
    const loadOrder = async () => {
      const ordered = await loadSavedOrder(gatherings);
      setOrderedGatherings(ordered);
    };
    loadOrder();
  }, [gatherings, loadSavedOrder]);

  const saveOrder = useCallback(async (items: GatheringType[]) => {
    if (!user?.id) return;
    const ids = items.map(i => i.id);
    try {
      await userPreferences.setGatheringOrder(ids);
    } catch (e) {
      logger.warn('Failed to save gathering order', e);
    }
  }, [user?.id]);

  const onDragStart = (id: number) => { draggingGatheringId.current = id; };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const onDrop = (targetId: number) => {
    // No-op for tab strip; reordering handled in modal now
    draggingGatheringId.current = null;
  };

  // Reorder modal helpers
  const openReorderModal = () => {
    const items = (orderedGatherings.length ? orderedGatherings : gatherings).slice();
    setReorderList(items);
    setShowReorderModal(true);
  };
  const closeReorderModal = () => setShowReorderModal(false);
  const onReorderDragStart = (index: number) => { dragIndexRef.current = index; };
  const onReorderDragOver = (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); };
  const onReorderDrop = (index: number) => {
    const fromIndex = dragIndexRef.current;
    dragIndexRef.current = null;
    if (fromIndex == null || fromIndex === index) return;
    setReorderList(prev => {
      const next = prev.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(index, 0, moved);
      return next;
    });
  };
  
  // Mobile reorder helper - move item up one position
  const moveItemUp = (index: number) => {
    if (index <= 0) return; // Can't move first item up
    setReorderList(prev => {
      const next = prev.slice();
      const [moved] = next.splice(index, 1);
      next.splice(index - 1, 0, moved);
      return next;
    });
  };
  
  const saveReorder = async () => {
    setOrderedGatherings(reorderList);
    await saveOrder(reorderList);
    // Persist default gathering as first item for cross-page defaults
    if (user?.id && reorderList.length > 0) {
      localStorage.setItem(`user_${user.id}_default_gathering_id`, String(reorderList[0].id));
    }
    setShowReorderModal(false);
  };

  return (
    <div className="space-y-6 pb-32">
      {/* Header */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Take Attendance</h1>
              <p className="mt-1 text-sm text-gray-500">
                Record attendance for your gathering
              </p>
            </div>
            <div className="flex items-center space-x-3">
              {/* isSaving && (
                <div className="flex items-center text-sm text-gray-500">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-600 mr-2"></div>
                  Saving...
                </div>
              ) */}
              {/* <button
                onClick={saveAttendance}
                disabled={isSaving}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
              >
                <CheckIcon className="h-4 w-4 mr-2" />
                Save Now
              </button> */}
            </div>
          </div>
        </div>
      </div>




      {/* Gathering Type Tabs and Controls */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="border-b border-gray-200 mb-6">
            {/* Mobile: Horizontal scrollable tabs with fade indicators */}
            <div className="block md:hidden">
              <div className="relative w-full overflow-hidden">
                <div 
                  ref={tabSliderRef}
                  className="flex items-center space-x-1 overflow-x-auto scrollbar-hide cursor-grab select-none w-full tab-slider" 
                  style={{scrollbarWidth: 'none', msOverflowStyle: 'none'}}
                  onMouseDown={(e) => handleMouseDown(e, tabSliderRef)}
                  onMouseLeave={() => handleMouseLeave(tabSliderRef)}
                  onMouseUp={() => handleMouseUp(tabSliderRef)}
                  onMouseMove={(e) => handleMouseMove(e, tabSliderRef)}
                  onTouchStart={(e) => handleTouchStart(e, tabSliderRef)}
                  onTouchMove={(e) => handleTouchMove(e, tabSliderRef)}
                  onTouchEnd={handleTouchEnd}
                >
                  {(orderedGatherings.length ? orderedGatherings : gatherings).map((gathering, index) => (
                    <div key={gathering.id} className="flex-shrink-0 min-w-0">
                      <button
                        draggable={false}
                        onClick={(e) => {
                          if (!isDragging) {
                            handleGatheringChange(gathering);
                          }
                        }}
                        className={`h-12 py-2 px-3 font-medium text-xs transition-all duration-300 rounded-t-lg group ${
                          selectedGathering?.id === gathering.id
                            ? 'bg-primary-500 text-white'
                            : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                        }`}
                        title={gathering.name}
                      >
                        <div className="flex items-center justify-center h-full">
                          <span className="text-center leading-tight whitespace-nowrap">
                            {gathering.name}
                          </span>
                        </div>
                      </button>
                    </div>
                  ))}
                  
                  {/* Edit Tab - Only show when there are multiple gatherings */}
                  {(orderedGatherings.length ? orderedGatherings : gatherings).length > 1 && (
                    <div className="flex-shrink-0 min-w-0">
                      <button
                        draggable={false}
                        onClick={(e) => {
                          if (!isDragging) {
                            openReorderModal();
                          }
                        }}
                        className="h-12 py-2 px-3 font-medium text-xs transition-all duration-300 rounded-t-lg border-2 border-dashed border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-700 hover:bg-gray-50"
                        title="Edit gathering order"
                      >
                        <div className="flex items-center justify-center h-full">
                          <span className="text-center leading-tight whitespace-nowrap flex items-center space-x-1">
                            <PencilIcon className="h-3 w-3" />
                            <span>Edit Order</span>
                          </span>
                        </div>
                      </button>
                    </div>
                  )}
                  
                </div>
                
                {/* Fade indicators */}
                {showLeftFade && (
                  <div className="absolute top-0 left-0 w-8 h-12 bg-gradient-to-r from-white via-white/90 to-transparent pointer-events-none z-10">
                    <div className="absolute top-1/2 left-2 -translate-y-1/2 w-4 h-4 text-gray-600 bg-white rounded-full shadow-sm flex items-center justify-center">
                      <svg viewBox="0 0 16 16" fill="currentColor">
                        <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                )}
                {showRightFade && (
                  <div className="absolute top-0 right-0 w-8 h-12 bg-gradient-to-l from-white via-white/90 to-transparent pointer-events-none z-10">
                    <div className="absolute top-1/2 right-2 -translate-y-1/2 w-4 h-4 text-gray-600 bg-white rounded-full shadow-sm flex items-center justify-center">
                      <svg viewBox="0 0 16 16" fill="currentColor">
                        <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            {/* Desktop: Horizontal scrollable tabs with fade indicators */}
            <nav className="hidden md:flex -mb-px items-center w-full" aria-label="Tabs">
              <div className="relative flex-1 overflow-hidden">
                <div 
                  ref={desktopTabSliderRef}
                  className="flex items-center space-x-2 overflow-x-auto scrollbar-hide cursor-grab select-none w-full tab-slider" 
                  style={{scrollbarWidth: 'none', msOverflowStyle: 'none'}}
                  onMouseDown={(e) => handleMouseDown(e, desktopTabSliderRef)}
                  onMouseLeave={() => handleMouseLeave(desktopTabSliderRef)}
                  onMouseUp={() => handleMouseUp(desktopTabSliderRef)}
                  onMouseMove={(e) => handleMouseMove(e, desktopTabSliderRef)}
                >
                  {(orderedGatherings.length ? orderedGatherings : gatherings).map((gathering) => (
                    <div key={gathering.id} className="flex-shrink-0">
                      <button
                        draggable={false}
                        onClick={(e) => {
                          if (!isDragging) {
                            handleGatheringChange(gathering);
                          }
                        }}
                        className={`h-12 py-2 px-4 font-medium text-xs transition-all duration-300 rounded-t-lg group ${
                          selectedGathering?.id === gathering.id
                            ? 'bg-primary-500 text-white'
                            : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                        }`}
                        title={gathering.name}
                      >
                        <div className="flex items-center justify-center h-full">
                          <span className="text-center leading-tight whitespace-nowrap">
                            {gathering.name}
                          </span>
                        </div>
                      </button>
                    </div>
                  ))}
                  
                  {/* Edit Tab - Only show when there are multiple gatherings */}
                  {(orderedGatherings.length ? orderedGatherings : gatherings).length > 1 && (
                    <div className="flex-shrink-0">
                      <button
                        draggable={false}
                        onClick={(e) => {
                          if (!isDragging) {
                            openReorderModal();
                          }
                        }}
                        className="h-12 py-2 px-4 font-medium text-xs transition-all duration-300 rounded-t-lg border-2 border-dashed border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-700 hover:bg-gray-50"
                        title="Edit gathering order"
                      >
                        <div className="flex items-center justify-center h-full">
                          <span className="text-center leading-tight whitespace-nowrap flex items-center space-x-1">
                            <PencilIcon className="h-3 w-3" />
                            <span>Edit Order</span>
                          </span>
                        </div>
                      </button>
                    </div>
                  )}
                  
                </div>
                
                {/* Fade indicators */}
                {showDesktopLeftFade && (
                  <div className="absolute top-0 left-0 w-10 h-12 bg-gradient-to-r from-white via-white/90 to-transparent pointer-events-none z-10">
                    <div className="absolute top-1/2 left-3 -translate-y-1/2 w-5 h-5 text-gray-600 bg-white rounded-full shadow-sm flex items-center justify-center">
                      <svg viewBox="0 0 20 20" fill="currentColor">
                        <path d="M12.5 5L7.5 10L12.5 15" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                )}
                {showDesktopRightFade && (
                  <div className="absolute top-0 right-0 w-10 h-12 bg-gradient-to-l from-white via-white/90 to-transparent pointer-events-none z-10">
                    <div className="absolute top-1/2 right-3 -translate-y-1/2 w-5 h-5 text-gray-600 bg-white rounded-full shadow-sm flex items-center justify-center">
                      <svg viewBox="0 0 20 20" fill="currentColor">
                        <path d="M7.5 5L12.5 10L7.5 15" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                )}
              </div>
            </nav>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Date Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Meeting Date
                {selectedDate && (() => {
                  const status = getDateStatus(selectedDate);
                  if (status.type === 'past') {
                    return (
                      <span className="ml-2 px-2 py-1 text-xs bg-amber-100 text-amber-800 rounded-full">
                        {status.daysDiff === 1 ? 'Yesterday' : `${status.daysDiff} days ago`}
                      </span>
                    );
                  } else if (status.type === 'future') {
                    return (
                      <span className="ml-2 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full">
                        {status.daysDiff === 1 ? 'Tomorrow' : `In ${status.daysDiff} days`}
                      </span>
                    );
                  }
                  return null;
                })()}
              </label>
              <div className="relative">
                {validDates.length > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowDatePicker(!showDatePicker)}
                      className="shadow-sm focus:ring-primary-500 focus:border-primary-500 block w-full px-3 py-2 sm:text-sm border border-gray-300 rounded-md bg-white text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-gray-900">
                          {selectedDate ? (
                            (() => {
                              const dateObj = new Date(selectedDate);
                              const isToday = format(dateObj, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
                              return isToday 
                                ? `Today (${format(dateObj, 'MMM d, yyyy')})`
                                : format(dateObj, 'EEEE, MMM d, yyyy');
                            })()
                          ) : (
                            'Select a date'
                          )}
                        </span>
                        <CalendarIcon className="h-5 w-5 text-gray-400" />
                      </div>
                    </button>
                    
                    {showDatePicker && (
                      <div ref={datePickerRef} className="absolute top-full left-0 mt-2 z-50">
                        <AttendanceDatePicker
                          selectedDate={selectedDate}
                          onDateChange={(date) => {
                            logger.log('📅 User selected new date via date picker:', { from: selectedDate, to: date });
                            setSelectedDate(date);
                            setShowDatePicker(false);
                          }}
                          validDates={validDates}
                          gatheringName={selectedGathering?.name}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-sm text-gray-500 py-2 px-3 border border-gray-300 rounded-md bg-gray-50">
                    No valid dates available for this gathering schedule
                  </div>
                )}
              </div>
            </div>

            {/* Search/Filter Bar - Only show for standard gatherings */}
            {selectedGathering?.attendanceType === 'standard' && (
              <div>
                <label htmlFor="search" className="block text-sm font-medium text-gray-700 mb-2">
                  Filter Families & Visitors
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    type="text"
                    id="search"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search by family member or visitor name..."
                    className="shadow-sm focus:ring-primary-500 focus:border-primary-500 block w-full pl-10 pr-3 py-2 sm:text-sm border border-gray-300 rounded-md"
                  />
                </div>
              </div>
            )}

            {/* Group by Family Toggle - Only show for standard gatherings */}
            {selectedGathering?.attendanceType === 'standard' && (
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <input
                    id="groupByFamily"
                    type="checkbox"
                    checked={groupByFamily}
                    onChange={(e) => handleGroupByFamilyChange(e.target.checked)}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                  />
                  <label htmlFor="groupByFamily" className="ml-2 block text-sm text-gray-900">
                    Group people by family
                  </label>
                </div>
                <div className="text-sm text-gray-500">
                  {groupByFamily ? 'Families grouped together' : 'Individuals listed separately'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Attendance Summary Bar - Show only for standard gatherings */}
      {selectedGathering && validDates.length > 0 && selectedGathering.attendanceType === 'standard' && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            {isAttendanceLocked && selectedGathering.attendanceType === 'standard' && (
              <div className="mb-4 rounded-md bg-amber-50 border border-amber-200 p-3 text-amber-800 text-sm">
                Editing is locked for attendance takers for services older than 2 weeks.
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {/* Total Present */}
              <div className="text-center relative">
                <button
                  onClick={() => setActiveStatBubble(activeStatBubble === 'total' ? null : 'total')}
                  className="w-full focus:outline-none active:scale-95 transition-transform"
                >
                  <div className="text-2xl font-bold text-gray-900">
                    {attendanceList.reduce((acc, p) => acc + ((presentById[p.id] ?? p.present) ? 1 : 0), 0) + getVisitorPeopleCount}
                  </div>
                  <div className="text-sm text-gray-500">Total Present</div>
                </button>
                {activeStatBubble === 'total' && (
                  <div className="absolute z-20 top-full mt-2 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg whitespace-nowrap">
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-800 rotate-45"></div>
                    <div className="flex gap-3">
                      <span>Adults: {attendanceBreakdown.total.adults}</span>
                      <span>Children: {attendanceBreakdown.total.children}</span>
                    </div>
                  </div>
                )}
              </div>
              {/* Regular Attendees */}
              <div className="text-center relative">
                <button
                  onClick={() => setActiveStatBubble(activeStatBubble === 'regular' ? null : 'regular')}
                  className="w-full focus:outline-none active:scale-95 transition-transform"
                >
                  <div className="text-2xl font-bold text-primary-600">
                    {attendanceList.reduce((acc, p) => acc + ((presentById[p.id] ?? p.present) ? 1 : 0), 0)}
                  </div>
                  <div className="text-sm text-gray-500">Regular Attendees</div>
                </button>
                {activeStatBubble === 'regular' && (
                  <div className="absolute z-20 top-full mt-2 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg whitespace-nowrap">
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-800 rotate-45"></div>
                    <div className="flex gap-3">
                      <span>Adults: {attendanceBreakdown.regular.adults}</span>
                      <span>Children: {attendanceBreakdown.regular.children}</span>
                    </div>
                  </div>
                )}
              </div>
              {/* Visitors */}
              <div className="text-center relative">
                <button
                  onClick={() => setActiveStatBubble(activeStatBubble === 'visitors' ? null : 'visitors')}
                  className="w-full focus:outline-none active:scale-95 transition-transform"
                >
                  <div className="text-2xl font-bold text-green-600">
                    {getVisitorPeopleCount}
                  </div>
                  <div className="text-sm text-gray-500">Visitors</div>
                </button>
                {activeStatBubble === 'visitors' && (
                  <div className="absolute z-20 top-full mt-2 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg whitespace-nowrap">
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-800 rotate-45"></div>
                    <div className="flex gap-3">
                      <span>Adults: {attendanceBreakdown.visitors.adults}</span>
                      <span>Children: {attendanceBreakdown.visitors.children}</span>
                    </div>
                  </div>
                )}
              </div>
              {/* Absent */}
              <div className="text-center relative">
                <button
                  onClick={() => setActiveStatBubble(activeStatBubble === 'absent' ? null : 'absent')}
                  className="w-full focus:outline-none active:scale-95 transition-transform"
                >
                  <div className="text-2xl font-bold text-gray-400">
                    {attendanceList.length - attendanceList.reduce((acc, p) => acc + ((presentById[p.id] ?? p.present) ? 1 : 0), 0)}
                  </div>
                  <div className="text-sm text-gray-500">Absent</div>
                </button>
                {activeStatBubble === 'absent' && (
                  <div className="absolute z-20 top-full mt-2 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg whitespace-nowrap">
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-800 rotate-45"></div>
                    <div className="flex gap-3">
                      <span>Adults: {attendanceBreakdown.absent.adults}</span>
                      <span>Children: {attendanceBreakdown.absent.children}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 p-4">
          <div className="text-sm text-red-700">{error}</div>
        </div>
      )}

      {/* Loading gatherings (prevents layout shift on initial load) */}
      {user && isLoadingGatherings && gatherings.length === 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex flex-col items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mb-3" />
              <p className="text-sm text-gray-500">Loading gatherings...</p>
            </div>
          </div>
        </div>
      )}

      {/* No gatherings available message */}
      {!isLoadingGatherings && gatherings.length === 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="text-center py-8">
              <CalendarIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No gatherings available</h3>
              <p className="mt-1 text-sm text-gray-500 mb-4">
                You haven't created any gatherings yet. Create a gathering to start taking attendance.
              </p>
              <div className="bg-blue-50 border border-blue-200 rounded-md p-4 max-w-md mx-auto">
                <div className="text-sm text-blue-700">
                  <p className="font-medium mb-2">Get started by:</p>
                  <ul className="text-left space-y-1">
                    <li>• <a href="/app/gatherings" className="text-blue-600 hover:text-blue-800 underline">Creating your first gathering</a></li>
                    <li>• <a href="/app/people" className="text-blue-600 hover:text-blue-800 underline">Adding people to your congregation</a></li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* No gathering or no valid dates message */}
      {selectedGathering && validDates.length === 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="text-center py-8">
              <CalendarIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No valid dates available</h3>
              <p className="mt-1 text-sm text-gray-500">
                This gathering ({selectedGathering.name}) doesn't have any valid dates in the current range.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Conditional Rendering based on Gathering Type */}
      {selectedGathering && validDates.length > 0 && (
        <>
          {selectedGathering.attendanceType === 'headcount' ? (
            <div className="bg-white shadow rounded-lg overflow-visible">
              <div className="px-4 py-5 sm:p-6">
                {/* Navigation Section */}
                <div className="flex justify-center items-center mb-6 py-3 border-b border-gray-100">
                  <div className="flex items-center space-x-4">
                    <button
                      onClick={navigateToPreviousDate}
                      disabled={!canNavigatePrevious}
                      className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-gray-50 hover:bg-gray-100 disabled:bg-gray-25 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                      title="Previous gathering"
                    >
                      <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                      <span className="text-sm text-gray-600">Previous</span>
                    </button>
                    
                    <div className="text-sm font-medium text-gray-700 px-4">
                      {selectedDate ? new Date(selectedDate).toLocaleDateString('en-US', {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                      }) : 'Select Date'}
                    </div>
                    
                    <button
                      onClick={navigateToNextDate}
                      disabled={!canNavigateNext}
                      className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-gray-50 hover:bg-gray-100 disabled:bg-gray-25 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                      title="Next gathering"
                    >
                      <span className="text-sm text-gray-600">Next</span>
                      <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-medium text-gray-900">
                    Headcount - {selectedGathering.name}
                  </h3>
                  
                  <button
                    onClick={() => setHeadcountFullscreen(true)}
                    className="md:hidden inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-purple-600 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                    </svg>
                    Fullscreen
                  </button>
                </div>
                
                <HeadcountAttendanceInterface
                  gatheringTypeId={selectedGathering.id}
                  date={selectedDate}
                  gatheringName={selectedGathering.name}
                  onHeadcountChange={setHeadcountValue}
                  isFullscreen={headcountFullscreen}
                  onExitFullscreen={() => setHeadcountFullscreen(false)}
                  socket={socket}
                  isConnected={isWebSocketConnected}
                  sendHeadcountUpdate={sendHeadcountUpdate}
                />
              </div>
            </div>
          ) : (
            <div className="bg-white shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                {/* Navigation Section - At the very top */}
                <div className="flex justify-center items-center mb-6 py-3 border-b border-gray-100 -mt-6 -mx-6 px-6 rounded-t-lg">
                  <div className="flex items-center space-x-4">
                    <button
                      onClick={navigateToPreviousDate}
                      disabled={!canNavigatePrevious}
                      className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-gray-50 hover:bg-gray-100 disabled:bg-gray-25 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                      title="Previous gathering"
                    >
                      <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                      <span className="text-sm text-gray-600">Previous</span>
                    </button>
                    
                    <div className="text-sm font-medium text-gray-700 px-4">
                      {selectedDate ? new Date(selectedDate).toLocaleDateString('en-US', {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                      }) : 'Select Date'}
                    </div>
                    
                    <button
                      onClick={navigateToNextDate}
                      disabled={!canNavigateNext}
                      className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-gray-50 hover:bg-gray-100 disabled:bg-gray-25 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                      title="Next gathering"
                    >
                      <span className="text-sm text-gray-600">Next</span>
                      <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-medium text-gray-900">
                    Attendance List - {selectedGathering.name}
                  </h3>
              <div className="flex items-center space-x-2">
                {/* Connection Status Indicator */}
                <div
                  className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getConnectionStatusStyle().containerClass}`}
                  title={getConnectionStatusStyle().tooltip}
                >
                  <div className={`w-2 h-2 rounded-full mr-1.5 ${getConnectionStatusStyle().dotClass}`}></div>
                  {getConnectionStatusStyle().label}
                </div>

                {/* Active Users Indicator */}
                <ActiveUsersIndicator activeUsers={[]} />
              </div>
            </div>

            {isLoading ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
                <p className="mt-2 text-gray-500">Loading attendance list...</p>
              </div>
            ) : attendanceList.length === 0 ? (
              <div className="text-center py-8">
                <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">No attendees</h3>
                <p className="mt-1 text-sm text-gray-500">
                  No regular attendees found for this gathering type.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredGroupedAttendees.map((group: any) => (
                  <div key={group.family_id || group.members[0].id} className={groupByFamily ? "border border-gray-200 rounded-lg p-4" : ""}>
                    {groupByFamily && group.familyName && (
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="text-md font-medium text-gray-900">
                          {(() => {
                            // Convert surname to uppercase: "SURNAME, firstname and firstname"
                            const parts = group.familyName.split(', ');
                            if (parts.length >= 2) {
                              return `${parts[0].toUpperCase()}, ${parts.slice(1).join(', ')}`;
                            }
                            return group.familyName;
                          })()}
                        </h4>
                        <button
                          onClick={() => toggleAllFamily(group.family_id)}
                          disabled={isAttendanceLocked}
                          className={`inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                            isAttendanceLocked 
                              ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
                              : 'bg-primary-50 text-primary-700 hover:bg-primary-100 border border-primary-200 hover:border-primary-300'
                          }`}
                        >
                          {(() => {
                            const familyMembers = attendanceList.filter(person => person.familyId === group.family_id);
                            const presentCount = familyMembers.filter(person => (presentById[person.id] ?? person.present)).length;
                            return presentCount > 0 ? 'Uncheck all family' : 'Check all family';
                          })()}
                        </button>
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-3 gap-y-6">
                      {group.members.map((person: Individual) => {
                        // Use presentById first (like visitor system), fallback to person.present
                        const isPresent = presentById[person.id] !== undefined ? presentById[person.id] : Boolean(person.present);
                        const isSaving = Boolean(savingById[person.id] || person.isSaving);
                        const displayName = getPersonDisplayName(person, group.familyName);
                        const needsWideLayout = shouldUseWideLayout(displayName);
                        const badgeInfo = !badgeSettingsLoading ? getBadgeInfo(person) : null;

                        return (
                          <label
                            key={person.id}
                            className={`relative flex items-center cursor-pointer transition-colors ${
                              groupByFamily
                                ? `p-3 rounded-md border-2 ${
                                    isPresent
                                      ? 'border-primary-500 bg-primary-50'
                                      : 'border-gray-200 hover:border-gray-300'
                                  } ${isSaving ? 'opacity-75' : ''}`
                                : `p-2 rounded-md ${
                                    isPresent
                                      ? 'bg-primary-50'
                                      : 'hover:bg-gray-50'
                                  } ${isSaving ? 'opacity-75' : ''}`
                            } ${needsWideLayout ? 'col-span-2' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={Boolean(isPresent)}
                              onChange={() => toggleAttendance(person.id)}
                              className="sr-only"
                              disabled={isSaving || isAttendanceLocked}
                            />
                            <div className={`flex-shrink-0 h-5 w-5 rounded border-2 flex items-center justify-center ${
                              isPresent ? 'bg-primary-600 border-primary-600' : 'border-gray-300'
                            } ${isSaving ? 'animate-pulse' : ''}`}>
                              {isPresent && (
                                <CheckIcon className="h-3 w-3 text-white" />
                              )}
                            </div>
                            <span className="ml-3 text-sm font-medium text-gray-900">
                              {displayName}
                              {isSaving && (
                                <span className="ml-2 text-xs text-gray-500">Saving...</span>
                              )}
                            </span>

                            {/* Floating Badge at Top Right */}
                            {badgeInfo && (
                              <span
                                className={`flex-shrink-0 ml-auto sm:absolute sm:right-3 sm:top-0 sm:-translate-y-1/2 flex items-center space-x-1 shadow-sm ${
                                  badgeInfo.text ? 'px-2 py-1 rounded-full' : 'w-6 h-6 justify-center rounded-full'
                                }`}
                                style={badgeInfo.styles}
                              >
                                {badgeInfo.icon && (
                                  <BadgeIcon type={badgeInfo.icon as BadgeIconType} className="w-4 h-4 flex-shrink-0" />
                                )}
                                {badgeInfo.text && (
                                  <span className="text-xs font-medium whitespace-nowrap">{badgeInfo.text}</span>
                                )}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
          )}
        </>
      )}



      {/* Recent Visitors Section - Only for Standard Gatherings */}
      {selectedGathering?.attendanceType === 'standard' && filteredGroupedVisitors.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              Recent Visitors
            </h3>
            <div className="space-y-4">
              {filteredGroupedVisitors.map((group: any) => (
                <div 
                  key={group.groupKey || `visitor-group-${group.members[0]?.id || 'unknown'}`} 
                  className={groupByFamily && group.familyName ? "border border-gray-200 rounded-lg p-4" : ""}
                >
                  {groupByFamily && group.familyName && (
                    <div className="flex justify-between items-center mb-3">
                      <div className="flex items-center space-x-3">
                        <h4 className="text-md font-medium text-gray-900">
                          {(() => {
                            // Convert surname to uppercase: "SURNAME, firstname and firstname"
                            const parts = group.familyName.split(', ');
                            if (parts.length >= 2) {
                              return `${parts[0].toUpperCase()}, ${parts.slice(1).join(', ')}`;
                            }
                            return group.familyName;
                          })()}
                        </h4>
                        {group.members[0].visitorType !== 'regular' && (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            group.members[0].visitorType === 'potential_regular' 
                              ? 'bg-green-100 text-green-800' 
                              : 'bg-gray-100 text-gray-800'
                          }`}>
                            {group.members[0].visitorType === 'potential_regular' ? 'Local' : 'Traveller'}
                          </span>
                        )}
                                                                                        {(user?.role === 'admin' || user?.role === 'coordinator') && (
                                    <button
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleEditVisitor(group.members[0]);
                                      }}
                                      className="p-1 text-blue-400 hover:text-blue-600 transition-colors"
                                      title="Edit visitor details"
                                    >
                                      <PencilIcon className="h-4 w-4" />
                                    </button>
                                )}

                      </div>
                      <div className="flex items-center space-x-3">
                        {group.members.length > 1 && (
                          <button
                            onClick={() => toggleAllVisitorFamily(group.members[0].visitorFamilyGroup || group.members[0].id)}
                            disabled={isAttendanceLocked}
                            className={`inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                              isAttendanceLocked 
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
                                : 'bg-primary-50 text-primary-700 hover:bg-primary-100 border border-primary-200 hover:border-primary-300'
                            }`}
                          >
                            {(() => {
                              const familyVisitors = group.members;
                              const presentCount = familyVisitors.filter((visitor: any) => {
                                return visitor.id && visitorAttendance[visitor.id];
                              }).length;
                              return presentCount > 0 ? 'Uncheck all family' : 'Check all family';
                            })()}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-3 gap-y-6">
                    {group.members.map((person: any, index: number) => {
                      const parts = person.name.trim().split(' ');
                      const firstName = parts[0];
                      const lastName = parts.slice(1).join(' ');
                      const cleanName = (lastName === 'Unknown' || !lastName) ? firstName : person.name;
                      const isPresent = person.id ? visitorAttendance[person.id] || false : false;
                      const displayName = getPersonDisplayName(person, group.familyName);
                      const needsWideLayout = shouldUseWideLayout(displayName);
                      const badgeInfo = !badgeSettingsLoading ? getBadgeInfo(person) : null;

                      const isHighlighted = shouldHighlightVisitor(person, index);

                      return (
                        <label
                          key={person.id || `visitor_${index}`}
                          className={`relative flex items-center cursor-pointer transition-colors ${
                            groupByFamily && group.familyName
                              ? `p-3 rounded-md border-2 ${
                                  isPresent
                                    ? 'border-primary-500 bg-primary-50'
                                    : isHighlighted
                                    ? 'border-blue-400 bg-blue-50 shadow-md'
                                    : 'border-gray-200 hover:border-gray-300'
                                }`
                              : `p-2 rounded-md ${
                                  isPresent
                                    ? 'bg-primary-50'
                                    : isHighlighted
                                    ? 'bg-blue-50 border border-blue-300 shadow-sm'
                                    : 'hover:bg-gray-50'
                                }`
                          } ${needsWideLayout ? 'col-span-2' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(isPresent)}
                            onChange={() => person.id && toggleVisitorAttendance(person.id)}
                            className="sr-only"
                            disabled={isAttendanceLocked}
                          />
                          <div className={`flex-shrink-0 h-5 w-5 rounded border-2 flex items-center justify-center ${
                            isPresent ? 'bg-primary-600 border-primary-600' : 'border-gray-300'
                          }`}>
                            {isPresent && (
                              <CheckIcon className="h-3 w-3 text-white" />
                            )}
                          </div>
                          <div className="ml-3 flex-1 min-w-0">
                            <span className="text-sm font-medium text-gray-900">
                              {displayName}
                            </span>
                            {/* Show visitor type and edit for groups without header */}
                            {(!groupByFamily || !group.familyName) && (
                              <div className="flex items-center space-x-2 mt-1">
                                {person.visitorType !== 'regular' && (
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                    person.visitorType === 'potential_regular'
                                      ? 'bg-green-100 text-green-800'
                                      : 'bg-gray-100 text-gray-800'
                                  }`}>
                                    {person.visitorType === 'potential_regular' ? 'Local' : 'Traveller'}
                                  </span>
                                )}
                                {(user?.role === 'admin' || user?.role === 'coordinator') && (
                                    <button
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleEditVisitor(person, index);
                                      }}
                                      className="p-0.5 text-blue-400 hover:text-blue-600 transition-colors"
                                      title="Edit visitor details"
                                    >
                                      <PencilIcon className="h-3 w-3" />
                                    </button>
                                )}

                              </div>
                            )}
                          </div>

                          {/* Floating Badge at Top Right */}
                          {badgeInfo && (
                            <span
                              className={`flex-shrink-0 ml-auto sm:absolute sm:right-3 sm:top-0 sm:-translate-y-1/2 flex items-center space-x-1 shadow-sm ${
                                badgeInfo.text ? 'px-2 py-1 rounded-full' : 'w-6 h-6 justify-center rounded-full'
                              }`}
                              style={badgeInfo.styles}
                            >
                              {badgeInfo.icon && (
                                <BadgeIcon type={badgeInfo.icon as BadgeIconType} className="w-4 h-4" />
                              )}
                              {badgeInfo.text && (
                                <span className="text-xs font-medium whitespace-nowrap">{badgeInfo.text}</span>
                              )}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* All People (people not currently visible in this gathering) - Only show for standard gatherings */}
      {selectedGathering?.attendanceType === 'standard' && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium text-gray-900">All People</h3>
              <button
                type="button"
                onClick={() => setShowAllVisitorsSection(v => !v)}
                className="text-sm font-medium text-primary-600 hover:text-primary-700"
              >
                {showAllVisitorsSection ? 'Hide' : 'Show'}
              </button>
            </div>
            {showAllVisitorsSection && (
              <div className="mt-4">
                {isLoadingAllVisitors ? (
                  <div className="text-center py-6 text-gray-500">Loading church people…</div>
                ) : groupedAllChurchVisitors.length === 0 ? (
                  <div className="text-sm text-gray-500">No additional people available to add.</div>
                ) : (
                  <div className="space-y-4">
                    {groupedAllChurchVisitors.map((group: any) => (
                      <div key={group.groupKey} className={groupByFamily && group.familyName ? 'border border-gray-200 rounded-lg p-4' : ''}>
                        {groupByFamily && group.familyName && (
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center space-x-3">
                              <h4 className="text-md font-medium text-gray-900">
                                {(() => {
                                  const parts = group.familyName.split(', ');
                                  if (parts.length >= 2) { return `${parts[0].toUpperCase()}, ${parts.slice(1).join(', ')}`; }
                                  return group.familyName;
                                })()}
                              </h4>
                              {group.members[0]?.visitorType !== 'regular' && (
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${group.members[0]?.visitorType === 'potential_regular' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                                  {group.members[0]?.visitorType === 'potential_regular' ? 'Local' : 'Traveller'}
                                </span>
                              )}
                            </div>
                            {group.familyId && (
                              <button
                                type="button"
                                disabled={isAttendanceLocked}
                                onClick={() => addVisitorFamilyFromAll(group.familyId)}
                                className={`text-sm ${isAttendanceLocked ? 'text-gray-300 cursor-not-allowed' : 'text-primary-600 hover:text-primary-700'}`}
                              >
                                Add family to this service
                              </button>
                            )}
                          </div>
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-3 gap-y-6">
                          {group.members.map((person: any, idx: number) => {
                            const parts = person.name.trim().split(' ');
                            const firstName = parts[0];
                            const lastName = parts.slice(1).join(' ');
                            const cleanName = (lastName === 'Unknown' || !lastName) ? firstName : person.name;
                            const displayName = getPersonDisplayName(person, group.familyName);
                            const needsWideLayout = shouldUseWideLayout(displayName);
                            const badgeInfo = !badgeSettingsLoading ? getBadgeInfo(person) : null;

                            return (
                              <div
                                key={person.id || `all_${idx}`}
                                onClick={() => !isAttendanceLocked && person.id && addIndividualFromAll(person.id, displayName)}
                                className={`relative p-3 rounded-md ${groupByFamily && group.familyName ? 'border-2' : 'border'} ${
                                  isAttendanceLocked
                                    ? 'border-gray-200 cursor-not-allowed opacity-50'
                                    : 'border-gray-200 hover:border-primary-400 hover:bg-primary-50 cursor-pointer transition-all'
                                } ${needsWideLayout ? 'col-span-2' : ''}`}
                                title={isAttendanceLocked ? 'Editing locked' : `Click to add ${displayName} to this service`}
                              >
                                <div className="flex items-center justify-between">
                                  <div className="text-sm font-medium text-gray-900">
                                    {displayName}
                                  </div>
                                  <PlusIcon className={`h-4 w-4 flex-shrink-0 ${isAttendanceLocked ? 'text-gray-300' : 'text-primary-500'}`} />
                                </div>

                                {/* Floating Badge at Top Right */}
                                {badgeInfo && (
                                  <span
                                    className={`flex-shrink-0 ml-auto sm:absolute sm:right-3 sm:top-0 sm:-translate-y-1/2 flex items-center space-x-1 shadow-sm ${
                                      badgeInfo.text ? 'px-2 py-1 rounded-full' : 'w-6 h-6 justify-center rounded-full'
                                    }`}
                                    style={badgeInfo.styles}
                                  >
                                    {badgeInfo.icon && (
                                      <BadgeIcon type={badgeInfo.icon as BadgeIconType} className="w-4 h-4" />
                                    )}
                                    {badgeInfo.text && (
                                      <span className="text-xs font-medium whitespace-nowrap">{badgeInfo.text}</span>
                                    )}
                                  </span>
                                )}
                                {!groupByFamily && group.familyId && (
                                  <div className="mt-2 pt-2 border-t border-gray-200">
                                    <button
                                      type="button"
                                      disabled={isAttendanceLocked}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        addVisitorFamilyFromAll(group.familyId);
                                      }}
                                      className={`text-xs ${isAttendanceLocked ? 'text-gray-300 cursor-not-allowed' : 'text-primary-600 hover:text-primary-700'}`}
                                    >
                                      Add entire family instead
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}



      {/* Floating Add Visitor Button - Only for Standard Gatherings */}
      {selectedGathering?.attendanceType === 'standard' && (
        <button
          onClick={handleAddVisitor}
          disabled={isAttendanceLocked}
          className={`fixed bottom-6 right-6 w-14 h-14 ${isAttendanceLocked ? 'bg-gray-300 cursor-not-allowed' : 'bg-primary-600 hover:bg-primary-700'} text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-50`}
        >
          <PlusIcon className="h-6 w-6" />
        </button>
      )}

            {/* Add Visitor Modal - Only for Standard Gatherings */}
      {selectedGathering?.attendanceType === 'standard' && showAddVisitorModal && createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  {getAddModalTitle()}
                </h3>
                <button
                  disabled={isSubmittingVisitor}
                  onClick={() => {
                    setShowAddVisitorModal(false);
                    setIsEditingVisitor(false);
                    setEditingVisitorData(null);
                    setError('');
                  }}
                  className="text-gray-400 hover:text-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <form onSubmit={(e) => { e.preventDefault(); handleSubmitVisitor(); }} className="space-y-4">
                {/* Person Type Selection */}
                {(user?.role === 'admin' || user?.role === 'coordinator') && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Person Type
                    </label>
                    <div className="flex space-x-4">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="personType"
                          value="local_visitor"
                          checked={visitorForm.personType === 'local_visitor'}
                          onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'local_visitor' | 'traveller_visitor' })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Local Visitor</span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="personType"
                          value="traveller_visitor"
                          checked={visitorForm.personType === 'traveller_visitor'}
                          onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'local_visitor' | 'traveller_visitor' })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Traveller Visitor</span>
                      </label>
                    </div>
                  </div>
                )}

                {/* Persons List */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Family Members (up to 10)
                    </label>
                  </div>
                  {visitorForm.persons.map((person, index) => (
                    <div key={index} className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${index > 0 ? 'mt-4 pt-4 border-t border-gray-200' : ''}`}>
                      <div>
                        <label htmlFor={`personFirstName-${index}`} className="block text-sm font-medium text-gray-700">
                          First Name {index + 1}
                        </label>
                        <input
                          id={`personFirstName-${index}`}
                          type="text"
                          value={person.firstName}
                          onChange={(e) => updatePerson(index, { firstName: e.target.value })}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                          placeholder="First name"
                          required
                        />
                        {/* Child checkbox - directly below first name */}
                        <div className="flex items-center mt-1">
                          <input
                            id={`inlineVisitorIsChild-${index}`}
                            type="checkbox"
                            checked={person.isChild || false}
                            onChange={(e) => updatePerson(index, { isChild: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <label htmlFor={`inlineVisitorIsChild-${index}`} className="ml-2 block text-sm text-gray-900">
                            Child
                          </label>
                        </div>
                      </div>
                      <div className="relative">
                        <label htmlFor={`personLastName-${index}`} className="block text-sm font-medium text-gray-700">
                          Last Name {index + 1}
                        </label>
                        <input
                          id={`personLastName-${index}`}
                          type="text"
                          value={person.lastName}
                          onChange={(e) => updatePerson(index, { lastName: e.target.value })}
                          disabled={index > 0 && person.fillLastNameFromAbove}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                          placeholder="Last name (optional)"
                        />
                        {/* For person 2+: Fill from above checkbox */}
                        {index > 0 && (
                          <div className="flex items-center mt-1">
                            <input
                              id={`personFillLastName-${index}`}
                              type="checkbox"
                              checked={person.fillLastNameFromAbove}
                              onChange={(e) => updatePerson(index, { fillLastNameFromAbove: e.target.checked })}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                            />
                            <label htmlFor={`personFillLastName-${index}`} className="ml-2 block text-sm text-gray-900">
                              Fill from above
                            </label>
                          </div>
                        )}
                        {index > 0 && (
                          <button
                            type="button"
                            onClick={() => removePerson(index)}
                            className="absolute top-0 right-0 text-sm text-red-600 hover:text-red-700"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Add Another Person button */}
                          {visitorForm.persons.length < 10 && (
                  <div>
                            <button
                              type="button"
                              onClick={addPerson}
                              className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-primary-700 bg-primary-100 hover:bg-primary-200"
                            >
                              <PlusIcon className="h-4 w-4 mr-2" />
                              Add Another Person
                            </button>
                        </div>
                      )}


                {/* Notes field - only for visitors */}
                {(visitorForm.personType === 'local_visitor' || visitorForm.personType === 'traveller_visitor') && (
                  <div>
                    <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
                      Notes
                    </label>
                    <textarea
                      id="notes"
                      value={visitorForm.notes}
                      onChange={(e) => setVisitorForm({ ...visitorForm, notes: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      placeholder="Any additional notes (optional)"
                      rows={3}
                    />
                  </div>
                )}

                {/* Family Name Display/Edit */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Family Name
                  </label>
                  {isEditingVisitor ? (
                    <>
                      <input
                        type="text"
                        value={visitorForm.familyName}
                        onChange={(e) => setVisitorForm({ ...visitorForm, familyName: e.target.value })}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="Family name"
                      />
                      <p className="mt-1 text-sm text-gray-500">
                        Edit the family name if needed, or leave as is.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="mt-1 p-3 bg-gray-50 border border-gray-200 rounded-md">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-gray-900 font-medium">
                            {computedVisitorFamilyName || 'Enter family member names above'}
                          </span>
                          {computedVisitorFamilyName && (
                            <span className="text-xs text-green-600 bg-green-100 px-2 py-1 rounded">
                              Auto-generated
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 text-sm text-gray-500">
                        Family name is automatically generated from the member names above.
                      </p>
                    </>
                  )}
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    disabled={isSubmittingVisitor}
                    onClick={() => {
                      setShowAddVisitorModal(false);
                      setIsEditingVisitor(false);
                      setEditingVisitorData(null);
                      setError('');
                    }}
                    className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmittingVisitor}
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmittingVisitor ? (
                      <span className="flex items-center">
                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Saving...
                      </span>
                    ) : (
                      getAddButtonText()
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>,
        document.body
      )}


      {/* Reorder Modal */}
      {showReorderModal && createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]" onClick={closeReorderModal}>
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-2/3 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">Edit gathering order</h3>
                <button onClick={closeReorderModal} className="text-gray-400 hover:text-gray-600">
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-4">Drag to reorder. The top gathering becomes your default across the app, including reports.</p>
              <div className="space-y-2">
                {reorderList.map((g, index) => (
                  <div
                    key={g.id}
                    draggable
                    onDragStart={() => onReorderDragStart(index)}
                    onDragOver={onReorderDragOver}
                    onDrop={() => onReorderDrop(index)}
                    className="flex items-center justify-between px-3 py-2 border rounded-md bg-white hover:bg-gray-50 cursor-move"
                    title="Drag to move"
                  >
                    <div className="flex items-center space-x-3">
                      <span className="text-sm text-gray-500 w-6 text-center">{index + 1}</span>
                      <span className="text-sm font-medium text-gray-900">{g.name}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      {index === 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-primary-100 text-primary-700">Default</span>
                      )}
                      {index > 0 && (
                        <button
                          type="button"
                          onClick={() => moveItemUp(index)}
                          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Move up"
                        >
                          <ChevronUpIcon className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={closeReorderModal}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveReorder}
                  className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                >
                  Save order
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}



    </div>
  );
};

export default AttendancePage;