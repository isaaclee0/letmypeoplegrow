import React, { useState, useEffect, useMemo, useCallback, useRef, useDeferredValue, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { format, addWeeks, startOfWeek, addDays, isBefore, startOfDay, parseISO } from 'date-fns';
import { useAuth } from '../contexts/AuthContext';
import { gatheringsAPI, attendanceAPI, authAPI, familiesAPI, visitorConfigAPI, GatheringType, Individual, Visitor } from '../services/api';
import AttendanceDatePicker from '../components/AttendanceDatePicker';
import { useToast } from '../components/ToastContainer';
import ActiveUsersIndicator from '../components/ActiveUsersIndicator';
import { generateFamilyName } from '../utils/familyNameUtils';
import { validatePerson, validateMultiplePeople } from '../utils/validationUtils';
import { useAttendanceWebSocket } from '../hooks/useAttendanceWebSocket';
import { useWebSocket } from '../contexts/WebSocketContext';
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
  personType: 'regular' | 'local_visitor' | 'traveller_visitor';
  notes: string;
  persons: PersonForm[];
  autoFillSurname: boolean;
}

const AttendancePage: React.FC = () => {
  const { user, updateUser } = useAuth();
  const { showSuccess } = useToast();
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedGathering, setSelectedGathering] = useState<GatheringType | null>(null);
  const [gatherings, setGatherings] = useState<GatheringType[]>([]);
  const [attendanceList, setAttendanceList] = useState<Individual[]>([]);
  const [visitors, setVisitors] = useState<Visitor[]>([]);
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
  
  // Helper functions for localStorage
  const saveLastViewed = (gatheringId: number, date: string) => {
    const lastViewed = {
      gatheringId,
      date,
      timestamp: Date.now()
    };
    localStorage.setItem('attendance_last_viewed', JSON.stringify(lastViewed));
  };

  // Simple state sync: whenever attendanceList changes, update presentById from server data
  // BUT preserve any recent user modifications (within last 30 seconds)
  useEffect(() => {
    console.log('📋 Syncing presentById with attendanceList', {
      attendanceCount: attendanceList.length,
      gathering: selectedGathering?.id,
      date: selectedDate
    });
    
    const now = Date.now();
    const newPresentById: Record<number, boolean> = {};
    
    attendanceList.forEach((person) => {
      const userModifiedTime = lastUserModificationRef.current[person.id];
      const timeSinceUserModification = userModifiedTime ? now - userModifiedTime : Infinity;
      
      if (timeSinceUserModification <= 30000) {
        // Preserve user's recent changes (within 30 seconds)
        const userValue = presentByIdRef.current[person.id];
        if (userValue !== undefined) {
          newPresentById[person.id] = userValue;
          console.log(`👤 Preserving user change for ${person.firstName} ${person.lastName}: ${userValue}`);
        } else {
          newPresentById[person.id] = Boolean(person.present);
        }
      } else {
        // Use server data for people not recently modified
        newPresentById[person.id] = Boolean(person.present);
      }
    });
    
    console.log('📊 Setting presentById:', newPresentById);
    setPresentById(newPresentById);
    presentByIdRef.current = newPresentById;
  }, [attendanceList, selectedGathering?.id, selectedDate]);

  useEffect(() => {
    presentByIdRef.current = presentById;
  }, [presentById]);
  
  const getLastViewed = () => {
    try {
      const saved = localStorage.getItem('attendance_last_viewed');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Only use if less than 30 days old
        if (Date.now() - parsed.timestamp < 30 * 24 * 60 * 60 * 1000) {
          return { gatheringId: parsed.gatheringId, date: parsed.date };
        }
      }
    } catch (e) {
      console.warn('Failed to parse last viewed data:', e);
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
      console.warn('Failed to save groupByFamily setting to localStorage:', error);
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
  const [showGatheringDropdown, setShowGatheringDropdown] = useState(false);
  const datePickerRef = useRef<HTMLDivElement>(null);
  const [showAddVisitorModal, setShowAddVisitorModal] = useState(false);
  const [showEditVisitorModal, setShowEditVisitorModal] = useState(false);
  const [editingVisitor, setEditingVisitor] = useState<Visitor | null>(null);
  const [lastUserModification, setLastUserModification] = useState<{ [key: number]: number }>({});

  const [visitorAttendance, setVisitorAttendance] = useState<{ [key: number]: boolean }>({});
  
  // WebSocket integration
  const { isConnected: isWebSocketConnected, activeUsers } = useWebSocket();
  const [useWebSocketForUpdates, setUseWebSocketForUpdates] = useState(true); // Forced to true for debugging
  // lastWebSocketUpdate removed - no longer needed for UI display


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
  const POLL_INTERVAL_MS = 10000; // Reduced to 10 seconds for faster updates while still avoiding race conditions

  // Keep refs in sync
  useEffect(() => { attendanceListRef.current = attendanceList; }, [attendanceList]);
  useEffect(() => { visitorsRef.current = visitors; }, [visitors]);
  useEffect(() => { lastUserModificationRef.current = lastUserModification; }, [lastUserModification]);

  const [visitorForm, setVisitorForm] = useState<VisitorFormState>({
    personType: 'local_visitor', // 'regular', 'local_visitor', or 'traveller_visitor'
    notes: '',
    persons: [{
      firstName: '',
      lastName: '',
      lastNameUnknown: false,
      fillLastNameFromAbove: false
    }],
    autoFillSurname: false
  });

  // Handle click outside to close date picker and gathering dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (datePickerRef.current && !datePickerRef.current.contains(event.target as Node)) {
        setShowDatePicker(false);
      }
      // Close gathering dropdown when clicking outside
      const target = event.target as Element;
      if (!target.closest('[data-gathering-dropdown]')) {
        setShowGatheringDropdown(false);
      }
    };

    if (showDatePicker || showGatheringDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDatePicker, showGatheringDropdown]);

  // Calculate valid dates for the selected gathering
  const validDates = useMemo(() => {
    if (!selectedGathering) return [];

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
    if (targetDay === undefined) return [];

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

  // Load gatherings on component mount
  useEffect(() => {
    const loadGatherings = async () => {
      try {
        const response = await gatheringsAPI.getAll();
        const userGatherings = response.data.gatherings.filter((g: GatheringType) => 
          user?.gatheringAssignments?.some((assignment: GatheringType) => assignment.id === g.id)
        );
        setGatherings(userGatherings);
        
        // Set default gathering honoring saved order and default preference
        if (userGatherings.length > 0) {
          const lastViewed = getLastViewed();
          let gatheringToSelect: GatheringType | null = null;

          // Try last viewed first
          if (lastViewed) {
            gatheringToSelect = userGatherings.find((g: GatheringType) => g.id === lastViewed.gatheringId) || null;
          }

          // Apply saved order
          let ordered = userGatherings;
          try {
            const saved = localStorage.getItem(`user_${user?.id}_gathering_order`);
            if (saved) {
              const orderIds: number[] = JSON.parse(saved);
              const idToItem = new Map<number, GatheringType>(userGatherings.map((i: GatheringType) => [i.id, i] as const));
              const temp: GatheringType[] = [];
              orderIds.forEach((id: number) => { const it = idToItem.get(id); if (it) temp.push(it); });
              userGatherings.forEach((i: GatheringType) => { if (!orderIds.includes(i.id)) temp.push(i); });
              ordered = temp;
            }
          } catch {}

          // Saved default id overrides if available
          if (!gatheringToSelect && user?.id) {
            const savedDefaultId = localStorage.getItem(`user_${user.id}_default_gathering_id`);
            if (savedDefaultId) {
              const idNum = parseInt(savedDefaultId, 10);
              gatheringToSelect = ordered.find((g: GatheringType) => g.id === idNum) || userGatherings.find((g: GatheringType) => g.id === idNum) || null;
            }
          }

          setSelectedGathering(gatheringToSelect || ordered[0] || userGatherings[0]);
        }
      } catch (err) {
        setError('Failed to load gatherings');
      }
    };

    loadGatherings();
  }, [user?.gatheringAssignments]);

  // Set date when gathering changes (use last viewed or nearest date)
  useEffect(() => {
    if (validDates.length > 0) {
      const lastViewed = getLastViewed();
      let dateToSelect = findNearestDate(validDates); // Default to nearest date
      
      if (lastViewed && validDates.includes(lastViewed.date)) {
        // Use last viewed date if it's valid for current gathering
        dateToSelect = lastViewed.date;
      }
      
      if (dateToSelect) {
        setSelectedDate(dateToSelect);
      }
    }
  }, [validDates]);

  const loadAttendanceData = useCallback(async () => {
    if (!selectedGathering) return;

    console.log(`🔄 Loading attendance data for gathering ${selectedGathering.id} on ${selectedDate}`);
    setIsLoading(true);
    
    // Store current data in case we need to preserve it on error
    const currentAttendanceList = attendanceListRef.current;
    const currentVisitors = visitorsRef.current;
    
    try {
      const response = await attendanceAPI.get(selectedGathering.id, selectedDate);
      console.log(`📊 Received attendance data:`, {
        attendeeCount: response.data.attendanceList?.length || 0,
        visitorCount: response.data.visitors?.length || 0,
        gatheringId: selectedGathering.id,
        date: selectedDate
      });
      
      setAttendanceList(response.data.attendanceList || []);
      setVisitors(response.data.visitors || []);
      
      // Cache the attendance data for offline use
      const cacheData = {
        gatheringId: selectedGathering.id,
        date: selectedDate,
        attendanceList: response.data.attendanceList || [],
        visitors: response.data.visitors || [],
        timestamp: Date.now()
      };
      localStorage.setItem('attendance_cached_data', JSON.stringify(cacheData));
      console.log('💾 Cached attendance data for offline use:', {
        gatheringId: selectedGathering.id,
        date: selectedDate,
        attendees: response.data.attendanceList?.length || 0,
        visitors: response.data.visitors?.length || 0
      });
      
      // Update visitor attendance state, preserving recent user changes (within 30 seconds)
      const now = Date.now();
      const newVisitorAttendance: { [key: number]: boolean } = {};
      (response.data.visitors || []).forEach((visitor: any) => {
        if (visitor.id) {
          const userModifiedTime = lastUserModificationRef.current[visitor.id];
          const timeSinceUserModification = userModifiedTime ? now - userModifiedTime : Infinity;
          
          if (timeSinceUserModification <= 30000) {
            // Preserve user's recent changes
            const userValue = visitorAttendance[visitor.id];
            if (userValue !== undefined) {
              newVisitorAttendance[visitor.id] = userValue;
              console.log(`👤 Preserving visitor change for ${visitor.name}: ${userValue}`);
            } else {
              newVisitorAttendance[visitor.id] = Boolean(visitor.present);
            }
          } else {
            // Use server data
            newVisitorAttendance[visitor.id] = Boolean(visitor.present);
          }
        }
      });
      console.log(`👥 Setting visitor attendance:`, newVisitorAttendance);
      setVisitorAttendance(newVisitorAttendance);
    } catch (err) {
      console.error(`❌ Failed to load attendance data for gathering ${selectedGathering.id} on ${selectedDate}:`, err);
      setError('Failed to load attendance data - using cached data');
      
      // Preserve existing data instead of clearing it on connection failure
      if (currentAttendanceList.length > 0 || currentVisitors.length > 0) {
        console.log('📱 Preserving existing attendance data due to connection failure');
        setAttendanceList(currentAttendanceList);
        setVisitors(currentVisitors);
      }
    } finally {
      setIsLoading(false);
    }
  }, [selectedGathering, selectedDate]);

  // Manual refresh function removed - automatic syncing handles refreshes now

  // Handle gathering changes with fresh data loading
  const handleGatheringChange = useCallback((gathering: GatheringType) => {
    console.log(`🏛️ Switching to gathering: ${gathering.name} (ID: ${gathering.id})`);
    
    // Clear user modification timestamps when switching gatherings
    // This ensures we get fresh server data instead of preserving stale local changes
    lastUserModificationRef.current = {};
    
    // Set the new gathering - this will trigger loadAttendanceData via useEffect
    setSelectedGathering(gathering);
  }, []);

  // Load attendance data when date or gathering changes
  useEffect(() => {
    if (selectedGathering && selectedDate) {
      // First try to load cached data immediately
      const cachedData = localStorage.getItem('attendance_cached_data');
      if (cachedData) {
        try {
          const parsed = JSON.parse(cachedData);
          if (parsed.gatheringId === selectedGathering.id && parsed.date === selectedDate) {
            console.log('📱 Loading cached data immediately for offline fallback');
            setAttendanceList(parsed.attendanceList || []);
            setVisitors(parsed.visitors || []);
            
            // Also restore visitor attendance state
            const newVisitorAttendance: { [key: number]: boolean } = {};
            (parsed.visitors || []).forEach((visitor: any) => {
              if (visitor.id) {
                newVisitorAttendance[visitor.id] = Boolean(visitor.present);
              }
            });
            setVisitorAttendance(newVisitorAttendance);
          }
        } catch (err) {
          console.error('Failed to parse cached attendance data:', err);
        }
      }
      
      // Then attempt to load fresh data from server
      loadAttendanceData();
      
      // Load the last used group by family setting for this gathering
      const lastSetting = localStorage.getItem(`gathering_${selectedGathering.id}_groupByFamily`);
      if (lastSetting !== null) {
        setGroupByFamily(lastSetting === 'true');
      } else {
        setGroupByFamily(true); // Default to true
      }
      
      // Save as last viewed
      saveLastViewed(selectedGathering.id, selectedDate);
    }
  }, [selectedGathering, selectedDate, loadAttendanceData]);

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
      
      // Reload attendance data
      await loadAttendanceData();
    } catch (err: any) {
      console.error('Failed to add recent visitor:', err);
      setError(err.response?.data?.error || 'Failed to add recent visitor');
    }
  };

  // Simple queue to serialize attendance writes per individual and reduce API thrash
  const pendingWritesRef = useRef<Map<number, Promise<void>>>(new Map());

  const toggleAttendance = async (individualId: number) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    
    const person = attendanceListRef.current.find(p => p.id === individualId);
    console.log(`🔄 Toggling attendance for ${person?.firstName} ${person?.lastName} (ID: ${individualId})`);
    
    const now = Date.now();
    setLastUserModification(prev => ({ ...prev, [individualId]: now }));
    // Compute new present using refs to avoid stale state reads
    const currentPresent = (presentByIdRef.current[individualId] ?? attendanceListRef.current.find(p => p.id === individualId)?.present) ?? false;
    const newPresent = !currentPresent;

    console.log(`📊 Attendance change: ${currentPresent} → ${newPresent} for gathering ${selectedGathering?.id} on ${selectedDate}`);

    setSavingById(prev => ({ ...prev, [individualId]: true }));
    setPresentById(prev => ({ ...prev, [individualId]: newPresent }));

    if (!selectedGathering || !selectedDate) {
      console.error('❌ Missing gathering or date context');
      setSavingById(prev => ({ ...prev, [individualId]: false }));
      return;
    }

    // Check if we're online or offline
    if (!isWebSocketConnected) {
      // Offline mode - save to local storage
      console.log('📱 Offline mode - saving to local storage');
      saveToOfflineStorage({
        individualId,
        present: newPresent,
        gatheringId: selectedGathering.id,
        date: selectedDate
      });
      setSavingById(prev => ({ ...prev, [individualId]: false }));
      return;
    }

    // Online mode - save via API
    const run = async () => {
      try {
        console.log(`💾 Saving attendance record:`, {
          gatheringId: selectedGathering.id,
          date: selectedDate,
          individualId,
          present: newPresent,
          personName: `${person?.firstName} ${person?.lastName}`
        });
        
        await attendanceAPI.record(selectedGathering.id, selectedDate, {
          attendanceRecords: [{ individualId, present: newPresent }],
          visitors: []
        });
        
        console.log(`✅ Successfully saved attendance for ${person?.firstName} ${person?.lastName}`);
        setSavingById(prev => ({ ...prev, [individualId]: false }));
      } catch (err) {
        console.error(`❌ Failed to save attendance change for ${person?.firstName} ${person?.lastName}:`, err);
        setError('Failed to save change');
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
    console.log('=== TOGGLE ALL FAMILY DEBUG ===');
    console.log('Toggling all family attendance for family:', familyId);
    console.log('Total attendance list length:', attendanceList.length);
    
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
    
    console.log('All families in attendance list:', Object.keys(allFamilies).map(familyId => ({
      familyId: parseInt(familyId),
      memberCount: allFamilies[parseInt(familyId)].length,
      members: allFamilies[parseInt(familyId)].map(p => ({ id: p.id, name: `${p.firstName} ${p.lastName}`, present: p.present }))
    })));
    
    // Family operation flags removed - no longer needed without polling
    
    // Get family members from attendance list
    const familyMembers = attendanceList.filter(person => person.familyId === familyId);
    const familyMemberIds = familyMembers.map(person => person.id);
    
    console.log('Family members found:', familyMembers.length);
    console.log('Family member IDs:', familyMemberIds);
    console.log('Family members details:', familyMembers.map(p => ({ id: p.id, name: `${p.firstName} ${p.lastName}`, familyId: p.familyId, present: p.present })));
    
    // Count how many family members are currently present using current state
    // Use presentById state first, fallback to attendanceList.present if not in presentById
    const presentCount = familyMemberIds.filter(id => {
      const presentInState = presentById[id];
      if (presentInState !== undefined) {
        console.log(`Person ${id}: present in state = ${presentInState}`);
        return presentInState;
      }
      // Fallback to attendanceList if not in presentById
      const person = familyMembers.find(p => p.id === id);
      const fallbackPresent = person ? Boolean(person.present) : false;
      console.log(`Person ${id}: fallback present = ${fallbackPresent} (from attendanceList)`);
      return fallbackPresent;
    }).length;
    
    // If any are present, uncheck all. Otherwise, check all
    const shouldCheckAll = presentCount === 0;
    console.log('Family members present:', presentCount, 'Should check all:', shouldCheckAll);
    console.log('Current presentById state:', presentById);
    console.log('=== END TOGGLE ALL FAMILY DEBUG ===');
    
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

      console.log('Sending attendance records to API:', familyAttendanceRecords);

      await attendanceAPI.record(selectedGathering.id, selectedDate, {
        attendanceRecords: familyAttendanceRecords,
        visitors: []
      });

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

  // WebSocket attendance updates
  const attendanceWebSocket = useAttendanceWebSocket({
    gatheringId: selectedGathering?.id || null,
    date: selectedDate,
    enabled: useWebSocketForUpdates && isWebSocketConnected,
    onAttendanceChange: useCallback((records: Array<{ individualId: number; present: boolean }>) => {
      console.log('🔌 [WEBSOCKET] Received attendance update:', records);
      
      // Update presentById based on WebSocket updates, but preserve recent user changes
      const now = Date.now();
      setPresentById(prev => {
        const updated = { ...prev };
        records.forEach((record: { individualId: number; present: boolean }) => {
          const userModifiedTime = lastUserModificationRef.current[record.individualId];
          const timeSinceUserModification = userModifiedTime ? now - userModifiedTime : Infinity;
          
          // Only update if user hasn't made recent changes (within 5 seconds)
          if (timeSinceUserModification > 5000) {
            updated[record.individualId] = record.present;
            console.log(`🔌 [WEBSOCKET] Updated attendance for individual ${record.individualId}: ${record.present}`);
          } else {
            console.log(`🔌 [WEBSOCKET] Preserved user change for individual ${record.individualId} (modified ${timeSinceUserModification}ms ago)`);
          }
        });
        return updated;
      });
      
      // Also update the attendance list to reflect changes
      setAttendanceList(prev => {
        const updated = [...prev];
        records.forEach((record: { individualId: number; present: boolean }) => {
          const userModifiedTime = lastUserModificationRef.current[record.individualId];
          const timeSinceUserModification = userModifiedTime ? now - userModifiedTime : Infinity;
          
          if (timeSinceUserModification > 5000) {
            const index = updated.findIndex(person => person.id === record.individualId);
            if (index !== -1) {
              updated[index] = { ...updated[index], present: record.present };
            }
          }
        });
        return updated;
      });
      
      console.log('🔌 [WEBSOCKET] Updated attendance state immediately:', {
        recordCount: records.length,
        updatedPresentById: records.reduce((acc, record) => ({ ...acc, [record.individualId]: record.present }), {})
      });
    }, []),
    onVisitorChange: useCallback((visitors: Visitor[]) => {
      console.log('🔌 [WEBSOCKET] Received visitor update:', visitors);
      
      // Update visitors state immediately
      setVisitors(visitors);
      
      // Update visitor attendance state immediately
      const newVisitorAttendance: { [key: number]: boolean } = {};
      visitors.forEach((visitor: any) => {
        if (visitor.id) {
          newVisitorAttendance[visitor.id] = Boolean(visitor.present);
        }
      });
      setVisitorAttendance(newVisitorAttendance);
      
      // Cache the updated data
      const cacheData = {
        gatheringId: selectedGathering?.id,
        date: selectedDate,
        attendanceList: attendanceList,
        visitors: visitors,
        timestamp: Date.now()
      };
      localStorage.setItem('attendance_cached_data', JSON.stringify(cacheData));
      
      console.log('🔌 [WEBSOCKET] Updated visitor state immediately:', {
        visitorCount: visitors.length,
        visitorAttendance: newVisitorAttendance
      });
    }, [selectedGathering, selectedDate, attendanceList]),
    onFullRefresh: useCallback((attendanceList: Individual[], visitors: Visitor[]) => {
      console.log('🔌 [WEBSOCKET] Received full refresh');
      // setLastWebSocketUpdate removed - no longer tracking for UI
      setAttendanceList(attendanceList);
      setVisitors(visitors);
      
      // Update visitor attendance state
      const newVisitorAttendance: { [key: number]: boolean } = {};
      visitors.forEach((visitor: any) => {
        if (visitor.id) {
          newVisitorAttendance[visitor.id] = Boolean(visitor.present);
        }
      });
      setVisitorAttendance(newVisitorAttendance);
    }, []),
    onError: useCallback((error: string) => {
      console.error('🔌 [WEBSOCKET] Error:', error);
      setError(`WebSocket error: ${error}`);
      // DEBUGGING: Don't fall back to polling, stay in WebSocket mode
      console.log('🔌 [WEBSOCKET] Error occurred but staying in WebSocket mode for debugging');
    }, [])
  });

  // POLLING DISABLED: Focusing on WebSocket-only implementation for debugging
  useEffect(() => {
    // Always clear any existing polling interval since we're debugging WebSocket only
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    console.log('🔌 [POLLING] DISABLED - Using WebSocket only for debugging');
    
    // Cleanup function
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [selectedGathering, selectedDate]);

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
      autoFillSurname: false
    });
    setShowAddVisitorModal(true);
  };

  const handleEditVisitor = (visitor: Visitor) => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    // Find ALL visitors in the same family group (including the clicked visitor)
    const familyMembers = visitor.visitorFamilyGroup 
      ? visitors.filter(v => v.visitorFamilyGroup === visitor.visitorFamilyGroup)
      : [visitor]; // If no family group, just edit the individual visitor
    
    const personsData = familyMembers.map((member, index) => {
      const parts = member.name.trim().split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      return {
        firstName: firstName === 'Unknown' ? '' : firstName,
        lastName: lastName === 'Unknown' ? '' : lastName,
        lastNameUnknown: lastName === 'Unknown',
        fillLastNameFromAbove: index > 0 // For editing, assume subsequent people should fill from above
      };
    });
    
    setVisitorForm({
      personType: visitor.visitorType === 'potential_regular' ? 'local_visitor' : 'traveller_visitor',
      notes: visitor.notes || '',
      persons: personsData,
      autoFillSurname: false
    });
    setEditingVisitor(visitor);
    setShowEditVisitorModal(true);
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
        firstUnknown: false,
        lastUnknown: person.lastNameUnknown,
        isChild: false // No distinction
      }));

      const notes = visitorForm.notes.trim();

      let response;
      // Choose endpoint based on person type
      if (visitorForm.personType === 'regular') {
        // Add as regular attendee (to People and gathering list)
        response = await attendanceAPI.addRegularAttendee(selectedGathering.id, selectedDate, people);
      } else {
        // NEW APPROACH: Create visitor family in People system and add to service
        // Generate family name from the people
        const familyName = generateFamilyName(convertToUtilityFormat(people)) || 'Visitor Family';
        
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
      }

      // Show success toast
      if (response.data.individuals && response.data.individuals.length > 0) {
        const names = response.data.individuals.map((ind: { firstName: string; lastName: string }) => `${ind.firstName} ${ind.lastName}`).join(', ');
        const personTypeText = visitorForm.personType === 'regular' ? 'Added to regular attendees' : 'Added as visitor family';
        showSuccess(`${personTypeText}: ${names}`);
      } else {
        showSuccess('Added successfully');
      }

      // Reload attendance data
      await loadAttendanceData();
      
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
        autoFillSurname: false
      });
      setShowAddVisitorModal(false);
      setError('');
    } catch (err: any) {
      console.error('Failed to add:', err);
      setError(err.response?.data?.error || 'Failed to add');
    }
  };

  const handleSubmitEditVisitor = async () => {
    if (isAttendanceLocked) { setError('Editing locked for attendance takers for services older than 2 weeks'); return; }
    if (!selectedGathering || !editingVisitor) return;
    
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
        firstUnknown: false,
        lastUnknown: person.lastNameUnknown,
        isChild: false // No distinction
      }));

      const notes = visitorForm.notes.trim();

      // NEW APPROACH: Update visitor family in People system
      // For now, we'll keep the old approach for editing since it's more complex
      // TODO: Implement proper editing of visitor families in People system
      const response = await attendanceAPI.updateVisitor(selectedGathering.id, selectedDate, editingVisitor.id!, {
        people,
        visitorType: visitorForm.personType === 'local_visitor' ? 'potential_regular' : 'temporary_other',
        notes: notes ? notes : undefined
      });

      // Show success toast
      if (response.data.individuals && response.data.individuals.length > 0) {
        const names = response.data.individuals.map((ind: { firstName: string; lastName: string }) => `${ind.firstName} ${ind.lastName}`).join(', ');
        showSuccess(`Updated: ${names}`);
      } else {
        showSuccess('Updated successfully');
      }

      // Reload attendance data
      await loadAttendanceData();
      
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
        autoFillSurname: false
      });
      setShowEditVisitorModal(false);
      setEditingVisitor(null);
      setError('');
    } catch (err: any) {
      console.error('Failed to update:', err);
      setError(err.response?.data?.error || 'Failed to update');
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
      console.log('📱 Offline mode - saving visitor change to local storage');
      saveToOfflineStorage({
        individualId: visitorId,
        present: newPresent,
        gatheringId: selectedGathering.id,
        date: selectedDate
      });
      return;
    }

    // Online mode - save via API
    try {
      await attendanceAPI.record(selectedGathering.id, selectedDate, {
        attendanceRecords: [{ individualId: visitorId, present: newPresent }],
        visitors: []
      });
      // Also update attendanceList present
      setAttendanceList(prev => prev.map(p => p.id === visitorId ? { ...p, present: newPresent } : p));
    } catch (err) {
      console.error('Failed to save visitor attendance change:', err);
      setError('Failed to save change');
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
      console.log('📱 Offline mode - saving visitor family changes to local storage');
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

    // Online mode - save via API
    try {
      await attendanceAPI.record(selectedGathering.id, selectedDate, {
        attendanceRecords: familyVisitorIds.map(id => ({ individualId: id, present: shouldCheckAll })),
        visitors: []
      });
      // Reflect in attendanceList
      setAttendanceList(prev => prev.map(p => familyVisitorIds.includes(p.id) ? { ...p, present: shouldCheckAll } : p));
    } catch (err) {
      console.error('Failed to save visitor family attendance change:', err);
      setError('Failed to save family changes');
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
      await loadAttendanceData();
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
    const totalPeople = visitorForm.persons.length;
    const personType = visitorForm.personType === 'regular' ? 'Person' : 'Visitor';
    
    if (totalPeople === 1) {
      return `Add ${personType}`;
    } else {
      const pluralType = visitorForm.personType === 'regular' ? 'People' : 'Visitors';
      return `Add ${pluralType} (${totalPeople})`;
    }
  };

  // Helper function to get the appropriate button text
  const getAddButtonText = () => {
    const totalPeople = visitorForm.persons.length;
    const personType = visitorForm.personType === 'regular' ? 'Person' : 'Visitor';
    
    if (totalPeople === 1) {
      return `Add ${personType}`;
    } else {
      const pluralType = visitorForm.personType === 'regular' ? 'People' : 'Visitors';
      return `Add ${pluralType}`;
    }
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

  // Helper function to get the appropriate edit button text
  const getEditButtonText = () => {
    const totalPeople = visitorForm.persons.length;
    
    if (totalPeople === 1) {
      return 'Update Visitor';
    } else {
      return 'Update Visitors';
    }
  };

  // Gatherings order management (drag & drop) with localStorage persistence
  const [isReorderMode, setIsReorderMode] = useState(false);
  const [orderedGatherings, setOrderedGatherings] = useState<GatheringType[]>([]);
  const draggingGatheringId = useRef<number | null>(null);
  const [showReorderModal, setShowReorderModal] = useState(false);
  const [reorderList, setReorderList] = useState<GatheringType[]>([]);

  // Offline storage for pending attendance changes
  const [pendingChanges, setPendingChanges] = useState<Array<{
    individualId: number;
    present: boolean;
    timestamp: number;
    gatheringId: number;
    date: string;
  }>>([]);
  
  const [isSyncing, setIsSyncing] = useState(false);
  const dragIndexRef = useRef<number | null>(null);

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
    
    console.log('💾 Saved to offline storage:', newChange);
  }, []);

  const syncOfflineChanges = useCallback(async () => {
    if (!isWebSocketConnected || pendingChanges.length === 0) return;
    
    setIsSyncing(true);
    console.log('🔄 Syncing offline changes:', pendingChanges.length, 'changes');
    
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
        
        console.log(`🔄 Syncing ${changes.length} changes for gathering ${gatheringId} on ${date}:`, changes);
        
        try {
          await attendanceAPI.record(parseInt(gatheringId), date, {
            attendanceRecords: changes,
            visitors: []
          });
          
          console.log(`✅ Successfully synced ${changes.length} changes for gathering ${gatheringId} on ${date}`);
        } catch (apiError) {
          console.error(`❌ Failed to sync changes for gathering ${gatheringId} on ${date}:`, apiError);
          throw apiError; // Re-throw to trigger the outer catch block
        }
      }

      // Clear offline storage only if all syncs succeeded
      localStorage.removeItem('attendance_offline_changes');
      setPendingChanges([]);
      setError(''); // Clear any lingering error messages
      console.log('✅ All offline changes synced successfully');
      
    } catch (error) {
      console.error('❌ Failed to sync offline changes:', error);
      
      // If changes are old (more than 1 hour), clear them instead of retrying
      const now = Date.now();
      const oldChanges = pendingChanges.filter(change => {
        const ageInMinutes = (now - change.timestamp) / (1000 * 60);
        return ageInMinutes > 60; // Changes older than 1 hour
      });
      
      if (oldChanges.length > 0) {
        console.log('🧹 Clearing old failed changes:', oldChanges.length);
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
        console.log('🧹 Clearing invalid date format:', change.date);
        return false;
      }
      
      // Check age (keep changes less than 24 hours old)
      const ageInHours = (now - change.timestamp) / (1000 * 60 * 60);
      if (ageInHours >= 24) {
        console.log('🧹 Clearing old change:', change);
        return false;
      }
      
      return true;
    });
    
    if (validChanges.length !== offlineChanges.length) {
      console.log('🧹 Cleared stale offline changes:', offlineChanges.length - validChanges.length);
      localStorage.setItem('attendance_offline_changes', JSON.stringify(validChanges));
    }
    
    setPendingChanges(validChanges);
    console.log('📱 Loaded offline changes:', validChanges.length);
    
    // Load cached attendance data if available
    const cachedData = localStorage.getItem('attendance_cached_data');
    if (cachedData && selectedGathering?.id && selectedDate) {
      try {
        const parsed = JSON.parse(cachedData);
        console.log('📱 Checking cached data:', {
          cached: { gatheringId: parsed.gatheringId, date: parsed.date },
          current: { gatheringId: selectedGathering.id, date: selectedDate },
          match: parsed.gatheringId === selectedGathering.id && parsed.date === selectedDate
        });
        
        if (parsed.gatheringId === selectedGathering.id && parsed.date === selectedDate) {
          console.log('📱 Loading cached attendance data:', {
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

  const loadSavedOrder = useCallback((items: GatheringType[]) => {
    if (!user?.id) return items;
    try {
      const saved = localStorage.getItem(`user_${user.id}_gathering_order`);
      if (!saved) return items;
      const orderIds: number[] = JSON.parse(saved);
      const idToItem = new Map(items.map(i => [i.id, i]));
      const ordered: GatheringType[] = [];
      orderIds.forEach(id => {
        const item = idToItem.get(id);
        if (item) ordered.push(item);
      });
      items.forEach(i => { if (!orderIds.includes(i.id)) ordered.push(i); });
      return ordered;
    } catch (e) {
      console.warn('Failed to parse saved gathering order', e);
      return items;
    }
  }, [user?.id]);

  useEffect(() => {
    setOrderedGatherings(loadSavedOrder(gatherings));
  }, [gatherings, loadSavedOrder]);

  const saveOrder = useCallback((items: GatheringType[]) => {
    if (!user?.id) return;
    const ids = items.map(i => i.id);
    localStorage.setItem(`user_${user.id}_gathering_order`, JSON.stringify(ids));
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
  
  const saveReorder = () => {
    setOrderedGatherings(reorderList);
    saveOrder(reorderList);
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

      {/* Attendance Summary */}
      {selectedGathering && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            {isAttendanceLocked && (
              <div className="mb-4 rounded-md bg-amber-50 border border-amber-200 p-3 text-amber-800 text-sm">
                Editing is locked for attendance takers for services older than 2 weeks.
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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



      {/* Gathering Type Tabs and Controls */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="border-b border-gray-200 mb-6">
            {/* Mobile: Show first 2 tabs + dropdown (uses saved order) */}
            <div className="block md:hidden">
              <div className="flex items-center space-x-2">
                {/* First 2 tabs */}
                {(orderedGatherings.length ? orderedGatherings : gatherings).slice(0, 2).map((gathering, index) => (
                  <div key={gathering.id} className="flex-1 relative">
                    <button
                      draggable={false}
                      onClick={() => handleGatheringChange(gathering)}
                      className={`w-full whitespace-nowrap py-2 px-3 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                        selectedGathering?.id === gathering.id
                          ? 'bg-primary-500 text-white'
                          : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <div className="flex items-center justify-center">
                        <span className="truncate">{gathering.name}</span>
                      </div>
                    </button>

                  </div>
                ))}
                

                
                {/* Dropdown for additional tabs */}
                {(orderedGatherings.length ? orderedGatherings : gatherings).length > 2 && (
                  <div className="relative" data-gathering-dropdown>
                    <button
                      onClick={() => setShowGatheringDropdown(!showGatheringDropdown)}
                      className="py-2 px-3 font-medium text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-t-lg border border-gray-300"
                    >
                      <EllipsisHorizontalIcon className="h-5 w-5" />
                    </button>
                    
                    {showGatheringDropdown && (
                      <div className="absolute top-full right-0 mt-1 w-48 bg-white rounded-md shadow-lg border border-gray-200 z-50">
                        <div className="py-1">
                          {(orderedGatherings.length ? orderedGatherings : gatherings).slice(2).map((gathering, index) => {
                            const actualIndex = index + 2; // Account for the first 2 tabs
                            return (
                              <div key={gathering.id} className="flex items-center justify-between px-4 py-2 text-sm hover:bg-gray-100">
                                <button
                                  draggable={false}
                                  onClick={() => {
                                    handleGatheringChange(gathering);
                                    setShowGatheringDropdown(false);
                                  }}
                                  className={`text-left flex-1 ${
                                    selectedGathering?.id === gathering.id
                                      ? 'bg-primary-50 text-primary-700 font-medium'
                                      : 'text-gray-700'
                                  }`}
                                >
                                  {gathering.name}
                                </button>

                              </div>
                            );
                          })}
                          <div className="my-1 border-t border-gray-200" />
                          <button
                            onClick={() => { setShowGatheringDropdown(false); openReorderModal(); }}
                            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-2"
                          >
                            <PencilIcon className="h-4 w-4 text-gray-500" />
                            <span>Edit order</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            
            {/* Desktop: Show all tabs; edit button on the right */}
            <nav className="hidden md:flex -mb-px items-center w-full space-x-2" aria-label="Tabs">
              <div className="flex items-center space-x-2 overflow-x-auto">
                {(orderedGatherings.length ? orderedGatherings : gatherings).map((gathering) => (
                  <button
                    key={gathering.id}
                    draggable={false}
                    onClick={() => handleGatheringChange(gathering)}
                    className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                      selectedGathering?.id === gathering.id
                        ? 'bg-primary-500 text-white'
                        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <span>{gathering.name}</span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="ml-auto">
                <button
                  type="button"
                  onClick={openReorderModal}
                  className="py-1 px-2 text-xs rounded border text-gray-500 hover:bg-gray-100"
                  title="Edit order"
                >
                  <PencilIcon className="h-4 w-4" />
                </button>
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

            {/* Search/Filter Bar */}
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

            {/* Group by Family Toggle */}
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
          </div>
        </div>
      </div>

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

      {/* Attendance List */}
      {selectedGathering && validDates.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                Attendance List - {selectedGathering.name}
              </h3>
              <div className="flex items-center space-x-2">
                {/* Connection Status Indicator */}
                <div
                  className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                    isWebSocketConnected 
                      ? 'bg-green-100 text-green-800 border border-green-200' 
                      : 'bg-red-100 text-red-800 border border-red-200'
                  }`}
                  title={
                    isWebSocketConnected 
                      ? pendingChanges.length > 0 
                        ? `Connected - Syncing ${pendingChanges.length} offline changes...`
                        : 'Connected - Real-time updates active'
                      : pendingChanges.length > 0
                        ? `Offline - ${pendingChanges.length} changes saved locally`
                        : 'Offline - Changes will be saved locally'
                  }
                >
                  <div className={`w-2 h-2 rounded-full mr-1.5 ${
                    isWebSocketConnected ? 'bg-green-500' : 'bg-red-500'
                  }`}></div>
                  {isWebSocketConnected 
                    ? pendingChanges.length > 0 
                      ? isSyncing 
                        ? `Syncing ${pendingChanges.length}...`
                        : `${pendingChanges.length} Pending`
                      : 'Connected'
                    : pendingChanges.length > 0
                      ? `${pendingChanges.length} Pending`
                      : 'Offline'
                  }
                </div>

                {/* Active Users Indicator */}
                <ActiveUsersIndicator activeUsers={activeUsers} />
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
                        const isPresent = (presentById[person.id] ?? person.present) as boolean;
                        const isSaving = Boolean(savingById[person.id] || person.isSaving);
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
                            }`}
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
                              {person.firstName} {person.lastName}
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



      {/* Visitors Section */}
      {filteredGroupedVisitors.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              Visitors ({getVisitorPeopleCount})
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
                        <button
                          disabled={isAttendanceLocked}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleEditVisitor(group.members[0]);
                          }}
                          className={`p-1 ${isAttendanceLocked ? 'text-gray-200 cursor-not-allowed' : 'text-gray-400 hover:text-gray-600'} transition-colors`}
                          title="Edit"
                        >
                          <PencilIcon className="h-4 w-4" />
                        </button>

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

                      return (
                        <label
                          key={person.id || `visitor_${index}`}
                          className={`flex items-center cursor-pointer transition-colors ${
                            groupByFamily && group.familyName
                              ? `p-3 rounded-md border-2 ${
                                  isPresent
                                    ? 'border-primary-500 bg-primary-50'
                                    : 'border-gray-200 hover:border-gray-300'
                                }`
                              : `p-2 rounded-md ${
                                  isPresent
                                    ? 'bg-primary-50'
                                    : 'hover:bg-gray-50'
                                }`
                          }`}
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
                              {cleanName}
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
                                <button
                                  disabled={isAttendanceLocked}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleEditVisitor(person);
                                  }}
                                  className={`p-0.5 ${isAttendanceLocked ? 'text-gray-200 cursor-not-allowed' : 'text-gray-400 hover:text-gray-600'} transition-colors`}
                                  title="Edit visitor"
                                >
                                  <PencilIcon className="h-3 w-3" />
                                </button>

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

      {/* Add People From Church (people not currently visible in this gathering) */}
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
                          return (
                            <div key={person.id || `all_${idx}`} className={`p-2 rounded-md ${groupByFamily && group.familyName ? 'border-2 border-gray-200' : 'border border-gray-200'}`}>
                              <div className="text-sm font-medium text-gray-900">{cleanName}</div>
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

      {/* Floating Add Visitor Button */}
      <button
        onClick={handleAddVisitor}
        disabled={isAttendanceLocked}
        className={`fixed bottom-6 right-6 w-14 h-14 ${isAttendanceLocked ? 'bg-gray-300 cursor-not-allowed' : 'bg-primary-600 hover:bg-primary-700'} text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-50`}
      >
        <PlusIcon className="h-6 w-6" />
      </button>

            {/* Add Visitor Modal */}
      {showAddVisitorModal && createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  {getAddModalTitle()}
                </h3>
                <button
                  onClick={() => setShowAddVisitorModal(false)}
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
                          onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
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
                          onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Traveller Visitor</span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="personType"
                          value="regular"
                          checked={visitorForm.personType === 'regular'}
                          onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Regular Attendee</span>
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
                      {/* Add Person button and auto-fill checkbox under person 1 info */}
                      {index === 0 && (
                        <div className="md:col-span-2 mt-4 space-y-3">
                          {visitorForm.persons.length < 10 && (
                            <button
                              type="button"
                              onClick={addPerson}
                              className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-primary-700 bg-primary-100 hover:bg-primary-200"
                            >
                              <PlusIcon className="h-4 w-4 mr-2" />
                              Add Another Person
                            </button>
                          )}

                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Help text for regular attendees */}
                {visitorForm.personType === 'regular' && (
                  <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                    <div className="text-sm text-blue-700">
                      <strong>Adding Regular Attendees:</strong> This will add the person to your People list and assign them to this gathering. 
                      For families, we recommend using the People page to properly organize family groups.
                    </div>
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
                    onClick={() => setShowAddVisitorModal(false)}
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

      {/* Edit Visitor Modal */}
      {showEditVisitorModal && createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Edit Visitor
                </h3>
                <button
                  onClick={() => setShowEditVisitorModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <form onSubmit={(e) => { e.preventDefault(); handleSubmitEditVisitor(); }} className="space-y-4">
                {/* Person Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Person Type
                  </label>
                  <div className="flex space-x-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="editPersonType"
                        value="local_visitor"
                        checked={visitorForm.personType === 'local_visitor'}
                        onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                      />
                      <span className="ml-2 text-sm text-gray-900">Local Visitor</span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="editPersonType"
                        value="traveller_visitor"
                        checked={visitorForm.personType === 'traveller_visitor'}
                        onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                      />
                      <span className="ml-2 text-sm text-gray-900">Traveller Visitor</span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="editPersonType"
                        value="regular"
                        checked={visitorForm.personType === 'regular'}
                        onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                      />
                      <span className="ml-2 text-sm text-gray-900">Regular Attendee</span>
                    </label>
                  </div>
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
                        <label htmlFor={`editPersonFirstName-${index}`} className="block text-sm font-medium text-gray-700">
                          First Name {index + 1}
                        </label>
                        <input
                          id={`editPersonFirstName-${index}`}
                          type="text"
                          value={person.firstName}
                          onChange={(e) => updatePerson(index, { firstName: e.target.value })}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                          placeholder="First name"
                          required
                        />
                      </div>
                      <div className="relative">
                        <label htmlFor={`editPersonLastName-${index}`} className="block text-sm font-medium text-gray-700">
                          Last Name {index + 1}
                        </label>
                        <input
                          id={`editPersonLastName-${index}`}
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
                              id={`editPersonLastNameUnknown-${index}`}
                              type="checkbox"
                              checked={person.lastNameUnknown}
                              onChange={(e) => updatePerson(index, { lastNameUnknown: e.target.checked })}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                            />
                            <label htmlFor={`editPersonLastNameUnknown-${index}`} className="ml-2 block text-sm text-gray-900">
                              Unknown
                            </label>
                          </div>
                          {/* For person 2+: Fill from above checkbox */}
                          {index > 0 && (
                            <div className="flex items-center">
                              <input
                                id={`editPersonFillLastName-${index}`}
                                type="checkbox"
                                checked={person.fillLastNameFromAbove}
                                onChange={(e) => updatePerson(index, { fillLastNameFromAbove: e.target.checked })}
                                disabled={person.lastNameUnknown}
                                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                              />
                              <label htmlFor={`editPersonFillLastName-${index}`} className="ml-2 block text-sm text-gray-900">
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
                      {/* Add Person button and auto-fill checkbox under person 1 info */}
                      {index === 0 && (
                        <div className="md:col-span-2 mt-4 space-y-3">
                          {visitorForm.persons.length < 10 && (
                            <button
                              type="button"
                              onClick={addPerson}
                              className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-primary-700 bg-primary-100 hover:bg-primary-200"
                            >
                              <PlusIcon className="h-4 w-4 mr-2" />
                              Add Another Person
                            </button>
                          )}

                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Notes field */}
                <div>
                  <label htmlFor="editNotes" className="block text-sm font-medium text-gray-700">
                    Notes
                  </label>
                  <textarea
                    id="editNotes"
                    value={visitorForm.notes}
                    onChange={(e) => setVisitorForm({ ...visitorForm, notes: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Any additional notes (optional)"
                    rows={3}
                  />
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowEditVisitorModal(false)}
                    className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                  >
                    {getEditButtonText()}
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