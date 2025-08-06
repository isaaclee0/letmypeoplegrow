import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { format, addWeeks, startOfWeek, addDays, isBefore, startOfDay } from 'date-fns';
import { useAuth } from '../contexts/AuthContext';
import { gatheringsAPI, attendanceAPI, authAPI, familiesAPI, GatheringType, Individual, Visitor } from '../services/api';
import AttendanceDatePicker from '../components/AttendanceDatePicker';
import { useToast } from '../components/ToastContainer';
import { 
  CalendarIcon, 
  PlusIcon, 
  UserGroupIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  StarIcon,
  XMarkIcon,
  PencilIcon,
  TrashIcon
} from '@heroicons/react/24/outline';

interface PersonForm {
  firstName: string;
  firstNameUnknown: boolean;
  lastName: string;
  lastNameUnknown: boolean;
}

interface VisitorFormState {
  personType: string;
  visitorType: string;
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
  
  // Helper functions for localStorage
  const saveLastViewed = (gatheringId: number, date: string) => {
    const lastViewed = {
      gatheringId,
      date,
      timestamp: Date.now()
    };
    localStorage.setItem('attendance_last_viewed', JSON.stringify(lastViewed));
  };
  
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
  const [showEditVisitorModal, setShowEditVisitorModal] = useState(false);
  const [editingVisitor, setEditingVisitor] = useState<Visitor | null>(null);
  const [lastUserModification, setLastUserModification] = useState<{ [key: number]: number }>({});

