import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { format, addDays, startOfWeek, addWeeks, startOfDay, isBefore, differenceInCalendarDays } from 'date-fns';
import { useAuth } from '../contexts/AuthContext';
import { useKiosk } from '../contexts/KioskContext';
import { gatheringsAPI, attendanceAPI, familiesAPI, GatheringType, Individual } from '../services/api';
import { generateFamilyName } from '../utils/familyNameUtils';
import {
  MagnifyingGlassIcon,
  PlusIcon,
  CheckCircleIcon,
  XMarkIcon,
  ArrowPathIcon,
  UserGroupIcon,
  LockClosedIcon,
  LockOpenIcon,
  ArrowRightOnRectangleIcon,
} from '@heroicons/react/24/outline';
import Modal from '../components/Modal';

interface FamilyGroup {
  familyId: number;
  familyName: string;
  members: Individual[];
}

type KioskPhase = 'setup' | 'pin' | 'active';
type KioskMode = 'checkin' | 'checkout';

const DAY_MAP: Record<string, number> = {
  'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
  'Thursday': 4, 'Friday': 5, 'Saturday': 6,
};

/**
 * Compute the next upcoming gathering date (today or in the future).
 * Returns the date string (yyyy-MM-dd) and the number of days away.
 */
function getNextGatheringDate(gathering: GatheringType): { date: string; daysAway: number } {
  const today = startOfDay(new Date());
  const todayStr = format(today, 'yyyy-MM-dd');

  // Custom schedule handling
  if (gathering.customSchedule) {
    const cs = gathering.customSchedule;
    if (cs.type === 'one_off') {
      const diff = differenceInCalendarDays(new Date(cs.startDate), today);
      return { date: cs.startDate, daysAway: Math.max(diff, 0) };
    }
    if (cs.type === 'recurring' && cs.pattern) {
      const endDate = cs.endDate ? new Date(cs.endDate) : addWeeks(today, 8);
      const dates: string[] = [];
      const startDate = new Date(cs.startDate);

      if (cs.pattern.frequency === 'daily') {
        if (cs.pattern.customDates?.length) {
          dates.push(...cs.pattern.customDates);
        } else {
          let cur = startDate;
          while (isBefore(cur, endDate)) {
            dates.push(format(cur, 'yyyy-MM-dd'));
            cur = addDays(cur, cs.pattern.interval || 1);
          }
        }
      } else if (cs.pattern.frequency === 'weekly' || cs.pattern.frequency === 'biweekly') {
        const targetDays = (cs.pattern.daysOfWeek || []).map(d => DAY_MAP[d]).filter(d => d !== undefined);
        let cur = startDate;
        let weekCount = 0;
        while (isBefore(cur, endDate)) {
          const skip = cs.pattern.frequency === 'biweekly' && weekCount % 2 !== 0;
          if (!skip) {
            const ws = startOfWeek(cur, { weekStartsOn: 0 });
            for (const td of targetDays) {
              const eventDate = addDays(ws, td);
              if (!isBefore(eventDate, startDate) && isBefore(eventDate, endDate)) {
                dates.push(format(eventDate, 'yyyy-MM-dd'));
              }
            }
          }
          cur = addWeeks(cur, 1);
          weekCount++;
        }
      } else if (cs.pattern.frequency === 'monthly' && cs.pattern.dayOfMonth) {
        let cur = startDate;
        while (isBefore(cur, endDate)) {
          const eventDate = new Date(cur.getFullYear(), cur.getMonth(), cs.pattern.dayOfMonth);
          if (!isBefore(eventDate, startDate) && isBefore(eventDate, endDate)) {
            dates.push(format(eventDate, 'yyyy-MM-dd'));
          }
          cur = addWeeks(cur, 4);
        }
      }

      const sorted = dates.sort();
      const next = sorted.find(d => d >= todayStr) || sorted[sorted.length - 1];
      if (next) {
        const diff = differenceInCalendarDays(new Date(next), today);
        return { date: next, daysAway: Math.max(diff, 0) };
      }
    }
  }

  // Standard weekly-type gatherings
  const targetDay = DAY_MAP[gathering.dayOfWeek || ''];
  if (targetDay === undefined) {
    return { date: todayStr, daysAway: 0 };
  }

  const todayDow = today.getDay();
  let daysUntil = targetDay - todayDow;
  if (daysUntil < 0) daysUntil += 7;

  // For biweekly/monthly we still find the next matching day-of-week
  // (the attendance API will accept the date regardless)
  const nextDate = addDays(today, daysUntil);
  const dateStr = format(nextDate, 'yyyy-MM-dd');
  return { date: dateStr, daysAway: daysUntil };
}

