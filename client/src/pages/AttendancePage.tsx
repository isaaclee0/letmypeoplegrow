import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { format, addWeeks, addMonths, startOfWeek, addDays, isBefore, isAfter, startOfDay } from 'date-fns';
import { useAuth } from '../contexts/AuthContext';
import { gatheringsAPI, attendanceAPI, authAPI, GatheringType, Individual, Visitor } from '../services/api';
import { useToast } from '../components/ToastContainer';
import { 
  CalendarIcon, 
  PlusIcon, 
  UserGroupIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  StarIcon,
  XMarkIcon,
  PencilIcon
} from '@heroicons/react/24/outline';

interface VisitorFormState {
  personType: string;
  visitorType: string;
  firstName: string;
  firstNameUnknown: boolean;
  lastName: string;
  lastNameUnknown: boolean;
  notes: string;
  spouseFirstName: string;
  spouseFirstNameUnknown: boolean;
  spouseLastName: string;
  spouseLastNameUnknown: boolean;
  hasSpouse: boolean;
  children: { firstName: string; firstNameUnknown: boolean; }[];
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
  const [isPolling, setIsPolling] = useState(false);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedDataRef = useRef<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [isSettingDefault, setIsSettingDefault] = useState(false);
  const [justSetDefault, setJustSetDefault] = useState<number | null>(null);
  const [groupByFamily, setGroupByFamily] = useState(true);
  const [showAddVisitorModal, setShowAddVisitorModal] = useState(false);
  const [showEditVisitorModal, setShowEditVisitorModal] = useState(false);
  const [editingVisitor, setEditingVisitor] = useState<Visitor | null>(null);

  const [visitorForm, setVisitorForm] = useState<VisitorFormState>({
    personType: 'visitor', // 'regular' or 'visitor'
    visitorType: 'local', // 'local' or 'traveller'
    firstName: '',
    firstNameUnknown: false,
    lastName: '',
    lastNameUnknown: false,
    notes: '',
    spouseFirstName: '',
    spouseFirstNameUnknown: false,
    spouseLastName: '',
    spouseLastNameUnknown: false,
    hasSpouse: false,
    children: []
  });

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
    const startDate = addWeeks(today, -8); // Start 8 weeks ago
    const endDate = addWeeks(today, 4); // End 4 weeks from now

    let currentDate = startOfWeek(startDate, { weekStartsOn: 0 }); // Start from Sunday
    currentDate = addDays(currentDate, targetDay);

    while (isBefore(currentDate, endDate)) {
      // Only include dates that are today or in the past
      if (isBefore(currentDate, today) || format(currentDate, 'yyyy-MM-dd') === format(today, 'yyyy-MM-dd')) {
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
        
        // Set default gathering or first available gathering
        if (userGatherings.length > 0) {
          const defaultGathering = userGatherings.find((g: GatheringType) => g.id === user?.defaultGatheringId);
          setSelectedGathering(defaultGathering || userGatherings[0]);
        }
      } catch (err) {
        setError('Failed to load gatherings');
      }
    };

