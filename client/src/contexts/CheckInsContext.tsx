import React, { createContext, useContext, useState, useCallback } from 'react';

const STORAGE_KEY = 'checkins_state';

interface CheckInsState {
  mode: 'self' | 'leader' | null;
  isLocked: boolean;
  pin: string | null;
  gatheringId: number | null;
  gatheringName: string | null;
  selectedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  customMessage: string | null;
}

interface CheckInsContextType {
  mode: 'self' | 'leader' | null;
  setMode: (mode: 'self' | 'leader' | null) => void;
  isLocked: boolean;
  lock: (pin: string, gatheringId: number, gatheringName: string, startTime: string, endTime: string, customMessage: string) => void;
  unlock: (pin: string) => boolean;
  forceUnlock: () => void;
  startLeaderSession: (gatheringId: number, gatheringName: string, date: string) => void;
  endSession: () => void;
  gatheringId: number | null;
  gatheringName: string | null;
  selectedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  customMessage: string | null;
}

const emptyState: CheckInsState = {
  mode: null,
  isLocked: false,
  pin: null,
  gatheringId: null,
  gatheringName: null,
  selectedDate: null,
  startTime: null,
  endTime: null,
  customMessage: null,
};

function loadState(): CheckInsState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CheckInsState;
      // Restore if locked (self check-in) or if there's an active mode with gathering
      if (parsed.isLocked || (parsed.mode && parsed.gatheringId)) return parsed;
    }
    // Also check legacy kiosk_state for backwards compatibility
    const legacy = sessionStorage.getItem('kiosk_state');
    if (legacy) {
      const parsed = JSON.parse(legacy) as any;
      if (parsed.isLocked) {
        const migrated: CheckInsState = { ...parsed, mode: 'self', selectedDate: null };
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        sessionStorage.removeItem('kiosk_state');
        return migrated;
      }
    }
  } catch {
    // ignore
  }
  return { ...emptyState };
}

function saveState(s: CheckInsState) {
  try {
    if (s.isLocked || (s.mode && s.gatheringId)) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

const CheckInsContext = createContext<CheckInsContextType>({
  mode: null,
  setMode: () => {},
  isLocked: false,
  lock: () => {},
  unlock: () => false,
  forceUnlock: () => {},
  startLeaderSession: () => {},
  endSession: () => {},
  gatheringId: null,
  gatheringName: null,
  selectedDate: null,
  startTime: null,
  endTime: null,
  customMessage: null,
});

export const useCheckIns = () => useContext(CheckInsContext);

export const CheckInsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<CheckInsState>(loadState);

  const setMode = useCallback((mode: 'self' | 'leader' | null) => {
    setState(prev => {
      const next = { ...prev, mode };
      saveState(next);
      return next;
    });
  }, []);

  const lock = useCallback((pin: string, gatheringId: number, gatheringName: string, startTime: string, endTime: string, customMessage: string) => {
    const next: CheckInsState = { mode: 'self', isLocked: true, pin, gatheringId, gatheringName, selectedDate: null, startTime, endTime, customMessage };
    setState(next);
    saveState(next);
  }, []);

  const unlock = useCallback((enteredPin: string): boolean => {
    if (state.pin && enteredPin === state.pin) {
      setState({ ...emptyState });
      saveState(emptyState);
      return true;
    }
    return false;
  }, [state.pin]);

  const forceUnlock = useCallback(() => {
    setState({ ...emptyState });
    saveState(emptyState);
  }, []);

  const startLeaderSession = useCallback((gatheringId: number, gatheringName: string, date: string) => {
    const next: CheckInsState = { ...emptyState, mode: 'leader', gatheringId, gatheringName, selectedDate: date };
    setState(next);
    saveState(next);
  }, []);

  const endSession = useCallback(() => {
    setState({ ...emptyState });
    saveState(emptyState);
  }, []);

  return (
    <CheckInsContext.Provider value={{
      mode: state.mode,
      setMode,
      isLocked: state.isLocked,
      lock,
      unlock,
      forceUnlock,
      startLeaderSession,
      endSession,
      gatheringId: state.gatheringId,
      gatheringName: state.gatheringName,
      selectedDate: state.selectedDate,
      startTime: state.startTime,
      endTime: state.endTime,
      customMessage: state.customMessage,
    }}>
      {children}
    </CheckInsContext.Provider>
  );
};
