import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { individualsAPI, familiesAPI, gatheringsAPI, csvImportAPI, visitorConfigAPI } from '../services/api';
import { useToast } from '../components/ToastContainer';
import ActionMenu from '../components/ActionMenu';
import MassEditModal from '../components/people/MassEditModal';
import FamilyEditorModal from '../components/people/FamilyEditorModal';
import { generateFamilyName } from '../utils/familyNameUtils';
import { validatePerson, validateMultiplePeople, sanitizeText } from '../utils/validationUtils';
import logger from '../utils/logger';
import {
  UserGroupIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  XMarkIcon,
  ArrowPathIcon,
  DocumentTextIcon,
  InformationCircleIcon
} from '@heroicons/react/24/outline';
import { format } from 'date-fns';
import { parseISO } from 'date-fns';

// Type definitions
interface Person {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  familyId?: number;
  familyName?: string;
  lastAttendanceDate?: string;
  createdAt?: string;
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
  lastAttended?: string;
}

interface GatheringType {
  id: number;
  name: string;
  description?: string;
  dayOfWeek: string;
  startTime: string;
  frequency: string;
  attendanceType?: 'standard' | 'headcount';
}

interface VisitorConfig {
  localVisitorServiceLimit: number;
  travellerVisitorServiceLimit: number;
}

