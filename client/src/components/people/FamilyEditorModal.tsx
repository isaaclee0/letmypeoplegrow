import React from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';

interface Person {
  id: number;
  firstName: string;
  lastName: string;
  familyId?: number;
}

interface FamilyEditorData {
  familyId: number;
  familyName: string;
  familyType: 'regular' | 'local_visitor' | 'traveller_visitor';
  memberIds: number[];
  addMemberQuery: string;
}

interface FamilyEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  familyEditor: FamilyEditorData;
  setFamilyEditor: React.Dispatch<React.SetStateAction<FamilyEditorData>>;
  people: Person[];
  onSave: () => Promise<void>;
  error?: string;
  isLoading?: boolean;
}

const FamilyEditorModal: React.FC<FamilyEditorModalProps> = ({
  isOpen,
  onClose,
  familyEditor,
  setFamilyEditor,
  people,
  onSave,
  error,
  isLoading = false
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
      <div className="flex items-center justify-center min-h-screen p-4">
        <div className="relative w-11/12 md:w-2/3 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Edit Family</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}

          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700">Family Name</label>
                <input 
                  type="text" 
                  value={familyEditor.familyName} 
                  onChange={(e) => setFamilyEditor(d => ({ ...d, familyName: e.target.value }))} 
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" 
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Family Type</label>
                <select 
                  value={familyEditor.familyType} 
                  onChange={(e) => setFamilyEditor(d => ({ ...d, familyType: e.target.value as any }))} 
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="regular">Regular</option>
                  <option value="local_visitor">Local Visitor</option>
                  <option value="traveller_visitor">Traveller Visitor</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Members</label>
              <div className="flex items-center space-x-2 mb-2">
                <input 
                  list="people-options" 
                  value={familyEditor.addMemberQuery} 
                  onChange={(e) => setFamilyEditor(d => ({ ...d, addMemberQuery: e.target.value }))} 
                  placeholder="Search people by name" 
                  className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" 
                />
                <button 
                  onClick={() => {
                    const name = familyEditor.addMemberQuery.trim().toLowerCase();
                    if (!name) return;
                    const person = people.find(p => `${p.firstName} ${p.lastName}`.toLowerCase() === name);
                    if (person && !familyEditor.memberIds.includes(person.id)) {
                      setFamilyEditor(d => ({ ...d, memberIds: [...d.memberIds, person.id], addMemberQuery: '' }));
                    }
                  }} 
                  className="px-3 py-2 bg-primary-600 text-white rounded-md text-sm"
                >
                  Add
                </button>
              </div>
              <datalist id="people-options">
                {people.filter(p => !familyEditor.memberIds.includes(p.id)).map(p => (
                  <option key={p.id} value={`${p.firstName} ${p.lastName}`} />
                ))}
              </datalist>
              <div className="border border-gray-200 rounded-md p-3 max-h-64 overflow-y-auto">
                {familyEditor.memberIds.length === 0 ? (
                  <div className="text-sm text-gray-500">No members</div>
                ) : (
                  <div className="space-y-2">
                    {familyEditor.memberIds.map(id => {
                      const p = people.find(pp => pp.id === id);
                      if (!p) return null;
                      return (
                        <div key={id} className="flex items-center justify-between text-sm">
                          <span>{p.firstName} {p.lastName}</span>
                          <button 
                            onClick={() => setFamilyEditor(d => ({ ...d, memberIds: d.memberIds.filter(pid => pid !== id) }))} 
                            className="text-red-600 hover:text-red-800"
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="text-xs text-gray-500 mt-2">
                Adding a member will move them into this family. Removing will detach them from any family.
              </div>
            </div>

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

export default FamilyEditorModal;
