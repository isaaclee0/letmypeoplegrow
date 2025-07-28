import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { gatheringsAPI, individualsAPI, usersAPI } from '../services/api';
import ActionMenu from '../components/ActionMenu';
import {
  PlusIcon,
  UserGroupIcon,
  CalendarIcon,
  TrashIcon,
  PencilIcon,
  EyeIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  XMarkIcon
} from '@heroicons/react/24/outline';

interface Gathering {
  id: number;
  name: string;
  description: string;
  dayOfWeek: string;
  startTime: string;
  durationMinutes: number;
  frequency: string;
  isActive: boolean;
  memberCount?: number;
  recentVisitorCount?: number;
}

interface Individual {
  id: number;
  firstName: string;
  lastName: string;
  familyName?: string;
}

interface User {
  id: number;
  firstName: string;
  lastName: string;
  email?: string;
  mobileNumber?: string;
  role: string;
}

interface CreateGatheringData {
  // Step 1: Basic details
  name: string;
  description: string;
  dayOfWeek: string;
  startTime: string;
  durationMinutes: number;
  frequency: string;
  setAsDefault: boolean;
  
  // Step 2: People to add
  peopleToAdd: string[]; // Array of "First Last" names
  bulkPeopleText: string; // For copy+paste input
  
  // Step 3: Users to assign
  userIds: number[];
  assignSelf: boolean;
}

