import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { gatheringsAPI } from '../services/api';
import logger from '../utils/logger';
import {
  PlusIcon,
  UserGroupIcon,
  CalendarIcon,
  TrashIcon,
  CheckIcon,
  XMarkIcon,
  DocumentDuplicateIcon,
  PencilIcon
} from '@heroicons/react/24/outline';

interface Gathering {
  id: number;
  name: string;
  description: string;
  dayOfWeek?: string;
  startTime?: string;
  endTime?: string;
  frequency?: string;
  attendanceType: 'standard' | 'headcount';
  customSchedule?: {
    type: 'one_off' | 'recurring';
    startDate: string;
    endDate?: string;
    pattern?: {
      frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly';
      interval: number;
      daysOfWeek?: string[];
      dayOfMonth?: number;
      customDates?: string[];
    };
  };
  kioskEnabled?: boolean;
  isActive: boolean;
  memberCount?: number;
  recentVisitorCount?: number;
}

interface CreateGatheringData {
  // Basic details
  name: string;
  description: string;
  dayOfWeek?: string;
  startTime?: string;
  endTime?: string;
  frequency?: string;
  attendanceType: 'standard' | 'headcount';
  customSchedule?: {
    type: 'one_off' | 'recurring';
    startDate: string;
    endDate?: string;
    pattern?: {
      frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly';
      interval: number;
      daysOfWeek?: string[];
      dayOfMonth?: number;
      customDates?: string[];
    };
  };
  kioskEnabled?: boolean;
}

