import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useCheckIns } from '../../contexts/CheckInsContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { gatheringsAPI, attendanceAPI, familiesAPI, kioskAPI, GatheringType, Individual } from '../../services/api';
import {
  MagnifyingGlassIcon,
  PlusIcon,
  CheckCircleIcon,
  XMarkIcon,
  ArrowPathIcon,
  LockClosedIcon,
  LockOpenIcon,
  ArrowRightOnRectangleIcon,
} from '@heroicons/react/24/outline';
import Modal from '../Modal';

interface FamilyGroup {
  familyId: number;
  familyName: string;
  members: Individual[];
}

/**
 * Lightweight markdown renderer for welcome messages.
 * Supports: **bold**, *italic*, # headings (h1-h3), [links](url), line breaks.
 */
function renderMarkdown(text: string): string {
  return text
    .split('\n')
    .map(line => {
      // Headings
      if (line.startsWith('### ')) return `<h3 class="text-xl font-semibold">${escapeAndInline(line.slice(4))}</h3>`;
      if (line.startsWith('## ')) return `<h2 class="text-2xl font-bold">${escapeAndInline(line.slice(3))}</h2>`;
      if (line.startsWith('# ')) return `<h1 class="text-4xl font-bold">${escapeAndInline(line.slice(2))}</h1>`;
      // Empty line -> spacer
      if (line.trim() === '') return '<div class="h-2"></div>';
      // Regular line with inline formatting
      return `<p>${escapeAndInline(line)}</p>`;
    })
    .join('');
}

function escapeAndInline(text: string): string {
  // Escape HTML entities
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="underline text-primary-600" target="_blank" rel="noopener noreferrer">$1</a>');
  // Bold: **text**
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic: *text*
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  return s;
}

type KioskPhase = 'setup' | 'pin' | 'active';
type KioskMode = 'checkin' | 'checkout';

// ===== Offline caching helpers =====
const KIOSK_ATTENDANCE_CACHE_KEY = 'kiosk_attendance_cache';
const KIOSK_OFFLINE_QUEUE_KEY = 'kiosk_offline_queue';