const ManageGatheringsPage: React.FC = () => {
  const { user } = useAuth();
  const [gatherings, setGatherings] = useState<Gathering[]>([]);
  const [selectedGathering, setSelectedGathering] = useState<Gathering | null>(null);
  const [gatheringMembers, setGatheringMembers] = useState<Individual[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [showAddGatheringWizard, setShowAddGatheringWizard] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [isCreating, setIsCreating] = useState(false);
  const [showManageMembers, setShowManageMembers] = useState(false);
  const [editingGathering, setEditingGathering] = useState<Gathering | null>(null);
  const [managingGathering, setManagingGathering] = useState<Gathering | null>(null);
  const [allPeople, setAllPeople] = useState<Array<{
    id: number;
    firstName: string;
    lastName: string;
    familyName?: string;
    assigned: boolean;
  }>>([]);
  const [originalAssignedIds, setOriginalAssignedIds] = useState<Set<number>>(new Set());
  
  // Form states
  const [editFormData, setEditFormData] = useState({
    name: '',
    description: '',
    dayOfWeek: 'Sunday',
    startTime: '10:00',
    durationMinutes: 90,
    frequency: 'weekly'
  });

  const [createGatheringData, setCreateGatheringData] = useState<CreateGatheringData>({
    name: '',
    description: '',
    dayOfWeek: 'Sunday',
    startTime: '10:00',
    durationMinutes: 90,
    frequency: 'weekly',
    setAsDefault: false,
    peopleToAdd: [],
    bulkPeopleText: '',
    userIds: [],
    assignSelf: true
  });

  // Confirmation modal states
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    gatheringId: number | null;
    gatheringName: string;
  }>({ gatheringId: null, gatheringName: '' });

  useEffect(() => {
    loadGatherings();
    loadUsers();
  }, []);

  const loadGatherings = async () => {
    try {
      setIsLoading(true);
      const response = await gatheringsAPI.getAll();
      setGatherings(response.data.gatherings || []);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load gatherings');
    } finally {
      setIsLoading(false);
    }
  };

  const loadUsers = async () => {
    try {
      const response = await usersAPI.getAll();
      setAllUsers(response.data.users || []);
    } catch (err: any) {
      console.error('Failed to load users:', err);
    }
  };

  const loadGatheringMembers = async (gatheringId: number) => {
    try {
      const response = await gatheringsAPI.getMembers(gatheringId);
      setGatheringMembers(response.data.members || []);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load gathering members');
    }
  };

  // Reset wizard state
  const resetWizardState = () => {
    setCreateGatheringData({
      name: '',
      description: '',
      dayOfWeek: 'Sunday',
      startTime: '10:00',
      durationMinutes: 90,
      frequency: 'weekly',
      setAsDefault: false,
      peopleToAdd: [],
      bulkPeopleText: '',
      userIds: [],
      assignSelf: true
    });
    setCurrentStep(1);
    setError('');
    setSuccess('');
  };

  // Parse bulk people text into individual names
  const parseBulkPeopleText = (text: string): string[] => {
    return text
      .split(/[\n,;]/) // Split by newlines, commas, or semicolons
      .map(name => name.trim())
      .filter(name => name.length > 0 && name.includes(' ')) // Must have at least first and last name
      .filter((name, index, arr) => arr.indexOf(name) === index); // Remove duplicates
  };

  // Handle bulk people text change
  const handleBulkPeopleTextChange = (text: string) => {
    setCreateGatheringData(prev => ({
      ...prev,
      bulkPeopleText: text,
      peopleToAdd: parseBulkPeopleText(text)
    }));
  };

  // Navigation functions
  const nextStep = () => {
    if (currentStep < 3) {
      setCurrentStep(currentStep + 1);
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const canProceedFromStep1 = () => {
    return createGatheringData.name.trim().length > 0;
  };



  // Handle gathering creation
  const handleCreateGathering = async () => {
    try {
      setIsCreating(true);
      setError('');

      // Step 1: Create the gathering
      const gatheringResponse = await gatheringsAPI.create({
        name: createGatheringData.name,
        description: createGatheringData.description,
        dayOfWeek: createGatheringData.dayOfWeek,
        startTime: createGatheringData.startTime,
        durationMinutes: createGatheringData.durationMinutes,
        frequency: createGatheringData.frequency,
        setAsDefault: createGatheringData.setAsDefault
      });

      const newGatheringId = gatheringResponse.data.id;

      // Step 2: Add people if any
      if (createGatheringData.peopleToAdd.length > 0) {
        try {
          // Create people and assign them to gathering
          for (const personName of createGatheringData.peopleToAdd) {
            const [firstName, ...lastNameParts] = personName.split(' ');
            const lastName = lastNameParts.join(' ');
            
            try {
              // Create the person
              const personResponse = await individualsAPI.create({
                firstName,
                lastName
              });
              
              // Assign them to the gathering
              await individualsAPI.assignToGathering(personResponse.data.id, newGatheringId);
            } catch (personErr: any) {
              console.error(`Failed to create person ${personName}:`, personErr);
              // Continue with other people even if one fails
            }
          }
        } catch (peopleErr: any) {
          console.error('Error adding people:', peopleErr);
          // Don't fail the whole process if people addition fails
        }
      }

      // Step 3: Assign users if any
      const usersToAssign = [...createGatheringData.userIds];
      if (createGatheringData.assignSelf && user && !usersToAssign.includes(user.id)) {
        usersToAssign.push(user.id);
      }

      if (usersToAssign.length > 0) {
        try {
          for (const userId of usersToAssign) {
            await usersAPI.assignGatherings(userId, [newGatheringId]);
          }
        } catch (userErr: any) {
          console.error('Error assigning users:', userErr);
          // Don't fail the whole process if user assignment fails
        }
      }

      // Success - update local state
      const newGathering: Gathering = {
        id: newGatheringId,
        name: createGatheringData.name,
        description: createGatheringData.description,
        dayOfWeek: createGatheringData.dayOfWeek,
        startTime: createGatheringData.startTime,
        durationMinutes: createGatheringData.durationMinutes,
        frequency: createGatheringData.frequency,
        isActive: true,
        memberCount: createGatheringData.peopleToAdd.length,
        recentVisitorCount: 0
      };

      setGatherings([...gatherings, newGathering]);
      setSuccess(`Gathering "${createGatheringData.name}" created successfully with ${createGatheringData.peopleToAdd.length} people and ${usersToAssign.length} users assigned.`);
      setShowAddGatheringWizard(false);
      resetWizardState();

    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create gathering');
      console.error('Create gathering error:', err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleViewMembers = async (gathering: Gathering) => {
    setSelectedGathering(gathering);
    await loadGatheringMembers(gathering.id);
    setShowMembers(true);
  };

  const handleEditGathering = (gathering: Gathering) => {
    setEditingGathering(gathering);
    setEditFormData({
      name: gathering.name,
      description: gathering.description || '',
      dayOfWeek: gathering.dayOfWeek,
      startTime: gathering.startTime,
      durationMinutes: gathering.durationMinutes,
      frequency: gathering.frequency
    });
    setShowEditForm(true);
  };

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
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update gathering');
    }
  };

  const handleManageMembers = async (gathering: Gathering) => {
    try {
      setManagingGathering(gathering);
      
      // Get all people (which includes their gathering assignments)
      const peopleResponse = await individualsAPI.getAll();
      const allPeople = peopleResponse.data.people || [];
      
      // Map people with their assignment status using the gathering assignments data
      const peopleWithAssignment = allPeople.map((person: any) => ({
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        familyName: person.familyName,
        assigned: person.gatheringAssignments?.some((assignment: any) => assignment.id === gathering.id) || false
      }));
      
      // Store the original assignment state
      const originalAssigned = new Set(
        peopleWithAssignment
          .filter((p: any) => p.assigned)
          .map((p: any) => p.id)
      );
      setOriginalAssignedIds(originalAssigned as Set<number>);
      
      setAllPeople(peopleWithAssignment);
      setShowManageMembers(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load people');
    }
  };

  const handleUpdateMemberAssignments = async () => {
    if (!managingGathering) return;

    try {
      // Get the current assignment status (what user has selected)
      const currentAssignedIds = new Set(
        allPeople
          .filter((p: any) => p.assigned)
          .map((p: any) => p.id)
      );
      
      // Find people who need to be assigned (currently assigned but weren't originally)
      const peopleToAssign = allPeople.filter((p: any) => 
        currentAssignedIds.has(p.id) && !originalAssignedIds.has(p.id)
      ).map((p: any) => p.id);
      
      // Find people who need to be unassigned (originally assigned but not currently)
      const peopleToUnassign = allPeople.filter((p: any) => 
        originalAssignedIds.has(p.id) && !currentAssignedIds.has(p.id)
      ).map((p: any) => p.id);
      
      // Only make API calls for people whose status actually changed
      await Promise.all([
        ...peopleToAssign.map(personId => 
          individualsAPI.assignToGathering(personId, managingGathering.id)
        ),
        ...peopleToUnassign.map(personId => 
          individualsAPI.unassignFromGathering(personId, managingGathering.id)
        )
      ]);
      
      // Update the gathering's member count (keep visitor count unchanged)
      setGatherings(gatherings.map(g => 
        g.id === managingGathering.id 
          ? { ...g, memberCount: currentAssignedIds.size }
          : g
      ));
      
      setShowManageMembers(false);
      setManagingGathering(null);
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update member assignments');
    }
  };

  const showDeleteConfirmation = (gatheringId: number, gatheringName: string) => {
    setDeleteConfirmation({ gatheringId, gatheringName });
    setShowDeleteModal(true);
  };

  const handleDeleteGathering = async () => {
    if (!deleteConfirmation.gatheringId) return;

    try {
      await gatheringsAPI.delete(deleteConfirmation.gatheringId);
      setGatherings(gatherings.filter(g => g.id !== deleteConfirmation.gatheringId));
      if (selectedGathering?.id === deleteConfirmation.gatheringId) {
        setSelectedGathering(null);
        setShowMembers(false);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete gathering');
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
          <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
            Your Gatherings
          </h3>
          
          {gatherings.length === 0 ? (
            <div className="text-center py-8">
              <CalendarIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No gatherings</h3>
              <p className="mt-1 text-sm text-gray-500">
                Get started by creating your first gathering.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {gatherings.map((gathering) => (
                <div key={gathering.id} className="bg-gray-50 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <h4 className="text-lg font-medium text-gray-900">
                        {gathering.name}
                      </h4>
                      <p className="text-sm text-gray-500">
                        {gathering.dayOfWeek}s at {gathering.startTime}
                      </p>
                      {gathering.description && (
                        <p className="text-sm text-gray-600 mt-1">
                          {gathering.description}
                        </p>
                      )}
                      <div className="flex items-center mt-2 text-sm text-gray-500">
                        <UserGroupIcon className="h-4 w-4 mr-1" />
                        {gathering.memberCount || 0} regular attendees
                        {(gathering.recentVisitorCount || 0) > 0 && (
                          <span className="ml-2 text-green-600">
                            • {gathering.recentVisitorCount} recent visitors
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex space-x-2">
                      <ActionMenu 
                        items={[
                          {
                            label: 'View Members',
                            onClick: () => handleViewMembers(gathering),
                            icon: <EyeIcon className="h-4 w-4" />
                          },
                          {
                            label: 'Manage Members',
                            onClick: () => handleManageMembers(gathering),
                            icon: <UserGroupIcon className="h-4 w-4" />
                          },
                          {
                            label: 'Edit Gathering',
                            onClick: () => handleEditGathering(gathering),
                            icon: <PencilIcon className="h-4 w-4" />
                          },
                          {
                            label: 'Delete Gathering',
                            onClick: () => showDeleteConfirmation(gathering.id, gathering.name),
                            icon: <TrashIcon className="h-4 w-4" />,
                            className: 'text-red-600 hover:bg-red-50'
                          }
                        ]}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Members Modal */}
      {showMembers && selectedGathering && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  {selectedGathering.name} - Members
                </h3>
                <button
                  onClick={() => setShowMembers(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <span className="sr-only">Close</span>
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <div className="max-h-96 overflow-y-auto">
                {gatheringMembers.length === 0 ? (
                  <p className="text-gray-500 text-center py-4">No members found</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {gatheringMembers.map((member) => (
                      <div key={member.id} className="flex items-center p-2 bg-gray-50 rounded">
                        <div className="flex-1">
                          <p className="text-sm font-medium text-gray-900">
                            {member.firstName} {member.lastName}
                          </p>
                          {member.familyName && (
                            <p className="text-xs text-gray-500">{member.familyName}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => setShowMembers(false)}
                  className="px-4 py-2 bg-gray-300 text-gray-700 rounded-md hover:bg-gray-400"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Gathering Modal */}
      {showEditForm && editingGathering && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Edit Gathering
                </h3>
                <button
                  onClick={() => setShowEditForm(false)}
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
                      onChange={(e) => setEditFormData({ ...editFormData, startTime: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="edit-durationMinutes" className="block text-sm font-medium text-gray-700">
                      Duration (minutes) *
                    </label>
                    <input
                      id="edit-durationMinutes"
                      type="number"
                      value={editFormData.durationMinutes}
                      onChange={(e) => setEditFormData({ ...editFormData, durationMinutes: parseInt(e.target.value) })}
                      min="15"
                      max="480"
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      required
                    />
                  </div>
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
        </div>
      )}

      {/* Add Gathering Wizard Modal */}
      {showAddGatheringWizard && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-10 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              {/* Progress Indicator */}
              <div className="mb-6">
                <div className="flex items-center">
                  <div className="flex items-center text-xs">
                    <div className={`flex items-center justify-center w-8 h-8 rounded-full ${
                      currentStep >= 1 ? 'bg-primary-600 text-white' : 'bg-gray-200 text-gray-600'
                    }`}>
                      {currentStep > 1 ? <CheckIcon className="w-5 h-5" /> : '1'}
                    </div>
                    <div className={`w-8 h-0.5 ${currentStep > 1 ? 'bg-primary-600' : 'bg-gray-200'}`}></div>
                  </div>
                  <div className="flex items-center text-xs">
                    <div className={`flex items-center justify-center w-8 h-8 rounded-full ${
                      currentStep >= 2 ? 'bg-primary-600 text-white' : 'bg-gray-200 text-gray-600'
                    }`}>
                      {currentStep > 2 ? <CheckIcon className="w-5 h-5" /> : '2'}
                    </div>
                    <div className={`w-8 h-0.5 ${currentStep > 2 ? 'bg-primary-600' : 'bg-gray-200'}`}></div>
                  </div>
                  <div className="flex items-center text-xs">
                    <div className={`flex items-center justify-center w-8 h-8 rounded-full ${
                      currentStep >= 3 ? 'bg-primary-600 text-white' : 'bg-gray-200 text-gray-600'
                    }`}>
                      3
                    </div>
                  </div>
                </div>
                <div className="flex justify-between text-xs text-gray-500 mt-2">
                  <span>Details</span>
                  <span>Add People</span>
                  <span>Assign Users</span>
                </div>
              </div>

              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  {currentStep === 1 ? 'Gathering Details' : currentStep === 2 ? 'Add People' : 'Assign Users'}
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
              
              {currentStep === 1 && (
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

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label htmlFor="add-dayOfWeek" className="block text-sm font-medium text-gray-700">
                        Day of Week *
                      </label>
                      <select
                        id="add-dayOfWeek"
                        value={createGatheringData.dayOfWeek}
                        onChange={(e) => setCreateGatheringData({ ...createGatheringData, dayOfWeek: e.target.value })}
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
                      <label htmlFor="add-startTime" className="block text-sm font-medium text-gray-700">
                        Start Time *
                      </label>
                      <input
                        id="add-startTime"
                        type="time"
                        value={createGatheringData.startTime}
                        onChange={(e) => setCreateGatheringData({ ...createGatheringData, startTime: e.target.value })}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        required
                      />
                    </div>

                    <div>
                      <label htmlFor="add-durationMinutes" className="block text-sm font-medium text-gray-700">
                        Duration (minutes) *
                      </label>
                      <input
                        id="add-durationMinutes"
                        type="number"
                        value={createGatheringData.durationMinutes}
                        onChange={(e) => setCreateGatheringData({ ...createGatheringData, durationMinutes: parseInt(e.target.value) })}
                        min="15"
                        max="480"
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="add-frequency" className="block text-sm font-medium text-gray-700">
                      Frequency *
                    </label>
                    <select
                      id="add-frequency"
                      value={createGatheringData.frequency}
                      onChange={(e) => setCreateGatheringData({ ...createGatheringData, frequency: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      required
                    >
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Bi-weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </div>

                  <div className="flex items-center">
                    <input
                      id="add-setAsDefault"
                      type="checkbox"
                      checked={createGatheringData.setAsDefault}
                      onChange={(e) => setCreateGatheringData({ ...createGatheringData, setAsDefault: e.target.checked })}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                    />
                    <label htmlFor="add-setAsDefault" className="ml-2 block text-sm text-gray-900">
                      Set as my default gathering
                    </label>
                  </div>
                  
                  <div className="flex justify-end space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddGatheringWizard(false);
                        resetWizardState();
                      }}
                      className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={nextStep}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                      disabled={!canProceedFromStep1()}
                    >
                      Next
                      <ChevronRightIcon className="ml-2 h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              {currentStep === 2 && (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="add-peopleToAdd" className="block text-sm font-medium text-gray-700">
                      Add People (Optional)
                    </label>
                    <div className="relative">
                      <textarea
                        id="add-peopleToAdd"
                        value={createGatheringData.bulkPeopleText}
                        onChange={(e) => handleBulkPeopleTextChange(e.target.value)}
                        rows={6}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="John Doe&#10;Jane Smith&#10;Peter Jones&#10;&#10;Or: John Doe, Jane Smith, Peter Jones"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.readText().then(text => {
                            handleBulkPeopleTextChange(text);
                          }).catch(err => {
                            console.error('Failed to read clipboard:', err);
                          });
                        }}
                        className="absolute top-2 right-2 p-1 text-gray-400 hover:text-gray-600"
                        title="Paste from clipboard"
                      >
                        <ClipboardDocumentIcon className="h-5 w-5" />
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-gray-500">
                      Enter names in "First Last" format. One per line, or separated by commas/semicolons.
                    </p>
                  </div>

                  {/* People Preview */}
                  {createGatheringData.peopleToAdd.length > 0 && (
                    <div className="bg-green-50 border border-green-200 rounded-md p-3">
                      <h4 className="text-sm font-medium text-green-800 mb-2">
                        People to add ({createGatheringData.peopleToAdd.length}):
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                        {createGatheringData.peopleToAdd.map((name, index) => (
                          <div key={index} className="text-sm text-green-700 flex items-center">
                            <CheckIcon className="h-3 w-3 mr-1" />
                            {name}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  <div className="flex justify-between space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={prevStep}
                      className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      <ChevronLeftIcon className="mr-2 h-4 w-4" />
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={nextStep}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                    >
                      Next
                      <ChevronRightIcon className="ml-2 h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              {currentStep === 3 && (
                <div className="space-y-4">
                  {/* Summary */}
                  <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                    <h4 className="text-sm font-medium text-blue-800">Summary:</h4>
                    <p className="text-sm text-blue-700">
                      Creating "{createGatheringData.name}" with {createGatheringData.peopleToAdd.length} people
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-3">
                      Assign Users (Optional)
                    </label>
                    
                    {/* Self Assignment First */}
                    <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={createGatheringData.assignSelf}
                          onChange={(e) => setCreateGatheringData({ ...createGatheringData, assignSelf: e.target.checked })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <div className="ml-3">
                          <p className="text-sm font-medium text-blue-900">
                            Assign myself to this gathering
                          </p>
                          <p className="text-xs text-blue-700">
                            Recommended so you can manage attendance and settings
                          </p>
                        </div>
                      </label>
                    </div>

                    {/* Other Users */}
                    {allUsers.filter(u => u.id !== user?.id).length > 0 && (
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {allUsers.filter(u => u.id !== user?.id).map((userItem) => (
                          <label key={userItem.id} className="flex items-center p-3 bg-gray-50 rounded-md hover:bg-gray-100 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={createGatheringData.userIds.includes(userItem.id)}
                              onChange={(e) => {
                                setCreateGatheringData(prev => ({
                                  ...prev,
                                  userIds: e.target.checked 
                                    ? [...prev.userIds, userItem.id]
                                    : prev.userIds.filter(id => id !== userItem.id)
                                }));
                              }}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                            />
                            <div className="ml-3 flex-1">
                              <p className="text-sm font-medium text-gray-900">
                                {userItem.firstName} {userItem.lastName}
                              </p>
                              <p className="text-xs text-gray-500">
                                {userItem.role} • {userItem.email || userItem.mobileNumber}
                              </p>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                  
                  <div className="flex justify-between space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={prevStep}
                      className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      <ChevronLeftIcon className="mr-2 h-4 w-4" />
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={handleCreateGathering}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700"
                      disabled={isCreating}
                    >
                      {isCreating ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                          Creating...
                        </>
                      ) : (
                        <>
                          <CheckIcon className="mr-2 h-4 w-4" />
                          Create Gathering
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Manage Members Modal */}
      {showManageMembers && managingGathering && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Manage Members - {managingGathering.name}
                </h3>
                <button
                  onClick={() => setShowManageMembers(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <span className="sr-only">Close</span>
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <div className="max-h-96 overflow-y-auto">
                {allPeople.length === 0 ? (
                  <p className="text-gray-500 text-center py-4">No people found</p>
                ) : (
                  <div className="space-y-2">
                    {allPeople.map((person) => (
                      <label key={person.id} className="flex items-center p-3 bg-gray-50 rounded-md hover:bg-gray-100 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={person.assigned}
                          onChange={(e) => {
                            setAllPeople(allPeople.map(p => 
                              p.id === person.id 
                                ? { ...p, assigned: e.target.checked }
                                : p
                            ));
                          }}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <div className="ml-3 flex-1">
                          <p className="text-sm font-medium text-gray-900">
                            {person.firstName} {person.lastName}
                          </p>
                          {person.familyName && (
                            <p className="text-xs text-gray-500">{person.familyName}</p>
                          )}
                        </div>
                        <div className={`px-2 py-1 text-xs font-medium rounded-full ${
                          person.assigned 
                            ? 'bg-green-100 text-green-800' 
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {person.assigned ? 'Assigned' : 'Not Assigned'}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              
              <div className="mt-4 flex justify-end space-x-3">
                <button
                  onClick={() => setShowManageMembers(false)}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateMemberAssignments}
                  className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                >
                  Update Assignments
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Gathering Confirmation Modal */}
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
        </div>
      )}

      {/* Floating Add Gathering Button */}
      <button
        onClick={() => {
          resetWizardState();
          setSuccess(''); // Clear any previous success messages
          setShowAddGatheringWizard(true);
        }}
        className="fixed bottom-6 right-6 w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-50"
      >
        <PlusIcon className="h-6 w-6" />
      </button>
    </div>
  );
};

export default ManageGatheringsPage; 