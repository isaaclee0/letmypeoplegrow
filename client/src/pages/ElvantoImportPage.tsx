import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { integrationsAPI, gatheringsAPI } from '../services/api';
import logger from '../utils/logger';
import {
  MagnifyingGlassIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  UserGroupIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CalendarDaysIcon,
  UsersIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';

interface ElvantoPerson {
  id: string;
  firstname: string;
  lastname: string;
  preferred_name?: string;
  family_id?: string;
  family_relationship?: string;
  archived?: number | string;
}

interface ElvantoFamily {
  id: string;
  name: string;
  isIndividual?: boolean;
  alreadyImported?: boolean;
  people?: { person?: ElvantoPerson[] };
}

interface ElvantoGroup {
  id: string;
  name: string;
  description?: string;
  status?: string;
  meeting_day?: string;
  meeting_time?: string;
  meeting_frequency?: string;
  meeting_address?: string;
  meeting_city?: string;
  meeting_state?: string;
  alreadyImported?: boolean;
}

interface ElvantoService {
  id: string;
  name: string;
  date?: string;
  description?: string;
  service_type?: {
    id: string;
    name: string;
  };
  location?: {
    id: string;
    name: string;
  };
}

interface ServiceType {
  id: string;
  name: string;
  count: number;
}

type TabType = 'people' | 'gatherings';

const ElvantoImportPage: React.FC = () => {
  // Tab state
  const [activeTab, setActiveTab] = useState<TabType>('people');

  // People tab state
  const [searchTerm, setSearchTerm] = useState('');
  const [families, setFamilies] = useState<ElvantoFamily[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFamilies, setSelectedFamilies] = useState<Set<string>>(new Set());
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);
  const [alreadyImportedCount, setAlreadyImportedCount] = useState(0);
  const [importResult, setImportResult] = useState<{
    success: boolean;
    imported?: { people: any[]; families: any[]; gatherings?: any[] };
    errors?: string[];
    message?: string;
    summary?: { peopleImported: number; familiesImported: number; errorCount: number };
    duplicates?: Array<{ name: string; elvantoId: string; source: string; existingId: number }>;
  } | null>(null);

  // Gathering selection modal state (for people import)
  const [showGatheringSelectionModal, setShowGatheringSelectionModal] = useState(false);
  const [availableGatherings, setAvailableGatherings] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedGatheringIds, setSelectedGatheringIds] = useState<Set<number>>(new Set());
  const [pendingImportData, setPendingImportData] = useState<{ peopleIds?: string[]; familyIds?: string[] } | null>(null);

  // Gatherings tab state
  const [groups, setGroups] = useState<ElvantoGroup[]>([]);
  const [services, setServices] = useState<ElvantoService[]>([]);
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [loadingGatherings, setLoadingGatherings] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [selectedServiceTypes, setSelectedServiceTypes] = useState<Set<string>>(new Set());
  const [gatheringsSearchTerm, setGatheringsSearchTerm] = useState('');
  
  // Gathering edit modal state
  const [showGatheringEditModal, setShowGatheringEditModal] = useState(false);
  const [gatheringsNeedingInfo, setGatheringsNeedingInfo] = useState<Array<{
    id: string;
    name: string;
    description?: string;
    type: 'group' | 'service';
    dayOfWeek: string;
    startTime: string;
    frequency: string;
    isDuplicate?: boolean;
  }>>([]);
  const [currentGatheringIndex, setCurrentGatheringIndex] = useState(0);
  const [gatheringEditData, setGatheringEditData] = useState<{
    name: string;
    description: string;
    dayOfWeek: string;
    startTime: string;
    frequency: string;
  }>({ 
    name: '', 
    description: '', 
    dayOfWeek: 'Sunday', 
    startTime: '10:00',
    frequency: 'weekly'
  });
  
  // Name overrides for renamed gatherings
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({});
  const [skippedGatherings, setSkippedGatherings] = useState<Set<string>>(new Set());

  // Check connection status
  const [isConnected, setIsConnected] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(true);

  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = async () => {
    try {
      setCheckingConnection(true);
      const response = await integrationsAPI.getElvantoStatus();
      setIsConnected(response.data.connected);
      if (response.data.connected) {
        loadFamilies();
      }
    } catch (error) {
      logger.error('Failed to check Elvanto connection:', error);
      setIsConnected(false);
    } finally {
      setCheckingConnection(false);
    }
  };

  const loadFamilies = useCallback(async () => {
    if (!isConnected) return;

    try {
      setLoading(true);
        const response = await integrationsAPI.getElvantoFamilies({
        search: searchTerm || undefined,
        include_archived: showArchived ? 'true' : 'false'
        });
        if (response.data?.families) {
          setFamilies(response.data.families.family || []);
        }
      if (response.data?.meta) {
        setArchivedCount(response.data.meta.archivedCount || 0);
        setAlreadyImportedCount(response.data.meta.alreadyImportedCount || 0);
      }
    } catch (error: any) {
      logger.error('Failed to load Elvanto families:', error);
      if (error.response?.status === 401) {
        setIsConnected(false);
      }
    } finally {
      setLoading(false);
    }
  }, [searchTerm, isConnected, showArchived]);

  const loadGatherings = useCallback(async () => {
    if (!isConnected) return;

    try {
      setLoadingGatherings(true);
      
      // Load groups and services in parallel
      const [groupsResponse, servicesResponse] = await Promise.all([
        integrationsAPI.getElvantoGroups({ per_page: 100 }),
        integrationsAPI.getElvantoServices({ per_page: 100 })
      ]);

      const groupsData = groupsResponse.data?.groups?.group || [];
      setGroups(groupsData);

      const servicesData = servicesResponse.data?.services?.service || [];
      setServices(servicesData);

      // Extract unique service types
      const typeMap = new Map<string, ServiceType>();
      servicesData.forEach((service: ElvantoService) => {
        if (service.service_type?.id) {
          const existing = typeMap.get(service.service_type.id);
          if (existing) {
            existing.count++;
          } else {
            typeMap.set(service.service_type.id, {
              id: service.service_type.id,
              name: service.service_type.name,
              count: 1
            });
          }
        }
      });
      setServiceTypes(Array.from(typeMap.values()));

    } catch (error: any) {
      logger.error('Failed to load Elvanto gatherings:', error);
      if (error.response?.status === 401) {
        setIsConnected(false);
      }
    } finally {
      setLoadingGatherings(false);
    }
  }, [isConnected]);

  useEffect(() => {
    if (isConnected) {
      loadFamilies();
    }
  }, [loadFamilies, isConnected]);

  useEffect(() => {
    if (isConnected && activeTab === 'gatherings' && groups.length === 0 && services.length === 0) {
      loadGatherings();
    }
  }, [activeTab, isConnected, groups.length, services.length, loadGatherings]);

  const handleSearch = () => {
    loadFamilies();
  };

  const toggleFamilyExpanded = (familyId: string) => {
    const newExpanded = new Set(expandedFamilies);
    if (newExpanded.has(familyId)) {
      newExpanded.delete(familyId);
    } else {
      newExpanded.add(familyId);
    }
    setExpandedFamilies(newExpanded);
  };

  const toggleFamilySelection = (familyId: string, familyMembers: ElvantoPerson[]) => {
    const newSelectedFamilies = new Set(selectedFamilies);
    const newSelectedPeople = new Set(selectedPeople);
    
    if (newSelectedFamilies.has(familyId)) {
      newSelectedFamilies.delete(familyId);
      familyMembers.forEach(p => newSelectedPeople.delete(p.id));
    } else {
      newSelectedFamilies.add(familyId);
      familyMembers.forEach(p => newSelectedPeople.add(p.id));
    }
    
    setSelectedFamilies(newSelectedFamilies);
    setSelectedPeople(newSelectedPeople);
  };

  const togglePersonSelection = (personId: string, familyId: string, familyMembers: ElvantoPerson[]) => {
    const newSelectedPeople = new Set(selectedPeople);
    const newSelectedFamilies = new Set(selectedFamilies);
    
    if (newSelectedPeople.has(personId)) {
      newSelectedPeople.delete(personId);
      const remainingSelected = familyMembers.filter(p => newSelectedPeople.has(p.id));
      if (remainingSelected.length === 0) {
        newSelectedFamilies.delete(familyId);
      }
    } else {
      newSelectedPeople.add(personId);
      const allSelected = familyMembers.every(p => newSelectedPeople.has(p.id) || p.id === personId);
      if (allSelected) {
        newSelectedFamilies.add(familyId);
      }
    }
    
    setSelectedPeople(newSelectedPeople);
    setSelectedFamilies(newSelectedFamilies);
  };

  const toggleGroupSelection = (groupId: string) => {
    const newSelected = new Set(selectedGroups);
    if (newSelected.has(groupId)) {
      newSelected.delete(groupId);
    } else {
      newSelected.add(groupId);
    }
    setSelectedGroups(newSelected);
  };

  const toggleServiceTypeSelection = (typeId: string) => {
    const newSelected = new Set(selectedServiceTypes);
    if (newSelected.has(typeId)) {
      newSelected.delete(typeId);
    } else {
      newSelected.add(typeId);
    }
    setSelectedServiceTypes(newSelected);
  };

  const selectAll = () => {
    const allFamilyIds = new Set<string>();
    const allPeopleIds = new Set<string>();
    
    families.forEach(family => {
      allFamilyIds.add(family.id);
      (family.people?.person || []).forEach(p => allPeopleIds.add(p.id));
    });
    
    setSelectedFamilies(allFamilyIds);
    setSelectedPeople(allPeopleIds);
  };

  const clearSelection = () => {
    setSelectedFamilies(new Set());
    setSelectedPeople(new Set());
  };

  const clearGatheringsSelection = () => {
    setSelectedGroups(new Set());
    setSelectedServiceTypes(new Set());
  };

  const handleImport = async () => {
    if (selectedPeople.size === 0) {
      alert('Please select at least one person or family to import.');
      return;
    }

    // Prepare import data
    const familyIdsToImport: string[] = [];
    const individualPeopleIds: string[] = [];
    
    families.forEach(family => {
      const members = family.people?.person || [];
      const selectedMembers = members.filter(p => selectedPeople.has(p.id));
      
      if (selectedMembers.length === members.length && members.length > 0) {
        familyIdsToImport.push(family.id);
      } else if (selectedMembers.length > 0) {
        selectedMembers.forEach(p => individualPeopleIds.push(p.id));
      }
    });

    // Store pending import data and show gathering selection modal
    setPendingImportData({
      peopleIds: individualPeopleIds.length > 0 ? individualPeopleIds : undefined,
      familyIds: familyIdsToImport.length > 0 ? familyIdsToImport : undefined
    });

    // Fetch available gatherings
    try {
      const gatheringsResponse = await gatheringsAPI.getAll();
      if (gatheringsResponse?.data?.gatherings) {
        setAvailableGatherings(gatheringsResponse.data.gatherings.map((g: any) => ({ id: g.id, name: g.name })));
      } else {
        setAvailableGatherings([]);
      }
    } catch (error) {
      logger.error('Failed to fetch gatherings:', error);
      // Continue anyway - user can still import without selecting gatherings
      setAvailableGatherings([]);
    }

    setSelectedGatheringIds(new Set());
    setShowGatheringSelectionModal(true);
  };

  const performPeopleImport = async () => {
    if (!pendingImportData) return;

    try {
      setImporting(true);
      setImportResult(null);
      setShowGatheringSelectionModal(false);

      const gatheringIds = selectedGatheringIds.size > 0 ? Array.from(selectedGatheringIds) : undefined;

      const response = await integrationsAPI.importFromElvanto({
        peopleIds: pendingImportData.peopleIds,
        familyIds: pendingImportData.familyIds,
        gatheringIds
      });

      setImportResult(response.data);
      setSelectedPeople(new Set());
      setSelectedFamilies(new Set());
      setPendingImportData(null);
      setSelectedGatheringIds(new Set());
      
      // Auto-dismiss success message after 3 seconds
      if (response.data.success) {
        setTimeout(() => {
          setImportResult(null);
        }, 3000);
      }
      
      setTimeout(() => {
        loadFamilies();
      }, 1000);
    } catch (error: any) {
      logger.error('Failed to import from Elvanto:', error);
      const errorMessage = error.response?.data?.error || error.response?.data?.details || error.message || 'Failed to import data';
      setImportResult({
        success: false,
        errors: [errorMessage]
      });
    } finally {
      setImporting(false);
    }
  };

  const handleImportGatherings = async () => {
    if (selectedGroups.size === 0 && selectedServiceTypes.size === 0) {
      alert('Please select at least one group or service type to import.');
      return;
    }

    try {
      // Check for duplicates and missing time info, then show edit modal for all that need it
      await checkAndShowEditModal();
    } catch (error: any) {
      logger.error('Failed to check gatherings:', error);
      // If check fails, proceed with edit modal anyway
      await checkAndShowEditModal();
    }
  };

  const checkAndShowEditModal = async () => {
    // First, check for duplicates
    let duplicates: Array<{ id: string; name: string; type: 'group' | 'service'; existingId: number }> = [];
    try {
      const duplicatesResponse = await integrationsAPI.checkGatheringDuplicates({
        groupIds: selectedGroups.size > 0 ? Array.from(selectedGroups) : undefined,
        serviceTypeIds: selectedServiceTypes.size > 0 ? Array.from(selectedServiceTypes) : undefined
      });
      duplicates = duplicatesResponse.data.duplicates || [];
    } catch (error) {
      // If duplicate check fails, continue anyway
      logger.error('Failed to check duplicates:', error);
    }
    
    const duplicateIds = new Set(duplicates.map(d => d.id));
    
    // Collect gatherings that need editing (duplicates OR missing time info)
    const allGatherings: Array<{ id: string; name: string; description?: string; type: 'group' | 'service'; dayOfWeek: string; startTime: string; frequency: string; isDuplicate?: boolean }> = [];
    
    // Check selected groups
    for (const groupId of selectedGroups) {
      if (skippedGatherings.has(groupId)) continue;
      
      const group = groups.find(g => g.id === groupId);
      if (!group) continue;
      
      const isDuplicate = duplicateIds.has(groupId);
      const hasDayOfWeek = group.meeting_day && ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].includes(group.meeting_day);
      const hasStartTime = group.meeting_time && group.meeting_time.trim() !== '';
      
      // Include if duplicate OR missing day of week OR missing start time
      if (isDuplicate || !hasDayOfWeek || !hasStartTime) {
        // Parse frequency from Elvanto data
        let frequency = 'weekly';
        if (group.meeting_frequency) {
          const freq = group.meeting_frequency.toLowerCase();
          if (freq.includes('2 week') || freq.includes('fortnightly') || freq.includes('biweekly')) {
            frequency = 'biweekly';
          } else if (freq.includes('month')) {
            frequency = 'monthly';
          }
        }
        
        // Parse day of week
        let dayOfWeek = '';
        if (group.meeting_day) {
          const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          if (days.includes(group.meeting_day)) {
            dayOfWeek = group.meeting_day;
          }
        }
        if (!dayOfWeek) dayOfWeek = 'Sunday';
        
        // Parse start time (convert from "6:00 PM" format if needed)
        let startTime = '';
        if (group.meeting_time) {
          const timeMatch = group.meeting_time.match(/(\d+):(\d+)\s*(AM|PM)?/i);
          if (timeMatch) {
            let hours = parseInt(timeMatch[1], 10);
            const minutes = timeMatch[2] || '00';
            const period = timeMatch[3]?.toUpperCase();
            
            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;
            
            startTime = `${hours.toString().padStart(2, '0')}:${minutes}`;
          }
        }
        if (!startTime) startTime = '10:00';
        
        allGatherings.push({
          id: groupId,
          name: nameOverrides[groupId] || group.name,
          description: group.description?.replace(/<[^>]*>/g, '') || '',
          type: 'group',
          dayOfWeek,
          startTime,
          frequency,
          isDuplicate
        });
      }
    }
    
    // Service types always need full info (they don't have meeting_time from Elvanto)
    for (const serviceTypeId of selectedServiceTypes) {
      if (skippedGatherings.has(serviceTypeId)) continue;
      
      const serviceType = serviceTypes.find(st => st.id === serviceTypeId);
      if (!serviceType) continue;
      
      const isDuplicate = duplicateIds.has(serviceTypeId);
      
      // Include if duplicate OR always (since service types don't have time info)
      if (isDuplicate || true) {
        allGatherings.push({
          id: serviceTypeId,
          name: nameOverrides[serviceTypeId] || serviceType.name,
          description: '',
          type: 'service',
          dayOfWeek: 'Sunday',
          startTime: '10:00',
          frequency: 'weekly',
          isDuplicate
        });
      }
    }

    // Show edit modal for all gatherings that need it
    if (allGatherings.length > 0) {
      setGatheringsNeedingInfo(allGatherings);
      setCurrentGatheringIndex(0);
      const firstGathering = allGatherings[0];
      setGatheringEditData({
        name: firstGathering.name,
        description: firstGathering.description || '',
        dayOfWeek: firstGathering.dayOfWeek,
        startTime: firstGathering.startTime,
        frequency: firstGathering.frequency
      });
      setShowGatheringEditModal(true);
      return;
    }

    // No gatherings need editing, proceed with import
    await performGatheringImport();
  };


  const handleGatheringEditNext = () => {
    // Save current gathering's data
    const updated = [...gatheringsNeedingInfo];
    updated[currentGatheringIndex] = {
      ...updated[currentGatheringIndex],
      name: gatheringEditData.name,
      description: gatheringEditData.description,
      dayOfWeek: gatheringEditData.dayOfWeek,
      startTime: gatheringEditData.startTime,
      frequency: gatheringEditData.frequency
    };
    setGatheringsNeedingInfo(updated);
    
    // Update name override if name changed
    const currentGathering = gatheringsNeedingInfo[currentGatheringIndex];
    if (gatheringEditData.name !== currentGathering.name) {
      setNameOverrides(prev => ({
        ...prev,
        [currentGathering.id]: gatheringEditData.name
      }));
    }

    // Move to next or finish
    if (currentGatheringIndex < gatheringsNeedingInfo.length - 1) {
      const nextGathering = updated[currentGatheringIndex + 1];
      setCurrentGatheringIndex(currentGatheringIndex + 1);
      setGatheringEditData({
        name: nextGathering.name,
        description: nextGathering.description || '',
        dayOfWeek: nextGathering.dayOfWeek || 'Sunday',
        startTime: nextGathering.startTime || '10:00',
        frequency: nextGathering.frequency || 'weekly'
      });
    } else {
      // All done, proceed with import
      setShowGatheringEditModal(false);
      performGatheringImport();
    }
  };

  const performGatheringImport = async () => {
    try {
      setImporting(true);
      setImportResult(null);

      // Build gathering info object from edited data
      const gatheringInfo: Record<string, { name?: string; description?: string; dayOfWeek: string; startTime: string; frequency: string }> = {};
      gatheringsNeedingInfo.forEach(g => {
        gatheringInfo[g.id] = {
          name: g.name,
          description: g.description,
          dayOfWeek: g.dayOfWeek,
          startTime: g.startTime,
          frequency: g.frequency
        };
      });

      // Filter out skipped gatherings
      const groupsToImport = selectedGroups.size > 0 
        ? Array.from(selectedGroups).filter(id => !skippedGatherings.has(id))
        : undefined;
      const servicesToImport = selectedServiceTypes.size > 0
        ? Array.from(selectedServiceTypes).filter(id => !skippedGatherings.has(id))
        : undefined;

      const response = await integrationsAPI.importGatheringsFromElvanto({
        groupIds: groupsToImport && groupsToImport.length > 0 ? groupsToImport : undefined,
        serviceTypeIds: servicesToImport && servicesToImport.length > 0 ? servicesToImport : undefined,
        gatheringInfo: Object.keys(gatheringInfo).length > 0 ? gatheringInfo : undefined,
        nameOverrides: Object.keys(nameOverrides).length > 0 ? nameOverrides : undefined
      });

      setImportResult(response.data);
      setSelectedGroups(new Set());
      setSelectedServiceTypes(new Set());
      setGatheringsNeedingInfo([]);
      
      // Auto-dismiss success message after 3 seconds
      if (response.data.success) {
        setTimeout(() => {
          setImportResult(null);
        }, 3000);
      }
      
      setTimeout(() => {
        loadGatherings();
      }, 1000);
    } catch (error: any) {
      logger.error('Failed to import gatherings from Elvanto:', error);
      setImportResult({
        success: false,
        errors: [error.response?.data?.error || 'Failed to import gatherings']
      });
    } finally {
      setImporting(false);
    }
  };

  const getPersonDisplayName = (person: ElvantoPerson, familyName: string) => {
    const firstName = person.preferred_name || person.firstname;
    const familySurname = familyName.split(',')[0]?.toLowerCase().trim() || '';
    const personSurname = person.lastname?.toLowerCase() || '';
    
    if (familySurname === personSurname && !familyName.includes('individual')) {
      return firstName;
    }
    return `${firstName} ${person.lastname}`;
  };

  const totalSelected = selectedPeople.size;
  const totalGatheringsSelected = selectedGroups.size + selectedServiceTypes.size;

  // Filter groups: must have meeting time set, and match search term
  const filteredGroups = groups.filter(group => {
    // Must have a meeting day or time set
    if (!group.meeting_day && !group.meeting_time) return false;
    
    // Apply search filter
    if (gatheringsSearchTerm) {
      return group.name.toLowerCase().includes(gatheringsSearchTerm.toLowerCase()) ||
        group.description?.toLowerCase().includes(gatheringsSearchTerm.toLowerCase());
    }
    return true;
  });

  if (checkingConnection) {
    return (
      <div className="flex items-center justify-center h-64">
        <ArrowPathIcon className="h-8 w-8 animate-spin text-primary-600" />
        <span className="ml-3 text-gray-600">Checking Elvanto connection...</span>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <div className="flex">
            <XCircleIcon className="h-6 w-6 text-yellow-600 mr-3" />
            <div>
              <h3 className="text-lg font-medium text-yellow-800">Elvanto Not Connected</h3>
              <p className="mt-2 text-sm text-yellow-700">
                You need to connect your Elvanto account before you can import data.
              </p>
              <div className="mt-4">
                <a
                  href="/app/settings?tab=integrations"
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                >
                  Go to Settings
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-32">
        {/* Header */}
      <div className="bg-white overflow-hidden shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Import from Elvanto</h1>
              <p className="mt-1 text-sm text-gray-500">
                Import people, families, and gatherings from Elvanto
              </p>
            </div>
              <button
              onClick={activeTab === 'people' ? loadFamilies : loadGatherings}
              disabled={loading || loadingGatherings}
              className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              <ArrowPathIcon className={`h-4 w-4 mr-2 ${(loading || loadingGatherings) ? 'animate-spin' : ''}`} />
              Refresh
              </button>
          </div>

        {/* Tabs */}
          <div className="mt-6 border-b border-gray-200">
            <nav className="-mb-px flex space-x-8">
            <button
                onClick={() => setActiveTab('people')}
                className={`${
                activeTab === 'people'
                    ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm flex items-center`}
            >
                <UsersIcon className="h-5 w-5 mr-2" />
                People & Families
            </button>
            <button
                onClick={() => setActiveTab('gatherings')}
                className={`${
                  activeTab === 'gatherings'
                    ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm flex items-center`}
            >
                <CalendarDaysIcon className="h-5 w-5 mr-2" />
                Gatherings
            </button>
          </nav>
          </div>
          </div>
        </div>


      {/* People Tab Content */}
      {activeTab === 'people' && (
        <>
          {/* Search & Filters */}
          <div className="bg-white shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
          <div className="flex space-x-4">
            <div className="flex-1">
              <div className="relative">
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="Search families and people..."
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm pl-10"
                />
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
              </div>
            </div>
            <button
              onClick={handleSearch}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
            >
              Search
            </button>
              </div>
              
              <div className="mt-4 pt-4 border-t border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <input
                      type="checkbox"
                      id="showArchived"
                      checked={showArchived}
                      onChange={(e) => setShowArchived(e.target.checked)}
                      className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                    <label htmlFor="showArchived" className="text-sm font-medium text-gray-700">
                      Show archived people
                    </label>
                  </div>
                  <div className="flex items-center gap-4">
                    {archivedCount > 0 && !showArchived && (
                      <span className="text-xs text-gray-500">
                        {archivedCount} archived {archivedCount === 1 ? 'person' : 'people'} hidden
                      </span>
                    )}
                    {alreadyImportedCount > 0 && (
                      <span className="text-xs text-green-600 flex items-center gap-1">
                        <CheckCircleIcon className="h-3 w-3" />
                        {alreadyImportedCount} {alreadyImportedCount === 1 ? 'family' : 'families'} already imported
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Families List */}
          <div className="bg-white shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900">
                  Families & People ({families.reduce((acc, f) => acc + (f.people?.person?.length || 0), 0)})
                </h3>
                <div className="flex items-center space-x-3">
                  {totalSelected > 0 ? (
                    <div className="flex items-center space-x-2 text-sm text-gray-600">
                      <span>{totalSelected} selected</span>
                      <button onClick={clearSelection} className="text-primary-600 hover:text-primary-700">
                        Clear
                      </button>
                    </div>
                  ) : families.length > 0 && (
                    <button onClick={selectAll} className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                      Select All
                    </button>
                  )}
          </div>
        </div>

          {loading ? (
            <div className="flex items-center justify-center h-64">
                  <ArrowPathIcon className="h-8 w-8 animate-spin text-primary-600" />
              <span className="ml-3 text-gray-600">Loading...</span>
            </div>
              ) : families.length === 0 ? (
                <div className="text-center py-8">
                  <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-medium text-gray-900">No families found</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {searchTerm ? 'Try adjusting your search.' : 'No families available to import.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {families.map((family) => {
                    const members = family.people?.person || [];
                    const isExpanded = expandedFamilies.has(family.id);
                    const isFamilySelected = selectedFamilies.has(family.id);
                    const selectedMemberCount = members.filter(p => selectedPeople.has(p.id)).length;
                    const isPartiallySelected = selectedMemberCount > 0 && selectedMemberCount < members.length;

                    return (
                      <div
                        key={family.id}
                        className={`border rounded-lg overflow-hidden ${
                          isFamilySelected ? 'border-primary-500 bg-primary-50'
                            : isPartiallySelected ? 'border-primary-300 bg-primary-25'
                            : 'border-gray-200'
                        }`}
                      >
                        <div
                          className={`flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50 ${
                            isFamilySelected ? 'hover:bg-primary-100' : ''
                          }`}
                          onClick={() => toggleFamilyExpanded(family.id)}
                        >
                          <div className="flex items-center space-x-3 flex-1 min-w-0">
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleFamilyExpanded(family.id); }}
                              className="text-gray-400 hover:text-gray-600"
                            >
                              {isExpanded ? <ChevronDownIcon className="h-5 w-5" /> : <ChevronRightIcon className="h-5 w-5" />}
                            </button>
                        <input
                          type="checkbox"
                              checked={isFamilySelected}
                              ref={(el) => { if (el) el.indeterminate = isPartiallySelected; }}
                              onChange={(e) => { e.stopPropagation(); toggleFamilySelection(family.id, members); }}
                          onClick={(e) => e.stopPropagation()}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <h4 className="text-md font-medium text-gray-900 truncate">{family.name}</h4>
                                {family.alreadyImported && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                                    <CheckCircleIcon className="h-3 w-3 mr-1" />
                                    Already Imported
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-gray-500">
                                {members.length} {members.length === 1 ? 'member' : 'members'}
                                {family.isIndividual && (
                                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
                                    Individual
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>
                        </div>

                        {isExpanded && members.length > 0 && (
                          <div className="border-t border-gray-200 bg-gray-50 p-4">
                            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                              {members.map((person) => {
                                const isSelected = selectedPeople.has(person.id);
                                const displayName = getPersonDisplayName(person, family.name);
                                const isArchived = person.archived === 1 || person.archived === '1';

                                return (
                                  <div
                                    key={person.id}
                                    className={`flex items-center p-3 rounded-md border-2 cursor-pointer transition-colors ${
                                      isSelected ? 'border-primary-500 bg-white'
                                        : isArchived ? 'border-gray-200 bg-gray-100 opacity-75'
                                        : 'border-gray-200 bg-white hover:border-gray-300'
                                    }`}
                                    onClick={() => togglePersonSelection(person.id, family.id, members)}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      onChange={() => togglePersonSelection(person.id, family.id, members)}
                                      onClick={(e) => e.stopPropagation()}
                                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mr-3 flex-shrink-0"
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className={`text-sm font-medium truncate ${isArchived ? 'text-gray-500' : 'text-gray-900'}`}>
                                          {displayName}
                                        </span>
                                        {isArchived && (
                                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-600">
                                            Archived
                                          </span>
                                        )}
                                      </div>
                                      {person.family_relationship && person.family_relationship !== 'Primary Contact' && (
                                        <span className="text-xs text-gray-500">{person.family_relationship}</span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                    </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Gatherings Tab Content */}
      {activeTab === 'gatherings' && (
        <>
          {/* Search */}
          <div className="bg-white shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <div className="relative">
                <input
                  type="text"
                  value={gatheringsSearchTerm}
                  onChange={(e) => setGatheringsSearchTerm(e.target.value)}
                  placeholder="Search groups..."
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm pl-10"
                />
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
              </div>
            </div>
          </div>

          {/* Groups Section */}
          <div className="bg-white shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 flex items-center">
                  <UserGroupIcon className="h-5 w-5 mr-2 text-gray-500" />
                  Groups ({filteredGroups.length})
                </h3>
                {selectedGroups.size > 0 && (
                  <span className="text-sm text-gray-600">{selectedGroups.size} selected</span>
                )}
              </div>

              {loadingGatherings ? (
                <div className="flex items-center justify-center h-32">
                  <ArrowPathIcon className="h-8 w-8 animate-spin text-primary-600" />
                  <span className="ml-3 text-gray-600">Loading groups...</span>
                </div>
              ) : filteredGroups.length === 0 ? (
                <div className="text-center py-8">
                  <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-medium text-gray-900">No groups found</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {gatheringsSearchTerm ? 'Try adjusting your search.' : 'No groups available in Elvanto.'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredGroups.map((group) => {
                    const isSelected = selectedGroups.has(group.id);
                    return (
                      <div
                        key={group.id}
                        onClick={() => toggleGroupSelection(group.id)}
                        className={`p-4 rounded-lg border-2 cursor-pointer transition-colors ${
                          isSelected ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleGroupSelection(group.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1 mr-3"
                          />
                          <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-medium text-gray-900">{group.name}</h4>
                            {group.meeting_day && (
                              <p className="text-xs text-gray-500 mt-1">
                                {group.meeting_day} {group.meeting_time && `at ${group.meeting_time}`}
                                {group.meeting_frequency && ` (${group.meeting_frequency})`}
                              </p>
                            )}
                            {group.meeting_city && (
                              <p className="text-xs text-gray-400 mt-1">
                                {group.meeting_city}{group.meeting_state && `, ${group.meeting_state}`}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                        </div>
                      )}
                    </div>
          </div>

          {/* Service Types Section */}
          <div className="bg-white shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 flex items-center">
                  <CalendarDaysIcon className="h-5 w-5 mr-2 text-gray-500" />
                  Service Types ({serviceTypes.length})
                </h3>
                {selectedServiceTypes.size > 0 && (
                  <span className="text-sm text-gray-600">{selectedServiceTypes.size} selected</span>
                )}
              </div>

              {loadingGatherings ? (
                <div className="flex items-center justify-center h-32">
                  <ArrowPathIcon className="h-8 w-8 animate-spin text-primary-600" />
                  <span className="ml-3 text-gray-600">Loading services...</span>
                </div>
              ) : serviceTypes.length === 0 ? (
                <div className="text-center py-8">
                  <CalendarDaysIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-medium text-gray-900">No service types found</h3>
                  <p className="mt-1 text-sm text-gray-500">No services available in Elvanto.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {serviceTypes.map((serviceType) => {
                    const isSelected = selectedServiceTypes.has(serviceType.id);
                    return (
                      <div
                        key={serviceType.id}
                        onClick={() => toggleServiceTypeSelection(serviceType.id)}
                        className={`p-4 rounded-lg border-2 cursor-pointer transition-colors ${
                          isSelected ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleServiceTypeSelection(serviceType.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1 mr-3"
                          />
                          <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-medium text-gray-900">{serviceType.name}</h4>
                            <p className="text-xs text-gray-500 mt-1">
                              {serviceType.count} upcoming {serviceType.count === 1 ? 'service' : 'services'}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Floating Import Button - People */}
      {activeTab === 'people' && totalSelected > 0 && (
        <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-[9999]">
          <div className="flex items-center space-x-3">
            <div className="bg-white px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap border border-gray-200">
              Import {totalSelected} {totalSelected === 1 ? 'person' : 'people'}
            </div>
              <button
              onClick={handleImport}
              disabled={importing}
              className="w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all duration-200 disabled:opacity-50 hover:scale-105 active:scale-95"
              title="Import Selected"
            >
              {importing ? (
                <ArrowPathIcon className="h-6 w-6 animate-spin" />
              ) : (
                <ArrowRightIcon className="h-6 w-6" />
              )}
              </button>
          </div>
        </div>
      )}

      {/* Floating Import Button - Gatherings */}
      {activeTab === 'gatherings' && totalGatheringsSelected > 0 && (
        <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-[9999]">
          <div className="flex items-center space-x-3">
            <div className="bg-white px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap border border-gray-200">
              Import {totalGatheringsSelected} {totalGatheringsSelected === 1 ? 'gathering' : 'gatherings'}
            </div>
              <button
              onClick={handleImportGatherings}
              disabled={importing}
              className="w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all duration-200 disabled:opacity-50 hover:scale-105 active:scale-95"
              title="Import Selected Gatherings"
            >
              {importing ? (
                <ArrowPathIcon className="h-6 w-6 animate-spin" />
              ) : (
                <ArrowRightIcon className="h-6 w-6" />
              )}
              </button>
          </div>
        </div>
      )}

      {/* Import Success Toast */}
      {importResult?.success && (!importResult.errors || importResult.errors.length === 0) && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-[10000] animate-slide-down">
          <div className="bg-green-600 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center space-x-3 min-w-[300px] max-w-[500px]">
            <div className="bg-green-500 rounded-full p-2">
              <CheckCircleIcon className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <p className="font-semibold">Import Successful!</p>
              <p className="text-sm text-green-100">
                {importResult.imported?.people && importResult.imported.people.length > 0 && 
                  `${importResult.imported.people.length} people, ${importResult.imported.families?.length || 0} families`}
                {importResult.imported?.gatherings && importResult.imported.gatherings.length > 0 && 
                  `${importResult.imported.gatherings.length} gathering(s) created`}
                {importResult.message && importResult.message}
              </p>
              {importResult.duplicates && importResult.duplicates.length > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-green-200 hover:text-white">
                    {importResult.duplicates.length} gathering(s) already exist (click to view)
                  </summary>
                  <ul className="mt-1 space-y-1 max-h-32 overflow-y-auto">
                    {importResult.duplicates.map((dup, idx) => (
                      <li key={idx} className="text-green-100">• {dup.name}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <button
              onClick={() => setImportResult(null)}
              className="text-green-200 hover:text-white p-1"
            >
              <XCircleIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {/* Partial Success / Warning Toast */}
      {importResult?.success && importResult.errors && importResult.errors.length > 0 && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-[10000] animate-slide-down">
          <div className="bg-yellow-600 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center space-x-3 min-w-[400px] max-w-[600px]">
            <div className="bg-yellow-500 rounded-full p-2">
              <InformationCircleIcon className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <p className="font-semibold">Import Completed with Errors</p>
              <p className="text-sm text-yellow-100">
                {importResult.summary && (
                  <>
                    Successfully imported: {importResult.summary.peopleImported} people, {importResult.summary.familiesImported} families.
                    {importResult.summary.errorCount > 0 && ` ${importResult.summary.errorCount} error(s) occurred.`}
                  </>
                )}
              </p>
              {importResult.errors && importResult.errors.length > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-yellow-200 hover:text-white">Show errors</summary>
                  <ul className="mt-1 space-y-1 max-h-40 overflow-y-auto">
                    {importResult.errors.map((error, idx) => (
                      <li key={idx} className="text-yellow-100">• {error}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <button
              onClick={() => setImportResult(null)}
              className="text-yellow-200 hover:text-white p-1"
            >
              <XCircleIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {/* Import Error Toast */}
      {importResult && !importResult.success && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-[10000] animate-slide-down">
          <div className="bg-red-600 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center space-x-3 min-w-[300px]">
            <div className="bg-red-500 rounded-full p-2">
              <XCircleIcon className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <p className="font-semibold">Import Failed</p>
              <p className="text-sm text-red-100">
                {importResult.errors?.[0] || 'An error occurred during import'}
              </p>
            </div>
            <button
              onClick={() => setImportResult(null)}
              className="text-red-200 hover:text-white p-1"
            >
              <XCircleIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {/* Gathering Edit Modal */}
      {showGatheringEditModal && gatheringsNeedingInfo.length > 0 && createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[10000]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Add/Edit Gathering
                </h3>
                <button
                  onClick={() => {
                    setShowGatheringEditModal(false);
                    setGatheringsNeedingInfo([]);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XCircleIcon className="h-6 w-6" />
                </button>
              </div>

              <div className="mb-4">
                <p className="text-sm text-gray-600 mb-2">
                  Gathering {currentGatheringIndex + 1} of {gatheringsNeedingInfo.length}
                </p>
                {gatheringsNeedingInfo[currentGatheringIndex]?.isDuplicate && (
                  <p className="text-sm text-yellow-600 mb-2">
                    ⚠️ A gathering with this name already exists. Please change the name.
                  </p>
                )}
                {!gatheringsNeedingInfo[currentGatheringIndex]?.dayOfWeek || !gatheringsNeedingInfo[currentGatheringIndex]?.startTime ? (
                  <p className="text-sm text-yellow-600 mb-2">
                    ⚠️ Day of week and start time are required.
                  </p>
                ) : null}
              </div>

              <form onSubmit={(e) => { e.preventDefault(); handleGatheringEditNext(); }} className="space-y-4">
                <div>
                  <label htmlFor="gathering-name" className="block text-sm font-medium text-gray-700 mb-1">
                    Gathering Name *
                  </label>
                  <input
                    id="gathering-name"
                    type="text"
                    value={gatheringEditData.name}
                    onChange={(e) => setGatheringEditData({ ...gatheringEditData, name: e.target.value })}
                    className="w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Sunday Service"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="gathering-description" className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    id="gathering-description"
                    value={gatheringEditData.description}
                    onChange={(e) => setGatheringEditData({ ...gatheringEditData, description: e.target.value })}
                    rows={2}
                    className="w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Weekly worship service"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="dayOfWeek" className="block text-sm font-medium text-gray-700 mb-1">
                      Day of Week *
                    </label>
                    <select
                      id="dayOfWeek"
                      value={gatheringEditData.dayOfWeek}
                      onChange={(e) => setGatheringEditData({ ...gatheringEditData, dayOfWeek: e.target.value })}
                      className="w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      required
                    >
                      <option value="Sunday">Sunday</option>
                      <option value="Monday">Monday</option>
                      <option value="Tuesday">Tuesday</option>
                      <option value="Wednesday">Wednesday</option>
                      <option value="Thursday">Thursday</option>
                      <option value="Friday">Friday</option>
                      <option value="Saturday">Saturday</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="startTime" className="block text-sm font-medium text-gray-700 mb-1">
                      Start Time *
                    </label>
                    <input
                      id="startTime"
                      type="time"
                      value={gatheringEditData.startTime}
                      onChange={(e) => setGatheringEditData({ ...gatheringEditData, startTime: e.target.value })}
                      className="w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="frequency" className="block text-sm font-medium text-gray-700 mb-1">
                      Frequency *
                    </label>
                    <select
                      id="frequency"
                      value={gatheringEditData.frequency}
                      onChange={(e) => setGatheringEditData({ ...gatheringEditData, frequency: e.target.value })}
                      className="w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      required
                    >
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Bi-weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end space-x-3 mt-6">
                  <button
                    type="button"
                    onClick={() => {
                      setShowGatheringEditModal(false);
                      setGatheringsNeedingInfo([]);
                    }}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700"
                  >
                    {currentGatheringIndex < gatheringsNeedingInfo.length - 1 ? 'Next' : 'Import'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Gathering Selection Modal for People Import */}
      {showGatheringSelectionModal && createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[10000]">
          <div className="flex items-center justify-center min-h-screen p-4">
            <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Assign to Gatherings
                </h3>
                <button
                  onClick={() => {
                    setShowGatheringSelectionModal(false);
                    setPendingImportData(null);
                    setSelectedGatheringIds(new Set());
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XCircleIcon className="h-6 w-6" />
                </button>
              </div>

              <div className="mb-4">
                <p className="text-sm text-gray-600 mb-2">
                  Select which gatherings to assign the imported people to. You can skip this step and assign them later.
                </p>
              </div>

              <div className="max-h-96 overflow-y-auto border border-gray-200 rounded-md p-4 mb-4">
                {availableGatherings.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-4">No gatherings available</p>
                ) : (
                  <div className="space-y-2">
                    {availableGatherings.map((gathering) => (
                      <label
                        key={gathering.id}
                        className="flex items-center space-x-3 p-2 hover:bg-gray-50 rounded cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedGatheringIds.has(gathering.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedGatheringIds(prev => new Set([...prev, gathering.id]));
                            } else {
                              setSelectedGatheringIds(prev => {
                                const next = new Set(prev);
                                next.delete(gathering.id);
                                return next;
                              });
                            }
                          }}
                          className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="text-sm text-gray-700">{gathering.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end space-x-3 mt-6">
                <button
                  onClick={() => {
                    setShowGatheringSelectionModal(false);
                    setPendingImportData(null);
                    setSelectedGatheringIds(new Set());
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={performPeopleImport}
                  disabled={importing}
                  className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {importing ? 'Importing...' : 'Import'}
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

export default ElvantoImportPage;
