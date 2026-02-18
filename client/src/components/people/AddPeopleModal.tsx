import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon, PlusIcon } from '@heroicons/react/24/outline';
import { individualsAPI, familiesAPI, csvImportAPI } from '../../services/api';
import { generateFamilyName } from '../../utils/familyNameUtils';
import logger from '../../utils/logger';

interface PersonForm {
  firstName: string;
  lastName: string;
  lastNameUnknown: boolean;
  fillLastNameFromAbove: boolean;
  isChild: boolean;
}

interface AddPeopleFormState {
  personType: 'regular' | 'local_visitor' | 'traveller_visitor';
  notes: string;
  persons: PersonForm[];
  selectedGatherings: { [key: number]: boolean };
}

interface GatheringType {
  id: number;
  name: string;
  description?: string;
  dayOfWeek: string;
  startTime: string;
  frequency: string;
  attendanceType?: 'standard' | 'headcount';
}

interface Person {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  familyId?: number;
  familyName?: string;
}

interface AddPeopleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void>;
  gatheringTypes: GatheringType[];
  people: Person[];
}

const AddPeopleModal: React.FC<AddPeopleModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  gatheringTypes,
  people
}) => {
  const [addModalMode, setAddModalMode] = useState<'person' | 'csv' | 'copy-paste'>('person');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const [addPeopleForm, setAddPeopleForm] = useState<AddPeopleFormState>({
    personType: 'regular',
    notes: '',
    persons: [{
      firstName: '',
      lastName: '',
      lastNameUnknown: false,
      fillLastNameFromAbove: false,
      isChild: false
    }],
    selectedGatherings: {}
  });

  const [csvData, setCsvData] = useState('');
  const [copyPasteData, setCopyPasteData] = useState('');
  const [potentialDuplicates, setPotentialDuplicates] = useState<Array<{firstName: string, lastName: string, reason: string}>>([]);
  const [tsvAnalysis, setTsvAnalysis] = useState<{
    newPeople: number;
    existingPeople: number;
    unknownGatherings: string[];
    totalRows: number;
  } | null>(null);

  // Modal tab slider state
  const [isModalTabDragging, setIsModalTabDragging] = useState(false);
  const [modalTabStartX, setModalTabStartX] = useState(0);
  const [modalTabScrollLeft, setModalTabScrollLeft] = useState(0);
  const [showModalTabLeftFade, setShowModalTabLeftFade] = useState(false);
  const [showModalTabRightFade, setShowModalTabRightFade] = useState(true);
  const modalTabSliderRef = useRef<HTMLDivElement>(null);
  const modalTabAnimationFrameRef = useRef<number | null>(null);
  const modalTabLastTouchTimeRef = useRef<number>(0);
  const modalTabTouchThrottleDelay = 16; // ~60fps

  // Helper function to analyze TSV data for potential duplicates
  const analyzeTSVForDuplicates = useCallback((tsvData: string) => {
    if (!tsvData || people.length === 0) {
      setPotentialDuplicates([]);
      return;
    }

    try {
      const lines = tsvData.trim().split('\n');
      let existingCount = 0;
      let totalCount = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (i === 0 && (line.toLowerCase().includes('first') || line.toLowerCase().includes('name'))) {
          continue;
        }

        const columns = line.split('\t');
        if (columns.length < 2) continue;

        const firstName = columns[0].trim();
        const lastName = columns[1].trim();

        if (!firstName || !lastName) continue;

        totalCount++;

        const exactMatch = people.find(p =>
          p.firstName.toLowerCase() === firstName.toLowerCase() &&
          p.lastName.toLowerCase() === lastName.toLowerCase()
        );

        if (exactMatch) {
          existingCount++;
        }
      }

      const isUpdateOperation = totalCount > 0 && (existingCount / totalCount) >= 0.8;
      const actualDuplicates: Array<{firstName: string, lastName: string, reason: string}> = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (i === 0 && (line.toLowerCase().includes('first') || line.toLowerCase().includes('name'))) {
          continue;
        }

        const columns = line.split('\t');
        if (columns.length < 2) continue;

        const firstName = columns[0].trim();
        const lastName = columns[1].trim();

        if (!firstName || !lastName) continue;

        const exactMatch = people.find(p =>
          p.firstName.toLowerCase() === firstName.toLowerCase() &&
          p.lastName.toLowerCase() === lastName.toLowerCase()
        );

        if (exactMatch && !isUpdateOperation) {
          actualDuplicates.push({
            firstName,
            lastName,
            reason: 'Exact name match found'
          });
          continue;
        }

        const similarMatches = people.filter(p => {
          const firstNameSimilar = p.firstName.toLowerCase().includes(firstName.toLowerCase()) ||
                                  firstName.toLowerCase().includes(p.firstName.toLowerCase());
          const lastNameSimilar = p.lastName.toLowerCase().includes(lastName.toLowerCase()) ||
                                lastName.toLowerCase().includes(p.lastName.toLowerCase());

          const isExactMatch = p.firstName.toLowerCase() === firstName.toLowerCase() &&
                              p.lastName.toLowerCase() === lastName.toLowerCase();

          return firstNameSimilar && lastNameSimilar && !isExactMatch;
        });

        if (similarMatches.length > 0) {
          actualDuplicates.push({
            firstName,
            lastName,
            reason: `Similar names found: ${similarMatches.map(p => `${p.firstName} ${p.lastName}`).join(', ')}`
          });
        }
      }

      setPotentialDuplicates(actualDuplicates);
    } catch (error) {
      console.error('Error analyzing TSV for duplicates:', error);
      setPotentialDuplicates([]);
    }
  }, [people]);

  // Helper function to analyze TSV data and determine what changes will be made
  const analyzeTSVData = useCallback((tsvData: string) => {
    if (!tsvData || people.length === 0 || gatheringTypes.length === 0) {
      setTsvAnalysis(null);
      return;
    }

    try {
      const lines = tsvData.trim().split('\n');
      let newPeople = 0;
      let existingPeople = 0;
      let totalRows = 0;
      const unknownGatherings = new Set<string>();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (i === 0 && (line.toLowerCase().includes('first') || line.toLowerCase().includes('name'))) {
          continue;
        }

        const columns = line.split('\t');
        if (columns.length < 2) continue;

        const firstName = columns[0].trim();
        const lastName = columns[1].trim();
        const gatherings = columns[3]?.trim() || '';

        if (!firstName || !lastName) continue;

        totalRows++;

        const existingPerson = people.find(p =>
          p.firstName.toLowerCase() === firstName.toLowerCase() &&
          p.lastName.toLowerCase() === lastName.toLowerCase()
        );

        if (existingPerson) {
          existingPeople++;
        } else {
          newPeople++;
        }

        if (gatherings) {
          const gatheringNames = gatherings.split(',').map(g => g.trim()).filter(g => g);
          for (const gatheringName of gatheringNames) {
            const gatheringExists = gatheringTypes.some(gt =>
              gt.name.toLowerCase() === gatheringName.toLowerCase()
            );
            if (!gatheringExists) {
              unknownGatherings.add(gatheringName);
            }
          }
        }
      }

      setTsvAnalysis({
        newPeople,
        existingPeople,
        unknownGatherings: Array.from(unknownGatherings),
        totalRows
      });
    } catch (error) {
      console.error('Error analyzing TSV data:', error);
      setTsvAnalysis(null);
    }
  }, [people, gatheringTypes]);

  // Analyze TSV data when it changes
  useEffect(() => {
    if (csvData) {
      analyzeTSVForDuplicates(csvData);
      analyzeTSVData(csvData);
    } else {
      setPotentialDuplicates([]);
      setTsvAnalysis(null);
    }
  }, [csvData, analyzeTSVForDuplicates, analyzeTSVData]);

  // Cleanup animation frames on unmount
  useEffect(() => {
    return () => {
      if (modalTabAnimationFrameRef.current) {
        cancelAnimationFrame(modalTabAnimationFrameRef.current);
      }
    };
  }, []);

  // Modal tab slider functions
  const handleModalTabMouseDown = (e: React.MouseEvent) => {
    setIsModalTabDragging(true);
    setModalTabStartX(e.pageX - (modalTabSliderRef.current?.offsetLeft || 0));
    setModalTabScrollLeft(modalTabSliderRef.current?.scrollLeft || 0);
  };

  const handleModalTabMouseLeave = () => {
    setIsModalTabDragging(false);
  };

  const handleModalTabMouseUp = () => {
    setIsModalTabDragging(false);
  };

  const handleModalTabMouseMove = (e: React.MouseEvent) => {
    if (!isModalTabDragging || !modalTabSliderRef.current) return;
    e.preventDefault();
    const x = e.pageX - modalTabSliderRef.current.offsetLeft;
    const walk = (x - modalTabStartX) * 2;
    modalTabSliderRef.current.scrollLeft = modalTabScrollLeft - walk;
  };

  const handleModalTabTouchStart = (e: React.TouchEvent) => {
    setIsModalTabDragging(true);
    setModalTabStartX(e.touches[0].pageX - (modalTabSliderRef.current?.offsetLeft || 0));
    setModalTabScrollLeft(modalTabSliderRef.current?.scrollLeft || 0);
  };

  const handleModalTabTouchMove = (e: React.TouchEvent) => {
    if (!isModalTabDragging || !modalTabSliderRef.current) return;

    const now = Date.now();
    if (now - modalTabLastTouchTimeRef.current < modalTabTouchThrottleDelay) {
      return;
    }
    modalTabLastTouchTimeRef.current = now;

    e.preventDefault();

    if (modalTabAnimationFrameRef.current) {
      cancelAnimationFrame(modalTabAnimationFrameRef.current);
    }

    modalTabAnimationFrameRef.current = requestAnimationFrame(() => {
      if (!modalTabSliderRef.current) return;
      const x = e.touches[0].pageX - modalTabSliderRef.current.offsetLeft;
      const walk = (x - modalTabStartX) * 2;
      modalTabSliderRef.current.scrollLeft = modalTabScrollLeft - walk;
    });
  };

  const handleModalTabTouchEnd = () => {
    setIsModalTabDragging(false);

    if (modalTabAnimationFrameRef.current) {
      cancelAnimationFrame(modalTabAnimationFrameRef.current);
      modalTabAnimationFrameRef.current = null;
    }
  };

  const checkModalTabScrollPosition = () => {
    if (!modalTabSliderRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = modalTabSliderRef.current;
    const isAtEnd = scrollLeft + clientWidth >= scrollWidth - 5;
    const isAtStart = scrollLeft <= 5;

    setShowModalTabRightFade(!isAtEnd);
    setShowModalTabLeftFade(!isAtStart);
  };

  // Add scroll event listener for modal tab fade indicators
  useEffect(() => {
    const handleScroll = () => {
      checkModalTabScrollPosition();
    };

    const modalSlider = modalTabSliderRef.current;

    if (modalSlider) {
      modalSlider.addEventListener('scroll', handleScroll);
      handleScroll();
    }

    return () => {
      if (modalSlider) {
        modalSlider.removeEventListener('scroll', handleScroll);
      }
    };
  }, [isOpen]);

  // Memoized family name computation using utility that excludes children
  const computedFamilyName = useMemo(() => {
    const validMembers = addPeopleForm.persons.filter(member =>
      member.firstName.trim() &&
      (member.lastName.trim() || member.lastNameUnknown)
    );

    if (validMembers.length === 0) {
      return '';
    }

    return generateFamilyName(validMembers.map(member => ({
      firstName: member.firstName.trim(),
      lastName: member.lastNameUnknown ? '' : member.lastName.trim(),
      lastUnknown: member.lastNameUnknown,
      isChild: member.isChild
    })));
  }, [addPeopleForm.persons]);

  const addPerson = () => {
    setAddPeopleForm(prev => {
      const newPerson: PersonForm = {
        firstName: '',
        lastName: '',
        lastNameUnknown: false,
        fillLastNameFromAbove: true,
        isChild: false
      };

      if (prev.persons.length > 0) {
        const firstPerson = prev.persons[0];
        if (firstPerson.lastName && !firstPerson.lastNameUnknown) {
          newPerson.lastName = firstPerson.lastName;
        }
      }

      return {
        ...prev,
        persons: [...prev.persons, newPerson]
      };
    });
  };

  const removePerson = (index: number) => {
    setAddPeopleForm(prev => ({
      ...prev,
      persons: prev.persons.filter((_, i) => i !== index)
    }));
  };

  const updatePerson = (index: number, updates: Partial<PersonForm>) => {
    setAddPeopleForm(prev => {
      const newPersons = [...prev.persons];
      newPersons[index] = { ...newPersons[index], ...updates };

      if (updates.lastNameUnknown !== undefined) {
        newPersons[index].lastName = updates.lastNameUnknown ? '' : newPersons[index].lastName;
        if (updates.lastNameUnknown) {
          newPersons[index].fillLastNameFromAbove = false;
        }
      }

      if (updates.fillLastNameFromAbove !== undefined) {
        if (updates.fillLastNameFromAbove && index > 0) {
          const firstPerson = newPersons[0];
          if (firstPerson.lastName && !firstPerson.lastNameUnknown) {
            newPersons[index].lastName = firstPerson.lastName;
            newPersons[index].lastNameUnknown = false;
          }
        }
      }

      if (index === 0 && updates.lastName !== undefined) {
        for (let i = 1; i < newPersons.length; i++) {
          if (newPersons[i].fillLastNameFromAbove && !newPersons[i].lastNameUnknown) {
            newPersons[i].lastName = updates.lastName;
          }
        }
      }

      return { ...prev, persons: newPersons };
    });
  };

  const handleAddPeople = async () => {
    try {
      setIsLoading(true);
      setError('');

      for (const person of addPeopleForm.persons) {
        if (!person.firstName.trim()) {
          setError('First name is required for all persons');
          return;
        }
        if (!person.lastName.trim() && !person.lastNameUnknown) {
          setError('Last name is required for all persons (or check "Unknown")');
          return;
        }
      }

      const people = addPeopleForm.persons.map(person => ({
        firstName: person.firstName.trim(),
        lastName: person.lastNameUnknown ? 'Unknown' : person.lastName.trim(),
        firstUnknown: false,
        lastUnknown: person.lastNameUnknown,
        isChild: person.isChild
      }));

      const notes = addPeopleForm.notes.trim();
      const familyName = computedFamilyName;

      if (addPeopleForm.personType === 'regular') {
        const familyResponse = await familiesAPI.create({
          familyName: familyName
        });

        const individualPromises = people.map(person =>
          individualsAPI.create({
            firstName: person.firstName,
            lastName: person.lastName,
            familyId: familyResponse.data.id,
            isChild: person.isChild
          })
        );

        const individualResponses = await Promise.all(individualPromises);
        const individualIds = individualResponses.map(response => response.data.id);

        const selectedGatheringIds = Object.keys(addPeopleForm.selectedGatherings)
          .filter(gatheringId => addPeopleForm.selectedGatherings[parseInt(gatheringId)])
          .map(gatheringId => parseInt(gatheringId));

        if (selectedGatheringIds.length > 0) {
          for (const gatheringId of selectedGatheringIds) {
            await csvImportAPI.massAssign(gatheringId, individualIds);
          }
        }
      } else {
        await familiesAPI.createVisitorFamily({
          familyName,
          peopleType: addPeopleForm.personType,
          notes: notes ? notes : undefined,
          people
        });
      }

      // Reset form
      setAddPeopleForm({
        personType: 'regular',
        notes: '',
        persons: [{
          firstName: '',
          lastName: '',
          lastNameUnknown: false,
          fillLastNameFromAbove: false,
          isChild: false
        }],
        selectedGatherings: {}
      });

      onClose();
      await onSuccess();

    } catch (err: any) {
      console.error('Failed to add people:', err);
      setError(err.response?.data?.error || 'Failed to add people');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCSVUpload = async () => {
    try {
      setIsLoading(true);
      setError('');

      logger.log('TSV data:', csvData);
      logger.log('TSV Analysis:', tsvAnalysis);

      let response;

      if (tsvAnalysis && tsvAnalysis.existingPeople > 0) {
        logger.log('Processing TSV for updates - found existing people');
        response = await csvImportAPI.updateExisting(csvData);
      } else {
        const csvBlob = new Blob([csvData], { type: 'text/tsv' });
        const formData = new FormData();
        formData.append('file', csvBlob, 'people.tsv');

        response = await csvImportAPI.copyPaste(csvData);
      }

      logger.log('CSV upload response:', response);

      if (tsvAnalysis && tsvAnalysis.existingPeople > 0) {
        // Show success message for updates
        // Note: Assuming showSuccess is handled by parent via onSuccess callback
        // which will trigger a toast
      }

      setCsvData('');
      setPotentialDuplicates([]);
      setTsvAnalysis(null);

      onClose();
      await onSuccess();

    } catch (err: any) {
      console.error('TSV upload failed:', err);
      setError(err.response?.data?.error || 'Failed to upload TSV file');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyPasteUpload = async () => {
    try {
      setIsLoading(true);
      setError('');

      logger.log('Sending copy-paste data:', copyPasteData);

      const response = await csvImportAPI.copyPaste(copyPasteData);

      logger.log('Copy-paste upload response:', response);

      setCopyPasteData('');

      onClose();
      await onSuccess();

    } catch (err: any) {
      console.error('Copy-paste upload failed:', err);
      setError(err.response?.data?.error || 'Failed to process pasted data');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-[9999]">
      <div className="flex items-center justify-center min-h-screen p-4">
        <div className="relative w-11/12 md:w-3/4 lg:w-1/2 max-w-2xl p-5 border shadow-lg rounded-md bg-white">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">
              {addModalMode === 'person' && 'Add New People'}
              {addModalMode === 'csv' && 'Upload TSV File'}
              {addModalMode === 'copy-paste' && 'Copy & Paste Data'}
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          {/* Mode Selection Tabs */}
          <div className="border-b border-gray-200 mb-6">
            <nav className="hidden md:flex -mb-px space-x-2 items-center" aria-label="Tabs">
              <button
                onClick={() => setAddModalMode('person')}
                className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                  addModalMode === 'person'
                    ? 'bg-primary-500 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                Add People
              </button>
              <button
                onClick={() => setAddModalMode('csv')}
                className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                  addModalMode === 'csv'
                    ? 'bg-primary-500 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                TSV Upload
              </button>
              <button
                onClick={() => setAddModalMode('copy-paste')}
                className={`whitespace-nowrap py-2 px-4 font-medium text-sm transition-all duration-300 rounded-t-lg ${
                  addModalMode === 'copy-paste'
                    ? 'bg-primary-500 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                Copy & Paste
              </button>
            </nav>
            {/* Mobile: Horizontal scrollable tabs with fade indicators */}
            <div className="md:hidden">
              <div className="relative w-full overflow-hidden">
                <div
                  ref={modalTabSliderRef}
                  className="flex items-center space-x-1 overflow-x-auto scrollbar-hide cursor-grab select-none w-full tab-slider"
                  style={{scrollbarWidth: 'none', msOverflowStyle: 'none'}}
                  onMouseDown={handleModalTabMouseDown}
                  onMouseLeave={handleModalTabMouseLeave}
                  onMouseUp={handleModalTabMouseUp}
                  onMouseMove={handleModalTabMouseMove}
                  onTouchStart={handleModalTabTouchStart}
                  onTouchMove={handleModalTabTouchMove}
                  onTouchEnd={handleModalTabTouchEnd}
                >
                  <div className="flex-shrink-0 min-w-0">
                    <button
                      draggable={false}
                      onClick={(e) => {
                        if (!isModalTabDragging) {
                          setAddModalMode('person');
                        }
                      }}
                      className={`h-12 py-2 px-3 font-medium text-xs transition-all duration-300 rounded-t-lg group ${
                        addModalMode === 'person'
                          ? 'bg-primary-500 text-white'
                          : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <div className="flex items-center justify-center h-full">
                        <span className="text-center leading-tight whitespace-nowrap">
                          Add People
                        </span>
                      </div>
                    </button>
                  </div>
                  <div className="flex-shrink-0 min-w-0">
                    <button
                      draggable={false}
                      onClick={(e) => {
                        if (!isModalTabDragging) {
                          setAddModalMode('csv');
                        }
                      }}
                      className={`h-12 py-2 px-3 font-medium text-xs transition-all duration-300 rounded-t-lg group ${
                        addModalMode === 'csv'
                          ? 'bg-primary-500 text-white'
                          : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <div className="flex items-center justify-center h-full">
                        <span className="text-center leading-tight whitespace-nowrap">
                          TSV Upload
                        </span>
                      </div>
                    </button>
                  </div>
                  <div className="flex-shrink-0 min-w-0">
                    <button
                      draggable={false}
                      onClick={(e) => {
                        if (!isModalTabDragging) {
                          setAddModalMode('copy-paste');
                        }
                      }}
                      className={`h-12 py-2 px-3 font-medium text-xs transition-all duration-300 rounded-t-lg group ${
                        addModalMode === 'copy-paste'
                          ? 'bg-primary-500 text-white'
                          : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <div className="flex items-center justify-center h-full">
                        <span className="text-center leading-tight whitespace-nowrap">
                          Copy & Paste
                        </span>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Fade indicators */}
                {showModalTabLeftFade && (
                  <div className="absolute top-0 left-0 w-8 h-12 bg-gradient-to-r from-white via-white/90 to-transparent pointer-events-none z-10">
                    <div className="absolute top-1/2 left-2 -translate-y-1/2 w-4 h-4 text-gray-600 bg-white rounded-full shadow-sm flex items-center justify-center">
                      <svg viewBox="0 0 16 16" fill="currentColor">
                        <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                )}
                {showModalTabRightFade && (
                  <div className="absolute top-0 right-0 w-8 h-12 bg-gradient-to-l from-white via-white/90 to-transparent pointer-events-none z-10">
                    <div className="absolute top-1/2 right-2 -translate-y-1/2 w-4 h-4 text-gray-600 bg-white rounded-full shadow-sm flex items-center justify-center">
                      <svg viewBox="0 0 16 16" fill="currentColor">
                        <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}

          {/* Add People Form */}
          {addModalMode === 'person' && (
            <form onSubmit={(e) => { e.preventDefault(); handleAddPeople(); }} className="space-y-4">
              {/* Person Type Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Person Type
                </label>
                <div className="flex space-x-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="personType"
                      value="regular"
                      checked={addPeopleForm.personType === 'regular'}
                      onChange={(e) => setAddPeopleForm({ ...addPeopleForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                    />
                    <span className="ml-2 text-sm text-gray-900">Regular Member</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="personType"
                      value="local_visitor"
                      checked={addPeopleForm.personType === 'local_visitor'}
                      onChange={(e) => setAddPeopleForm({ ...addPeopleForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                    />
                    <span className="ml-2 text-sm text-gray-900">Local Visitor</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="personType"
                      value="traveller_visitor"
                      checked={addPeopleForm.personType === 'traveller_visitor'}
                      onChange={(e) => setAddPeopleForm({ ...addPeopleForm, personType: e.target.value as 'regular' | 'local_visitor' | 'traveller_visitor' })}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                    />
                    <span className="ml-2 text-sm text-gray-900">Traveller Visitor</span>
                  </label>
                </div>
              </div>

              {/* Persons List */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Family Members (up to 10)
                  </label>
                </div>
                {addPeopleForm.persons.map((person, index) => (
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
                        disabled={person.lastNameUnknown || (index > 0 && person.fillLastNameFromAbove)}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100"
                        placeholder="Last name"
                      />
                      <div className="flex flex-col space-y-1 mt-1">
                        <div className="flex items-center">
                          <input
                            id={`personLastNameUnknown-${index}`}
                            type="checkbox"
                            checked={person.lastNameUnknown}
                            onChange={(e) => updatePerson(index, { lastNameUnknown: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <label htmlFor={`personLastNameUnknown-${index}`} className="ml-2 block text-sm text-gray-900">
                            Unknown
                          </label>
                        </div>
                        {index > 0 && (
                          <div className="flex items-center">
                            <input
                              id={`personFillLastName-${index}`}
                              type="checkbox"
                              checked={person.fillLastNameFromAbove}
                              onChange={(e) => updatePerson(index, { fillLastNameFromAbove: e.target.checked })}
                              disabled={person.lastNameUnknown}
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
                    <div className="md:col-span-2">
                      <label className="flex items-center">
                        <input
                          id={`personIsChild-${index}`}
                          type="checkbox"
                          checked={person.isChild}
                          onChange={(e) => updatePerson(index, { isChild: e.target.checked })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <span className="ml-2 text-sm text-gray-700">Child</span>
                        <span className="ml-1 text-xs text-gray-400">(excluded from family name)</span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add Another Person button */}
              {addPeopleForm.persons.length < 10 && (
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

              {/* Family Name Display */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Family Name
                </label>
                <div className="mt-1 p-3 bg-gray-50 border border-gray-200 rounded-md">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-900 font-medium">
                      {computedFamilyName || 'Enter family member names above'}
                    </span>
                    {computedFamilyName && (
                      <span className="text-xs text-green-600 bg-green-100 px-2 py-1 rounded">
                        Auto-generated
                      </span>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-sm text-gray-500">
                  Family name is automatically generated from the member names above.
                </p>
              </div>

              {/* Gathering Assignments - only for regular members */}
              {addPeopleForm.personType === 'regular' && gatheringTypes.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Assign to Gatherings (Optional)
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {gatheringTypes
                      .map((gathering) => (
                        <label key={gathering.id} className="flex items-center">
                          <input
                            type="checkbox"
                            checked={addPeopleForm.selectedGatherings[gathering.id] || false}
                            onChange={(e) => setAddPeopleForm({
                              ...addPeopleForm,
                              selectedGatherings: {
                                ...addPeopleForm.selectedGatherings,
                                [gathering.id]: e.target.checked
                              }
                            })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <span className="ml-2 text-sm text-gray-900">{gathering.name}</span>
                        </label>
                      ))}
                  </div>
                </div>
              )}

              {/* Notes field - only for visitors */}
              {(addPeopleForm.personType === 'local_visitor' || addPeopleForm.personType === 'traveller_visitor') && (
                <div>
                  <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
                    Notes
                  </label>
                  <textarea
                    id="notes"
                    value={addPeopleForm.notes}
                    onChange={(e) => setAddPeopleForm({ ...addPeopleForm, notes: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Any additional notes (optional)"
                    rows={3}
                  />
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                  disabled={isLoading}
                >
                  {isLoading ? 'Adding...' : 'Add People'}
                </button>
              </div>
            </form>
          )}

          {/* TSV Upload Form */}
          {addModalMode === 'csv' && (
            <div className="space-y-4">
              {/* TSV Analysis section - continuing from previous code */}
              {tsvAnalysis && (
                <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-blue-800">
                        Upload Analysis
                      </h3>
                      <div className="mt-2 text-sm text-blue-700">
                        <p>Found {tsvAnalysis.totalRows} rows in your TSV file:</p>
                        <ul className="mt-2 space-y-1">
                          {tsvAnalysis.newPeople > 0 && (
                            <li className="flex items-center">
                              <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-2"></span>
                              <span className="font-medium text-green-800">{tsvAnalysis.newPeople} new people</span> will be added
                            </li>
                          )}
                          {tsvAnalysis.existingPeople > 0 && (
                            <li className="flex items-center">
                              <span className="inline-block w-2 h-2 bg-blue-500 rounded-full mr-2"></span>
                              <span className="font-medium text-blue-800">{tsvAnalysis.existingPeople} existing people</span> will be updated
                            </li>
                          )}
                        </ul>
                        {tsvAnalysis.unknownGatherings.length > 0 && (
                          <div className="mt-3 p-2 bg-yellow-100 rounded border border-yellow-300">
                            <p className="font-medium text-yellow-800">⚠️ Unknown gatherings found:</p>
                            <p className="text-yellow-700 text-xs mt-1">
                              {tsvAnalysis.unknownGatherings.join(', ')} - these will be ignored
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* New People Warning */}
              {tsvAnalysis && tsvAnalysis.newPeople > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-md p-4">
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <svg className="h-5 w-5 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-amber-800">
                        Adding New People
                      </h3>
                      <div className="mt-2 text-sm text-amber-700">
                        <p>
                          <strong>{tsvAnalysis.newPeople} new people</strong> will be added to your system.
                          Make sure these are not duplicates of existing people.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Duplication Warning */}
              {potentialDuplicates.length > 0 && (
                <div className={`border rounded-md p-4 ${
                  potentialDuplicates.length > 5
                    ? 'bg-red-50 border-red-200'
                    : 'bg-yellow-50 border-yellow-200'
                }`}>
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <svg className={`h-5 w-5 ${
                        potentialDuplicates.length > 5 ? 'text-red-400' : 'text-yellow-400'
                      }`} viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="ml-3">
                      <h3 className={`text-sm font-medium ${
                        potentialDuplicates.length > 5 ? 'text-red-800' : 'text-yellow-800'
                      }`}>
                        {potentialDuplicates.length > 5 ? 'High Risk of Duplication!' : 'Potential Duplication Warning'}
                      </h3>
                      <div className={`mt-2 text-sm ${
                        potentialDuplicates.length > 5 ? 'text-red-700' : 'text-yellow-700'
                      }`}>
                        <p className={`font-medium mb-2 ${
                          potentialDuplicates.length > 5 ? 'text-red-800' : 'text-yellow-800'
                        }`}>
                          ⚠️ Potential duplicates detected in your TSV:
                        </p>
                        <div className={`rounded p-2 max-h-32 overflow-y-auto ${
                          potentialDuplicates.length > 5 ? 'bg-red-100' : 'bg-yellow-100'
                        }`}>
                          {potentialDuplicates.map((dup, index) => (
                            <div key={index} className={`text-xs mb-1 ${
                              potentialDuplicates.length > 5 ? 'text-red-800' : 'text-yellow-800'
                            }`}>
                              <strong>{dup.firstName} {dup.lastName}</strong>: {dup.reason}
                            </div>
                          ))}
                        </div>

                        {potentialDuplicates.length > 5 && (
                          <p className="mt-2 font-bold text-red-800">
                            🚨 HIGH RISK: {potentialDuplicates.length} potential duplicates detected!
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="csvFile" className="block text-sm font-medium text-gray-700">
                  Select TSV File
                </label>
                <input
                  id="csvFile"
                  type="file"
                  accept=".tsv,.txt,.csv"
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
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p>Expected TSV format:</p>
                  <button
                    onClick={async () => {
                      try {
                        const response = await csvImportAPI.downloadTemplate();
                        const blob = new Blob([response.data], { type: 'text/tab-separated-values' });
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'people_import_template.tsv';
                        document.body.appendChild(a);
                        a.click();
                        window.URL.revokeObjectURL(url);
                        document.body.removeChild(a);
                      } catch (error) {
                        console.error('Error downloading template:', error);
                        setError('Failed to download template');
                      }
                    }}
                    className="ml-4 inline-flex items-center text-primary-600 hover:text-primary-700 font-medium"
                  >
                    Download template
                  </button>
                </div>
                <div className="mt-1 bg-gray-50 p-3 rounded border border-gray-200 overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="border-b border-gray-300">
                        <th className="text-left py-1 px-2 font-semibold text-gray-700">FIRST NAME</th>
                        <th className="text-left py-1 px-2 font-semibold text-gray-700">LAST NAME</th>
                        <th className="text-left py-1 px-2 font-semibold text-gray-700">FAMILY NAME</th>
                        <th className="text-left py-1 px-2 font-semibold text-gray-700">GATHERINGS</th>
                        <th className="text-left py-1 px-2 font-semibold text-gray-400">ADULT/CHILD</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="py-1 px-2">John</td>
                        <td className="py-1 px-2">Smith</td>
                        <td className="py-1 px-2">Smith, John and Sarah</td>
                        <td className="py-1 px-2">
                          {gatheringTypes.length >= 2
                            ? `${gatheringTypes[0].name}, ${gatheringTypes[1].name}`
                            : gatheringTypes.length === 1
                              ? gatheringTypes[0].name
                              : 'Sunday Service, Bible Study'
                          }
                        </td>
                        <td className="py-1 px-2 text-gray-400">Adult</td>
                      </tr>
                      <tr>
                        <td className="py-1 px-2">Sarah</td>
                        <td className="py-1 px-2">Smith</td>
                        <td className="py-1 px-2">Smith, John and Sarah</td>
                        <td className="py-1 px-2">
                          {gatheringTypes.length >= 1
                            ? gatheringTypes[0].name
                            : 'Sunday Service'
                          }
                        </td>
                        <td className="py-1 px-2 text-gray-400">Child</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCSVUpload}
                  disabled={!csvData || isLoading}
                  className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  {isLoading ? 'Uploading...' : 'Upload'}
                </button>
              </div>
            </div>
          )}

          {/* Copy & Paste Form */}
          {addModalMode === 'copy-paste' && (
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
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p>Expected format (tab or comma separated):</p>
                  <button
                    onClick={async () => {
                      try {
                        const response = await csvImportAPI.downloadTemplate();
                        const blob = new Blob([response.data], { type: 'text/tab-separated-values' });
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'people_import_template.tsv';
                        document.body.appendChild(a);
                        a.click();
                        window.URL.revokeObjectURL(url);
                        document.body.removeChild(a);
                      } catch (error) {
                        console.error('Error downloading template:', error);
                        setError('Failed to download template');
                      }
                    }}
                    className="ml-4 inline-flex items-center text-primary-600 hover:text-primary-700 font-medium"
                  >
                    Download template
                  </button>
                </div>
                <div className="mt-1 bg-gray-50 border border-gray-200 rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium text-gray-700 border-r border-gray-200">FIRST NAME</th>
                        <th className="px-2 py-1 text-left font-medium text-gray-700 border-r border-gray-200">LAST NAME</th>
                        <th className="px-2 py-1 text-left font-medium text-gray-700 border-r border-gray-200">FAMILY NAME</th>
                        <th className="px-2 py-1 text-left font-medium text-gray-700 border-r border-gray-200">GATHERINGS</th>
                        <th className="px-2 py-1 text-left font-medium text-gray-400">ADULT/CHILD</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      <tr>
                        <td className="px-2 py-1 border-r border-gray-200">John</td>
                        <td className="px-2 py-1 border-r border-gray-200">Smith</td>
                        <td className="px-2 py-1 border-r border-gray-200">Smith, John and Sarah</td>
                        <td className="px-2 py-1 border-r border-gray-200">
                          {gatheringTypes.length >= 2
                            ? `${gatheringTypes[0].name}, ${gatheringTypes[1].name}`
                            : gatheringTypes.length === 1
                              ? gatheringTypes[0].name
                              : 'Sunday Service, Bible Study'
                          }
                        </td>
                        <td className="px-2 py-1 text-gray-400">Adult</td>
                      </tr>
                      <tr>
                        <td className="px-2 py-1 border-r border-gray-200">Sarah</td>
                        <td className="px-2 py-1 border-r border-gray-200">Smith</td>
                        <td className="px-2 py-1 border-r border-gray-200">Smith, John and Sarah</td>
                        <td className="px-2 py-1 border-r border-gray-200">
                          {gatheringTypes.length >= 1
                            ? gatheringTypes[0].name
                            : 'Sunday Service'
                          }
                        </td>
                        <td className="px-2 py-1 text-gray-400">Child</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs">Copy rows from Excel/Google Sheets with columns: FIRST NAME, LAST NAME, FAMILY NAME, GATHERINGS, ADULT/CHILD (optional).</p>
              </div>


              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCopyPasteUpload}
                  disabled={!copyPasteData || isLoading}
                  className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  {isLoading ? 'Processing...' : 'Process Data'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AddPeopleModal;
