import React, { useState, useEffect, useMemo } from 'react';
import { XMarkIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { Individual } from '../../services/api';
import { useBadgeSettings } from '../../hooks/useBadgeSettings';
import BadgeIcon from '../icons/BadgeIcon';
import Modal from '../Modal';

interface LeaderCheckInModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedPeople: Individual[];
  action: 'checkin' | 'checkout';
  onConfirm: (signerName: string) => Promise<void>;
}

const LeaderCheckInModal: React.FC<LeaderCheckInModalProps> = ({
  isOpen,
  onClose,
  selectedPeople,
  action,
  onConfirm,
}) => {
  const [signerName, setSignerName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const { getBadgeInfo } = useBadgeSettings();

  const hasChildren = useMemo(() => selectedPeople.some(p => p.isChild), [selectedPeople]);

  const uniqueFamilyNotes = useMemo(() => {
    const seen = new Set<string>();
    const notes: Array<{ familyName: string; notes: string }> = [];
    for (const person of selectedPeople) {
      if (person.familyNotes && person.familyName && !seen.has(person.familyName)) {
        seen.add(person.familyName);
        notes.push({ familyName: person.familyName, notes: person.familyNotes });
      }
    }
    return notes;
  }, [selectedPeople]);

  const [showNotes, setShowNotes] = useState(uniqueFamilyNotes.length > 0);

  // Expand notes by default when modal opens with family notes
  useEffect(() => {
    if (uniqueFamilyNotes.length > 0) {
      setShowNotes(true);
    }
  }, [uniqueFamilyNotes.length]);

  const handleSubmit = async () => {
    if (hasChildren && !signerName.trim()) {
      setError('Please enter the authorised person\'s name.');
      return;
    }
    try {
      setIsSubmitting(true);
      setError('');
      await onConfirm(signerName.trim() || '');
      setSignerName('');
      setShowNotes(false);
    } catch (err: any) {
      setError(err.message || 'Failed to process check-in.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isCheckin = action === 'checkin';
  const title = isCheckin
    ? `Check In ${selectedPeople.length} ${selectedPeople.length === 1 ? 'Person' : 'People'}`
    : `Check Out ${selectedPeople.length} ${selectedPeople.length === 1 ? 'Person' : 'People'}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">{title}</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          <div className="space-y-4">
            {/* Selected people list */}
            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">Selected:</p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {selectedPeople.map(person => {
                  const badge = getBadgeInfo(person);
                  return (
                    <div key={person.id} className="flex items-center text-sm text-gray-800">
                      <span className="mr-1">&bull;</span>
                      <span>{person.firstName} {person.lastName}</span>
                      {badge && (
                        <span
                          className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs font-medium"
                          style={badge.styles}
                        >
                          {badge.icon && <BadgeIcon icon={badge.icon} size={12} />}
                          {badge.text && <span>{badge.text}</span>}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Signer name — only required when children are being checked in/out */}
            {hasChildren && (
              <div>
                <label htmlFor="leader-signer-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Authorised person name <span className="text-red-500">*</span>
                </label>
                <input
                  id="leader-signer-name"
                  type="text"
                  value={signerName}
                  onChange={(e) => { setSignerName(e.target.value); setError(''); }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                  className="block w-full border-gray-300 rounded-lg shadow-sm focus:ring-primary-500 focus:border-primary-500 px-3 py-2"
                  placeholder="Name of person authorising this action..."
                  autoFocus
                  autoComplete="off"
                />
              </div>
            )}

            {/* Family notes (expandable) */}
            {uniqueFamilyNotes.length > 0 && (
              <div>
                <button
                  onClick={() => setShowNotes(!showNotes)}
                  className="flex items-center text-sm font-medium text-gray-700 hover:text-gray-900"
                >
                  {showNotes ? (
                    <ChevronUpIcon className="h-4 w-4 mr-1" />
                  ) : (
                    <ChevronDownIcon className="h-4 w-4 mr-1" />
                  )}
                  Family Notes
                </button>
                {showNotes && (
                  <div className="mt-2 p-3 bg-white border border-gray-300 rounded-lg text-sm">
                    {uniqueFamilyNotes.map((note, idx) => (
                      <div key={idx} className={idx > 0 ? 'mt-2 pt-2 border-t border-gray-200' : ''}>
                        <span className="text-gray-800 whitespace-pre-wrap">{note.notes}</span>
                        <p className="text-xs text-gray-400 mt-0.5">{note.familyName}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {error && (
              <p className="text-sm text-red-600">{error}</p>
            )}
          </div>

          <div className="mt-6 flex space-x-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || (hasChildren && !signerName.trim())}
              className={`flex-1 px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white disabled:opacity-50 disabled:cursor-not-allowed ${
                isCheckin
                  ? 'bg-primary-600 hover:bg-primary-700'
                  : 'bg-orange-500 hover:bg-orange-600'
              }`}
            >
              {isSubmitting ? 'Processing...' : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default LeaderCheckInModal;