const KioskPage: React.FC = () => {
  const { user, logout } = useAuth();
  const kiosk = useKiosk();

  // ===== Phase management =====
  const [phase, setPhase] = useState<KioskPhase>(kiosk.isLocked ? 'active' : 'setup');

  // ===== Setup phase state =====
  const [kioskGatherings, setKioskGatherings] = useState<GatheringType[]>([]);
  const [selectedGathering, setSelectedGathering] = useState<GatheringType | null>(null);
  const [startTime, setStartTime] = useState(kiosk.startTime || '10:00');
  const [endTime, setEndTime] = useState(kiosk.endTime || '11:00');
  const [isLoading, setIsLoading] = useState(true);

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
  const [visitorNotes, setVisitorNotes] = useState('');
  const [isAddingVisitor, setIsAddingVisitor] = useState(false);

  // Computed gathering date (next upcoming date for this gathering type)
  const [gatheringDate, setGatheringDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [daysAway, setDaysAway] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ===== Recompute gathering date when gathering changes =====
  useEffect(() => {
    if (selectedGathering) {
      const { date, daysAway: da } = getNextGatheringDate(selectedGathering);
      setGatheringDate(date);
      setDaysAway(da);
    }
  }, [selectedGathering]);

  // ===== Time-based mode defaulting =====
  const computeDefaultMode = useCallback((): KioskMode => {
    const now = new Date();
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);

    const startDate = new Date(now);
    startDate.setHours(sh, sm, 0, 0);
    const endDate = new Date(now);
    endDate.setHours(eh, em, 0, 0);

    // 15 minutes before end
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

  // ===== Load kiosk-enabled gatherings =====
  useEffect(() => {
    const loadGatherings = async () => {
      try {
        setIsLoading(true);
        const response = await gatheringsAPI.getAll();
        const all: GatheringType[] = response.data.gatherings || [];
        const kioskList = all.filter(g => g.kioskEnabled && g.attendanceType === 'standard');
        setKioskGatherings(kioskList);
        if (kioskList.length === 1) {
          const g = kioskList[0];
          setSelectedGathering(g);
          if (g.startTime) {
            const st = g.startTime.substring(0, 5);
            setStartTime(st);
            // Default end time: start + 1 hour
            const [h, m] = st.split(':').map(Number);
            const endH = (h + 1) % 24;
            setEndTime(`${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
          }
        }
      } catch (err) {
        setError('Failed to load gatherings.');
      } finally {
        setIsLoading(false);
      }
    };
    loadGatherings();
  }, []);

  // If we're already locked (e.g., page reload), restore state from context
  useEffect(() => {
    if (kiosk.isLocked && kiosk.gatheringId) {
      setPhase('active');
      if (kiosk.startTime) setStartTime(kiosk.startTime);
      if (kiosk.endTime) setEndTime(kiosk.endTime);
      // Reload the gathering data
      const loadLockedGathering = async () => {
        try {
          const response = await gatheringsAPI.getAll();
          const all: GatheringType[] = response.data.gatherings || [];
          const g = all.find(g => g.id === kiosk.gatheringId);
          if (g) setSelectedGathering(g);
        } catch (err) {
          // Fallback
        }
      };
      loadLockedGathering();
    }
  }, [kiosk.isLocked, kiosk.gatheringId]);

  // ===== Load attendance list when gathering selected and active =====
  const loadAttendance = useCallback(async () => {
    if (!selectedGathering) return;
    try {
      const response = await attendanceAPI.get(selectedGathering.id, gatheringDate);
      const list: Individual[] = response.data.attendanceList || [];
      setAttendanceList(list);

      // Group by family
      const groups: Record<number, FamilyGroup> = {};
      const noFamily: Individual[] = [];
      for (const person of list) {
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
    }
  }, [selectedGathering, gatheringDate]);

  useEffect(() => {
    if (phase === 'active') {
      loadAttendance();
    }
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
      // Default all unchecked – user explicitly selects who to sign in
      setCheckedMembers(new Set());
    } else {
      // Checkout: pre-check members that ARE present
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

      const present = mode === 'checkin';
      const records = Array.from(checkedMembers).map(id => ({
        individualId: id,
        present,
      }));

      await attendanceAPI.record(selectedGathering.id, gatheringDate, {
        attendanceRecords: records,
        visitors: [],
      });

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
    // Focus search input after reset
    setTimeout(() => searchInputRef.current?.focus(), 100);
  };

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, []);

  // ===== Setup: select gathering =====
  const handleGatheringSelect = (g: GatheringType) => {
    setSelectedGathering(g);
    if (g.startTime) {
      const st = g.startTime.substring(0, 5);
      setStartTime(st);
      const [h, m] = st.split(':').map(Number);
      const endH = (h + 1) % 24;
      setEndTime(`${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  };

  // ===== Setup: enter kiosk mode -> go to PIN =====
  const handleEnterKioskMode = () => {
    if (!selectedGathering) {
      setError('Please select a gathering.');
      return;
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
    // Lock kiosk
    kiosk.lock(pinInput, selectedGathering!.id, selectedGathering!.name, startTime, endTime);
    setPhase('active');
  };

  // ===== Unlock =====
  const handleUnlock = () => {
    const success = kiosk.unlock(unlockPinInput);
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
    kiosk.forceUnlock();
    setShowUnlockModal(false);
    await logout();
    window.location.href = '/login';
  };

  // ===== Add visitor handler =====
  const handleAddVisitor = async () => {
    if (!selectedGathering) return;
    const validPersons = visitorPersons.filter(p => p.firstName.trim() && p.lastName.trim());
    if (validPersons.length === 0) {
      setError('Please enter at least one name.');
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
        isChild: false,
      }));

      const familyName = generateFamilyName(people) || 'Visitor';

      const familyResponse = await familiesAPI.createVisitorFamily({
        familyName,
        peopleType: 'local_visitor',
        notes: visitorNotes.trim() || undefined,
        people,
      });

      const familyId = familyResponse.data.familyId || familyResponse.data.family?.id;

      if (familyId) {
        await attendanceAPI.addVisitorFamilyToService(selectedGathering.id, gatheringDate, familyId);
      }

      setShowAddVisitorModal(false);
      setVisitorPersons([{ firstName: '', lastName: '' }]);
      setVisitorNotes('');
      await loadAttendance();

      const names = validPersons.map(p => p.firstName).join(' and ');
      setSuccessMessage(`${names} added and signed in!`);
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

  // ===== RENDER: Loading =====
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-3 text-gray-500">Loading kiosk...</p>
        </div>
      </div>
    );
  }

  // ===== RENDER: No kiosk gatherings =====
  if (kioskGatherings.length === 0) {
    return (
      <div className="max-w-lg mx-auto mt-12 text-center">
        <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
        <h2 className="mt-4 text-lg font-medium text-gray-900">No Kiosk Gatherings</h2>
        <p className="mt-2 text-sm text-gray-600">
          No gatherings have self sign-in (kiosk mode) enabled. An admin can enable this in Gatherings settings.
        </p>
      </div>
    );
  }

  // ===== RENDER: Setup phase =====
  if (phase === 'setup') {
    return (
      <div className="max-w-md mx-auto mt-8">
        <div className="text-center mb-6">
          <div className="mx-auto flex items-center justify-center h-14 w-14 rounded-full bg-primary-100 mb-3">
            <LockClosedIcon className="h-7 w-7 text-primary-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Kiosk Setup</h1>
          <p className="text-sm text-gray-500 mt-1">Configure self sign-in for your gathering</p>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="bg-white shadow rounded-lg p-6 space-y-5">
          {/* Gathering selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Gathering</label>
            {kioskGatherings.length === 1 ? (
              <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div className="font-medium text-gray-900">{kioskGatherings[0].name}</div>
                {kioskGatherings[0].dayOfWeek && (
                  <div className="text-sm text-gray-500">{kioskGatherings[0].dayOfWeek}</div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {kioskGatherings.map(g => (
                  <label
                    key={g.id}
                    className={`flex items-center p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                      selectedGathering?.id === g.id
                        ? 'border-primary-500 bg-primary-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="gathering"
                      checked={selectedGathering?.id === g.id}
                      onChange={() => handleGatheringSelect(g)}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                    />
                    <div className="ml-3">
                      <div className="font-medium text-gray-900">{g.name}</div>
                      {g.dayOfWeek && g.startTime && (
                        <div className="text-sm text-gray-500">{g.dayOfWeek} at {g.startTime}</div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Times */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="kiosk-start" className="block text-sm font-medium text-gray-700 mb-1">
                Start Time
              </label>
              <input
                id="kiosk-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              <label htmlFor="kiosk-end" className="block text-sm font-medium text-gray-700 mb-1">
                End Time
              </label>
              <input
                id="kiosk-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
          </div>

          <p className="text-xs text-gray-500">
            The kiosk will default to Check In before the gathering and switch to Check Out 15 minutes before the end time.
          </p>

          {/* Show next gathering date info */}
          {selectedGathering && daysAway > 0 && (
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

          {/* Enter Kiosk Mode */}
          <button
            onClick={handleEnterKioskMode}
            disabled={!selectedGathering}
            className="w-full py-3 px-4 text-base font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
          >
            <LockClosedIcon className="h-5 w-5 mr-2" />
            Enter Kiosk Mode
          </button>
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
            This PIN will be required to exit kiosk mode
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

  // ===== RENDER: Active kiosk mode =====
  return (
    <div className="max-w-xl mx-auto">
      {/* Unlock button (top-left) */}
      <button
        onClick={() => { setShowUnlockModal(true); setUnlockPinInput(''); setUnlockError(''); }}
        className="fixed top-4 left-4 z-50 p-2 text-gray-300 hover:text-gray-500 transition-colors"
        title="Unlock kiosk"
      >
        <LockOpenIcon className="h-5 w-5" />
      </button>

      {/* Header */}
      <div className="text-center mb-4">
        <h1 className="text-2xl font-bold text-gray-900">
          {selectedGathering?.name || kiosk.gatheringName}
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
                        <div className="text-sm text-gray-500 mt-0.5">
                          {group.members.map(m => m.firstName).join(', ')}
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
                    // Checkout: only show present members
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
                  setVisitorNotes('');
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
              <h3 className="text-lg font-medium text-gray-900">Unlock Kiosk</h3>
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
              <h3 className="text-lg font-medium text-gray-900">Add New Visitor</h3>
              <button onClick={() => setShowAddVisitorModal(false)} className="text-gray-400 hover:text-gray-600">
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="space-y-4">
              {visitorPersons.map((person, idx) => (
                <div key={idx} className="space-y-2">
                  {visitorPersons.length > 1 && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700">Person {idx + 1}</span>
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

              <button type="button" onClick={addVisitorPerson} className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                + Add another person
              </button>

              <div>
                <label htmlFor="visitor-notes" className="block text-sm font-medium text-gray-700">
                  Contact Phone Number
                </label>
                <input
                  id="visitor-notes"
                  type="tel"
                  value={visitorNotes}
                  onChange={(e) => setVisitorNotes(e.target.value)}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  placeholder="Enter a contact phone number"
                />
                <p className="mt-1 text-xs text-gray-500">
                  So we can follow up and welcome you properly.
                </p>
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
                disabled={isAddingVisitor || visitorPersons.every(p => !p.firstName.trim() || !p.lastName.trim())}
                className="flex-1 px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isAddingVisitor ? (
                  <>
                    <ArrowPathIcon className="inline h-4 w-4 mr-1 animate-spin" />
                    Adding...
                  </>
                ) : (
                  'Add & Sign In'
                )}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default KioskPage;
