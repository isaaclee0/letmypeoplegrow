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
import { useAttendanceWebSocketConnection } from '../hooks/useAttendanceWebSocketConnection';
import { userPreferences } from '../services/userPreferences';
import HeadcountAttendanceInterface from '../components/HeadcountAttendanceInterface';
import logger from '../utils/logger';
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

interface PersonForm {
  firstName: string;
  lastName: string;
  lastNameUnknown: boolean;
  fillLastNameFromAbove: boolean;
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
  // Initialize selectedDate from cache if available, otherwise use today
  const [selectedDate, setSelectedDate] = useState(() => {
    try {
      const cachedData = localStorage.getItem('attendance_cached_data');
      if (cachedData) {
        const parsed = JSON.parse(cachedData);
        const cacheAge = Date.now() - (parsed.timestamp || 0);
        const isStale = cacheAge > 120000; // 2 minutes - more conservative for PWA reliability
        
        if (!isStale && parsed.date && parsed.attendanceList?.length > 0) {
          logger.log('📅 Initializing selectedDate from cache:', parsed.date);
          return parsed.date;
        }
      }
    } catch (err) {
      console.error('Failed to initialize date from cache:', err);
    }
    
    logger.log('📅 Initializing selectedDate to today:', format(new Date(), 'yyyy-MM-dd'));
    return format(new Date(), 'yyyy-MM-dd');
  });
  const [selectedGathering, setSelectedGathering] = useState<GatheringType | null>(null);
  const [gatherings, setGatherings] = useState<GatheringType[]>([]);
  const [attendanceList, setAttendanceList] = useState<Individual[]>([]);
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [headcountValue, setHeadcountValue] = useState<number>(0);
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
        to: { date: selectedDate, gathering: selectedGathering?.id },
        currentPresentByIdKeys: Object.keys(presentById).length
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
  }, [selectedDate, selectedGathering?.id, presentById]); // Include presentById to ensure we have current keys for logging

  // Load cached data immediately on component mount for better UX during navigation
  useEffect(() => {
    logger.log('🔍 AttendancePage mounted - checking for cached data...');
    
    // Debug: List all localStorage keys
    logger.log('🔑 All localStorage keys:', Object.keys(localStorage));
    logger.log('📋 LocalStorage content:');
    for (const key of Object.keys(localStorage)) {
      if (key.includes('attendance') || key.includes('gathering')) {
        logger.log(`  ${key}:`, localStorage.getItem(key)?.substring(0, 100) + '...');
      }
    }
    
    const cachedData = localStorage.getItem('attendance_cached_data');
    
    if (!cachedData) {
      logger.log('❌ No cached attendance data found in localStorage');
      return;
    }
    
    try {
      const parsed = JSON.parse(cachedData);
      const cacheAge = Date.now() - (parsed.timestamp || 0);
      const isStale = cacheAge > 120000; // 2 minutes - more conservative for PWA reliability
      
      logger.log('📦 Found cached data:', {
        gatheringId: parsed.gatheringId,
        date: parsed.date,
        attendees: parsed.attendanceList?.length || 0,
        visitors: parsed.visitors?.length || 0,
        cacheAge: Math.round(cacheAge / 1000) + 's',
        isStale,
        hasAttendanceList: !!parsed.attendanceList?.length
      });
      
      if (!isStale && parsed.attendanceList?.length > 0) {
        logger.log('🚀 Loading cached data immediately on navigation');
        
        // Load cached attendance data immediately
        setAttendanceList(parsed.attendanceList || []);
        setVisitors(parsed.visitors || []);
        
                      // Initialize presentById from cached data directly (like visitors)
              const cachedPresentById = syncPresentByIdWithAttendanceList(parsed.attendanceList || []);
              
              // Apply any pending offline changes to cached data
              const currentPendingChanges = JSON.parse(localStorage.getItem('attendance_offline_changes') || '[]');
              currentPendingChanges.forEach((change: any) => {
                if (change.gatheringId === parsed.gatheringId && change.date === parsed.date) {
                  cachedPresentById[change.individualId] = change.present;
                }
              });
              
              // Use cached data directly to prevent cross-date contamination
              setPresentById(cachedPresentById);
              presentByIdRef.current = cachedPresentById;
        
        // Update visitor attendance state from cached data
        const newVisitorAttendance: { [key: number]: boolean } = {};
        (parsed.visitors || []).forEach((visitor: any) => {
          if (visitor.id) {
            newVisitorAttendance[visitor.id] = Boolean(visitor.present);
          }
        });
        setVisitorAttendance(newVisitorAttendance);
        
        logger.log('✅ Cached data loaded successfully');
        logger.log('📊 Cache load summary:', {
          attendanceListLength: parsed.attendanceList?.length || 0,
          visitorsLength: parsed.visitors?.length || 0,
          presentByIdKeys: Object.keys(cachedPresentById).length,
          samplePresentById: Object.fromEntries(Object.entries(cachedPresentById).slice(0, 5))
        });
        
        // Mark that we have loaded cached data to prevent immediate clearing
        sessionStorage.setItem('attendance_cache_loaded', 'true');
      } else if (isStale) {
        logger.log('⏰ Cache is stale, will load fresh data');
      } else if (!parsed.attendanceList?.length) {
        logger.log('📭 Cache exists but no attendance data');
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
  const findNearestDate = (dates: string[]) => {
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
  };

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
  const { 
    socket,
    isConnected: isWebSocketConnected, 
    connectionStatus, 
    sendAttendanceUpdate,
    sendHeadcountUpdate,
    loadAttendanceData: loadAttendanceDataWebSocket
  } = useAttendanceWebSocketConnection();
  const webSocketMode = useMemo(() => getWebSocketMode(), []);
  const useWebSocketForUpdates = webSocketMode.enabled;

  // Add connection debugging
  useEffect(() => {
    logger.log('🔌 WebSocket Connection Status:', {
      isConnected: isWebSocketConnected,
      connectionStatus,
      webSocketMode,
      useWebSocketForUpdates
    });
  }, [isWebSocketConnected, connectionStatus, webSocketMode, useWebSocketForUpdates]);

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
    personType: 'local_visitor', // 'local_visitor' or 'traveller_visitor'
    notes: '',
    persons: [{
      firstName: '',
      lastName: '',
      lastNameUnknown: false,
      fillLastNameFromAbove: false
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

  // Calculate valid dates for the selected gathering
  const validDates = useMemo(() => {
    if (!selectedGathering) return [];

    // Handle custom schedule for headcount gatherings
    if (selectedGathering.attendanceType === 'headcount' && selectedGathering.customSchedule) {
      const customSchedule = selectedGathering.customSchedule;
      const dates: string[] = [];

      if (customSchedule.type === 'one_off') {
        // One-off event - just return the start date
        dates.push(customSchedule.startDate);
      } else if (customSchedule.type === 'recurring' && customSchedule.pattern) {
        const pattern = customSchedule.pattern;
        const startDate = parseISO(customSchedule.startDate);
        const endDate = customSchedule.endDate ? parseISO(customSchedule.endDate) : addWeeks(new Date(), 4);
        
        if (pattern.frequency === 'daily') {
          // Daily frequency
          if (pattern.customDates && pattern.customDates.length > 0) {
            // Use specific custom dates
            dates.push(...pattern.customDates);
          } else {
            // Generate daily dates from start to end
            let currentDate = startDate;
            while (isBefore(currentDate, endDate)) {
              dates.push(format(currentDate, 'yyyy-MM-dd'));
              currentDate = addDays(currentDate, pattern.interval || 1);
            }
          }
        } else if (pattern.frequency === 'weekly') {
          // Weekly frequency
          const dayMap: { [key: string]: number } = {
            'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
            'Thursday': 4, 'Friday': 5, 'Saturday': 6
          };
          
          if (pattern.daysOfWeek && pattern.daysOfWeek.length > 0) {
            // Use specific days of week
            const targetDays = pattern.daysOfWeek.map(day => dayMap[day]).filter(day => day !== undefined);
            
            let currentDate = startDate;
            while (isBefore(currentDate, endDate)) {
              const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
              
              for (const targetDay of targetDays) {
                const eventDate = addDays(weekStart, targetDay);
                if (isBefore(eventDate, endDate) && !isBefore(eventDate, startDate)) {
                  dates.push(format(eventDate, 'yyyy-MM-dd'));
                }
              }
              
              currentDate = addWeeks(currentDate, pattern.interval || 1);
            }
          }
        } else if (pattern.frequency === 'biweekly') {
          // Biweekly frequency
          const dayMap: { [key: string]: number } = {
            'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
            'Thursday': 4, 'Friday': 5, 'Saturday': 6
          };
          
          if (pattern.daysOfWeek && pattern.daysOfWeek.length > 0) {
            const targetDays = pattern.daysOfWeek.map(day => dayMap[day]).filter(day => day !== undefined);
            
            let currentDate = startDate;
            let weekCount = 0;
            while (isBefore(currentDate, endDate)) {
              if (weekCount % 2 === 0) { // Every other week
                const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
                
                for (const targetDay of targetDays) {
                  const eventDate = addDays(weekStart, targetDay);
                  if (isBefore(eventDate, endDate) && !isBefore(eventDate, startDate)) {
                    dates.push(format(eventDate, 'yyyy-MM-dd'));
                  }
                }
              }
              
              currentDate = addWeeks(currentDate, 1);
              weekCount++;
            }
          }
        } else if (pattern.frequency === 'monthly') {
          // Monthly frequency
          if (pattern.dayOfMonth) {
            let currentDate = startDate;
            while (isBefore(currentDate, endDate)) {
              const eventDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), pattern.dayOfMonth);
              if (isBefore(eventDate, endDate) && !isBefore(eventDate, startDate)) {
                dates.push(format(eventDate, 'yyyy-MM-dd'));
              }
              currentDate = addWeeks(currentDate, 4); // Move to next month
            }
          }
        }
      }

      return dates.sort((a, b) => b.localeCompare(a)); // Sort newest first
    }

    // Handle standard gatherings with dayOfWeek
    // Skip if this is a headcount gathering (should have been handled above)
    if (selectedGathering.attendanceType === 'headcount') {
      return [];
    }

    const dayMap: { [key: string]: number } = {
      'Sunday': 0,
      'Monday': 1,
      'Tuesday': 2,
      'Wednesday': 3,
      'Thursday': 4,
      'Friday': 5,
      'Saturday': 6
    };

    const targetDay = dayMap[selectedGathering.dayOfWeek];
    if (targetDay === undefined || selectedGathering.dayOfWeek === null) return [];

    const dates: string[] = [];
    const today = startOfDay(new Date());
    // Extended range for better testing and historical data entry:
    // - Past: 6 months back for historical attendance entry
    // - Future: 4 weeks ahead for testing upcoming meetings
    const startDate = addWeeks(today, -26); // Start 26 weeks ago (6 months)
    const endDate = addWeeks(today, 4); // End 4 weeks from now

    let currentDate = startOfWeek(startDate, { weekStartsOn: 0 }); // Start from Sunday
    currentDate = addDays(currentDate, targetDay);

    while (isBefore(currentDate, endDate)) {
      // Include all dates within the range for maximum flexibility:
      // - Historical data entry (past dates)
      // - Current attendance (today)  
      // - Testing and preparation (future dates)
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      
      // Apply frequency filtering
      let shouldInclude = true;
        if (selectedGathering.frequency === 'biweekly') {
          // For biweekly, only include every other occurrence
          const weekDiff = Math.floor((currentDate.getTime() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
          shouldInclude = weekDiff % 2 === 0;
        } else if (selectedGathering.frequency === 'monthly') {
          // For monthly, only include the first occurrence of the month
          const firstOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
          let firstTargetDay = addDays(startOfWeek(firstOfMonth, { weekStartsOn: 0 }), targetDay);
          
          // If the first target day is in the previous month, move to the next week
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

    return dates.sort((a, b) => b.localeCompare(a)); // Sort newest first
  }, [selectedGathering]);

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
  useEffect(() => {
    const refreshUserDataOnMount = async () => {
      try {
        logger.log('🔄 Refreshing user data on attendance page mount to get latest gathering assignments');
        await refreshUserData();
      } catch (error) {
        logger.warn('Failed to refresh user data on mount:', error);
      }
    };
    
    refreshUserDataOnMount();
  }, []); // Run only on mount

  // Load gatherings when user data is available
  useEffect(() => {
    const loadGatherings = async () => {
      if (!user) return; // Wait for user data to be available
      
      try {
        const response = await gatheringsAPI.getAll();
        // Admin users see all gatherings, other users only see their assigned gatherings
        const userGatherings = user?.role === 'admin' 
          ? response.data.gatherings 
          : response.data.gatherings.filter((g: GatheringType) => 
              user?.gatheringAssignments?.some((assignment: GatheringType) => assignment.id === g.id)
            );
        setGatherings(userGatherings);
        
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
            logger.log('🔍 Looking for last viewed gathering:', lastViewed.gatheringId);
            gatheringToSelect = userGatherings.find((g: GatheringType) => g.id === lastViewed.gatheringId) || null;
            if (gatheringToSelect) {
              logger.log('✅ Found last viewed gathering:', gatheringToSelect.name);
            } else {
              logger.log('❌ Last viewed gathering not found in current gatherings');
            }
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
          
          logger.log('🎯 Final gathering selection:', {
            gatheringToSelect: gatheringToSelect?.name || 'none',
            finalGatheringToSelect: finalGatheringToSelect?.name || 'none',
            orderedFirst: ordered[0]?.name || 'none',
            userGatheringsFirst: userGatherings[0]?.name || 'none'
          });
          
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
      } catch (err) {
        setError('Failed to load gatherings');
      }
    };

    loadGatherings();
  }, [user]); // Re-run when user data changes (including gathering assignments)

  // Set date when gathering changes (use cached, last viewed, or nearest date)
  useEffect(() => {
    const setDateForGathering = async () => {
      if (validDates.length > 0) {
        let dateToSelect = null;
        let shouldUpdate = false;
        
        logger.log('📅 Setting date for gathering:', selectedGathering?.name, 'with valid dates:', validDates);
        
        // First, check if we have cached data for this gathering (within 24 hours)
        const cachedData = localStorage.getItem('attendance_cached_data');
        if (cachedData && selectedGathering) {
          try {
            const parsed = JSON.parse(cachedData);
            const cacheAge = Date.now() - (parsed.timestamp || 0);
            const isWithin24Hours = cacheAge < 24 * 60 * 60 * 1000; // 24 hours
            
            if (isWithin24Hours && parsed.gatheringId === selectedGathering.id && validDates.includes(parsed.date)) {
              logger.log('📅 Using date from cache for gathering change (within 24 hours):', {
                gatheringId: parsed.gatheringId,
                date: parsed.date,
                ageHours: Math.round(cacheAge / (60 * 60 * 1000))
              });
              dateToSelect = parsed.date;
              shouldUpdate = true;
            }
          } catch (err) {
            console.error('Failed to parse cached data for date selection:', err);
          }
        }
        
        // If no cached data within 24 hours, check for last viewed date for this gathering
        if (!shouldUpdate && selectedGathering) {
          try {
            // Check user preferences for last viewed date for this specific gathering
            const lastViewedDate = await userPreferences.getLastViewedDateForGathering(selectedGathering.id);
            
            if (lastViewedDate && validDates.includes(lastViewedDate)) {
              logger.log('📅 Using last viewed date for gathering:', {
                gatheringId: selectedGathering.id,
                date: lastViewedDate
              });
              dateToSelect = lastViewedDate;
              shouldUpdate = true;
            }
          } catch (err) {
            console.error('Failed to get last viewed date for gathering:', err);
          }
        }
        
        // If still no date selected, fall back to most recent date
        if (!shouldUpdate) {
          // Sort dates in descending order (most recent first)
          const sortedDates = [...validDates].sort((a, b) => b.localeCompare(a));
          const mostRecentDate = sortedDates[0];
          
          logger.log('📅 No last viewed date found, using most recent date for gathering:', mostRecentDate);
          dateToSelect = mostRecentDate;
          shouldUpdate = true;
        }
      
        if (shouldUpdate && dateToSelect) {
          setSelectedDate(dateToSelect);
        }
      }
    };
    
    setDateForGathering();
  }, [validDates, selectedGathering]);

  // Add request deduplication and cancellation
  const loadAttendanceDataRef = useRef<AbortController | null>(null);
  const currentRequestKey = useRef<string | null>(null);

  const loadAttendanceData = useCallback(async () => {
    if (!selectedGathering) return;

    const requestKey = `${selectedGathering.id}-${selectedDate}`;
    
    // Prevent duplicate requests
    if (currentRequestKey.current === requestKey) {
      logger.log(`⏭️ Skipping duplicate request for ${requestKey}`);
      return;
    }

    // Cancel previous request if it exists
    if (loadAttendanceDataRef.current) {
      logger.log(`❌ Cancelling previous request for ${currentRequestKey.current}`);
      loadAttendanceDataRef.current.abort();
    }

    // Create new AbortController for this request
    const abortController = new AbortController();
    loadAttendanceDataRef.current = abortController;
    currentRequestKey.current = requestKey;

    logger.log(`🔄 Loading attendance data for gathering ${selectedGathering.id} on ${selectedDate}`);
    setIsLoading(true);
    
    // Store current data in case we need to preserve it on error
    const currentAttendanceList = attendanceListRef.current;
    const currentVisitors = visitorsRef.current;
    
    try {
      let response;
      
      // Try WebSocket first if connected, fall back to REST API
      if (isWebSocketConnected) {
        try {
          logger.log(`📡 Loading via WebSocket for gathering ${selectedGathering.id} on ${selectedDate}`);
          response = await loadAttendanceDataWebSocket(selectedGathering.id, selectedDate);
          logger.log(`📊 Received fresh attendance data via WebSocket:`, {
            attendeeCount: response.attendanceList?.length || 0,
            visitorCount: response.visitors?.length || 0,
            gatheringId: selectedGathering.id,
            date: selectedDate,
            timestamp: new Date().toISOString()
          });
        } catch (wsError) {
          logger.warn(`⚠️ WebSocket failed, falling back to REST API:`, wsError);
          throw wsError; // Re-throw to trigger REST API fallback
        }
      } else {
        throw new Error('WebSocket not connected, using REST API');
      }
      
      setAttendanceList(response.attendanceList || []);
      setVisitors(response.visitors || []);
      
      // Initialize presentById from server data directly (like visitors)
      const serverPresentById = syncPresentByIdWithAttendanceList(response.attendanceList || []);
      
      // Apply any pending offline changes for this exact gathering/date
      const currentPendingChanges = JSON.parse(localStorage.getItem('attendance_offline_changes') || '[]');
      currentPendingChanges.forEach((change: any) => {
        if (change.gatheringId === selectedGathering.id && change.date === selectedDate) {
          serverPresentById[change.individualId] = change.present;
        }
      });
      
      logger.log('🔄 Setting presentById from server data:', {
        serverKeys: Object.keys(serverPresentById).length,
        sampleData: Object.fromEntries(Object.entries(serverPresentById).slice(0, 5)),
        gatheringId: selectedGathering.id,
        date: selectedDate
      });
      
      // Use server data directly to prevent cross-date contamination
      setPresentById(serverPresentById);
      presentByIdRef.current = serverPresentById;
      
        // Cache the attendance data for offline use with server state applied
        const attendanceListForCache = (response.attendanceList || []).map((person: any) => {
          // Use the server present state which includes pending changes
          const finalPresent = serverPresentById[person.id] ?? person.present;
          return { ...person, present: finalPresent };
        });
      
      const cacheData = {
        gatheringId: selectedGathering.id,
        date: selectedDate,
        attendanceList: attendanceListForCache,
        visitors: response.visitors || [],
        timestamp: Date.now(),
        hasPendingChanges: pendingChanges.some(change => 
          change.gatheringId === selectedGathering.id && change.date === selectedDate
        )
      };
      localStorage.setItem('attendance_cached_data', JSON.stringify(cacheData));
      logger.log('💾 Cached attendance data for offline use:', {
        gatheringId: selectedGathering.id,
        date: selectedDate,
        attendees: attendanceListForCache.length,
        visitors: response.visitors?.length || 0,
        hasPendingChanges: cacheData.hasPendingChanges
      });
      
      // Update visitor attendance state from server data
      // WebSocket handles real-time changes, so we can use server data directly
      const newVisitorAttendance: { [key: number]: boolean } = {};
      (response.visitors || []).forEach((visitor: any) => {
        if (visitor.id) {
          newVisitorAttendance[visitor.id] = Boolean(visitor.present);
        }
      });
      logger.log(`👥 Setting visitor attendance:`, newVisitorAttendance);
      setVisitorAttendance(newVisitorAttendance);
      
    } catch (err) {
      // Don't process if request was cancelled
      if (err instanceof Error && err.name === 'AbortError') {
        logger.log(`🚫 WebSocket request cancelled for ${requestKey}`);
        return;
      }
      
      // Fall back to REST API if WebSocket failed or not connected
      try {
        logger.log(`📡 Falling back to REST API for gathering ${selectedGathering.id} on ${selectedDate}`);
        
        // Check if request was cancelled before making API call
        if (abortController.signal.aborted) {
          logger.log(`❌ Request cancelled before API call for ${requestKey}`);
          return;
        }
        
        const apiResponse = await attendanceAPI.get(selectedGathering.id, selectedDate);
        
        // Check if request was cancelled after API call
        if (abortController.signal.aborted) {
          logger.log(`❌ Request cancelled after API call for ${requestKey}`);
          return;
        }
        
        logger.log(`📊 Received attendance data via REST API:`, {
          attendeeCount: apiResponse.data.attendanceList?.length || 0,
          visitorCount: apiResponse.data.visitors?.length || 0,
          gatheringId: selectedGathering.id,
          date: selectedDate,
          timestamp: new Date().toISOString()
        });
        
        setAttendanceList(apiResponse.data.attendanceList || []);
        setVisitors(apiResponse.data.visitors || []);
        
        // Initialize presentById from server data directly (API fallback)
        const serverPresentById = syncPresentByIdWithAttendanceList(apiResponse.data.attendanceList || []);
        
        // Apply any pending offline changes for this exact gathering/date
        const currentPendingChanges = JSON.parse(localStorage.getItem('attendance_offline_changes') || '[]');
        currentPendingChanges.forEach((change: any) => {
          if (change.gatheringId === selectedGathering.id && change.date === selectedDate) {
            serverPresentById[change.individualId] = change.present;
          }
        });
        
        logger.log('📝 Setting presentById from API data:', {
          serverKeys: Object.keys(serverPresentById).length,
          gatheringId: selectedGathering.id,
          date: selectedDate
        });
        
        setPresentById(serverPresentById);
        presentByIdRef.current = serverPresentById;
        
        // Cache the attendance data for offline use with server state applied
        const attendanceListForCache = (apiResponse.data.attendanceList || []).map((person: any) => {
          // Use the server present state which includes pending changes
          const finalPresent = serverPresentById[person.id] ?? person.present;
          return { ...person, present: finalPresent };
        });
        
        const cacheData = {
          gatheringId: selectedGathering.id,
          date: selectedDate,
          attendanceList: attendanceListForCache,
          visitors: apiResponse.data.visitors || [],
          timestamp: Date.now(),
          hasPendingChanges: pendingChanges.some(change => 
            change.gatheringId === selectedGathering.id && change.date === selectedDate
          )
        };
        localStorage.setItem('attendance_cached_data', JSON.stringify(cacheData));
        
        // Update visitor attendance state from server data
        const newVisitorAttendance: { [key: number]: boolean } = {};
        (apiResponse.data.visitors || []).forEach((visitor: any) => {
          if (visitor.id) {
            newVisitorAttendance[visitor.id] = Boolean(visitor.present);
          }
        });
        setVisitorAttendance(newVisitorAttendance);
        
        // Clear any previous error since REST API worked
        setError('');
        
      } catch (apiError) {
        // Don't show error if request was cancelled
        if (apiError instanceof Error && apiError.name === 'AbortError') {
          logger.log(`🚫 API request cancelled for ${requestKey}`);
          return;
        }
        
        console.error(`❌ Both WebSocket and REST API failed for gathering ${selectedGathering.id} on ${selectedDate}:`, { 
          originalError: err, 
          apiError 
        });
        setError('Failed to load attendance data - using cached data');
        
        // Preserve existing data instead of clearing it on connection failure
        if (currentAttendanceList.length > 0 || currentVisitors.length > 0) {
          logger.log('📱 Preserving existing attendance data due to connection failure');
          setAttendanceList(currentAttendanceList);
          setVisitors(currentVisitors);
        }
      }
    } finally {
      // Clear request tracking if this is still the current request
      if (currentRequestKey.current === requestKey) {
        loadAttendanceDataRef.current = null;
        currentRequestKey.current = null;
      }
      setIsLoading(false);
    }
  }, [selectedGathering, selectedDate, isWebSocketConnected, loadAttendanceDataWebSocket, showToast]);

  // Manual refresh function removed - automatic syncing handles refreshes now

  // Handle gathering changes with fresh data loading
  const handleGatheringChange = useCallback((gathering: GatheringType) => {
    logger.log(`🏛️ Switching to gathering: ${gathering.name} (ID: ${gathering.id})`);
    
    // Clear user modification timestamps when switching gatherings
    // This ensures we get fresh server data instead of preserving stale local changes
    lastUserModificationRef.current = {};
    
    // Clear attendance state to prevent cross-gathering contamination
    setPresentById({});
    presentByIdRef.current = {};
    
    // Set the new gathering first - this will trigger loadAttendanceData via useEffect
    setSelectedGathering(gathering);
    
    // Reset headcount value after setting the new gathering to prevent race conditions
    setHeadcountValue(0);
  }, []);

  // Load attendance data when date or gathering changes
  useEffect(() => {
    const loadData = async () => {
      if (selectedGathering && selectedDate) {
      logger.log('📅 Main data loading effect triggered:', {
        gatheringId: selectedGathering.id,
        gatheringName: selectedGathering.name,
        date: selectedDate
      });
      
      // Critical: Clear presentById state when switching dates to prevent cross-date contamination
      // The presentById state should be date-specific, not persist across date changes
      
      // Check if we're loading a different date/gathering than what's currently in state
      const cachedData = localStorage.getItem('attendance_cached_data');
      let currentContextKey = `${selectedGathering.id}-${selectedDate}`;
      let cachedContextKey = null;
      
      if (cachedData) {
        try {
          const parsed = JSON.parse(cachedData);
          cachedContextKey = `${parsed.gatheringId}-${parsed.date}`;
        } catch (err) {
          console.error('Failed to parse cached data for context key:', err);
        }
      }
      
      // Always clear state when switching to a different date/gathering combination
      // This ensures presentById doesn't carry over from previous dates
      const contextChanged = !cachedContextKey || cachedContextKey !== currentContextKey;
      
      logger.log('🔄 [CONTEXT] Checking context change:', {
        cachedContextKey,
        currentContextKey,
        contextChanged,
        selectedGathering: selectedGathering?.id,
        selectedDate
      });
      
      // Reset headcount value when context changes
      if (contextChanged) {
        logger.log('🔄 [CONTEXT] Context changed, resetting headcount value');
        setHeadcountValue(0);
      }
      
      if (contextChanged) {
        logger.log('🧹 Clearing state for date/gathering change:', {
          previous: cachedContextKey,
          current: currentContextKey,
          clearing: 'presentById, attendanceList, visitors, visitorAttendance'
        });
        
        // Clear all state to prevent cross-date contamination
        setAttendanceList([]);
        setVisitors([]);
        setPresentById({});
        presentByIdRef.current = {};
        setVisitorAttendance({});
      } else {
        logger.log('📋 Same date/gathering context, preserving state for potential merging:', currentContextKey);
      }
      
      // First try to load cached data immediately (for faster UX)
      if (cachedData) {
        try {
          const parsed = JSON.parse(cachedData);
          if (parsed.gatheringId === selectedGathering.id && parsed.date === selectedDate) {
            // Check if cache is fresh (less than 5 minutes old) to avoid showing stale data
            const cacheAge = Date.now() - (parsed.timestamp || 0);
            const isStale = cacheAge > 120000; // 2 minutes - more conservative for PWA reliability
            
            logger.log('📱 Loading cached attendance data:', {
              attendees: parsed.attendanceList?.length || 0,
              visitors: parsed.visitors?.length || 0,
              cacheAge: Math.round(cacheAge / 1000) + 's',
              isStale
            });
            
            if (!isStale) {
              setAttendanceList(parsed.attendanceList || []);
              setVisitors(parsed.visitors || []);
              
              // Initialize presentById from cached data directly (no merge)
              const cachedPresentById = syncPresentByIdWithAttendanceList(parsed.attendanceList || []);
              
              // Apply any pending offline changes to cached data
              const currentPendingChanges = JSON.parse(localStorage.getItem('attendance_offline_changes') || '[]');
              currentPendingChanges.forEach((change: any) => {
                if (change.gatheringId === selectedGathering.id && change.date === selectedDate) {
                  cachedPresentById[change.individualId] = change.present;
                }
              });
              
              // Use cached data directly to prevent cross-date contamination
              setPresentById(cachedPresentById);
              presentByIdRef.current = cachedPresentById;
            } else {
              logger.log('🗑️ Cache is stale, skipping cached data and fetching fresh');
            }
          }
        } catch (err) {
          console.error('Failed to parse cached attendance data:', err);
        }
      }
      
      // Always load fresh data on page load to ensure accuracy
      // Cache is only used for immediate UX while fresh data loads
      logger.log('🔄 Loading fresh attendance data (cache used for immediate UX only)');
      
      if (isWebSocketConnected) {
        logger.log('🔌 WebSocket connected - loading fresh data via WebSocket');
      } else {
        logger.log('📡 WebSocket not connected - loading fresh data via REST API');
      }
      
      loadAttendanceData();
      
      // Load the last used group by family setting for this gathering
      const lastSetting = localStorage.getItem(`gathering_${selectedGathering.id}_groupByFamily`);
      if (lastSetting !== null) {
        setGroupByFamily(lastSetting === 'true');
      } else {
        setGroupByFamily(true); // Default to true
      }
      
      // Save as last viewed (both general and gathering-specific)
      await saveLastViewed(selectedGathering.id, selectedDate);
      }
    };
    
    loadData();
  }, [selectedGathering, selectedDate, isWebSocketConnected, loadAttendanceData]); // Removed pendingChanges dependency

  // WebSocket real-time updates handle all data synchronization now
  // No need for visibility-based refreshes that cause issues on mobile PWA

  // Load recent visitors when gathering changes
  useEffect(() => {
    const loadRecentVisitors = async () => {
      if (!selectedGathering) return;
      
      try {
        const response = await attendanceAPI.getRecentVisitors(selectedGathering.id);
        setRecentVisitors(response.data.visitors || []);
        setAllRecentVisitorsPool(response.data.visitors || []);
      } catch (err) {
        console.error('Failed to load recent visitors:', err);
      }
    };

    loadRecentVisitors();
  }, [selectedGathering]);

  // Load church-wide people once (or when user context changes significantly)
  useEffect(() => {
    const loadAllChurchPeople = async () => {
      try {
        setIsLoadingAllVisitors(true);
        const response = await attendanceAPI.getAllPeople();
        setAllChurchVisitors(response.data.visitors || []); // Keep using same state var for compatibility
      } catch (err) {
        console.error('Failed to load all church people:', err);
      } finally {
        setIsLoadingAllVisitors(false);
      }
    };
    loadAllChurchPeople();
  }, []);

  // Combine current visitors with gathering-specific recent visitors from last 6 weeks
  useEffect(() => {
    if (!selectedGathering) return;

    const loadAllVisitors = async () => {
      try {
        // Get current visitors for this date
        const currentResponse = await attendanceAPI.get(selectedGathering.id, selectedDate);
        const currentVisitors = currentResponse.data.visitors || [];

        // Use already loaded gathering-specific recent visitors pool if available; otherwise fetch once
        let gatheringRecentVisitors = allRecentVisitorsPool;
        if (!gatheringRecentVisitors || gatheringRecentVisitors.length === 0) {
          const recentResponse = await attendanceAPI.getRecentVisitors(selectedGathering.id);
          gatheringRecentVisitors = recentResponse.data.visitors || [];
          setAllRecentVisitorsPool(gatheringRecentVisitors);
        }

        // Server now handles service-based filtering, so we use all visitors it returns
        // The filtering is done on the server side using the configured service limits
        const filteredGatheringRecentVisitors = gatheringRecentVisitors || [];

        // Combine current visitors with gathering-specific recent visitors, avoiding duplicates
        const currentVisitorIds = new Set(currentVisitors.map((v: Visitor) => v.id));
        const combinedVisitors = [
          ...currentVisitors,
          ...filteredGatheringRecentVisitors.filter((v: Visitor) => !currentVisitorIds.has(v.id))
        ];

        setAllVisitors(combinedVisitors);
        
        // Initialize visitor attendance state from server 'present' flags
        const presentVisitorIds = new Set((currentVisitors || []).filter((cv: any) => cv.present).map((cv: any) => cv.id));
        const initialVisitorAttendance: { [key: number]: boolean } = {};
        combinedVisitors.forEach((visitor: Visitor) => {
          if (visitor.id) {
            initialVisitorAttendance[visitor.id] = presentVisitorIds.has(visitor.id);
          }
        });
        setVisitorAttendance(initialVisitorAttendance);
      } catch (err) {
        console.error('Failed to load all visitors:', err);
      }
    };

    loadAllVisitors();
  }, [selectedGathering, selectedDate, allRecentVisitorsPool]);

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
      await loadAttendanceData();
      
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
    
    if (!webSocketMode.enabled) {
      logger.log('📡 Using REST API (WebSocket disabled)');
      // WebSocket disabled - use API directly
      await attendanceAPI.record(gatheringId, date, {
        attendanceRecords: records,
        visitors: []
      });
      return;
    }

    // Check if WebSocket is available and connected
    const shouldUseWebSocket = isWebSocketConnected && connectionStatus === 'connected';
    
    if (!shouldUseWebSocket && webSocketMode.fallbackAllowed) {
      logger.log('📡 WebSocket not available, using REST API fallback');
      await attendanceAPI.record(gatheringId, date, {
        attendanceRecords: records,
        visitors: []
      });
      return;
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
      await sendAttendanceUpdate(gatheringId, date, records);
      logger.log(`🔌 [${isPWA ? 'PWA' : 'Browser'}] Successfully sent attendance via WebSocket`);
    } catch (wsError) {
      if (webSocketMode.fallbackAllowed) {
        logger.warn(`⚠️ WebSocket failed, falling back to API:`, wsError);
        await attendanceAPI.record(gatheringId, date, {
          attendanceRecords: records,
          visitors: []
        });
        logger.log(`✅ Successfully saved attendance via API fallback`);
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
        
        await sendAttendanceChange(selectedGathering.id, selectedDate, [
          { individualId, present: newPresent }
        ]);
        
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

  // Handle all WebSocket events directly (no room management needed)
  useEffect(() => {
    if (!isWebSocketConnected || !selectedGathering || !selectedDate) {
      return;
    }

    const handleAttendanceUpdated = (data: any) => {
      // Only process updates for the current gathering and date
      if (data.gatheringId === selectedGathering.id && data.date === selectedDate) {
        logger.log('🔌 [WEBSOCKET] Received attendance update:', data);
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
          
          // Update presentById state to match attendanceList (similar to visitor system)
          setPresentById(prev => {
            const updated = { ...prev };
            data.records.forEach((record: any) => {
              updated[record.individualId] = record.present;
            });
            return updated;
          });
          
          // Clear pending changes for these records
          setPendingChanges(prev => {
            const filtered = prev.filter(pendingChange => {
              const hasMatchingRecord = data.records.some((record: any) =>
                record.individualId === pendingChange.individualId
              );
              return !hasMatchingRecord;
            });
            return filtered;
          });
        }
      }
    };

    const handleHeadcountUpdated = (data: any) => {
      // Only process updates for the current gathering and date
      if (data.gatheringId === selectedGathering.id && data.date === selectedDate) {
        logger.log('🔌 [WEBSOCKET] Received headcount update:', {
          data,
          currentGathering: selectedGathering.id,
          currentDate: selectedDate,
          headcountValue
        });
        // The HeadcountAttendanceInterface will handle the update
      } else {
        logger.log('🔌 [WEBSOCKET] Ignored headcount update (wrong context):', {
          received: { gatheringId: data.gatheringId, date: data.date },
          expected: { gatheringId: selectedGathering.id, date: selectedDate }
        });
      }
    };

    const handleVisitorUpdated = (data: any) => {
      // Only process updates for the current gathering and date
      if (data.gatheringId === selectedGathering.id && data.date === selectedDate) {
        logger.log('🔌 [WEBSOCKET] Received visitor update:', data);
        // Handle visitor updates
        if (data.visitors) {
          setVisitors(data.visitors);
        }
      }
    };

    // Listen for all WebSocket events
    socket?.on('attendance_updated', handleAttendanceUpdated);
    socket?.on('headcount_updated', handleHeadcountUpdated);
    socket?.on('visitor_updated', handleVisitorUpdated);

    return () => {
      socket?.off('attendance_updated', handleAttendanceUpdated);
      socket?.off('headcount_updated', handleHeadcountUpdated);
      socket?.off('visitor_updated', handleVisitorUpdated);
    };
  }, [socket, isWebSocketConnected, selectedGathering?.id, selectedDate]);

  // WebSocket attendance updates (disabled - using direct socket access instead)
  const attendanceWebSocket = {
    isConnected: isWebSocketConnected,
    isInRoom: false,
    connectionStatus: connectionStatus,
    roomName: null,
    lastUpdate: null,
    userActivity: [], // No active users tracking in simplified WebSocket
    joinRoom: () => {},
    leaveRoom: () => {},
    forceReconnect: () => {}
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
        lastNameUnknown: false,
        fillLastNameFromAbove: false
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

    // Convert visitor data to form format
    const persons = familyGroup.members.map((member: any) => {
      const nameParts = member.name.trim().split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      
      return {
        firstName,
        lastName,
        lastNameUnknown: lastName === 'Unknown' || !lastName,
        fillLastNameFromAbove: false
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
      const newPerson = { 
        firstName: '', 
        lastName: '', 
        lastNameUnknown: false,
        fillLastNameFromAbove: true // Default to checked for subsequent people
      };
      
      // Auto-fill surname from first person if they have one
      if (prev.persons.length > 0) {
        const firstPerson = prev.persons[0];
        if (firstPerson.lastName && !firstPerson.lastNameUnknown) {
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
      
      // Handle last name unknown checkbox
      if (updates.lastNameUnknown !== undefined) {
        newPersons[index].lastName = updates.lastNameUnknown ? '' : newPersons[index].lastName;
        // If setting to unknown, also uncheck fill from above
        if (updates.lastNameUnknown) {
          newPersons[index].fillLastNameFromAbove = false;
        }
      }
      
      // Handle fill from above checkbox
      if (updates.fillLastNameFromAbove !== undefined) {
        if (updates.fillLastNameFromAbove && index > 0) {
          // Fill from first person's last name
          const firstPerson = newPersons[0];
          if (firstPerson.lastName && !firstPerson.lastNameUnknown) {
            newPersons[index].lastName = firstPerson.lastName;
            newPersons[index].lastNameUnknown = false;
          }
        }
        // If unchecking fill from above, don't clear the name (let user decide)
      }
      
      // If updating first person's last name, update all others who have fillLastNameFromAbove checked
      if (index === 0 && updates.lastName !== undefined) {
        for (let i = 1; i < newPersons.length; i++) {
          if (newPersons[i].fillLastNameFromAbove && !newPersons[i].lastNameUnknown) {
            newPersons[i].lastName = updates.lastName;
          }
        }
      }
      
      return { ...prev, persons: newPersons };
    });
  };

  const handleSubmitVisitor = async () => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    if (!selectedGathering) return;
    
    try {
      // Validate form
      for (const person of visitorForm.persons) {
        if (!person.firstName.trim()) {
          setError('First name is required for all persons');
          return;
        }
        if (!person.lastName.trim() && !person.lastNameUnknown) {
          setError('Last name is required for all persons (or check "Unknown")');
          return;
        }
      }

      // Build people array
      const people = visitorForm.persons.map(person => ({
        firstName: person.firstName.trim(),
        lastName: person.lastNameUnknown ? 'Unknown' : person.lastName.trim(),
        firstUnknown: false, // Always false - we accept whatever is entered
        lastUnknown: person.lastNameUnknown,
        isChild: false // No distinction
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

        // Update the individual visitor record directly
        const personType = visitorForm.personType === 'local_visitor' ? 'local_visitor' : 'traveller_visitor';
        
        // For now, update the first person as the representative
        // In a more sophisticated system, we'd update all family members
        const firstPerson = people[0];
        await individualsAPI.update(editingVisitorData.visitorId, {
          firstName: firstPerson.firstName,
          lastName: firstPerson.lastName,
          familyId: editingVisitorData.familyId,
          peopleType: personType
        });

        response = { data: { message: 'Visitor updated successfully', individuals: [{ id: editingVisitorData.visitorId, firstName: firstPerson.firstName, lastName: firstPerson.lastName }] } };
        showSuccess('Visitor updated successfully');
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
      await loadAttendanceData();
      
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
          lastNameUnknown: false,
          fillLastNameFromAbove: false
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
            family_name: person.familyName,
            members: [] as Individual[],
          };
        }
        groups[familyKey].members.push(person);
      } else {
        const individualGroupKey = 'individuals';
        if (!groups[individualGroupKey]) {
          groups[individualGroupKey] = {
            family_id: null,
            family_name: null,
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

    const grouped: { [key: string]: { familyId: number | null; familyName: string | null; members: Visitor[]; isFamily: boolean; groupKey: string } } = {};

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
        grouped[groupKey] = { familyId: computedFamilyId, familyName, members: [], isFamily, groupKey };
      }
      grouped[groupKey].members.push(visitor);
    });
    return Object.values(grouped);
  }, [groupByFamily]);

  // Build displayed visitors groups: if searching, include all recent visitors (even >6 weeks); otherwise only within 6 weeks
  const displayedGroupedVisitors = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    if (search) {
      const poolMap = new Map<number | string, Visitor>();
      allVisitors.forEach(v => { if (v.id) poolMap.set(v.id, v); else poolMap.set(`c_${v.name}`, v); });
      allRecentVisitorsPool.forEach(v => { if (v.id && !poolMap.has(v.id)) poolMap.set(v.id, v); });
      const pool = Array.from(poolMap.values());
      const filtered = pool.filter(v => v.name.toLowerCase().includes(search));
      return groupVisitors(filtered);
    }
    return groupVisitors(allVisitors);
  }, [searchTerm, allVisitors, allRecentVisitorsPool, groupVisitors]);

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
    
    // Get IDs of people already visible in current gathering (attendees + current visitors)
    const currentlyVisibleIds = new Set([
      ...attendanceList.map(person => person.id),
      ...allVisitors.map(visitor => visitor.id)
    ]);
    
    // Filter to show only church people NOT currently visible in this gathering
    const availableChurchPeople = allChurchVisitors.filter(person => 
      !currentlyVisibleIds.has(person.id) && 
      (search === '' || person.name.toLowerCase().includes(search))
    );
    
    return groupVisitors(availableChurchPeople);
  }, [allChurchVisitors, attendanceList, allVisitors, searchTerm, groupVisitors]);

  // Sort members within each group
  filteredGroupedAttendees.forEach((group: any) => {
    group.members.sort((a: Individual, b: Individual) => {
      // Sort by last name, then first name
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
      await loadAttendanceData();
      
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

  // Helper function to count actual number of people in visitor records
  const getVisitorPeopleCount = useMemo(() => {
    // Count only visitors that are marked as present
    return allVisitors.filter((visitor) => {
      return visitor.id && visitorAttendance[visitor.id];
    }).length;
  }, [allVisitors, visitorAttendance]);

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
      lastUnknown: person.lastUnknown
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
      if (familyName) {
        // Extract surname from family name and compare with visitor's name
        const familySurname = familyName.split(',')[0]?.trim().toLowerCase();
        const parts = person.name.trim().split(' ');
        const firstName = parts[0];
        const lastName = parts.slice(1).join(' ');
        
        // Only hide surname if it matches the family surname and is not empty
        if (lastName && lastName.toLowerCase() !== 'unknown' && familySurname === lastName.toLowerCase()) {
          return firstName;
        }
      }
      return person.name;
    }
    
    // For regular attendees with firstName/lastName
    if (familyName && person.lastName) {
      const familySurname = familyName.split(',')[0]?.trim().toLowerCase();
      const personSurname = person.lastName.toLowerCase();
      
      // Only hide surname if it matches the family surname and is not empty/unknown
      if (familySurname && personSurname && familySurname === personSurname && personSurname !== 'unknown') {
        return person.firstName;
      }
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
    logger.log('📱 Loaded offline changes:', validChanges.length);
    
    // Load cached attendance data if available
    const cachedData = localStorage.getItem('attendance_cached_data');
    if (cachedData && selectedGathering?.id && selectedDate) {
      try {
        const parsed = JSON.parse(cachedData);
        logger.log('📱 Checking cached data:', {
          cached: { gatheringId: parsed.gatheringId, date: parsed.date },
          current: { gatheringId: selectedGathering.id, date: selectedDate },
          match: parsed.gatheringId === selectedGathering.id && parsed.date === selectedDate
        });
        
        if (parsed.gatheringId === selectedGathering.id && parsed.date === selectedDate) {
          logger.log('📱 Loading cached attendance data:', {
            attendees: parsed.attendanceList?.length || 0,
            visitors: parsed.visitors?.length || 0
          });
          setAttendanceList(parsed.attendanceList || []);
          setVisitors(parsed.visitors || []);
        }
      } catch (err) {
        console.error('Failed to parse cached attendance data:', err);
      }
    }
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
    <div className="space-y-6 pb-20">
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
                  
                  {/* Edit Tab */}
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
                  
                  {/* Edit Tab */}
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
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">
                  {attendanceList.reduce((acc, p) => acc + ((presentById[p.id] ?? p.present) ? 1 : 0), 0) + getVisitorPeopleCount}
                </div>
                <div className="text-sm text-gray-500">Total Present</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-primary-600">
                  {attendanceList.reduce((acc, p) => acc + ((presentById[p.id] ?? p.present) ? 1 : 0), 0)}
                </div>
                <div className="text-sm text-gray-500">Regular Attendees</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">
                  {getVisitorPeopleCount}
                </div>
                <div className="text-sm text-gray-500">Visitors</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-400">
                  {attendanceList.length - attendanceList.reduce((acc, p) => acc + ((presentById[p.id] ?? p.present) ? 1 : 0), 0)}
                </div>
                <div className="text-sm text-gray-500">Absent</div>
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
                    Headcount - {selectedGathering.name}
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
                
                <HeadcountAttendanceInterface
                  gatheringTypeId={selectedGathering.id}
                  date={selectedDate}
                  gatheringName={selectedGathering.name}
                  onHeadcountChange={setHeadcountValue}
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
                    {groupByFamily && group.family_name && (
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="text-md font-medium text-gray-900">
                          {(() => {
                            // Convert surname to uppercase: "SURNAME, firstname and firstname"
                            const parts = group.family_name.split(', ');
                            if (parts.length >= 2) {
                              return `${parts[0].toUpperCase()}, ${parts.slice(1).join(', ')}`;
                            }
                            return group.family_name;
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                      {group.members.map((person: Individual) => {
                        // Use presentById first (like visitor system), fallback to person.present
                        const isPresent = presentById[person.id] !== undefined ? presentById[person.id] : Boolean(person.present);
                        const isSaving = Boolean(savingById[person.id] || person.isSaving);
                        const displayName = getPersonDisplayName(person, group.familyName);
                        const needsWideLayout = shouldUseWideLayout(displayName);
                        
                        return (
                          <label
                            key={person.id}
                            className={`flex items-center cursor-pointer transition-colors ${
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



      {/* Visitors Section - Only for Standard Gatherings */}
      {selectedGathering?.attendanceType === 'standard' && filteredGroupedVisitors.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              Visitors
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
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          group.members[0].visitorType === 'potential_regular' 
                            ? 'bg-green-100 text-green-800' 
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {group.members[0].visitorType === 'potential_regular' ? 'Local' : 'Traveller'}
                        </span>
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
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                    {group.members.map((person: any, index: number) => {
                      const parts = person.name.trim().split(' ');
                      const firstName = parts[0];
                      const lastName = parts.slice(1).join(' ');
                      const cleanName = (lastName === 'Unknown' || !lastName) ? firstName : person.name;
                      const isPresent = person.id ? visitorAttendance[person.id] || false : false;
                      const displayName = getPersonDisplayName(person, group.familyName);
                      const needsWideLayout = shouldUseWideLayout(displayName);

                      const isHighlighted = shouldHighlightVisitor(person, index);
                      
                      return (
                        <label
                          key={person.id || `visitor_${index}`}
                          className={`flex items-center cursor-pointer transition-colors ${
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
                          <div className="ml-3 flex-1">
                            <span className="text-sm font-medium text-gray-900">
                              {displayName}
                            </span>
                            {/* Show visitor type and edit for groups without header */}
                            {(!groupByFamily || !group.familyName) && (
                              <div className="flex items-center space-x-2 mt-1">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                  person.visitorType === 'potential_regular' 
                                    ? 'bg-green-100 text-green-800' 
                                    : 'bg-gray-100 text-gray-800'
                                }`}>
                                  {person.visitorType === 'potential_regular' ? 'Local' : 'Traveller'}
                                </span>
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

      {/* Add People From Church (people not currently visible in this gathering) - Only show for standard gatherings */}
      {selectedGathering?.attendanceType === 'standard' && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium text-gray-900">Add People From Church</h3>
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
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${group.members[0]?.visitorType === 'potential_regular' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                                {group.members[0]?.visitorType === 'potential_regular' ? 'Local' : 'Traveller'}
                              </span>
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
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                          {group.members.map((person: any, idx: number) => {
                            const parts = person.name.trim().split(' ');
                            const firstName = parts[0];
                            const lastName = parts.slice(1).join(' ');
                            const cleanName = (lastName === 'Unknown' || !lastName) ? firstName : person.name;
                            const displayName = getPersonDisplayName(person, group.familyName);
                            const needsWideLayout = shouldUseWideLayout(displayName);
                            
                            return (
                              <div 
                                key={person.id || `all_${idx}`} 
                                className={`p-2 rounded-md ${groupByFamily && group.familyName ? 'border-2 border-gray-200' : 'border border-gray-200'} ${needsWideLayout ? 'col-span-2' : ''}`}
                              >
                                <div className="text-sm font-medium text-gray-900">{displayName}</div>
                                {!groupByFamily && group.familyId && (
                                  <div className="mt-2">
                                    <button
                                      type="button"
                                      disabled={isAttendanceLocked}
                                      onClick={() => addVisitorFamilyFromAll(group.familyId)}
                                      className={`text-xs ${isAttendanceLocked ? 'text-gray-300 cursor-not-allowed' : 'text-primary-600 hover:text-primary-700'}`}
                                    >
                                      Add family to this service
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
                  onClick={() => {
                    setShowAddVisitorModal(false);
                    setIsEditingVisitor(false);
                    setEditingVisitorData(null);
                    setError('');
                  }}
                  className="text-gray-400 hover:text-gray-600"
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

                {/* Family Name Field */}
                <div>
                  <label htmlFor="familyName" className="block text-sm font-medium text-gray-700">
                    Family Name
                  </label>
                  <input
                    id="familyName"
                    type="text"
                    value={visitorForm.familyName}
                    onChange={(e) => setVisitorForm({ ...visitorForm, familyName: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Leave blank to auto-generate from member names"
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    Optional. If left blank, will be generated from the member names.
                  </p>
                </div>

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
                          disabled={person.lastNameUnknown || (index > 0 && person.fillLastNameFromAbove)}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                          placeholder="Last name"
                        />
                        <div className="flex flex-col space-y-1 mt-1">
                          {/* For person 1 or any person: Unknown checkbox */}
                          <div className="flex items-center">
                            <input
                              id={`personLastNameUnknown-${index}`}
                              type="checkbox"
                              checked={person.lastNameUnknown}
                              onChange={(e) => updatePerson(index, { lastNameUnknown: e.target.checked })}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                            />
                            <label htmlFor={`personLastNameUnknown-${index}`} className="ml-2 block text-sm text-gray-900">
                              Unknown
                            </label>
                          </div>
                          {/* For person 2+: Fill from above checkbox */}
                          {index > 0 && (
                            <div className="flex items-center">
                              <input
                                id={`personFillLastName-${index}`}
                                type="checkbox"
                                checked={person.fillLastNameFromAbove}
                                onChange={(e) => updatePerson(index, { fillLastNameFromAbove: e.target.checked })}
                                disabled={person.lastNameUnknown}
                                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                              />
                              <label htmlFor={`personFillLastName-${index}`} className="ml-2 block text-sm text-gray-900">
                                Fill from above
                              </label>
                            </div>
                          )}
                        </div>
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
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddVisitorModal(false);
                      setIsEditingVisitor(false);
                      setEditingVisitorData(null);
                      setError('');
                    }}
                    className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                  >
                    {getAddButtonText()}
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