// Custom hook for attendance data
const useAttendanceData = (personId: number | null) => {
  const [attendanceData, setAttendanceData] = useState<{
    lastAttendance: {
      date: string;
      gatheringName: string;
      gatheringId: number;
      recordedAt: string;
    } | null;
    gatheringRegularity: Array<{
      name: string;
      regularity: string;
      attendanceCount: number;
    }>;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAttendanceData = useCallback(async () => {
    if (!personId) {
      setAttendanceData(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      const response = await individualsAPI.getAttendanceHistory(personId);
      setAttendanceData(response.data || response); // Handle both response.data and direct response
    } catch (err: any) {
      console.error('Attendance API error:', err); // Debug log
      setError(err.response?.data?.error || 'Failed to fetch attendance data');
      setAttendanceData(null);
    } finally {
      setIsLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    if (personId) {
      fetchAttendanceData();
    }
  }, [personId, fetchAttendanceData]);

    return { attendanceData, isLoading, error, refetch: fetchAttendanceData };
};

// Attendance Info Button Component
const AttendanceInfoButton: React.FC<{
  personId: number;
  createdAt?: string;
}> = ({ personId, createdAt }) => {
  const { attendanceData, isLoading, error } = useAttendanceData(personId);
  const [showModal, setShowModal] = useState(false);

  const formatDate = (dateString: string) => {
    try {
      return format(parseISO(dateString), 'MMM d, yyyy');
    } catch {
      return dateString;
    }
  };

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="ml-2 text-gray-400 hover:text-blue-500 transition-colors"
        title="View attendance info"
      >
        <InformationCircleIcon className="h-4 w-4" />
      </button>

      {showModal ? createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">Attendance Information</h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            
            {isLoading ? (
              <div className="text-center py-8">
                <div className="text-gray-500">Loading attendance data...</div>
              </div>
            ) : attendanceData ? (
              <div className="space-y-4">
                {attendanceData.lastAttendance ? (
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">Last Attendance</div>
                    <div className="text-lg text-gray-900">
                      {formatDate(attendanceData.lastAttendance.date)} at {attendanceData.lastAttendance.gatheringName}
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">Last Attendance</div>
                    <div className="text-lg text-gray-900 text-gray-500">No attendance records</div>
                  </div>
                )}
                
                {attendanceData.gatheringRegularity.length > 0 ? (
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-2">Regularity by Gathering</div>
                    <div className="space-y-3">
                      {attendanceData.gatheringRegularity.map((gathering, index) => (
                                                             <div key={index} className="bg-gray-50 rounded-lg p-3">
                                       <div className="flex items-center justify-between mb-1">
                                         <span className="font-medium text-gray-900">{gathering.name}</span>
                                       </div>
                                       <div className="flex items-center justify-between">
                                         <span className="text-sm text-gray-600 capitalize">{gathering.regularity}</span>
                                         <span className="text-sm text-gray-600">{gathering.attendanceCount} times</span>
                                       </div>
                                     </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">Regularity</div>
                    <div className="text-lg text-gray-900 text-gray-500">No attendance data available</div>
                  </div>
                )}
                
                                           {createdAt && (
                             <div>
                               <div className="text-sm font-medium text-gray-700 mb-1">Added to System</div>
                               <div className="text-lg text-gray-900">{formatDate(createdAt)}</div>
                             </div>
                           )}
              </div>
            ) : error ? (
              <div className="text-center py-8">
                <div className="text-red-500">Error loading attendance data: {error}</div>
              </div>
            ) : (
              <div className="text-center py-8">
                <div className="text-gray-500">No attendance data found</div>
              </div>
            )}
            
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      ) : null}
    </>
  );
};

const PeoplePage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const location = useLocation();

  const { showSuccess } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [people, setPeople] = useState<Person[]>([]);
  const [archivedPeople, setArchivedPeople] = useState<Person[]>([]);
  const [families, setFamilies] = useState<Family[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFamily, setSelectedFamily] = useState<number | null>(null);
  const [selectedGathering, setSelectedGathering] = useState<number | null>(null);
  // Removed selectedPerson state - no longer used
  // Removed showPersonDetails - not used anymore
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
  const [dedupeKeepId, setDedupeKeepId] = useState<number | null>(null);
  
  // Combined family/person modal state - updated to match visitor modal structure
  interface PersonForm {
    firstName: string;
    lastName: string;
    lastNameUnknown: boolean;
    fillLastNameFromAbove: boolean;
  }

  interface AddPeopleFormState {
    personType: 'regular' | 'local_visitor' | 'traveller_visitor';
    notes: string;
    persons: PersonForm[];
    selectedGatherings: { [key: number]: boolean };
  }

  const [addPeopleForm, setAddPeopleForm] = useState<AddPeopleFormState>({
    personType: 'regular',
    notes: '',
    persons: [{
      firstName: '',
      lastName: '',
      lastNameUnknown: false,
      fillLastNameFromAbove: false
    }],
    selectedGatherings: {}
  });

  // Removed personForm state - no longer used



  const [csvData, setCsvData] = useState('');
  const [copyPasteData, setCopyPasteData] = useState('');
  const [uploadMode, setUploadMode] = useState<'new' | 'update'>('new');
  const [selectedPeople, setSelectedPeople] = useState<number[]>([]);
  const [potentialDuplicates, setPotentialDuplicates] = useState<Array<{firstName: string, lastName: string, reason: string}>>([]);
  const [tsvAnalysis, setTsvAnalysis] = useState<{
    newPeople: number;
    existingPeople: number;
    unknownGatherings: string[];
    totalRows: number;
  } | null>(null);
  const [gatheringTypes, setGatheringTypes] = useState<GatheringType[]>([]);

  const [selectedGatheringId, setSelectedGatheringId] = useState<number | null>(null);
  // Removed individual person editor - using mass edit modal for all edits

  const [showMassEditModal, setShowMassEditModal] = useState(false);
  const [massEdit, setMassEdit] = useState<{
    familyInput: string;
    selectedFamilyId: number | null;
    newFamilyName: string;
    firstName: string;
    lastName: string;
    peopleType: '' | 'regular' | 'local_visitor' | 'traveller_visitor';
    assignments: { [key: number]: boolean };
    originalAssignments: { [key: number]: Set<number> };
    applyToWholeFamily: boolean;
  }>({ familyInput: '', selectedFamilyId: null, newFamilyName: '', firstName: '', lastName: '', peopleType: '', assignments: {}, originalAssignments: {}, applyToWholeFamily: false });
  
  // Add a separate state for the modal's selected count to avoid race conditions
  const [modalSelectedCount, setModalSelectedCount] = useState(0);

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
  const [showPermanentDeleteModal, setShowPermanentDeleteModal] = useState(false);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<{
    personId: number | null;
    personName: string;
  }>({ personId: null, personName: '' });

  // UI state for visitor sections
  const [showArchivedVisitors, setShowArchivedVisitors] = useState(false);
  const [showArchivedPeople, setShowArchivedPeople] = useState(false);
  
  // Grouping and selection state
  const [groupByFamily, setGroupByFamily] = useState(true);
  
  // Notes modal state
  const [showNotesModal, setShowNotesModal] = useState(false);
  const [selectedFamilyForNotes, setSelectedFamilyForNotes] = useState<any>(null);
  const [currentNotes, setCurrentNotes] = useState('');

  // Visitor configuration state
  const [visitorConfig, setVisitorConfig] = useState({
    localVisitorServiceLimit: 6,
    travellerVisitorServiceLimit: 2
  });
  const [showVisitorConfig, setShowVisitorConfig] = useState(false);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);

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

  // Helper function to analyze TSV data for potential duplicates
  const analyzeTSVForDuplicates = useCallback((tsvData: string) => {
    if (!tsvData || people.length === 0) {
      setPotentialDuplicates([]);
      return;
    }

    try {
      const lines = tsvData.trim().split('\n');
      const duplicates: Array<{firstName: string, lastName: string, reason: string}> = [];
      
      // Determine if this is an update operation (all or mostly existing people)
      let existingCount = 0;
      let totalCount = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Skip header row
        if (i === 0 && (line.toLowerCase().includes('first') || line.toLowerCase().includes('name'))) {
          continue;
        }
        
        // Split by tabs
        const columns = line.split('\t');
        if (columns.length < 2) continue;
        
        const firstName = columns[0].trim();
        const lastName = columns[1].trim();
        
        if (!firstName || !lastName) continue;
        
        totalCount++;
        
        // Check for exact name matches
        const exactMatch = people.find(p => 
          p.firstName.toLowerCase() === firstName.toLowerCase() && 
          p.lastName.toLowerCase() === lastName.toLowerCase()
        );
        
        if (exactMatch) {
          existingCount++;
        }
      }
      
      // If most people are existing, this is likely an update operation
      const isUpdateOperation = totalCount > 0 && (existingCount / totalCount) >= 0.8;
      
      // Reset duplicates array for the actual analysis
      const actualDuplicates: Array<{firstName: string, lastName: string, reason: string}> = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Skip header row
        if (i === 0 && (line.toLowerCase().includes('first') || line.toLowerCase().includes('name'))) {
          continue;
        }
        
        // Split by tabs
        const columns = line.split('\t');
        if (columns.length < 2) continue;
        
        const firstName = columns[0].trim();
        const lastName = columns[1].trim();
        
        if (!firstName || !lastName) continue;
        
        // Check for exact name matches
        const exactMatch = people.find(p => 
          p.firstName.toLowerCase() === firstName.toLowerCase() && 
          p.lastName.toLowerCase() === lastName.toLowerCase()
        );
        
        // Only flag exact matches as duplicates if this is NOT an update operation
        if (exactMatch && !isUpdateOperation) {
          actualDuplicates.push({
            firstName,
            lastName,
            reason: 'Exact name match found'
          });
          continue;
        }
        
        // Check for similar names (fuzzy matching) - but not exact matches
        const similarMatches = people.filter(p => {
          const firstNameSimilar = p.firstName.toLowerCase().includes(firstName.toLowerCase()) || 
                                  firstName.toLowerCase().includes(p.firstName.toLowerCase());
          const lastNameSimilar = p.lastName.toLowerCase().includes(lastName.toLowerCase()) || 
                                lastName.toLowerCase().includes(p.lastName.toLowerCase());
          
          // Don't include exact matches in similar matches
          const isExactMatch = p.firstName.toLowerCase() === firstName.toLowerCase() && 
                              p.lastName.toLowerCase() === lastName.toLowerCase();
          
          return firstNameSimilar && lastNameSimilar && !isExactMatch;
        });
        
        if (similarMatches.length > 0) {
          actualDuplicates.push({
            firstName,
            lastName,
            reason: `Similar names found: ${similarMatches.map(p => `${p.firstName} ${p.lastName}`).join(', ')}`
          });
        }
      }
      
      setPotentialDuplicates(actualDuplicates);
    } catch (error) {
      console.error('Error analyzing TSV for duplicates:', error);
      setPotentialDuplicates([]);
    }
  }, [people]);

  // Helper function to analyze TSV data and determine what changes will be made
  const analyzeTSVData = useCallback((tsvData: string) => {
    if (!tsvData || people.length === 0 || gatheringTypes.length === 0) {
      setTsvAnalysis(null);
      return;
    }

    try {
      const lines = tsvData.trim().split('\n');
      let newPeople = 0;
      let existingPeople = 0;
      let totalRows = 0;
      const unknownGatherings = new Set<string>();
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Skip header row
        if (i === 0 && (line.toLowerCase().includes('first') || line.toLowerCase().includes('name'))) {
          continue;
        }
        
        // Split by tabs
        const columns = line.split('\t');
        if (columns.length < 2) continue;
        
        const firstName = columns[0].trim();
        const lastName = columns[1].trim();
        const gatherings = columns[3]?.trim() || '';
        
        if (!firstName || !lastName) continue;
        
        totalRows++;
        
        // Check if person exists
        const existingPerson = people.find(p => 
          p.firstName.toLowerCase() === firstName.toLowerCase() && 
          p.lastName.toLowerCase() === lastName.toLowerCase()
        );
        
        if (existingPerson) {
          existingPeople++;
        } else {
          newPeople++;
        }
        
        // Check for unknown gatherings
        if (gatherings) {
          const gatheringNames = gatherings.split(',').map(g => g.trim()).filter(g => g);
          for (const gatheringName of gatheringNames) {
            const gatheringExists = gatheringTypes.some(gt => 
              gt.name.toLowerCase() === gatheringName.toLowerCase()
            );
            if (!gatheringExists) {
              unknownGatherings.add(gatheringName);
            }
          }
        }
      }
      
      setTsvAnalysis({
        newPeople,
        existingPeople,
        unknownGatherings: Array.from(unknownGatherings),
        totalRows
      });
    } catch (error) {
      console.error('Error analyzing TSV data:', error);
      setTsvAnalysis(null);
    }
  }, [people, gatheringTypes]);

  // Helper function to get optimized display name
  const getPersonDisplayName = (person: Person, familyName?: string) => {
    // If person has a family and their last name matches the family surname, show only first name
    if (familyName && person.lastName) {
      // Extract surname from family name (format: "SURNAME, First and Second")
      const familySurname = familyName.split(',')[0]?.trim().toLowerCase();
      const personSurname = person.lastName.toLowerCase();
      
      if (familySurname === personSurname) {
        return person.firstName;
      }
    }
    
    // Default to full name
    return `${person.firstName} ${person.lastName}`;
  };

  // Helper function to get full display name (always shows surname)
  const getFullPersonDisplayName = (person: Person) => {
    return `${person.firstName} ${person.lastName}`;
  };

  const shouldUseWideLayout = (name: string) => {
    // Names longer than 20 characters or containing very long individual words
    return name.length > 20 || name.split(' ').some(word => word.length > 15);
  };

  // Get color for a gathering
  const getGatheringColor = (gatheringId: number) => {
    return gatheringColors[gatheringId % gatheringColors.length];
  };

  // Filter out headcount gatherings from gathering assignments (they don't need colored dots)
  const getStandardGatheringAssignments = (gatheringAssignments: Array<{id: number; name: string}> | undefined) => {
    if (!gatheringAssignments) return [];
    return gatheringAssignments.filter(gathering => {
      const gatheringType = gatheringTypes.find(gt => gt.id === gathering.id);
      return gatheringType?.attendanceType !== 'headcount';
    });
  };

  useEffect(() => {
    loadPeople();
    loadFamilies();
    loadGatheringTypes();
    loadArchivedPeople();
    loadVisitorConfig();
  }, []);

  // Handle URL parameters for navigation from AttendancePage
  useEffect(() => {
    const familyIdParam = searchParams.get('familyId');
    const searchParam = searchParams.get('search');
    
    if (familyIdParam) {
      const familyId = parseInt(familyIdParam, 10);
      if (!isNaN(familyId)) {
        setSelectedFamily(familyId);
        // Clear search when focusing on a specific family
        setSearchTerm('');
        // Scroll to the family after a brief delay to ensure rendering
        setTimeout(() => {
          const familyElement = document.querySelector(`[data-family-id="${familyId}"]`);
          if (familyElement) {
            familyElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Add a highlight effect
            familyElement.classList.add('ring-2', 'ring-blue-500', 'ring-opacity-50');
            setTimeout(() => {
              familyElement.classList.remove('ring-2', 'ring-blue-500', 'ring-opacity-50');
            }, 3000);
          }
        }, 500);
      }
    } else if (searchParam) {
      // Set search term and clear family selection
      setSearchTerm(decodeURIComponent(searchParam));
      setSelectedFamily(null);
    }
  }, [searchParams, families, people]); // Include families and people to ensure data is loaded

  // Analyze TSV data for potential duplicates and changes when data changes
  useEffect(() => {
    if (csvData) {
      analyzeTSVForDuplicates(csvData);
      analyzeTSVData(csvData);
    } else {
      setPotentialDuplicates([]);
      setTsvAnalysis(null);
    }
  }, [csvData, analyzeTSVForDuplicates, analyzeTSVData]);

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
        const potentialDuplicates = Array.from(nameMap.entries()).filter(([name, persons]) => persons.length > 1);
        if (potentialDuplicates.length > 0) {
          logger.log('Potential duplicates found based on name:', potentialDuplicates);
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
      setIsLoading(true);
      setError('');
      
      logger.log('TSV data:', csvData);
      logger.log('TSV Analysis:', tsvAnalysis);
      
      let response;
      
      // Automatically determine whether to add new people or update existing ones
      // If there are existing people in the TSV, use update mode; otherwise use new mode
      if (tsvAnalysis && tsvAnalysis.existingPeople > 0) {
        // Handle updates to existing people
        logger.log('Processing TSV for updates - found existing people');
        response = await csvImportAPI.updateExisting(csvData);
      } else {
        // Handle new people upload (existing logic)
        const csvBlob = new Blob([csvData], { type: 'text/tsv' });
        const csvFile = new File([csvBlob], 'upload.tsv', { type: 'text/tsv' });
        
        logger.log('Uploading TSV file for new people:', csvFile);
        
        // Upload without assignment since we're handling gatherings in the TSV
        response = await csvImportAPI.copyPaste(csvData);
      }
      
      setShowAddModal(false);
      setCsvData('');
      setSelectedGatheringId(null);
      setUploadMode('new');
      
      // Show success message
      let successMessage;
      if (tsvAnalysis && tsvAnalysis.existingPeople > 0) {
        successMessage = response.data.message || `Update completed! Updated: ${response.data.updated}, Not Found: ${response.data.notFound}, Skipped: ${response.data.skipped}`;
      } else {
        successMessage = response.data.message || `Import completed! Imported: ${response.data.imported} people, Families: ${response.data.families}, Duplicates: ${response.data.duplicates}, Skipped: ${response.data.skipped}`;
      }
      showSuccess(successMessage);
      
      // Log detailed information for debugging
      if (response.data.details) {
        logger.log('Import details:', response.data.details);
        if (tsvAnalysis && tsvAnalysis.existingPeople > 0) {
          if (response.data.details.filter(r => r.status === 'updated').length > 0) {
            logger.log('Successfully updated:', response.data.details.filter(r => r.status === 'updated'));
          }
          if (response.data.details.filter(r => r.status === 'not_found').length > 0) {
            logger.log('Not found:', response.data.details.filter(r => r.status === 'not_found'));
          }
        } else {
          if (response.data.details.duplicates && response.data.details.duplicates.length > 0) {
            logger.log('Duplicates found:', response.data.details.duplicates);
          }
          if (response.data.details.imported && response.data.details.imported.length > 0) {
            logger.log('Successfully imported:', response.data.details.imported);
          }
        }
      }
      
      // Reload people after upload
      await loadPeople();
    } catch (err: any) {
      console.error('TSV upload error:', err);
      console.error('Error response:', err.response?.data);
      
      let errorMessage = 'Failed to upload TSV';
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

  const handleCopyPasteUpload = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      logger.log('Sending copy-paste data:', copyPasteData);
      logger.log('Selected gathering ID:', selectedGatheringId);
      
      const response = await csvImportAPI.copyPaste(copyPasteData, selectedGatheringId || undefined);
      
      setShowAddModal(false);
      setCopyPasteData('');
      setSelectedGatheringId(null);
      
      // Show success message
      const successMessage = response.data.message || `Import completed! Imported: ${response.data.imported} people, Families: ${response.data.families}, Duplicates: ${response.data.duplicates}, Skipped: ${response.data.skipped}`;
      showSuccess(successMessage);
      
      // Log detailed information for debugging
      if (response.data.details) {
        logger.log('Import details:', response.data.details);
        if (response.data.details.duplicates && response.data.details.duplicates.length > 0) {
          logger.log('Duplicates found:', response.data.details.duplicates);
        }
        if (response.data.details.imported && response.data.details.imported.length > 0) {
          logger.log('Successfully imported:', response.data.details.imported);
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

  const confirmPermanentDelete = (personId: number, personName: string) => {
    setPermanentDeleteTarget({ personId, personName });
    setShowPermanentDeleteModal(true);
  };

  const handlePermanentDelete = async () => {
    if (!permanentDeleteTarget.personId) return;
    try {
      setIsLoading(true);
      setError('');
      await individualsAPI.permanentDelete(permanentDeleteTarget.personId);
      await loadArchivedPeople();
      showSuccess('Person permanently deleted');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to permanently delete person');
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

  const selectAllPeople = () => {
    if (groupByFamily) {
      // Select all people in filtered groups
      const allPeopleInGroups = filteredGroupedPeople.reduce((acc: number[], group: any) => {
        return acc.concat(group.members.map((person: Person) => person.id));
      }, []);
      setSelectedPeople(allPeopleInGroups);
    } else {
      // Select all people in individual view
      const allPeopleIds = filteredIndividualPeople.map((person: Person) => person.id);
      setSelectedPeople(allPeopleIds);
    }
  };

  const handleOpenNotes = (family: any) => {
    setSelectedFamilyForNotes(family);
    setCurrentNotes(family.familyNotes || '');
    setShowNotesModal(true);
  };

  const handleSaveNotes = async () => {
    try {
      setIsLoading(true);
      await familiesAPI.update(selectedFamilyForNotes.familyId, { 
        familyNotes: currentNotes 
      });
      
      // Update the local family data
      setFamilies(families.map(family => 
        family.id === selectedFamilyForNotes.familyId 
          ? { ...family, familyNotes: currentNotes }
          : family
      ));
      
      setShowNotesModal(false);
      showSuccess('Family notes updated successfully');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update family notes');
    } finally {
      setIsLoading(false);
    }
  };

  // Load visitor configuration
  const loadVisitorConfig = async () => {
    try {
      const response = await visitorConfigAPI.getConfig();
      setVisitorConfig(response.data);
    } catch (err) {
      console.error('Failed to load visitor config:', err);
      setError('Failed to load visitor configuration');
    }
  };

  // Save visitor configuration
  const saveVisitorConfig = async () => {
    setIsLoadingConfig(true);
    try {
      await visitorConfigAPI.updateConfig(visitorConfig);
      showSuccess('Visitor configuration updated');
      setShowVisitorConfig(false);
    } catch (err) {
      console.error('Failed to save visitor config:', err);
      setError('Failed to save visitor configuration');
    } finally {
      setIsLoadingConfig(false);
    }
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

  // Build visitor groups filtered by selected gathering and search term
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
      
      // Apply search filter to visitors
      if (searchTerm.trim()) {
        const searchLower = searchTerm.toLowerCase();
        const hasMatchingMember = group.members.some((member: Person) => {
          const fullName = `${member.firstName} ${member.lastName}`.toLowerCase();
          const familyName = member.familyName?.toLowerCase() || '';
          return fullName.includes(searchLower) || familyName.includes(searchLower);
        });
        if (!hasMatchingMember) return false;
        
        // Filter members within the group to only show those matching the search
        group.members = group.members.filter((member: Person) => {
          const fullName = `${member.firstName} ${member.lastName}`.toLowerCase();
          const familyName = member.familyName?.toLowerCase() || '';
          return fullName.includes(searchLower) || familyName.includes(searchLower);
        });
        
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
  }, [groupedVisitors, selectedGathering, searchTerm]);

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
    
    // If no attendance date found, check creation dates to avoid showing newly created visitors as "infrequent"
    if (!latest) {
      group.members.forEach((m: Person) => {
        const createdDate = parseISO(m.createdAt);
        if (createdDate && (!latest || createdDate > latest)) latest = createdDate;
      });
    }
    
    return daysSince(latest);
  };

  const recentVisitorGroups = useMemo(() => {
    return filteredVisitorGroups.filter(group => getGroupLastAttended(group) <= SIX_WEEKS_DAYS);
  }, [filteredVisitorGroups, families]);

  const olderVisitorGroups = useMemo(() => {
    return filteredVisitorGroups.filter(group => getGroupLastAttended(group) > SIX_WEEKS_DAYS);
  }, [filteredVisitorGroups, families]);

  // Create individual people list (not grouped by family)
  const filteredIndividualPeople = people.filter((person: Person) => {
    // Only include regular attendees in this main list
    if (person.peopleType !== 'regular') {
      return false;
    }
    
    // Filter by gathering selection
    if (selectedGathering !== null) {
      const hasGatheringAssignment = person.gatheringAssignments?.some(gathering => gathering.id === selectedGathering);
      if (!hasGatheringAssignment) return false;
    }
    
    // Filter by family selection (if still using this)
    if (selectedFamily !== null) {
      return person.familyId === selectedFamily;
    }
    
    // Filter by search term
    if (!searchTerm.trim()) return true;
    
    const searchLower = searchTerm.toLowerCase();
    const fullName = `${person.firstName} ${person.lastName}`.toLowerCase();
    const familyName = person.familyName?.toLowerCase() || '';
    return fullName.includes(searchLower) || familyName.includes(searchLower);
  }).sort((a: Person, b: Person) => {
    // Sort by last name, then first name
    const lastNameComparison = a.lastName.localeCompare(b.lastName);
    if (lastNameComparison !== 0) return lastNameComparison;
    return a.firstName.localeCompare(b.firstName);
  });

  // Calculate people count for display
  const peopleCount: number = groupByFamily 
    ? filteredGroupedPeople.reduce((total: number, group: any) => total + group.members.length, 0)
    : filteredIndividualPeople.length;

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

  const addPerson = () => {
    setAddPeopleForm(prev => {
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
    setAddPeopleForm(prev => ({
      ...prev,
      persons: prev.persons.filter((_, i) => i !== index)
    }));
  };

  const updatePerson = (index: number, updates: Partial<PersonForm>) => {
    setAddPeopleForm(prev => {
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

  // Memoized family name computation to avoid recomputes on frequent handler invocations
  const computedFamilyName = useMemo(() => {
    const validMembers = addPeopleForm.persons.filter(member => 
      member.firstName.trim() && 
      (member.lastName.trim() || member.lastNameUnknown)
    );
    
    if (validMembers.length === 0) {
      return '';
    }
    
    if (validMembers.length === 1) {
      const lastName = validMembers[0].lastNameUnknown ? 'Unknown' : validMembers[0].lastName;
      return `${lastName}, ${validMembers[0].firstName}`;
    }
    
    // Multiple members: "SURNAME, Person1 and Person2" (limit to first two people for consistency)
    const surname = validMembers[0].lastNameUnknown ? 'Unknown' : validMembers[0].lastName;
    // Only include the first two people's first names for consistency
    const firstNames = validMembers.slice(0, 2).map(member => member.firstName);
    
    // Use Intl.ListFormat for better internationalization support
    try {
      const listFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
      const formattedNames = listFormatter.format(firstNames);
      return `${surname}, ${formattedNames}`;
    } catch (error) {
      // Fallback to manual formatting if Intl.ListFormat is not supported
      if (firstNames.length === 1) {
        return `${surname}, ${firstNames[0]}`;
      } else {
        return `${surname}, ${firstNames[0]} and ${firstNames[1]}`;
      }
    }
  }, [addPeopleForm.persons]);


  const handleAddPeople = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      // Validate form
      for (const person of addPeopleForm.persons) {
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
      const people = addPeopleForm.persons.map(person => ({
        firstName: person.firstName.trim(),
        lastName: person.lastNameUnknown ? 'Unknown' : person.lastName.trim(),
        firstUnknown: false,
        lastUnknown: person.lastNameUnknown,
        isChild: false // No distinction
      }));

      const notes = addPeopleForm.notes.trim();
      const familyName = computedFamilyName;

      let response;
      // Choose endpoint based on person type
      if (addPeopleForm.personType === 'regular') {
        // Create regular family
      const familyResponse = await familiesAPI.create({
          familyName: familyName
        });
        
        // Create individuals and assign to family
        const individualPromises = people.map(person => 
          individualsAPI.create({
            firstName: person.firstName,
            lastName: person.lastName,
            familyId: familyResponse.data.familyId
          })
        );
        
        await Promise.all(individualPromises);
        
        // Assign to selected gatherings
        const selectedGatheringIds = Object.keys(addPeopleForm.selectedGatherings)
          .filter(gatheringId => addPeopleForm.selectedGatherings[parseInt(gatheringId)])
          .map(gatheringId => parseInt(gatheringId));
        
        if (selectedGatheringIds.length > 0) {
          const individualIds = await Promise.all(
            people.map(async (person) => {
              const individualResponse = await individualsAPI.create({
                firstName: person.firstName,
                lastName: person.lastName,
                familyId: familyResponse.data.familyId
              });
              return individualResponse.data.individualId;
            })
          );
          
          // Assign all individuals to selected gatherings
          for (const gatheringId of selectedGatheringIds) {
            await csvImportAPI.massAssign(gatheringId, individualIds);
          }
        }
        
        response = { data: { individuals: people.map((person, index) => ({ 
          firstName: person.firstName, 
          lastName: person.lastName,
          id: index + 1 // Temporary ID for display
        })) } };
      } else {
        // Create visitor family
        const familyResponse = await familiesAPI.createVisitorFamily({
          familyName,
          peopleType: addPeopleForm.personType,
          notes: notes ? notes : undefined,
          people
        });
        
        response = { data: { individuals: people.map((person, index) => ({ 
          firstName: person.firstName, 
          lastName: person.lastName,
          id: index + 1 // Temporary ID for display
        })) } };
      }

      // Show success toast
      if (response.data.individuals && response.data.individuals.length > 0) {
        const names = response.data.individuals.map((ind: { firstName: string; lastName: string }) => `${ind.firstName} ${ind.lastName}`).join(', ');
        const personTypeText = addPeopleForm.personType === 'regular' ? 'Added regular family' : 'Added visitor family';
        showSuccess(`${personTypeText}: ${names}`);
      } else {
        showSuccess('Added successfully');
      }

      // Reset form
      setAddPeopleForm({
        personType: 'regular',
        notes: '',
        persons: [{
          firstName: '',
          lastName: '',
          lastNameUnknown: false,
          fillLastNameFromAbove: false
        }],
        selectedGatherings: {}
      });
      
      // Close modal
      setShowAddModal(false);
      
      // Reload data
      await loadData();
      
    } catch (err: any) {
      console.error('Failed to add people:', err);
      setError(err.response?.data?.error || 'Failed to add people');
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
    
    // Initialize all standard gatherings as unchecked
    gatheringTypes
      .filter(gathering => gathering.attendanceType !== 'headcount')
      .forEach(gathering => {
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
    // Use mass edit modal for single person editing
    logger.log('handleEditPerson called with:', person);
    
    const gatheringAssignments: { [key: number]: boolean } = {};
    
    gatheringTypes
      .filter(g => g.attendanceType !== 'headcount')
      .forEach(g => {
        const hasAssignment = person.gatheringAssignments?.some(ga => ga.id === g.id) || false;
        gatheringAssignments[g.id] = hasAssignment;
      });
    
    const originalAssignments: { [key: number]: Set<number> } = {};
    originalAssignments[person.id] = new Set(
      (person.gatheringAssignments || []).map(ga => ga.id)
    );

    const massEditData = {
      familyInput: person.familyName || '',
      selectedFamilyId: person.familyId || null,
      newFamilyName: '',
      firstName: person.firstName,
      lastName: person.lastName,
      peopleType: person.peopleType,
      assignments: gatheringAssignments,
      originalAssignments,
      applyToWholeFamily: false
    };
    
    logger.log('Person data:', person);
    logger.log('Setting massEdit data:', massEditData);
    logger.log('Setting selectedPeople to:', [person.id]);
    
    // Pre-populate mass edit modal with person's data
    setMassEdit(massEditData);
    
    // Select only this person and open modal
    setSelectedPeople([person.id]);
    setModalSelectedCount(1); // Set the count directly for the modal
    
    // Open modal immediately - no need for setTimeout now
    setShowMassEditModal(true);
  };

  // removed: handleUpdatePerson

  // removed: handleManageFamilies

  // removed: updateMassEditData


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
      
      // Use the selected master record
      const keepId = dedupeKeepId ?? selectedPeople[0];
      const deleteIds = selectedPeople.filter(id => id !== keepId);
      
      const response = await individualsAPI.deduplicate({
        keepId,
        deleteIds,
        mergeAssignments: mergeData.mergeAssignments
      });
      
      showSuccess(`Successfully deduplicated ${deleteIds.length} individuals`);
      setShowMergeModal(false);
      setSelectedPeople([]);
      setDedupeKeepId(null);
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
    if (mode === 'deduplicate') {
      setDedupeKeepId(selectedPeople[0]);
    }
    setShowMergeModal(true);
  };

  const downloadPeopleTSV = () => {
    try {
      // Create TSV content
      const headers = ['First Name', 'Last Name', 'Family Name', 'Gatherings'];
      const rows = people.map(person => {
        const gatherings = person.gatheringAssignments?.map(g => g.name).join(', ') || '';
        return [
          person.firstName,
          person.lastName,
          person.familyName || '',
          gatherings
        ];
      });

      // Convert to TSV format
      const tsvContent = [
        headers.join('\t'),
        ...rows.map(row => row.join('\t'))
      ].join('\n');

      // Create and download file
      const blob = new Blob([tsvContent], { type: 'text/tab-separated-values' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `people-export-${new Date().toISOString().split('T')[0]}.tsv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showSuccess('People data exported successfully');
    } catch (error) {
      console.error('Error exporting people data:', error);
      setError('Failed to export people data');
    }
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
            {people.length > 0 && (
              <button
                onClick={downloadPeopleTSV}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
              >
                <DocumentTextIcon className="h-4 w-4 mr-2" />
                Export People
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Gathering Legend */}
      {gatheringTypes.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-3 sm:px-6">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Gathering Assignments</h3>
            <div className="flex flex-wrap gap-3">
              {gatheringTypes
                .filter(gathering => gathering.attendanceType !== 'headcount')
                .map((gathering) => (
                  <div key={gathering.id} className="flex items-center space-x-2">
                    <div className={`w-3 h-3 rounded-full ${getGatheringColor(gathering.id)}`}></div>
                    <span className="text-sm text-gray-600">{gathering.name}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      

      {/* Removed individual person editor modal - now using mass edit modal for all edits */}

      {/* Mass Edit Modal */}
      <MassEditModal
        isOpen={showMassEditModal}
        onClose={() => setShowMassEditModal(false)}
        selectedCount={modalSelectedCount}
        massEdit={massEdit}
        setMassEdit={setMassEdit}
        families={families}
        gatheringTypes={gatheringTypes}
        onSave={async () => {
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
            // If famInput is empty, familyIdToUse remains undefined, 
            // which means we won't include familyId in the payload, preserving existing families

            const peopleMap = new Map(people.map(p => [p.id, p]));
            for (const personId of selectedPeople) {
              const p = peopleMap.get(personId);
              if (!p) continue;

              // Check if we need to update individual data (firstName, family, lastName, peopleType)
              const hasIndividualChanges = massEdit.firstName.trim() || massEdit.lastName.trim() || familyIdToUse !== undefined || massEdit.peopleType;
              
              if (hasIndividualChanges) {
                const payload: any = {
                  firstName: p.firstName, // Always include firstName as it's required
                  lastName: p.lastName, // Always include lastName as it's required
                };
                
                // Only update fields that are actually changed
                if (massEdit.firstName.trim()) {
                  payload.firstName = massEdit.firstName.trim();
                }
                if (massEdit.lastName.trim()) {
                  payload.lastName = massEdit.lastName.trim();
                }
                if (familyIdToUse !== undefined) {
                  payload.familyId = familyIdToUse;
                }
                // Note: If familyIdToUse is undefined and no family input provided, 
                // we don't include familyId in payload, preserving existing family association
                if (massEdit.peopleType) {
                  payload.peopleType = massEdit.peopleType;
                }

                await individualsAPI.update(personId, payload);
              }

              // Handle gathering assignments - only apply changes
              for (const g of gatheringTypes) {
                const want = !!massEdit.assignments[g.id];
                const had = massEdit.originalAssignments[personId]?.has(g.id) || false;
                if (want && !had) {
                  await individualsAPI.assignToGathering(personId, g.id);
                } else if (!want && had) {
                  await individualsAPI.unassignFromGathering(personId, g.id);
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
        }}
        error={error}
        isLoading={isLoading}
      />

      {/* Family Editor Modal */}
      {showFamilyEditorModal ? createPortal(
        <FamilyEditorModal
          isOpen={showFamilyEditorModal}
          onClose={() => setShowFamilyEditorModal(false)}
          familyEditor={familyEditor}
          setFamilyEditor={setFamilyEditor}
          people={people}
          onSave={async () => {
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
          }}
          error={error}
          isLoading={isLoading}
        />,
        document.body
      ) : null}
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
                {gatheringTypes
                  .filter(gathering => gathering.attendanceType !== 'headcount')
                  .map((gathering) => (
                    <option key={gathering.id} value={gathering.id}>
                      {gathering.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          
          {/* Grouping Toggle */}
          <div className="mt-4 pt-4 border-t border-gray-200">
            <div className="flex items-center space-x-3">
              <input
                type="checkbox"
                id="groupByFamily"
                checked={groupByFamily}
                onChange={(e) => {
                  setGroupByFamily(e.target.checked);
                  // Clear selection when switching views to avoid confusion
                  setSelectedPeople([]);
                }}
                className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              />
              <label htmlFor="groupByFamily" className="text-sm font-medium text-gray-700">
                Group people by families
              </label>
              <span className="text-xs text-gray-500">
                (Uncheck for individual view with easier multi-select)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* People List - Grouped by Family */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              People ({peopleCount}) {groupByFamily ? '(Grouped by Family)' : '(Individual View)'}
            </h3>
            <div className="flex space-x-3">
              {selectedPeople.length > 0 ? (
                <div className="flex items-center space-x-2 text-sm text-gray-600">
                  <span>{selectedPeople.length} selected</span>
                  <button
                    onClick={clearSelection}
                    className="text-primary-600 hover:text-primary-700"
                  >
                    Clear
                  </button>
                </div>
              ) : peopleCount > 0 && (
                <button
                  onClick={selectAllPeople}
                  className="text-sm text-primary-600 hover:text-primary-700 font-medium"
                >
                  Select All ({peopleCount})
                </button>
              )}
            </div>
          </div>

          {(groupByFamily ? filteredGroupedPeople.length === 0 : filteredIndividualPeople.length === 0) ? (
            <div className="text-center py-8">
              <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No people found</h3>
              <p className="mt-1 text-sm text-gray-500">
                {searchTerm || selectedGathering ? 'Try adjusting your search or filters.' : 'Get started by adding your first person.'}
              </p>
            </div>
          ) : groupByFamily ? (
            <div className="space-y-4">
              {filteredGroupedPeople.map((group: any) => (
                <div key={group.familyId || 'individuals'} data-family-id={group.familyId} className="border border-gray-200 rounded-lg p-4">
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
                         const hasRegular = group.members.some((m: Person) => m.peopleType === 'regular');
                         return (
                           <>
                             {hasRegular && (
                               <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                 Regular
                               </span>
                             )}
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
                          onClick={() => handleOpenNotes(group)}
                          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Family Notes"
                        >
                          <DocumentTextIcon className="h-4 w-4" />
                        </button>
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
                                                 {group.members.map((person: Person) => {
                               const displayName = getPersonDisplayName(person, group.familyName);
                               const needsWideLayout = shouldUseWideLayout(displayName);

                               return (
                                 <div
                                   key={person.id}
                                   className={`flex items-center justify-between p-3 rounded-md border-2 cursor-pointer transition-colors ${
                                     selectedPeople.includes(person.id)
                                       ? 'border-primary-500 bg-primary-50'
                                       : 'border-gray-200 hover:border-gray-300'
                                   } ${needsWideLayout ? 'col-span-2' : ''}`}
                                   onClick={() => togglePersonSelection(person.id)}
                                 >
                                   <div className="flex items-center space-x-3 flex-1 min-w-0">
                                     <input
                                       type="checkbox"
                                       checked={selectedPeople.includes(person.id)}
                                       onChange={() => togglePersonSelection(person.id)}
                                       className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
                                       onClick={(e) => e.stopPropagation()}
                                     />
                                     <div className="flex-1 min-w-0">
                                       <div className="flex items-center space-x-2">
                                         <span className="text-sm font-medium text-gray-900 truncate">
                                           {displayName}
                                         </span>
                                         <AttendanceInfoButton personId={person.id} createdAt={person.createdAt} />
                                       </div>
                                       <div className="text-xs text-gray-500">
                                         {person.peopleType === 'local_visitor' ? 'Local Visitor' : person.peopleType === 'traveller_visitor' ? 'Traveller Visitor' : ''}
                                       </div>
                                       {(() => {
                                         const standardGatherings = getStandardGatheringAssignments(person.gatheringAssignments);
                                         return standardGatherings.length > 0 && (
                                           <div className="flex items-center space-x-1 mt-1">
                                             {standardGatherings.map(gathering => (
                                               <div
                                                 key={gathering.id}
                                                 className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                                                 title={gathering.name}
                                               ></div>
                                             ))}
                                           </div>
                                         );
                                       })()}
                                     </div>
                                   </div>

                                 </div>
                               );
                             })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            // Individual view (not grouped by family)
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                                     {filteredIndividualPeople.map((person: Person) => {
                         const displayName = getPersonDisplayName(person); // No family context in individual view
                         const needsWideLayout = shouldUseWideLayout(displayName);

                         return (
                           <div
                             key={person.id}
                             className={`p-2 rounded-md border border-gray-200 cursor-pointer transition-colors ${
                               selectedPeople.includes(person.id)
                                 ? 'border-primary-500 bg-primary-50'
                                 : 'hover:bg-gray-50'
                             } ${needsWideLayout ? 'col-span-2' : ''}`}
                             onClick={() => togglePersonSelection(person.id)}
                           >
                             <div className="flex items-center space-x-3">
                               <input
                                 type="checkbox"
                                 checked={selectedPeople.includes(person.id)}
                                 onChange={() => togglePersonSelection(person.id)}
                                 className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
                                 onClick={(e) => e.stopPropagation()}
                               />
                               <div className="flex items-center space-x-2">
                                 <span className="text-sm font-medium text-gray-900">{displayName}</span>
                                 {(() => {
                                   const standardGatherings = getStandardGatheringAssignments(person.gatheringAssignments);
                                   return standardGatherings.length > 0 && (
                                     <div className="flex items-center space-x-1">
                                       {standardGatherings.map(gathering => (
                                         <div
                                           key={gathering.id}
                                           className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                                           title={gathering.name}
                                         ></div>
                                       ))}
                                     </div>
                                   );
                                 })()}
                               </div>
                             </div>
                           </div>
                         );
                       })}
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
                Visitors ({recentVisitorGroups.flatMap(g => g.members).length + olderVisitorGroups.flatMap(g => g.members).length})
              </h3>
              <button
                onClick={() => setShowVisitorConfig(!showVisitorConfig)}
                className="text-sm text-primary-600 hover:text-primary-700 font-medium"
              >
                {showVisitorConfig ? 'Hide Settings' : 'Configure Filtering'}
              </button>
            </div>

            {/* Visitor Configuration Section */}
            {showVisitorConfig && (
              <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
                <h4 className="text-md font-medium text-gray-900 mb-3">Visitor Filtering Configuration</h4>
                <p className="text-sm text-gray-600 mb-4">
                  Configure how long visitors appear in recent visitor lists for attendance taking.
                </p>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Local Visitors (services to keep)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="52"
                      value={visitorConfig.localVisitorServiceLimit}
                      onChange={(e) => setVisitorConfig(prev => ({
                        ...prev,
                        localVisitorServiceLimit: parseInt(e.target.value) || 1
                      }))}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Local visitors appear in recent lists for this many services after their last attendance.
                    </p>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Traveller Visitors (services to keep)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="52"
                      value={visitorConfig.travellerVisitorServiceLimit}
                      onChange={(e) => setVisitorConfig(prev => ({
                        ...prev,
                        travellerVisitorServiceLimit: parseInt(e.target.value) || 1
                      }))}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Traveller visitors appear in recent lists for this many services after their last attendance.
                    </p>
                  </div>
                </div>
                
                <div className="flex justify-end mt-4 space-x-3">
                  <button
                    onClick={() => setShowVisitorConfig(false)}
                    className="px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveVisitorConfig}
                    disabled={isLoadingConfig}
                    className="px-3 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                  >
                    {isLoadingConfig ? 'Saving...' : 'Save Configuration'}
                  </button>
                </div>
              </div>
            )}
            <div className="space-y-4">
              {/* Recent Visitors (configurable service-based filtering) */}
              {recentVisitorGroups.length > 0 && (
                <>
                  <h4 className="text-md font-medium text-gray-800">Recent (based on configured service limits)</h4>
                  {groupByFamily ? (
                    // Grouped by family view
                    <div className="space-y-4">
                      {recentVisitorGroups.map((group: any) => (
                        <div key={`recent-visitor-${group.familyId || 'individuals'}`} className="border border-gray-200 rounded-lg p-4">
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
                                  onClick={() => handleOpenNotes(group)}
                                  className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                  title="Family Notes"
                                >
                                  <DocumentTextIcon className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() => {
                                    const familyId = group.familyId;
                                    if (familyId) {
                                      setFamilyEditor({
                                        familyId,
                                        familyName: group.familyName || '',
                                        familyType: group.members.some((m: Person) => m.peopleType === 'local_visitor') ? 'local_visitor' : 
                                                   group.members.some((m: Person) => m.peopleType === 'traveller_visitor') ? 'traveller_visitor' : 'regular',
                                        memberIds: group.members.map((m: Person) => m.id),
                                        addMemberQuery: ''
                                      });
                                      setShowFamilyEditorModal(true);
                                    }
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
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                            {group.members.map((person: Person) => {
                              const displayName = getPersonDisplayName(person, group.familyName);
                              const needsWideLayout = shouldUseWideLayout(displayName);
                              
                              return (
                                <div
                                  key={person.id}
                                  className={`p-2 rounded-md border border-gray-200 cursor-pointer transition-colors ${
                                    selectedPeople.includes(person.id)
                                      ? 'border-primary-500 bg-primary-50'
                                      : 'hover:bg-gray-50'
                                  } ${needsWideLayout ? 'col-span-2' : ''}`}
                                  onClick={() => togglePersonSelection(person.id)}
                                >
                                  <div className="flex items-center space-x-3">
                                    <input
                                      type="checkbox"
                                      checked={selectedPeople.includes(person.id)}
                                      onChange={() => togglePersonSelection(person.id)}
                                      className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center space-x-2">
                                        <span className="text-sm font-medium text-gray-900 truncate">
                                          {displayName}
                                        </span>
                                        <AttendanceInfoButton personId={person.id} createdAt={person.createdAt} />
                                      </div>
                                      {(() => {
                                        const standardGatherings = getStandardGatheringAssignments(person.gatheringAssignments);
                                        return standardGatherings.length > 0 && (
                                          <div className="flex items-center space-x-1 mt-1">
                                            {standardGatherings.map(gathering => (
                                              <div
                                                key={gathering.id}
                                                className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                                                title={gathering.name}
                                              ></div>
                                            ))}
                                          </div>
                                        );
                                      })()}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    // Individual view
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                      {recentVisitorGroups.flatMap((group: any) => 
                        group.members.map((person: Person) => {
                          const displayName = getFullPersonDisplayName(person);
                          const needsWideLayout = shouldUseWideLayout(displayName);
                          
                          return (
                            <div
                              key={person.id}
                              className={`p-2 rounded-md border border-gray-200 cursor-pointer transition-colors ${
                                selectedPeople.includes(person.id)
                                  ? 'border-primary-500 bg-primary-50'
                                  : 'hover:bg-gray-50'
                              } ${needsWideLayout ? 'col-span-2' : ''}`}
                              onClick={() => togglePersonSelection(person.id)}
                            >
                              <div className="flex items-center space-x-3">
                                <input
                                  type="checkbox"
                                  checked={selectedPeople.includes(person.id)}
                                  onChange={() => togglePersonSelection(person.id)}
                                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <div className="flex items-center space-x-2">
                                  <span className="text-sm font-medium text-gray-900">{displayName}</span>
                                  {(() => {
                                    const standardGatherings = getStandardGatheringAssignments(person.gatheringAssignments);
                                    return standardGatherings.length > 0 && (
                                      <div className="flex items-center space-x-1">
                                        {standardGatherings.map(gathering => (
                                          <div
                                            key={gathering.id}
                                            className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                                            title={gathering.name}
                                          ></div>
                                        ))}
                                      </div>
                                    );
                                  })()}
                                  <AttendanceInfoButton personId={person.id} createdAt={person.createdAt} />
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Less recently attended visitors (suggested word: Infrequent) */}
              {olderVisitorGroups.length > 0 && (
                <div className="mt-6">
                  <div className="flex items-center justify-between">
                    <h4 className="text-md font-medium text-gray-800">Infrequent</h4>
                    <button
                      type="button"
                      onClick={() => setShowArchivedVisitors(v => !v)}
                      className="text-sm font-medium text-primary-600 hover:text-primary-700"
                    >
                      {showArchivedVisitors ? 'Hide' : `Show (${olderVisitorGroups.reduce((acc, g) => acc + g.members.length, 0)})`}
                    </button>
                  </div>
                  {showArchivedVisitors && (
                    groupByFamily ? (
                      // Grouped by family view
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
                                  <button
                                    onClick={() => handleOpenNotes(group)}
                                    className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                    title="Family Notes"
                                  >
                                    <DocumentTextIcon className="h-4 w-4" />
                                  </button>
                                  <button
                                    onClick={() => {
                                      const familyId = group.familyId;
                                      if (familyId) {
                                        setFamilyEditor({
                                          familyId,
                                          familyName: group.familyName || '',
                                          familyType: group.members.some((m: Person) => m.peopleType === 'local_visitor') ? 'local_visitor' : 
                                                     group.members.some((m: Person) => m.peopleType === 'traveller_visitor') ? 'traveller_visitor' : 'regular',
                                          memberIds: group.members.map((m: Person) => m.id),
                                          addMemberQuery: ''
                                        });
                                        setShowFamilyEditorModal(true);
                                      }
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
                            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                              {group.members.map((person: Person) => {
                                const displayName = getPersonDisplayName(person, group.familyName);
                                const needsWideLayout = shouldUseWideLayout(displayName);
                                
                                return (
                                  <div
                                    key={person.id}
                                    className={`p-2 rounded-md border border-gray-200 cursor-pointer transition-colors ${
                                      selectedPeople.includes(person.id)
                                        ? 'border-primary-500 bg-primary-50'
                                        : 'hover:bg-gray-50'
                                    } ${needsWideLayout ? 'col-span-2' : ''}`}
                                    onClick={() => togglePersonSelection(person.id)}
                                  >
                                    <div className="flex items-center space-x-3">
                                      <input
                                        type="checkbox"
                                        checked={selectedPeople.includes(person.id)}
                                        onChange={() => togglePersonSelection(person.id)}
                                        className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center space-x-2">
                                          <span className="text-sm font-medium text-gray-900 truncate">
                                            {displayName}
                                          </span>
                                          <AttendanceInfoButton personId={person.id} createdAt={person.createdAt} />
                                        </div>
                                        {(() => {
                                          const standardGatherings = getStandardGatheringAssignments(person.gatheringAssignments);
                                          return standardGatherings.length > 0 && (
                                            <div className="flex items-center space-x-1 mt-1">
                                              {standardGatherings.map(gathering => (
                                                <div
                                                  key={gathering.id}
                                                  className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                                                  title={gathering.name}
                                                ></div>
                                              ))}
                                            </div>
                                          );
                                        })()}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      // Individual view
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3 mt-3">
                        {olderVisitorGroups.flatMap((group: any) => 
                          group.members.map((person: Person) => {
                            const displayName = getFullPersonDisplayName(person);
                            const needsWideLayout = shouldUseWideLayout(displayName);
                            
                            return (
                              <div
                                key={person.id}
                                className={`p-2 rounded-md border border-gray-200 cursor-pointer transition-colors ${
                                  selectedPeople.includes(person.id)
                                    ? 'border-primary-500 bg-primary-50'
                                    : 'hover:bg-gray-50'
                                } ${needsWideLayout ? 'col-span-2' : ''}`}
                                onClick={() => togglePersonSelection(person.id)}
                              >
                                <div className="flex items-center space-x-3">
                                  <input
                                    type="checkbox"
                                    checked={selectedPeople.includes(person.id)}
                                    onChange={() => togglePersonSelection(person.id)}
                                    className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 flex-shrink-0"
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                  <div className="flex items-center space-x-2">
                                    <span className="text-sm font-medium text-gray-900">{displayName}</span>
                                    {(() => {
                                      const standardGatherings = getStandardGatheringAssignments(person.gatheringAssignments);
                                      return standardGatherings.length > 0 && (
                                        <div className="flex items-center space-x-1">
                                          {standardGatherings.map(gathering => (
                                            <div
                                              key={gathering.id}
                                              className={`w-2 h-2 rounded-full ${getGatheringColor(gathering.id)}`}
                                              title={gathering.name}
                                            ></div>
                                          ))}
                                        </div>
                                      );
                                    })()}
                                    <AttendanceInfoButton personId={person.id} createdAt={person.createdAt} />
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )
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
                {archivedPeople.map((person: Person) => {
                  const displayName = getPersonDisplayName(person); // No family context for archived
                  const needsWideLayout = shouldUseWideLayout(displayName);
                  
                  return (
                    <div 
                      key={`arch-${person.id}`} 
                      className={`flex items-center justify-between p-3 rounded-md border-2 border-gray-200 hover:border-gray-300 ${needsWideLayout ? 'col-span-2' : ''}`}
                    >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {displayName}
                      </div>
                      <div className="text-xs text-gray-500">
                        {person.peopleType === 'local_visitor' ? 'Local Visitor' : person.peopleType === 'traveller_visitor' ? 'Traveller Visitor' : ''}
                      </div>
                    </div>
                    <ActionMenu
                      items={[
                        {
                          label: 'Restore',
                          icon: <ArrowPathIcon className="h-4 w-4" />,
                          onClick: () => restorePerson(person.id)
                        },
                        {
                          label: 'Delete Permanently',
                          icon: <TrashIcon className="h-4 w-4" />,
                          onClick: () => confirmPermanentDelete(person.id, `${person.firstName} ${person.lastName}`),
                          className: 'text-red-600 hover:bg-red-50'
                        }
                      ]}
                    />
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Comprehensive Add Modal */}
      {showAddModal ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  {addModalMode === 'person' && 'Add New People'}
                  {addModalMode === 'csv' && 'Upload TSV File'}
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
                    TSV Upload
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
                    TSV Upload
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

                            {/* Add People Form */}
              {addModalMode === 'person' && (
                <form onSubmit={(e) => { e.preventDefault(); handleAddPeople(); }} className="space-y-4">
                  {/* Person Type Selection */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Person Type
                    </label>
                    <div className="flex space-x-4">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="personType"
                          value="regular"
                          checked={addPeopleForm.personType === 'regular'}
                          onChange={(e) => setAddPeopleForm({ ...addPeopleForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Regular Member</span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="personType"
                          value="local_visitor"
                          checked={addPeopleForm.personType === 'local_visitor'}
                          onChange={(e) => setAddPeopleForm({ ...addPeopleForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Local Visitor</span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="personType"
                          value="traveller_visitor"
                          checked={addPeopleForm.personType === 'traveller_visitor'}
                          onChange={(e) => setAddPeopleForm({ ...addPeopleForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-900">Traveller Visitor</span>
                      </label>
                    </div>
                  </div>

                  {/* Gathering Assignments - only for regular members */}
                  {addPeopleForm.personType === 'regular' && gatheringTypes.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Assign to Gatherings (Optional)
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {gatheringTypes
                          .filter(gathering => gathering.attendanceType !== 'headcount')
                          .map((gathering) => (
                            <label key={gathering.id} className="flex items-center">
                              <input
                                type="checkbox"
                                checked={addPeopleForm.selectedGatherings[gathering.id] || false}
                                onChange={(e) => setAddPeopleForm({
                                  ...addPeopleForm,
                                  selectedGatherings: {
                                    ...addPeopleForm.selectedGatherings,
                                    [gathering.id]: e.target.checked
                                  }
                                })}
                                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                              />
                              <span className="ml-2 text-sm text-gray-900">{gathering.name}</span>
                            </label>
                          ))}
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
                    {addPeopleForm.persons.map((person, index) => (
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
                  {addPeopleForm.persons.length < 10 && (
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

                  {/* Help text for regular attendees */}
                  {addPeopleForm.personType === 'regular' && (
                    <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                      <div className="text-sm text-blue-700">
                        <strong>Adding Regular Members:</strong> This will add the people to your People list. 
                        You can optionally assign them to specific gatherings.
                      </div>
                    </div>
                  )}

                  {/* Notes field - only for visitors */}
                  {(addPeopleForm.personType === 'local_visitor' || addPeopleForm.personType === 'traveller_visitor') && (
                    <div>
                      <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
                        Notes
                      </label>
                      <textarea
                        id="notes"
                        value={addPeopleForm.notes}
                        onChange={(e) => setAddPeopleForm({ ...addPeopleForm, notes: e.target.value })}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="Any additional notes (optional)"
                        rows={3}
                      />
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
                      type="submit"
                      className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                    >
                      Add People
                    </button>
                  </div>
                </form>
              )}

              

              {/* TSV Upload Form */}
              {addModalMode === 'csv' && (
                <div className="space-y-4">
                  {/* Automatic Change Detection */}
                  {tsvAnalysis && (
                    <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                      <div className="flex">
                        <div className="flex-shrink-0">
                          <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                          </svg>
                        </div>
                        <div className="ml-3">
                          <h3 className="text-sm font-medium text-blue-800">
                            Upload Analysis
                          </h3>
                          <div className="mt-2 text-sm text-blue-700">
                            <p>Found {tsvAnalysis.totalRows} rows in your TSV file:</p>
                            <ul className="mt-2 space-y-1">
                              {tsvAnalysis.newPeople > 0 && (
                                <li className="flex items-center">
                                  <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-2"></span>
                                  <span className="font-medium text-green-800">{tsvAnalysis.newPeople} new people</span> will be added
                                </li>
                              )}
                              {tsvAnalysis.existingPeople > 0 && (
                                <li className="flex items-center">
                                  <span className="inline-block w-2 h-2 bg-blue-500 rounded-full mr-2"></span>
                                  <span className="font-medium text-blue-800">{tsvAnalysis.existingPeople} existing people</span> will be updated
                                </li>
                              )}
                            </ul>
                            {tsvAnalysis.unknownGatherings.length > 0 && (
                              <div className="mt-3 p-2 bg-yellow-100 rounded border border-yellow-300">
                                <p className="font-medium text-yellow-800">⚠️ Unknown gatherings found:</p>
                                <p className="text-yellow-700 text-xs mt-1">
                                  {tsvAnalysis.unknownGatherings.join(', ')} - these will be ignored
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* New People Warning */}
                  {tsvAnalysis && tsvAnalysis.newPeople > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-md p-4">
                      <div className="flex">
                        <div className="flex-shrink-0">
                          <svg className="h-5 w-5 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                          </svg>
                    </div>
                        <div className="ml-3">
                          <h3 className="text-sm font-medium text-amber-800">
                            Adding New People
                          </h3>
                          <div className="mt-2 text-sm text-amber-700">
                            <p>
                              <strong>{tsvAnalysis.newPeople} new people</strong> will be added to your system. 
                              Make sure these are not duplicates of existing people.
                            </p>
                  </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Duplication Warning */}
                  {potentialDuplicates.length > 0 && (
                    <div className={`border rounded-md p-4 ${
                      potentialDuplicates.length > 5 
                        ? 'bg-red-50 border-red-200' 
                        : 'bg-yellow-50 border-yellow-200'
                    }`}>
                      <div className="flex">
                        <div className="flex-shrink-0">
                          <svg className={`h-5 w-5 ${
                            potentialDuplicates.length > 5 ? 'text-red-400' : 'text-yellow-400'
                          }`} viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                          </svg>
                        </div>
                        <div className="ml-3">
                          <h3 className={`text-sm font-medium ${
                            potentialDuplicates.length > 5 ? 'text-red-800' : 'text-yellow-800'
                          }`}>
                            {potentialDuplicates.length > 5 ? 'High Risk of Duplication!' : 'Potential Duplication Warning'}
                          </h3>
                          <div className={`mt-2 text-sm ${
                            potentialDuplicates.length > 5 ? 'text-red-700' : 'text-yellow-700'
                          }`}>
                                <p className={`font-medium mb-2 ${
                                  potentialDuplicates.length > 5 ? 'text-red-800' : 'text-yellow-800'
                                }`}>
                                  ⚠️ Potential duplicates detected in your TSV:
                                </p>
                                <div className={`rounded p-2 max-h-32 overflow-y-auto ${
                                  potentialDuplicates.length > 5 ? 'bg-red-100' : 'bg-yellow-100'
                                }`}>
                                  {potentialDuplicates.map((dup, index) => (
                                    <div key={index} className={`text-xs mb-1 ${
                                      potentialDuplicates.length > 5 ? 'text-red-800' : 'text-yellow-800'
                                    }`}>
                                      <strong>{dup.firstName} {dup.lastName}</strong>: {dup.reason}
                                    </div>
                                  ))}
                                </div>
                            
                            {potentialDuplicates.length > 5 && (
                              <p className="mt-2 font-bold text-red-800">
                                🚨 HIGH RISK: {potentialDuplicates.length} potential duplicates detected!
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <label htmlFor="csvFile" className="block text-sm font-medium text-gray-700">
                      Select TSV File
                    </label>
                    <input
                      id="csvFile"
                      type="file"
                      accept=".tsv,.txt,.csv"
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
                      <p>Expected TSV format:</p>
                      <a
                        href="/api/csv-import/template"
                        className="ml-4 inline-flex items-center text-primary-600 hover:text-primary-700 font-medium"
                      >
                        Download template
                      </a>
                    </div>
                    <div className="mt-1 bg-gray-50 p-3 rounded border border-gray-200 overflow-x-auto">
                      <table className="w-full text-xs font-mono">
                        <thead>
                          <tr className="border-b border-gray-300">
                            <th className="text-left py-1 px-2 font-semibold text-gray-700">FIRST NAME</th>
                            <th className="text-left py-1 px-2 font-semibold text-gray-700">LAST NAME</th>
                            <th className="text-left py-1 px-2 font-semibold text-gray-700">FAMILY NAME</th>
                            <th className="text-left py-1 px-2 font-semibold text-gray-700">GATHERINGS</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className="py-1 px-2">John</td>
                            <td className="py-1 px-2">Smith</td>
                            <td className="py-1 px-2">Smith, John and Sarah</td>
                            <td className="py-1 px-2">
                              {gatheringTypes.length >= 2 
                                ? `${gatheringTypes[0].name}, ${gatheringTypes[1].name}`
                                : gatheringTypes.length === 1 
                                  ? gatheringTypes[0].name
                                  : 'Sunday Service, Bible Study'
                              }
                            </td>
                          </tr>
                          <tr>
                            <td className="py-1 px-2">Sarah</td>
                            <td className="py-1 px-2">Smith</td>
                            <td className="py-1 px-2">Smith, John and Sarah</td>
                            <td className="py-1 px-2">
                              {gatheringTypes.length >= 1 
                                ? gatheringTypes[0].name
                                : 'Sunday Service'
                              }
                            </td>
                          </tr>
                        </tbody>
                      </table>
                  </div>
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
                   <div className="flex items-center justify-between flex-wrap gap-2">
                   <p>Expected format (tab or comma separated):</p>
                     <a
                       href="/api/csv-import/template"
                       className="ml-4 inline-flex items-center text-primary-600 hover:text-primary-700 font-medium"
                     >
                       Download template
                     </a>
                   </div>
                   <div className="mt-1 bg-gray-50 border border-gray-200 rounded overflow-hidden">
                     <table className="w-full text-xs">
                       <thead className="bg-gray-100">
                         <tr>
                           <th className="px-2 py-1 text-left font-medium text-gray-700 border-r border-gray-200">FIRST NAME</th>
                           <th className="px-2 py-1 text-left font-medium text-gray-700 border-r border-gray-200">LAST NAME</th>
                           <th className="px-2 py-1 text-left font-medium text-gray-700 border-r border-gray-200">FAMILY NAME</th>
                           <th className="px-2 py-1 text-left font-medium text-gray-700">GATHERINGS</th>
                         </tr>
                       </thead>
                       <tbody className="font-mono">
                         <tr>
                           <td className="px-2 py-1 border-r border-gray-200">John</td>
                           <td className="px-2 py-1 border-r border-gray-200">Smith</td>
                           <td className="px-2 py-1 border-r border-gray-200">Smith, John and Sarah</td>
                           <td className="px-2 py-1">
                             {gatheringTypes.length >= 2 
                               ? `${gatheringTypes[0].name}, ${gatheringTypes[1].name}`
                               : gatheringTypes.length === 1 
                                 ? gatheringTypes[0].name
                                 : 'Sunday Service, Bible Study'
                             }
                           </td>
                         </tr>
                         <tr>
                           <td className="px-2 py-1 border-r border-gray-200">Sarah</td>
                           <td className="px-2 py-1 border-r border-gray-200">Smith</td>
                           <td className="px-2 py-1 border-r border-gray-200">Smith, John and Sarah</td>
                           <td className="px-2 py-1">
                             {gatheringTypes.length >= 1 
                               ? gatheringTypes[0].name
                               : 'Sunday Service'
                             }
                           </td>
                         </tr>
                       </tbody>
                     </table>
                   </div>
                   <p className="mt-2 text-xs">Copy rows from Excel/Google Sheets with columns: FIRST NAME, LAST NAME, FAMILY NAME, GATHERINGS.</p>
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
        </div>,
        document.body
      ) : null}

      {/* Removed duplicate Person Details Modal */}

      {/* Delete Person Confirmation Modal */}
      {showDeleteModal ? createPortal(
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
        </div>,
        document.body
      ) : null}

      {/* Remove People Confirmation Modal */}
      {showRemoveModal ? createPortal(
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
        </div>,
        document.body
      ) : null}

      {showPermanentDeleteModal ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">Permanently Delete</h3>
                <button
                  onClick={() => setShowPermanentDeleteModal(false)}
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
                  This will permanently delete <strong>{permanentDeleteTarget.personName}</strong> and related attendance records. This action cannot be undone.
                </p>
              </div>

              <div className="flex space-x-3">
                <button
                  onClick={() => setShowPermanentDeleteModal(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    await handlePermanentDelete();
                    setShowPermanentDeleteModal(false);
                    setPermanentDeleteTarget({ personId: null, personName: '' });
                  }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                >
                  Delete Permanently
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}



             {/* removed: Manage Gatherings Modal */}
       

             {/* Manage People Type Modal */}
      {/* removed: showManagePeopleTypeModal UI */}

             {/* Removed duplicate Person Details Modal */}

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
                  // Initialize mass edit with meaningful data from selected people
                  const selectedPeopleData = people.filter(p => selectedPeople.includes(p.id));
                  
                  // Initialize assignments based on current gathering assignments
                  const assignments: { [key: number]: boolean } = {};
                  const originalAssignments: { [key: number]: Set<number> } = {};
                  
                  // Check if all selected people have the same gathering assignments
                  const allGatheringIds = new Set<number>();
                  selectedPeopleData.forEach(person => {
                    person.gatheringAssignments?.forEach(gathering => {
                      allGatheringIds.add(gathering.id);
                    });
                  });
                  
                  // Initialize assignments based on common standard gatherings
                  gatheringTypes
                    .filter(g => g.attendanceType !== 'headcount')
                    .forEach(g => {
                      const hasGathering = selectedPeopleData.every(person => 
                        person.gatheringAssignments?.some(ga => ga.id === g.id)
                      );
                      assignments[g.id] = hasGathering;
                    });
                  
                  // Store original assignments for each person
                  selectedPeopleData.forEach(person => {
                    originalAssignments[person.id] = new Set(
                      person.gatheringAssignments?.map(g => g.id) || []
                    );
                  });
                  
                  // Determine common family info
                  const familyIds = new Set(selectedPeopleData.map(p => p.familyId).filter(Boolean));
                  let familyInput = '';
                  let selectedFamilyId: number | null = null;
                  
                  if (familyIds.size === 1) {
                    // All people are in the same family
                    const familyId = Array.from(familyIds)[0];
                    const family = families.find(f => f.id === familyId);
                    if (family) {
                      familyInput = family.familyName;
                      selectedFamilyId = familyId;
                    }
                  }
                  
                  // Determine common people type
                  const peopleTypes = new Set(selectedPeopleData.map(p => p.peopleType));
                  let peopleType: '' | 'regular' | 'local_visitor' | 'traveller_visitor' = '';
                  if (peopleTypes.size === 1) {
                    peopleType = Array.from(peopleTypes)[0];
                  }
                  
                  // Determine common last name (only if all have same last name)
                  const lastNames = new Set(selectedPeopleData.map(p => p.lastName));
                  let lastName = '';
                  if (lastNames.size === 1) {
                    lastName = Array.from(lastNames)[0];
                  }
                  
                  setMassEdit({ 
                    familyInput, 
                    selectedFamilyId, 
                    newFamilyName: '', 
                    firstName: selectedPeople.length === 1 ? selectedPeopleData[0].firstName : '', // Only show for single person
                    lastName, // Show if all have same last name
                    peopleType, // Show if all have same type
                    assignments,
                    originalAssignments,
                    applyToWholeFamily: false
                  });
                  setModalSelectedCount(selectedPeople.length); // Set the count directly
                  setShowMassEditModal(true);
                }}
               className="w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
                title="Edit Selected"
             >
               <PencilIcon className="h-6 w-6" />
             </button>
           </div>
           {/* Archive Button - Always shown when people are selected */}
           <div className="flex items-center justify-end space-x-3">
             <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
                Archive Selected
             </div>
             <button
                onClick={() => {
                  // Archive all selected people
                  selectedPeople.forEach(personId => {
                    archivePerson(personId);
                  });
                }}
               className="w-14 h-14 bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
                title="Archive Selected"
             >
               <TrashIcon className="h-6 w-6" />
             </button>
           </div>
           
           {/* Merge Button - Only shown for 2+ people and admin users */}
           {isAdmin && selectedPeople.length >= 2 && (
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
                <div className="fixed bottom-16 right-28 z-40 flex items-center space-x-3">
                 <div className="bg-white/90 backdrop-blur rounded-lg shadow-lg border border-primary-200 px-4 py-3 text-primary-800 animate-pulse">
                   <p className="text-base font-semibold">Add your first people</p>
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

             </>
           )}
         </>
       )}

       {/* Merge Modal */}
       {showMergeModal ? createPortal(
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
                          Deduplicate {selectedPeople.length} selected individuals. Choose which record to keep as the master. The rest will be removed. Use this only for true duplicates, not different people.
                       </p>
                       
                       <div className="space-y-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700">Master record to keep</label>
                            <select
                              value={dedupeKeepId || ''}
                              onChange={(e) => setDedupeKeepId(e.target.value ? parseInt(e.target.value) : null)}
                              className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                            >
                              <option value="">Select record to keep</option>
                              {people.filter(p => selectedPeople.includes(p.id)).map(p => (
                                <option key={p.id} value={p.id}>
                                  {p.firstName} {p.lastName}{p.familyName ? ` — Family: ${p.familyName}` : ''} (ID: {p.id})
                                </option>
                              ))}
                            </select>
                          </div>

                         <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4">
                           <div className="flex">
                             <div className="text-sm text-yellow-700">
                                <strong>Warning:</strong> This will permanently delete {selectedPeople.length - 1} individual(s). Ensure you selected the correct master record above.
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
         </div>,
                 document.body
      ) : null}

      {/* Family Notes Modal */}
      {showNotesModal && selectedFamilyForNotes ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Family Notes: {selectedFamilyForNotes.familyName}
                </h3>
                <button
                  onClick={() => setShowNotesModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="mb-4">
                <label htmlFor="familyNotes" className="block text-sm font-medium text-gray-700 mb-2">
                  Notes
                </label>
                <textarea
                  id="familyNotes"
                  rows={6}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Add notes about this family..."
                  value={currentNotes}
                  onChange={(e) => setCurrentNotes(e.target.value)}
                />
              </div>
              
              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowNotesModal(false)}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveNotes}
                  disabled={isLoading}
                  className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  {isLoading ? 'Saving...' : 'Save Notes'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}
   </div>
 );
};

export default PeoplePage; 