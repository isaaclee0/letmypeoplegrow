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

interface MassEditData {
  familyInput: string;
  selectedFamilyId: number | null;
  newFamilyName: string;
  firstName: string;
  lastName: string;
  peopleType: '' | 'regular' | 'local_visitor' | 'traveller_visitor';
  assignments: { [key: number]: boolean };
  originalAssignments: { [key: number]: Set<number> };
  applyToWholeFamily: boolean;
}

interface MassEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedCount: number;
  massEdit: MassEditData;
  setMassEdit: React.Dispatch<React.SetStateAction<MassEditData>>;
  families: Family[];
  gatheringTypes: GatheringType[];
  onSave: () => Promise<void>;
  error?: string;
  isLoading?: boolean;
}

const MassEditModal: React.FC<MassEditModalProps> = ({
  isOpen,
  onClose,
  selectedCount,
  massEdit,
  setMassEdit,
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
        <div className="relative w-11/12 md:w-2/3 lg:w-1/2 max-w-3xl p-5 border shadow-lg rounded-md bg-white">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">
              {selectedCount === 1 ? 'Edit Person' : `Edit ${selectedCount} Selected`}
            </h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>
          
          {/* Summary of what will be changed */}
          <div className="bg-blue-50 border border-blue-200 rounded-md p-3 mb-4">
            <div className="text-sm text-blue-800">
              <strong>Summary:</strong> Only fields with values will be updated. Leave fields blank to keep current values.
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}

          <div className="space-y-4">
            {/* Show firstName field only when editing single person */}
            {selectedCount === 1 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">First Name</label>
                  <input 
                    type="text" 
                    value={massEdit.firstName} 
                    onChange={(e) => setMassEdit(d => ({ ...d, firstName: e.target.value }))} 
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" 
                    placeholder="Enter first name" 
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Last Name</label>
                  <input 
                    type="text" 
                    value={massEdit.lastName} 
                    onChange={(e) => setMassEdit(d => ({ ...d, lastName: e.target.value }))} 
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" 
                    placeholder="Leave blank to keep current last name" 
                  />
                </div>
              </div>
            )}

            {/* Show bulk last name field for multiple people */}
            {selectedCount > 1 && (
              <div>
                <label className="block text-sm font-medium text-gray-700">Last Name</label>
                <input 
                  type="text" 
                  value={massEdit.lastName} 
                  onChange={(e) => setMassEdit(d => ({ ...d, lastName: e.target.value }))} 
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" 
                  placeholder="Leave blank to keep current last names" 
                />
                <div className="text-xs text-gray-500 mt-1">Enter a last name to set it for all selected people</div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700">Family</label>
              <input 
                list="family-options" 
                value={massEdit.familyInput} 
                onChange={(e) => {
                  const value = e.target.value;
                  const match = families.find(f => f.familyName.toLowerCase() === value.toLowerCase());
                  setMassEdit(d => ({ ...d, familyInput: value, selectedFamilyId: match ? match.id : null, newFamilyName: match ? '' : value }));
                }} 
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" 
                placeholder="Search or type to create new family" 
              />
              <datalist id="family-options">
                {families.map(f => (
                  <option key={f.id} value={f.familyName} />
                ))}
              </datalist>
              <div className="text-xs text-gray-500 mt-1">
                Leave blank to keep existing families. Enter family name to move all selected to that family.
              </div>
              
              {/* Apply to whole family checkbox */}
              <label className="flex items-center space-x-2 text-sm mt-2">
                <input 
                  type="checkbox" 
                  checked={massEdit.applyToWholeFamily} 
                  onChange={(e) => setMassEdit(d => ({ ...d, applyToWholeFamily: e.target.checked }))} 
                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500" 
                />
                <span>Apply to entire family</span>
              </label>
              <div className="text-xs text-gray-500 mt-1">
                When checked, changes will affect all family members, even those not selected
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">People Type</label>
              <select 
                value={massEdit.peopleType} 
                onChange={(e) => setMassEdit(d => ({ ...d, peopleType: e.target.value as any }))} 
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="">Do not change</option>
                <option value="regular">Regular</option>
                <option value="local_visitor">Local Visitor</option>
                <option value="traveller_visitor">Traveller Visitor</option>
              </select>
              <div className="text-xs text-gray-500 mt-1">Select a type to change all selected people to that type</div>
            </div>

            {gatheringTypes.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">Gathering Assignments</label>
                  <div className="text-xs text-gray-500">
                    Checked = Add to all selected, Unchecked = Remove from all selected
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {gatheringTypes.map(g => (
                    <label key={g.id} className="flex items-center space-x-2 text-sm">
                      <input 
                        type="checkbox" 
                        checked={!!massEdit.assignments[g.id]} 
                        onChange={() => setMassEdit(d => ({ ...d, assignments: { ...d.assignments, [g.id]: !d.assignments[g.id] } }))} 
                        className="rounded border-gray-300 text-primary-600 focus:ring-primary-500" 
                      />
                      <span>{g.name}</span>
                    </label>
                  ))}
                </div>
                <div className="text-xs text-gray-500">
                  Changes will be applied to all selected people. Checked gatherings will be added, unchecked will be removed.
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
                {isLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MassEditModal;
