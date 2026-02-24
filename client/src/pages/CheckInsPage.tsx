import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { useCheckIns } from '../contexts/CheckInsContext';
import { gatheringsAPI, GatheringType } from '../services/api';
import { getNextGatheringDate } from '../components/checkins/GatheringDateSelector';
import GatheringDateSelector from '../components/checkins/GatheringDateSelector';
import CheckInHistory from '../components/checkins/CheckInHistory';
import SelfCheckInMode from '../components/checkins/SelfCheckInMode';
import LeaderCheckInMode from '../components/checkins/LeaderCheckInMode';
import {
  UserGroupIcon,
  ClipboardDocumentCheckIcon,
  LockClosedIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';

const CheckInsPage: React.FC = () => {
  const checkIns = useCheckIns();

  // Gathering selection
  const [selectedGathering, setSelectedGathering] = useState<GatheringType | null>(null);
  const [gatheringDate, setGatheringDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [daysAway, setDaysAway] = useState(0);

  // Mode selection — driven by context for persistence
  const [activeMode, setActiveMode] = useState<'self' | 'leader' | null>(null);

  // No check-in gatherings available
  const [noGatherings, setNoGatherings] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Check for no gatherings state and restore persisted sessions
  useEffect(() => {
    const checkGatherings = async () => {
      try {
        setIsLoading(true);
        const response = await gatheringsAPI.getAll();
        const all: GatheringType[] = response.data.gatherings || [];
        const kioskList = all.filter(g => g.kioskEnabled && g.attendanceType === 'standard');
        setNoGatherings(kioskList.length === 0);

        // Restore persisted session from context
        if (checkIns.gatheringId && checkIns.mode) {
          const g = all.find(g => g.id === checkIns.gatheringId);
          if (g) {
            setSelectedGathering(g);
            if (checkIns.mode === 'leader' && checkIns.selectedDate) {
              setGatheringDate(checkIns.selectedDate);
              setDaysAway(0);
            } else {
              const { date, daysAway: da } = getNextGatheringDate(g);
              setGatheringDate(date);
              setDaysAway(da);
            }
          } else {
            setSelectedGathering({
              id: checkIns.gatheringId!,
              name: checkIns.gatheringName || 'Gathering',
              attendanceType: 'standard',
              isActive: true,
              kioskEnabled: true,
            } as GatheringType);
            if (checkIns.selectedDate) {
              setGatheringDate(checkIns.selectedDate);
            }
          }
          setActiveMode(checkIns.mode);
        }
      } catch {
        // Use cache
        try {
          const cachedGatherings = localStorage.getItem('gatherings_cached_data');
          if (cachedGatherings) {
            const parsed = JSON.parse(cachedGatherings);
            const all: GatheringType[] = parsed.gatherings || [];
            const kioskList = all.filter((g: GatheringType) => g.kioskEnabled && g.attendanceType === 'standard');
            setNoGatherings(kioskList.length === 0);
          }
        } catch {
          // ignore
        }
      } finally {
        setIsLoading(false);
      }
    };
    checkGatherings();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // If locked, go directly to self check-in
  if (checkIns.isLocked && selectedGathering && activeMode === 'self') {
    return (
      <SelfCheckInMode
        selectedGathering={selectedGathering}
        gatheringDate={gatheringDate}
        daysAway={daysAway}
        onBack={() => {
          // Can't go back while locked; handled by unlock
        }}
      />
    );
  }

  // Self check-in mode
  if (activeMode === 'self' && selectedGathering) {
    return (
      <SelfCheckInMode
        selectedGathering={selectedGathering}
        gatheringDate={gatheringDate}
        daysAway={daysAway}
        onBack={() => {
          setActiveMode(null);
          checkIns.endSession();
        }}
      />
    );
  }

  // Leader check-in mode
  if (activeMode === 'leader' && selectedGathering) {
    return (
      <LeaderCheckInMode
        selectedGathering={selectedGathering}
        gatheringDate={gatheringDate}
        onBack={() => {
          setActiveMode(null);
          checkIns.endSession();
        }}
      />
    );
  }

  // Loading
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-3 text-gray-500">Loading check-ins...</p>
        </div>
      </div>
    );
  }

  // No gatherings with check-ins enabled
  if (noGatherings) {
    return (
      <div className="max-w-lg mx-auto mt-12 text-center">
        <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
        <h2 className="mt-4 text-lg font-medium text-gray-900">No Check-in Gatherings</h2>
        <p className="mt-2 text-sm text-gray-600">
          No gatherings have check-ins enabled. An admin can enable this in Gatherings settings.
        </p>
      </div>
    );
  }

  // Selection / setup view
  const handleGatheringSelect = (gathering: GatheringType, date: string, da: number) => {
    setSelectedGathering(gathering);
    setGatheringDate(date);
    setDaysAway(da);
  };

  return (
    <div className="max-w-2xl mx-auto mt-4">
      <div className="text-center mb-6">
        <div className="mx-auto flex items-center justify-center h-14 w-14 rounded-full bg-primary-100 mb-3">
          <ClipboardDocumentCheckIcon className="h-7 w-7 text-primary-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Check-ins</h1>
        <p className="text-sm text-gray-500 mt-1">Select a gathering and check-in mode</p>
      </div>

      <div className="bg-white shadow rounded-lg p-6 space-y-5">
        {/* Gathering selection */}
        <GatheringDateSelector
          onSelect={handleGatheringSelect}
          selectedGathering={selectedGathering}
          selectedDate={gatheringDate}
          daysAway={daysAway}
        />

        {/* Mode selection */}
        {selectedGathering && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Mode</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  if (selectedGathering) {
                    checkIns.startLeaderSession(selectedGathering.id, selectedGathering.name, gatheringDate);
                  }
                  setActiveMode('leader');
                }}
                className="flex flex-col items-center p-4 rounded-lg border-2 border-gray-200 hover:border-primary-400 hover:bg-primary-50 transition-colors"
              >
                <UsersIcon className="h-8 w-8 text-primary-600 mb-2" />
                <span className="text-sm font-medium text-gray-900">Leader Check-in</span>
                <span className="text-xs text-gray-500 mt-1 text-center">
                  Check people in/out with signer tracking
                </span>
              </button>
              <button
                onClick={() => {
                  checkIns.setMode('self');
                  setActiveMode('self');
                }}
                className="flex flex-col items-center p-4 rounded-lg border-2 border-gray-200 hover:border-primary-400 hover:bg-primary-50 transition-colors"
              >
                <LockClosedIcon className="h-8 w-8 text-primary-600 mb-2" />
                <span className="text-sm font-medium text-gray-900">Self Check-in</span>
                <span className="text-xs text-gray-500 mt-1 text-center">
                  PIN-locked self-service for a shared device
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* History */}
      {selectedGathering && (
        <CheckInHistory
          gatheringId={selectedGathering.id}
          gatheringName={selectedGathering.name}
        />
      )}
    </div>
  );
};

export default CheckInsPage;
