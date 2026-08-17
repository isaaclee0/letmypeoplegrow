import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { contactsAPI, familiesAPI, usersAPI } from '../../services/api';

interface FamilyCaregiver {
  id: number;
  caregiver_type: 'user' | 'contact';
  user_id?: number;
  contact_id?: number;
  first_name: string;
  last_name: string;
  email: string | null;
  mobile_number: string | null;
}

interface CaregiverSearchResult {
  type: 'user' | 'contact';
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
}

interface CaregiverPickerProps {
  familyId: number;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
}

const CaregiverPicker: React.FC<CaregiverPickerProps> = ({ familyId, open, onClose, onChanged }) => {
  const [caregivers, setCaregivers] = useState<FamilyCaregiver[]>([]);
  const [caregiverSearch, setCaregiverSearch] = useState('');
  const [allCaregiverOptions, setAllCaregiverOptions] = useState<CaregiverSearchResult[]>([]);
  const [caregiversLoading, setCaregiversLoading] = useState(false);
  const [caregiverOptionsLoading, setCaregiverOptionsLoading] = useState(false);

  const loadFamilyCaregivers = useCallback(async () => {
    setCaregiversLoading(true);
    try {
      setCaregivers(await familiesAPI.getCaregivers(familyId));
    } catch (error) {
      console.error('Failed to load family caregivers', error);
    } finally {
      setCaregiversLoading(false);
    }
  }, [familyId]);

  const loadCaregiverOptions = useCallback(async () => {
    if (allCaregiverOptions.length > 0) return;
    setCaregiverOptionsLoading(true);
    try {
      const [usersResponse, contacts] = await Promise.all([
        usersAPI.getAll(),
        contactsAPI.getAll(),
      ]);
      const users = (usersResponse as any).data?.users || [];
      setAllCaregiverOptions([
        ...users.map((user: any) => ({
          type: 'user' as const,
          id: user.id,
          first_name: user.firstName,
          last_name: user.lastName,
          email: user.email,
        })),
        ...contacts.map((contact: any) => ({
          type: 'contact' as const,
          id: contact.id,
          first_name: contact.first_name,
          last_name: contact.last_name,
          email: contact.email,
        })),
      ]);
    } catch (error) {
      console.error('Failed to load caregiver options', error);
    } finally {
      setCaregiverOptionsLoading(false);
    }
  }, [allCaregiverOptions.length]);

  useEffect(() => {
    if (!open) return;
    setCaregiverSearch('');
    loadFamilyCaregivers();
  }, [loadFamilyCaregivers, open]);

  useEffect(() => {
    if (!open) return;
    loadCaregiverOptions();
  }, [loadCaregiverOptions, open]);

  const filteredOptions = useMemo(() => {
    const query = caregiverSearch.toLowerCase();
    return allCaregiverOptions.filter((option) => (
      !query || `${option.first_name} ${option.last_name}`.toLowerCase().includes(query)
    ));
  }, [allCaregiverOptions, caregiverSearch]);

  const handleAddCaregiver = async (result: CaregiverSearchResult) => {
    try {
      await familiesAPI.assignCaregiver(familyId, {
        caregiver_type: result.type,
        user_id: result.type === 'user' ? result.id : undefined,
        contact_id: result.type === 'contact' ? result.id : undefined,
      });
      await loadFamilyCaregivers();
      await onChanged?.();
      onClose();
    } catch (error) {
      console.error('Failed to add caregiver', error);
    }
  };

  const handleRemoveCaregiver = async (caregiverId: number) => {
    try {
      await familiesAPI.removeCaregiver(familyId, caregiverId);
      await loadFamilyCaregivers();
      await onChanged?.();
    } catch (error) {
      console.error('Failed to remove caregiver', error);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="caregiver-picker-title"
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 id="caregiver-picker-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Caregivers
          </h3>
          <button
            type="button"
            aria-label="Close caregiver picker"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            ✕
          </button>
        </div>

        {caregiversLoading ? (
          <p className="mb-3 text-sm text-gray-400">Loading...</p>
        ) : caregivers.length === 0 ? (
          <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">No caregivers assigned.</p>
        ) : (
          <ul className="mb-3 space-y-2">
            {caregivers.map((caregiver) => (
              <li key={caregiver.id} className="flex items-center justify-between text-sm">
                <span className="text-gray-800 dark:text-gray-200">
                  {caregiver.first_name} {caregiver.last_name}
                  <span className="ml-1 text-xs text-gray-400">({caregiver.caregiver_type})</span>
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveCaregiver(caregiver.id)}
                  className="text-xs text-red-400 hover:text-red-600"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <label
            htmlFor="caregiver-filter"
            className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400"
          >
            Add caregiver
          </label>
          <input
            id="caregiver-filter"
            type="text"
            placeholder="Filter..."
            className="mb-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            value={caregiverSearch}
            onChange={(event) => setCaregiverSearch(event.target.value)}
            autoFocus
          />
          {caregiverOptionsLoading ? (
            <p className="py-2 text-center text-sm text-gray-400">Loading...</p>
          ) : (
            <ul className="max-h-48 overflow-y-auto rounded-md border border-gray-200 divide-y divide-gray-100 dark:border-gray-600 dark:divide-gray-700">
              {filteredOptions.map((result) => {
                const alreadyAssigned = caregivers.some((caregiver) => (
                  (result.type === 'user' && caregiver.user_id === result.id)
                  || (result.type === 'contact' && caregiver.contact_id === result.id)
                ));
                return (
                  <li key={`${result.type}-${result.id}`}>
                    <button
                      type="button"
                      onClick={() => !alreadyAssigned && handleAddCaregiver(result)}
                      disabled={alreadyAssigned}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                        alreadyAssigned
                          ? 'cursor-default text-gray-400 dark:text-gray-500'
                          : 'text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-600'
                      }`}
                    >
                      <span>{result.first_name} {result.last_name}</span>
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {alreadyAssigned ? 'assigned' : result.type}
                      </span>
                    </button>
                  </li>
                );
              })}
              {filteredOptions.length === 0 && (
                <li className="px-3 py-2 text-sm text-gray-400 dark:text-gray-500">No matches</li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default CaregiverPicker;