const ManageGatheringsPage: React.FC = () => {

  const { user } = useAuth();
  const navigate = useNavigate();
  const [gatherings, setGatherings] = useState<Gathering[]>([]);
  const [selectedGathering, setSelectedGathering] = useState<Gathering | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [showEditForm, setShowEditForm] = useState(false);
  const [showAddGatheringWizard, setShowAddGatheringWizard] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingGathering, setEditingGathering] = useState<Gathering | null>(null);
  
  // Form states
  const [editFormData, setEditFormData] = useState({
    name: '',
    description: '',
    dayOfWeek: 'Sunday',
    startTime: '10:00',
    endTime: '11:00',
    frequency: 'weekly',
    attendanceType: 'standard' as 'standard' | 'headcount',
    customSchedule: undefined as any,
    kioskEnabled: false
  });

  const [createGatheringData, setCreateGatheringData] = useState<CreateGatheringData>({
    name: 'Sunday Morning Service',
    description: 'Weekly Sunday morning gathering',
    dayOfWeek: 'Sunday',
    startTime: '10:00',
    endTime: '11:00',
    frequency: 'weekly',
    attendanceType: 'standard',
    kioskEnabled: false
  });

  // Confirmation modal states
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    gatheringId: number | null;
    gatheringName: string;
  }>({ gatheringId: null, gatheringName: '' });

  // Manage occurrences modal states
  const [showManageOccurrencesModal, setShowManageOccurrencesModal] = useState(false);
  const [selectedOccurrences, setSelectedOccurrences] = useState<string[]>([]);
  const [gatheringOccurrences, setGatheringOccurrences] = useState<{
    gathering: Gathering | null;
    occurrences: Array<{ date: string; canDelete: boolean }>;
  }>({ gathering: null, occurrences: [] });

  // Duplicate modal states
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicateGathering, setDuplicateGathering] = useState<Gathering | null>(null);
  const [duplicateName, setDuplicateName] = useState('');
  const [isDuplicating, setIsDuplicating] = useState(false);
  
  // People prompt states - now just for tracking if we should show the animated arrow
  const [showArrowPrompt, setShowArrowPrompt] = useState(false);

  // Selection state
  const [selectedGatherings, setSelectedGatherings] = useState<number[]>([]);

  useEffect(() => {
    loadGatherings();
  }, []);

  // Auto-hide the arrow after 8 seconds
  useEffect(() => {
    if (showArrowPrompt) {
      const timer = setTimeout(() => {
        setShowArrowPrompt(false);
      }, 8000);
      return () => clearTimeout(timer);
    }
  }, [showArrowPrompt]);

  const loadGatherings = async () => {
    try {
      setIsLoading(true);
      const response = await gatheringsAPI.getAll();
      const gatherings = response.data.gatherings || [];
      setGatherings(gatherings);
      
      // Check if user has gatherings but they have very few people (likely a new user) - show arrow prompt
      if (gatherings.length > 0) {
        const totalMembers = gatherings.reduce((sum: number, gathering: Gathering) => sum + (gathering.memberCount || 0), 0);
        const hasSeenPrompt = localStorage.getItem('people_prompt_dismissed') === 'true';
        // Show arrow prompt if they have no people, or if they have only 1-2 people across all gatherings (might be test data)
        // and they haven't dismissed it before
        if (totalMembers <= 2 && !hasSeenPrompt) {
          setShowArrowPrompt(true);
        }
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load gatherings');
    } finally {
      setIsLoading(false);
    }
  };

  // removed: loadUsers



  // Reset wizard state
  const resetWizardState = useCallback(() => {
    setCreateGatheringData({
      name: 'Sunday Morning Service',
      description: 'Weekly Sunday morning gathering',
      dayOfWeek: 'Sunday',
      startTime: '10:00',
      frequency: 'weekly'
    });
    setError('');
    setSuccess('');
  }, []);

  const closeAddModal = useCallback(() => {
    setShowAddGatheringWizard(false);
    resetWizardState();
  }, [resetWizardState]);

  const closeEditModal = useCallback(() => {
    setShowEditForm(false);
    setEditingGathering(null);
  }, []);

  const openAddModal = useCallback(() => {
    resetWizardState();
    setSuccess(''); // Clear any previous success messages
    setShowAddGatheringWizard(true);
  }, [resetWizardState]);

  // removed: user assignment options

  // Wizard steps removed; simple create modal only
  const canProceedFromStep1 = useCallback(() => {
    return createGatheringData.name.trim().length > 0;
  }, [createGatheringData.name]);



  // Handle gathering creation
  const handleCreateGathering = async () => {
    try {
      setIsCreating(true);
      setError('');

      // Create the gathering
      // Ensure time format is correct (HH:MM)
      const formattedStartTime = createGatheringData.startTime.length === 4 
        ? `0${createGatheringData.startTime}` 
        : createGatheringData.startTime;
      
      const gatheringData = {
        name: createGatheringData.name,
        description: createGatheringData.description,
        dayOfWeek: createGatheringData.dayOfWeek,
        startTime: formattedStartTime,
        frequency: createGatheringData.frequency,
        attendanceType: createGatheringData.attendanceType,
        customSchedule: createGatheringData.customSchedule,
        kioskEnabled: createGatheringData.kioskEnabled
      };
      
      logger.log('Creating gathering with data:', gatheringData);
      
      const gatheringResponse = await gatheringsAPI.create(gatheringData);

      const newGatheringId = gatheringResponse.data.id;

      // Success - update local state
      const newGathering: Gathering = {
        id: newGatheringId,
        name: createGatheringData.name,
        description: createGatheringData.description,
        dayOfWeek: createGatheringData.dayOfWeek,
        startTime: createGatheringData.startTime,
        frequency: createGatheringData.frequency,
        attendanceType: createGatheringData.attendanceType,
        customSchedule: createGatheringData.customSchedule,
        kioskEnabled: createGatheringData.kioskEnabled,
        isActive: true,
        memberCount: 0,
        recentVisitorCount: 0
      };

      setGatherings([...gatherings, newGathering]);
      setSuccess(`Gathering "${createGatheringData.name}" created successfully.`);
      setShowAddGatheringWizard(false);
      resetWizardState();
      
      // Check if this is the first gathering and it has no members - show arrow prompt
      const hasSeenPrompt = localStorage.getItem('people_prompt_dismissed') === 'true';
      if (gatherings.length === 0 && newGathering.memberCount === 0 && !hasSeenPrompt) {
        setShowArrowPrompt(true);
      }

    } catch (err: any) {
      console.error('Create gathering error:', err);
      console.error('Error response data:', err.response?.data);
      console.error('Error status:', err.response?.status);
      
      // Handle validation errors
      if (err.response?.data?.errors) {
        const validationErrors = err.response.data.errors.map((e: any) => e.msg).join(', ');
        setError(`Validation errors: ${validationErrors}`);
      } else {
        setError(err.response?.data?.error || 'Failed to create gathering');
      }
    } finally {
      setIsCreating(false);
    }
  };



  const handleEditGathering = useCallback((gathering: Gathering) => {
    // Optimized with batched updates for efficiency
    setEditingGathering(gathering);
    setEditFormData({
      name: gathering.name,
      description: gathering.description || '',
      dayOfWeek: gathering.dayOfWeek,
      startTime: gathering.startTime,
      endTime: gathering.endTime || (gathering.startTime ? (() => {
        // Auto-calculate end time as start time + 1 hour if not set
        const [hours, minutes] = gathering.startTime.split(':').map(Number);
        const endHours = (hours + 1) % 24;
        return `${String(endHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      })() : '11:00'),
      frequency: gathering.frequency,
      attendanceType: gathering.attendanceType,
      customSchedule: gathering.customSchedule,
      kioskEnabled: gathering.kioskEnabled || false
    });
    setShowEditForm(true);
  }, []);

  const handleUpdateGathering = async () => {
    if (!editingGathering) return;

    try {
      await gatheringsAPI.update(editingGathering.id, editFormData);
      
      // Update the gathering in the local state
      setGatherings(gatherings.map(g => 
        g.id === editingGathering.id 
          ? { ...g, ...editFormData }
          : g
      ));
      
      setShowEditForm(false);
      setEditingGathering(null);
      setError('');
      
      // Clear selection after successful edit
      setSelectedGatherings([]);
      
      setSuccess('Gathering updated successfully');
      setTimeout(() => setSuccess(''), 5000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update gathering');
    }
  };



  const showDeleteConfirmation = useCallback((gatheringId: number, gatheringName: string) => {
    setDeleteConfirmation({ gatheringId, gatheringName });
    setShowDeleteModal(true);
  }, []);

  const handleManageMembers = useCallback(() => {
    navigate('/app/people');
  }, [navigate]);

  const handleDeleteGathering = async () => {
    if (!deleteConfirmation.gatheringId) return;

    try {
      await gatheringsAPI.delete(deleteConfirmation.gatheringId);
      setGatherings(gatherings.filter(g => g.id !== deleteConfirmation.gatheringId));
      if (selectedGathering?.id === deleteConfirmation.gatheringId) {
        setSelectedGathering(null);
      }
      
      // Remove from selection if it was selected
      setSelectedGatherings(prev => prev.filter(id => id !== deleteConfirmation.gatheringId));
      
      setSuccess('Gathering deleted successfully');
      setTimeout(() => setSuccess(''), 5000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete gathering');
    }
  };

  const handleDuplicateGathering = async () => {
    if (!duplicateGathering || !duplicateName.trim()) return;

    setIsDuplicating(true);
    try {
      const response = await gatheringsAPI.duplicate(duplicateGathering.id, duplicateName.trim());
      const newGathering = response.data.gathering;
      
      // Add the new gathering to the list
      setGatherings([...gatherings, newGathering]);
      
      // Close modal and reset state
      setShowDuplicateModal(false);
      setDuplicateGathering(null);
      setDuplicateName('');
      
      // Clear selection after successful duplication
      setSelectedGatherings([]);
      
      setSuccess(`Gathering "${newGathering.name}" created successfully!`);
      setTimeout(() => setSuccess(''), 5000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to duplicate gathering');
    } finally {
      setIsDuplicating(false);
    }
  };

  // Generate occurrences for a gathering (for display purposes)
  const generateGatheringOccurrences = (gathering: Gathering): Array<{ date: string; canDelete: boolean }> => {
    const occurrences: Array<{ date: string; canDelete: boolean }> = [];
    const today = new Date();
    const futureDate = new Date();
    futureDate.setMonth(futureDate.getMonth() + 3); // Show next 3 months

    if (gathering.attendanceType === 'headcount' && gathering.customSchedule) {
      // Handle custom schedule
      if (gathering.customSchedule.type === 'one_off') {
        const date = new Date(gathering.customSchedule.startDate);
        occurrences.push({
          date: date.toISOString().split('T')[0],
          canDelete: true
        });
      } else if (gathering.customSchedule.type === 'recurring' && gathering.customSchedule.pattern) {
        const startDate = new Date(gathering.customSchedule.startDate);
        const endDate = gathering.customSchedule.endDate ? new Date(gathering.customSchedule.endDate) : futureDate;
        const pattern = gathering.customSchedule.pattern;

        let currentDate = new Date(startDate);
        while (currentDate <= endDate && currentDate <= futureDate) {
          let shouldInclude = false;

          if (pattern.frequency === 'daily') {
            shouldInclude = true;
            currentDate.setDate(currentDate.getDate() + (pattern.interval || 1));
          } else if (pattern.frequency === 'weekly' && pattern.daysOfWeek) {
            const dayName = currentDate.toLocaleDateString('en-US', { weekday: 'long' });
            if (pattern.daysOfWeek.includes(dayName)) {
              shouldInclude = true;
            }
            currentDate.setDate(currentDate.getDate() + 1);
          } else if (pattern.frequency === 'monthly' && pattern.dayOfMonth) {
            if (currentDate.getDate() === pattern.dayOfMonth) {
              shouldInclude = true;
            }
            currentDate.setMonth(currentDate.getMonth() + (pattern.interval || 1));
            currentDate.setDate(pattern.dayOfMonth);
          }

          if (shouldInclude && currentDate >= today) {
            occurrences.push({
              date: currentDate.toISOString().split('T')[0],
              canDelete: true
            });
          }
        }
      }
    } else {
      // Handle regular schedule
      const dayMap: { [key: string]: number } = {
        'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
        'Thursday': 4, 'Friday': 5, 'Saturday': 6
      };

      const targetDay = dayMap[gathering.dayOfWeek || 'Sunday'];
      let currentDate = new Date(today);
      
      // Find next occurrence
      while (currentDate.getDay() !== targetDay) {
        currentDate.setDate(currentDate.getDate() + 1);
      }

      // Generate occurrences based on frequency
      while (currentDate <= futureDate) {
        occurrences.push({
          date: currentDate.toISOString().split('T')[0],
          canDelete: true
        });

        if (gathering.frequency === 'weekly') {
          currentDate.setDate(currentDate.getDate() + 7);
        } else if (gathering.frequency === 'biweekly') {
          currentDate.setDate(currentDate.getDate() + 14);
        } else if (gathering.frequency === 'monthly') {
          currentDate.setMonth(currentDate.getMonth() + 1);
        }
      }
    }

    return occurrences;
  };

  const handleManageOccurrences = (gathering: Gathering) => {
    const occurrences = generateGatheringOccurrences(gathering);
    setGatheringOccurrences({ gathering, occurrences });
    setSelectedOccurrences([]);
    setShowManageOccurrencesModal(true);
  };

  const handleDeleteSelectedOccurrences = async () => {
    if (!gatheringOccurrences.gathering || selectedOccurrences.length === 0) return;

    try {
      // TODO: Implement API call to delete specific occurrences
      // For now, we'll just show a success message
      setSuccess(`Deleted ${selectedOccurrences.length} occurrence(s) from "${gatheringOccurrences.gathering.name}"`);
      setShowManageOccurrencesModal(false);
      setSelectedOccurrences([]);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete occurrences');
    }
  };

  // Selection functions
  const toggleGatheringSelection = (gatheringId: number) => {
    setSelectedGatherings(prev => 
      prev.includes(gatheringId) 
        ? prev.filter(id => id !== gatheringId)
        : [...prev, gatheringId]
    );
  };

  const clearSelection = () => {
    setSelectedGatherings([]);
  };

  const selectAllGatherings = () => {
    setSelectedGatherings(gatherings.map(gathering => gathering.id));
  };

  const handleEditSelectedGathering = () => {
    if (selectedGatherings.length === 1) {
      const gathering = gatherings.find(g => g.id === selectedGatherings[0]);
      if (gathering) {
        handleEditGathering(gathering);
      }
    }
  };

  const handleDuplicateSelectedGathering = () => {
    if (selectedGatherings.length === 1) {
      const gathering = gatherings.find(g => g.id === selectedGatherings[0]);
      if (gathering) {
        setDuplicateGathering(gathering);
        setDuplicateName(`${gathering.name} (Copy)`);
        setShowDuplicateModal(true);
      }
    }
  };

  const handleManageOccurrencesSelectedGathering = () => {
    if (selectedGatherings.length === 1) {
      const gathering = gatherings.find(g => g.id === selectedGatherings[0]);
      if (gathering) {
        handleManageOccurrences(gathering);
      }
    }
  };

  const handleDeleteSelectedGatherings = () => {
    if (selectedGatherings.length === 1) {
      const gathering = gatherings.find(g => g.id === selectedGatherings[0]);
      if (gathering) {
        showDeleteConfirmation(gathering.id, gathering.name);
      }
    } else if (selectedGatherings.length > 1) {
      // For multiple gatherings, we'll need to implement a bulk delete modal
      // For now, just show an error
      setError('Bulk gathering deletion not yet implemented');
      setTimeout(() => setError(''), 5000);
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
    <div className="space-y-6 pb-32">
      {/* Header */}
      <div className="bg-white overflow-hidden shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                Manage Gatherings
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Manage your church gatherings and their members
              </p>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="text-sm text-red-700">{error}</div>
          </div>
        </div>
      )}

      {success && (
        <div className="bg-green-50 border border-green-200 rounded-md p-4">
          <div className="flex">
            <div className="text-sm text-green-700">{success}</div>
          </div>
        </div>
      )}

      {/* Gatherings List */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              Your Gatherings ({gatherings.length})
            </h3>
            <div className="flex items-center space-x-3">
              {selectedGatherings.length > 0 ? (
                <div className="flex items-center space-x-2 text-sm text-gray-600">
                  <span>{selectedGatherings.length} selected</span>
                  <button
                    onClick={clearSelection}
                    className="text-primary-600 hover:text-primary-700"
                  >
                    Clear
                  </button>
                </div>
              ) : gatherings.length > 0 && (
                <button
                  onClick={selectAllGatherings}
                  className="text-sm text-primary-600 hover:text-primary-700"
                >
                  Select All
                </button>
              )}
            </div>
          </div>
          
          {gatherings.length === 0 ? (
            <div className="relative text-center py-12">
              <CalendarIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No gatherings</h3>
              <p className="mt-1 text-sm text-gray-500">
                Get started by creating your first gathering.
              </p>
              {/* Prominent guidance to add button */}
              <div className="hidden sm:block">
                <div className="fixed bottom-4 sm:bottom-6 right-20 z-40 flex items-center">
                  <div className="bg-white/90 backdrop-blur rounded-lg shadow-lg border border-primary-200 px-4 h-14 flex items-center justify-center text-primary-800 animate-slide-right mr-2">
                    <p className="text-base font-semibold whitespace-nowrap">Add Gathering Here</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3">
              {gatherings.map((gathering) => (
                <div 
                  key={gathering.id} 
                  className={`border rounded-lg p-6 cursor-pointer transition-all ${
                    selectedGatherings.includes(gathering.id)
                      ? 'border-primary-500 bg-primary-50 shadow-md'
                      : 'bg-white border-gray-200 hover:shadow-md'
                  }`}
                  onClick={() => toggleGatheringSelection(gathering.id)}
                >
                  <div className="flex space-x-4">
                    {/* Checkbox Column */}
                    <div className="flex-shrink-0 pt-1">
                      <input
                        type="checkbox"
                        checked={selectedGatherings.includes(gathering.id)}
                        onChange={() => toggleGatheringSelection(gathering.id)}
                        className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 h-4 w-4"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                    
                    {/* Gathering Info Column */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between mb-3">
                        <h4 className="text-lg font-semibold text-gray-900 truncate">
                          {gathering.name}
                        </h4>
                        <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                          gathering.attendanceType === 'headcount' 
                            ? 'bg-blue-100 text-blue-800' 
                            : 'bg-green-100 text-green-800'
                        } flex-shrink-0 ml-3`}>
                          {gathering.attendanceType === 'headcount' ? 'Headcount' : 'Standard'}
                        </span>
                      </div>
                      
                      <div className="space-y-3">
                        <div className="text-sm text-gray-700">
                          {gathering.attendanceType === 'headcount' && gathering.customSchedule ? (
                            // Show custom schedule info for headcount gatherings
                            gathering.customSchedule.type === 'one_off' ? (
                              <div>
                                <div className="font-medium text-gray-900">One-off Event</div>
                                <div className="text-gray-600">{new Date(gathering.customSchedule.startDate).toLocaleDateString('en-US', { 
                                  weekday: 'long',
                                  year: 'numeric',
                                  month: 'long',
                                  day: 'numeric'
                                })}</div>
                              </div>
                            ) : (
                              <div>
                                <div className="font-medium text-gray-900">Custom Schedule</div>
                                <div className="text-gray-600">
                                  {gathering.customSchedule.pattern?.frequency || 'recurring'} from {new Date(gathering.customSchedule.startDate).toLocaleDateString()}
                                  {gathering.customSchedule.endDate && ` to ${new Date(gathering.customSchedule.endDate).toLocaleDateString()}`}
                                </div>
                              </div>
                            )
                          ) : (
                            <div>
                              <div className="font-medium text-gray-900">Regular Schedule</div>
                              <div className="text-gray-600">
                                {gathering.dayOfWeek}s at {gathering.startTime}
                                {gathering.frequency && gathering.frequency !== 'weekly' && ` (${gathering.frequency})`}
                              </div>
                            </div>
                          )}
                        </div>
                        
                        {gathering.description && (
                          <div className="text-sm text-gray-700">
                            <div className="font-medium text-gray-900">Description</div>
                            <div className="text-gray-600">{gathering.description}</div>
                          </div>
                        )}
                        
                        {gathering.attendanceType === 'standard' && (
                          <div className="flex items-center text-sm text-gray-700 bg-gray-50 p-3 rounded-md">
                            <UserGroupIcon className="h-4 w-4 mr-2 flex-shrink-0" />
                            <div>
                              <div className="font-medium text-gray-900">
                                {gathering.memberCount || 0} regular attendees
                              </div>
                              {(gathering.recentVisitorCount || 0) > 0 && (
                                <div className="text-green-600 text-sm">
                                  {gathering.recentVisitorCount} recent visitors
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        
                        {gathering.attendanceType === 'standard' && (gathering.memberCount || 0) === 0 && (
                          <button 
                            className="w-full text-sm text-purple-600 font-medium relative hover:text-purple-700 hover:underline transition-colors underline decoration-dotted bg-purple-50 p-3 rounded-md hover:bg-purple-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              localStorage.setItem('people_prompt_dismissed', 'true');
                              setShowArrowPrompt(false);
                              navigate('/app/people');
                            }}
                          >
                            <div className="font-medium">Add people to this gathering</div>
                            <div className="text-xs text-purple-500 mt-1">Click to manage members</div>
                            {showArrowPrompt && (
                              <div className="absolute -right-32 top-1/2 transform -translate-y-1/2 flex items-center animate-bounce z-10">
                                <svg width="80" height="20" viewBox="0 0 80 20" className="text-purple-500">
                                  <defs>
                                    <marker id="arrowhead-purple" markerWidth="8" markerHeight="8" refX="0" refY="3" orient="auto">
                                      <polygon points="0 0, 6 3, 0 6" fill="currentColor" />
                                    </marker>
                                  </defs>
                                  <path d="M5 10 L70 10" stroke="currentColor" strokeWidth="2" fill="none" markerEnd="url(#arrowhead-purple)" />
                                </svg>
                                <span className="ml-2 text-sm text-purple-600 font-medium whitespace-nowrap bg-white/90 px-2 py-1 rounded shadow">
                                  Click here!
                                </span>
                              </div>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>



      {/* Edit Gathering Modal */}
      {showEditForm && editingGathering ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Edit Gathering
                </h3>
                <button
                  onClick={closeEditModal}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <span className="sr-only">Close</span>
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <form onSubmit={(e) => { e.preventDefault(); handleUpdateGathering(); }} className="space-y-4">
                <div>
                  <label htmlFor="edit-name" className="block text-sm font-medium text-gray-700">
                    Gathering Name *
                  </label>
                  <input
                    id="edit-name"
                    type="text"
                    value={editFormData.name}
                    onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Sunday Service"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="edit-description" className="block text-sm font-medium text-gray-700">
                    Description
                  </label>
                  <textarea
                    id="edit-description"
                    value={editFormData.description}
                    onChange={(e) => setEditFormData({ ...editFormData, description: e.target.value })}
                    rows={2}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Weekly worship service"
                  />
                </div>

                {/* Only show regular schedule fields for standard gatherings or headcount without custom schedule */}
                {(editFormData.attendanceType === 'standard' || !editFormData.customSchedule) && (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label htmlFor="edit-dayOfWeek" className="block text-sm font-medium text-gray-700">
                          Day of Week *
                        </label>
                        <select
                          id="edit-dayOfWeek"
                          value={editFormData.dayOfWeek}
                          onChange={(e) => setEditFormData({ ...editFormData, dayOfWeek: e.target.value })}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
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
                        <label htmlFor="edit-startTime" className="block text-sm font-medium text-gray-700">
                          Start Time *
                        </label>
                        <input
                          id="edit-startTime"
                          type="time"
                          value={editFormData.startTime}
                          onChange={(e) => {
                            const newStartTime = e.target.value;
                            // Auto-calculate end time as start time + 1 hour if end time not manually set
                            const [hours, minutes] = newStartTime.split(':').map(Number);
                            const endHours = (hours + 1) % 24;
                            const autoEndTime = `${String(endHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
                            setEditFormData({
                              ...editFormData,
                              startTime: newStartTime,
                              endTime: editFormData.endTime || autoEndTime
                            });
                          }}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                          required
                        />
                      </div>

                      <div>
                        <label htmlFor="edit-endTime" className="block text-sm font-medium text-gray-700">
                          End Time
                        </label>
                        <input
                          id="edit-endTime"
                          type="time"
                          value={editFormData.endTime || ''}
                          onChange={(e) => setEditFormData({ ...editFormData, endTime: e.target.value })}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        />
                      </div>

                      <div>
                        <label htmlFor="edit-frequency" className="block text-sm font-medium text-gray-700">
                          Frequency *
                        </label>
                        <select
                          id="edit-frequency"
                          value={editFormData.frequency}
                          onChange={(e) => setEditFormData({ ...editFormData, frequency: e.target.value })}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                          required
                        >
                          <option value="weekly">Weekly</option>
                          <option value="biweekly">Bi-weekly</option>
                          <option value="monthly">Monthly</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}

                {/* Attendance Type (editable if no attendance records) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Attendance Type
                  </label>
                  <div className="mt-1 space-y-2">
                    <div className="flex space-x-4">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="edit-attendanceType"
                          value="standard"
                          checked={editFormData.attendanceType === 'standard'}
                          onChange={(e) => setEditFormData({ ...editFormData, attendanceType: e.target.value as 'standard' | 'headcount' })}
                          className="mr-2"
                        />
                        <span className="text-sm">Standard Attendance</span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="edit-attendanceType"
                          value="headcount"
                          checked={editFormData.attendanceType === 'headcount'}
                          onChange={(e) => setEditFormData({ ...editFormData, attendanceType: e.target.value as 'standard' | 'headcount' })}
                          className="mr-2"
                        />
                        <span className="text-sm">Headcount Only</span>
                      </label>
                    </div>
                    <p className="text-xs text-gray-500">
                      Note: Changing attendance type is only allowed when no attendance records exist
                    </p>
                  </div>
                </div>

                {/* Kiosk Mode Toggle - only for standard gatherings */}
                {editFormData.attendanceType === 'standard' && (
                  <div className="space-y-4">
                    <div>
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editFormData.kioskEnabled || false}
                          onChange={(e) => setEditFormData({ ...editFormData, kioskEnabled: e.target.checked })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <span className="ml-2 text-sm font-medium text-gray-700">
                          Allow Self Sign-In (Kiosk Mode)
                        </span>
                      </label>
                      <p className="mt-1 text-xs text-gray-500 ml-6">
                        Enables a self-service sign-in page where attendees can check themselves in via a shared device.
                      </p>
                    </div>

                    {/* Kiosk Configuration - only show when kiosk is enabled */}
                    {editFormData.kioskEnabled && (
                      <div className="ml-6 border-l-2 border-primary-200 pl-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            End Time
                          </label>
                          <input
                            type="time"
                            value={editFormData.kioskEndTime || ''}
                            onChange={(e) => setEditFormData({ ...editFormData, kioskEndTime: e.target.value })}
                            className="w-40 px-3 py-2 border border-gray-300 rounded-md focus:ring-primary-500 focus:border-primary-500"
                          />
                          <p className="mt-1 text-xs text-gray-500">
                            When should sign-in close? (optional)
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Custom Schedule Display for Headcount Gatherings */}
                {editFormData.attendanceType === 'headcount' && editFormData.customSchedule && (
                  <div className="bg-blue-50 p-4 rounded-lg border">
                    <h4 className="text-sm font-medium text-blue-900 mb-2">Custom Schedule</h4>
                    <div className="text-sm text-blue-700">
                      <p><strong>Type:</strong> {editFormData.customSchedule.type === 'one_off' ? 'One-off event' : 'Recurring pattern'}</p>
                      <p><strong>Start Date:</strong> {new Date(editFormData.customSchedule.startDate).toLocaleDateString()}</p>
                      {editFormData.customSchedule.endDate && (
                        <p><strong>End Date:</strong> {new Date(editFormData.customSchedule.endDate).toLocaleDateString()}</p>
                      )}
                      {editFormData.customSchedule.pattern && (
                        <>
                          <p><strong>Frequency:</strong> {editFormData.customSchedule.pattern.frequency}</p>
                          {editFormData.customSchedule.pattern.daysOfWeek && editFormData.customSchedule.pattern.daysOfWeek.length > 0 && (
                            <p><strong>Days:</strong> {editFormData.customSchedule.pattern.daysOfWeek.join(', ')}</p>
                          )}
                          {editFormData.customSchedule.pattern.dayOfMonth && (
                            <p><strong>Day of Month:</strong> {editFormData.customSchedule.pattern.dayOfMonth}</p>
                          )}
                        </>
                      )}
                    </div>
                    <p className="text-xs text-blue-600 mt-2">
                      Custom schedule details cannot be modified after creation. Delete and recreate the gathering to change the schedule.
                    </p>
                  </div>
                )}


                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowEditForm(false)}
                    className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                  >
                    Update Gathering
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {/* Add Gathering Modal (simplified) */}
      {showAddGatheringWizard ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-10 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Gathering Details
                </h3>
                <button
                  onClick={() => {
                    setShowAddGatheringWizard(false);
                    resetWizardState();
                  }}
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
                    <label htmlFor="add-name" className="block text-sm font-medium text-gray-700">
                      Gathering Name *
                    </label>
                    <input
                      id="add-name"
                      type="text"
                      value={createGatheringData.name}
                      onChange={(e) => setCreateGatheringData({ ...createGatheringData, name: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      placeholder="Sunday Service"
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="add-description" className="block text-sm font-medium text-gray-700">
                      Description
                    </label>
                    <textarea
                      id="add-description"
                      value={createGatheringData.description}
                      onChange={(e) => setCreateGatheringData({ ...createGatheringData, description: e.target.value })}
                      rows={2}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      placeholder="Weekly worship service"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Attendance Type *
                    </label>
                    <div className="space-y-2">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="attendanceType"
                          value="standard"
                          checked={createGatheringData.attendanceType === 'standard'}
                          onChange={(e) => setCreateGatheringData({ 
                            ...createGatheringData, 
                            attendanceType: e.target.value as 'standard' | 'headcount',
                            customSchedule: undefined
                          })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-700">
                          <strong>Standard Attendance</strong> - Track individual people by name
                        </span>
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="attendanceType"
                          value="headcount"
                          checked={createGatheringData.attendanceType === 'headcount'}
                          onChange={(e) => setCreateGatheringData({ 
                            ...createGatheringData, 
                            attendanceType: e.target.value as 'standard' | 'headcount'
                          })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                        />
                        <span className="ml-2 text-sm text-gray-700">
                          <strong>Headcount Only</strong> - Just track total numbers
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Kiosk Mode Toggle - only for standard gatherings */}
                  {createGatheringData.attendanceType === 'standard' && (
                    <div className="space-y-4">
                      <div>
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={createGatheringData.kioskEnabled || false}
                            onChange={(e) => setCreateGatheringData({ ...createGatheringData, kioskEnabled: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <span className="ml-2 text-sm font-medium text-gray-700">
                            Allow Self Sign-In (Kiosk Mode)
                          </span>
                        </label>
                        <p className="mt-1 text-xs text-gray-500 ml-6">
                          Enables a self-service sign-in page where attendees can check themselves in via a shared device.
                        </p>
                      </div>

                      {/* Kiosk Configuration - only show when kiosk is enabled */}
                      {createGatheringData.kioskEnabled && (
                        <div className="ml-6 border-l-2 border-primary-200 pl-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              End Time
                            </label>
                            <input
                              type="time"
                              value={createGatheringData.kioskEndTime || ''}
                              onChange={(e) => setCreateGatheringData({ ...createGatheringData, kioskEndTime: e.target.value })}
                              className="w-40 px-3 py-2 border border-gray-300 rounded-md focus:ring-primary-500 focus:border-primary-500"
                            />
                            <p className="mt-1 text-xs text-gray-500">
                              When should sign-in close? (optional)
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {createGatheringData.attendanceType === 'headcount' && (
                    <div className="bg-blue-50 p-4 rounded-lg">
                      <h4 className="text-sm font-medium text-blue-900 mb-2">Custom Schedule Options</h4>
                      <p className="text-sm text-blue-700 mb-3">
                        For headcount gatherings, you can use flexible scheduling or stick with regular weekly/biweekly/monthly patterns.
                      </p>
                      <div className="space-y-2">
                        <label className="flex items-center">
                          <input
                            type="radio"
                            name="scheduleType"
                            value="regular"
                            checked={!createGatheringData.customSchedule}
                            onChange={() => setCreateGatheringData({ 
                              ...createGatheringData, 
                              customSchedule: undefined 
                            })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                          />
                          <span className="ml-2 text-sm text-gray-700">
                            Use regular schedule (weekly/biweekly/monthly)
                          </span>
                        </label>
                        <label className="flex items-center">
                          <input
                            type="radio"
                            name="scheduleType"
                            value="custom"
                            checked={!!createGatheringData.customSchedule}
                            onChange={() => setCreateGatheringData({ 
                              ...createGatheringData, 
                              customSchedule: {
                                type: 'one_off',
                                startDate: new Date().toISOString().split('T')[0]
                              }
                            })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                          />
                          <span className="ml-2 text-sm text-gray-700">
                            Use custom schedule (one-off events, daily for X days, etc.)
                          </span>
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Custom Schedule Configuration */}
                  {createGatheringData.attendanceType === 'headcount' && createGatheringData.customSchedule && (
                    <div className="bg-gray-50 p-4 rounded-lg border">
                      <h4 className="text-sm font-medium text-gray-900 mb-3">Custom Schedule Configuration</h4>
                      
                      {/* Schedule Type Selection */}
                      <div className="mb-4">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Schedule Type
                        </label>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="radio"
                              name="customScheduleType"
                              value="one_off"
                              checked={createGatheringData.customSchedule.type === 'one_off'}
                              onChange={(e) => setCreateGatheringData({
                                ...createGatheringData,
                                customSchedule: {
                                  ...createGatheringData.customSchedule,
                                  type: e.target.value as 'one_off' | 'recurring'
                                }
                              })}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                            />
                            <span className="ml-2 text-sm text-gray-700">
                              One-off event (single occurrence)
                            </span>
                          </label>
                          <label className="flex items-center">
                            <input
                              type="radio"
                              name="customScheduleType"
                              value="recurring"
                              checked={createGatheringData.customSchedule.type === 'recurring'}
                              onChange={(e) => setCreateGatheringData({
                                ...createGatheringData,
                                customSchedule: {
                                  ...createGatheringData.customSchedule,
                                  type: e.target.value as 'one_off' | 'recurring'
                                }
                              })}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                            />
                            <span className="ml-2 text-sm text-gray-700">
                              Recurring pattern (multiple occurrences)
                            </span>
                          </label>
                        </div>
                      </div>

                      {/* Start Date */}
                      <div className="mb-4">
                        <label htmlFor="custom-startDate" className="block text-sm font-medium text-gray-700 mb-1">
                          Start Date *
                        </label>
                        <input
                          id="custom-startDate"
                          type="date"
                          value={createGatheringData.customSchedule.startDate}
                          onChange={(e) => setCreateGatheringData({
                            ...createGatheringData,
                            customSchedule: {
                              ...createGatheringData.customSchedule,
                              startDate: e.target.value
                            }
                          })}
                          className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                          required
                        />
                      </div>

                      {/* End Date for Recurring */}
                      {createGatheringData.customSchedule.type === 'recurring' && (
                        <div className="mb-4">
                          <label htmlFor="custom-endDate" className="block text-sm font-medium text-gray-700 mb-1">
                            End Date *
                          </label>
                          <input
                            id="custom-endDate"
                            type="date"
                            value={createGatheringData.customSchedule.endDate || ''}
                            onChange={(e) => setCreateGatheringData({
                              ...createGatheringData,
                              customSchedule: {
                                ...createGatheringData.customSchedule,
                                endDate: e.target.value
                              }
                            })}
                            className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                            required
                          />
                        </div>
                      )}

                      {/* Pattern Configuration for Recurring */}
                      {createGatheringData.customSchedule.type === 'recurring' && (
                        <div className="space-y-4">
                          <div>
                            <label htmlFor="pattern-frequency" className="block text-sm font-medium text-gray-700 mb-1">
                              Frequency *
                            </label>
                            <select
                              id="pattern-frequency"
                              value={createGatheringData.customSchedule.pattern?.frequency || ''}
                              onChange={(e) => setCreateGatheringData({
                                ...createGatheringData,
                                customSchedule: {
                                  ...createGatheringData.customSchedule,
                                  pattern: {
                                    ...createGatheringData.customSchedule.pattern,
                                    frequency: e.target.value as 'daily' | 'weekly' | 'biweekly' | 'monthly',
                                    interval: 1
                                  }
                                }
                              })}
                              className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                              required
                            >
                              <option value="">Select frequency</option>
                              <option value="daily">Daily</option>
                              <option value="weekly">Weekly</option>
                              <option value="biweekly">Bi-weekly</option>
                              <option value="monthly">Monthly</option>
                            </select>
                          </div>

                          <div>
                            <label htmlFor="pattern-interval" className="block text-sm font-medium text-gray-700 mb-1">
                              Interval *
                            </label>
                            <input
                              id="pattern-interval"
                              type="number"
                              min="1"
                              value={createGatheringData.customSchedule.pattern?.interval || 1}
                              onChange={(e) => setCreateGatheringData({
                                ...createGatheringData,
                                customSchedule: {
                                  ...createGatheringData.customSchedule,
                                  pattern: {
                                    ...createGatheringData.customSchedule.pattern,
                                    interval: parseInt(e.target.value) || 1
                                  }
                                }
                              })}
                              className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                              placeholder="1"
                              required
                            />
                            <p className="mt-1 text-xs text-gray-500">
                              {createGatheringData.customSchedule.pattern?.frequency === 'daily' && 'Every X days'}
                              {createGatheringData.customSchedule.pattern?.frequency === 'weekly' && 'Every X weeks'}
                              {createGatheringData.customSchedule.pattern?.frequency === 'biweekly' && 'Every X bi-weekly periods'}
                              {createGatheringData.customSchedule.pattern?.frequency === 'monthly' && 'Every X months'}
                            </p>
                          </div>

                          {/* Days of Week for Weekly */}
                          {createGatheringData.customSchedule.pattern?.frequency === 'weekly' && (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">
                                Days of Week *
                              </label>
                              
                              {/* Quick Selection Buttons */}
                              <div className="mb-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
                                    setCreateGatheringData({
                                      ...createGatheringData,
                                      customSchedule: {
                                        ...createGatheringData.customSchedule,
                                        pattern: {
                                          ...createGatheringData.customSchedule.pattern,
                                          daysOfWeek: weekdays
                                        }
                                      }
                                    });
                                  }}
                                  className="px-3 py-1 text-xs bg-blue-100 hover:bg-blue-200 text-blue-800 rounded-full border border-blue-300"
                                >
                                  Weekdays
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const weekends = ['Saturday', 'Sunday'];
                                    setCreateGatheringData({
                                      ...createGatheringData,
                                      customSchedule: {
                                        ...createGatheringData.customSchedule,
                                        pattern: {
                                          ...createGatheringData.customSchedule.pattern,
                                          daysOfWeek: weekends
                                        }
                                      }
                                    });
                                  }}
                                  className="px-3 py-1 text-xs bg-green-100 hover:bg-green-200 text-green-800 rounded-full border border-green-300"
                                >
                                  Weekends
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCreateGatheringData({
                                      ...createGatheringData,
                                      customSchedule: {
                                        ...createGatheringData.customSchedule,
                                        pattern: {
                                          ...createGatheringData.customSchedule.pattern,
                                          daysOfWeek: []
                                        }
                                      }
                                    });
                                  }}
                                  className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-full border border-gray-300"
                                >
                                  Clear All
                                </button>
                              </div>

                              {/* Individual Day Selection */}
                              <div className="grid grid-cols-2 gap-2">
                                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => (
                                  <label key={day} className="flex items-center">
                                    <input
                                      type="checkbox"
                                      checked={createGatheringData.customSchedule.pattern?.daysOfWeek?.includes(day) || false}
                                      onChange={(e) => {
                                        const currentDays = createGatheringData.customSchedule.pattern?.daysOfWeek || [];
                                        const newDays = e.target.checked
                                          ? [...currentDays, day]
                                          : currentDays.filter(d => d !== day);
                                        
                                        setCreateGatheringData({
                                          ...createGatheringData,
                                          customSchedule: {
                                            ...createGatheringData.customSchedule,
                                            pattern: {
                                              ...createGatheringData.customSchedule.pattern,
                                              daysOfWeek: newDays
                                            }
                                          }
                                        });
                                      }}
                                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                                    />
                                    <span className="ml-2 text-sm text-gray-700">{day}</span>
                                  </label>
                                ))}
                              </div>
                              
                              {/* Selected Days Summary */}
                              {createGatheringData.customSchedule.pattern?.daysOfWeek && createGatheringData.customSchedule.pattern.daysOfWeek.length > 0 && (
                                <div className="mt-2 p-2 bg-blue-50 rounded border">
                                  <p className="text-sm text-blue-700">
                                    <strong>Selected:</strong> {createGatheringData.customSchedule.pattern.daysOfWeek.join(', ')}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Day of Month for Monthly */}
                          {createGatheringData.customSchedule.pattern?.frequency === 'monthly' && (
                            <div>
                              <label htmlFor="pattern-dayOfMonth" className="block text-sm font-medium text-gray-700 mb-1">
                                Day of Month *
                              </label>
                              <input
                                id="pattern-dayOfMonth"
                                type="number"
                                min="1"
                                max="31"
                                value={createGatheringData.customSchedule.pattern?.dayOfMonth || 1}
                                onChange={(e) => setCreateGatheringData({
                                  ...createGatheringData,
                                  customSchedule: {
                                    ...createGatheringData.customSchedule,
                                    pattern: {
                                      ...createGatheringData.customSchedule.pattern,
                                      dayOfMonth: parseInt(e.target.value) || 1
                                    }
                                  }
                                })}
                                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                                required
                              />
                            </div>
                          )}

                          {/* Custom Date Selection for Daily */}
                          {createGatheringData.customSchedule.pattern?.frequency === 'daily' && (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">
                                Custom Date Selection (Optional)
                              </label>
                              <p className="text-sm text-gray-600 mb-3">
                                Leave empty to use the start/end date range, or specify specific dates.
                              </p>
                              <div className="space-y-2">
                                <div>
                                  <label htmlFor="custom-dates" className="block text-xs text-gray-600 mb-1">
                                    Specific Dates (one per line, YYYY-MM-DD format)
                                  </label>
                                  <textarea
                                    id="custom-dates"
                                    rows={3}
                                    placeholder="2024-03-15&#10;2024-03-18&#10;2024-03-22"
                                    className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
                                    onChange={(e) => {
                                      const dates = e.target.value
                                        .split('\n')
                                        .map(date => date.trim())
                                        .filter(date => date && /^\d{4}-\d{2}-\d{2}$/.test(date));
                                      
                                      setCreateGatheringData({
                                        ...createGatheringData,
                                        customSchedule: {
                                          ...createGatheringData.customSchedule,
                                          pattern: {
                                            ...createGatheringData.customSchedule.pattern,
                                            customDates: dates
                                          }
                                        }
                                      });
                                    }}
                                  />
                                  <p className="text-xs text-gray-500 mt-1">
                                    Enter specific dates in YYYY-MM-DD format, one per line
                                  </p>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Schedule Preview */}
                      <div className="mt-4 p-3 bg-blue-50 rounded border">
                        <h5 className="text-sm font-medium text-blue-900 mb-1">Schedule Preview</h5>
                        <p className="text-sm text-blue-700">
                          {createGatheringData.customSchedule.type === 'one_off' ? (
                            `Single event on ${new Date(createGatheringData.customSchedule.startDate).toLocaleDateString()}`
                          ) : (
                            `Recurring ${createGatheringData.customSchedule.pattern?.frequency || 'weekly'} event` +
                            (createGatheringData.customSchedule.pattern?.frequency === 'weekly' && createGatheringData.customSchedule.pattern?.daysOfWeek?.length ? 
                              ` on ${createGatheringData.customSchedule.pattern.daysOfWeek.join(', ')}` : '') +
                            (createGatheringData.customSchedule.pattern?.frequency === 'monthly' && createGatheringData.customSchedule.pattern?.dayOfMonth ? 
                              ` on day ${createGatheringData.customSchedule.pattern.dayOfMonth}` : '') +
                            ` from ${new Date(createGatheringData.customSchedule.startDate).toLocaleDateString()}` +
                            (createGatheringData.customSchedule.endDate ? 
                              ` to ${new Date(createGatheringData.customSchedule.endDate).toLocaleDateString()}` : '')
                          )}
                        </p>
                      </div>
                    </div>
                  )}

                  {(createGatheringData.attendanceType === 'standard' || !createGatheringData.customSchedule) && (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                          <label htmlFor="add-dayOfWeek" className="block text-sm font-medium text-gray-700">
                            Day of Week {createGatheringData.attendanceType === 'standard' ? '*' : ''}
                          </label>
                          <select
                            id="add-dayOfWeek"
                            value={createGatheringData.dayOfWeek || ''}
                            onChange={(e) => setCreateGatheringData({ ...createGatheringData, dayOfWeek: e.target.value })}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                            required={createGatheringData.attendanceType === 'standard'}
                          >
                            <option value="">Select day</option>
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
                          <label htmlFor="add-startTime" className="block text-sm font-medium text-gray-700">
                            Start Time {createGatheringData.attendanceType === 'standard' ? '*' : ''}
                          </label>
                          <input
                            id="add-startTime"
                            type="time"
                            value={createGatheringData.startTime || ''}
                            onChange={(e) => setCreateGatheringData({ ...createGatheringData, startTime: e.target.value })}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                            required={createGatheringData.attendanceType === 'standard'}
                          />
                        </div>

                        <div>
                          <label htmlFor="add-frequency" className="block text-sm font-medium text-gray-700">
                            Frequency {createGatheringData.attendanceType === 'standard' ? '*' : ''}
                          </label>
                          <select
                            id="add-frequency"
                            value={createGatheringData.frequency || ''}
                            onChange={(e) => setCreateGatheringData({ ...createGatheringData, frequency: e.target.value })}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                            required={createGatheringData.attendanceType === 'standard'}
                          >
                            <option value="">Select frequency</option>
                            <option value="weekly">Weekly</option>
                            <option value="biweekly">Bi-weekly</option>
                            <option value="monthly">Monthly</option>
                          </select>
                        </div>
                      </div>
                    </>
                  )}

                  <div className="flex justify-end space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={closeAddModal}
                      className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleCreateGathering}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                      disabled={isCreating || !canProceedFromStep1()}
                    >
                      {isCreating ? 'Creating...' : 'Create Gathering'}
                    </button>
                  </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}



      {/* Delete Gathering Confirmation Modal */}
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
                  Are you sure you want to delete <strong>{deleteConfirmation.gatheringName}</strong>? This will also remove all member associations and cannot be undone.
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
                    await handleDeleteGathering();
                    setShowDeleteModal(false);
                    setDeleteConfirmation({ gatheringId: null, gatheringName: '' });
                  }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                >
                  Delete Gathering
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}



      {/* Manage Occurrences Modal */}
      {showManageOccurrencesModal && gatheringOccurrences.gathering ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-10 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-2/3 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Manage Occurrences - {gatheringOccurrences.gathering.name}
                </h3>
                <button
                  onClick={() => setShowManageOccurrencesModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="mb-4">
                <p className="text-sm text-gray-600">
                  Select specific occurrences to remove from this gathering's schedule. This will not delete the gathering itself, just those specific dates.
                </p>
              </div>

              {gatheringOccurrences.occurrences.length === 0 ? (
                <div className="text-center py-8">
                  <CalendarIcon className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-sm font-medium text-gray-900">No upcoming occurrences</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    This gathering has no scheduled occurrences in the next 3 months.
                  </p>
                </div>
              ) : (
                <>
                  <div className="mb-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700">
                        Upcoming Occurrences ({gatheringOccurrences.occurrences.length})
                      </span>
                      <div className="flex space-x-2">
                        <button
                          onClick={() => setSelectedOccurrences(gatheringOccurrences.occurrences.map(o => o.date))}
                          className="text-xs text-blue-600 hover:text-blue-800"
                        >
                          Select All
                        </button>
                        <button
                          onClick={() => setSelectedOccurrences([])}
                          className="text-xs text-gray-600 hover:text-gray-800"
                        >
                          Clear All
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-96 overflow-y-auto">
                    {gatheringOccurrences.occurrences.map((occurrence) => (
                      <div
                        key={occurrence.date}
                        className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                          selectedOccurrences.includes(occurrence.date)
                            ? 'border-primary-500 bg-primary-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                        onClick={() => {
                          if (selectedOccurrences.includes(occurrence.date)) {
                            setSelectedOccurrences(selectedOccurrences.filter(d => d !== occurrence.date));
                          } else {
                            setSelectedOccurrences([...selectedOccurrences, occurrence.date]);
                          }
                        }}
                      >
                        <div className="flex items-center">
                          <input
                            type="checkbox"
                            checked={selectedOccurrences.includes(occurrence.date)}
                            onChange={() => {}} // Handled by parent div click
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <div className="ml-3">
                            <p className="text-sm font-medium text-gray-900">
                              {new Date(occurrence.date).toLocaleDateString('en-US', { 
                                weekday: 'long',
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric'
                              })}
                            </p>
                            <p className="text-xs text-gray-500">
                              {new Date(occurrence.date).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {selectedOccurrences.length > 0 && (
                    <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                      <div className="flex items-center">
                        <TrashIcon className="h-5 w-5 text-red-600 mr-2" />
                        <span className="text-sm font-medium text-red-800">
                          {selectedOccurrences.length} occurrence(s) selected for deletion
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end space-x-3 pt-4">
                    <button
                      onClick={() => setShowManageOccurrencesModal(false)}
                      className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDeleteSelectedOccurrences}
                      disabled={selectedOccurrences.length === 0}
                      className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                    >
                      Delete Selected ({selectedOccurrences.length})
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {/* Duplicate Gathering Modal */}
      {showDuplicateModal && duplicateGathering ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Duplicate Gathering
                </h3>
                <button
                  onClick={() => {
                    setShowDuplicateModal(false);
                    setDuplicateGathering(null);
                    setDuplicateName('');
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="mb-4">
                <p className="text-sm text-gray-600 mb-4">
                  Duplicating: <span className="font-medium">{duplicateGathering.name}</span>
                </p>
                <p className="text-sm text-gray-500 mb-4">
                  This will copy all details, people assignments, and user assignments to a new gathering.
                </p>
                
                <label htmlFor="duplicate-name" className="block text-sm font-medium text-gray-700 mb-2">
                  New Gathering Name *
                </label>
                <input
                  id="duplicate-name"
                  type="text"
                  value={duplicateName}
                  onChange={(e) => setDuplicateName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter new gathering name"
                  autoFocus
                />
              </div>
              
              <div className="flex space-x-3">
                <button
                  onClick={() => {
                    setShowDuplicateModal(false);
                    setDuplicateGathering(null);
                    setDuplicateName('');
                  }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDuplicateGathering}
                  disabled={!duplicateName.trim() || isDuplicating}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-md hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isDuplicating ? 'Duplicating...' : 'Duplicate Gathering'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {/* Floating Action Buttons */}
      {selectedGatherings.length > 0 ? (
        <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 flex flex-col space-y-2 z-30">
          {/* Show all options for single selection */}
          {selectedGatherings.length === 1 ? (
            <>
              {/* Edit Gathering Button */}
              <div className="flex items-center justify-end space-x-3">
                <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
                  Edit Gathering
                </div>
                <button
                  onClick={handleEditSelectedGathering}
                  className="w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
                  title="Edit Gathering"
                >
                  <PencilIcon className="h-6 w-6" />
                </button>
              </div>
              
              {/* Duplicate Gathering Button */}
              <div className="flex items-center justify-end space-x-3">
                <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
                  Duplicate Gathering
                </div>
                <button
                  onClick={handleDuplicateSelectedGathering}
                  className="w-14 h-14 bg-purple-600 hover:bg-purple-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
                  title="Duplicate Gathering"
                >
                  <DocumentDuplicateIcon className="h-6 w-6" />
                </button>
              </div>
              
              {/* Manage Occurrences Button - only for headcount gatherings */}
              {(() => {
                const gathering = gatherings.find(g => g.id === selectedGatherings[0]);
                if (gathering?.attendanceType === 'headcount') {
                  return (
                    <div className="flex items-center justify-end space-x-3">
                      <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
                        Manage Occurrences
                      </div>
                      <button
                        onClick={handleManageOccurrencesSelectedGathering}
                        className="w-14 h-14 bg-orange-600 hover:bg-orange-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
                        title="Manage Occurrences"
                      >
                        <CalendarIcon className="h-6 w-6" />
                      </button>
                    </div>
                  );
                }
                return null;
              })()}
            </>
          ) : null}
          
          {/* Delete Gathering Button - always shown when selections exist */}
          <div className="flex items-center justify-end space-x-3">
            <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
              {selectedGatherings.length === 1 ? "Delete Gathering" : "Delete Gatherings"}
            </div>
            <button
              onClick={handleDeleteSelectedGatherings}
              className="w-14 h-14 bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
              title={selectedGatherings.length === 1 ? "Delete Gathering" : "Delete Gatherings"}
            >
              <TrashIcon className="h-6 w-6" />
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={openAddModal}
          className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-30"
          aria-label="Add Gathering"
        >
          <PlusIcon className="h-6 w-6" />
        </button>
      )}
    </div>
  );
};

export default ManageGatheringsPage; 