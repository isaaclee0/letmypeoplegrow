import { useState, useCallback, useEffect } from 'react';
import logger from '../utils/logger';

interface PendingChange {
  individualId: number;
  present: boolean;
  timestamp: number;
  gatheringId: number;
  date: string;
}

interface UseOfflineAttendanceOptions {
  isConnected: boolean;
  selectedGatheringId: number | undefined;
  selectedDate: string;
  sendAttendanceChange: (
    gatheringId: number,
    date: string,
    records: Array<{ individualId: number; present: boolean }>
  ) => Promise<any>;
  setError: (error: string) => void;
}

interface UseOfflineAttendanceReturn {
  pendingChanges: PendingChange[];
  isSyncing: boolean;
  saveToOfflineStorage: (change: {
    individualId: number;
    present: boolean;
    gatheringId: number;
    date: string;
  }) => void;
  syncOfflineChanges: () => Promise<void>;
}

const STORAGE_KEY = 'attendance_offline_changes';

export function useOfflineAttendance({
  isConnected,
  selectedGatheringId,
  selectedDate,
  sendAttendanceChange,
  setError,
}: UseOfflineAttendanceOptions): UseOfflineAttendanceReturn {
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);

  const saveToOfflineStorage = useCallback(
    (change: { individualId: number; present: boolean; gatheringId: number; date: string }) => {
      const offlineChanges: PendingChange[] = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || '[]'
      );
      const newChange: PendingChange = {
        ...change,
        timestamp: Date.now(),
      };

      // Remove any existing change for this individual in this gathering/date
      const filteredChanges = offlineChanges.filter(
        (c) =>
          !(
            c.individualId === change.individualId &&
            c.gatheringId === change.gatheringId &&
            c.date === change.date
          )
      );

      const updatedChanges = [...filteredChanges, newChange];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedChanges));
      setPendingChanges(updatedChanges);

      logger.log('💾 Saved to offline storage:', newChange);
    },
    []
  );

  const syncOfflineChanges = useCallback(async () => {
    if (!isConnected || pendingChanges.length === 0) return;

    setIsSyncing(true);
    logger.log('🔄 Syncing offline changes:', pendingChanges.length, 'changes');

    try {
      // Group changes by gathering and date
      const changesByGathering: {
        [key: string]: Array<{ individualId: number; present: boolean }>;
      } = {};

      pendingChanges.forEach((change) => {
        const key = `${change.gatheringId}|${change.date}`;
        if (!changesByGathering[key]) {
          changesByGathering[key] = [];
        }
        changesByGathering[key].push({
          individualId: change.individualId,
          present: change.present,
        });
      });

      // Sync each group of changes
      for (const [key, changes] of Object.entries(changesByGathering)) {
        const [gatheringId, date] = key.split('|');

        logger.log(
          `🔄 Syncing ${changes.length} changes for gathering ${gatheringId} on ${date}:`,
          changes
        );

        try {
          await sendAttendanceChange(parseInt(gatheringId), date, changes);
          logger.log(
            `✅ Successfully synced ${changes.length} changes for gathering ${gatheringId} on ${date}`
          );
        } catch (syncError) {
          console.error(
            `❌ Failed to sync changes for gathering ${gatheringId} on ${date}:`,
            syncError
          );
          throw syncError; // Re-throw to trigger the outer catch block
        }
      }

      // Clear offline storage only if all syncs succeeded
      localStorage.removeItem(STORAGE_KEY);
      setPendingChanges([]);
      setError(''); // Clear any lingering error messages
      logger.log('✅ All offline changes synced successfully');
    } catch (error) {
      console.error('❌ Failed to sync offline changes:', error);

      // If changes are old (more than 1 hour), clear them instead of retrying
      const now = Date.now();
      const oldChanges = pendingChanges.filter((change) => {
        const ageInMinutes = (now - change.timestamp) / (1000 * 60);
        return ageInMinutes > 60; // Changes older than 1 hour
      });

      if (oldChanges.length > 0) {
        logger.log('🧹 Clearing old failed changes:', oldChanges.length);
        localStorage.removeItem(STORAGE_KEY);
        setPendingChanges([]);
        setError(''); // Clear error since we're giving up on old changes
      } else {
        setError('Failed to sync offline changes. They will be retried when connection is restored.');
        // Don't clear pending changes on error - they'll be retried
      }
    } finally {
      setIsSyncing(false);
    }
  }, [isConnected, pendingChanges, sendAttendanceChange, setError]);

  // Load offline changes on mount / when gathering or date changes
  useEffect(() => {
    // Clear any lingering error messages on component mount
    setError('');

    const offlineChanges: PendingChange[] = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || '[]'
    );

    // Clear any old offline changes that might have invalid date formats or are too old
    const now = Date.now();
    const validChanges = offlineChanges.filter((change) => {
      // Check if the date format is valid (should be YYYY-MM-DD)
      if (!change.date || !/^\d{4}-\d{2}-\d{2}$/.test(change.date)) {
        logger.log('🧹 Clearing invalid date format:', change.date);
        return false;
      }

      // Check age (keep changes less than 24 hours old)
      const ageInHours = (now - change.timestamp) / (1000 * 60 * 60);
      if (ageInHours >= 24) {
        logger.log('🧹 Clearing old change:', change);
        return false;
      }

      return true;
    });

    if (validChanges.length !== offlineChanges.length) {
      logger.log(
        '🧹 Cleared stale offline changes:',
        offlineChanges.length - validChanges.length
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(validChanges));
    }

    setPendingChanges(validChanges);
  }, [selectedGatheringId, selectedDate, setError]);

  // Clear error on component unmount to prevent stale state
  useEffect(() => {
    return () => {
      setError('');
    };
  }, [setError]);

  // Sync offline changes when connection is restored
  useEffect(() => {
    if (isConnected) {
      if (pendingChanges.length > 0) {
        syncOfflineChanges();
      } else {
        // Clear any lingering error messages when connection is restored
        setError('');
      }
    }
  }, [isConnected, pendingChanges.length, syncOfflineChanges, setError]);

  return {
    pendingChanges,
    isSyncing,
    saveToOfflineStorage,
    syncOfflineChanges,
  };
}
