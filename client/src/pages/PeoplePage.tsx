import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { individualsAPI, familiesAPI, gatheringsAPI, csvImportAPI } from '../services/api';
import { useToast } from '../components/ToastContainer';
import ActionMenu from '../components/ActionMenu';
import {
  UserGroupIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  CloudArrowUpIcon,
  ClipboardDocumentIcon,
  TrashIcon,
  PencilIcon,
  EyeIcon,
  XMarkIcon
} from '@heroicons/react/24/outline';

interface Person {
  id: number;
  firstName: string;
  lastName: string;
  familyId?: number;
  familyName?: string;
  isVisitor?: boolean;
  gatheringAssignments?: Array<{
    id: number;
    name: string;
  }>;
}

interface Family {
  id: number;
  familyName: string;
  familyIdentifier?: string;
  memberCount: number;
}

const PeoplePage: React.FC = () => {

  const { showSuccess } = useToast();
  const [people, setPeople] = useState<Person[]>([]);
  const [families, setFamilies] = useState<Family[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFamily, setSelectedFamily] = useState<number | null>(null);
  const [showAddPerson, setShowAddPerson] = useState(false);
  const [showAddFamily, setShowAddFamily] = useState(false);
  const [showCSVUpload, setShowCSVUpload] = useState(false);
  const [showCopyPaste, setShowCopyPaste] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [showPersonDetails, setShowPersonDetails] = useState(false);

  // Form states
  const [personForm, setPersonForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    familyId: ''
  });

  const [familyForm, setFamilyForm] = useState({
    familyName: '',
    familyIdentifier: ''
  });

  const [csvData, setCsvData] = useState('');
  const [copyPasteData, setCopyPasteData] = useState('');
  const [selectedPeople, setSelectedPeople] = useState<number[]>([]);
  const [gatheringTypes, setGatheringTypes] = useState<Array<{id: number, name: string}>>([]);
  const [showMassManage, setShowMassManage] = useState(false);
  const [selectedGatheringId, setSelectedGatheringId] = useState<number | null>(null);
  
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

  useEffect(() => {
    loadPeople();
    loadFamilies();
    loadGatheringTypes();
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

  const loadGatheringTypes = async () => {
    try {
      const response = await gatheringsAPI.getAll();
      setGatheringTypes(response.data.gatherings || []);
    } catch (err: any) {
      console.error('Failed to load gathering types:', err);
    }
  };

  const handleAddPerson = async () => {
    try {
      const personData = {
        ...personForm,
        familyId: personForm.familyId ? parseInt(personForm.familyId) : undefined
      };
      
      await individualsAPI.create(personData);
      
      // Reload people to get the updated list
      await loadPeople();
      
      setShowAddPerson(false);
      setPersonForm({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        familyId: ''
      });
      setError('');
      showSuccess('Person added successfully');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to add person');
    }
  };

  const handleAddFamily = async () => {
    try {
      await familiesAPI.create(familyForm);
      
      // Reload families to get the updated list
      await loadFamilies();
      
      setShowAddFamily(false);
      setFamilyForm({
        familyName: '',
        familyIdentifier: ''
      });
      setError('');
      showSuccess('Family added successfully');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to add family');
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
      setShowCSVUpload(false);
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
      
      const response = await csvImportAPI.copyPaste(copyPasteData, selectedGatheringId || undefined);
      
      setShowCopyPaste(false);
      setCopyPasteData('');
      setSelectedGatheringId(null);
      
      // Show success message
      showSuccess(`Import completed! Imported: ${response.data.imported} people, Families: ${response.data.families}, Duplicates: ${response.data.duplicates}, Skipped: ${response.data.skipped}`);
      
      // Reload people after upload
      await loadPeople();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to process data');
    } finally {
      setIsLoading(false);
    }
  };

  const handleMassAssign = async (gatheringId: number) => {
    if (selectedPeople.length === 0) {
      setError('Please select people to assign');
      return;
    }

    try {
      setIsLoading(true);
      setError('');
      
      const response = await csvImportAPI.massAssign(gatheringId, selectedPeople);
      
      showSuccess(`Mass assignment completed! Assigned: ${response.data.assigned}, Already assigned: ${response.data.alreadyAssigned}, Not found: ${response.data.notFound}`);
      
      setSelectedPeople([]);
      setShowMassManage(false);
      await loadPeople();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to assign people to service');
    } finally {
      setIsLoading(false);
    }
  };

  const showRemoveConfirmation = (gatheringId: number) => {
    if (selectedPeople.length === 0) {
      setError('Please select people to remove');
      return;
    }
    setRemoveConfirmation({ gatheringId, peopleCount: selectedPeople.length });
    setShowRemoveModal(true);
  };

  const handleMassRemove = async () => {
    if (!removeConfirmation.gatheringId) return;

    try {
      setIsLoading(true);
      setError('');
      
      const response = await csvImportAPI.massRemove(removeConfirmation.gatheringId, selectedPeople);
      
      showSuccess(`Mass removal completed! Removed: ${response.data.removed} people`);
      
      setSelectedPeople([]);
      setShowMassManage(false);
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

  const selectAllPeople = () => {
    setSelectedPeople([...filteredPeople.map(person => person.id), ...filteredVisitors.map(person => person.id)]);
  };

  const clearSelection = () => {
    setSelectedPeople([]);
  };

  // Filter people based on search term and family selection
  const filteredPeople = people.filter(person => {
    const matchesSearch = searchTerm === '' || 
      person.firstName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      person.lastName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      person.familyName?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesFamily = selectedFamily === null || person.familyId === selectedFamily;
    
    return matchesSearch && matchesFamily && !person.isVisitor;
  });

  // Filter visitors separately
  const filteredVisitors = people.filter(person => {
    const matchesSearch = searchTerm === '' || 
      person.firstName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      person.lastName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      person.familyName?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesFamily = selectedFamily === null || person.familyId === selectedFamily;
    
    return matchesSearch && matchesFamily && person.isVisitor;
  });

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
            <div className="flex space-x-3">
              {selectedPeople.length > 0 && (
                <button
                  onClick={() => setShowMassManage(true)}
                  className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                >
                  <UserGroupIcon className="h-4 w-4 mr-2" />
                  Manage Selected ({selectedPeople.length})
                </button>
              )}
              <button
                onClick={() => setShowCopyPaste(true)}
                className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                <ClipboardDocumentIcon className="h-4 w-4 mr-2" />
                Copy & Paste
              </button>
              <button
                onClick={() => setShowCSVUpload(true)}
                className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                <CloudArrowUpIcon className="h-4 w-4 mr-2" />
                CSV Upload
              </button>
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
              <label htmlFor="familyFilter" className="block text-sm font-medium text-gray-700">
                Filter by Family
              </label>
              <select
                id="familyFilter"
                value={selectedFamily || ''}
                onChange={(e) => setSelectedFamily(e.target.value ? parseInt(e.target.value) : null)}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="">All Families</option>
                {families.map((family) => (
                  <option key={family.id} value={family.id}>
                    {family.familyName} ({family.memberCount} members)
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* People List */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              People ({filteredPeople.length})
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
              <button
                onClick={() => setShowAddFamily(true)}
                className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                <UserGroupIcon className="h-4 w-4 mr-2" />
                Add Family
              </button>
            </div>
          </div>
          
          {filteredPeople.length === 0 ? (
            <div className="text-center py-8">
              <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No people found</h3>
              <p className="mt-1 text-sm text-gray-500">
                {searchTerm || selectedFamily ? 'Try adjusting your search or filters.' : 'Get started by adding your first person.'}
              </p>
            </div>
          ) : (
            <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <input
                        type="checkbox"
                        checked={selectedPeople.length === filteredPeople.length && filteredPeople.length > 0}
                        onChange={selectedPeople.length === filteredPeople.length ? clearSelection : selectAllPeople}
                        className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Family
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Gatherings
                    </th>
                    <th className="relative px-6 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredPeople.map((person) => (
                    <tr key={person.id}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={selectedPeople.includes(person.id)}
                          onChange={() => togglePersonSelection(person.id)}
                          className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">
                          {person.firstName} {person.lastName}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {person.familyName || '-'}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {person.isVisitor ? 'Visitor' : 'Regular'}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {person.gatheringAssignments?.length ? (
                            <div className="flex flex-wrap gap-1">
                              {person.gatheringAssignments.map(gathering => (
                                <span key={gathering.id} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-800">
                                  {gathering.name}
                                </span>
                              ))}
                            </div>
                          ) : (
                            '-'
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <ActionMenu
                          items={[
                            {
                              label: 'View Details',
                              icon: <EyeIcon className="h-4 w-4" />,
                              onClick: () => {
                                setSelectedPerson(person);
                                setShowPersonDetails(true);
                              }
                            },
                            {
                              label: 'Edit',
                              icon: <PencilIcon className="h-4 w-4" />,
                              onClick: () => {/* TODO: Implement edit */}
                            },
                            {
                              label: 'Delete',
                              icon: <TrashIcon className="h-4 w-4" />,
                              onClick: () => showDeleteConfirmation(person.id, `${person.firstName} ${person.lastName}`),
                              className: 'text-red-600 hover:bg-red-50'
                            }
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Visitors Section */}
      {filteredVisitors.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg leading-6 font-medium text-gray-900">
                Visitors ({filteredVisitors.length})
              </h3>
            </div>
            
            <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <input
                        type="checkbox"
                        checked={filteredVisitors.length > 0 && filteredVisitors.every(person => selectedPeople.includes(person.id))}
                        onChange={filteredVisitors.every(person => selectedPeople.includes(person.id)) ? 
                          () => setSelectedPeople(selectedPeople.filter(id => !filteredVisitors.map(p => p.id).includes(id))) :
                          () => setSelectedPeople([...selectedPeople, ...filteredVisitors.map(person => person.id)])}
                        className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Family
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Gatherings
                    </th>
                    <th className="relative px-6 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredVisitors.map((person) => (
                    <tr key={person.id} className="bg-yellow-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={selectedPeople.includes(person.id)}
                          onChange={() => togglePersonSelection(person.id)}
                          className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">
                          {person.firstName} {person.lastName}
                          <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                            Visitor
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {person.familyName || '-'}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {person.isVisitor ? 'Visitor' : 'Regular'}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {person.gatheringAssignments?.length ? (
                            <div className="flex flex-wrap gap-1">
                              {person.gatheringAssignments.map(gathering => (
                                <span key={gathering.id} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-800">
                                  {gathering.name}
                                </span>
                              ))}
                            </div>
                          ) : (
                            '-'
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <ActionMenu
                          items={[
                            {
                              label: 'View Details',
                              icon: <EyeIcon className="h-4 w-4" />,
                              onClick: () => {
                                setSelectedPerson(person);
                                setShowPersonDetails(true);
                              }
                            },
                            {
                              label: 'Edit',
                              icon: <PencilIcon className="h-4 w-4" />,
                              onClick: () => {/* TODO: Implement edit */}
                            },
                            {
                              label: 'Delete',
                              icon: <TrashIcon className="h-4 w-4" />,
                              onClick: () => showDeleteConfirmation(person.id, `${person.firstName} ${person.lastName}`),
                              className: 'text-red-600 hover:bg-red-50'
                            }
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Add Person Modal */}
      {showAddPerson && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Add New Person
                </h3>
                <button
                  onClick={() => setShowAddPerson(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <span className="sr-only">Close</span>
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <form onSubmit={(e) => { e.preventDefault(); handleAddPerson(); }} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="firstName" className="block text-sm font-medium text-gray-700">
                      First Name *
                    </label>
                    <input
                      id="firstName"
                      type="text"
                      value={personForm.firstName}
                      onChange={(e) => setPersonForm({ ...personForm, firstName: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      placeholder="First name"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="lastName" className="block text-sm font-medium text-gray-700">
                      Last Name *
                    </label>
                    <input
                      id="lastName"
                      type="text"
                      value={personForm.lastName}
                      onChange={(e) => setPersonForm({ ...personForm, lastName: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      placeholder="Last name"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="family" className="block text-sm font-medium text-gray-700">
                    Family
                  </label>
                  <select
                    id="family"
                    value={personForm.familyId}
                    onChange={(e) => setPersonForm({ ...personForm, familyId: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="">No Family</option>
                    {families.map((family) => (
                      <option key={family.id} value={family.id}>
                        {family.familyName}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                      Email
                    </label>
                    <input
                      id="email"
                      type="email"
                      value={personForm.email}
                      onChange={(e) => setPersonForm({ ...personForm, email: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      placeholder="email@example.com"
                    />
                  </div>
                  <div>
                    <label htmlFor="phone" className="block text-sm font-medium text-gray-700">
                      Phone
                    </label>
                    <input
                      id="phone"
                      type="tel"
                      value={personForm.phone}
                      onChange={(e) => setPersonForm({ ...personForm, phone: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      placeholder="0412345678"
                    />
                  </div>
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddPerson(false)}
                    className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                  >
                    Add Person
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Add Family Modal */}
      {showAddFamily && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Add New Family
                </h3>
                <button
                  onClick={() => setShowAddFamily(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <span className="sr-only">Close</span>
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              
              <form onSubmit={(e) => { e.preventDefault(); handleAddFamily(); }} className="space-y-4">
                <div>
                  <label htmlFor="familyName" className="block text-sm font-medium text-gray-700">
                    Family Name *
                  </label>
                  <input
                    id="familyName"
                    type="text"
                    value={familyForm.familyName}
                    onChange={(e) => setFamilyForm({ ...familyForm, familyName: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Family name"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="familyIdentifier" className="block text-sm font-medium text-gray-700">
                    Family Identifier
                  </label>
                  <input
                    id="familyIdentifier"
                    type="text"
                    value={familyForm.familyIdentifier}
                    onChange={(e) => setFamilyForm({ ...familyForm, familyIdentifier: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Optional identifier (e.g., DOE001)"
                  />
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddFamily(false)}
                    className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                  >
                    Add Family
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* CSV Upload Modal */}
      {showCSVUpload && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Upload CSV File
                </h3>
                <button
                  onClick={() => setShowCSVUpload(false)}
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
                  <p>Expected CSV format:</p>
                  <p className="font-mono text-xs mt-1">firstName,lastName,email,phone,familyName</p>
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowCSVUpload(false)}
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
            </div>
          </div>
        </div>
      )}

      {/* Copy & Paste Modal */}
      {showCopyPaste && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Copy & Paste Data
                </h3>
                <button
                  onClick={() => setShowCopyPaste(false)}
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
                  <p className="font-mono text-xs mt-1">firstName lastName familyName</p>
                  <p className="mt-2">The system will automatically detect the separator and parse the data.</p>
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
                    onClick={() => setShowCopyPaste(false)}
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
            </div>
          </div>
        </div>
      )}

      {/* Mass Management Modal */}
      {showMassManage && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Mass Manage People ({selectedPeople.length} selected)
                </h3>
                <button
                  onClick={() => setShowMassManage(false)}
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
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Assign to Service
                  </label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {gatheringTypes.map(gathering => (
                      <div key={gathering.id} className="flex space-x-2">
                        <button
                          onClick={() => handleMassAssign(gathering.id)}
                          className="flex-1 px-3 py-2 text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                        >
                          Add to {gathering.name}
                        </button>
                        <button
                          onClick={() => showRemoveConfirmation(gathering.id)}
                          className="px-3 py-2 text-sm font-medium rounded-md text-red-600 border border-red-600 hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  {gatheringTypes.length === 0 && (
                    <p className="text-sm text-gray-500">No services available</p>
                  )}
                </div>

                <div className="text-sm text-gray-500">
                  <p>This will assign or remove the selected people from the chosen service.</p>
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowMassManage(false)}
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
                  <p className="mt-1 text-sm text-gray-900">{selectedPerson.isVisitor ? 'Visitor' : 'Regular Attendee'}</p>
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

      {/* Floating Add Person Button */}
      <button
        onClick={() => setShowAddPerson(true)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-50"
      >
        <PlusIcon className="h-6 w-6" />
      </button>
    </div>
  );
};

export default PeoplePage; 