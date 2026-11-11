import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { individualsAPI, familiesAPI } from '../../services/api';

interface Person {
  id: number;
  firstName: string;
  lastName: string;
  familyName?: string;
  planningCenterId?: string;
  externalLinks?: { planning_center?: string; elvanto?: string };
}

interface Family {
  id: number;
  familyName: string;
  memberCount: number;
}

interface MergeData {
  familyName: string;
  familyType: 'regular' | 'local_visitor' | 'traveller_visitor';
  mergeAssignments: boolean;
  keepFamilyId: number | null;
  mergeFamilyIds: number[];
}

interface MergeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (message: string) => Promise<void>;
  mergeMode: 'individuals' | 'families' | 'deduplicate';
  selectedPeople: number[];
  people: Person[];
  families: Family[];
}

const MergeModal: React.FC<MergeModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  mergeMode,
  selectedPeople,
  people,
  families
}) => {
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [dedupeKeepId, setDedupeKeepId] = useState<number | null>(null);
  const [mergeData, setMergeData] = useState<MergeData>({
    familyName: '',
    familyType: 'regular',
    mergeAssignments: true,
    keepFamilyId: null,
    mergeFamilyIds: []
  });

  useEffect(() => {
    if (!isOpen) {
      setDedupeKeepId(null);
      setError('');
    }
  }, [isOpen]);

  const selectedRecords = people.filter(person => selectedPeople.includes(person.id));
  const retainedPerson = selectedRecords.find(person => person.id === dedupeKeepId);
  const providerConflict = (['planning_center', 'elvanto'] as const).find(provider => {
    const identities = new Set(selectedRecords.flatMap(person => [
      person.externalLinks?.[provider],
      ...(provider === 'planning_center' ? [person.planningCenterId] : []),
    ]).filter(Boolean));
    return identities.size > 1;
  });
  const conflictMessage = providerConflict
    ? `These records link to different ${providerConflict === 'planning_center' ? 'Planning Center' : 'Elvanto'} people. Correct the provider links in sync review before merging.`
    : '';

  const handleMergeIndividuals = async () => {
    try {
      setIsLoading(true);
      setError('');

      if (!mergeData.familyName.trim()) {
        setError('Family name is required');
        return;
      }

      await familiesAPI.mergeIndividuals({
        individualIds: selectedPeople,
        familyName: mergeData.familyName.trim(),
        familyType: mergeData.familyType,
        mergeAssignments: mergeData.mergeAssignments
      });

      await onSuccess(`Successfully merged ${selectedPeople.length} individuals into family "${mergeData.familyName}"`);
      onClose();
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

      await familiesAPI.merge({
        keepFamilyId: mergeData.keepFamilyId,
        mergeFamilyIds: mergeData.mergeFamilyIds,
        newFamilyName: mergeData.familyName.trim() || undefined,
        newFamilyType: mergeData.familyType
      });

      await onSuccess(`Successfully merged ${mergeData.mergeFamilyIds.length} families`);
      onClose();
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

      if (!retainedPerson || conflictMessage) {
        setError(conflictMessage || 'Choose the record to keep before merging.');
        return;
      }
      const keepId = retainedPerson.id;
      const deleteIds = selectedPeople.filter(id => id !== keepId);

      await individualsAPI.deduplicate({
        keepId,
        deleteIds,
        mergeAssignments: mergeData.mergeAssignments
      });

      await onSuccess(`Kept ${retainedPerson.firstName} ${retainedPerson.lastName} (ID: ${keepId}) and merged ${deleteIds.length} duplicate record(s), preserving attendance history.`);
      onClose();
      setDedupeKeepId(null);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to deduplicate individuals');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-[9999]">
      <div className="flex items-center justify-center min-h-screen p-4">
        <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white dark:bg-gray-800">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
              {mergeMode === 'individuals' ? 'Merge Individuals into Family' :
               mergeMode === 'families' ? 'Merge Families' : 'Merge duplicate people'}
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          {(error || (mergeMode === 'deduplicate' && conflictMessage)) && (
            <div role="alert" className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4 mb-4">
              <div className="text-sm text-red-700 dark:text-red-400">{error || conflictMessage}</div>
            </div>
          )}

          <div className="space-y-6">
            {mergeMode === 'individuals' ? (
              <>
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                    Merge {selectedPeople.length} selected individuals into a new family. This is useful when people get married or need to be grouped together.
                  </p>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Family Name *
                      </label>
                      <input
                        type="text"
                        value={mergeData.familyName}
                        onChange={(e) => setMergeData({...mergeData, familyName: e.target.value})}
                        className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="Enter family name"
                        required
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Family Type
                      </label>
                      <select
                        value={mergeData.familyType}
                        onChange={(e) => setMergeData({...mergeData, familyType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor'})}
                        className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
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
                        className="rounded border-gray-300 dark:border-gray-500 text-primary-600 focus:ring-primary-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        Merge gathering assignments from all individuals
                      </span>
                    </div>
                  </div>
                </div>
              </>
            ) : mergeMode === 'families' ? (
              <>
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                    Merge families. Select which family to keep and which families to merge into it.
                  </p>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Keep Family
                      </label>
                      <select
                        value={mergeData.keepFamilyId || ''}
                        onChange={(e) => setMergeData({...mergeData, keepFamilyId: e.target.value ? parseInt(e.target.value) : null})}
                        className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
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
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        New Family Name (Optional)
                      </label>
                      <input
                        type="text"
                        value={mergeData.familyName}
                        onChange={(e) => setMergeData({...mergeData, familyName: e.target.value})}
                        className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="Leave blank to keep current name"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        New Family Type (Optional)
                      </label>
                      <select
                        value={mergeData.familyType}
                        onChange={(e) => setMergeData({...mergeData, familyType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor'})}
                        className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
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
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                    Merge {selectedPeople.length} records for the same person. Choose the record whose name, family and person ID you want to keep.
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                    All attendance history is preserved. If records overlap on a date and gathering, present wins and the person is counted once. Engagement history and compatible provider links are kept too.
                  </p>

                  <div className="space-y-4">
                    <div>
                      <label htmlFor="deduplicate-keep-record" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Record to keep</label>
                      <select
                        id="deduplicate-keep-record"
                        value={dedupeKeepId || ''}
                        onChange={(e) => setDedupeKeepId(e.target.value ? parseInt(e.target.value) : null)}
                        disabled={isLoading}
                        className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      >
                        <option value="">Select record to keep</option>
                        {selectedRecords.map(p => (
                          <option key={p.id} value={p.id}>
                            {p.firstName} {p.lastName}{p.familyName ? ` — Family: ${p.familyName}` : ''} (ID: {p.id})
                          </option>
                        ))}
                      </select>
                    </div>

                    {retainedPerson && <div className="rounded-md border border-primary-200 bg-primary-50 p-4 text-sm text-primary-900 dark:border-primary-800 dark:bg-primary-900/20 dark:text-primary-200">
                      <p className="font-medium">Keep {retainedPerson.firstName} {retainedPerson.lastName} (ID: {retainedPerson.id})</p>
                      <p className="mt-1">{retainedPerson.familyName ? `${retainedPerson.familyName} will stay as their family.` : 'They will stay without a family assignment.'}</p>
                      <p className="mt-2">Merge into this record: {selectedRecords.filter(person => person.id !== retainedPerson.id).map(person => `${person.firstName} ${person.lastName} (ID: ${person.id})`).join(', ')}.</p>
                    </div>}

                    <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-4">
                      <div className="flex">
                        <div className="text-sm text-yellow-700 dark:text-yellow-300">
                          <strong>Permanent merge:</strong> The {selectedPeople.length - 1} other record(s) will be deleted after their history is transferred. Use this only for records of the same person.
                        </div>
                      </div>
                    </div>

                    <label className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={mergeData.mergeAssignments}
                        onChange={(e) => setMergeData({...mergeData, mergeAssignments: e.target.checked})}
                        disabled={isLoading}
                        className="rounded border-gray-300 dark:border-gray-500 text-primary-600 focus:ring-primary-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        Also combine gathering assignments. Attendance history is kept either way.
                      </span>
                    </label>
                  </div>
                </div>
              </>
            )}

            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                onClick={mergeMode === 'individuals' ? handleMergeIndividuals :
                         mergeMode === 'families' ? handleMergeFamilies : handleDeduplicateIndividuals}
                disabled={(mergeMode === 'individuals' && !mergeData.familyName.trim())
                  || (mergeMode === 'deduplicate' && (!retainedPerson || selectedPeople.length < 2 || Boolean(conflictMessage))) || isLoading}
                className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
              >
                {isLoading ? 'Processing...' :
                 mergeMode === 'individuals' ? 'Merge Individuals' :
                 mergeMode === 'families' ? 'Merge Families' : 'Merge duplicate people'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default MergeModal;
