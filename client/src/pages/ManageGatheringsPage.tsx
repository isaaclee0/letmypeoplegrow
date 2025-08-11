import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { gatheringsAPI } from '../services/api';
import ActionMenu from '../components/ActionMenu';
import {
  PlusIcon,
  UserGroupIcon,
  CalendarIcon,
  TrashIcon,
  PencilIcon,
  CheckIcon,
  XMarkIcon
} from '@heroicons/react/24/outline';

interface Gathering {
  id: number;
  name: string;
  description: string;
  dayOfWeek: string;
  startTime: string;
  frequency: string;
  isActive: boolean;
  memberCount?: number;
  recentVisitorCount?: number;
}



interface CreateGatheringData {
  // Basic details
  name: string;
  description: string;
  dayOfWeek: string;
  startTime: string;
  frequency: string;
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
    frequency: 'weekly'
  });

  const [createGatheringData, setCreateGatheringData] = useState<CreateGatheringData>({
    name: 'Sunday Morning Service',
    description: 'Weekly Sunday morning gathering',
    dayOfWeek: 'Sunday',
    startTime: '10:00',
    frequency: 'weekly'
  });

  // Confirmation modal states
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    gatheringId: number | null;
    gatheringName: string;
  }>({ gatheringId: null, gatheringName: '' });

  useEffect(() => {
    loadGatherings();
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
        frequency: createGatheringData.frequency
      };
      
      console.log('Creating gathering with data:', gatheringData);
      
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
        isActive: true,
        memberCount: 0,
        recentVisitorCount: 0
      };

      setGatherings([...gatherings, newGathering]);
      setSuccess(`Gathering "${createGatheringData.name}" created successfully.`);
      setShowAddGatheringWizard(false);
      resetWizardState();

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
      frequency: gathering.frequency
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
            <div className="relative text-center py-12">
              <CalendarIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No gatherings</h3>
              <p className="mt-1 text-sm text-gray-500">
                Get started by creating your first gathering.
              </p>
              {/* Prominent guidance to add button */}
              <div className="hidden sm:block">
                <div className="absolute bottom-2 right-28 z-40 flex items-center space-x-3">
                  <div className="bg-white/90 backdrop-blur rounded-lg shadow-lg border border-primary-200 px-4 py-3 text-primary-800 animate-pulse">
                    <p className="text-base font-semibold">Click the plus to add a gathering</p>
                  </div>
                  <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-primary-600 animate-bounce">
                    <path d="M5 5 C90 5, 100 60, 110 110" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path d="M96 88 L110 110 L85 106" stroke="currentColor" strokeWidth="4" fill="none" />
                  </svg>
                </div>
              </div>
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
                            label: 'Manage Members',
                            onClick: handleManageMembers,
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

      {/* Add Gathering Modal (simplified) */}
      {showAddGatheringWizard && (
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
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700"
                      disabled={isCreating || !canProceedFromStep1()}
                    >
                      {isCreating ? 'Creating...' : 'Create Gathering'}
                    </button>
                  </div>
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
      {gatherings.length === 0 && (
        <span className="pointer-events-none fixed bottom-6 right-6 z-40 inline-flex h-20 w-20 rounded-full bg-primary-400 opacity-30 animate-ping"></span>
      )}
      <button
        onClick={openAddModal}
        className="fixed bottom-6 right-6 w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-50"
      >
        <PlusIcon className="h-6 w-6" />
      </button>
    </div>
  );
};

export default ManageGatheringsPage; 