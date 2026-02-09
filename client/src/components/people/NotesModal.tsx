import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { familiesAPI } from '../../services/api';

interface Family {
  id: number;
  familyId: number;
  familyName: string;
  familyNotes?: string;
}

interface NotesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (message: string, updatedFamily: { id: number; familyNotes: string }) => Promise<void>;
  family: Family | null;
}

const NotesModal: React.FC<NotesModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  family
}) => {
  const [currentNotes, setCurrentNotes] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Update currentNotes when family changes
  useEffect(() => {
    if (family) {
      setCurrentNotes(family.familyNotes || '');
    }
  }, [family]);

  const handleSaveNotes = async () => {
    if (!family) return;

    try {
      setIsLoading(true);
      setError('');

      await familiesAPI.update(family.familyId, {
        familyNotes: currentNotes
      });

      await onSuccess('Family notes updated successfully', {
        id: family.familyId,
        familyNotes: currentNotes
      });

      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update family notes');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen || !family) return null;

  return createPortal(
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-1/2 shadow-lg rounded-md bg-white">
        <div className="mt-3">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">
              Family Notes: {family.familyName}
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}

          <div className="mb-4">
            <label htmlFor="familyNotes" className="block text-sm font-medium text-gray-700 mb-2">
              Notes
            </label>
            <textarea
              id="familyNotes"
              rows={6}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              placeholder="Add notes about this family..."
              value={currentNotes}
              onChange={(e) => setCurrentNotes(e.target.value)}
            />
          </div>

          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              onClick={handleSaveNotes}
              disabled={isLoading}
              className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
            >
              {isLoading ? 'Saving...' : 'Save Notes'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default NotesModal;
