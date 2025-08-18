import React from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';

interface Family {
  id: number;
  familyName: string;
}

interface GatheringType {
  id: number;
  name: string;
}

interface PersonEditorData {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  familyInput: string;
  selectedFamilyId: number | null;
  newFamilyName: string;
  assignments: { [key: number]: boolean };
  originalAssignments: Set<number>;
}

interface PersonEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  personEditorData: PersonEditorData;
  setPersonEditorData: React.Dispatch<React.SetStateAction<PersonEditorData>>;
  families: Family[];
  gatheringTypes: GatheringType[];
  onSave: () => Promise<void>;
  error?: string;
  isLoading?: boolean;
}

const PersonEditorModal: React.FC<PersonEditorModalProps> = ({
  isOpen,
  onClose,
  personEditorData,
  setPersonEditorData,
  families,
  gatheringTypes,
  onSave,
  error,
  isLoading = false
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
      <div className="flex items-center justify-center min-h-screen p-4">
        <div className="relative w-11/12 md:w-1/2 lg:w-1/3 max-w-xl p-5 border shadow-lg rounded-md bg-white">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Edit Person</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-2 mb-3 text-sm text-red-700">{error}</div>
          )}

          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700">First Name *</label>
                <input 
                  type="text" 
                  value={personEditorData.firstName} 
                  onChange={(e) => setPersonEditorData(d => ({ ...d, firstName: e.target.value }))} 
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" 
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Last Name *</label>
                <input 
                  type="text" 
                  value={personEditorData.lastName} 
                  onChange={(e) => setPersonEditorData(d => ({ ...d, lastName: e.target.value }))} 
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" 
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Family</label>
              <input 
                list="family-options" 
                value={personEditorData.familyInput} 
                onChange={(e) => {
                  const value = e.target.value;
                  const match = families.find(f => f.familyName.toLowerCase() === value.toLowerCase());
                  setPersonEditorData(d => ({ ...d, familyInput: value, selectedFamilyId: match ? match.id : null, newFamilyName: match ? '' : value }));
                }} 
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" 
                placeholder="Search or type to create new" 
              />
              <datalist id="family-options">
                {families.map(f => (
                  <option key={f.id} value={f.familyName} />
                ))}
              </datalist>
              <div className="text-xs text-gray-500 mt-1">Leave blank for no family</div>
            </div>

            {gatheringTypes.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700">Gathering Assignments</label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-1">
                  {gatheringTypes.map(g => (
                    <label key={g.id} className="flex items-center space-x-2 text-sm">
                      <input 
                        type="checkbox" 
                        checked={!!personEditorData.assignments[g.id]} 
                        onChange={() => setPersonEditorData(d => ({ ...d, assignments: { ...d.assignments, [g.id]: !d.assignments[g.id] } }))} 
                        className="rounded border-gray-300 text-primary-600 focus:ring-primary-500" 
                      />
                      <span>{g.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end space-x-3 pt-2">
              <button 
                onClick={onClose} 
                className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                disabled={isLoading}
              >
                Cancel
              </button>
              <button 
                onClick={onSave} 
                className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                disabled={isLoading}
              >
                {isLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PersonEditorModal;
