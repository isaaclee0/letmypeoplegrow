import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { individualsAPI, familiesAPI, gatheringsAPI, csvImportAPI } from '../services/api';
import { useToast } from '../components/ToastContainer';
import ActionMenu from '../components/ActionMenu';
import {
  UserGroupIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  XMarkIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline';

interface Person {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  familyId?: number;
  familyName?: string;
  // Optional last attendance metadata if provided by API
  lastAttendanceDate?: string;
  gatheringAssignments?: Array<{
    id: number;
    name: string;
  }>;
}

interface Family {
  id: number;
  familyName: string;
  memberCount: number;
  familyType?: 'regular' | 'local_visitor' | 'traveller_visitor';
  // Optional last attended metadata if provided by API
  lastAttended?: string;
}

const PeoplePage: React.FC = () => {

  const { showSuccess } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [people, setPeople] = useState<Person[]>([]);
  const [archivedPeople, setArchivedPeople] = useState<Person[]>([]);
  const [families, setFamilies] = useState<Family[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFamily] = useState<number | null>(null);
  const [selectedGathering, setSelectedGathering] = useState<number | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [showPersonDetails, setShowPersonDetails] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addModalMode, setAddModalMode] = useState<'person' | 'family' | 'csv' | 'copy-paste'>('person');
  // Removed old management modals
  const [selectedGatheringAssignments, setSelectedGatheringAssignments] = useState<{ [key: number]: boolean }>({});
  const [selectedPeopleType, setSelectedPeopleType] = useState<'regular' | 'local_visitor' | 'traveller_visitor'>('regular');
  
  // Mass family management state
  // removed: massEditData / setMassEditData
  
  // Merge functionality state
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeMode, setMergeMode] = useState<'individuals' | 'families' | 'deduplicate'>('individuals');
  const [mergeData, setMergeData] = useState({
    familyName: '',
    familyType: 'regular' as 'regular' | 'local_visitor' | 'traveller_visitor',
    mergeAssignments: true,
    keepFamilyId: null as number | null,
    mergeFamilyIds: [] as number[]
  });
  
  // Combined family/person modal state
  const [familyMembers, setFamilyMembers] = useState<Array<{firstName: string, lastName: string}>>([{firstName: '', lastName: ''}]);
  const [familyName, setFamilyName] = useState('');
  const [useSameSurname, setUseSameSurname] = useState(false);

  // Form states
  const [personForm, setPersonForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    familyId: ''
  });



  const [csvData, setCsvData] = useState('');
  const [copyPasteData, setCopyPasteData] = useState('');
  const [selectedPeople, setSelectedPeople] = useState<number[]>([]);
  const [gatheringTypes, setGatheringTypes] = useState<Array<{id: number, name: string}>>([]);

  const [selectedGatheringId, setSelectedGatheringId] = useState<number | null>(null);
  // New unified editors state
  const [showPersonEditor, setShowPersonEditor] = useState(false);
  const [personEditorData, setPersonEditorData] = useState<{
    id: number;
    firstName: string;
    lastName: string;
    peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
    familyInput: string;
    selectedFamilyId: number | null;
    newFamilyName: string;
    assignments: { [key: number]: boolean };
    originalAssignments: Set<number>;
  }>({ id: 0, firstName: '', lastName: '', peopleType: 'regular', familyInput: '', selectedFamilyId: null, newFamilyName: '', assignments: {}, originalAssignments: new Set() });

  const [showMassEditModal, setShowMassEditModal] = useState(false);
  const [massEdit, setMassEdit] = useState<{
    familyInput: string;
    selectedFamilyId: number | null;
    newFamilyName: string;
    lastName: string;
    peopleType: '' | 'regular' | 'local_visitor' | 'traveller_visitor';
    useAssignments: boolean;
    assignments: { [key: number]: boolean };
  }>({ familyInput: '', selectedFamilyId: null, newFamilyName: '', lastName: '', peopleType: '', useAssignments: false, assignments: {} });

  const [showFamilyEditorModal, setShowFamilyEditorModal] = useState(false);
  const [familyEditor, setFamilyEditor] = useState<{
    familyId: number;
    familyName: string;
    familyType: 'regular' | 'local_visitor' | 'traveller_visitor';
    memberIds: number[];
    addMemberQuery: string;
  }>({ familyId: 0, familyName: '', familyType: 'regular', memberIds: [], addMemberQuery: '' });
  
  // Confirmation modal states
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    personId: number | null;
    personName: string;
  }>({ personId: null, personName: '' });
  const [removeConfirmation, setRemoveConfirmation] = useState<{
    gatheringId: number | null;
    peopleCount: number;
  }>({ gatheringId: null, peopleCount: 0 });

  // UI state for visitor sections
  const [showArchivedVisitors, setShowArchivedVisitors] = useState(false);
  const [showArchivedPeople, setShowArchivedPeople] = useState(false);

  // Color palette for gatherings
  const gatheringColors = [
    'bg-blue-500',
    'bg-green-500', 
    'bg-purple-500',
    'bg-orange-500',
    'bg-pink-500',
    'bg-indigo-500',
    'bg-red-500',
    'bg-yellow-500',
    'bg-teal-500',
    'bg-cyan-500'
  ];

  // Get color for a gathering
  const getGatheringColor = (gatheringId: number) => {
    return gatheringColors[gatheringId % gatheringColors.length];
  };

  useEffect(() => {
    loadPeople();
    loadFamilies();
    loadGatheringTypes();
    loadArchivedPeople();
  }, []);

  const loadPeople = async () => {
    try {
      setIsLoading(true);
      const response = await individualsAPI.getAll();
      const peopleData = response.data.people || [];
      // Deduplicate people by ID to ensure no duplicates are displayed
      const uniquePeople = Array.from(new Map(peopleData.map((person: Person) => [person.id, person])).values()) as Person[];
      // Check for potential duplicates by name (only log in development)
      if (process.env.NODE_ENV === 'development') {
        const nameMap = new Map<string, Person[]>();
        uniquePeople.forEach(person => {
          const key = `${person.firstName.toLowerCase()} ${person.lastName.toLowerCase()}`;
          if (!nameMap.has(key)) {
            nameMap.set(key, []);
          }
          nameMap.get(key)!.push(person);
        });
        const potentialDuplicates = Array.from(nameMap.entries()).filter(([_, persons]) => persons.length > 1);
        if (potentialDuplicates.length > 0) {
          console.log('Potential duplicates found based on name:', potentialDuplicates);
        }
      }
      setPeople(uniquePeople);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load people');
    } finally {
      setIsLoading(false);
    }
  };

  const loadFamilies = async () => {
    try {
      const response = await familiesAPI.getAll();
      setFamilies(response.data.families || []);
    } catch (err: any) {
      setError('Failed to load families');
    }
  };

  const loadArchivedPeople = async () => {
    try {
      const response = await individualsAPI.getArchived();
      setArchivedPeople(response.data.people || []);
    } catch (err: any) {
      console.error('Failed to load archived people', err);
    }
  };

  const loadGatheringTypes = async () => {
    try {
      const response = await gatheringsAPI.getAll();
      setGatheringTypes(response.data.gatherings || []);
    } catch (err: any) {
      console.error('Failed to load gathering types:', err);
    }
  };



  const showDeleteConfirmation = (personId: number, personName: string) => {
    setDeleteConfirmation({ personId, personName });
    setShowDeleteModal(true);
  };

  const handleDeletePerson = async () => {
    if (!deleteConfirmation.personId) return;

    try {
      await individualsAPI.delete(deleteConfirmation.personId);
      
      // Reload people to get the updated list
      await loadPeople();
      showSuccess('Person deleted successfully');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete person');
    }
  };

  const handleCSVUpload = async () => {
    try {
      // TODO: Implement CSV parsing and upload
      console.log('CSV data:', csvData);
      setShowAddModal(false);
      setCsvData('');
      // Reload people after upload
      await loadPeople();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to upload CSV');
    }
  };

  const handleCopyPasteUpload = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      console.log('Sending copy-paste data:', copyPasteData);
      console.log('Selected gathering ID:', selectedGatheringId);
      
      const response = await csvImportAPI.copyPaste(copyPasteData, selectedGatheringId || undefined);
      
      setShowAddModal(false);
      setCopyPasteData('');
      setSelectedGatheringId(null);
      
      // Show success message
      const successMessage = response.data.message || `Import completed! Imported: ${response.data.imported} people, Families: ${response.data.families}, Duplicates: ${response.data.duplicates}, Skipped: ${response.data.skipped}`;
      showSuccess(successMessage);
      
      // Log detailed information for debugging
      if (response.data.details) {
        console.log('Import details:', response.data.details);
        if (response.data.details.duplicates && response.data.details.duplicates.length > 0) {
          console.log('Duplicates found:', response.data.details.duplicates);
        }
        if (response.data.details.imported && response.data.details.imported.length > 0) {
          console.log('Successfully imported:', response.data.details.imported);
        }
      }
      
      // Reload people after upload
      await loadPeople();
    } catch (err: any) {
      console.error('Copy-paste error:', err);
      console.error('Error response:', err.response?.data);
      
      let errorMessage = 'Failed to process data';
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



  const handleMassRemove = async () => {
    if (!removeConfirmation.gatheringId) return;

    try {
      setIsLoading(true);
      setError('');
      
      const response = await csvImportAPI.massRemove(removeConfirmation.gatheringId, selectedPeople);
      
      showSuccess(`Mass removal completed! Removed: ${response.data.removed} people`);
      
      setSelectedPeople([]);
      await loadPeople();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to remove people from service');
    } finally {
      setIsLoading(false);
    }
  };

  const togglePersonSelection = (personId: number) => {
    setSelectedPeople(prev => 
      prev.includes(personId) 
        ? prev.filter(id => id !== personId)
        : [...prev, personId]
    );
  };

  const archivePerson = async (personId: number) => {
    try {
      setIsLoading(true);
      setError('');
      await individualsAPI.delete(personId); // soft delete (archive)
      await loadPeople();
      await loadArchivedPeople();
      showSuccess('Person archived');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to archive person');
    } finally {
      setIsLoading(false);
    }
  };

  const restorePerson = async (personId: number) => {
    try {
      setIsLoading(true);
      setError('');
      await individualsAPI.restore(personId);
      await loadPeople();
      await loadArchivedPeople();
      showSuccess('Person restored');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to restore person');
    } finally {
      setIsLoading(false);
    }
  };

  // const selectAllPeople = () => {
  //   setSelectedPeople([...people.map(person => person.id)]);
  // };

  const clearSelection = () => {
    setSelectedPeople([]);
  };



  // Group people by family
  const groupedPeople = people.reduce((groups, person) => {
    // Only include regular attendees in this main list
    if (person.peopleType !== 'regular') {
      return groups;
    }
    if (person.familyId && person.familyName) {
      // Group by family if person has a family
      const familyKey = `family_${person.familyId}`;
      if (!groups[familyKey]) {
        groups[familyKey] = {
          familyId: person.familyId,
          familyName: person.familyName,
          members: []
        };
      }
      groups[familyKey].members.push(person);
    } else {
      // List individuals without family in a single group
      const individualGroupKey = 'individuals';
      if (!groups[individualGroupKey]) {
        groups[individualGroupKey] = {
          familyId: null,
          familyName: null,
          members: []
        };
      }
      groups[individualGroupKey].members.push(person);
    }
    return groups;
  }, {} as any);

  // Group visitors by family (separate from regular list)
  const groupedVisitors = useMemo(() => {
    return people.reduce((groups, person) => {
      if (person.peopleType !== 'local_visitor' && person.peopleType !== 'traveller_visitor') {
        return groups;
      }
      if (person.familyId && person.familyName) {
        const familyKey = `family_${person.familyId}`;
        if (!groups[familyKey]) {
          groups[familyKey] = {
            familyId: person.familyId,
            familyName: person.familyName,
            members: [] as Person[]
          };
        }
        groups[familyKey].members.push(person);
      } else {
        const individualGroupKey = 'individuals';
        if (!groups[individualGroupKey]) {
          groups[individualGroupKey] = {
            familyId: null,
            familyName: null,
            members: [] as Person[]
          };
        }
        groups[individualGroupKey].members.push(person);
      }
      return groups;
    }, {} as any);
  }, [people]);

  // Filter groups based on search term and family selection
  const filteredGroupedPeople = Object.values(groupedPeople).filter((group: any) => {
    // Filter by gathering selection
    if (selectedGathering !== null) {
      // Only show families that have at least one member assigned to the selected gathering
      const hasMemberInGathering = group.members.some((member: Person) => 
        member.gatheringAssignments?.some(gathering => gathering.id === selectedGathering)
      );
      if (!hasMemberInGathering) return false;
      
      // Filter members within the family to only show those assigned to the selected gathering
      group.members = group.members.filter((member: Person) => 
        member.gatheringAssignments?.some(gathering => gathering.id === selectedGathering)
      );
      
      // Don't show empty families
      if (group.members.length === 0) return false;
    }
    
    // Filter by family selection (if still using this)
    if (selectedFamily !== null) {
      return group.familyId === selectedFamily;
    }
    
    // Filter by search term
    if (!searchTerm.trim()) return true;
    
    const searchLower = searchTerm.toLowerCase();
    
    // Check if any family member's name contains the search term
    return group.members.some((member: Person) => {
      const fullName = `${member.firstName} ${member.lastName}`.toLowerCase();
      const familyName = member.familyName?.toLowerCase() || '';
      return fullName.includes(searchLower) || familyName.includes(searchLower);
    });
  });

  // Sort members within each group
  filteredGroupedPeople.forEach((group: any) => {
    group.members.sort((a: Person, b: Person) => {
      // Sort by last name, then first name
      const lastNameComparison = a.lastName.localeCompare(b.lastName);
      if (lastNameComparison !== 0) return lastNameComparison;
      return a.firstName.localeCompare(b.firstName);
    });
  });

  // Build visitor groups filtered by selected gathering
  const filteredVisitorGroups = useMemo(() => {
    const groupsArray: any[] = Object.values(groupedVisitors);
    // Apply gathering filter if selected
    const result = groupsArray.filter((group: any) => {
      if (selectedGathering !== null) {
        const hasInGathering = group.members.some((member: Person) =>
          member.gatheringAssignments?.some(g => g.id === selectedGathering)
        );
        if (!hasInGathering) return false;
        group.members = group.members.filter((member: Person) =>
          member.gatheringAssignments?.some(g => g.id === selectedGathering)
        );
        if (group.members.length === 0) return false;
      }
      return true;
    });
    // Sort members in each group
    result.forEach((group: any) => {
      group.members.sort((a: Person, b: Person) => {
        const ln = a.lastName.localeCompare(b.lastName);
        if (ln !== 0) return ln;
        return a.firstName.localeCompare(b.firstName);
      });
    });
    return result;
  }, [groupedVisitors, selectedGathering]);

  // Split visitors into recent (<= 6 weeks) and older (> 6 weeks)
  const SIX_WEEKS_DAYS = 42;
  const parseISO = (s?: string) => {
    if (!s) return undefined;
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
  };
  const daysSince = (d?: Date) => {
    if (!d) return Infinity;
    const ms = Date.now() - d.getTime();
    return ms / (1000 * 60 * 60 * 24);
  };
  const getGroupLastAttended = (group: any): number => {
    // Prefer family's lastAttended if available
    if (group.familyId) {
      const fam = families.find(f => f.id === group.familyId);
      const famDate = parseISO(fam?.lastAttended as any);
      if (famDate) return daysSince(famDate);
    }
    // Fallback to latest member lastAttendanceDate if present
    let latest: Date | undefined = undefined;
    group.members.forEach((m: Person) => {
      const d = parseISO((m as any).lastAttendanceDate as any);
      if (d && (!latest || d > latest)) latest = d;
    });
    return daysSince(latest);
  };

  const recentVisitorGroups = useMemo(() => {
    return filteredVisitorGroups.filter(group => getGroupLastAttended(group) <= SIX_WEEKS_DAYS);
  }, [filteredVisitorGroups, families]);

  const olderVisitorGroups = useMemo(() => {
    return filteredVisitorGroups.filter(group => getGroupLastAttended(group) > SIX_WEEKS_DAYS);
  }, [filteredVisitorGroups, families]);

  // Calculate people count for display
  const peopleCount: number = filteredGroupedPeople.reduce((total: number, group: any) => total + group.members.length, 0);

  const openAddModal = (mode: 'person' | 'family' | 'csv' | 'copy-paste') => {
    setAddModalMode(mode);
    setShowAddModal(true);
    setError('');
    
    // Initialize combined family/person modal
    if (mode === 'person' || mode === 'family') {
      setFamilyMembers([{firstName: '', lastName: ''}]);
      setFamilyName('');
      setUseSameSurname(false);
    }
  };

  const addFamilyMember = () => {
    const newMember = {firstName: '', lastName: ''};
    if (useSameSurname && familyMembers.length > 0) {
      newMember.lastName = familyMembers[0].lastName;
    }
    const updatedMembers = [...familyMembers, newMember];
    setFamilyMembers(updatedMembers);
    generateFamilyName(updatedMembers);
  };

  const removeFamilyMember = (index: number) => {
    if (familyMembers.length > 1) {
      const updatedMembers = familyMembers.filter((_, i) => i !== index);
      setFamilyMembers(updatedMembers);
      generateFamilyName(updatedMembers);
    }
  };

  const updateFamilyMember = (index: number, field: 'firstName' | 'lastName', value: string) => {
    const updatedMembers = [...familyMembers];
    updatedMembers[index][field] = value;
    setFamilyMembers(updatedMembers);
    
    // Auto-generate family name
    generateFamilyName(updatedMembers);
    
    // Apply same surname to all members if checkbox is checked
    if (field === 'lastName' && useSameSurname && index === 0) {
      updatedMembers.forEach((member, i) => {
        if (i > 0) {
          member.lastName = value;
        }
      });
      setFamilyMembers(updatedMembers);
      generateFamilyName(updatedMembers);
    }
  };

  // Memoized family name computation to avoid recomputes on frequent handler invocations
  const computedFamilyName = useMemo(() => {
    const validMembers = familyMembers.filter(member => member.firstName.trim() && member.lastName.trim());
    
    if (validMembers.length === 0) {
      return '';
    }
    
    if (validMembers.length === 1) {
      return `${validMembers[0].lastName}, ${validMembers[0].firstName}`;
    }
    
    // Multiple members: "SURNAME, Person1 and Person2" - enhanced for i18n
    const surname = validMembers[0].lastName;
    const firstNames = validMembers.map(member => member.firstName);
    
    // Use Intl.ListFormat for better internationalization support
    try {
      const listFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
      const formattedNames = listFormatter.format(firstNames);
      return `${surname}, ${formattedNames}`;
    } catch (error) {
      // Fallback to manual formatting if Intl.ListFormat is not supported
      const lastName = firstNames[firstNames.length - 1];
      const otherNames = firstNames.slice(0, -1);
      
      if (otherNames.length === 0) {
        return `${surname}, ${lastName}`;
      } else {
        return `${surname}, ${otherNames.join(', ')} and ${lastName}`;
      }
    }
  }, [familyMembers]);

  const generateFamilyName = useCallback((members: Array<{firstName: string, lastName: string}>) => {
    const validMembers = members.filter(member => member.firstName.trim() && member.lastName.trim());
    
    if (validMembers.length === 0) {
      setFamilyName('');
      return;
    }
    
    if (validMembers.length === 1) {
      setFamilyName(`${validMembers[0].lastName}, ${validMembers[0].firstName}`);
      return;
    }
    
    // Multiple members: "SURNAME, Person1 and Person2" - enhanced for i18n
    const surname = validMembers[0].lastName;
    const firstNames = validMembers.map(member => member.firstName);
    
    // Use Intl.ListFormat for better internationalization support
    try {
      const listFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
      const formattedNames = listFormatter.format(firstNames);
      setFamilyName(`${surname}, ${formattedNames}`);
    } catch (error) {
      // Fallback to manual formatting if Intl.ListFormat is not supported
      const lastName = firstNames[firstNames.length - 1];
      const otherNames = firstNames.slice(0, -1);
      
      if (otherNames.length === 0) {
        setFamilyName(`${surname}, ${lastName}`);
      } else {
        setFamilyName(`${surname}, ${otherNames.join(', ')} and ${lastName}`);
      }
    }
  }, []);

  const handleCombinedFamilyPerson = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      // Validate that all members have names
      const validMembers = familyMembers.filter(member => 
        member.firstName.trim() && member.lastName.trim()
      );
      
      if (validMembers.length === 0) {
        setError('Please enter at least one family member');
        return;
      }
      
      if (!familyName.trim()) {
        setError('Family name is required');
        return;
      }
      
      console.log('Creating family with name:', familyName);
      console.log('Valid members:', validMembers);
      
      // Create family first
      const familyResponse = await familiesAPI.create({
        familyName: familyName.trim()
      });
      
      console.log('Family created successfully:', familyResponse.data);
      
      const familyId = familyResponse.data.id;
      
      // Add all family members
      for (const member of validMembers) {
        console.log('Creating individual:', member);
        await individualsAPI.create({
          firstName: member.firstName.trim(),
          lastName: member.lastName.trim(),
          familyId: familyId
        });
      }
      
      showSuccess(`Added ${validMembers.length} family member${validMembers.length > 1 ? 's' : ''} to ${familyName}`);
      setShowAddModal(false);
      await loadPeople();
      await loadFamilies();
    } catch (err: any) {
      console.error('Error creating family:', err);
      console.error('Error response:', err.response?.data);
      setError(err.response?.data?.error || 'Failed to add family members');
    } finally {
      setIsLoading(false);
    }
  };

  /*
  const handleManageGatherings = () => {
    // Initialize gathering assignments based on selected people
    const assignments: { [key: number]: boolean } = {};
    
    // Check what gatherings the selected people are currently assigned to
    const selectedPeopleData = people.filter(p => selectedPeople.includes(p.id));
    const allGatheringIds = new Set<number>();
    
    selectedPeopleData.forEach(person => {
      person.gatheringAssignments?.forEach(gathering => {
        allGatheringIds.add(gathering.id);
      });
    });
    
    // Initialize all gatherings as unchecked
    gatheringTypes.forEach(gathering => {
      assignments[gathering.id] = false;
    });
    
    // Check gatherings that ALL selected people are assigned to
    const commonGatherings = Array.from(allGatheringIds).filter(gatheringId => {
      return selectedPeopleData.every(person => 
        person.gatheringAssignments?.some(gathering => gathering.id === gatheringId)
      );
    });
    
    commonGatherings.forEach(gatheringId => {
      assignments[gatheringId] = true;
    });
    
    setSelectedGatheringAssignments(assignments);
    setShowManageGatheringsModal(true);
  };
  */

  /*
  const handleManagePeopleType = () => {
    // Determine the most common type among selected people
    const selectedPeopleData = people.filter(p => selectedPeople.includes(p.id));
    const regularCount = selectedPeopleData.filter(p => p.peopleType === 'regular').length;
    const localVisitorCount = selectedPeopleData.filter(p => p.peopleType === 'local_visitor').length;
    const travellerVisitorCount = selectedPeopleData.filter(p => p.peopleType === 'traveller_visitor').length;
    
    // Set initial type to the most common one
    if (regularCount >= localVisitorCount && regularCount >= travellerVisitorCount) {
      setSelectedPeopleType('regular');
    } else if (localVisitorCount >= travellerVisitorCount) {
      setSelectedPeopleType('local_visitor');
    } else {
      setSelectedPeopleType('traveller_visitor');
    }
    
    // removed: setShowManagePeopleTypeModal(true)
  };
  */

  /*
  const saveGatheringAssignments = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      // Get all gathering IDs that should be assigned
      const gatheringsToAssign = Object.keys(selectedGatheringAssignments)
        .filter(gatheringId => selectedGatheringAssignments[parseInt(gatheringId)])
        .map(gatheringId => parseInt(gatheringId));
      
      // Get all gathering IDs that should be removed
      const gatheringsToRemove = Object.keys(selectedGatheringAssignments)
        .filter(gatheringId => !selectedGatheringAssignments[parseInt(gatheringId)])
        .map(gatheringId => parseInt(gatheringId));
      
      // Process assignments and removals
      for (const gatheringId of gatheringsToAssign) {
        await csvImportAPI.massAssign(gatheringId, selectedPeople);
      }
      
      for (const gatheringId of gatheringsToRemove) {
        await csvImportAPI.massRemove(gatheringId, selectedPeople);
      }
      
      showSuccess(`Updated gathering assignments for ${selectedPeople.length} people`);
      setSelectedPeople([]);
      setShowManageGatheringsModal(false);
      await loadPeople();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update gathering assignments');
    } finally {
      setIsLoading(false);
    }
  };
  */

  /*
  const savePeopleTypeChanges = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      // Now use the specific people type instead of boolean isVisitor
      const response = await csvImportAPI.massUpdatePeopleType(selectedPeople, selectedPeopleType);
      
      showSuccess(`Updated people type for ${response.data.updated} people`);
      setSelectedPeople([]);
      // removed: setShowManagePeopleTypeModal(false)
      await loadPeople();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update people type');
    } finally {
      setIsLoading(false);
    }
  };
  */

  const handleEditPerson = (person: Person) => {
    const original = new Set<number>((person.gatheringAssignments || []).map(g => g.id));
    const assignments: { [key: number]: boolean } = {};
    gatheringTypes.forEach(g => {
      assignments[g.id] = original.has(g.id);
    });
    setPersonEditorData({
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      peopleType: person.peopleType,
      familyInput: person.familyName || '',
      selectedFamilyId: person.familyId || null,
      newFamilyName: '',
      assignments,
      originalAssignments: original,
    });
    setShowPersonEditor(true);
  };

  // removed: handleUpdatePerson

  // removed: handleManageFamilies

  // removed: updateMassEditData

  const handleUseSameSurnameChange = useCallback((checked: boolean) => {
    setUseSameSurname(checked);
    if (checked && familyMembers[0].lastName.trim()) {
      // Fill in all other surnames with the first person's surname
      const updatedMembers = [...familyMembers];
      updatedMembers.forEach((member, i) => {
        if (i > 0) {
          member.lastName = familyMembers[0].lastName;
        }
      });
      setFamilyMembers(updatedMembers);
      generateFamilyName(updatedMembers);
    }
  }, [familyMembers, generateFamilyName]);

  // removed: handleUpdatePeopleFamilies

  const handleMergeIndividuals = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      if (!mergeData.familyName.trim()) {
        setError('Family name is required');
        return;
      }
      
      const response = await familiesAPI.mergeIndividuals({
        individualIds: selectedPeople,
        familyName: mergeData.familyName.trim(),
        familyType: mergeData.familyType,
        mergeAssignments: mergeData.mergeAssignments
      });
      
      showSuccess(`Successfully merged ${selectedPeople.length} individuals into family "${mergeData.familyName}"`);
      setShowMergeModal(false);
      setSelectedPeople([]);
      await loadPeople();
      await loadFamilies();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to merge individuals');
    } finally {
      setIsLoading(false);
    }
  };

  const handleMergeFamilies = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      if (!mergeData.keepFamilyId) {
        setError('Please select a family to keep');
        return;
      }
      
      if (mergeData.mergeFamilyIds.length === 0) {
        setError('Please select families to merge');
        return;
      }
      
      const response = await familiesAPI.merge({
        keepFamilyId: mergeData.keepFamilyId,
        mergeFamilyIds: mergeData.mergeFamilyIds,
        newFamilyName: mergeData.familyName.trim() || undefined,
        newFamilyType: mergeData.familyType
      });
      
      showSuccess(`Successfully merged ${mergeData.mergeFamilyIds.length} families`);
      setShowMergeModal(false);
      setSelectedPeople([]);
      await loadPeople();
      await loadFamilies();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to merge families');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeduplicateIndividuals = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      if (selectedPeople.length < 2) {
        setError('Please select at least 2 individuals to deduplicate');
        return;
      }
      
      // For now, keep the first selected individual and delete the rest
      const keepId = selectedPeople[0];
      const deleteIds = selectedPeople.slice(1);
      
      const response = await individualsAPI.deduplicate({
        keepId,
        deleteIds,
        mergeAssignments: mergeData.mergeAssignments
      });
      
      showSuccess(`Successfully deduplicated ${deleteIds.length} individuals`);
      setShowMergeModal(false);
      setSelectedPeople([]);
      await loadPeople();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to deduplicate individuals');
    } finally {
      setIsLoading(false);
    }
  };

  const openMergeModal = (mode: 'individuals' | 'families' | 'deduplicate') => {
    if (selectedPeople.length === 0) {
      setError('Please select at least one person to merge');
      return;
    }
    
    setMergeMode(mode);
    setMergeData({
      familyName: '',
      familyType: 'regular',
      mergeAssignments: true,
      keepFamilyId: null,
      mergeFamilyIds: []
    });
    setShowMergeModal(true);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white overflow-hidden shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                Manage People
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Manage all people and families in your church
              </p>
            </div>

          </div>
        </div>
      </div>

      {/* Gathering Legend */}
      {gatheringTypes.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-3 sm:px-6">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Gathering Assignments</h3>
            <div className="flex flex-wrap gap-3">
              {gatheringTypes.map((gathering) => (
                <div key={gathering.id} className="flex items-center space-x-2">
                  <div className={`w-3 h-3 rounded-full ${getGatheringColor(gathering.id)}`}></div>
                  <span className="text-sm text-gray-600">{gathering.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      

      {/* Person Editor Modal */}
      {showPersonEditor && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-1/2 lg:w-1/3 max-w-xl p-5 border shadow-lg rounded-md bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">Edit Person</h3>
                <button onClick={() => setShowPersonEditor(false)} className="text-gray-400 hover:text-gray-600">
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-md p-2 mb-3 text-sm text-red-700">{error}</div>
              )}
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">First Name *</label>
                    <input type="text" value={personEditorData.firstName} onChange={(e) => setPersonEditorData(d => ({ ...d, firstName: e.target.value }))} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Last Name *</label>
                    <input type="text" value={personEditorData.lastName} onChange={(e) => setPersonEditorData(d => ({ ...d, lastName: e.target.value }))} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Family</label>
                  <input list="family-options" value={personEditorData.familyInput} onChange={(e) => {
                    const value = e.target.value;
                    const match = families.find(f => f.familyName.toLowerCase() === value.toLowerCase());
                    setPersonEditorData(d => ({ ...d, familyInput: value, selectedFamilyId: match ? match.id : null, newFamilyName: match ? '' : value }));
                  }} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" placeholder="Search or type to create new" />
                  <datalist id="family-options">
                    {families.map(f => (
                      <option key={f.id} value={f.familyName} />
                    ))}
                  </datalist>
                  <div className="text-xs text-gray-500 mt-1">Leave blank for no family</div>
                </div>

                {/* People Type is governed by Family. Hidden in person editor. */}

                {gatheringTypes.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Gathering Assignments</label>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-1">
                      {gatheringTypes.map(g => (
                        <label key={g.id} className="flex items-center space-x-2 text-sm">
                          <input type="checkbox" checked={!!personEditorData.assignments[g.id]} onChange={() => setPersonEditorData(d => ({ ...d, assignments: { ...d.assignments, [g.id]: !d.assignments[g.id] } }))} className="rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                          <span>{g.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex justify-end space-x-3 pt-2">
                  <button onClick={() => setShowPersonEditor(false)} className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
                  <button onClick={async () => {
                    try {
                      setIsLoading(true);
                      setError('');
                      // Resolve family
                      let familyIdToUse: number | undefined = undefined;
                      const input = personEditorData.familyInput.trim();
                      if (input) {
                        const match = families.find(f => f.familyName.toLowerCase() === input.toLowerCase());
                        if (match) {
                          familyIdToUse = match.id;
                        } else {
                          const created = await familiesAPI.create({ familyName: input });
                          familyIdToUse = created.data.id;
                        }
                      }

                      await individualsAPI.update(personEditorData.id, {
                        firstName: personEditorData.firstName.trim(),
                        lastName: personEditorData.lastName.trim(),
                        familyId: familyIdToUse,
                      });

                      // Sync gathering assignments
                      for (const g of gatheringTypes) {
                        const want = !!personEditorData.assignments[g.id];
                        const had = personEditorData.originalAssignments.has(g.id);
                        if (want && !had) {
                          await individualsAPI.assignToGathering(personEditorData.id, g.id);
                        } else if (!want && had) {
                          await individualsAPI.unassignFromGathering(personEditorData.id, g.id);
                        }
                      }

                      showSuccess('Person updated');
                      setShowPersonEditor(false);
                      await loadPeople();
                      await loadFamilies();
                    } catch (err: any) {
                      setError(err.response?.data?.error || 'Failed to update person');
                    } finally {
                      setIsLoading(false);
                    }
                  }} className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700">Save</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mass Edit Modal */}
      {showMassEditModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-2/3 lg:w-1/2 max-w-3xl p-5 border shadow-lg rounded-md bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">Edit {selectedPeople.length} Selected</h3>
                <button onClick={() => setShowMassEditModal(false)} className="text-gray-400 hover:text-gray-600">
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Family (optional)</label>
                  <input list="family-options" value={massEdit.familyInput} onChange={(e) => {
                    const value = e.target.value;
                    const match = families.find(f => f.familyName.toLowerCase() === value.toLowerCase());
                    setMassEdit(d => ({ ...d, familyInput: value, selectedFamilyId: match ? match.id : null, newFamilyName: match ? '' : value }));
                  }} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" placeholder="Search or type to create new" />
                  <div className="text-xs text-gray-500 mt-1">Leave blank to keep existing families</div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Last Name (optional)</label>
                  <input type="text" value={massEdit.lastName} onChange={(e) => setMassEdit(d => ({ ...d, lastName: e.target.value }))} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" placeholder="Set last name for all selected" />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">People Type (optional)</label>
                  <select value={massEdit.peopleType} onChange={(e) => setMassEdit(d => ({ ...d, peopleType: e.target.value as any }))} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500">
                    <option value="">Do not change</option>
                    <option value="regular">Regular</option>
                    <option value="local_visitor">Local Visitor</option>
                    <option value="traveller_visitor">Traveller Visitor</option>
                  </select>
                </div>

                {gatheringTypes.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="block text-sm font-medium text-gray-700">Gathering Assignments</label>
                      <label className="flex items-center space-x-2 text-xs text-gray-600">
                        <input type="checkbox" checked={massEdit.useAssignments} onChange={(e) => setMassEdit(d => ({ ...d, useAssignments: e.target.checked }))} className="rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                        <span>Set exactly for all selected</span>
                      </label>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {gatheringTypes.map(g => (
                        <label key={g.id} className={`flex items-center space-x-2 text-sm ${!massEdit.useAssignments ? 'opacity-50' : ''}`}>
                          <input type="checkbox" disabled={!massEdit.useAssignments} checked={!!massEdit.assignments[g.id]} onChange={() => setMassEdit(d => ({ ...d, assignments: { ...d.assignments, [g.id]: !d.assignments[g.id] } }))} className="rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                          <span>{g.name}</span>
                        </label>
                      ))}
                    </div>
                    <div className="text-xs text-gray-500">When enabled, saving will make all selected people have exactly these gathering assignments.</div>
                  </div>
                )}

                <div className="flex justify-end space-x-3 pt-2">
                  <button onClick={() => setShowMassEditModal(false)} className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
                  <button onClick={async () => {
                    try {
                      setIsLoading(true);
                      setError('');

                      // Resolve family target if provided
                      let familyIdToUse: number | undefined = undefined;
                      const famInput = massEdit.familyInput.trim();
                      if (famInput) {
                        const match = families.find(f => f.familyName.toLowerCase() === famInput.toLowerCase());
                        if (match) {
                          familyIdToUse = match.id;
                        } else {
                          const created = await familiesAPI.create({ familyName: famInput });
                          familyIdToUse = created.data.id;
                        }
                      }

                      const peopleMap = new Map(people.map(p => [p.id, p]));
                      for (const personId of selectedPeople) {
                        const p = peopleMap.get(personId);
                        if (!p) continue;

                        const payload: any = {
                          firstName: p.firstName,
                          lastName: massEdit.lastName ? massEdit.lastName.trim() : p.lastName,
                        };
                        if (familyIdToUse !== undefined) payload.familyId = familyIdToUse;
                        if (massEdit.peopleType) payload.peopleType = massEdit.peopleType;

                        await individualsAPI.update(personId, payload);

                        if (massEdit.useAssignments) {
                          const originalSet = new Set<number>((p.gatheringAssignments || []).map(g => g.id));
                          for (const g of gatheringTypes) {
                            const want = !!massEdit.assignments[g.id];
                            const had = originalSet.has(g.id);
                            if (want && !had) {
                              await individualsAPI.assignToGathering(personId, g.id);
                            } else if (!want && had) {
                              await individualsAPI.unassignFromGathering(personId, g.id);
                            }
                          }
                        }
                      }

                      showSuccess('Updated selected people');
                      setSelectedPeople([]);
                      setShowMassEditModal(false);
                      await loadPeople();
                      await loadFamilies();
                    } catch (err: any) {
                      setError(err.response?.data?.error || 'Failed to update selected people');
                    } finally {
                      setIsLoading(false);
                    }
                  }} className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700">Save Changes</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Family Editor Modal */}
      {showFamilyEditorModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-2/3 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">Edit Family</h3>
                <button onClick={() => setShowFamilyEditorModal(false)} className="text-gray-400 hover:text-gray-600">
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Family Name</label>
                    <input type="text" value={familyEditor.familyName} onChange={(e) => setFamilyEditor(d => ({ ...d, familyName: e.target.value }))} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Family Type</label>
                    <select value={familyEditor.familyType} onChange={(e) => setFamilyEditor(d => ({ ...d, familyType: e.target.value as any }))} className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500">
                      <option value="regular">Regular</option>
                      <option value="local_visitor">Local Visitor</option>
                      <option value="traveller_visitor">Traveller Visitor</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Members</label>
                  <div className="flex items-center space-x-2 mb-2">
                    <input list="people-options" value={familyEditor.addMemberQuery} onChange={(e) => setFamilyEditor(d => ({ ...d, addMemberQuery: e.target.value }))} placeholder="Search people by name" className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" />
                    <button onClick={() => {
                      const name = familyEditor.addMemberQuery.trim().toLowerCase();
                      if (!name) return;
                      const person = people.find(p => `${p.firstName} ${p.lastName}`.toLowerCase() === name);
                      if (person && !familyEditor.memberIds.includes(person.id)) {
                        setFamilyEditor(d => ({ ...d, memberIds: [...d.memberIds, person.id], addMemberQuery: '' }));
                      }
                    }} className="px-3 py-2 bg-primary-600 text-white rounded-md text-sm">Add</button>
                  </div>
                  <datalist id="people-options">
                    {people.filter(p => !familyEditor.memberIds.includes(p.id)).map(p => (
                      <option key={p.id} value={`${p.firstName} ${p.lastName}`} />
                    ))}
                  </datalist>
                  <div className="border border-gray-200 rounded-md p-3 max-h-64 overflow-y-auto">
                    {familyEditor.memberIds.length === 0 ? (
                      <div className="text-sm text-gray-500">No members</div>
                    ) : (
                      <div className="space-y-2">
                        {familyEditor.memberIds.map(id => {
                          const p = people.find(pp => pp.id === id);
                          if (!p) return null;
                          return (
                            <div key={id} className="flex items-center justify-between text-sm">
                              <span>{p.firstName} {p.lastName}</span>
                              <button onClick={() => setFamilyEditor(d => ({ ...d, memberIds: d.memberIds.filter(pid => pid !== id) }))} className="text-red-600 hover:text-red-800">Remove</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-2">Adding a member will move them into this family. Removing will detach them from any family.</div>
                </div>

                <div className="flex justify-end space-x-3 pt-2">
                  <button onClick={() => setShowFamilyEditorModal(false)} className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
                  <button onClick={async () => {
                    try {
                      setIsLoading(true);
                      setError('');

                      // Update family name/type
                      await familiesAPI.update(familyEditor.familyId, {
                        familyName: familyEditor.familyName.trim() || undefined,
                        familyType: familyEditor.familyType,
                      });

                      // Determine current members of this family from people
                      const currentMembersArr = people.filter(p => p.familyId === familyEditor.familyId).map(p => p.id);
                      const desiredMembersArr = [...familyEditor.memberIds];

                      const peopleMap = new Map(people.map(p => [p.id, p]));

                      // Add new members
                      for (const id of desiredMembersArr) {
                        if (currentMembersArr.indexOf(id) === -1) {
                          const p = peopleMap.get(id);
                          if (!p) continue;
                          await individualsAPI.update(id, { firstName: p.firstName, lastName: p.lastName, familyId: familyEditor.familyId, peopleType: familyEditor.familyType });
                        }
                      }

                      // Remove members not desired
                      for (const id of currentMembersArr) {
                        if (desiredMembersArr.indexOf(id) === -1) {
                          const p = peopleMap.get(id);
                          if (!p) continue;
                          await individualsAPI.update(id, { firstName: p.firstName, lastName: p.lastName, familyId: undefined });
                        }
                      }

                      // Propagate family type to all desired members (enforce rule)
                      for (const id of desiredMembersArr) {
                        const p = peopleMap.get(id);
                        if (!p) continue;
                        await individualsAPI.update(id, { firstName: p.firstName, lastName: p.lastName, familyId: familyEditor.familyId, peopleType: familyEditor.familyType });
                      }

                      // If family became empty, delete it
                      if (desiredMembersArr.length === 0) {
                        await familiesAPI.delete(familyEditor.familyId);
                      }

                      showSuccess('Family updated');
                      setShowFamilyEditorModal(false);
                      await loadPeople();
                      await loadFamilies();
                    } catch (err: any) {
                      setError(err.response?.data?.error || 'Failed to update family');
                    } finally {
                      setIsLoading(false);
                    }
                  }} className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700">Save</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="text-sm text-red-700">{error}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Search */}
            <div>
              <label htmlFor="search" className="block text-sm font-medium text-gray-700">
                Search People
              </label>
              <div className="mt-1 relative">
                <input
                  type="text"
                  id="search"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Search by name, email, or family..."
                />
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
                </div>
              </div>
            </div>

            {/* Family Filter */}
            <div>
              <label htmlFor="gatheringFilter" className="block text-sm font-medium text-gray-700">
                Filter by Gathering
              </label>
              <select
                id="gatheringFilter"
                value={selectedGathering || ''}
                onChange={(e) => setSelectedGathering(e.target.value ? parseInt(e.target.value) : null)}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="">All Gatherings</option>
                {gatheringTypes.map((gathering) => (
                  <option key={gathering.id} value={gathering.id}>
                    {gathering.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* People List - Grouped by Family */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              People ({peopleCount})
            </h3>
            <div className="flex space-x-3">
              {selectedPeople.length > 0 && (
                <div className="flex items-center space-x-2 text-sm text-gray-600">
                  <span>{selectedPeople.length} selected</span>
                  <button
                    onClick={clearSelection}
                    className="text-primary-600 hover:text-primary-700"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          </div>

          {filteredGroupedPeople.length === 0 ? (
            <div className="text-center py-8">
              <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No people found</h3>
              <p className="mt-1 text-sm text-gray-500">
                {searchTerm || selectedGathering ? 'Try adjusting your search or filters.' : 'Get started by adding your first person.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredGroupedPeople.map((group: any) => (
                <div key={group.familyId || 'individuals'} className="border border-gray-200 rounded-lg p-4">
                  {group.familyName && (
                    <div className="flex justify-between items-center mb-3">
                      <div className="flex items-center space-x-2">
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
                       {(() => {
                         const hasLocalVisitor = group.members.some((m: Person) => m.peopleType === 'local_visitor');
                         const hasTravellerVisitor = group.members.some((m: Person) => m.peopleType === 'traveller_visitor');
                         return (
                           <>
                             {hasLocalVisitor && (
                               <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                                 Local Visitor
                               </span>
                             )}
                             {hasTravellerVisitor && (
                               <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                                 Traveller Visitor
                               </span>
                             )}
                           </>
                         );
                       })()}
                        <button
                          onClick={() => {
                            const fam = families.find(f => f.id === group.familyId);
                            setFamilyEditor({
                              familyId: group.familyId,
                              familyName: group.familyName,
                              familyType: fam?.familyType || 'regular',
                              memberIds: group.members.map((m: Person) => m.id),
                              addMemberQuery: ''
                            });
                            setShowFamilyEditorModal(true);
                          }}
                          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Family Settings"
                        >
                          <PencilIcon className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="text-sm text-gray-500">
                          {group.members.length} member{group.members.length !== 1 ? 's' : ''}
                        </span>
                        <input
                          type="checkbox"
                          checked={group.members.every((person: Person) => selectedPeople.includes(person.id))}
                          onChange={() => {
                            const allSelected = group.members.every((person: Person) => selectedPeople.includes(person.id));
                            if (allSelected) {
                              setSelectedPeople(prev => prev.filter(id => !group.members.map((p: Person) => p.id).includes(id)));
                            } else {
                              setSelectedPeople(prev => [...prev, ...group.members.map((p: Person) => p.id)]);
                            }
                          }}
                          className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                    {group.members.map((person: Person) => (
                      <div
                        key={person.id}
                        className={`flex items-center justify-between p-3 rounded-md border-2 ${
                          selectedPeople.includes(person.id)
                            ? 'border-primary-500 bg-primary-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-center space-x-3 flex-1 min-w-0">
                          <input
                            type="checkbox"
                            checked={selectedPeople.includes(person.id)}
                            onChange={() => togglePersonSelection(person.id)}
                            className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900 truncate">
                              {person.firstName} {person.lastName}
                            </div>
                            <div className="text-xs text-gray-500">
                              {person.peopleType === 'regular' ? 'Regular' : person.peopleType === 'local_visitor' ? 'Local Visitor' : 'Traveller Visitor'}
                            </div>
                            {person.gatheringAssignments && person.gatheringAssignments.length > 0 && (
                              <div className="flex items-center space-x-1 mt-1">
                                {person.gatheringAssignments.map(gathering => (
                                  <div
                                    key={gathering.id}
                                    className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                                    title={gathering.name}
                                  ></div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <ActionMenu
                          items={[
                            {
                              label: 'Edit',
                              icon: <PencilIcon className="h-4 w-4" />,
                              onClick: () => handleEditPerson(person)
                            },
                            {
                              label: 'Archive',
                              icon: <TrashIcon className="h-4 w-4" />,
                              onClick: () => archivePerson(person.id),
                              className: 'text-red-600 hover:bg-red-50'
                            }
                          ]}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Visitors Section */}
      {people.filter(p => p.peopleType === 'local_visitor' || p.peopleType === 'traveller_visitor').length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg leading-6 font-medium text-gray-900">
                Visitors ({people.filter(p => p.peopleType === 'local_visitor' || p.peopleType === 'traveller_visitor').length})
              </h3>
            </div>
            <div className="space-y-4">
              {/* Recent Visitors (last 6 weeks) */}
              {recentVisitorGroups.length > 0 && (
                <>
                  <h4 className="text-md font-medium text-gray-800">Recent (last 6 weeks)</h4>
                  {recentVisitorGroups
                .map((group: any) => (
                  <div key={`visitor-${group.familyId || 'individuals'}`} className="border border-gray-200 rounded-lg p-4">
                    {group.familyName && (
                      <div className="flex justify-between items-center mb-3">
                        <div className="flex items-center space-x-2">
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
                          {(() => {
                            const hasLocalVisitor = group.members.some((m: Person) => m.peopleType === 'local_visitor');
                            const hasTravellerVisitor = group.members.some((m: Person) => m.peopleType === 'traveller_visitor');
                            return (
                              <>
                                {hasLocalVisitor && (
                                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                                    Local Visitor
                                  </span>
                                )}
                                {hasTravellerVisitor && (
                                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 ml-2">
                                    Traveller Visitor
                                  </span>
                                )}
                              </>
                            );
                          })()}
                          <button
                            onClick={() => {
                              const fam = families.find(f => f.id === group.familyId);
                              setFamilyEditor({
                                familyId: group.familyId,
                                familyName: group.familyName,
                                familyType: fam?.familyType || 'regular',
                                memberIds: group.members.map((m: Person) => m.id),
                                addMemberQuery: ''
                              });
                              setShowFamilyEditorModal(true);
                            }}
                            className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                            title="Family Settings"
                          >
                            <PencilIcon className="h-4 w-4" />
                          </button>
                        </div>
                        <div className="flex items-center space-x-2">
                          <span className="text-sm text-gray-500">
                            {group.members.length} visitor{group.members.length !== 1 ? 's' : ''}
                          </span>
                          <input
                            type="checkbox"
                            checked={group.members.every((person: Person) => selectedPeople.includes(person.id))}
                            onChange={() => {
                              const allSelected = group.members.every((person: Person) => selectedPeople.includes(person.id));
                              if (allSelected) {
                                setSelectedPeople(prev => prev.filter(id => !group.members.map((p: Person) => p.id).includes(id)));
                              } else {
                                setSelectedPeople(prev => [...prev, ...group.members.map((p: Person) => p.id)]);
                              }
                            }}
                            className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                          />
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                      {group.members.map((person: Person) => (
                        <div
                          key={person.id}
                          className={`flex items-center justify-between p-3 rounded-md border-2 ${
                            selectedPeople.includes(person.id)
                              ? 'border-primary-500 bg-primary-50'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <div className="flex items-center space-x-3 flex-1 min-w-0">
                            <input
                              type="checkbox"
                              checked={selectedPeople.includes(person.id)}
                              onChange={() => togglePersonSelection(person.id)}
                              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-gray-900 truncate">
                                {person.firstName} {person.lastName}
                              </div>
                              <div className="text-xs text-gray-500">
                                {person.peopleType === 'local_visitor' ? 'Local Visitor' : 'Traveller Visitor'}
                              </div>
                              {person.gatheringAssignments && person.gatheringAssignments.length > 0 && (
                                <div className="flex items-center space-x-1 mt-1">
                                  {person.gatheringAssignments.map(gathering => (
                                    <div
                                      key={gathering.id}
                                      className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                                      title={gathering.name}
                                    ></div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          <ActionMenu
                            items={[
                              {
                                label: 'Edit',
                                icon: <PencilIcon className="h-4 w-4" />,
                                onClick: () => handleEditPerson(person)
                              },
                                {
                                  label: 'Archive',
                                  icon: <TrashIcon className="h-4 w-4" />,
                                  onClick: () => archivePerson(person.id),
                                  className: 'text-red-600 hover:bg-red-50'
                                }
                            ]}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                  ))}
                </>
              )}

              {/* Less recently attended visitors (suggested word: Infrequent) */}
              {olderVisitorGroups.length > 0 && (
                <div className="mt-6">
                  <div className="flex items-center justify-between">
                    <h4 className="text-md font-medium text-gray-800">Infrequent (not seen in 6+ weeks)</h4>
                    <button
                      type="button"
                      onClick={() => setShowArchivedVisitors(v => !v)}
                      className="text-sm font-medium text-primary-600 hover:text-primary-700"
                    >
                      {showArchivedVisitors ? 'Hide' : `Show (${olderVisitorGroups.reduce((acc, g) => acc + g.members.length, 0)})`}
                    </button>
                  </div>
                  {showArchivedVisitors && (
                    <div className="space-y-4 mt-3">
                      {olderVisitorGroups.map((group: any) => (
                        <div key={`older-visitor-${group.familyId || 'individuals'}`} className="border border-gray-200 rounded-lg p-4">
                          {group.familyName && (
                            <div className="flex justify-between items-center mb-3">
                              <div className="flex items-center space-x-2">
                                <h4 className="text-md font-medium text-gray-900">
                                  {(() => {
                                    const parts = group.familyName.split(', ');
                                    if (parts.length >= 2) {
                                      return `${parts[0].toUpperCase()}, ${parts.slice(1).join(', ')}`;
                                    }
                                    return group.familyName;
                                  })()}
                                </h4>
                              </div>
                              <div className="flex items-center space-x-2">
                                <span className="text-sm text-gray-500">
                                  {group.members.length} visitor{group.members.length !== 1 ? 's' : ''}
                                </span>
                                <input
                                  type="checkbox"
                                  checked={group.members.every((person: Person) => selectedPeople.includes(person.id))}
                                  onChange={() => {
                                    const allSelected = group.members.every((person: Person) => selectedPeople.includes(person.id));
                                    if (allSelected) {
                                      setSelectedPeople(prev => prev.filter(id => !group.members.map((p: Person) => p.id).includes(id)));
                                    } else {
                                      setSelectedPeople(prev => [...prev, ...group.members.map((p: Person) => p.id)]);
                                    }
                                  }}
                                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                />
                              </div>
                            </div>
                          )}
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                            {group.members.map((person: Person) => (
                              <div
                                key={person.id}
                                className={`flex items-center justify-between p-3 rounded-md border-2 ${
                                  selectedPeople.includes(person.id)
                                    ? 'border-primary-500 bg-primary-50'
                                    : 'border-gray-200 hover:border-gray-300'
                                }`}
                              >
                                <div className="flex items-center space-x-3 flex-1 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={selectedPeople.includes(person.id)}
                                    onChange={() => togglePersonSelection(person.id)}
                                    className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
                                  />
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium text-gray-900 truncate">
                                      {person.firstName} {person.lastName}
                                    </div>
                                    <div className="text-xs text-gray-500">
                                      {person.peopleType === 'local_visitor' ? 'Local Visitor' : 'Traveller Visitor'}
                                    </div>
                                    {person.gatheringAssignments && person.gatheringAssignments.length > 0 && (
                                      <div className="flex items-center space-x-1 mt-1">
                                        {person.gatheringAssignments.map(gathering => (
                                          <div
                                            key={gathering.id}
                                            className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                                            title={gathering.name}
                                          ></div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <ActionMenu
                                  items={[
                                    {
                                      label: 'Edit',
                                      icon: <PencilIcon className="h-4 w-4" />,
                                      onClick: () => handleEditPerson(person)
                                    },
                                    {
                                      label: 'Archive',
                                      icon: <TrashIcon className="h-4 w-4" />,
                                      onClick: () => archivePerson(person.id),
                                      className: 'text-red-600 hover:bg-red-50'
                                    }
                                  ]}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Archived People Section */}
      {archivedPeople && archivedPeople.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg leading-6 font-medium text-gray-900">Archived People ({archivedPeople.length})</h3>
              <button
                type="button"
                onClick={() => setShowArchivedPeople(v => !v)}
                className="text-sm font-medium text-primary-600 hover:text-primary-700"
              >
                {showArchivedPeople ? 'Hide' : `Show (${archivedPeople.length})`}
              </button>
            </div>
            {showArchivedPeople && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {archivedPeople.map((person: Person) => (
                  <div key={`arch-${person.id}`} className="flex items-center justify-between p-3 rounded-md border-2 border-gray-200 hover:border-gray-300">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {person.firstName} {person.lastName}
                      </div>
                      <div className="text-xs text-gray-500">
                        {person.peopleType === 'regular' ? 'Regular' : person.peopleType === 'local_visitor' ? 'Local Visitor' : 'Traveller Visitor'}
                      </div>
                    </div>
                    <ActionMenu
                      items={[
                        {
                          label: 'Restore',
                          icon: <ArrowPathIcon className="h-4 w-4" />,
                          onClick: () => restorePerson(person.id)
                        }
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Comprehensive Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  {addModalMode === 'person' && (selectedPerson ? 'Edit Person' : 'Add New People')}
                  {addModalMode === 'csv' && 'Upload CSV File'}
                  {addModalMode === 'copy-paste' && 'Copy & Paste Data'}
                </h3>
                <button
                  onClick={() => setShowAddModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>

              {/* Mode Selection Tabs - styled similar to AttendancePage */}
              <div className="border-b border-gray-200 mb-6">
                <nav className="hidden md:flex -mb-px space-x-2 items-center" aria-label="Tabs">
                  <button
                    onClick={() => setAddModalMode('person')}
                    className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                      addModalMode === 'person'
                        ? 'bg-primary-500 text-white'
                        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    Add People
                  </button>
                  <button
                    onClick={() => setAddModalMode('csv')}
                    className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                      addModalMode === 'csv'
                        ? 'bg-primary-500 text-white'
                        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    CSV Upload
                  </button>
                  <button
                    onClick={() => setAddModalMode('copy-paste')}
                    className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                      addModalMode === 'copy-paste'
                        ? 'bg-primary-500 text-white'
                        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    Copy & Paste
                  </button>
                </nav>
                <nav className="md:hidden -mb-px flex space-x-8" aria-label="Tabs">
                  <button
                    onClick={() => setAddModalMode('person')}
                    className={`whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm ${
                      addModalMode === 'person'
                        ? 'border-primary-500 text-primary-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    Add People
                  </button>
                  <button
                    onClick={() => setAddModalMode('csv')}
                    className={`whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm ${
                      addModalMode === 'csv'
                        ? 'border-primary-500 text-primary-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    CSV Upload
                  </button>
                  <button
                    onClick={() => setAddModalMode('copy-paste')}
                    className={`whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm ${
                      addModalMode === 'copy-paste'
                        ? 'border-primary-500 text-primary-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    Copy & Paste
                  </button>
                </nav>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
                  <div className="text-sm text-red-700">{error}</div>
                </div>
              )}

                            {/* Combined Family/Person Form */}
              {addModalMode === 'person' && (
                <div className="space-y-6">

                  {/* Individual Person Edit Form */}
                  {selectedPerson && (
                    <div className="space-y-4">
                      <h4 className="text-sm font-medium text-gray-700">Edit Person</h4>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            First Name *
                          </label>
                          <input
                            type="text"
                            value={personForm.firstName}
                            onChange={(e) => setPersonForm({...personForm, firstName: e.target.value})}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                            placeholder="First name"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Last Name *
                          </label>
                          <input
                            type="text"
                            value={personForm.lastName}
                            onChange={(e) => setPersonForm({...personForm, lastName: e.target.value})}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                            placeholder="Last name"
                            required
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Family
                        </label>
                        <select
                          value={personForm.familyId}
                          onChange={(e) => setPersonForm({...personForm, familyId: e.target.value})}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        >
                          <option value="">No family</option>
                          {families.map(family => (
                            <option key={family.id} value={family.id}>
                              {family.familyName}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Family Members Form (only show when not editing) */}
                  {!selectedPerson && (
                    <div className="space-y-4">
                      <h4 className="text-sm font-medium text-gray-700">Family Members</h4>
                    
                    {familyMembers.map((member, index) => (
                      <div key={index} className="border border-gray-200 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                          <h5 className="text-sm font-medium text-gray-700">
                            Person {index + 1}
                          </h5>
                          {familyMembers.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeFamilyMember(index)}
                              className="text-red-600 hover:text-red-800 text-sm"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700">
                              First Name *
                            </label>
                            <input
                              type="text"
                              value={member.firstName}
                              onChange={(e) => updateFamilyMember(index, 'firstName', e.target.value)}
                              className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                              placeholder="First name"
                              required
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700">
                              Last Name *
                            </label>
                            <input
                              type="text"
                              value={member.lastName}
                              onChange={(e) => updateFamilyMember(index, 'lastName', e.target.value)}
                              className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                              placeholder="Last name"
                              required
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                    
                    {/* Same Surname Checkbox */}
                    {familyMembers.length > 1 && (
                      <div className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          checked={useSameSurname}
                          onChange={(e) => handleUseSameSurnameChange(e.target.checked)}
                          disabled={!familyMembers[0].lastName.trim()}
                          className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                          title={!familyMembers[0].lastName.trim() ? "Requires first member's last name to be set" : ""}
                        />
                        <span 
                          className={`text-sm ${!familyMembers[0].lastName.trim() ? 'text-gray-400' : 'text-gray-700'}`}
                          title={!familyMembers[0].lastName.trim() ? "Requires first member's last name to be set" : ""}
                        >
                          Use same surname for all family members
                        </span>
                      </div>
                    )}
                    
                    {/* Add Another Family Member Button */}
                    <button
                      type="button"
                      onClick={addFamilyMember}
                      className="w-full py-2 px-4 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-gray-400 hover:text-gray-700 transition-colors"
                    >
                      + Add Another Family Member
                    </button>
                  </div>
                  )}
                  
                  <div className="flex justify-end space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowAddModal(false)}
                      className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={selectedPerson ? async () => { /* removed old edit flow */ } : handleCombinedFamilyPerson}
                      className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                    >
                      {selectedPerson ? 'Update Person' : 'Add People'}
                    </button>
                  </div>
                </div>
              )}

              

              {/* CSV Upload Form */}
              {addModalMode === 'csv' && (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="csvFile" className="block text-sm font-medium text-gray-700">
                      Select CSV File
                    </label>
                    <input
                      id="csvFile"
                      type="file"
                      accept=".csv"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (e) => {
                            setCsvData(e.target?.result as string);
                          };
                          reader.readAsText(file);
                        }
                      }}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>

                  {csvData && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Preview
                      </label>
                      <textarea
                        value={csvData}
                        onChange={(e) => setCsvData(e.target.value)}
                        rows={6}
                        className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="CSV data will appear here..."
                      />
                    </div>
                  )}

                  <div className="text-sm text-gray-500">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <p>Expected CSV format:</p>
                      <a
                        href="/api/csv-import/template"
                        className="ml-4 inline-flex items-center text-primary-600 hover:text-primary-700 font-medium"
                      >
                        Download template
                      </a>
                    </div>
                    <pre className="font-mono text-xs mt-1 bg-gray-50 p-2 rounded border border-gray-200 whitespace-pre-wrap break-words overflow-x-auto">{`FIRST NAME,LAST NAME,FAMILY NAME
John,Smith,"Smith, John and Sarah"
Sarah,Smith,"Smith, John and Sarah"`}</pre>
                  </div>
                  
                  <div className="flex justify-end space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowAddModal(false)}
                      className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCSVUpload}
                      disabled={!csvData}
                      className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                    >
                      Upload
                    </button>
                  </div>
                </div>
              )}

              {/* Copy & Paste Form */}
              {addModalMode === 'copy-paste' && (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="copyPasteData" className="block text-sm font-medium text-gray-700">
                      Paste your data here
                    </label>
                    <textarea
                      id="copyPasteData"
                      value={copyPasteData}
                      onChange={(e) => setCopyPasteData(e.target.value)}
                      rows={10}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      placeholder="Paste data from Excel, Google Sheets, or any tabular format..."
                    />
                  </div>

                 <div className="text-sm text-gray-500">
                   <p>Expected format (tab or comma separated):</p>
                   <pre className="font-mono text-xs mt-1 bg-gray-50 p-2 rounded border border-gray-200 whitespace-pre-wrap break-words overflow-x-auto">FIRST NAME  LAST NAME  FAMILY NAME
John        Smith      Smith, John and Sarah
Sarah       Smith      Smith, John and Sarah</pre>
                   <p className="mt-2 text-xs">Copy rows from Excel/Google Sheets with columns: FIRST NAME, LAST NAME, FAMILY NAME.</p>
                 </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Assign to Service (Optional)
                    </label>
                    <select
                      value={selectedGatheringId || ''}
                      onChange={(e) => setSelectedGatheringId(e.target.value ? parseInt(e.target.value) : null)}
                      className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    >
                      <option value="">Don't assign to any service</option>
                      {gatheringTypes.map(gathering => (
                        <option key={gathering.id} value={gathering.id}>
                          {gathering.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  
                  <div className="flex justify-end space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowAddModal(false)}
                      className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCopyPasteUpload}
                      disabled={!copyPasteData}
                      className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                    >
                      Process Data
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Person Details Modal */}
      {showPersonDetails && selectedPerson && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Person Details
                </h3>
                <button
                  onClick={() => setShowPersonDetails(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <span className="sr-only">Close</span>
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Name</label>
                  <p className="mt-1 text-sm text-gray-900">{selectedPerson.firstName} {selectedPerson.lastName}</p>
                </div>

                {selectedPerson.familyName && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Family</label>
                    <p className="mt-1 text-sm text-gray-900">{selectedPerson.familyName}</p>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700">Type</label>
                  <p className="mt-1 text-sm text-gray-900">
                    {selectedPerson.peopleType === 'regular' ? 'Regular Attendee' : 
                     selectedPerson.peopleType === 'local_visitor' ? 'Local Visitor' : 'Traveller Visitor'}
                  </p>
                </div>

                {selectedPerson.gatheringAssignments && selectedPerson.gatheringAssignments.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Gathering Assignments</label>
                    <div className="mt-1">
                      {selectedPerson.gatheringAssignments.map(gathering => (
                        <span key={gathering.id} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-800 mr-2 mb-2">
                          {gathering.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                
                <div className="flex justify-end pt-4">
                  <button
                    onClick={() => setShowPersonDetails(false)}
                    className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Person Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Confirm Deletion
                </h3>
                <button
                  onClick={() => setShowDeleteModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                <TrashIcon className="h-6 w-6 text-red-600" />
              </div>
              
              <div className="text-center mb-6">
                <p className="text-sm text-gray-500">
                  Are you sure you want to delete <strong>{deleteConfirmation.personName}</strong>? This action cannot be undone.
                </p>
              </div>
              
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowDeleteModal(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    await handleDeletePerson();
                    setShowDeleteModal(false);
                    setDeleteConfirmation({ personId: null, personName: '' });
                  }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Remove People Confirmation Modal */}
      {showRemoveModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Confirm Removal
                </h3>
                <button
                  onClick={() => setShowRemoveModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                <TrashIcon className="h-6 w-6 text-red-600" />
              </div>
              
              <div className="text-center mb-6">
                <p className="text-sm text-gray-500">
                  Are you sure you want to remove <strong>{removeConfirmation.peopleCount} people</strong> from this service? This action cannot be undone.
                </p>
              </div>
              
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowRemoveModal(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    await handleMassRemove();
                    setShowRemoveModal(false);
                    setRemoveConfirmation({ gatheringId: null, peopleCount: 0 });
                  }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        </div>
      )}



             {/* removed: Manage Gatherings Modal */}
       

             {/* Manage People Type Modal */}
      {/* removed: showManagePeopleTypeModal UI */}

             {/* Person Details Modal */}
       {showPersonDetails && selectedPerson && (
         <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
           <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
             <div className="mt-3">
               <div className="flex items-center justify-between mb-4">
                 <h3 className="text-lg font-medium text-gray-900">
                   Person Details
                 </h3>
                 <button
                   onClick={() => setShowPersonDetails(false)}
                   className="text-gray-400 hover:text-gray-600"
                 >
                   <span className="sr-only">Close</span>
                   <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                   </svg>
                 </button>
               </div>
               
               <div className="space-y-4">
                 <div>
                   <label className="block text-sm font-medium text-gray-700">Name</label>
                   <p className="mt-1 text-sm text-gray-900">{selectedPerson.firstName} {selectedPerson.lastName}</p>
                 </div>

                 {selectedPerson.familyName && (
                   <div>
                     <label className="block text-sm font-medium text-gray-700">Family</label>
                     <p className="mt-1 text-sm text-gray-900">{selectedPerson.familyName}</p>
                   </div>
                 )}

                 <div>
                   <label className="block text-sm font-medium text-gray-700">Type</label>
                   <p className="mt-1 text-sm text-gray-900">
                     {selectedPerson.peopleType === 'regular' ? 'Regular Attendee' : 
                      selectedPerson.peopleType === 'local_visitor' ? 'Local Visitor' : 'Traveller Visitor'}
                   </p>
                 </div>

                 {selectedPerson.gatheringAssignments && selectedPerson.gatheringAssignments.length > 0 && (
                   <div>
                     <label className="block text-sm font-medium text-gray-700">Gathering Assignments</label>
                     <div className="mt-1">
                       {selectedPerson.gatheringAssignments.map(gathering => (
                         <span key={gathering.id} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-800 mr-2 mb-2">
                           {gathering.name}
                         </span>
                       ))}
                     </div>
                   </div>
                 )}
                 
                 <div className="flex justify-end pt-4">
                   <button
                     onClick={() => setShowPersonDetails(false)}
                     className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                   >
                     Close
                   </button>
                 </div>
               </div>
             </div>
           </div>
         </div>
       )}

       {/* Delete Person Confirmation Modal */}
       {showDeleteModal && (
         <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
           <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
             <div className="mt-3">
               <div className="flex items-center justify-between mb-4">
                 <h3 className="text-lg font-medium text-gray-900">
                   Confirm Deletion
                 </h3>
                 <button
                   onClick={() => setShowDeleteModal(false)}
                   className="text-gray-400 hover:text-gray-600"
                 >
                   <XMarkIcon className="h-6 w-6" />
                 </button>
               </div>
               
               <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                 <TrashIcon className="h-6 w-6 text-red-600" />
               </div>
               
               <div className="text-center mb-6">
                 <p className="text-sm text-gray-500">
                   Are you sure you want to delete <strong>{deleteConfirmation.personName}</strong>? This action cannot be undone.
                 </p>
               </div>
               
               <div className="flex space-x-3">
                 <button
                   onClick={() => setShowDeleteModal(false)}
                   className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                 >
                   Cancel
                 </button>
                 <button
                   onClick={async () => {
                     await handleDeletePerson();
                     setShowDeleteModal(false);
                     setDeleteConfirmation({ personId: null, personName: '' });
                   }}
                   className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                 >
                   Delete
                 </button>
               </div>
             </div>
           </div>
         </div>
       )}

       {/* Remove People Confirmation Modal */}
       {showRemoveModal && (
         <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
           <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
             <div className="mt-3">
               <div className="flex items-center justify-between mb-4">
                 <h3 className="text-lg font-medium text-gray-900">
                   Confirm Removal
                 </h3>
                 <button
                   onClick={() => setShowRemoveModal(false)}
                   className="text-gray-400 hover:text-gray-600"
                 >
                   <XMarkIcon className="h-6 w-6" />
                 </button>
               </div>
               
               <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                 <TrashIcon className="h-6 w-6 text-red-600" />
               </div>
               
               <div className="text-center mb-6">
                 <p className="text-sm text-gray-500">
                   Are you sure you want to remove <strong>{removeConfirmation.peopleCount} people</strong> from this service? This action cannot be undone.
                 </p>
               </div>
               
               <div className="flex space-x-3">
                 <button
                   onClick={() => setShowRemoveModal(false)}
                   className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                 >
                   Cancel
                 </button>
                 <button
                   onClick={async () => {
                     await handleMassRemove();
                     setShowRemoveModal(false);
                     setRemoveConfirmation({ gatheringId: null, peopleCount: 0 });
                   }}
                   className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                 >
                   Remove
                 </button>
               </div>
             </div>
           </div>
         </div>
       )}

       {/* removed: showEditPersonModal UI */}

       {/* removed: showManageFamiliesModal UI */}
       

       {/* Floating Action Buttons */}
       {selectedPeople.length > 0 ? (
         <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 flex flex-col space-y-2 z-[9999]">
           <div className="flex items-center justify-end space-x-3">
             <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
                Edit Selected
             </div>
             <button
                onClick={() => {
                  const assignments: { [key: number]: boolean } = {};
                  gatheringTypes.forEach(g => { assignments[g.id] = false; });
                  setMassEdit({ familyInput: '', selectedFamilyId: null, newFamilyName: '', lastName: '', peopleType: '', useAssignments: false, assignments });
                  setShowMassEditModal(true);
                }}
               className="w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
                title="Edit Selected"
             >
               <PencilIcon className="h-6 w-6" />
             </button>
           </div>
           {isAdmin && (
               <div className="flex items-center justify-end space-x-3">
                 <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
                  Merge
                 </div>
                 <button
                  onClick={() => openMergeModal('deduplicate')}
                   className="w-14 h-14 bg-orange-600 hover:bg-orange-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
                  title="Merge (deduplicate)"
                 >
                   <ArrowPathIcon className="h-6 w-6" />
                 </button>
               </div>
           )}
         </div>
        ) : (
         <>
           <button
             onClick={() => openAddModal('person')}
             className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-[9999]"
           >
             <PlusIcon className="h-6 w-6" />
           </button>
           {people.length === 0 && (
             <>
                <div className="hidden sm:block fixed bottom-24 right-28 z-[9998] flex items-center space-x-3">
                 <div className="bg-white/90 backdrop-blur rounded-lg shadow-lg border border-primary-200 px-4 py-3 text-primary-800 animate-pulse">
                   <p className="text-base font-semibold">Add your first people</p>
                   <p className="text-xs text-primary-700 mt-1">Click the plus button</p>
                 </div>
                  <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-primary-600 opacity-70">
                    <defs>
                      <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="0" refY="2" orient="auto">
                        <polygon points="0 0, 4 2, 0 4" fill="currentColor" />
                      </marker>
                    </defs>
                    <path d="M10 10 C 70 10, 95 60, 105 105" stroke="currentColor" strokeWidth="4" fill="none" markerEnd="url(#arrowhead)" />
                  </svg>
               </div>
                <span className="pointer-events-none fixed bottom-6 right-6 z-[9998] inline-flex h-16 w-16 rounded-full bg-primary-400/40"></span>
             </>
           )}
         </>
       )}

       {/* Merge Modal */}
       {showMergeModal && (
         <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
           <div className="flex items-center justify-center min-h-screen p-4">
             <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
               <div className="flex items-center justify-between mb-4">
                 <h3 className="text-lg font-medium text-gray-900">
                   {mergeMode === 'individuals' ? 'Merge Individuals into Family' : 
                    mergeMode === 'families' ? 'Merge Families' : 'Deduplicate Individuals'}
                 </h3>
                 <button
                   onClick={() => setShowMergeModal(false)}
                   className="text-gray-400 hover:text-gray-600"
                 >
                   <XMarkIcon className="h-6 w-6" />
                 </button>
               </div>

               {error && (
                 <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
                   <div className="text-sm text-red-700">{error}</div>
                 </div>
               )}

               <div className="space-y-6">
                 {mergeMode === 'individuals' ? (
                   <>
                     <div>
                       <p className="text-sm text-gray-600 mb-4">
                         Merge {selectedPeople.length} selected individuals into a new family. This is useful when people get married or need to be grouped together.
                       </p>
                       
                       <div className="space-y-4">
                         <div>
                           <label className="block text-sm font-medium text-gray-700">
                             Family Name *
                           </label>
                           <input
                             type="text"
                             value={mergeData.familyName}
                             onChange={(e) => setMergeData({...mergeData, familyName: e.target.value})}
                             className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                             placeholder="Enter family name"
                             required
                           />
                         </div>
                         
                         <div>
                           <label className="block text-sm font-medium text-gray-700">
                             Family Type
                           </label>
                           <select
                             value={mergeData.familyType}
                             onChange={(e) => setMergeData({...mergeData, familyType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor'})}
                             className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                           >
                             <option value="regular">Regular Family</option>
                             <option value="local_visitor">Local Visitor Family</option>
                             <option value="traveller_visitor">Traveller Visitor Family</option>
                           </select>
                         </div>
                         
                         <div className="flex items-center space-x-2">
                           <input
                             type="checkbox"
                             checked={mergeData.mergeAssignments}
                             onChange={(e) => setMergeData({...mergeData, mergeAssignments: e.target.checked})}
                             className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                           />
                           <span className="text-sm text-gray-700">
                             Merge gathering assignments from all individuals
                           </span>
                         </div>
                       </div>
                     </div>
                   </>
                 ) : mergeMode === 'families' ? (
                   <>
                     <div>
                       <p className="text-sm text-gray-600 mb-4">
                         Merge families. Select which family to keep and which families to merge into it.
                       </p>
                       
                       <div className="space-y-4">
                         <div>
                           <label className="block text-sm font-medium text-gray-700">
                             Keep Family
                           </label>
                           <select
                             value={mergeData.keepFamilyId || ''}
                             onChange={(e) => setMergeData({...mergeData, keepFamilyId: e.target.value ? parseInt(e.target.value) : null})}
                             className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                           >
                             <option value="">Select family to keep</option>
                             {families.map(family => (
                               <option key={family.id} value={family.id}>
                                 {family.familyName} ({family.memberCount} members)
                               </option>
                             ))}
                           </select>
                         </div>
                         
                         <div>
                           <label className="block text-sm font-medium text-gray-700">
                             New Family Name (Optional)
                           </label>
                           <input
                             type="text"
                             value={mergeData.familyName}
                             onChange={(e) => setMergeData({...mergeData, familyName: e.target.value})}
                             className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                             placeholder="Leave blank to keep current name"
                           />
                         </div>
                         
                         <div>
                           <label className="block text-sm font-medium text-gray-700">
                             New Family Type (Optional)
                           </label>
                           <select
                             value={mergeData.familyType}
                             onChange={(e) => setMergeData({...mergeData, familyType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor'})}
                             className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                           >
                             <option value="regular">Regular Family</option>
                             <option value="local_visitor">Local Visitor Family</option>
                             <option value="traveller_visitor">Traveller Visitor Family</option>
                           </select>
                         </div>
                       </div>
                     </div>
                   </>
                 ) : (
                   <>
                     <div>
                       <p className="text-sm text-gray-600 mb-4">
                         Deduplicate {selectedPeople.length} selected individuals. The first selected individual will be kept, and the rest will be removed. This is useful when the same person has been added multiple times.
                       </p>
                       
                       <div className="space-y-4">
                         <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4">
                           <div className="flex">
                             <div className="text-sm text-yellow-700">
                               <strong>Warning:</strong> This will permanently delete {selectedPeople.length - 1} individual(s). The first selected individual will be kept.
                             </div>
                           </div>
                         </div>
                         
                         <div className="flex items-center space-x-2">
                           <input
                             type="checkbox"
                             checked={mergeData.mergeAssignments}
                             onChange={(e) => setMergeData({...mergeData, mergeAssignments: e.target.checked})}
                             className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                           />
                           <span className="text-sm text-gray-700">
                             Merge gathering assignments from deleted individuals to the kept individual
                           </span>
                         </div>
                       </div>
                     </div>
                   </>
                 )}
                 
                 <div className="flex justify-end space-x-3 pt-4">
                   <button
                     type="button"
                     onClick={() => setShowMergeModal(false)}
                     className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                   >
                     Cancel
                   </button>
                   <button
                     onClick={mergeMode === 'individuals' ? handleMergeIndividuals : 
                              mergeMode === 'families' ? handleMergeFamilies : handleDeduplicateIndividuals}
                     disabled={mergeMode === 'individuals' && !mergeData.familyName.trim()}
                     className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                   >
                     {mergeMode === 'individuals' ? 'Merge Individuals' : 
                      mergeMode === 'families' ? 'Merge Families' : 'Deduplicate Individuals'}
                   </button>
                 </div>
               </div>
             </div>
           </div>
         </div>
       )}
    </div>
  );
};

export default PeoplePage; 