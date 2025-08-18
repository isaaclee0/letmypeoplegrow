import React, { useState, useCallback } from 'react';
import { XMarkIcon, PlusIcon } from '@heroicons/react/24/outline';
import PersonForm, { PersonFormData } from '../shared/PersonForm';
import FamilyNameInput from '../shared/FamilyNameInput';
import { generateFamilyName } from '../../utils/familyNameUtils';
import { validateMultiplePeople, validateCSVData } from '../../utils/validationUtils';

interface GatheringType {
  id: number;
  name: string;
}

interface AddPeopleModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'person' | 'csv' | 'copy-paste';
  setMode: (mode: 'person' | 'csv' | 'copy-paste') => void;
  gatheringTypes: GatheringType[];
  onSubmitPeople: (data: {
    familyMembers: PersonFormData[];
    familyName: string;
    selectedGatheringId?: number;
  }) => Promise<void>;
  onSubmitCSV: (data: {
    csvData: string;
    selectedGatheringId?: number;
  }) => Promise<void>;
  onSubmitCopyPaste: (data: {
    copyPasteData: string;
    selectedGatheringId?: number;
  }) => Promise<void>;
  error?: string;
  isLoading?: boolean;
}

const AddPeopleModal: React.FC<AddPeopleModalProps> = ({
  isOpen,
  onClose,
  mode,
  setMode,
  gatheringTypes,
  onSubmitPeople,
  onSubmitCSV,
  onSubmitCopyPaste,
  error,
  isLoading = false
}) => {
  const [familyMembers, setFamilyMembers] = useState<PersonFormData[]>([
    { firstName: '', lastName: '' }
  ]);
  const [familyName, setFamilyName] = useState('');
  const [useSameSurname, setUseSameSurname] = useState(false);
  const [csvData, setCsvData] = useState('');
  const [copyPasteData, setCopyPasteData] = useState('');
  const [selectedGatheringId, setSelectedGatheringId] = useState<number | null>(null);

  const addFamilyMember = () => {
    const newMember: PersonFormData = { firstName: '', lastName: '' };
    if (useSameSurname && familyMembers.length > 0 && familyMembers[0].lastName) {
      newMember.lastName = familyMembers[0].lastName;
    }
    setFamilyMembers([...familyMembers, newMember]);
  };

  const removeFamilyMember = (index: number) => {
    if (familyMembers.length > 1) {
      setFamilyMembers(familyMembers.filter((_, i) => i !== index));
    }
  };

  const updateFamilyMember = useCallback((index: number, updates: Partial<PersonFormData>) => {
    const updatedMembers = [...familyMembers];
    updatedMembers[index] = { ...updatedMembers[index], ...updates };
    
    // Auto-fill surnames if enabled
    if (updates.lastName && useSameSurname && index === 0) {
      updatedMembers.forEach((member, i) => {
        if (i > 0) {
          member.lastName = updates.lastName!;
        }
      });
    }
    
    setFamilyMembers(updatedMembers);
  }, [familyMembers, useSameSurname]);

  const handleUseSameSurnameChange = (checked: boolean) => {
    setUseSameSurname(checked);
    if (checked && familyMembers[0]?.lastName) {
      const updatedMembers = familyMembers.map((member, i) => 
        i === 0 ? member : { ...member, lastName: familyMembers[0].lastName }
      );
      setFamilyMembers(updatedMembers);
    }
  };

  const handleSubmit = async () => {
    if (mode === 'person') {
      const validation = validateMultiplePeople(familyMembers);
      if (!validation.isValid) {
        return; // PersonForm components will show individual errors
      }
      
      await onSubmitPeople({
        familyMembers,
        familyName,
        selectedGatheringId: selectedGatheringId || undefined
      });
    } else if (mode === 'csv') {
      const validation = validateCSVData(csvData);
      if (!validation.isValid) {
        return; // Error will be shown by parent
      }
      
      await onSubmitCSV({
        csvData,
        selectedGatheringId: selectedGatheringId || undefined
      });
    } else if (mode === 'copy-paste') {
      const validation = validateCSVData(copyPasteData);
      if (!validation.isValid) {
        return; // Error will be shown by parent
      }
      
      await onSubmitCopyPaste({
        copyPasteData,
        selectedGatheringId: selectedGatheringId || undefined
      });
    }
  };

  const handleClose = () => {
    // Reset form state
    setFamilyMembers([{ firstName: '', lastName: '' }]);
    setFamilyName('');
    setUseSameSurname(false);
    setCsvData('');
    setCopyPasteData('');
    setSelectedGatheringId(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
      <div className="flex items-center justify-center min-h-screen p-4">
        <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">
              {mode === 'person' && 'Add New People'}
              {mode === 'csv' && 'Upload CSV File'}
              {mode === 'copy-paste' && 'Copy & Paste Data'}
            </h3>
            <button onClick={handleClose} className="text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          {/* Mode Selection Tabs */}
          <div className="border-b border-gray-200 mb-6">
            <nav className="hidden md:flex -mb-px space-x-2 items-center" aria-label="Tabs">
              <button
                onClick={() => setMode('person')}
                className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                  mode === 'person'
                    ? 'bg-primary-500 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                Add People
              </button>
              <button
                onClick={() => setMode('csv')}
                className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                  mode === 'csv'
                    ? 'bg-primary-500 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                CSV Upload
              </button>
              <button
                onClick={() => setMode('copy-paste')}
                className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                  mode === 'copy-paste'
                    ? 'bg-primary-500 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                Copy & Paste
              </button>
            </nav>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}

          {/* Person Form */}
          {mode === 'person' && (
            <div className="space-y-6">
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-gray-700">Family Members</h4>
                
                {familyMembers.map((member, index) => (
                  <PersonForm
                    key={index}
                    person={member}
                    index={index}
                    showRemove={familyMembers.length > 1}
                    autoFillLastName={useSameSurname && index > 0}
                    lastNameFromAbove={familyMembers[0]?.lastName}
                    onUpdate={updateFamilyMember}
                    onRemove={removeFamilyMember}
                  />
                ))}
                
                {/* Same Surname Checkbox */}
                {familyMembers.length > 1 && (
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={useSameSurname}
                      onChange={(e) => handleUseSameSurnameChange(e.target.checked)}
                      disabled={!familyMembers[0]?.lastName?.trim()}
                      className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <span className={`text-sm ${!familyMembers[0]?.lastName?.trim() ? 'text-gray-400' : 'text-gray-700'}`}>
                      Use same surname for all family members
                    </span>
                  </div>
                )}
                
                {/* Add Another Family Member Button */}
                <button
                  type="button"
                  onClick={addFamilyMember}
                  className="w-full py-2 px-4 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-gray-400 hover:text-gray-700 transition-colors flex items-center justify-center space-x-2"
                >
                  <PlusIcon className="h-4 w-4" />
                  <span>Add Another Family Member</span>
                </button>
              </div>

              <FamilyNameInput
                value={familyName}
                onChange={setFamilyName}
                people={familyMembers}
                autoGenerate={true}
                required={true}
                helpText="Family name will be auto-generated from member names"
              />
            </div>
          )}

          {/* CSV Upload Form */}
          {mode === 'csv' && (
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
                  <label className="block text-sm font-medium text-gray-700 mb-2">Preview</label>
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
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p>Expected CSV format:</p>
                  <a
                    href="/api/csv-import/template"
                    className="ml-4 inline-flex items-center text-primary-600 hover:text-primary-700 font-medium"
                  >
                    Download template
                  </a>
                </div>
                <pre className="font-mono text-xs mt-1 bg-gray-50 p-2 rounded border border-gray-200 whitespace-pre-wrap break-words overflow-x-auto">
{`FIRST NAME,LAST NAME,FAMILY NAME
John,Smith,"Smith, John and Sarah"
Sarah,Smith,"Smith, John and Sarah"`}
                </pre>
              </div>
            </div>
          )}

          {/* Copy & Paste Form */}
          {mode === 'copy-paste' && (
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
                <pre className="font-mono text-xs mt-1 bg-gray-50 p-2 rounded border border-gray-200 whitespace-pre-wrap break-words overflow-x-auto">
{`FIRST NAME  LAST NAME  FAMILY NAME
John        Smith      Smith, John and Sarah
Sarah       Smith      Smith, John and Sarah`}
                </pre>
                <p className="mt-2 text-xs">
                  Copy rows from Excel/Google Sheets with columns: FIRST NAME, LAST NAME, FAMILY NAME.
                </p>
              </div>
            </div>
          )}

          {/* Gathering Assignment (for all modes) */}
          {(mode === 'csv' || mode === 'copy-paste') && (
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
          )}
          
          <div className="flex justify-end space-x-3 pt-4">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isLoading || (mode === 'csv' && !csvData) || (mode === 'copy-paste' && !copyPasteData)}
              className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
            >
              {isLoading ? 'Processing...' : 
               mode === 'person' ? 'Add People' :
               mode === 'csv' ? 'Upload' : 'Process Data'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AddPeopleModal;