    loadGatherings();
  }, [user?.defaultGatheringId, user?.gatheringAssignments]); // Add specific dependencies

  // Set default date when gathering changes
  useEffect(() => {
    if (validDates.length > 0) {
      // Set to the most recent valid date (first in the sorted array)
      setSelectedDate(validDates[0]);
    }
  }, [validDates]);

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
    }
  }, [selectedGathering, selectedDate]);

  const loadAttendanceData = async () => {
    if (!selectedGathering) return;

    setIsLoading(true);
    try {
      const response = await attendanceAPI.get(selectedGathering.id, selectedDate);
      setAttendanceList(response.data.attendanceList || []);
      setVisitors(response.data.visitors || []);
      // setHasChanges(false); // Removed hasChanges state
    } catch (err) {
      setError('Failed to load attendance data');
    } finally {
      setIsLoading(false);
    }
  };



  const toggleAttendance = async (individualId: number) => {
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

  const toggleAllFamily = (familyId: number) => {
    console.log('Toggling all family attendance for family:', familyId);
    // Count how many family members are currently present
    const familyMembers = attendanceList.filter(person => person.familyId === familyId);
    const presentCount = familyMembers.filter(person => person.present).length;
    
    // If 2 or more are present, uncheck all. Otherwise, check all
    const shouldCheckAll = presentCount < 2;
    console.log('Family members present:', presentCount, 'Should check all:', shouldCheckAll);
    
    setAttendanceList(prev => {
      const updated = prev.map(person => 
        person.familyId === familyId 
          ? { ...person, present: shouldCheckAll, isSaving: true }
          : person
      );
      console.log('Updated attendance list after family toggle:', updated);
      return updated;
    });
    // setHasChanges(true); // Removed hasChanges state
    console.log('Set hasChanges to true (family toggle)');
  };

  // Remove saveAttendance and debouncedSave

  // Update polling effect
  useEffect(() => {
    if (!selectedGathering || !selectedDate) {
      return;
    }

    const startPolling = () => {
      pollingIntervalRef.current = setInterval(async () => {
        setIsPolling(true);
        try {
          const response = await attendanceAPI.get(selectedGathering!.id, selectedDate);
          const newAttendanceList = response.data.attendanceList || [];
          const newVisitors = response.data.visitors || [];
          
          setAttendanceList(prev => {
            return prev.map(person => {
              const newPerson = newAttendanceList.find((p: Individual) => p.id === person.id);
              if (newPerson && !person.isSaving) {
                return { ...newPerson, isSaving: false };
              }
              return person;
            });
          });
          
          setVisitors(newVisitors);
        } catch (err) {
          console.error('Polling error:', err);
        } finally {
          setIsPolling(false);
        }
      }, 5000); // Poll every 5 seconds
    };

    startPolling();

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [selectedGathering, selectedDate]);

  // Remove useEffect for hasChanges and debouncedSave

  // Remove save button if not needed, or keep for manual full save

  // Add subtle spinner
  {isPolling && (
    <div className="fixed top-4 right-4 animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
  )}

  // Set default gathering
  const setDefaultGathering = async (gatheringId: number) => {
    setIsSettingDefault(true);
    try {
      await authAPI.setDefaultGathering(gatheringId);
      // Refresh user data to get the updated default
      const response = await authAPI.getCurrentUser();
      updateUser(response.data.user);
      // Update the selected gathering immediately if it's the one we just set as default
      if (selectedGathering && selectedGathering.id === gatheringId) {
        // The gathering is already selected, no need to change it
      } else {
        // Find and select the newly set default gathering
        const newDefaultGathering = gatherings.find(g => g.id === gatheringId);
        if (newDefaultGathering) {
          setSelectedGathering(newDefaultGathering);
        }
      }
      // Set visual feedback
      setJustSetDefault(gatheringId);
      // Clear the feedback after 3 seconds
      setTimeout(() => setJustSetDefault(null), 3000);
    } catch (err) {
      setError('Failed to set default gathering');
    } finally {
      setIsSettingDefault(false);
    }
  };

  // Handle add visitor
  const handleAddVisitor = async () => {
    // Set default person type based on user role
    const defaultPersonType = user?.role === 'admin' || user?.role === 'coordinator' ? 'visitor' : 'visitor';
    setVisitorForm({
      personType: defaultPersonType,
      visitorType: 'local',
      firstName: '',
      firstNameUnknown: false,
      lastName: '',
      lastNameUnknown: false,
      notes: '',
      spouseFirstName: '',
      spouseFirstNameUnknown: false,
      spouseLastName: '',
      spouseLastNameUnknown: false,
      hasSpouse: false,
      children: []
    });
    setShowAddVisitorModal(true);
  };

  const handleEditVisitor = (visitor: Visitor) => {
    // Parse visitor name to extract first and last name
    const nameParts = visitor.name.split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    
    setVisitorForm({
      personType: 'visitor',
      visitorType: visitor.visitorType === 'potential_regular' ? 'local' : 'traveller',
      firstName: firstName === 'Unknown' ? '' : firstName,
      firstNameUnknown: firstName === 'Unknown',
      lastName: lastName === 'Unknown' ? '' : lastName,
      lastNameUnknown: lastName === 'Unknown',
      notes: visitor.notes || '',
      spouseFirstName: '',
      spouseFirstNameUnknown: false,
      spouseLastName: '',
      spouseLastNameUnknown: false,
      hasSpouse: false,
      children: []
    });
    setEditingVisitor(visitor);
    setShowEditVisitorModal(true);
  };

  const addChild = () => {
    setVisitorForm(prev => ({
      ...prev,
      children: [...prev.children, { firstName: '', firstNameUnknown: false }]
    }));
  };

  const removeChild = (index: number) => {
    setVisitorForm(prev => ({
      ...prev,
      children: prev.children.filter((_, i) => i !== index)
    }));
  };

  const updateChild = (index: number, updates: Partial<{ firstName: string; firstNameUnknown: boolean }>) => {
    setVisitorForm(prev => {
      const newChildren = [...prev.children];
      newChildren[index] = { ...newChildren[index], ...updates };
      if (updates.firstNameUnknown) {
        newChildren[index].firstName = '';
      }
      return { ...prev, children: newChildren };
    });
  };

  const handleSubmitVisitor = async () => {
    if (!selectedGathering) return;
    
    try {
      // Validate form
      if (!visitorForm.firstName.trim() && !visitorForm.firstNameUnknown) {
        setError('First name is required');
        return;
      }
      if (!visitorForm.lastName.trim() && !visitorForm.lastNameUnknown) {
        setError('Last name is required');
        return;
      }

      // Build people array
      const people: { firstName: string; lastName: string; firstUnknown: boolean; lastUnknown: boolean; isChild: boolean; }[] = [];
      const firstName = visitorForm.firstNameUnknown ? 'Unknown' : visitorForm.firstName.trim();
      const lastName = visitorForm.lastNameUnknown ? 'Unknown' : visitorForm.lastName.trim();
      people.push({
        firstName,
        lastName,
        firstUnknown: visitorForm.firstNameUnknown,
        lastUnknown: visitorForm.lastNameUnknown,
        isChild: false
      });

      if (visitorForm.hasSpouse) {
        const spouseFirst = visitorForm.spouseFirstNameUnknown ? 'Unknown' : visitorForm.spouseFirstName.trim();
        const spouseLast = visitorForm.spouseLastNameUnknown ? 'Unknown' : visitorForm.spouseLastName.trim();
        people.push({
          firstName: spouseFirst,
          lastName: spouseLast,
          firstUnknown: visitorForm.spouseFirstNameUnknown,
          lastUnknown: visitorForm.spouseLastNameUnknown,
          isChild: false
        });
      }

      visitorForm.children.forEach((child) => {
        const childFirst = child.firstNameUnknown ? 'Unknown' : child.firstName.trim();
        people.push({
          firstName: childFirst,
          lastName: 'Unknown',
          firstUnknown: child.firstNameUnknown,
          lastUnknown: true,
          isChild: true
        });
      });

      const notes = visitorForm.notes.trim();

      // Add visitor to backend
      const response = await attendanceAPI.addVisitor(selectedGathering.id, selectedDate, {
        people,
        visitorType: visitorForm.visitorType === 'local' ? 'potential_regular' : 'temporary_other',
        notes: notes ? notes : undefined
      });

      // Show success toast
      if (response.data.individuals && response.data.individuals.length > 0) {
        const names = response.data.individuals.map((ind: { firstName: string; lastName: string }) => `${ind.firstName} ${ind.lastName}`).join(', ');
        showSuccess(`Added: ${names}`);
      } else {
        showSuccess('Added successfully');
      }

      // Reload attendance data
      await loadAttendanceData();
      
      // Reset form and close modal
      setVisitorForm({
        personType: 'visitor',
        visitorType: 'local',
        firstName: '',
        firstNameUnknown: false,
        lastName: '',
        lastNameUnknown: false,
        notes: '',
        spouseFirstName: '',
        spouseFirstNameUnknown: false,
        spouseLastName: '',
        spouseLastNameUnknown: false,
        hasSpouse: false,
        children: []
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
      if (!visitorForm.firstName.trim() && !visitorForm.firstNameUnknown) {
        setError('First name is required');
        return;
      }
      if (!visitorForm.lastName.trim() && !visitorForm.lastNameUnknown) {
        setError('Last name is required');
        return;
      }

      // Build people array
      const people: { firstName: string; lastName: string; firstUnknown: boolean; lastUnknown: boolean; isChild: boolean; }[] = [];
      const firstName = visitorForm.firstNameUnknown ? 'Unknown' : visitorForm.firstName.trim();
      const lastName = visitorForm.lastNameUnknown ? 'Unknown' : visitorForm.lastName.trim();
      people.push({
        firstName,
        lastName,
        firstUnknown: visitorForm.firstNameUnknown,
        lastUnknown: visitorForm.lastNameUnknown,
        isChild: false
      });

      if (visitorForm.hasSpouse) {
        const spouseFirst = visitorForm.spouseFirstNameUnknown ? 'Unknown' : visitorForm.spouseFirstName.trim();
        const spouseLast = visitorForm.spouseLastNameUnknown ? 'Unknown' : visitorForm.spouseLastName.trim();
        people.push({
          firstName: spouseFirst,
          lastName: spouseLast,
          firstUnknown: visitorForm.spouseFirstNameUnknown,
          lastUnknown: visitorForm.spouseLastNameUnknown,
          isChild: false
        });
      }

      visitorForm.children.forEach((child) => {
        const childFirst = child.firstNameUnknown ? 'Unknown' : child.firstName.trim();
        people.push({
          firstName: childFirst,
          lastName: 'Unknown',
          firstUnknown: child.firstNameUnknown,
          lastUnknown: true,
          isChild: true
        });
      });

      const notes = visitorForm.notes.trim();

      // Update visitor in backend
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
        firstName: '',
        firstNameUnknown: false,
        lastName: '',
        lastNameUnknown: false,
        notes: '',
        spouseFirstName: '',
        spouseFirstNameUnknown: false,
        spouseLastName: '',
        spouseLastNameUnknown: false,
        hasSpouse: false,
        children: []
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

  // Sort members within each group
  filteredGroupedAttendees.forEach((group: any) => {
    group.members.sort((a: Individual, b: Individual) => {
      // Sort by last name, then first name
      const lastNameComparison = a.lastName.localeCompare(b.lastName);
      if (lastNameComparison !== 0) return lastNameComparison;
      return a.firstName.localeCompare(b.firstName);
    });
  });

  // Group visitors by family
  const groupedVisitors = useMemo(() => {
    if (!groupByFamily) {
      return [{ familyId: null, familyName: null, members: visitors }];
    }

    const grouped: { [key: string]: { familyId: number | null; familyName: string | null; members: Visitor[] } } = {};

    visitors.forEach(visitor => {
      // For now, treat all visitors as individuals since they don't have family info from backend
      const singleVisitorKey = 'single_visitor';
      if (!grouped[singleVisitorKey]) {
        grouped[singleVisitorKey] = {
          familyId: null,
          familyName: null,
          members: []
        };
      }
      grouped[singleVisitorKey].members.push(visitor);
    });

    return Object.values(grouped);
  }, [visitors, groupByFamily]);

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
                  {attendanceList.filter(person => person.present).length + visitors.length}
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
                  {visitors.length}
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

      {/* Gathering Type Tabs */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex space-x-8" aria-label="Tabs">
              {gatherings.map((gathering) => (
                <button
                  key={gathering.id}
                  onClick={() => setSelectedGathering(gathering)}
                  className={`whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm transition-all duration-300 ${
                    selectedGathering?.id === gathering.id
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  } ${
                    justSetDefault === gathering.id 
                      ? 'bg-yellow-50 border-yellow-300 text-yellow-700 shadow-sm' 
                      : ''
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <span className={justSetDefault === gathering.id ? 'font-semibold' : ''}>
                      {gathering.name}
                    </span>
                    {user?.defaultGatheringId === gathering.id && (
                      <StarIcon className={`h-4 w-4 text-yellow-500 ${justSetDefault === gathering.id ? 'animate-pulse' : ''}`} />
                    )}
                  </div>
                </button>
              ))}
            </nav>
          </div>
          
          {/* Set Default Link */}
          {selectedGathering && user?.defaultGatheringId !== selectedGathering.id && (
            <div className="mt-3">
              <button
                onClick={() => setDefaultGathering(selectedGathering.id)}
                disabled={isSettingDefault}
                className="text-sm text-primary-600 hover:text-primary-700 flex items-center space-x-1"
              >
                <StarIcon className="h-3 w-3" />
                <span>{isSettingDefault ? 'Setting...' : 'Set as default'}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Date Selection and Search */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Date Selection */}
            <div>
              <label htmlFor="date" className="block text-sm font-medium text-gray-700">
                Date
              </label>
              <div className="mt-1 relative">
                {validDates.length > 0 ? (
                  <select
                    id="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="shadow-sm focus:ring-primary-500 focus:border-primary-500 block w-full sm:text-sm border-gray-300 rounded-md"
                  >
                    {validDates.map((date) => {
                      const dateObj = new Date(date);
                      const isToday = format(dateObj, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
                      const isPast = isBefore(dateObj, startOfDay(new Date()));
                                          const displayText = isToday 
                      ? `Today (${format(dateObj, 'MMM d, yyyy')})`
                      : format(dateObj, 'MMM d, yyyy');
                      
                      return (
                        <option key={date} value={date}>
                          {displayText}
                        </option>
                      );
                    })}
                  </select>
                ) : (
                  <div className="text-sm text-gray-500 py-2 px-3 border border-gray-300 rounded-md bg-gray-50">
                    No valid dates available for this gathering schedule
                  </div>
                )}
                <CalendarIcon className="h-5 w-5 text-gray-400 absolute right-3 top-2 pointer-events-none" />
              </div>
            </div>

            {/* Search/Filter Bar */}
            <div>
              <label htmlFor="search" className="block text-sm font-medium text-gray-700">
                Filter Families
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  id="search"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search by family member name..."
                  className="shadow-sm focus:ring-primary-500 focus:border-primary-500 block w-full pl-10 pr-3 py-2 sm:text-sm border-gray-300 rounded-md"
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
      {visitors.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Visitors</h3>
            <div className="space-y-6">
              {groupedVisitors.map((group: any) => (
                <div key={group.familyId || `single-${group.members[0].id}`} className="border border-gray-200 rounded-md p-4">
                  {group.familyId && (
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-sm font-semibold text-gray-900">{group.familyName}</h4>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                    {group.members.map((person: any) => (
                      <div
                        key={person.id}
                        className="flex items-center p-3 rounded-md border-2 border-primary-500 bg-primary-50"
                      >
                        <div className="flex-shrink-0 h-5 w-5 rounded border-2 flex items-center justify-center bg-primary-600 border-primary-600">
                          <CheckIcon className="h-3 w-3 text-white" />
                        </div>
                        <div className="ml-3 flex-1">
                          <span className="text-sm font-medium text-gray-900">
                            {person.name}
                          </span>
                          <div className="flex items-center mt-1">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              person.visitorType === 'potential_regular' 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-gray-100 text-gray-800'
                            }`}>
                              {person.visitorType === 'potential_regular' ? 'Potential Regular' : 'Temporary'}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleEditVisitor(person)}
                          className="ml-2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Edit visitor"
                        >
                          <PencilIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
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
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Add Person
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

                {/* Name Fields */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="firstName" className="block text-sm font-medium text-gray-700">
                      First Name
                    </label>
                    <input
                      id="firstName"
                      type="text"
                      value={visitorForm.firstName}
                      onChange={(e) => setVisitorForm({ ...visitorForm, firstName: e.target.value })}
                      disabled={visitorForm.firstNameUnknown}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                      placeholder="First name"
                    />
                    <div className="flex items-center mt-1">
                      <input
                        id="firstNameUnknown"
                        type="checkbox"
                        checked={visitorForm.firstNameUnknown}
                        onChange={(e) => setVisitorForm({ ...visitorForm, firstNameUnknown: e.target.checked, firstName: e.target.checked ? '' : visitorForm.firstName })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                      />
                      <label htmlFor="firstNameUnknown" className="ml-2 block text-sm text-gray-900">
                        Unknown
                      </label>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="lastName" className="block text-sm font-medium text-gray-700">
                      Last Name
                    </label>
                    <input
                      id="lastName"
                      type="text"
                      value={visitorForm.lastName}
                      onChange={(e) => setVisitorForm({ ...visitorForm, lastName: e.target.value })}
                      disabled={visitorForm.lastNameUnknown}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                      placeholder="Last name"
                    />
                    <div className="flex items-center mt-1">
                      <input
                        id="lastNameUnknown"
                        type="checkbox"
                        checked={visitorForm.lastNameUnknown}
                        onChange={(e) => setVisitorForm({ ...visitorForm, lastNameUnknown: e.target.checked, lastName: e.target.checked ? '' : visitorForm.lastName })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                      />
                      <label htmlFor="lastNameUnknown" className="ml-2 block text-sm text-gray-900">
                        Unknown
                      </label>
                    </div>
                  </div>
                </div>

                {/* Add Spouse */}
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">
                    Family Members
                  </label>
                  <button
                    type="button"
                    onClick={() => setVisitorForm({ ...visitorForm, hasSpouse: !visitorForm.hasSpouse })}
                    className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-primary-700 bg-primary-100 hover:bg-primary-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                  >
                    {visitorForm.hasSpouse ? 'Remove Spouse' : 'Add Spouse'}
                  </button>
                </div>
                {/* Spouse Fields */}
                {visitorForm.hasSpouse && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-6 border-l-2 border-gray-200">
                    <div>
                      <label htmlFor="spouseFirstName" className="block text-sm font-medium text-gray-700">
                        Spouse First Name
                      </label>
                      <input
                        id="spouseFirstName"
                        type="text"
                        value={visitorForm.spouseFirstName}
                        onChange={(e) => setVisitorForm({ ...visitorForm, spouseFirstName: e.target.value })}
                        disabled={visitorForm.spouseFirstNameUnknown}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                        placeholder="First name"
                      />
                      <div className="flex items-center mt-1">
                        <input
                          id="spouseFirstNameUnknown"
                          type="checkbox"
                          checked={visitorForm.spouseFirstNameUnknown}
                          onChange={(e) => setVisitorForm({ ...visitorForm, spouseFirstNameUnknown: e.target.checked, spouseFirstName: e.target.checked ? '' : visitorForm.spouseFirstName })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <label htmlFor="spouseFirstNameUnknown" className="ml-2 block text-sm text-gray-900">
                          Unknown
                        </label>
                      </div>
                    </div>
                    <div>
                      <label htmlFor="spouseLastName" className="block text-sm font-medium text-gray-700">
                        Spouse Last Name
                      </label>
                      <input
                        id="spouseLastName"
                        type="text"
                        value={visitorForm.spouseLastName}
                        onChange={(e) => setVisitorForm({ ...visitorForm, spouseLastName: e.target.value })}
                        disabled={visitorForm.spouseLastNameUnknown}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                        placeholder="Last name"
                      />
                      <div className="flex items-center mt-1">
                        <input
                          id="spouseLastNameUnknown"
                          type="checkbox"
                          checked={visitorForm.spouseLastNameUnknown}
                          onChange={(e) => setVisitorForm({ ...visitorForm, spouseLastNameUnknown: e.target.checked, spouseLastName: e.target.checked ? '' : visitorForm.spouseLastName })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <label htmlFor="spouseLastNameUnknown" className="ml-2 block text-sm text-gray-900">
                          Unknown
                        </label>
                      </div>
                    </div>
                  </div>
                )}
                {/* Children Section */}
                {visitorForm.personType === 'visitor' && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between">
                      <label className="block text-sm font-medium text-gray-700">
                        Children (up to 10)
                      </label>
                      {visitorForm.children.length < 10 && (
                        <button
                          type="button"
                          onClick={addChild}
                          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-primary-700 bg-primary-100 hover:bg-primary-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                        >
                          Add Child
                        </button>
                      )}
                    </div>
                    {visitorForm.children.map((child, index) => (
                      <div key={index} className="mt-2 pl-6 border-l-2 border-gray-200">
                        <div className="grid grid-cols-1 gap-4 relative">
                          <div>
                            <label htmlFor={`childFirstName-${index}`} className="block text-sm font-medium text-gray-700">
                              Child {index + 1} First Name
                            </label>
                            <input
                              id={`childFirstName-${index}`}
                              type="text"
                              value={child.firstName}
                              onChange={(e) => updateChild(index, { firstName: e.target.value })}
                              disabled={child.firstNameUnknown}
                              className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                              placeholder="First name (optional)"
                            />
                            <div className="flex items-center mt-1">
                              <input
                                id={`childFirstNameUnknown-${index}`}
                                type="checkbox"
                                checked={child.firstNameUnknown}
                                onChange={(e) => updateChild(index, { firstNameUnknown: e.target.checked })}
                                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                              />
                              <label htmlFor={`childFirstNameUnknown-${index}`} className="ml-2 block text-sm text-gray-900">
                                Use placeholder (Child {index + 1})
                              </label>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeChild(index)}
                            className="absolute top-0 right-0 text-sm text-red-600 hover:text-red-700"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Notes field - single notes box for all */}
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
                    disabled={
                      (visitorForm.firstNameUnknown && visitorForm.lastNameUnknown && !visitorForm.notes)
                    }
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                  >
                    Add Person
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Edit Visitor Modal */}
      {showEditVisitorModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
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

                {/* Name Fields */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="editFirstName" className="block text-sm font-medium text-gray-700">
                      First Name
                    </label>
                    <input
                      id="editFirstName"
                      type="text"
                      value={visitorForm.firstName}
                      onChange={(e) => setVisitorForm({ ...visitorForm, firstName: e.target.value })}
                      disabled={visitorForm.firstNameUnknown}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                      placeholder="First name"
                    />
                    <div className="flex items-center mt-1">
                      <input
                        id="editFirstNameUnknown"
                        type="checkbox"
                        checked={visitorForm.firstNameUnknown}
                        onChange={(e) => setVisitorForm({ ...visitorForm, firstNameUnknown: e.target.checked, firstName: e.target.checked ? '' : visitorForm.firstName })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                      />
                      <label htmlFor="editFirstNameUnknown" className="ml-2 block text-sm text-gray-900">
                        Unknown
                      </label>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="editLastName" className="block text-sm font-medium text-gray-700">
                      Last Name
                    </label>
                    <input
                      id="editLastName"
                      type="text"
                      value={visitorForm.lastName}
                      onChange={(e) => setVisitorForm({ ...visitorForm, lastName: e.target.value })}
                      disabled={visitorForm.lastNameUnknown}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                      placeholder="Last name"
                    />
                    <div className="flex items-center mt-1">
                      <input
                        id="editLastNameUnknown"
                        type="checkbox"
                        checked={visitorForm.lastNameUnknown}
                        onChange={(e) => setVisitorForm({ ...visitorForm, lastNameUnknown: e.target.checked, lastName: e.target.checked ? '' : visitorForm.lastName })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                      />
                      <label htmlFor="editLastNameUnknown" className="ml-2 block text-sm text-gray-900">
                        Unknown
                      </label>
                    </div>
                  </div>
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
                    disabled={
                      (visitorForm.firstNameUnknown && visitorForm.lastNameUnknown && !visitorForm.notes)
                    }
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                  >
                    Update Visitor
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AttendancePage; 