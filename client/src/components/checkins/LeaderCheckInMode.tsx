import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { attendanceAPI, kioskAPI, familiesAPI, GatheringType, Individual } from '../../services/api';
import { useWebSocket, KioskSelectionUpdate, KioskSelectionCleared } from '../../contexts/WebSocketContext';
import { useAuth } from '../../contexts/AuthContext';
import { useBadgeSettings } from '../../hooks/useBadgeSettings';
import BadgeIcon, { BadgeIconType } from '../icons/BadgeIcon';
import LeaderCheckInModal from './LeaderCheckInModal';
import Modal from '../Modal';
import {
  MagnifyingGlassIcon,
  ArrowLeftIcon,
  CheckCircleIcon,
  CheckIcon,
  PlusIcon,
  XMarkIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';

interface FamilyGroup {
  familyId: number;
  familyName: string;
  members: Individual[];
}

interface LeaderCheckInModeProps {
  selectedGathering: GatheringType;
  gatheringDate: string;
  onBack: () => void;
}

const LeaderCheckInMode: React.FC<LeaderCheckInModeProps> = ({
  selectedGathering,
  gatheringDate,
  onBack,
}) => {
  const { getBadgeInfo } = useBadgeSettings();
  const { socket, isConnected, sendAttendanceUpdate, sendKioskAction, onAttendanceUpdate, onKioskCheckout, onReconnect, broadcastKioskSelection, clearKioskSelection, onKioskSelectionChanged, onKioskSelectionCleared } = useWebSocket();
  const { user } = useAuth();

  // Mode
  const [mode, setMode] = useState<'checkin' | 'present' | 'checkout' | 'checkedout'>('checkin');

  // Data
  const [attendanceList, setAttendanceList] = useState<Individual[]>([]);
  const [familyGroups, setFamilyGroups] = useState<FamilyGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Selection
  const [searchTerm, setSearchTerm] = useState('');
  const [groupByFamily, setGroupByFamily] = useState(true);
  const [checkedMembers, setCheckedMembers] = useState<Set<number>>(new Set());

  // Modal
  const [showModal, setShowModal] = useState(false);
  const [showUndoModal, setShowUndoModal] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);

  // Visitor
  const [showAddVisitorModal, setShowAddVisitorModal] = useState(false);
  const [visitorPersons, setVisitorPersons] = useState([{ firstName: '', lastName: '' }]);
  const [isAddingVisitor, setIsAddingVisitor] = useState(false);
  const [guardianName, setGuardianName] = useState('');
  const [guardianContact, setGuardianContact] = useState('');

  // Checked-out tracking
  const [checkedOutIds, setCheckedOutIds] = useState<Set<number>>(new Set());

  // Other leaders' selections: userId → { userName, selectedIds }
  const [otherSelections, setOtherSelections] = useState<Map<number, { userName: string; selectedIds: Set<number> }>>(new Map());

  // Toast for soft warning
  const [selectionToast, setSelectionToast] = useState<string | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Feedback
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Load attendance data
  const loadAttendance = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await attendanceAPI.getFull(selectedGathering.id, gatheringDate);
      const regulars: Individual[] = (response.data.attendanceList || []).map((a: any) => ({
        ...a,
        present: Boolean(a.present),
      }));

      const seenIds = new Set(regulars.map(p => p.id));
      const allPeople = [...regulars];

      const visitors: any[] = response.data.visitors || [];
      for (const v of visitors) {
        const id = v.id || v.individualId;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          const nameParts = (v.name || '').split(' ');
          allPeople.push({
            id,
            firstName: v.firstName || nameParts[0] || '',
            lastName: v.lastName || nameParts.slice(1).join(' ') || '',
            peopleType: v.peopleType || 'local_visitor',
            isChild: v.isChild,
            badgeText: v.badgeText,
            badgeColor: v.badgeColor,
            badgeIcon: v.badgeIcon,
            familyId: v.familyId,
            familyName: v.familyName,
            familyNotes: v.familyNotes || v.notes,
            present: Boolean(v.present),
          });
        }
      }

      // potentialVisitors are unassigned visitors — skip them for leader check-in
      // Only regulars + visitors assigned to this gathering are shown

      setAttendanceList(allPeople);

      // Group by family
      const groups: Record<number, FamilyGroup> = {};
      const noFamily: Individual[] = [];
      for (const person of allPeople) {
        if (person.familyId) {
          if (!groups[person.familyId]) {
            groups[person.familyId] = {
              familyId: person.familyId,
              familyName: person.familyName || 'Unknown Family',
              members: [],
            };
          }
          groups[person.familyId].members.push(person);
        } else {
          noFamily.push(person);
        }
      }
      for (const person of noFamily) {
        groups[-person.id] = {
          familyId: -person.id,
          familyName: `${person.firstName} ${person.lastName}`,
          members: [person],
        };
      }
      setFamilyGroups(Object.values(groups));
    } catch (err) {
      setError('Failed to load attendance data.');
    } finally {
      setIsLoading(false);
    }
  }, [selectedGathering.id, gatheringDate]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance]);

  // Load kiosk checkout records to identify checked-out people
  const loadCheckoutData = useCallback(async () => {
    try {
      const response = await kioskAPI.getHistoryDetail(selectedGathering.id, gatheringDate);
      const individuals: any[] = response.data.individuals || [];
      const ids = new Set<number>();
      for (const ind of individuals) {
        if (ind.checkouts && ind.checkouts.length > 0) {
          const lastCheckin = ind.checkins?.[ind.checkins.length - 1]?.time;
          const lastCheckout = ind.checkouts[ind.checkouts.length - 1]?.time;
          if (!lastCheckin || new Date(lastCheckout) > new Date(lastCheckin)) {
            ids.add(ind.individualId);
          }
        }
      }
      setCheckedOutIds(ids);
    } catch {
      // Not critical if this fails
    }
  }, [selectedGathering.id, gatheringDate]);

  useEffect(() => {
    loadCheckoutData();
  }, [loadCheckoutData]);

  // Refresh all data when WebSocket reconnects (device woke up, network restored, etc.)
  useEffect(() => {
    return onReconnect(() => {
      loadAttendance();
      loadCheckoutData();
    });
  }, [onReconnect, loadAttendance, loadCheckoutData]);

  // WebSocket: subscribe to attendance updates via context callback
  useEffect(() => {
    const unsub = onAttendanceUpdate((data) => {
      if (String(data.gatheringId) !== String(selectedGathering.id) || data.date !== gatheringDate) return;
      if (!data.records) return;
      setAttendanceList(prev =>
        prev.map(p => {
          const rec = data.records!.find(r => r.individualId === p.id);
          return rec ? { ...p, present: Boolean(rec.present) } : p;
        })
      );
      setFamilyGroups(prev =>
        prev.map(fg => ({
          ...fg,
          members: fg.members.map(m => {
            const rec = data.records!.find(r => r.individualId === m.id);
            return rec ? { ...m, present: Boolean(rec.present) } : m;
          }),
        }))
      );
    });
    return unsub;
  }, [onAttendanceUpdate, selectedGathering.id, gatheringDate]);

  // WebSocket: subscribe to kiosk checkout events from other leaders
  useEffect(() => {
    const unsub = onKioskCheckout((data) => {
      if (String(data.gatheringId) === String(selectedGathering.id) && data.date === gatheringDate) {
        setCheckedOutIds(prev => {
          const next = new Set(prev);
          data.individualIds.forEach(id => next.add(id));
          return next;
        });
      }
    });
    return unsub;
  }, [onKioskCheckout, selectedGathering.id, gatheringDate]);

  // Broadcast selection changes to other leaders
  useEffect(() => {
    const userName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || '' : '';
    broadcastKioskSelection(selectedGathering.id, gatheringDate, Array.from(checkedMembers), userName, mode);
  }, [checkedMembers, broadcastKioskSelection, selectedGathering.id, gatheringDate, mode, user]);

  // Listen for other leaders' selection changes
  useEffect(() => {
    const unsubChanged = onKioskSelectionChanged((update: KioskSelectionUpdate) => {
      if (String(update.gatheringId) === String(selectedGathering.id) && update.date === gatheringDate) {
        setOtherSelections(prev => {
          const next = new Map(prev);
          if (update.selectedIds.length === 0) {
            next.delete(update.userId);
          } else {
            next.set(update.userId, {
              userName: update.userName,
              selectedIds: new Set(update.selectedIds),
            });
          }
          return next;
        });
      }
    });

    const unsubCleared = onKioskSelectionCleared((update: KioskSelectionCleared) => {
      setOtherSelections(prev => {
        const next = new Map(prev);
        next.delete(update.userId);
        return next;
      });
    });

    return () => {
      unsubChanged();
      unsubCleared();
    };
  }, [onKioskSelectionChanged, onKioskSelectionCleared, selectedGathering.id, gatheringDate]);

  // Clear selection on unmount
  useEffect(() => {
    return () => {
      clearKioskSelection(selectedGathering.id, gatheringDate);
    };
  }, [clearKioskSelection, selectedGathering.id, gatheringDate]);

  // Compute which people are selected by other leaders: individualId → list of names
  const selectedByOthers = useMemo(() => {
    const map = new Map<number, string[]>();
    otherSelections.forEach(({ userName, selectedIds }) => {
      selectedIds.forEach(id => {
        const names = map.get(id) || [];
        names.push(userName);
        map.set(id, names);
      });
    });
    return map;
  }, [otherSelections]);

  // Display name helper - matches AttendancePage logic
  const getPersonDisplayName = useCallback((person: Individual, familyName?: string) => {
    if (familyName) {
      const hasSurnameInFamilyName = familyName.includes(',');
      if (!hasSurnameInFamilyName) {
        return person.firstName || '';
      }
      const familySurname = familyName.split(',')[0]?.trim().toLowerCase();
      const personSurname = person.lastName?.toLowerCase() || '';
      if (personSurname && personSurname !== 'unknown' && familySurname === personSurname) {
        return person.firstName;
      }
    }
    if (!person.lastName || person.lastName.toLowerCase() === 'unknown' || !person.lastName.trim()) {
      return person.firstName || '';
    }
    return `${person.firstName || ''} ${person.lastName || ''}`.trim();
  }, []);

  // Filter families by search + mode
  const filteredFamilies = useMemo(() => {
    let results = familyGroups;

    // Filter members based on tab
    if (mode === 'checkin') {
      // Not yet checked in (and not checked out)
      results = results
        .map(g => ({
          ...g,
          members: g.members.filter(m => !m.present && !checkedOutIds.has(m.id)),
        }))
        .filter(g => g.members.length > 0);
    } else if (mode === 'present') {
      // Currently present (checked in, not checked out)
      results = results
        .map(g => ({
          ...g,
          members: g.members.filter(m => m.present && !checkedOutIds.has(m.id)),
        }))
        .filter(g => g.members.length > 0);
    } else if (mode === 'checkout') {
      // Currently present (can be checked out)
      results = results
        .map(g => ({
          ...g,
          members: g.members.filter(m => m.present && !checkedOutIds.has(m.id)),
        }))
        .filter(g => g.members.length > 0);
    } else if (mode === 'checkedout') {
      // Already checked out
      results = results
        .map(g => ({
          ...g,
          members: g.members.filter(m => checkedOutIds.has(m.id)),
        }))
        .filter(g => g.members.length > 0);
    }

    if (searchTerm.trim().length >= 1) {
      const term = searchTerm.toLowerCase();
      results = results.filter(g => {
        if (g.familyName.toLowerCase().includes(term)) return true;
        return g.members.some(m =>
          `${m.firstName} ${m.lastName}`.toLowerCase().includes(term)
        );
      });
    }

    // Sort by family surname (alphabetically)
    const getFamilySortKey = (g: FamilyGroup) => {
      const commaIdx = g.familyName.indexOf(',');
      const surname = commaIdx >= 0 ? g.familyName.slice(0, commaIdx).trim() : '';
      if (surname) return surname.toLowerCase();
      // Solo person: "FirstName LastName" - use last word as surname
      const parts = g.familyName.trim().split(/\s+/);
      return parts.length > 1 ? (parts[parts.length - 1] || '').toLowerCase() : g.familyName.toLowerCase();
    };
    results.sort((a, b) => getFamilySortKey(a).localeCompare(getFamilySortKey(b)));

    return results;
  }, [familyGroups, mode, searchTerm, checkedOutIds]);

  // Flattened individuals sorted by first name (for ungrouped view)
  const filteredIndividuals = useMemo(() => {
    const people: Individual[] = [];
    for (const g of filteredFamilies) {
      for (const m of g.members) people.push(m);
    }
    people.sort((a, b) => (a.firstName || '').localeCompare(b.firstName || ''));
    return people;
  }, [filteredFamilies]);

  // Toggle member
  const toggleMember = (id: number) => {
    setCheckedMembers(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Show soft warning if another leader has this person selected
        const otherNames = selectedByOthers.get(id);
        if (otherNames && otherNames.length > 0) {
          const names = otherNames.join(', ');
          setSelectionToast(`Also being selected by ${names}`);
          if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
          toastTimeoutRef.current = setTimeout(() => setSelectionToast(null), 2500);
        }
      }
      return next;
    });
  };

  // Get selected people objects
  const selectedPeople = useMemo(() => {
    return attendanceList.filter(p => checkedMembers.has(p.id));
  }, [attendanceList, checkedMembers]);

  // Handle confirm from modal
  const handleConfirm = async (signerName: string) => {
    const ids = Array.from(checkedMembers);
    const apiAction = mode === 'checkout' ? 'checkout' : 'checkin';

    // Try WebSocket first, fall back to REST
    if (isConnected && socket) {
      try {
        await sendKioskAction(selectedGathering.id, gatheringDate, ids, apiAction, signerName);
      } catch {
        // Fallback to REST
        await kioskAPI.record(selectedGathering.id, gatheringDate, {
          individualIds: ids, action: apiAction, signerName,
        });
      }
    } else {
      await kioskAPI.record(selectedGathering.id, gatheringDate, {
        individualIds: ids, action: apiAction, signerName,
      });
    }

    // Optimistic update
    if (mode === 'checkin') {
      setAttendanceList(prev =>
        prev.map(p => checkedMembers.has(p.id) ? { ...p, present: true } : p)
      );
      setFamilyGroups(prev =>
        prev.map(fg => ({
          ...fg,
          members: fg.members.map(m =>
            checkedMembers.has(m.id) ? { ...m, present: true } : m
          ),
        }))
      );
      // Remove from checked-out set if re-checking in
      setCheckedOutIds(prev => {
        const next = new Set(prev);
        checkedMembers.forEach(id => next.delete(id));
        return next;
      });
    } else {
      // Track as checked out
      setCheckedOutIds(prev => {
        const next = new Set(prev);
        checkedMembers.forEach(id => next.add(id));
        return next;
      });
    }

    const names = selectedPeople.map(p => p.firstName).join(', ');
    const verb = mode === 'checkin' ? 'checked in' : 'checked out';
    setSuccessMessage(`Successfully ${verb}: ${names}`);
    setCheckedMembers(new Set());
    clearKioskSelection(selectedGathering.id, gatheringDate);
    setShowModal(false);

    setTimeout(() => setSuccessMessage(null), 4000);
  };

  // Handle undo check-in or undo check-out
  const handleUndo = async () => {
    const ids = Array.from(checkedMembers);
    try {
      setIsUndoing(true);
      setError('');

      if (mode === 'present') {
        // Undo check-in: mark as not present
        const records = ids.map(id => ({ individualId: id, present: false }));
        if (isConnected && socket) {
          try {
            await sendAttendanceUpdate(selectedGathering.id, gatheringDate, records);
          } catch {
            await attendanceAPI.record(selectedGathering.id, gatheringDate, {
              attendanceRecords: records,
              visitors: [],
            });
          }
        } else {
          await attendanceAPI.record(selectedGathering.id, gatheringDate, {
            attendanceRecords: records,
            visitors: [],
          });
        }

        // Optimistic update: mark as not present
        setAttendanceList(prev =>
          prev.map(p => checkedMembers.has(p.id) ? { ...p, present: false } : p)
        );
        setFamilyGroups(prev =>
          prev.map(fg => ({
            ...fg,
            members: fg.members.map(m =>
              checkedMembers.has(m.id) ? { ...m, present: false } : m
            ),
          }))
        );
      } else if (mode === 'checkedout') {
        // Undo check-out: re-checkin so the checkout record is superseded
        if (isConnected && socket) {
          try {
            await sendKioskAction(selectedGathering.id, gatheringDate, ids, 'checkin', '');
          } catch {
            await kioskAPI.record(selectedGathering.id, gatheringDate, {
              individualIds: ids, action: 'checkin', signerName: '',
            });
          }
        } else {
          await kioskAPI.record(selectedGathering.id, gatheringDate, {
            individualIds: ids, action: 'checkin', signerName: '',
          });
        }

        // Optimistic update: remove from checked-out set (person goes back to present)
        setCheckedOutIds(prev => {
          const next = new Set(prev);
          checkedMembers.forEach(id => next.delete(id));
          return next;
        });
      }

      const names = selectedPeople.map(p => p.firstName).join(', ');
      const verb = mode === 'present' ? 'check-in undone' : 'check-out undone';
      setSuccessMessage(`${verb}: ${names}`);
      setCheckedMembers(new Set());
      setShowUndoModal(false);
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err: any) {
      setError(err.message || 'Failed to undo.');
    } finally {
      setIsUndoing(false);
    }
  };

  // Add visitor
  const handleAddVisitor = async () => {
    const validPersons = visitorPersons.filter(p => p.firstName.trim() && p.lastName.trim());
    if (validPersons.length === 0) {
      setError('Please enter at least one name.');
      return;
    }
    if (!guardianName.trim()) {
      setError('Please enter the parent/guardian name.');
      return;
    }

    if (!navigator.onLine) {
      setError('Adding new visitors requires an internet connection.');
      return;
    }

    try {
      setIsAddingVisitor(true);
      setError('');

      const people = validPersons.map(p => ({
        firstName: p.firstName.trim(),
        lastName: p.lastName.trim(),
        firstUnknown: false,
        lastUnknown: false,
        isChild: true,
      }));

      const guardianParts = guardianName.trim().split(/\s+/);
      const guardianFirst = guardianParts[0] || '';
      const guardianLast = guardianParts.length > 1 ? guardianParts.slice(1).join(' ') : guardianFirst;

      const familyName = `${guardianLast}, ${guardianFirst}`;
      const familyNotes = guardianContact.trim() || undefined;

      const familyResponse = await familiesAPI.createVisitorFamily({
        familyName,
        peopleType: 'local_visitor',
        notes: familyNotes,
        people,
      });

      const familyId = familyResponse.data.familyId || familyResponse.data.family?.id;
      const individualIds: number[] = (familyResponse.data.individuals || []).map((i: any) => i.id);

      if (familyId) {
        await attendanceAPI.addVisitorFamilyToService(selectedGathering.id, gatheringDate, familyId);
      }

      if (individualIds.length > 0) {
        await kioskAPI.record(selectedGathering.id, gatheringDate, {
          individualIds,
          action: 'checkin',
          signerName: guardianName.trim(),
        });
      }

      setShowAddVisitorModal(false);
      setVisitorPersons([{ firstName: '', lastName: '' }]);
      setGuardianName('');
      setGuardianContact('');
      await loadAttendance();

      const names = validPersons.map(p => p.firstName).join(' and ');
      setSuccessMessage(`${names} checked in by ${guardianName.trim()}!`);
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to add visitor.');
    } finally {
      setIsAddingVisitor(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-3 text-gray-500">Loading attendance data...</p>
        </div>
      </div>
    );
  }

  const notCheckedInCount = attendanceList.filter(p => !p.present && !checkedOutIds.has(p.id)).length;
  const presentCount = attendanceList.filter(p => p.present && !checkedOutIds.has(p.id)).length;
  const checkedOutCount = checkedOutIds.size;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={onBack}
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeftIcon className="h-4 w-4 mr-1" />
          Back
        </button>
        <div className="text-center flex-1">
          <h1 className="text-lg font-bold text-gray-900">Leader Check-in</h1>
          <p className="text-xs text-gray-500">
            {selectedGathering.name} &middot;{' '}
            {new Date(gatheringDate + 'T00:00:00').toLocaleDateString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric',
            })}
          </p>
        </div>
        <div className="w-12" /> {/* spacer for centering */}
      </div>

      {/* Mode Tabs */}
      <div className="flex items-center justify-center mb-4">
        <div className="bg-gray-100 rounded-full p-1 flex">
          <button
            onClick={() => { setMode('checkin'); setCheckedMembers(new Set()); clearKioskSelection(selectedGathering.id, gatheringDate); }}
            className={`px-3 sm:px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              mode === 'checkin'
                ? 'bg-primary-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Check In{notCheckedInCount > 0 ? ` (${notCheckedInCount})` : ''}
          </button>
          <button
            onClick={() => { setMode('present'); setCheckedMembers(new Set()); clearKioskSelection(selectedGathering.id, gatheringDate); }}
            className={`px-3 sm:px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              mode === 'present'
                ? 'bg-green-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Present{presentCount > 0 ? ` (${presentCount})` : ''}
          </button>
          <button
            onClick={() => { setMode('checkout'); setCheckedMembers(new Set()); clearKioskSelection(selectedGathering.id, gatheringDate); }}
            className={`px-3 sm:px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              mode === 'checkout'
                ? 'bg-orange-500 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Check Out
          </button>
          <button
            onClick={() => { setMode('checkedout'); setCheckedMembers(new Set()); clearKioskSelection(selectedGathering.id, gatheringDate); }}
            className={`px-3 sm:px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              mode === 'checkedout'
                ? 'bg-gray-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Left{checkedOutCount > 0 ? ` (${checkedOutCount})` : ''}
          </button>
        </div>
      </div>

      {/* Selection toast */}
      {selectionToast && (
        <div className="mb-3 flex justify-center">
          <div className="rounded-lg px-3 py-1.5 text-xs animate-pulse" style={{ backgroundColor: '#fce4ef', border: '1px solid #ec75a6', color: '#b5446e' }}>
            {selectionToast}
          </div>
        </div>
      )}

      {/* Success */}
      {successMessage && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700 flex items-center justify-between">
          <div className="flex items-center">
            <CheckCircleIcon className="h-5 w-5 text-green-500 mr-2 flex-shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="text-green-400 hover:text-green-600">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-600">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Search */}
      <div className="flex justify-center mb-4">
        <div className="relative w-full max-w-md">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="shadow-sm focus:ring-primary-500 focus:border-primary-500 block w-full pl-10 pr-3 py-2 sm:text-sm border border-gray-300 rounded-md"
            placeholder="Search by name or family..."
            autoComplete="off"
          />
        </div>
      </div>

      {/* Group by family checkbox */}
      <div className="flex justify-center mb-4">
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={groupByFamily}
            onChange={(e) => setGroupByFamily(e.target.checked)}
            className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          />
          <span className="ml-2 text-sm text-gray-700">Group people by family</span>
        </label>
      </div>

      {/* Family list / Individual grid */}
      <div className="space-y-4">
        {(groupByFamily ? filteredFamilies.length === 0 : filteredIndividuals.length === 0) ? (
          <p className="text-sm text-gray-500 text-center py-8">
            {searchTerm.trim()
              ? 'No matching people found.'
              : mode === 'checkin'
              ? 'Everyone has been checked in.'
              : mode === 'present'
              ? 'No one is present yet.'
              : mode === 'checkout'
              ? 'No one is available to check out.'
              : 'No one has been checked out.'}
          </p>
        ) : groupByFamily ? (
          filteredFamilies.map(group => {
            const isRealFamily = group.familyId > 0;
            const familyDisplayName = (() => {
              const parts = group.familyName.split(', ');
              if (parts.length >= 2) {
                return `${parts[0].toUpperCase()}, ${parts.slice(1).join(', ')}`;
              }
              return group.familyName;
            })();
            const isUndoTab = mode === 'present' || mode === 'checkedout';

            // Check if any member in this family is selected by another leader
            const familyOtherLeaders = new Set<string>();
            group.members.forEach(m => {
              const names = selectedByOthers.get(m.id);
              if (names) names.forEach(n => familyOtherLeaders.add(n));
            });
            const isFamilySelectedByOther = familyOtherLeaders.size > 0;

            let familyCardClasses = '';
            if (isRealFamily) {
              familyCardClasses = isFamilySelectedByOther
                ? 'relative rounded-lg p-4 pb-5 mb-1'
                : 'bg-white border border-gray-200 rounded-lg p-4';
            }

            return (
              <div
                key={group.familyId}
                className={familyCardClasses}
                style={isRealFamily && isFamilySelectedByOther ? { backgroundColor: '#fce4ef', border: '2px solid #ec75a6' } : undefined}
              >
                {/* Other-leader name bump — sits on the bottom border, centered */}
                {isRealFamily && isFamilySelectedByOther && (
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 whitespace-nowrap text-white text-[9px] font-medium px-1.5 py-0.5 rounded-full shadow-sm z-10" style={{ backgroundColor: '#ec75a6' }}>
                    {Array.from(familyOtherLeaders).join(', ')}
                  </div>
                )}
                {/* For solo (non-family) tiles selected by another leader */}
                {!isRealFamily && isFamilySelectedByOther && (
                  <div className="relative">
                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 translate-y-1/2 whitespace-nowrap text-white text-[9px] font-medium px-1.5 py-0.5 rounded-full shadow-sm z-10" style={{ backgroundColor: '#ec75a6' }}>
                      {Array.from(familyOtherLeaders).join(', ')}
                    </div>
                  </div>
                )}
                {isRealFamily && (
                  <div className="flex justify-between items-center mb-3">
                    <h4 className="text-md font-medium text-gray-900">{familyDisplayName}</h4>
                    {group.members.length > 1 && (
                      <button
                        onClick={() => {
                          const allSelected = group.members.every(m => checkedMembers.has(m.id));
                          setCheckedMembers(prev => {
                            const next = new Set(prev);
                            if (allSelected) {
                              group.members.forEach(m => next.delete(m.id));
                            } else {
                              group.members.forEach(m => next.add(m.id));
                            }
                            return next;
                          });
                        }}
                        className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md transition-colors bg-primary-50 text-primary-700 hover:bg-primary-100 border border-primary-200 hover:border-primary-300"
                      >
                        {group.members.every(m => checkedMembers.has(m.id)) ? 'Uncheck all family' : 'Check all family'}
                      </button>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-3 gap-y-6">
                  {group.members.map(member => {
                    const isChecked = checkedMembers.has(member.id);
                    const badgeInfo = getBadgeInfo(member);
                    const displayName = getPersonDisplayName(member, isRealFamily ? group.familyName : undefined);
                    const otherLeaderNames = selectedByOthers.get(member.id);
                    const isSelectedByOther = otherLeaderNames && otherLeaderNames.length > 0;

                    // Card styling matching AttendancePage
                    let cardClasses = 'relative flex items-center transition-colors p-3 rounded-md border-2 bg-white cursor-pointer';
                    if (mode === 'present' && isChecked) {
                      cardClasses += ' border-red-400 bg-red-50';
                    } else if (mode === 'present') {
                      cardClasses += ' border-primary-500 bg-primary-50';
                    } else if (mode === 'checkedout' && isChecked) {
                      cardClasses += ' border-red-400 bg-red-50';
                    } else if (mode === 'checkedout') {
                      cardClasses += ' border-gray-200';
                    } else if (isChecked) {
                      cardClasses += mode === 'checkin'
                        ? ' border-primary-500 bg-primary-50 cursor-pointer'
                        : ' border-orange-500 bg-orange-50 cursor-pointer';
                    } else {
                      cardClasses += ' border-gray-200 hover:border-gray-300 cursor-pointer';
                    }

                    // All tabs are selectable
                    return (
                      <label key={member.id} className={cardClasses}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleMember(member.id)}
                          className="sr-only"
                        />
                        <div
                          className={`flex-shrink-0 h-5 w-5 rounded border-2 flex items-center justify-center ${
                            isUndoTab
                              ? (isChecked
                                  ? 'bg-red-500 border-red-500'
                                  : (mode === 'present' ? 'bg-primary-600 border-primary-600' : 'bg-gray-400 border-gray-400'))
                              : isChecked
                                ? (mode === 'checkin' ? 'bg-primary-600 border-primary-600' : 'bg-orange-500 border-orange-500')
                                : !isSelectedByOther
                                  ? 'border-gray-300'
                                  : ''
                          }`}
                          style={!isChecked && isSelectedByOther && !isUndoTab ? { backgroundColor: '#f8c8da', borderColor: '#ec75a6' } : undefined}
                        >
                          {isUndoTab && !isChecked && (
                            <CheckIcon className="h-3 w-3 text-white" />
                          )}
                          {isUndoTab && isChecked && (
                            <XMarkIcon className="h-3 w-3 text-white" />
                          )}
                          {!isUndoTab && isChecked && (
                            <CheckIcon className="h-3 w-3 text-white" />
                          )}
                          {!isUndoTab && !isChecked && isSelectedByOther && (
                            <CheckIcon className="h-3 w-3 opacity-50" style={{ color: '#ec75a6' }} />
                          )}
                        </div>
                        <span className="ml-3 text-sm font-medium text-gray-900">
                          {displayName}
                        </span>
                        {badgeInfo && (
                          <span
                            className={`flex-shrink-0 ml-auto sm:absolute sm:right-3 sm:top-0 sm:-translate-y-1/2 flex items-center space-x-1 shadow-sm ${
                              badgeInfo.text ? 'px-2 py-1 rounded-full' : 'w-6 h-6 justify-center rounded-full'
                            }`}
                            style={badgeInfo.styles}
                          >
                            {badgeInfo.icon && (
                              <BadgeIcon type={badgeInfo.icon as BadgeIconType} className="w-4 h-4 flex-shrink-0" />
                            )}
                            {badgeInfo.text && (
                              <span className="text-xs font-medium whitespace-nowrap">{badgeInfo.text}</span>
                            )}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-3 gap-y-6">
            {filteredIndividuals.map(member => {
              const isChecked = checkedMembers.has(member.id);
              const badgeInfo = getBadgeInfo(member);
              const displayName = getPersonDisplayName(member);
              const otherLeaderNames = selectedByOthers.get(member.id);
              const isSelectedByOther = otherLeaderNames && otherLeaderNames.length > 0;
              const isUndoTab = mode === 'present' || mode === 'checkedout';

              let cardClasses = 'relative flex items-center transition-colors p-3 rounded-md border-2 bg-white cursor-pointer';
              if (mode === 'present' && isChecked) {
                cardClasses += ' border-red-400 bg-red-50';
              } else if (mode === 'present') {
                cardClasses += ' border-primary-500 bg-primary-50';
              } else if (mode === 'checkedout' && isChecked) {
                cardClasses += ' border-red-400 bg-red-50';
              } else if (mode === 'checkedout') {
                cardClasses += ' border-gray-200';
              } else if (isChecked) {
                cardClasses += mode === 'checkin'
                  ? ' border-primary-500 bg-primary-50 cursor-pointer'
                  : ' border-orange-500 bg-orange-50 cursor-pointer';
              } else {
                cardClasses += ' border-gray-200 hover:border-gray-300 cursor-pointer';
              }

              return (
                <label key={member.id} className={cardClasses}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleMember(member.id)}
                    className="sr-only"
                  />
                  <div
                    className={`flex-shrink-0 h-5 w-5 rounded border-2 flex items-center justify-center ${
                      isUndoTab
                        ? (isChecked
                            ? 'bg-red-500 border-red-500'
                            : (mode === 'present' ? 'bg-primary-600 border-primary-600' : 'bg-gray-400 border-gray-400'))
                        : isChecked
                          ? (mode === 'checkin' ? 'bg-primary-600 border-primary-600' : 'bg-orange-500 border-orange-500')
                          : !isSelectedByOther
                            ? 'border-gray-300'
                            : ''
                    }`}
                    style={!isChecked && isSelectedByOther && !isUndoTab ? { backgroundColor: '#f8c8da', borderColor: '#ec75a6' } : undefined}
                  >
                    {isUndoTab && !isChecked && (
                      <CheckIcon className="h-3 w-3 text-white" />
                    )}
                    {isUndoTab && isChecked && (
                      <XMarkIcon className="h-3 w-3 text-white" />
                    )}
                    {!isUndoTab && isChecked && (
                      <CheckIcon className="h-3 w-3 text-white" />
                    )}
                    {!isUndoTab && !isChecked && isSelectedByOther && (
                      <CheckIcon className="h-3 w-3 opacity-50" style={{ color: '#ec75a6' }} />
                    )}
                  </div>
                  <span className="ml-3 text-sm font-medium text-gray-900">
                    {displayName}
                  </span>
                  {badgeInfo && (
                    <span
                      className={`flex-shrink-0 ml-auto sm:absolute sm:right-3 sm:top-0 sm:-translate-y-1/2 flex items-center space-x-1 shadow-sm ${
                        badgeInfo.text ? 'px-2 py-1 rounded-full' : 'w-6 h-6 justify-center rounded-full'
                      }`}
                      style={badgeInfo.styles}
                    >
                      {badgeInfo.icon && (
                        <BadgeIcon type={badgeInfo.icon as BadgeIconType} className="w-4 h-4 flex-shrink-0" />
                      )}
                      {badgeInfo.text && (
                        <span className="text-xs font-medium whitespace-nowrap">{badgeInfo.text}</span>
                      )}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Visitor button */}
      {mode === 'checkin' && (
        <div className="mt-4">
          <button
            onClick={() => {
              setShowAddVisitorModal(true);
              setVisitorPersons([{ firstName: '', lastName: '' }]);
              setGuardianName('');
              setGuardianContact('');
              setError('');
            }}
            className="w-full flex items-center justify-center px-4 py-2.5 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-primary-300 hover:text-primary-600 transition-colors"
          >
            <PlusIcon className="h-4 w-4 mr-1.5" />
            Add Visitor
          </button>
        </div>
      )}

      {/* Floating action button */}
      {checkedMembers.size > 0 && (
        <div className="fixed bottom-6 right-6 z-40">
          {(mode === 'checkin' || mode === 'checkout') ? (
            <button
              onClick={() => setShowModal(true)}
              className={`px-6 py-3 rounded-full text-white font-medium shadow-lg transition-colors ${
                mode === 'checkin'
                  ? 'bg-primary-600 hover:bg-primary-700'
                  : 'bg-orange-500 hover:bg-orange-600'
              }`}
            >
              {mode === 'checkin' ? 'Check In' : 'Check Out'} ({checkedMembers.size})
            </button>
          ) : (
            <button
              onClick={() => setShowUndoModal(true)}
              className="px-6 py-3 rounded-full text-white font-medium shadow-lg transition-colors bg-red-500 hover:bg-red-600"
            >
              {mode === 'present' ? 'Undo Check In' : 'Undo Check Out'} ({checkedMembers.size})
            </button>
          )}
        </div>
      )}

      {/* Leader Check-in Modal */}
      <LeaderCheckInModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        selectedPeople={selectedPeople}
        action={mode === 'checkout' ? 'checkout' : 'checkin'}
        onConfirm={handleConfirm}
      />

      {/* Undo confirmation modal */}
      <Modal isOpen={showUndoModal} onClose={() => setShowUndoModal(false)}>
        <div className="relative bg-white rounded-lg shadow-xl max-w-sm w-full mx-4">
          <div className="p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {mode === 'present' ? 'Undo Check In?' : 'Undo Check Out?'}
            </h3>
            <p className="text-sm text-gray-600 mb-1">
              {mode === 'present'
                ? `This will mark ${checkedMembers.size === 1 ? 'this person' : `these ${checkedMembers.size} people`} as not checked in.`
                : `This will move ${checkedMembers.size === 1 ? 'this person' : `these ${checkedMembers.size} people`} back to Present.`}
            </p>
            <div className="mb-4 text-sm text-gray-500">
              {selectedPeople.map(p => (
                <span key={p.id} className="inline-block mr-2">
                  &bull; {p.firstName} {p.lastName}
                </span>
              ))}
            </div>
            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            <div className="flex space-x-3">
              <button
                onClick={() => { setShowUndoModal(false); setError(''); }}
                className="flex-1 px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleUndo}
                disabled={isUndoing}
                className="flex-1 px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-500 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isUndoing ? 'Processing...' : 'Yes, Undo'}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Add Visitor Modal */}
      <Modal
        isOpen={showAddVisitorModal}
        onClose={() => setShowAddVisitorModal(false)}
      >
        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">Add New Visitor Child</h3>
              <button onClick={() => setShowAddVisitorModal(false)} className="text-gray-400 hover:text-gray-600">
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="space-y-5">
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3 uppercase tracking-wide">Visitor Child Details</h4>
                <div className="space-y-3">
                  {visitorPersons.map((person, idx) => (
                    <div key={idx} className="space-y-2">
                      {visitorPersons.length > 1 && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-700">Child {idx + 1}</span>
                          <button
                            onClick={() => setVisitorPersons(prev => prev.filter((_, i) => i !== idx))}
                            className="text-xs text-red-500 hover:text-red-700"
                          >
                            Remove
                          </button>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">First Name</label>
                          <input
                            type="text"
                            value={person.firstName}
                            onChange={(e) => {
                              const updated = [...visitorPersons];
                              updated[idx] = { ...updated[idx], firstName: e.target.value };
                              setVisitorPersons(updated);
                            }}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            placeholder="First name"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Last Name</label>
                          <input
                            type="text"
                            value={person.lastName}
                            onChange={(e) => {
                              const updated = [...visitorPersons];
                              updated[idx] = { ...updated[idx], lastName: e.target.value };
                              setVisitorPersons(updated);
                            }}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            placeholder="Last name"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setVisitorPersons(prev => [...prev, { firstName: '', lastName: '' }])}
                    className="text-sm text-primary-600 hover:text-primary-700 font-medium"
                  >
                    + Add another child
                  </button>
                </div>
              </div>

              <div className="border-t border-gray-200" />

              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3 uppercase tracking-wide">Parent / Guardian Details</h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Parent/Guardian Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={guardianName}
                      onChange={(e) => setGuardianName(e.target.value)}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                      placeholder="Full name of parent or guardian"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Contact Number</label>
                    <input
                      type="tel"
                      value={guardianContact}
                      onChange={(e) => setGuardianContact(e.target.value)}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                      placeholder="Phone number"
                    />
                    <p className="mt-1 text-xs text-gray-500">For emergency contact purposes.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 flex space-x-3">
              <button
                onClick={() => setShowAddVisitorModal(false)}
                className="flex-1 px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAddVisitor}
                disabled={isAddingVisitor || visitorPersons.every(p => !p.firstName.trim() || !p.lastName.trim()) || !guardianName.trim()}
                className="flex-1 px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isAddingVisitor ? (
                  <>
                    <ArrowPathIcon className="inline h-4 w-4 mr-1 animate-spin" />
                    Adding...
                  </>
                ) : (
                  'Add & Check In'
                )}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default LeaderCheckInMode;