  const [visitorAttendance, setVisitorAttendance] = useState<{ [key: number | string]: boolean }>({});
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    visitor: Visitor | null;
    deleteFamily: boolean;
    message: string;
  }>({ visitor: null, deleteFamily: false, message: '' });

  // Add state for recent visitors
  const [recentVisitors, setRecentVisitors] = useState<Visitor[]>([]);
  const [showRecentVisitors, setShowRecentVisitors] = useState(false);
  const [allVisitors, setAllVisitors] = useState<Visitor[]>([]);

  const [visitorForm, setVisitorForm] = useState<VisitorFormState>({
    personType: 'visitor', // 'regular' or 'visitor'
    visitorType: 'local', // 'local' or 'traveller'
    notes: '',
    persons: [{
      firstName: '',
      firstNameUnknown: false,
      lastName: '',
      lastNameUnknown: false
    }],
    autoFillSurname: false
  });

  // Handle click outside to close date picker
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
        
        // Set last viewed gathering or first available gathering
        if (userGatherings.length > 0) {
          const lastViewed = getLastViewed();
          let gatheringToSelect = null;
          
          if (lastViewed) {
            // Try to find the last viewed gathering
            gatheringToSelect = userGatherings.find((g: GatheringType) => g.id === lastViewed.gatheringId);
          }
          
          // Fall back to first available gathering
          setSelectedGathering(gatheringToSelect || userGatherings[0]);
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

    setIsLoading(true);
    try {
      const response = await attendanceAPI.get(selectedGathering.id, selectedDate);
      setAttendanceList(response.data.attendanceList || []);
      setVisitors(response.data.visitors || []);
      
      // Initialize visitor attendance state (all visitors start as present)
      const initialVisitorAttendance: { [key: number]: boolean } = {};
      (response.data.visitors || []).forEach((visitor: Visitor) => {
        if (visitor.id) {
          initialVisitorAttendance[visitor.id] = true;
        }
      });
      setVisitorAttendance(initialVisitorAttendance);
    } catch (err) {
      setError('Failed to load attendance data');
    } finally {
      setIsLoading(false);
    }
  }, [selectedGathering, selectedDate]);

  // Load attendance data when date or gathering changes
  useEffect(() => {
    if (selectedGathering && selectedDate) {
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

  // Load recent visitors when gathering changes
  useEffect(() => {
    const loadRecentVisitors = async () => {
      if (!selectedGathering) return;
      
      try {
        const response = await attendanceAPI.getRecentVisitors(selectedGathering.id);
        setRecentVisitors(response.data.visitors || []);
      } catch (err) {
        console.error('Failed to load recent visitors:', err);
      }
    };

    loadRecentVisitors();
  }, [selectedGathering]);

  // Combine current visitors with recent visitors from last 6 weeks
  useEffect(() => {
    if (!selectedGathering) return;

    const loadAllVisitors = async () => {
      try {
        // Get current visitors for this date
        const currentResponse = await attendanceAPI.get(selectedGathering.id, selectedDate);
        const currentVisitors = currentResponse.data.visitors || [];

        // Get recent visitors from last 6 weeks
        const sixWeeksAgo = new Date();
        sixWeeksAgo.setDate(sixWeeksAgo.getDate() - 42); // 6 weeks = 42 days

        const recentResponse = await attendanceAPI.getRecentVisitors(selectedGathering.id);
        const allRecentVisitors = recentResponse.data.visitors || [];
        
        // Filter recent visitors to only include those from last 6 weeks
        const recentVisitorsLast6Weeks = allRecentVisitors.filter((visitor: Visitor) => {
          if (!visitor.lastAttended) return false;
          const lastAttendedDate = new Date(visitor.lastAttended);
          return lastAttendedDate >= sixWeeksAgo;
        });

        // Combine current visitors with recent visitors, avoiding duplicates
        const currentVisitorIds = new Set(currentVisitors.map((v: Visitor) => v.id));
        const combinedVisitors = [
          ...currentVisitors,
          ...recentVisitorsLast6Weeks.filter((v: Visitor) => !currentVisitorIds.has(v.id))
        ];

        setAllVisitors(combinedVisitors);
        
        // Initialize visitor attendance state
        const initialVisitorAttendance: { [key: number | string]: boolean } = {};
        combinedVisitors.forEach((visitor: Visitor, index: number) => {
          // Use visitor ID if available, otherwise use a temporary key
          const visitorKey = visitor.id || `temp_${index}`;
          // Current visitors are checked by default, recent visitors are unchecked
          initialVisitorAttendance[visitorKey] = currentVisitors.some((cv: Visitor) => cv.id === visitor.id);
        });
        setVisitorAttendance(initialVisitorAttendance);
      } catch (err) {
        console.error('Failed to load all visitors:', err);
      }
    };

    loadAllVisitors();
  }, [selectedGathering, selectedDate]);

  // Function to quickly add a recent visitor
  const quickAddRecentVisitor = async (recentVisitor: Visitor) => {
    if (!selectedGathering) return;
    
    try {
      // Parse the visitor name to extract people
      const nameParts = recentVisitor.name.trim().split(' & ');
      const people = nameParts.map(namePart => {
        const personParts = namePart.trim().split(' ');
        const firstName = personParts[0] || 'Unknown';
        const lastName = personParts.slice(1).join(' ') || 'Unknown';
        return {
          firstName: firstName === 'Unknown' ? '' : firstName,
          lastName: lastName === 'Unknown' ? '' : lastName,
          firstUnknown: firstName === 'Unknown',
          lastUnknown: lastName === 'Unknown',
          isChild: false
        };
      });

      // Add as visitor
      const response = await attendanceAPI.addVisitor(selectedGathering.id, selectedDate, {
        people,
        visitorType: recentVisitor.visitorType,
        notes: recentVisitor.notes
      });

      showSuccess(`Added ${recentVisitor.name} from recent visitors`);
      
      // Reload attendance data
      await loadAttendanceData();
    } catch (err: any) {
      console.error('Failed to add recent visitor:', err);
      setError(err.response?.data?.error || 'Failed to add recent visitor');
    }
  };

  const toggleAttendance = async (individualId: number) => {
    const now = Date.now();
    setLastUserModification(prev => ({ ...prev, [individualId]: now }));
    
    setAttendanceList(prev => {
      return prev.map(person => 
        person.id === individualId 
          ? { ...person, present: !person.present, isSaving: true }
          : person
      );
    });

    if (!selectedGathering || !selectedDate) return;

    try {
      await attendanceAPI.record(selectedGathering.id, selectedDate, {
        attendanceRecords: [{ individualId, present: !attendanceList.find(p => p.id === individualId)?.present }],
        visitors: []
      });

      setAttendanceList(prev => 
        prev.map(person => 
          person.id === individualId 
            ? { ...person, isSaving: false }
            : person
        )
      );
    } catch (err) {
      console.error('Failed to save attendance change:', err);
      setError('Failed to save change');
      setAttendanceList(prev => 
        prev.map(person => 
          person.id === individualId 
            ? { ...person, isSaving: false, present: !person.present } // Revert on error
            : person
        )
      );
    }
  };

  const toggleAllFamily = async (familyId: number) => {
    console.log('Toggling all family attendance for family:', familyId);
    // Count how many family members are currently present
    const familyMembers = attendanceList.filter(person => person.familyId === familyId);
    const presentCount = familyMembers.filter(person => person.present).length;
    
    // If 2 or more are present, uncheck all. Otherwise, check all
    const shouldCheckAll = presentCount < 2;
    console.log('Family members present:', presentCount, 'Should check all:', shouldCheckAll);
    
    if (!selectedGathering || !selectedDate) return;

    // Track user modifications for all family members
    const now = Date.now();
    const familyMemberIds = familyMembers.map(person => person.id);
    setLastUserModification(prev => {
      const updated = { ...prev };
      familyMemberIds.forEach(id => {
        updated[id] = now;
      });
      return updated;
    });

    // Update local state first
    setAttendanceList(prev => {
      const updated = prev.map(person => 
        person.familyId === familyId 
          ? { ...person, present: shouldCheckAll, isSaving: true }
          : person
      );
      console.log('Updated attendance list after family toggle:', updated);
      return updated;
    });

    try {
      // Create attendance records for all family members
      const familyAttendanceRecords = familyMembers.map(person => ({
        individualId: person.id,
        present: shouldCheckAll
      }));

      await attendanceAPI.record(selectedGathering.id, selectedDate, {
        attendanceRecords: familyAttendanceRecords,
        visitors: []
      });

      // Clear saving state
      setAttendanceList(prev => 
        prev.map(person => 
          person.familyId === familyId 
            ? { ...person, isSaving: false }
            : person
        )
      );
    } catch (err) {
      console.error('Failed to save family attendance change:', err);
      setError('Failed to save family changes');
      // Revert on error
      setAttendanceList(prev => 
        prev.map(person => 
          person.familyId === familyId 
            ? { ...person, isSaving: false, present: !shouldCheckAll } // Revert to previous state
            : person
        )
      );
    }
  };

  // Update polling effect
  useEffect(() => {
    if (!selectedGathering || !selectedDate) {
      return;
    }

    const startPolling = () => {
      pollingIntervalRef.current = setInterval(async () => {
        try {
          const response = await attendanceAPI.get(selectedGathering!.id, selectedDate);
          const newAttendanceList = response.data.attendanceList || [];
          const newVisitors = response.data.visitors || [];
          
          console.log('Polling: Current list length:', attendanceList.length, 'New list length:', newAttendanceList.length);
          
          // Check for concurrent updates by comparing attendance states
          let hasConcurrentUpdates = false;
          if (attendanceList.length > 0 && newAttendanceList.length > 0) {
            const currentMap = new Map(attendanceList.map((p: Individual) => [p.id, p.present]));
            const newMap = new Map(newAttendanceList.map((p: Individual) => [p.id, p.present]));
            
            newMap.forEach((newPresent, id) => {
              const currentPresent = currentMap.get(id as number);
              if (currentPresent !== undefined && currentPresent !== newPresent) {
                const userModifiedTime = lastUserModification[id as number];
                const timeSinceUserModification = userModifiedTime ? Date.now() - userModifiedTime : Infinity;
                
                // If user hasn't modified recently and values differ, it's a concurrent update
                if (timeSinceUserModification > 15000) {
                  hasConcurrentUpdates = true;
                }
              }
            });
          }
          
          setAttendanceList(prev => {
            // Create a map of current people by ID for quick lookup
            const currentPeopleMap = new Map(prev.map(p => [p.id, p]));
            
            // Process new data from server
            const updatedList = newAttendanceList.map((newPerson: Individual) => {
              const currentPerson = currentPeopleMap.get(newPerson.id);
              
              if (!currentPerson) {
                // New person from server
                return { ...newPerson, isSaving: false };
              }
              
              // Check if user has modified this person recently (within last 15 seconds)
              const userModifiedTime = lastUserModification[newPerson.id];
              const timeSinceUserModification = userModifiedTime ? Date.now() - userModifiedTime : Infinity;
              
              if (currentPerson.isSaving) {
                // Person is currently being saved, keep current state
                return currentPerson;
              } else if (timeSinceUserModification <= 15000) { // 15 seconds (increased window)
                // User modified recently, keep user's version
                return {
                  ...newPerson,
                  present: currentPerson.present, // Keep user's present value
                  isSaving: false
                };
              } else {
                // Safe to update from server
                return { ...newPerson, isSaving: false };
              }
            });
            
            return updatedList;
          });
          
          setVisitors(newVisitors);
        } catch (err) {
          console.error('Polling error:', err);
        }
      }, 10000); // Poll every 10 seconds (reduced frequency)
    };

    startPolling();

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [selectedGathering, selectedDate, lastUserModification, attendanceList]);

  // Clean up old modification timestamps (older than 30 seconds)
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      setLastUserModification(prev => {
        const cleaned = { ...prev };
        Object.keys(cleaned).forEach(key => {
          const id = parseInt(key);
          if (now - cleaned[id] > 30000) { // 30 seconds
            delete cleaned[id];
          }
        });
        return cleaned;
      });
    }, 30000); // Clean up every 30 seconds

    return () => clearInterval(cleanupInterval);
  }, []);



  // Handle add visitor
  const handleAddVisitor = async () => {
    // Set default person type based on user role
    const defaultPersonType = user?.role === 'admin' || user?.role === 'coordinator' ? 'visitor' : 'visitor';
    setVisitorForm({
      personType: defaultPersonType,
      visitorType: 'local',
      notes: '',
      persons: [{
        firstName: '',
        firstNameUnknown: false,
        lastName: '',
        lastNameUnknown: false
      }],
      autoFillSurname: false
    });
    setShowAddVisitorModal(true);
  };

  const handleEditVisitor = (visitor: Visitor) => {
    // Find ALL visitors in the same family group (including the clicked visitor)
    const familyMembers = visitor.visitorFamilyGroup 
      ? visitors.filter(v => v.visitorFamilyGroup === visitor.visitorFamilyGroup)
      : [visitor]; // If no family group, just edit the individual visitor
    
    const personsData = familyMembers.map(member => {
      const parts = member.name.trim().split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      return {
        firstName: firstName === 'Unknown' ? '' : firstName,
        firstNameUnknown: firstName === 'Unknown',
        lastName: lastName === 'Unknown' ? '' : lastName,
        lastNameUnknown: lastName === 'Unknown'
      };
    });
    
    setVisitorForm({
      personType: 'visitor',
      visitorType: visitor.visitorType === 'potential_regular' ? 'local' : 'traveller',
      notes: visitor.notes || '',
      persons: personsData,
      autoFillSurname: false
    });
    setEditingVisitor(visitor);
    setShowEditVisitorModal(true);
  };

  const handleDeleteVisitor = (visitor: Visitor, deleteFamily: boolean = false) => {
    const confirmMessage = deleteFamily 
      ? `Are you sure you want to delete the entire visitor family? This cannot be undone.`
      : `Are you sure you want to delete ${visitor.name}? This cannot be undone.`;

    setDeleteConfirmation({
      visitor,
      deleteFamily,
      message: confirmMessage
    });
    setShowDeleteModal(true);
  };

  const confirmDeleteVisitor = async () => {
    if (!selectedGathering || !deleteConfirmation.visitor) return;

    try {
      const response = await attendanceAPI.deleteVisitor(
        selectedGathering.id, 
        selectedDate, 
        deleteConfirmation.visitor.id!, 
        deleteConfirmation.deleteFamily
      );

      showSuccess(response.data.message);
      
      // Reload attendance data to refresh the visitor list
      await loadAttendanceData();
    } catch (err: any) {
      console.error('Failed to delete visitor:', err);
      setError(err.response?.data?.error || 'Failed to delete visitor');
    } finally {
      setShowDeleteModal(false);
      setDeleteConfirmation({ visitor: null, deleteFamily: false, message: '' });
    }
  };

  const cancelDeleteVisitor = () => {
    setShowDeleteModal(false);
    setDeleteConfirmation({ visitor: null, deleteFamily: false, message: '' });
  };

  // Add functions to manage persons array
  const addPerson = () => {
    setVisitorForm(prev => {
      const newPerson = { firstName: '', firstNameUnknown: false, lastName: '', lastNameUnknown: false };
      
      // Auto-fill surname if enabled and first person has a surname
      if (prev.autoFillSurname && prev.persons.length > 0) {
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
      if (updates.firstNameUnknown !== undefined) {
        newPersons[index].firstName = updates.firstNameUnknown ? '' : newPersons[index].firstName;
      }
      if (updates.lastNameUnknown !== undefined) {
        newPersons[index].lastName = updates.lastNameUnknown ? '' : newPersons[index].lastName;
      }
      return { ...prev, persons: newPersons };
    });
  };

  const handleSubmitVisitor = async () => {
    if (!selectedGathering) return;
    
    try {
      // Validate form
      for (const person of visitorForm.persons) {
        if (!person.firstName.trim() && !person.firstNameUnknown) {
          setError('First name is required for all persons');
          return;
        }
        if (!person.lastName.trim() && !person.lastNameUnknown) {
          setError('Last name is required for all persons');
          return;
        }
      }

      // Build people array
      const people = visitorForm.persons.map(person => ({
        firstName: person.firstNameUnknown ? 'Unknown' : person.firstName.trim(),
        lastName: person.lastNameUnknown ? 'Unknown' : person.lastName.trim(),
        firstUnknown: person.firstNameUnknown,
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
        const familyName = generateFamilyName(people);
        
        // Create visitor family in People system
        const familyResponse = await familiesAPI.createVisitorFamily({
          familyName,
          visitorType: visitorForm.visitorType === 'local' ? 'local' : 'traveller',
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
        personType: 'visitor',
        visitorType: 'local',
        notes: '',
        persons: [{
          firstName: '',
          firstNameUnknown: false,
          lastName: '',
          lastNameUnknown: false
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
    if (!selectedGathering || !editingVisitor) return;
    
    try {
      // Validate form
      for (const person of visitorForm.persons) {
        if (!person.firstName.trim() && !person.firstNameUnknown) {
          setError('First name is required for all persons');
          return;
        }
        if (!person.lastName.trim() && !person.lastNameUnknown) {
          setError('Last name is required for all persons');
          return;
        }
      }

      // Build people array
      const people = visitorForm.persons.map(person => ({
        firstName: person.firstNameUnknown ? 'Unknown' : person.firstName.trim(),
        lastName: person.lastNameUnknown ? 'Unknown' : person.lastName.trim(),
        firstUnknown: person.firstNameUnknown,
        lastUnknown: person.lastNameUnknown,
        isChild: false // No distinction
      }));

      const notes = visitorForm.notes.trim();

      // NEW APPROACH: Update visitor family in People system
      // For now, we'll keep the old approach for editing since it's more complex
      // TODO: Implement proper editing of visitor families in People system
      const response = await attendanceAPI.updateVisitor(selectedGathering.id, selectedDate, editingVisitor.id!, {
        people,
        visitorType: visitorForm.visitorType === 'local' ? 'potential_regular' : 'temporary_other',
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
        personType: 'visitor',
        visitorType: 'local',
        notes: '',
        persons: [{
          firstName: '',
          firstNameUnknown: false,
          lastName: '',
          lastNameUnknown: false
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

  // Group attendees by family and filter based on search term
  const groupedAttendees = attendanceList.reduce((groups, person) => {
    if (groupByFamily && person.familyId) {
      // Group by family if setting is enabled and person has a family
      const familyKey = `family_${person.familyId}`;
      if (!groups[familyKey]) {
        groups[familyKey] = {
          family_id: person.familyId,
          family_name: person.familyName,
          members: []
        };
      }
      groups[familyKey].members.push(person);
    } else {
      // List all individuals in a single group
      const individualGroupKey = 'individuals';
      if (!groups[individualGroupKey]) {
        groups[individualGroupKey] = {
          family_id: null,
          family_name: null,
          members: []
        };
      }
      groups[individualGroupKey].members.push(person);
    }
    return groups;
  }, {} as any);

  // Group visitors by family
  const groupedVisitors = useMemo(() => {
    if (!groupByFamily) {
      return [{ familyId: null, familyName: null, members: allVisitors, isFamily: false, groupKey: 'ungrouped' }];
    }

    const grouped: { [key: string]: { familyId: number | null; familyName: string | null; members: Visitor[]; isFamily: boolean; groupKey: string } } = {};

    allVisitors.forEach((visitor, index) => {
      // Group by visitor_family_group if it exists, otherwise treat as individual
      // Use a fallback for visitors without IDs to ensure unique keys
      const visitorId = visitor.id || `temp_${index}`;
      const groupKey = visitor.visitorFamilyGroup ? `family_${visitor.visitorFamilyGroup}` : `individual_${visitorId}`;
      
      if (!grouped[groupKey]) {
        const isFamily = !!visitor.visitorFamilyGroup;
        let familyName = null;
        
        if (isFamily) {
          // For families, collect all names and create a family name
          const familyMembers = allVisitors.filter(v => v.visitorFamilyGroup === visitor.visitorFamilyGroup);
          
          // Use first two members added (by ID order, not alphabetically)
          const sortedMembers = familyMembers.sort((a, b) => (a.id || 0) - (b.id || 0));
          const firstTwoMembers = sortedMembers.slice(0, 2);
          
          const firstNames = firstTwoMembers.map(member => {
            const parts = member.name.trim().split(' ');
            const firstName = parts[0];
            return (firstName && firstName !== 'Unknown' && !firstName.match(/^Child$/i)) ? firstName : null;
          }).filter(name => name !== null);
          
          const surnames = firstTwoMembers.map(member => {
            const parts = member.name.trim().split(' ');
            const lastName = parts.slice(1).join(' ');
            return (lastName && lastName !== 'Unknown') ? lastName : null;
          }).filter(name => name !== null);
          
          // Handle unknown surnames - use first two first names
          if (surnames.length === 0 && firstNames.length > 0) {
            if (firstNames.length === 1) {
              familyName = firstNames[0];
            } else {
              familyName = `${firstNames[0]} and ${firstNames[1]}`;
            }
          } else {
            // Follow the pattern: SURNAME, firstname and firstname OR SURNAME1, firstname1 and SURNAME2, firstname2
            const uniqueSurnames = Array.from(new Set(surnames));
            
            if (uniqueSurnames.length === 1 && uniqueSurnames[0]) {
              // All have the same surname - use pattern: SURNAME, firstname and firstname
              const surname = uniqueSurnames[0].toUpperCase();
              if (firstNames.length === 1) {
                familyName = `${surname}, ${firstNames[0]}`;
              } else {
                familyName = `${surname}, ${firstNames[0]} and ${firstNames[1]}`;
              }
            } else if (firstNames.length > 0 && surnames.length > 0) {
              // Different surnames - use pattern: SURNAME1, firstname1 and SURNAME2, firstname2
              const nameWithSurname = firstTwoMembers.map(member => {
                const parts = member.name.trim().split(' ');
                const firstName = parts[0];
                const lastName = parts.slice(1).join(' ');
                
                if (firstName && firstName !== 'Unknown' && lastName && lastName !== 'Unknown') {
                  return `${lastName.toUpperCase()}, ${firstName}`;
                } else if (firstName && firstName !== 'Unknown') {
                  return firstName;
                } else {
                  return null;
                }
              }).filter(name => name !== null);
              
              if (nameWithSurname.length === 1) {
                familyName = nameWithSurname[0];
              } else if (nameWithSurname.length === 2) {
                familyName = `${nameWithSurname[0]} and ${nameWithSurname[1]}`;
              } else {
                familyName = 'Visitor Family';
              }
            } else {
              familyName = 'Visitor Family';
            }
          }
        } else {
          // For individuals, generate familyName
          const parts = visitor.name.trim().split(' ');
          const firstName = parts[0] || 'Unknown';
          const lastName = parts.slice(1).join(' ') || 'Unknown';
          
          if (lastName !== 'Unknown') {
            familyName = `${lastName.toUpperCase()}, ${firstName}`;
          } else if (firstName !== 'Unknown') {
            familyName = firstName;
          } else {
            familyName = 'Unknown Visitor';
          }
        }
        
        grouped[groupKey] = {
          familyId: null,
          familyName,
          members: [],
          isFamily,
          groupKey
        };
      }
      grouped[groupKey].members.push(visitor);
    });

    return Object.values(grouped);
  }, [allVisitors, groupByFamily]);

  // Filter families based on search term
  const filteredGroupedAttendees = Object.values(groupedAttendees).filter((group: any) => {
    if (!searchTerm.trim()) return true;
    
    const searchLower = searchTerm.toLowerCase();
    
    // Check if any family member's name contains the search term
    return group.members.some((member: Individual) => {
      const fullName = `${member.firstName} ${member.lastName}`.toLowerCase();
      return fullName.includes(searchLower);
    });
  });

  // Filter visitors based on search term
  const filteredGroupedVisitors = groupedVisitors.filter((group: any) => {
    if (!searchTerm.trim()) return true;
    
    const searchLower = searchTerm.toLowerCase();
    
    // Check if any visitor's name contains the search term
    return group.members.some((visitor: Visitor) => {
      const visitorName = visitor.name.toLowerCase();
      return visitorName.includes(searchLower);
    });
  });

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
  const toggleVisitorAttendance = (visitorId: number | string) => {
    setVisitorAttendance(prev => ({
      ...prev,
      [visitorId]: !prev[visitorId]
    }));
  };

  // Add toggle all family function for visitors
  const toggleAllVisitorFamily = (familyGroup: number | string) => {
    const familyVisitors = allVisitors.filter(visitor => visitor.visitorFamilyGroup === familyGroup);
    const familyVisitorKeys = familyVisitors.map((visitor, index) => visitor.id || `temp_${index}`);
    
    // Count how many family members are currently present
    const presentCount = familyVisitorKeys.filter(key => visitorAttendance[key]).length;
    
    // If 2 or more are present, uncheck all. Otherwise, check all
    const shouldCheckAll = presentCount < 2;
    
    setVisitorAttendance(prev => {
      const updated = { ...prev };
      familyVisitorKeys.forEach(key => {
        updated[key] = shouldCheckAll;
      });
      return updated;
    });
  };

  // Helper function to count actual number of people in visitor records
  const getVisitorPeopleCount = useMemo(() => {
    // Count only visitors that are marked as present
    return allVisitors.filter((visitor, index) => {
      const visitorKey = visitor.id || `temp_${index}`;
      return visitorAttendance[visitorKey];
    }).length;
  }, [allVisitors, visitorAttendance]);

  // Helper function to get the appropriate modal title
  const getAddModalTitle = () => {
    const totalPeople = visitorForm.persons.length;
    const personType = visitorForm.personType === 'visitor' ? 'Visitor' : 'Person';
    
    if (totalPeople === 1) {
      return `Add ${personType}`;
    } else {
      const pluralType = visitorForm.personType === 'visitor' ? 'Visitors' : 'People';
      return `Add ${pluralType} (${totalPeople})`;
    }
  };

  // Helper function to get the appropriate button text
  const getAddButtonText = () => {
    const totalPeople = visitorForm.persons.length;
    const personType = visitorForm.personType === 'visitor' ? 'Visitor' : 'Person';
    
    if (totalPeople === 1) {
      return `Add ${personType}`;
    } else {
      const pluralType = visitorForm.personType === 'visitor' ? 'Visitors' : 'People';
      return `Add ${pluralType}`;
    }
  };

  // Helper function to generate family name from people array
  const generateFamilyName = (people: Array<{
    firstName: string;
    lastName: string;
    firstUnknown: boolean;
    lastUnknown: boolean;
    isChild: boolean;
  }>) => {
    if (people.length === 0) return 'Visitor Family';
    
    // Use first two people to generate family name
    const firstTwoPeople = people.slice(0, 2);
    
    const firstNames = firstTwoPeople.map(person => {
      return (!person.firstUnknown && person.firstName && person.firstName !== 'Unknown') ? person.firstName : null;
    }).filter(name => name !== null);
    
    const surnames = firstTwoPeople.map(person => {
      return (!person.lastUnknown && person.lastName && person.lastName !== 'Unknown') ? person.lastName : null;
    }).filter(name => name !== null);
    
    // Handle unknown surnames - use first two first names
    if (surnames.length === 0 && firstNames.length > 0) {
      if (firstNames.length === 1) {
        return firstNames[0];
      } else {
        return `${firstNames[0]} and ${firstNames[1]}`;
      }
    } else if (surnames.length > 0) {
      // Follow the pattern: SURNAME, firstname and firstname OR SURNAME1, firstname1 and SURNAME2, firstname2
      const uniqueSurnames = Array.from(new Set(surnames));
      
      if (uniqueSurnames.length === 1 && uniqueSurnames[0]) {
        // All have the same surname - use pattern: SURNAME, firstname and firstname
        const surname = uniqueSurnames[0].toUpperCase();
        if (firstNames.length === 1) {
          return `${surname}, ${firstNames[0]}`;
        } else {
          return `${surname}, ${firstNames[0]} and ${firstNames[1]}`;
        }
      } else if (firstNames.length > 0 && surnames.length > 0) {
        // Different surnames - use pattern: SURNAME1, firstname1 and SURNAME2, firstname2
        const nameWithSurname = firstTwoPeople.map(person => {
          const firstName = !person.firstUnknown && person.firstName && person.firstName !== 'Unknown' ? person.firstName : null;
          const lastName = !person.lastUnknown && person.lastName && person.lastName !== 'Unknown' ? person.lastName : null;
          
          if (firstName && lastName) {
            return `${lastName.toUpperCase()}, ${firstName}`;
          } else if (firstName) {
            return firstName;
          } else {
            return null;
          }
        }).filter(name => name !== null);
        
        if (nameWithSurname.length === 1) {
          return nameWithSurname[0];
        } else if (nameWithSurname.length === 2) {
          return `${nameWithSurname[0]} and ${nameWithSurname[1]}`;
        } else {
          return 'Visitor Family';
        }
      } else {
        return 'Visitor Family';
      }
    } else {
      return 'Visitor Family';
    }
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

  return (
    <div className="space-y-6">
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
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-900">
                  {attendanceList.filter(person => person.present).length + getVisitorPeopleCount}
                </div>
                <div className="text-sm text-gray-500">Total Present</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-primary-600">
                  {attendanceList.filter(person => person.present).length}
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
                  {attendanceList.filter(person => !person.present).length}
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
            <nav className="-mb-px flex space-x-8" aria-label="Tabs">
              {gatherings.map((gathering) => (
                <button
                  key={gathering.id}
                  onClick={() => setSelectedGathering(gathering)}
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
                  onChange={(e) => {
                    const newValue = e.target.checked;
                    setGroupByFamily(newValue);
                    // Save the setting for this gathering
                    if (selectedGathering) {
                      localStorage.setItem(`gathering_${selectedGathering.id}_groupByFamily`, newValue.toString());
                    }
                  }}
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
                          {group.family_name}
                        </h4>
                        <button
                          onClick={() => toggleAllFamily(group.family_id)}
                          className="text-sm text-primary-600 hover:text-primary-700"
                        >
                          {(() => {
                            const familyMembers = attendanceList.filter(person => person.familyId === group.family_id);
                            const presentCount = familyMembers.filter(person => person.present).length;
                            return presentCount >= 2 ? 'Uncheck all family' : 'Check all family';
                          })()}
                        </button>
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                      {group.members.map((person: Individual) => (
                        <label
                          key={person.id}
                          className={`flex items-center cursor-pointer transition-colors ${
                            groupByFamily 
                              ? `p-3 rounded-md border-2 ${
                                  person.present
                                    ? 'border-primary-500 bg-primary-50'
                                    : 'border-gray-200 hover:border-gray-300'
                                } ${person.isSaving ? 'opacity-75' : ''}`
                              : `p-2 rounded-md ${
                                  person.present
                                    ? 'bg-primary-50'
                                    : 'hover:bg-gray-50'
                                } ${person.isSaving ? 'opacity-75' : ''}`
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(person.present)}
                            onChange={() => toggleAttendance(person.id)}
                            className="sr-only"
                            disabled={person.isSaving}
                          />
                          <div className={`flex-shrink-0 h-5 w-5 rounded border-2 flex items-center justify-center ${
                            person.present ? 'bg-primary-600 border-primary-600' : 'border-gray-300'
                          } ${person.isSaving ? 'animate-pulse' : ''}`}>
                            {person.present && (
                              <CheckIcon className="h-3 w-3 text-white" />
                            )}
                          </div>
                          <span className="ml-3 text-sm font-medium text-gray-900">
                            {person.firstName} {person.lastName}
                            {person.isSaving && (
                              <span className="ml-2 text-xs text-gray-500">Saving...</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}



      {/* Visitors Section */}
      {allVisitors.length > 0 && (
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
                          {group.familyName}
                        </h4>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          group.members[0].visitorType === 'potential_regular' 
                            ? 'bg-green-100 text-green-800' 
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {group.members[0].visitorType === 'potential_regular' ? 'Local' : 'Traveller'}
                        </span>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            handleEditVisitor(group.members[0]);
                          }}
                          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Edit"
                        >
                          <PencilIcon className="h-4 w-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            handleDeleteVisitor(group.members[0], group.members.length > 1);
                          }}
                          className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                          title="Delete"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                      {group.members.length > 1 && (
                        <button
                          onClick={() => toggleAllVisitorFamily(group.members[0].visitorFamilyGroup || group.members[0].id)}
                          className="text-sm text-primary-600 hover:text-primary-700"
                        >
                          {(() => {
                            const familyVisitors = group.members;
                            const presentCount = familyVisitors.filter((visitor: any, index: number) => {
                              const visitorKey = visitor.id || `temp_${index}`;
                              return visitorAttendance[visitorKey];
                            }).length;
                            return presentCount >= 2 ? 'Uncheck all family' : 'Check all family';
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
                      const visitorKey = person.id || `temp_${index}`;
                      const isPresent = visitorAttendance[visitorKey] || false;

                      return (
                        <label
                          key={visitorKey}
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
                            onChange={() => toggleVisitorAttendance(visitorKey)}
                            className="sr-only"
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
                                  onClick={(e) => {
                                    e.preventDefault();
                                    handleEditVisitor(person);
                                  }}
                                  className="p-0.5 text-gray-400 hover:text-gray-600 transition-colors"
                                  title="Edit visitor"
                                >
                                  <PencilIcon className="h-3 w-3" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    handleDeleteVisitor(person, false);
                                  }}
                                  className="p-0.5 text-gray-400 hover:text-red-600 transition-colors"
                                  title="Delete visitor"
                                >
                                  <TrashIcon className="h-3 w-3" />
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

      {/* Floating Add Visitor Button */}
      <button
        onClick={handleAddVisitor}
        className="fixed bottom-6 right-6 w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-50"
      >
        <PlusIcon className="h-6 w-6" />
      </button>

            {/* Add Visitor Modal */}
      {showAddVisitorModal && (
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
                          value="visitor"
                          checked={visitorForm.personType === 'visitor'}
                          onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Visitor</span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="personType"
                          value="regular"
                          checked={visitorForm.personType === 'regular'}
                          onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Regular Attendee</span>
                      </label>
                    </div>
                  </div>
                )}

                {/* Visitor Type (only show if person type is visitor) */}
                {visitorForm.personType === 'visitor' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Visitor Type
                    </label>
                    <div className="flex space-x-4">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="visitorType"
                          value="local"
                          checked={visitorForm.visitorType === 'local'}
                          onChange={(e) => setVisitorForm({ ...visitorForm, visitorType: e.target.value })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Local (might attend regularly)</span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="visitorType"
                          value="traveller"
                          checked={visitorForm.visitorType === 'traveller'}
                          onChange={(e) => setVisitorForm({ ...visitorForm, visitorType: e.target.value })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Traveller (just passing through)</span>
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
                          disabled={person.firstNameUnknown}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                          placeholder="First name"
                        />
                        <div className="flex items-center mt-1">
                          <input
                            id={`personFirstNameUnknown-${index}`}
                            type="checkbox"
                            checked={person.firstNameUnknown}
                            onChange={(e) => updatePerson(index, { firstNameUnknown: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <label htmlFor={`personFirstNameUnknown-${index}`} className="ml-2 block text-sm text-gray-900">
                            Unknown
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
                          disabled={person.lastNameUnknown}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                          placeholder="Last name"
                        />
                        <div className="flex items-center mt-1">
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
                          {/* Auto-fill checkbox appears under person 1 when there are 2+ people */}
                          {visitorForm.persons.length >= 2 && (
                            <div className="flex items-center">
                              <input
                                type="checkbox"
                                checked={visitorForm.autoFillSurname}
                                onChange={(e) => setVisitorForm({ ...visitorForm, autoFillSurname: e.target.checked })}
                                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                              />
                              <label className="ml-2 block text-sm text-gray-900">
                                Auto-fill surname for all future additions
                              </label>
                            </div>
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
                {visitorForm.personType === 'visitor' && (
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
        </div>
      )}

      {/* Edit Visitor Modal */}
      {showEditVisitorModal && (
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
                {/* Visitor Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Visitor Type
                  </label>
                  <div className="flex space-x-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="visitorType"
                        value="local"
                        checked={visitorForm.visitorType === 'local'}
                        onChange={(e) => setVisitorForm({ ...visitorForm, visitorType: e.target.value })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                      />
                      <span className="ml-2 text-sm text-gray-900">Local (might attend regularly)</span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="visitorType"
                        value="traveller"
                        checked={visitorForm.visitorType === 'traveller'}
                        onChange={(e) => setVisitorForm({ ...visitorForm, visitorType: e.target.value })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                      />
                      <span className="ml-2 text-sm text-gray-900">Traveller (just passing through)</span>
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
                          disabled={person.firstNameUnknown}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                          placeholder="First name"
                        />
                        <div className="flex items-center mt-1">
                          <input
                            id={`editPersonFirstNameUnknown-${index}`}
                            type="checkbox"
                            checked={person.firstNameUnknown}
                            onChange={(e) => updatePerson(index, { firstNameUnknown: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <label htmlFor={`editPersonFirstNameUnknown-${index}`} className="ml-2 block text-sm text-gray-900">
                            Unknown
                          </label>
                        </div>
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
                          disabled={person.lastNameUnknown}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                          placeholder="Last name"
                        />
                        <div className="flex items-center mt-1">
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
                          {/* Auto-fill checkbox appears under person 1 when there are 2+ people */}
                          {visitorForm.persons.length >= 2 && (
                            <div className="flex items-center">
                              <input
                                type="checkbox"
                                checked={visitorForm.autoFillSurname}
                                onChange={(e) => setVisitorForm({ ...visitorForm, autoFillSurname: e.target.checked })}
                                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                              />
                              <label className="ml-2 block text-sm text-gray-900">
                                Auto-fill surname for all future additions
                              </label>
                            </div>
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
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-1/2 lg:w-1/3 max-w-md p-5 border shadow-lg rounded-md bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Confirm Deletion
                </h3>
                <button
                  onClick={cancelDeleteVisitor}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="mb-6">
                <div className="flex items-center mb-4">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100">
                    <TrashIcon className="h-6 w-6 text-red-600" />
                  </div>
                </div>
                <div className="text-center">
                  <p className="text-sm text-gray-500">
                    {deleteConfirmation.message}
                  </p>
                </div>
              </div>
              
              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={cancelDeleteVisitor}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmDeleteVisitor}
                  className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AttendancePage; 