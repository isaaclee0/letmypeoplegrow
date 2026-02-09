import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon, PlusIcon } from '@heroicons/react/24/outline';
import { attendanceAPI, familiesAPI, individualsAPI } from '../../services/api';
import { generateFamilyName } from '../../utils/familyNameUtils';
import logger from '../../utils/logger';

interface PersonForm {
  firstName: string;
  lastName: string;
  fillLastNameFromAbove: boolean;
}

interface VisitorFormState {
  personType: 'local_visitor' | 'traveller_visitor';
  notes: string;
  persons: PersonForm[];
  autoFillSurname: boolean;
  familyName: string;
}

interface AddVisitorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (message: string) => Promise<void>;
  selectedGathering: any;
  selectedDate: string;
  user: any;
  isAttendanceLocked: boolean;
  isEditingVisitor: boolean;
  editingVisitorData: any;
  setAttendanceRefreshTrigger: React.Dispatch<React.SetStateAction<number>>;
  setRecentVisitors: React.Dispatch<React.SetStateAction<any[]>>;
  setAllRecentVisitorsPool: React.Dispatch<React.SetStateAction<any[]>>;
  setAllChurchVisitors: React.Dispatch<React.SetStateAction<any[]>>;
}

const AddVisitorModal: React.FC<AddVisitorModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  selectedGathering,
  selectedDate,
  user,
  isAttendanceLocked,
  isEditingVisitor,
  editingVisitorData,
  setAttendanceRefreshTrigger,
  setRecentVisitors,
  setAllRecentVisitorsPool,
  setAllChurchVisitors
}) => {
  const [visitorForm, setVisitorForm] = useState<VisitorFormState>({
    personType: 'local_visitor',
    notes: '',
    persons: [{
      firstName: '',
      lastName: '',
      fillLastNameFromAbove: false
    }],
    autoFillSurname: false,
    familyName: ''
  });

  const [error, setError] = useState('');
  const [isSubmittingVisitor, setIsSubmittingVisitor] = useState(false);

  // Helper to convert internal format to utility format
  const convertToUtilityFormat = (people: any[]) => {
    return people.map(p => ({
      firstName: p.firstName,
      lastName: p.lastName,
      lastUnknown: p.lastUnknown
    }));
  };

  const addPerson = () => {
    setVisitorForm(prev => {
      const newPerson = {
        firstName: '',
        lastName: '',
        fillLastNameFromAbove: false
      };

      // Auto-fill last name from first person if checkbox enabled
      if (prev.autoFillSurname && prev.persons.length > 0) {
        newPerson.lastName = prev.persons[0].lastName;
        newPerson.fillLastNameFromAbove = true;
      }

      return {
        ...prev,
        persons: [...prev.persons, newPerson]
      };
    });
  };

  const removePerson = (index: number) => {
    setVisitorForm(prev => ({
      ...prev,
      persons: prev.persons.filter((_, i) => i !== index)
    }));
  };

  const updatePerson = (index: number, updates: Partial<PersonForm>) => {
    setVisitorForm(prev => {
      const newPersons = [...prev.persons];
      newPersons[index] = { ...newPersons[index], ...updates };

      // If updating first person's last name and autoFillSurname is enabled, propagate to others
      if (index === 0 && updates.lastName !== undefined && prev.autoFillSurname) {
        for (let i = 1; i < newPersons.length; i++) {
          if (newPersons[i].fillLastNameFromAbove) {
            newPersons[i].lastName = updates.lastName;
          }
        }
      }

      // If enabling fillLastNameFromAbove, copy from first person
      if (updates.fillLastNameFromAbove && index > 0 && newPersons[0]) {
        newPersons[index].lastName = newPersons[0].lastName;
      }

      return {
        ...prev,
        persons: newPersons
      };
    });
  };

  const computedVisitorFamilyName = useMemo(() => {
    const validMembers = visitorForm.persons.filter(member =>
      member.firstName.trim()
    );

    if (validMembers.length === 0) return '';

    return generateFamilyName(validMembers.map(person => ({
      firstName: person.firstName.trim(),
      lastName: person.lastName.trim(),
      lastUnknown: !person.lastName.trim()
    })));
  }, [visitorForm.persons]);

  const getAddModalTitle = () => {
    if (isEditingVisitor) {
      const totalPeople = visitorForm.persons.length;
      return totalPeople === 1 ? 'Edit Visitor' : `Edit Visitors (${totalPeople})`;
    } else {
      const totalPeople = visitorForm.persons.length;
      return totalPeople === 1 ? 'Add Visitor' : `Add Visitors (${totalPeople})`;
    }
  };

  const getAddButtonText = () => {
    if (isEditingVisitor) {
      return 'Save Changes';
    } else {
      const totalPeople = visitorForm.persons.length;
      return totalPeople === 1 ? 'Add Visitor' : 'Add Visitors';
    }
  };

  const handleSubmit = async () => {
    if (isAttendanceLocked) {
      setError('Editing locked for attendance takers for services older than 2 weeks');
      return;
    }
    if (!selectedGathering) return;
    if (isSubmittingVisitor) return;

    setIsSubmittingVisitor(true);
    try {
      // Validate form
      for (const person of visitorForm.persons) {
        if (!person.firstName.trim()) {
          setError('First name is required for all persons');
          return;
        }
      }

      const people = visitorForm.persons.map(person => ({
        firstName: person.firstName.trim(),
        lastName: person.lastName.trim(),
        firstUnknown: false,
        lastUnknown: !person.lastName.trim(),
        isChild: false
      }));

      const notes = visitorForm.notes.trim();
      let response;

      if (isEditingVisitor && editingVisitorData) {
        // Edit existing visitor family
        const familyName = visitorForm.familyName.trim() || generateFamilyName(convertToUtilityFormat(people)) || 'Visitor Family';

        if (familyName) {
          await familiesAPI.update(editingVisitorData.familyId, {
            familyName,
            familyType: visitorForm.personType
          });
        } else {
          await familiesAPI.update(editingVisitorData.familyId, {
            familyType: visitorForm.personType
          });
        }

        const personType = visitorForm.personType === 'local_visitor' ? 'local_visitor' : 'traveller_visitor';

        const allIndividualsResponse = await individualsAPI.getAll();
        const allIndividuals = allIndividualsResponse.data.people || [];
        const familyMembers = allIndividuals.filter((ind: any) => ind.familyId === editingVisitorData.familyId);

        const updatePromises = familyMembers.map(async (member: any, index: number) => {
          const formPerson = people[index];
          return individualsAPI.update(member.id, {
            firstName: formPerson ? formPerson.firstName : member.firstName,
            lastName: formPerson ? formPerson.lastName : member.lastName,
            familyId: editingVisitorData.familyId,
            peopleType: personType
          });
        });

        await Promise.all(updatePromises);

        const newPeopleCount = people.length - familyMembers.length;
        let createdIndividuals: any[] = [];

        if (newPeopleCount > 0) {
          const newPeople = people.slice(familyMembers.length);
          const createPromises = newPeople.map(async (person) => {
            return individualsAPI.create({
              firstName: person.firstName,
              lastName: person.lastName,
              familyId: editingVisitorData.familyId,
              peopleType: personType
            });
          });

          const createResults = await Promise.all(createPromises);
          createdIndividuals = createResults.map(r => r.data);

          if (selectedGathering && selectedDate) {
            const addToServicePromises = createdIndividuals.map(async (individual) => {
              return attendanceAPI.addIndividualToService(
                selectedGathering.id,
                selectedDate,
                individual.id
              );
            });
            await Promise.all(addToServicePromises);
          }
        }

        const totalMembers = familyMembers.length + createdIndividuals.length;

        if (newPeopleCount > 0) {
          await onSuccess(`Visitor family updated: ${newPeopleCount} new member${newPeopleCount !== 1 ? 's' : ''} added (${totalMembers} total)`);
        } else {
          await onSuccess(`Visitor family updated successfully (${totalMembers} member${totalMembers !== 1 ? 's' : ''})`);
        }
      } else {
        // Create new visitor family
        const familyName = visitorForm.familyName.trim() || generateFamilyName(convertToUtilityFormat(people)) || 'Visitor Family';

        const familyResponse = await familiesAPI.createVisitorFamily({
          familyName,
          peopleType: visitorForm.personType,
          notes: notes ? notes : undefined,
          people
        });

        response = await attendanceAPI.addVisitorFamilyToService(
          selectedGathering.id,
          selectedDate,
          familyResponse.data.familyId
        );

        if (response.data.individuals && response.data.individuals.length > 0) {
          const names = response.data.individuals.map((ind: { firstName: string; lastName: string }) => `${ind.firstName} ${ind.lastName}`).join(', ');
          await onSuccess(`Added as visitor family: ${names}`);
        } else {
          await onSuccess('Added successfully');
        }
      }

      // Reload attendance data
      setAttendanceRefreshTrigger(prev => prev + 1);

      if (selectedGathering) {
        try {
          const recentResponse = await attendanceAPI.getRecentVisitors(selectedGathering.id);
          setRecentVisitors(recentResponse.data.visitors || []);
          setAllRecentVisitorsPool(recentResponse.data.visitors || []);

          const allPeopleResponse = await attendanceAPI.getAllPeople();
          setAllChurchVisitors(allPeopleResponse.data.visitors || []);

          logger.log('✅ Refreshed all visitor data after visitor operation');
        } catch (refreshErr) {
          logger.warn('⚠️ Failed to refresh some visitor data:', refreshErr);
        }
      }

      // Reset form
      setVisitorForm({
        personType: 'local_visitor',
        notes: '',
        persons: [{
          firstName: '',
          lastName: '',
          fillLastNameFromAbove: false
        }],
        autoFillSurname: false,
        familyName: ''
      });

      onClose();
      setError('');
    } catch (err: any) {
      console.error('Failed to save visitor:', err);
      setError(err.response?.data?.error || 'Failed to save visitor');
    } finally {
      setIsSubmittingVisitor(false);
    }
  };

  if (!isOpen || selectedGathering?.attendanceType !== 'standard') return null;

  return createPortal(
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
      <div className="flex items-center justify-center min-h-screen p-4">
        <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">
              {getAddModalTitle()}
            </h3>
            <button
              disabled={isSubmittingVisitor}
              onClick={() => {
                onClose();
                setError('');
              }}
              className="text-gray-400 hover:text-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}

          <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="space-y-4">
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
                      value="local_visitor"
                      checked={visitorForm.personType === 'local_visitor'}
                      onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'local_visitor' | 'traveller_visitor' })}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                    />
                    <span className="ml-2 text-sm text-gray-900">Local Visitor</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="personType"
                      value="traveller_visitor"
                      checked={visitorForm.personType === 'traveller_visitor'}
                      onChange={(e) => setVisitorForm({ ...visitorForm, personType: e.target.value as 'local_visitor' | 'traveller_visitor' })}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                    />
                    <span className="ml-2 text-sm text-gray-900">Traveller Visitor</span>
                  </label>
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
              {visitorForm.persons.map((person, index) => (
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
                      disabled={index > 0 && person.fillLastNameFromAbove}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                      placeholder="Last name (optional)"
                    />
                    <div className="flex flex-col space-y-1 mt-1">
                      {index > 0 && (
                        <div className="flex items-center">
                          <input
                            id={`personFillLastName-${index}`}
                            type="checkbox"
                            checked={person.fillLastNameFromAbove}
                            onChange={(e) => updatePerson(index, { fillLastNameFromAbove: e.target.checked })}
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
            {visitorForm.persons.length < 10 && (
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

            {/* Notes field */}
            {(visitorForm.personType === 'local_visitor' || visitorForm.personType === 'traveller_visitor') && (
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
            )}

            {/* Family Name Display/Edit */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Family Name
              </label>
              {isEditingVisitor ? (
                <>
                  <input
                    type="text"
                    value={visitorForm.familyName}
                    onChange={(e) => setVisitorForm({ ...visitorForm, familyName: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Family name"
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    Edit the family name if needed, or leave as is.
                  </p>
                </>
              ) : (
                <>
                  <div className="mt-1 p-3 bg-gray-50 border border-gray-200 rounded-md">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-900 font-medium">
                        {computedVisitorFamilyName || 'Enter family member names above'}
                      </span>
                      {computedVisitorFamilyName && (
                        <span className="text-xs text-green-600 bg-green-100 px-2 py-1 rounded">
                          Auto-generated
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-sm text-gray-500">
                    Family name is automatically generated from the member names above.
                  </p>
                </>
              )}
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                disabled={isSubmittingVisitor}
                onClick={() => {
                  onClose();
                  setError('');
                }}
                className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmittingVisitor}
                className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmittingVisitor ? (
                  <span className="flex items-center">
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Saving...
                  </span>
                ) : (
                  getAddButtonText()
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AddVisitorModal;
