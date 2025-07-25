import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { gatheringsAPI, individualsAPI } from '../services/api';
import {
  PlusIcon,
  UserGroupIcon,
  CalendarIcon,
  TrashIcon,
  PencilIcon,
  EyeIcon
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
}

interface Individual {
  id: number;
  firstName: string;
  lastName: string;
  familyName?: string;
}

const ManageGatheringsPage: React.FC = () => {
  const { user } = useAuth();
  const [gatherings, setGatherings] = useState<Gathering[]>([]);
  const [selectedGathering, setSelectedGathering] = useState<Gathering | null>(null);
  const [gatheringMembers, setGatheringMembers] = useState<Individual[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
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
  const [editFormData, setEditFormData] = useState({
    name: '',
    description: '',
    dayOfWeek: 'Sunday',
    startTime: '10:00',
    durationMinutes: 90,
    frequency: 'weekly'
  });
  const [addFormData, setAddFormData] = useState({
    name: '',
    description: '',
    dayOfWeek: 'Sunday',
    startTime: '10:00',
    durationMinutes: 90,
    frequency: 'weekly',
    setAsDefault: false
  });

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

  const loadGatheringMembers = async (gatheringId: number) => {
    try {
      const response = await gatheringsAPI.getMembers(gatheringId);
      setGatheringMembers(response.data.members || []);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load gathering members');
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

  const handleCreateGathering = async () => {
    try {
      const response = await gatheringsAPI.create(addFormData);
      
      // Add the new gathering to the local state
      const newGathering: Gathering = {
        id: response.data.id,
        name: addFormData.name,
        description: addFormData.description,
        dayOfWeek: addFormData.dayOfWeek,
        startTime: addFormData.startTime,
        durationMinutes: addFormData.durationMinutes,
        frequency: addFormData.frequency,
        isActive: true,
        memberCount: 0
      };
      
      setGatherings([...gatherings, newGathering]);
      setShowAddForm(false);
      setAddFormData({
        name: '',
        description: '',
        dayOfWeek: 'Sunday',
        startTime: '10:00',
        durationMinutes: 90,
        frequency: 'weekly',
        setAsDefault: false
      });
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create gathering');
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
      
      // Update the gathering's member count
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

  const handleDeleteGathering = async (gatheringId: number) => {
    if (!window.confirm('Are you sure you want to delete this gathering? This will also remove all member associations.')) {
      return;
    }

    try {
      await gatheringsAPI.delete(gatheringId);
      setGatherings(gatherings.filter(g => g.id !== gatheringId));
      if (selectedGathering?.id === gatheringId) {
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
                        {gathering.memberCount || 0} members
                      </div>
                    </div>
                    <div className="flex space-x-2">
                      <button
                        onClick={() => handleManageMembers(gathering)}
                        className="text-primary-600 hover:text-primary-700"
                        title="Manage Members"
                      >
                        <UserGroupIcon className="h-5 w-5" />
                      </button>
                      <button
                        onClick={() => handleViewMembers(gathering)}
                        className="text-blue-600 hover:text-blue-700"
                        title="View Members"
                      >
                        <EyeIcon className="h-5 w-5" />
                      </button>
                      <button
                        onClick={() => handleEditGathering(gathering)}
                        className="text-gray-400 hover:text-gray-600"
                        title="Edit"
                      >
                        <PencilIcon className="h-5 w-5" />
                      </button>
                      <button
                        onClick={() => handleDeleteGathering(gathering.id)}
                        className="text-red-400 hover:text-red-600"
                        title="Delete"
                      >
                        <TrashIcon className="h-5 w-5" />
                      </button>
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

      {/* Add Gathering Modal */}
      {showAddForm && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Add New Gathering
                </h3>
                <button
                  onClick={() => setShowAddForm(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <span className="sr-only">Close</span>
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <form onSubmit={(e) => { e.preventDefault(); handleCreateGathering(); }} className="space-y-4">
                <div>
                  <label htmlFor="add-name" className="block text-sm font-medium text-gray-700">
                    Gathering Name *
                  </label>
                  <input
                    id="add-name"
                    type="text"
                    value={addFormData.name}
                    onChange={(e) => setAddFormData({ ...addFormData, name: e.target.value })}
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
                    value={addFormData.description}
                    onChange={(e) => setAddFormData({ ...addFormData, description: e.target.value })}
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
                      value={addFormData.dayOfWeek}
                      onChange={(e) => setAddFormData({ ...addFormData, dayOfWeek: e.target.value })}
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
                      value={addFormData.startTime}
                      onChange={(e) => setAddFormData({ ...addFormData, startTime: e.target.value })}
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
                      value={addFormData.durationMinutes}
                      onChange={(e) => setAddFormData({ ...addFormData, durationMinutes: parseInt(e.target.value) })}
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
                    value={addFormData.frequency}
                    onChange={(e) => setAddFormData({ ...addFormData, frequency: e.target.value })}
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
                    checked={addFormData.setAsDefault}
                    onChange={(e) => setAddFormData({ ...addFormData, setAsDefault: e.target.checked })}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                  />
                  <label htmlFor="add-setAsDefault" className="ml-2 block text-sm text-gray-900">
                    Set as my default gathering
                  </label>
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                  >
                    Create Gathering
                  </button>
                </div>
              </form>
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

      {/* Floating Add Gathering Button */}
      <button
        onClick={() => setShowAddForm(true)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-50"
      >
        <PlusIcon className="h-6 w-6" />
      </button>
    </div>
  );
};

export default ManageGatheringsPage; 