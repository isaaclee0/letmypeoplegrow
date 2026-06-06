import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  CalendarDaysIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  LinkIcon,
  LinkSlashIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  UserGroupIcon,
  UsersIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { integrationsAPI, gatheringsAPI } from '../../services/api';
import Modal from '../Modal';
import logger from '../../utils/logger';
import { ElvantoStatus, PanelProps } from './types';

// ---------------------------------------------------------------------------
// Interfaces (from ImportPage)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ElvantoIntegrationPanel: React.FC<PanelProps<ElvantoStatus>> = ({ status, refreshStatus, onBack }) => {
  // --- Connect / disconnect state ---
  const [elvantoApiKey, setElvantoApiKey] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showApiKeyGuide, setShowApiKeyGuide] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);

  // --- Import: people tab state ---
  const [activeTab, setActiveTab] = useState<TabType>('people');
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

  // Gathering selection modal (for people import)
  const [showGatheringSelectionModal, setShowGatheringSelectionModal] = useState(false);
  const [availableGatherings, setAvailableGatherings] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedGatheringIds, setSelectedGatheringIds] = useState<Set<number>>(new Set());
  const [pendingImportData, setPendingImportData] = useState<{ peopleIds?: string[]; familyIds?: string[] } | null>(null);

  // --- Import: gatherings tab state ---
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

  // ---------------------------------------------------------------------------
  // Handlers: connect / disconnect
  // ---------------------------------------------------------------------------

  const handleElvantoConnect = async () => {
    if (!elvantoApiKey.trim()) {
      setConnectionError('Please enter your Elvanto API key.');
      return;
    }

    try {
      setSavingConfig(true);
      setConnectionError(null);
      await integrationsAPI.connectElvanto(elvantoApiKey.trim());
      setElvantoApiKey('');
      await refreshStatus();
    } catch (error: any) {
      logger.error('Failed to connect Elvanto:', error);
      setConnectionError(error.response?.data?.error || 'Failed to connect. Please check your API key.');
      localStorage.setItem('elvanto_connected', 'false');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleElvantoDisconnect = async () => {
    setShowDisconnectModal(true);
  };

  const confirmDisconnect = async () => {
    setShowDisconnectModal(false);

    try {
      logger.debug('🔌 [CLIENT] Starting Elvanto disconnect...');

      // CRITICAL: Clear all Elvanto-related localStorage items to prevent re-sync
      logger.debug('🔌 [CLIENT] Clearing Elvanto localStorage items...');
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.includes('elvanto') || key.includes('Elvanto'))) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => {
        logger.debug(`🔌 [CLIENT] Removing localStorage key: ${key}`);
        localStorage.removeItem(key);
      });

      // Also clear the elvanto_connected status
      localStorage.setItem('elvanto_connected', 'false');

      // Perform the disconnect
      logger.debug('🔌 [CLIENT] Calling disconnectElvanto API...');
      const disconnectResponse = await integrationsAPI.disconnectElvanto();
      logger.debug('🔌 [CLIENT] Disconnect API response:', disconnectResponse);

      // Verify the disconnect by checking status after a brief delay
      await new Promise(resolve => setTimeout(resolve, 200));

      // Refresh status to confirm disconnect
      const statusResponse = await integrationsAPI.getElvantoStatus();
      const connected = statusResponse.data.connected === true;

      logger.debug('🔌 [CLIENT] Status check after disconnect:', {
        connected,
        configured: statusResponse.data.configured,
        fullResponse: statusResponse.data
      });

      localStorage.setItem('elvanto_connected', connected.toString());

      if (connected) {
        logger.error('🔌 [CLIENT] ERROR: Status still shows connected after disconnect!', statusResponse.data);
        logger.error('Elvanto disconnect may have failed - status still shows connected', statusResponse.data);
        localStorage.setItem('elvanto_connected', 'false');
        await refreshStatus();
      } else {
        logger.debug('🔌 [CLIENT] Successfully disconnected - status confirmed');
        // Refresh the page to remove the "Import from Elvanto" menu option
        window.location.reload();
      }
    } catch (error: any) {
      logger.error('🔌 [CLIENT] Disconnect error:', error);
      logger.error('🔌 [CLIENT] Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        config: error.config
      });
      logger.error('Failed to disconnect Elvanto:', error);
      localStorage.setItem('elvanto_connected', 'false');
      await refreshStatus();
    }
  };

  // ---------------------------------------------------------------------------
  // Handlers: import — people
  // ---------------------------------------------------------------------------

  const loadFamilies = useCallback(async () => {
    if (!status.connected) return;

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
    } finally {
      setLoading(false);
    }
  }, [searchTerm, status.connected, showArchived]);

  const loadGatherings = useCallback(async () => {
    if (!status.connected) return;

    try {
      setLoadingGatherings(true);

      const [groupsResponse, servicesResponse] = await Promise.all([
        integrationsAPI.getElvantoGroups({ per_page: 100 }),
        integrationsAPI.getElvantoServices({ per_page: 100 })
      ]);

      const groupsData = groupsResponse.data?.groups?.group || [];
      setGroups(groupsData);

      const servicesData = servicesResponse.data?.services?.service || [];
      setServices(servicesData);

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
    } finally {
      setLoadingGatherings(false);
    }
  }, [status.connected]);

  useEffect(() => {
    if (status.connected) {
      loadFamilies();
    }
  }, [loadFamilies, status.connected]);

  useEffect(() => {
    if (status.connected && activeTab === 'gatherings' && groups.length === 0 && services.length === 0) {
      loadGatherings();
    }
  }, [activeTab, status.connected, groups.length, services.length, loadGatherings]);

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

  const handleImport = async () => {
    if (selectedPeople.size === 0) {
      alert('Please select at least one person or family to import.');
      return;
    }

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

    setPendingImportData({
      peopleIds: individualPeopleIds.length > 0 ? individualPeopleIds : undefined,
      familyIds: familyIdsToImport.length > 0 ? familyIdsToImport : undefined
    });

    try {
      const gatheringsResponse = await gatheringsAPI.getAll();
      if (gatheringsResponse?.data?.gatherings) {
        setAvailableGatherings(gatheringsResponse.data.gatherings.map((g: any) => ({ id: g.id, name: g.name })));
      } else {
        setAvailableGatherings([]);
      }
    } catch (error) {
      logger.error('Failed to fetch gatherings:', error);
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

  // ---------------------------------------------------------------------------
  // Handlers: import — gatherings
  // ---------------------------------------------------------------------------

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

  const clearGatheringsSelection = () => {
    setSelectedGroups(new Set());
    setSelectedServiceTypes(new Set());
  };

  const handleImportGatherings = async () => {
    if (selectedGroups.size === 0 && selectedServiceTypes.size === 0) {
      alert('Please select at least one group or service type to import.');
      return;
    }

    try {
      await checkAndShowEditModal();
    } catch (error: any) {
      logger.error('Failed to check gatherings:', error);
      await checkAndShowEditModal();
    }
  };

  const checkAndShowEditModal = async () => {
    let duplicates: Array<{ id: string; name: string; type: 'group' | 'service'; existingId: number }> = [];
    try {
      const duplicatesResponse = await integrationsAPI.checkGatheringDuplicates({
        groupIds: selectedGroups.size > 0 ? Array.from(selectedGroups) : undefined,
        serviceTypeIds: selectedServiceTypes.size > 0 ? Array.from(selectedServiceTypes) : undefined
      });
      duplicates = duplicatesResponse.data.duplicates || [];
    } catch (error) {
      logger.error('Failed to check duplicates:', error);
    }

    const duplicateIds = new Set(duplicates.map(d => d.id));

    const allGatherings: Array<{ id: string; name: string; description?: string; type: 'group' | 'service'; dayOfWeek: string; startTime: string; frequency: string; isDuplicate?: boolean }> = [];

    for (const groupId of selectedGroups) {
      if (skippedGatherings.has(groupId)) continue;

      const group = groups.find(g => g.id === groupId);
      if (!group) continue;

      const isDuplicate = duplicateIds.has(groupId);
      const hasDayOfWeek = group.meeting_day && ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].includes(group.meeting_day);
      const hasStartTime = group.meeting_time && group.meeting_time.trim() !== '';

      if (isDuplicate || !hasDayOfWeek || !hasStartTime) {
        let frequency = 'weekly';
        if (group.meeting_frequency) {
          const freq = group.meeting_frequency.toLowerCase();
          if (freq.includes('2 week') || freq.includes('fortnightly') || freq.includes('biweekly')) {
            frequency = 'biweekly';
          } else if (freq.includes('month')) {
            frequency = 'monthly';
          }
        }

        let dayOfWeek = '';
        if (group.meeting_day) {
          const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          if (days.includes(group.meeting_day)) {
            dayOfWeek = group.meeting_day;
          }
        }
        if (!dayOfWeek) dayOfWeek = 'Sunday';

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

    for (const serviceTypeId of selectedServiceTypes) {
      if (skippedGatherings.has(serviceTypeId)) continue;

      const serviceType = serviceTypes.find(st => st.id === serviceTypeId);
      if (!serviceType) continue;

      const isDuplicate = duplicateIds.has(serviceTypeId);

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

    await performGatheringImport();
  };

  const handleGatheringEditNext = () => {
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

    const currentGathering = gatheringsNeedingInfo[currentGatheringIndex];
    if (gatheringEditData.name !== currentGathering.name) {
      setNameOverrides(prev => ({
        ...prev,
        [currentGathering.id]: gatheringEditData.name
      }));
    }

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
      setShowGatheringEditModal(false);
      performGatheringImport(updated);
    }
  };

  const performGatheringImport = async (overrideInfo?: Array<{
    id: string;
    name: string;
    description?: string;
    type: 'group' | 'service';
    dayOfWeek: string;
    startTime: string;
    frequency: string;
    isDuplicate?: boolean;
  }>) => {
    try {
      setImporting(true);
      setImportResult(null);

      const infoSource = overrideInfo ?? gatheringsNeedingInfo;
      const gatheringInfo: Record<string, { name?: string; description?: string; dayOfWeek: string; startTime: string; frequency: string }> = {};
      infoSource.forEach(g => {
        gatheringInfo[g.id] = {
          name: g.name,
          description: g.description,
          dayOfWeek: g.dayOfWeek,
          startTime: g.startTime,
          frequency: g.frequency
        };
      });

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
      setNameOverrides({});
      setGatheringsNeedingInfo([]);

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

  const filteredGroups = groups.filter(group => {
    if (!group.meeting_day && !group.meeting_time) return false;
    if (gatheringsSearchTerm) {
      return group.name.toLowerCase().includes(gatheringsSearchTerm.toLowerCase()) ||
        group.description?.toLowerCase().includes(gatheringsSearchTerm.toLowerCase());
    }
    return true;
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* Back button */}
      <button
        onClick={onBack}
        className="inline-flex items-center text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 mb-4"
      >
        <ArrowLeftIcon className="h-4 w-4 mr-1.5" />
        Back to integrations
      </button>

      {/* Connection status header card */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-4">
            <div className="shrink-0">
              <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
            </div>
            <div>
              <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">Elvanto</h4>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Import people and families from your Elvanto account.
              </p>
              {status.connected && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center">
                  <CheckCircleIcon className="w-3 h-3 mr-1" />
                  {status.elvantoAccount || 'Connected'}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center space-x-3">
            {status.loading ? (
              <ArrowPathIcon className="w-5 h-5 animate-spin text-gray-400" />
            ) : status.connected ? (
              <>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                  <ShieldCheckIcon className="w-3 h-3 mr-1" />
                  Connected
                </span>
                <button
                  onClick={handleElvantoDisconnect}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                Not Connected
              </span>
            )}
          </div>
        </div>

        {/* API Key Connection Form — only when not connected */}
        {!status.connected && !status.loading && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
            <div className="flex items-center justify-between mb-4">
              <h5 className="text-base font-medium text-gray-900 dark:text-gray-100">Connect with API Key</h5>
              <button
                onClick={() => setShowApiKeyGuide(true)}
                className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <InformationCircleIcon className="h-4 w-4 mr-1.5" />
                How to get API Key
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="elvanto-api-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Elvanto API Key
                </label>
                <input
                  type="password"
                  id="elvanto-api-key"
                  value={elvantoApiKey}
                  onChange={(e) => setElvantoApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleElvantoConnect()}
                  className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  placeholder="Paste your Elvanto API key here"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Your API key is stored securely and only used to access your Elvanto data.
                </p>
              </div>

              {connectionError && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                  <div className="flex">
                    <ShieldExclamationIcon className="h-5 w-5 text-red-400 shrink-0" />
                    <div className="ml-2">
                      <p className="text-sm text-red-700 dark:text-red-400">{connectionError}</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={handleElvantoConnect}
                  disabled={savingConfig || !elvantoApiKey.trim()}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingConfig ? (
                    <>
                      <ArrowPathIcon className="h-4 w-4 mr-2 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <LinkIcon className="h-4 w-4 mr-2" />
                      Connect
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <div className="flex">
            <div className="shrink-0">
              <InformationCircleIcon className="h-5 w-5 text-blue-400" />
            </div>
            <div className="ml-3">
              <h4 className="text-sm font-medium text-blue-800 dark:text-blue-300">What you'll get</h4>
              <div className="mt-2 text-sm text-blue-700 dark:text-blue-400">
                <ul className="list-disc list-inside space-y-1">
                  <li>Sync people data between systems</li>
                  <li>Automated attendance tracking</li>
                  <li>Seamless integration with your existing workflow</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Import UI — only when connected                                     */}
      {/* ------------------------------------------------------------------ */}
      {status.connected && (
        <div className="mt-6 space-y-6 pb-32">
          {/* Sub-tabs */}
          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Import from Elvanto</h3>
                <button
                  onClick={activeTab === 'people' ? loadFamilies : loadGatherings}
                  disabled={loading || loadingGatherings}
                  className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
                >
                  <ArrowPathIcon className={`h-4 w-4 mr-2 ${(loading || loadingGatherings) ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>

              <div className="border-b border-gray-200 dark:border-gray-700">
                <nav className="-mb-px flex space-x-8">
                  <button
                    onClick={() => setActiveTab('people')}
                    className={`${
                      activeTab === 'people'
                        ? 'border-primary-500 text-primary-600'
                        : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
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
                        : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
                    } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm flex items-center`}
                  >
                    <CalendarDaysIcon className="h-5 w-5 mr-2" />
                    Gatherings
                  </button>
                </nav>
              </div>
            </div>
          </div>

          {/* People Tab */}
          {activeTab === 'people' && (
            <>
              {/* Search & Filters */}
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg">
                <div className="px-4 py-5 sm:p-6">
                  <div className="flex space-x-4">
                    <div className="flex-1">
                      <div className="relative">
                        <input
                          type="text"
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                          placeholder="Search families and people..."
                          className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm pl-10"
                        />
                        <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                      </div>
                    </div>
                    <button
                      onClick={handleSearch}
                      className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      Search
                    </button>
                  </div>

                  <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <input
                          type="checkbox"
                          id="showArchived"
                          checked={showArchived}
                          onChange={(e) => setShowArchived(e.target.checked)}
                          className="rounded border-gray-300 dark:border-gray-500 text-primary-600 focus:ring-primary-500"
                        />
                        <label htmlFor="showArchived" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          Show archived people
                        </label>
                      </div>
                      <div className="flex items-center gap-4">
                        {archivedCount > 0 && !showArchived && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">
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
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg">
                <div className="px-4 py-5 sm:p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-gray-100">
                      Families & People ({families.reduce((acc, f) => acc + (f.people?.person?.length || 0), 0)})
                    </h3>
                    <div className="flex items-center space-x-3">
                      {totalSelected > 0 ? (
                        <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-400">
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
                      <span className="ml-3 text-gray-600 dark:text-gray-400">Loading...</span>
                    </div>
                  ) : families.length === 0 ? (
                    <div className="text-center py-8">
                      <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
                      <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No families found</h3>
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
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
                              isFamilySelected ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                                : isPartiallySelected ? 'border-primary-300 bg-primary-25 dark:bg-primary-900/10'
                                : 'border-gray-200 dark:border-gray-700'
                            }`}
                          >
                            <div
                              className={`flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 ${
                                isFamilySelected ? 'hover:bg-primary-100 dark:hover:bg-primary-900/30' : ''
                              }`}
                              onClick={() => toggleFamilyExpanded(family.id)}
                            >
                              <div className="flex items-center space-x-3 flex-1 min-w-0">
                                <button
                                  onClick={(e) => { e.stopPropagation(); toggleFamilyExpanded(family.id); }}
                                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                                >
                                  {isExpanded ? <ChevronDownIcon className="h-5 w-5" /> : <ChevronRightIcon className="h-5 w-5" />}
                                </button>
                                <input
                                  type="checkbox"
                                  checked={isFamilySelected}
                                  ref={(el) => { if (el) el.indeterminate = isPartiallySelected; }}
                                  onChange={(e) => { e.stopPropagation(); toggleFamilySelection(family.id, members); }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <h4 className="text-base font-medium text-gray-900 dark:text-gray-100 truncate">{family.name}</h4>
                                    {family.alreadyImported && (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                                        <CheckCircleIcon className="h-3 w-3 mr-1" />
                                        Already Imported
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-gray-500 dark:text-gray-400">
                                    {members.length} {members.length === 1 ? 'member' : 'members'}
                                    {family.isIndividual && (
                                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-600 text-gray-800 dark:text-gray-200">
                                        Individual
                                      </span>
                                    )}
                                  </p>
                                </div>
                              </div>
                            </div>

                            {isExpanded && members.length > 0 && (
                              <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 p-4">
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                                  {members.map((person) => {
                                    const isSelected = selectedPeople.has(person.id);
                                    const displayName = getPersonDisplayName(person, family.name);
                                    const isArchived = person.archived === 1 || person.archived === '1';

                                    return (
                                      <div
                                        key={person.id}
                                        className={`flex items-center p-3 rounded-md border-2 cursor-pointer transition-colors ${
                                          isSelected ? 'border-primary-500 bg-white dark:bg-gray-800'
                                            : isArchived ? 'border-gray-200 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 opacity-75'
                                            : 'border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-500'
                                        }`}
                                        onClick={() => togglePersonSelection(person.id, family.id, members)}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isSelected}
                                          onChange={() => togglePersonSelection(person.id, family.id, members)}
                                          onClick={(e) => e.stopPropagation()}
                                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded mr-3 shrink-0"
                                        />
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center gap-2">
                                            <span className={`text-sm font-medium truncate ${isArchived ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>
                                              {displayName}
                                            </span>
                                            {isArchived && (
                                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
                                                Archived
                                              </span>
                                            )}
                                          </div>
                                          {person.family_relationship && person.family_relationship !== 'Primary Contact' && (
                                            <span className="text-xs text-gray-500 dark:text-gray-400">{person.family_relationship}</span>
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

          {/* Gatherings Tab */}
          {activeTab === 'gatherings' && (
            <>
              {/* Search */}
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg">
                <div className="px-4 py-5 sm:p-6">
                  <div className="relative">
                    <input
                      type="text"
                      value={gatheringsSearchTerm}
                      onChange={(e) => setGatheringsSearchTerm(e.target.value)}
                      placeholder="Search groups..."
                      className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm pl-10"
                    />
                    <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                  </div>
                </div>
              </div>

              {/* Groups Section */}
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg">
                <div className="px-4 py-5 sm:p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-gray-100 flex items-center">
                      <UserGroupIcon className="h-5 w-5 mr-2 text-gray-500" />
                      Groups ({filteredGroups.length})
                    </h3>
                    {selectedGroups.size > 0 && (
                      <span className="text-sm text-gray-600 dark:text-gray-400">{selectedGroups.size} selected</span>
                    )}
                  </div>

                  {loadingGatherings ? (
                    <div className="flex items-center justify-center h-32">
                      <ArrowPathIcon className="h-8 w-8 animate-spin text-primary-600" />
                      <span className="ml-3 text-gray-600 dark:text-gray-400">Loading groups...</span>
                    </div>
                  ) : filteredGroups.length === 0 ? (
                    <div className="text-center py-8">
                      <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
                      <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No groups found</h3>
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
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
                              isSelected ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20' : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                            }`}
                          >
                            <div className="flex items-start">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleGroupSelection(group.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded mt-1 mr-3"
                              />
                              <div className="flex-1 min-w-0">
                                <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">{group.name}</h4>
                                {group.meeting_day && (
                                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
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
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg">
                <div className="px-4 py-5 sm:p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-gray-100 flex items-center">
                      <CalendarDaysIcon className="h-5 w-5 mr-2 text-gray-500" />
                      Service Types ({serviceTypes.length})
                    </h3>
                    {selectedServiceTypes.size > 0 && (
                      <span className="text-sm text-gray-600 dark:text-gray-400">{selectedServiceTypes.size} selected</span>
                    )}
                  </div>

                  {loadingGatherings ? (
                    <div className="flex items-center justify-center h-32">
                      <ArrowPathIcon className="h-8 w-8 animate-spin text-primary-600" />
                      <span className="ml-3 text-gray-600 dark:text-gray-400">Loading services...</span>
                    </div>
                  ) : serviceTypes.length === 0 ? (
                    <div className="text-center py-8">
                      <CalendarDaysIcon className="mx-auto h-12 w-12 text-gray-400" />
                      <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No service types found</h3>
                      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">No services available in Elvanto.</p>
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
                              isSelected ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20' : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                            }`}
                          >
                            <div className="flex items-start">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleServiceTypeSelection(serviceType.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded mt-1 mr-3"
                              />
                              <div className="flex-1 min-w-0">
                                <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">{serviceType.name}</h4>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
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

          {/* Floating Import Button — People */}
          {activeTab === 'people' && totalSelected > 0 && createPortal(
            <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-[9999]">
              <div className="flex items-center space-x-3">
                <div className="bg-white dark:bg-gray-800 px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap border border-gray-200 dark:border-gray-700">
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
            </div>,
            document.body
          )}

          {/* Floating Import Button — Gatherings */}
          {activeTab === 'gatherings' && totalGatheringsSelected > 0 && createPortal(
            <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-[9999]">
              <div className="flex items-center space-x-3">
                <div className="bg-white dark:bg-gray-800 px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap border border-gray-200 dark:border-gray-700">
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
            </div>,
            document.body
          )}

          {/* Import Success Toast */}
          {importResult?.success && (!importResult.errors || importResult.errors.length === 0) && createPortal(
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
            </div>,
            document.body
          )}

          {/* Partial Success / Warning Toast */}
          {importResult?.success && importResult.errors && importResult.errors.length > 0 && createPortal(
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
            </div>,
            document.body
          )}

          {/* Import Error Toast */}
          {importResult && !importResult.success && createPortal(
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
            </div>,
            document.body
          )}

          {/* Gathering Edit Modal */}
          {showGatheringEditModal && gatheringsNeedingInfo.length > 0 && createPortal(
            <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-[10000]">
              <div className="flex items-center justify-center min-h-screen p-4">
                <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                      Add/Edit Gathering
                    </h3>
                    <button
                      onClick={() => {
                        setShowGatheringEditModal(false);
                        setGatheringsNeedingInfo([]);
                      }}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      <XCircleIcon className="h-6 w-6" />
                    </button>
                  </div>

                  <div className="mb-4">
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                      Gathering {currentGatheringIndex + 1} of {gatheringsNeedingInfo.length}
                    </p>
                    {gatheringsNeedingInfo[currentGatheringIndex]?.isDuplicate && (
                      <p className="text-sm text-yellow-600 dark:text-yellow-400 mb-2">
                        ⚠️ A gathering with this name already exists. Please change the name.
                      </p>
                    )}
                    {!gatheringsNeedingInfo[currentGatheringIndex]?.dayOfWeek || !gatheringsNeedingInfo[currentGatheringIndex]?.startTime ? (
                      <p className="text-sm text-yellow-600 dark:text-yellow-400 mb-2">
                        ⚠️ Day of week and start time are required.
                      </p>
                    ) : null}
                  </div>

                  <form onSubmit={(e) => { e.preventDefault(); handleGatheringEditNext(); }} className="space-y-4">
                    <div>
                      <label htmlFor="gathering-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        Gathering Name *
                      </label>
                      <input
                        id="gathering-name"
                        type="text"
                        value={gatheringEditData.name}
                        onChange={(e) => setGatheringEditData({ ...gatheringEditData, name: e.target.value })}
                        className="w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="Sunday Service"
                        required
                      />
                    </div>

                    <div>
                      <label htmlFor="gathering-description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        Description
                      </label>
                      <textarea
                        id="gathering-description"
                        value={gatheringEditData.description}
                        onChange={(e) => setGatheringEditData({ ...gatheringEditData, description: e.target.value })}
                        rows={2}
                        className="w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="Weekly worship service"
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label htmlFor="dayOfWeek" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Day of Week *
                        </label>
                        <select
                          id="dayOfWeek"
                          value={gatheringEditData.dayOfWeek}
                          onChange={(e) => setGatheringEditData({ ...gatheringEditData, dayOfWeek: e.target.value })}
                          className="w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
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
                        <label htmlFor="startTime" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Start Time *
                        </label>
                        <input
                          id="startTime"
                          type="time"
                          value={gatheringEditData.startTime}
                          onChange={(e) => setGatheringEditData({ ...gatheringEditData, startTime: e.target.value })}
                          className="w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                          required
                        />
                      </div>

                      <div>
                        <label htmlFor="frequency" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Frequency *
                        </label>
                        <select
                          id="frequency"
                          value={gatheringEditData.frequency}
                          onChange={(e) => setGatheringEditData({ ...gatheringEditData, frequency: e.target.value })}
                          className="w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
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
                        className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
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
            <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-[10000]">
              <div className="flex items-center justify-center min-h-screen p-4">
                <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                      Assign to Gatherings
                    </h3>
                    <button
                      onClick={() => {
                        setShowGatheringSelectionModal(false);
                        setPendingImportData(null);
                        setSelectedGatheringIds(new Set());
                      }}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      <XCircleIcon className="h-6 w-6" />
                    </button>
                  </div>

                  <div className="mb-4">
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                      Select which gatherings to assign the imported people to. You can skip this step and assign them later.
                    </p>
                  </div>

                  <div className="max-h-96 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md p-4 mb-4">
                    {availableGatherings.length === 0 ? (
                      <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">No gatherings available</p>
                    ) : (
                      <div className="space-y-2">
                        {availableGatherings.map((gathering) => (
                          <label
                            key={gathering.id}
                            className="flex items-center space-x-3 p-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer"
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
                              className="rounded border-gray-300 dark:border-gray-500 text-primary-600 focus:ring-primary-500"
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-300">{gathering.name}</span>
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
                      className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
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
      )}

      {/* API Key Setup Guide Modal */}
      <Modal
        isOpen={showApiKeyGuide}
        onClose={() => setShowApiKeyGuide(false)}
        className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">How to Get Your Elvanto API Key</h2>
            <button
              onClick={() => setShowApiKeyGuide(false)}
              className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 focus:outline-none"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          <div className="space-y-6">
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <p className="text-sm text-blue-800 dark:text-blue-300">
                Follow these simple steps to get your API key from Elvanto. You'll need admin access to your Elvanto account.
              </p>
            </div>

            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    1
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Log in to Elvanto</h3>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Go to <a href="https://www.elvanto.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline">elvanto.com</a> and log in with your admin account.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    2
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Go to Settings → Integrations</h3>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Click on <strong>Settings</strong> in the top menu, then select <strong>Integrations</strong> from the sidebar.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    3
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Find API Access</h3>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Look for <strong>API Access</strong> or <strong>Developer</strong> section. Click on it to view your API keys.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-l-4 border-blue-500 pl-4">
              <div className="flex items-start">
                <div className="shrink-0">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-500 text-white font-semibold">
                    4
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Copy Your API Key</h3>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    Copy your API key and paste it into the field above. If you don't have one, you can generate a new key from this page.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
              <div className="flex">
                <InformationCircleIcon className="h-5 w-5 text-yellow-400 shrink-0" />
                <div className="ml-3">
                  <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-300">Keep Your API Key Secure</h4>
                  <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-400">
                    Your API key provides access to your Elvanto data. Keep it private and don't share it publicly.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => setShowApiKeyGuide(false)}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Elvanto Disconnect Confirmation Modal */}
      <Modal
        isOpen={showDisconnectModal}
        onClose={() => setShowDisconnectModal(false)}
      >
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Disconnect Elvanto
              </h3>
              <button
                onClick={() => setShowDisconnectModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-yellow-100 dark:bg-yellow-900/30 rounded-full">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600" />
            </div>

            <div className="text-center mb-6">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Are you sure you want to disconnect from Elvanto?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                This will stop syncing data between the services. You can reconnect at any time.
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDisconnect}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
              >
                <LinkSlashIcon className="h-4 w-4 mr-2" />
                Disconnect
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default ElvantoIntegrationPanel;