function cacheAttendanceData(gatheringId: number, date: string, attendanceList: Individual[], familyGroups: FamilyGroup[]) {
  try {
    const data = { gatheringId, date, attendanceList, familyGroups, timestamp: Date.now() };
    localStorage.setItem(KIOSK_ATTENDANCE_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or unavailable
  }
}

function loadCachedAttendanceData(gatheringId: number, date: string): { attendanceList: Individual[]; familyGroups: FamilyGroup[] } | null {
  try {
    const raw = localStorage.getItem(KIOSK_ATTENDANCE_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.gatheringId === gatheringId && data.date === date) {
      return { attendanceList: data.attendanceList, familyGroups: data.familyGroups };
    }
  } catch {
    // Corrupted cache
  }
  return null;
}

interface OfflineSubmission {
  gatheringId: number;
  date: string;
  data: { individualIds: number[]; action: string; signerName?: string };
  timestamp: number;
}

function queueOfflineSubmission(gatheringId: number, date: string, data: { individualIds: number[]; action: string; signerName?: string }) {
  try {
    const queue: OfflineSubmission[] = JSON.parse(localStorage.getItem(KIOSK_OFFLINE_QUEUE_KEY) || '[]');
    queue.push({ gatheringId, date, data, timestamp: Date.now() });
    localStorage.setItem(KIOSK_OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full
  }
}

async function syncOfflineQueue(): Promise<number> {
  let synced = 0;
  try {
    const queue: OfflineSubmission[] = JSON.parse(localStorage.getItem(KIOSK_OFFLINE_QUEUE_KEY) || '[]');
    if (queue.length === 0) return 0;

    const remaining: OfflineSubmission[] = [];
    for (const item of queue) {
      try {
        await kioskAPI.record(item.gatheringId, item.date, item.data as any);
        synced++;
      } catch {
        remaining.push(item);
      }
    }
    localStorage.setItem(KIOSK_OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
  } catch {
    // Parse error
  }
  return synced;
}

interface SelfCheckInModeProps {
  selectedGathering: GatheringType;
  gatheringDate: string;
  daysAway: number;
  onBack: () => void;
}

const SelfCheckInMode: React.FC<SelfCheckInModeProps> = ({
  selectedGathering,
  gatheringDate,
  daysAway,
  onBack,
}) => {
  const { logout } = useAuth();
  const checkIns = useCheckIns();
  const { isConnected, socket, sendKioskAction, onAttendanceUpdate, onKioskCheckout, onReconnect } = useWebSocket();

  // ===== Phase management =====
  const [phase, setPhase] = useState<KioskPhase>(checkIns.isLocked ? 'active' : 'setup');

  // ===== Setup phase state =====
  const [startTime, setStartTime] = useState(() => {
    if (checkIns.startTime) return checkIns.startTime;
    if (selectedGathering.startTime) return selectedGathering.startTime.substring(0, 5);
    return '10:00';
  });
  const [endTime, setEndTime] = useState(() => {
    if (checkIns.endTime) return checkIns.endTime;
    if (selectedGathering.endTime) return selectedGathering.endTime.substring(0, 5);
    // Default: 1 hour after start
    const st = selectedGathering.startTime ? selectedGathering.startTime.substring(0, 5) : '10:00';
    const [h, m] = st.split(':').map(Number);
    const endH = (h + 1) % 24;
    return `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  });
  const [customMessage, setCustomMessage] = useState(() => {
    if (checkIns.customMessage) return checkIns.customMessage;
    if (selectedGathering.kioskMessage) return selectedGathering.kioskMessage;
    return 'Welcome\nPlease use this to sign in/out';
  });

  // ===== PIN state =====
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState('');

  // ===== Unlock state =====
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [unlockPinInput, setUnlockPinInput] = useState('');
  const [unlockError, setUnlockError] = useState('');

  // ===== Check-in / Check-out mode =====
  const [mode, setMode] = useState<KioskMode>('checkin');

  // ===== Attendance data =====
  const [attendanceList, setAttendanceList] = useState<Individual[]>([]);
  const [familyGroups, setFamilyGroups] = useState<FamilyGroup[]>([]);

  // ===== Search and selection =====
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFamily, setSelectedFamily] = useState<FamilyGroup | null>(null);
  const [checkedMembers, setCheckedMembers] = useState<Set<number>>(new Set());
  const [signerName, setSignerName] = useState('');

  // ===== Submission state =====
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [error, setError] = useState('');
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [refreshCountdown, setRefreshCountdown] = useState(5);

  // ===== Add visitor modal =====
  const [showAddVisitorModal, setShowAddVisitorModal] = useState(false);
  const [visitorPersons, setVisitorPersons] = useState([{ firstName: '', lastName: '' }]);
  const [isAddingVisitor, setIsAddingVisitor] = useState(false);
  const [guardianName, setGuardianName] = useState('');
  const [guardianContact, setGuardianContact] = useState('');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // ===== iOS viewport fix: prevent over-scrolling when inputs are focused =====
  useEffect(() => {
    if (phase !== 'active') return;

    const handleFocusIn = (e: Event) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      // Wait for iOS to finish its scroll adjustment, then correct if no keyboard
      setTimeout(() => {
        const vv = window.visualViewport;
        if (vv) {
          const keyboardHeight = window.innerHeight - vv.height;
          // If no substantial keyboard (< 100px), the shift was unwarranted
          if (keyboardHeight < 100 && scrollContainerRef.current) {
            // Gently scroll the input into view within our container instead
            (e.target as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        }
      }, 350);
    };

    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, [phase]);

  // ===== Pre-populate settings from gathering (only in setup phase) =====
  useEffect(() => {
    if (phase === 'setup') {
      if (selectedGathering.endTime) {
        setEndTime(selectedGathering.endTime.substring(0, 5));
      }
      if (selectedGathering.kioskMessage) {
        setCustomMessage(selectedGathering.kioskMessage);
      }
    }
  }, [selectedGathering, phase]);

  // ===== Time-based mode defaulting =====
  const computeDefaultMode = useCallback((): KioskMode => {
    const now = new Date();
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);

    const startDate = new Date(now);
    startDate.setHours(sh, sm, 0, 0);
    const endDate = new Date(now);
    endDate.setHours(eh, em, 0, 0);

    const checkoutThreshold = new Date(endDate.getTime() - 15 * 60 * 1000);

    if (now >= checkoutThreshold) {
      return 'checkout';
    }
    return 'checkin';
  }, [startTime, endTime]);

  // Set default mode on entry, then auto-switch every 15 minutes
  const modeTimerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (phase !== 'active') return;

    setMode(computeDefaultMode());

    modeTimerRef.current = setInterval(() => {
      setMode(computeDefaultMode());
    }, 15 * 60 * 1000);

    return () => {
      if (modeTimerRef.current) clearInterval(modeTimerRef.current);
    };
  }, [phase, computeDefaultMode]);

  // If we're already locked (e.g., page reload), restore state from context
  useEffect(() => {
    if (checkIns.isLocked && checkIns.gatheringId) {
      setPhase('active');
      if (checkIns.startTime) setStartTime(checkIns.startTime);
      if (checkIns.endTime) setEndTime(checkIns.endTime);
      if (checkIns.customMessage) setCustomMessage(checkIns.customMessage);
    }
  }, [checkIns.isLocked, checkIns.gatheringId]);

  // ===== Load attendance list when gathering selected and active =====
  const loadAttendance = useCallback(async () => {
    if (!selectedGathering) return;
    try {
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
            familyId: v.familyId,
            familyName: v.familyName,
            present: Boolean(v.present),
          });
        }
      }

      const potentialVisitors: any[] = response.data.potentialVisitors || [];
      for (const v of potentialVisitors) {
        const id = v.id;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          const nameParts = (v.name || '').split(' ');
          allPeople.push({
            id,
            firstName: v.firstName || nameParts[0] || '',
            lastName: v.lastName || nameParts.slice(1).join(' ') || '',
            peopleType: v.peopleType || 'local_visitor',
            familyId: v.familyId,
            familyName: v.familyName,
            present: false,
          });
        }
      }

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
      const familyGroupList = Object.values(groups);
      setFamilyGroups(familyGroupList);

      // Cache for offline use
      cacheAttendanceData(selectedGathering.id, gatheringDate, allPeople, familyGroupList);
    } catch (err) {
      // Try loading from cache when offline
      const cached = loadCachedAttendanceData(selectedGathering.id, gatheringDate);
      if (cached) {
        setAttendanceList(cached.attendanceList);
        setFamilyGroups(cached.familyGroups);
      } else {
        setError('Failed to load attendance data.');
      }
    }
  }, [selectedGathering, gatheringDate]);

  useEffect(() => {
    if (phase === 'active') {
      loadAttendance();
    }
  }, [phase, loadAttendance]);

  // ===== WebSocket: subscribe to attendance updates from other devices =====
  useEffect(() => {
    return onAttendanceUpdate((data) => {
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
      setSelectedFamily(prev => {
        if (!prev) return prev;
        const updated = prev.members.some(m => data.records!.find(r => r.individualId === m.id));
        if (!updated) return prev;
        return {
          ...prev,
          members: prev.members.map(m => {
            const rec = data.records!.find(r => r.individualId === m.id);
            return rec ? { ...m, present: Boolean(rec.present) } : m;
          }),
        };
      });
    });
  }, [onAttendanceUpdate, selectedGathering.id, gatheringDate]);

  // ===== WebSocket: subscribe to kiosk checkout events =====
  useEffect(() => {
    return onKioskCheckout((data) => {
      if (String(data.gatheringId) !== String(selectedGathering.id) || data.date !== gatheringDate) return;
      const ids = data.individualIds || [];
      setAttendanceList(prev =>
        prev.map(p => ids.includes(p.id) ? { ...p, present: false } : p)
      );
      setFamilyGroups(prev =>
        prev.map(fg => ({
          ...fg,
          members: fg.members.map(m => ids.includes(m.id) ? { ...m, present: false } : m),
        }))
      );
      setSelectedFamily(prev => {
        if (!prev) return prev;
        const affected = prev.members.some(m => ids.includes(m.id));
        if (!affected) return prev;
        return {
          ...prev,
          members: prev.members.map(m => ids.includes(m.id) ? { ...m, present: false } : m),
        };
      });
    });
  }, [onKioskCheckout, selectedGathering.id, gatheringDate]);

  // ===== WebSocket: refresh data on reconnect =====
  useEffect(() => {
    return onReconnect(() => {
      loadAttendance();
    });
  }, [onReconnect, loadAttendance]);

  // ===== Offline queue sync interval =====
  useEffect(() => {
    if (phase !== 'active') return;

    const doSync = async () => {
      const synced = await syncOfflineQueue();
      if (synced > 0) {
        // Refresh attendance data after successful sync
        loadAttendance();
      }
    };

    // Sync every 30 seconds
    const syncInterval = setInterval(doSync, 30000);

    // Also sync when coming back online
    const handleOnline = () => {
      setTimeout(doSync, 1000);
    };
    window.addEventListener('online', handleOnline);

    // Try an initial sync on mount
    doSync();

    return () => {
      clearInterval(syncInterval);
      window.removeEventListener('online', handleOnline);
    };
  }, [phase, loadAttendance]);

  // ===== Filter families by search =====
  const filteredFamilies = useMemo(() => {
    if (searchTerm.trim().length < 1) return [];

    const term = searchTerm.toLowerCase();
    let results = familyGroups.filter(g => {
      if (g.familyName.toLowerCase().includes(term)) return true;
      return g.members.some(m =>
        `${m.firstName} ${m.lastName}`.toLowerCase().includes(term)
      );
    });

    // In checkout mode, only show families with at least one present member
    if (mode === 'checkout') {
      results = results.filter(g => g.members.some(m => m.present));
    }

    return results;
  }, [searchTerm, familyGroups, mode]);

  // ===== Select a family =====
  const handleSelectFamily = (group: FamilyGroup) => {
    setSelectedFamily(group);
    setSearchTerm('');

    if (mode === 'checkin') {
      setCheckedMembers(new Set());
    } else {
      const toCheck = new Set<number>();
      for (const m of group.members) {
        if (m.present) toCheck.add(m.id);
      }
      setCheckedMembers(toCheck);
    }
  };

  // ===== Toggle a member checkbox =====
  const toggleMember = (id: number) => {
    setCheckedMembers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ===== Submit sign-in / sign-out =====
  const handleSubmit = async () => {
    if (!selectedGathering || !selectedFamily) return;
    if (checkedMembers.size === 0) {
      setError(`Please select at least one person to ${mode === 'checkin' ? 'sign in' : 'sign out'}.`);
      return;
    }

    try {
      setIsSubmitting(true);
      setError('');

      const ids = Array.from(checkedMembers);
      const apiAction = mode === 'checkin' ? 'checkin' as const : 'checkout' as const;
      const signer = signerName.trim() || '';

      // WebSocket-first, REST fallback, offline queue last resort
      if (isConnected && socket) {
        try {
          await sendKioskAction(selectedGathering.id, gatheringDate, ids, apiAction, signer);
        } catch {
          try {
            await kioskAPI.record(selectedGathering.id, gatheringDate, {
              individualIds: ids, action: apiAction, signerName: signer || undefined,
            });
          } catch {
            queueOfflineSubmission(selectedGathering.id, gatheringDate, {
              individualIds: ids, action: apiAction, signerName: signer || undefined,
            });
          }
        }
      } else {
        try {
          await kioskAPI.record(selectedGathering.id, gatheringDate, {
            individualIds: ids, action: apiAction, signerName: signer || undefined,
          });
        } catch {
          queueOfflineSubmission(selectedGathering.id, gatheringDate, {
            individualIds: ids, action: apiAction, signerName: signer || undefined,
          });
        }
      }

      // Optimistically update local state
      if (mode === 'checkin') {
        const updatedList = attendanceList.map(p =>
          checkedMembers.has(p.id) ? { ...p, present: true } : p
        );
        setAttendanceList(updatedList);

        const updatedGroups = familyGroups.map(fg => ({
          ...fg,
          members: fg.members.map(m =>
            checkedMembers.has(m.id) ? { ...m, present: true } : m
          ),
        }));
        setFamilyGroups(updatedGroups);

        // Update cache with optimistic changes
        cacheAttendanceData(selectedGathering.id, gatheringDate, updatedList, updatedGroups);
      }

      const names = selectedFamily.members
        .filter(m => checkedMembers.has(m.id))
        .map(m => m.firstName)
        .join(' and ');

      const verb = mode === 'checkin' ? 'signed in' : 'signed out';
      setSuccessMessage(`You have successfully ${verb} ${names}!`);
      setSelectedFamily(null);
      setCheckedMembers(new Set());
      setSignerName('');
      startCountdown();
    } catch (err: any) {
      setError(err.response?.data?.error || `Failed to ${mode === 'checkin' ? 'sign in' : 'sign out'}. Please try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ===== Countdown and reset =====
  const startCountdown = () => {
    setRefreshCountdown(5);
    const interval = setInterval(() => {
      setRefreshCountdown(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          resetKiosk();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    refreshTimerRef.current = interval;
  };

  const resetKiosk = () => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    setSuccessMessage(null);
    setSelectedFamily(null);
    setCheckedMembers(new Set());
    setSignerName('');
    setSearchTerm('');
    setRefreshCountdown(5);
    loadAttendance();
    setTimeout(() => searchInputRef.current?.focus(), 100);
  };

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, []);

  // ===== Setup: enter check-in mode -> go to PIN =====
  const handleEnterCheckInMode = async () => {
    // Save kiosk settings to gathering for future use via dedicated endpoint
    try {
      await gatheringsAPI.updateKioskSettings(selectedGathering.id, {
        endTime: endTime,
        kioskMessage: customMessage,
      });
    } catch (err) {
      console.error('Failed to save check-in settings:', err);
    }

    setPhase('pin');
    setPinInput('');
    setPinConfirm('');
    setPinError('');
  };

  // ===== PIN: confirm and lock =====
  const handleSetPin = () => {
    if (pinInput.length < 4) {
      setPinError('PIN must be at least 4 digits.');
      return;
    }
    if (pinInput !== pinConfirm) {
      setPinError('PINs do not match.');
      return;
    }
    // Lock - includes customMessage for session persistence
    checkIns.lock(pinInput, selectedGathering.id, selectedGathering.name, startTime, endTime, customMessage);
    setPhase('active');
  };

  // ===== Unlock =====
  const handleUnlock = () => {
    const success = checkIns.unlock(unlockPinInput);
    if (success) {
      setShowUnlockModal(false);
      setUnlockPinInput('');
      setUnlockError('');
      setPhase('setup');
    } else {
      setUnlockError('Incorrect PIN.');
    }
  };

  const handleForceUnlockAndLogout = async () => {
    checkIns.forceUnlock();
    setShowUnlockModal(false);
    await logout();
    window.location.href = '/login';
  };

  // ===== Add visitor handler =====
  const handleAddVisitor = async () => {
    if (!selectedGathering) return;
    const validPersons = visitorPersons.filter(p => p.firstName.trim() && p.lastName.trim());
    if (validPersons.length === 0) {
      setError('Please enter at least one child name.');
      return;
    }
    if (!guardianName.trim()) {
      setError('Please enter the parent/guardian name.');
      return;
    }

    // Adding visitors requires internet
    if (!navigator.onLine) {
      setError('Adding new visitors requires an internet connection. Please check your connection and try again.');
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
        try {
          await kioskAPI.record(selectedGathering.id, gatheringDate, {
            individualIds,
            action: 'checkin',
            signerName: guardianName.trim(),
          });
        } catch (err) {
          // Queue for offline sync
          queueOfflineSubmission(selectedGathering.id, gatheringDate, {
            individualIds,
            action: 'checkin',
            signerName: guardianName.trim(),
          });
        }
      }

      setShowAddVisitorModal(false);
      setVisitorPersons([{ firstName: '', lastName: '' }]);
      setGuardianName('');
      setGuardianContact('');
      await loadAttendance();

      const names = validPersons.map(p => p.firstName).join(' and ');
      setSuccessMessage(`${names} signed in by ${guardianName.trim()}!`);
      startCountdown();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to add visitor.');
    } finally {
      setIsAddingVisitor(false);
    }
  };

  const addVisitorPerson = () => {
    setVisitorPersons(prev => [...prev, { firstName: '', lastName: '' }]);
  };

  const removeVisitorPerson = (idx: number) => {
    setVisitorPersons(prev => prev.filter((_, i) => i !== idx));
  };

  // ===== RENDER: Setup phase =====
  if (phase === 'setup') {
    return (
      <div className="max-w-2xl mx-auto mt-8">
        <div className="text-center mb-6">
          <div className="mx-auto flex items-center justify-center h-14 w-14 rounded-full bg-primary-100 mb-3">
            <LockClosedIcon className="h-7 w-7 text-primary-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Self Check-in Setup</h1>
          <p className="text-sm text-gray-500 mt-1">Configure self sign-in for your gathering</p>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="bg-white shadow rounded-lg p-6 space-y-5">
          {/* Gathering display (already selected via props) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Gathering</label>
            <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
              <div className="font-medium text-gray-900">{selectedGathering.name}</div>
              {selectedGathering.dayOfWeek && (
                <div className="text-sm text-gray-500">{selectedGathering.dayOfWeek}</div>
              )}
            </div>
          </div>

          {/* Times */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="checkin-start" className="block text-sm font-medium text-gray-700 mb-1">
                Start Time
              </label>
              <input
                id="checkin-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              <label htmlFor="checkin-end" className="block text-sm font-medium text-gray-700 mb-1">
                End Time
              </label>
              <input
                id="checkin-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
          </div>

          <p className="text-xs text-gray-500">
            The check-in will default to Check In before the gathering and switch to Check Out 15 minutes before the end time.
          </p>

          {/* Custom Welcome Message */}
          <div>
            <label htmlFor="checkin-message" className="block text-sm font-medium text-gray-700 mb-1">
              Custom Welcome Message
            </label>
            <textarea
              id="checkin-message"
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              rows={4}
              placeholder="# Welcome&#10;Please use this to **sign in/out**"
              className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              Supports markdown: <code className="bg-gray-100 px-1 rounded">**bold**</code>, <code className="bg-gray-100 px-1 rounded">*italic*</code>, <code className="bg-gray-100 px-1 rounded"># Heading</code>, <code className="bg-gray-100 px-1 rounded">[link](url)</code>
            </p>
            {/* Live preview */}
            {customMessage.trim() && (
              <div className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <p className="text-xs font-medium text-gray-500 mb-2">Preview:</p>
                <div
                  className="text-center text-xl font-bold text-gray-800 leading-tight [&_h1]:text-2xl [&_h2]:text-lg [&_h3]:text-base [&_p]:mb-0.5 [&_a]:underline [&_a]:text-primary-600"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(customMessage) }}
                />
              </div>
            )}
          </div>

          {/* Show next gathering date info */}
          {daysAway > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
              Next gathering is on{' '}
              <span className="font-medium">
                {new Date(gatheringDate + 'T00:00:00').toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                })}
              </span>{' '}
              ({daysAway} day{daysAway !== 1 ? 's' : ''} away). Attendance will be recorded for that date.
            </div>
          )}

          {/* Enter Self Check-in Mode */}
          <div className="flex space-x-3">
            <button
              onClick={onBack}
              className="py-3 px-4 text-base font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleEnterCheckInMode}
              className="flex-1 py-3 px-4 text-base font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors flex items-center justify-center"
            >
              <LockClosedIcon className="h-5 w-5 mr-2" />
              Enter Self Check-in Mode
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== RENDER: PIN setup phase =====
  if (phase === 'pin') {
    return (
      <div className="max-w-sm mx-auto mt-12">
        <div className="text-center mb-6">
          <div className="mx-auto flex items-center justify-center h-14 w-14 rounded-full bg-primary-100 mb-3">
            <LockClosedIcon className="h-7 w-7 text-primary-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Set a PIN</h1>
          <p className="text-sm text-gray-500 mt-1">
            This PIN will be required to exit check-in mode
          </p>
        </div>

        <div className="bg-white shadow rounded-lg p-6 space-y-4">
          <div>
            <label htmlFor="pin-input" className="block text-sm font-medium text-gray-700 mb-1">
              Enter PIN (4+ digits)
            </label>
            <input
              id="pin-input"
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={pinInput}
              onChange={(e) => { setPinInput(e.target.value.replace(/\D/g, '')); setPinError(''); }}
              className="block w-full border-gray-300 rounded-lg shadow-sm focus:ring-primary-500 focus:border-primary-500 text-center text-2xl tracking-[0.5em] py-3"
              placeholder="----"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="pin-confirm" className="block text-sm font-medium text-gray-700 mb-1">
              Confirm PIN
            </label>
            <input
              id="pin-confirm"
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={pinConfirm}
              onChange={(e) => { setPinConfirm(e.target.value.replace(/\D/g, '')); setPinError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && handleSetPin()}
              className="block w-full border-gray-300 rounded-lg shadow-sm focus:ring-primary-500 focus:border-primary-500 text-center text-2xl tracking-[0.5em] py-3"
              placeholder="----"
            />
          </div>

          {pinError && (
            <p className="text-sm text-red-600 text-center">{pinError}</p>
          )}

          <div className="flex space-x-3">
            <button
              onClick={() => setPhase('setup')}
              className="flex-1 py-2.5 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Back
            </button>
            <button
              onClick={handleSetPin}
              disabled={pinInput.length < 4}
              className="flex-1 py-2.5 px-4 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              <LockClosedIcon className="h-4 w-4 mr-2" />
              Lock & Start
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== RENDER: Active check-in mode =====
  return (
    <div className="max-w-xl mx-auto" ref={scrollContainerRef}>
      {/* Unlock button (top-left) */}
      <button
        onClick={() => { setShowUnlockModal(true); setUnlockPinInput(''); setUnlockError(''); }}
        className="fixed top-4 left-4 z-50 p-2 text-gray-300 hover:text-gray-500 transition-colors"
        title="Unlock"
      >
        <LockOpenIcon className="h-5 w-5" />
      </button>

      {/* Header */}
      <div className="text-center mb-4">
        <h1 className="text-2xl font-bold text-gray-900">
          {selectedGathering?.name || checkIns.gatheringName}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {new Date(gatheringDate + 'T00:00:00').toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </p>
        {daysAway > 0 && (
          <p className="text-xs text-amber-600 mt-1">
            This gathering is in {daysAway} day{daysAway !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {/* Custom Welcome Message - rendered with markdown */}
      <div className="text-center mb-6 px-4">
        <div
          className="text-3xl font-bold text-gray-800 leading-tight [&_h1]:text-4xl [&_h2]:text-2xl [&_h3]:text-xl [&_p]:mb-1 [&_a]:underline [&_a]:text-primary-600"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(customMessage) }}
        />
        {selectedGathering?.endTime && (
          <p className="text-sm text-gray-500 mt-2">
            Sign-in closes at {selectedGathering.endTime.substring(0, 5)}
          </p>
        )}
      </div>

      {/* Check-in / Check-out Toggle */}
      <div className="flex items-center justify-center mb-6">
        <div className="bg-gray-100 rounded-full p-1 flex">
          <button
            onClick={() => { setMode('checkin'); setSelectedFamily(null); setCheckedMembers(new Set()); setSearchTerm(''); }}
            className={`px-6 py-2 rounded-full text-sm font-medium transition-colors ${
              mode === 'checkin'
                ? 'bg-primary-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Check In
          </button>
          <button
            onClick={() => { setMode('checkout'); setSelectedFamily(null); setCheckedMembers(new Set()); setSearchTerm(''); }}
            className={`px-6 py-2 rounded-full text-sm font-medium transition-colors ${
              mode === 'checkout'
                ? 'bg-orange-500 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Check Out
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-600">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Success Screen */}
      {successMessage && (
        <div className="text-center py-12">
          <div className={`mx-auto flex items-center justify-center h-16 w-16 rounded-full mb-4 ${
            mode === 'checkin' ? 'bg-green-100' : 'bg-orange-100'
          }`}>
            <CheckCircleIcon className={`h-10 w-10 ${mode === 'checkin' ? 'text-green-600' : 'text-orange-600'}`} />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">{successMessage}</h2>
          <p className="text-sm text-gray-500 mb-6">
            This screen will refresh in {refreshCountdown} second{refreshCountdown !== 1 ? 's' : ''}...
          </p>
          <button
            onClick={resetKiosk}
            className="inline-flex items-center px-4 py-2 text-sm font-medium text-primary-700 bg-primary-50 border border-primary-200 rounded-md hover:bg-primary-100 transition-colors"
          >
            <ArrowPathIcon className="h-4 w-4 mr-2" />
            Next person
          </button>
        </div>
      )}

      {/* Sign-in/out Flow */}
      {!successMessage && (
        <div className="bg-white shadow rounded-lg p-6">
          {/* Search */}
          {!selectedFamily && (
            <>
              <label htmlFor="kiosk-search" className="block text-sm font-medium text-gray-700 mb-2">
                {mode === 'checkin' ? 'Search for your family or name' : 'Search to check out'}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  ref={searchInputRef}
                  id="kiosk-search"
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-lg text-lg focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Type your surname..."
                  autoFocus
                  autoComplete="off"
                />
              </div>

              {searchTerm.trim().length >= 1 && (
                <div className="mt-3 space-y-2">
                  {filteredFamilies.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-4">
                      {mode === 'checkin'
                        ? "No matching families found. Use the + button below to add yourself."
                        : "No matching families currently checked in."}
                    </p>
                  ) : (
                    filteredFamilies.map(group => (
                      <button
                        key={group.familyId}
                        onClick={() => handleSelectFamily(group)}
                        className="w-full text-left p-3 border border-gray-200 rounded-lg hover:border-primary-300 hover:bg-primary-50 transition-colors"
                      >
                        <div className="font-medium text-gray-900">{group.familyName}</div>
                        <div className="text-sm text-gray-500 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                          {group.members.map((m, i) => (
                            <span key={m.id} className={m.present ? 'text-green-600 font-medium' : ''}>
                              {m.present && <CheckCircleIcon className="inline h-3.5 w-3.5 mr-0.5 -mt-0.5" />}
                              {m.firstName}{i < group.members.length - 1 ? ',' : ''}
                            </span>
                          ))}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          )}

          {/* Selected Family - Member Checkboxes */}
          {selectedFamily && (
            <>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">{selectedFamily.familyName}</h3>
                <button
                  onClick={() => { setSelectedFamily(null); setCheckedMembers(new Set()); setSignerName(''); }}
                  className="text-sm text-gray-500 hover:text-gray-700 underline"
                >
                  Change
                </button>
              </div>

              <div className="space-y-2 mb-6">
                {selectedFamily.members.map(member => {
                  const isPresent = Boolean(member.present);
                  const isChecked = checkedMembers.has(member.id);

                  if (mode === 'checkin') {
                    return (
                      <label
                        key={member.id}
                        className={`flex items-center p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                          isPresent
                            ? 'border-green-300 bg-green-50 opacity-75'
                            : isChecked
                            ? 'border-primary-500 bg-primary-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isPresent || isChecked}
                          disabled={isPresent}
                          onChange={() => toggleMember(member.id)}
                          className="h-5 w-5 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <span className="ml-3 text-base text-gray-900">
                          {member.firstName} {member.lastName}
                        </span>
                        {isPresent && (
                          <span className="ml-auto text-xs text-green-600 font-medium">Already signed in</span>
                        )}
                      </label>
                    );
                  } else {
                    if (!isPresent) return null;
                    return (
                      <label
                        key={member.id}
                        className={`flex items-center p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                          isChecked
                            ? 'border-orange-500 bg-orange-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleMember(member.id)}
                          className="h-5 w-5 text-orange-600 focus:ring-orange-500 border-gray-300 rounded"
                        />
                        <span className="ml-3 text-base text-gray-900">
                          {member.firstName} {member.lastName}
                        </span>
                      </label>
                    );
                  }
                })}
              </div>

              {/* Signer name */}
              <div className="mb-6">
                <label htmlFor="signer-name" className="block text-sm font-medium text-gray-700 mb-1">
                  Your name
                </label>
                <input
                  id="signer-name"
                  type="text"
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  className="block w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Type your name to confirm..."
                  autoComplete="off"
                />
              </div>

              {/* Submit Button */}
              <button
                onClick={handleSubmit}
                disabled={isSubmitting || checkedMembers.size === 0 || !signerName.trim()}
                className={`w-full py-3 px-4 text-lg font-medium text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center ${
                  mode === 'checkin'
                    ? 'bg-primary-600 hover:bg-primary-700'
                    : 'bg-orange-500 hover:bg-orange-600'
                }`}
              >
                {isSubmitting ? (
                  <>
                    <ArrowPathIcon className="h-5 w-5 mr-2 animate-spin" />
                    {mode === 'checkin' ? 'Signing in...' : 'Signing out...'}
                  </>
                ) : (
                  <>
                    <CheckCircleIcon className="h-5 w-5 mr-2" />
                    {mode === 'checkin' ? 'Sign In' : 'Sign Out'}
                  </>
                )}
              </button>
            </>
          )}

          {/* Add Visitor Button - only in check-in mode */}
          {!selectedFamily && mode === 'checkin' && (
            <div className="mt-6 pt-4 border-t border-gray-200">
              <button
                onClick={() => {
                  setShowAddVisitorModal(true);
                  setVisitorPersons([{ firstName: '', lastName: '' }]);
                  setGuardianName('');
                  setGuardianContact('');
                }}
                className="w-full flex items-center justify-center px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-primary-300 hover:text-primary-600 transition-colors"
              >
                <PlusIcon className="h-5 w-5 mr-2" />
                I'm new here
              </button>
            </div>
          )}
        </div>
      )}

      {/* Unlock Modal */}
      <Modal
        isOpen={showUnlockModal}
        onClose={() => setShowUnlockModal(false)}
      >
        <div className="relative bg-white rounded-lg shadow-xl max-w-sm w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">Unlock</h3>
              <button onClick={() => setShowUnlockModal(false)} className="text-gray-400 hover:text-gray-600">
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="unlock-pin" className="block text-sm font-medium text-gray-700 mb-1">
                  Enter PIN
                </label>
                <input
                  id="unlock-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  value={unlockPinInput}
                  onChange={(e) => { setUnlockPinInput(e.target.value.replace(/\D/g, '')); setUnlockError(''); }}
                  onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                  className="block w-full border-gray-300 rounded-lg shadow-sm focus:ring-primary-500 focus:border-primary-500 text-center text-2xl tracking-[0.5em] py-3"
                  placeholder="----"
                  autoFocus
                />
              </div>

              {unlockError && (
                <p className="text-sm text-red-600 text-center">{unlockError}</p>
              )}

              <button
                onClick={handleUnlock}
                className="w-full py-2.5 px-4 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg"
              >
                Unlock
              </button>

              <div className="border-t border-gray-200 pt-3">
                <p className="text-xs text-gray-500 text-center mb-2">Forgot your PIN?</p>
                <button
                  onClick={handleForceUnlockAndLogout}
                  className="w-full py-2 px-4 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 flex items-center justify-center"
                >
                  <ArrowRightOnRectangleIcon className="h-4 w-4 mr-2" />
                  Unlock & Log Out
                </button>
              </div>
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
              <h3 className="text-lg font-medium text-gray-900">Check In a New Child</h3>
              <button onClick={() => setShowAddVisitorModal(false)} className="text-gray-400 hover:text-gray-600">
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="space-y-5">
              {/* Child details section */}
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3 uppercase tracking-wide">Child Details</h4>
                <div className="space-y-3">
                  {visitorPersons.map((person, idx) => (
                    <div key={idx} className="space-y-2">
                      {visitorPersons.length > 1 && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-700">Child {idx + 1}</span>
                          <button onClick={() => removeVisitorPerson(idx)} className="text-xs text-red-500 hover:text-red-700">
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
                            placeholder="Child's first name"
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
                            placeholder="Child's last name"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={addVisitorPerson} className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                    + Add another child
                  </button>
                </div>
              </div>

              {/* Divider */}
              <div className="border-t border-gray-200" />

              {/* Parent/Guardian section */}
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-3 uppercase tracking-wide">Parent / Guardian</h4>
                <div className="space-y-3">
                  <div>
                    <label htmlFor="guardian-name" className="block text-sm font-medium text-gray-700">
                      Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="guardian-name"
                      type="text"
                      value={guardianName}
                      onChange={(e) => setGuardianName(e.target.value)}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                      placeholder="Parent or guardian's full name"
                    />
                  </div>
                  <div>
                    <label htmlFor="guardian-contact" className="block text-sm font-medium text-gray-700">
                      Contact Number
                    </label>
                    <input
                      id="guardian-contact"
                      type="tel"
                      value={guardianContact}
                      onChange={(e) => setGuardianContact(e.target.value)}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                      placeholder="Phone number"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      In case we need to contact you.
                    </p>
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
                    Checking in...
                  </>
                ) : (
                  'Check In'
                )}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default SelfCheckInMode;
