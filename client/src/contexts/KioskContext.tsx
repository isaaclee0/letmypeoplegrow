import React, { createContext, useContext, useState, useCallback } from 'react';

const STORAGE_KEY = 'kiosk_state';

interface KioskState {
  isLocked: boolean;
  pin: string | null;
  gatheringId: number | null;
  gatheringName: string | null;
  startTime: string | null;
  endTime: string | null;
  customMessage: string | null;
}

interface KioskContextType {
  isLocked: boolean;
  lock: (pin: string, gatheringId: number, gatheringName: string, startTime: string, endTime: string, customMessage: string) => void;
  unlock: (pin: string) => boolean;
  forceUnlock: () => void;
  gatheringId: number | null;
  gatheringName: string | null;
  startTime: string | null;
  endTime: string | null;
  customMessage: string | null;
}

const emptyState: KioskState = {
  isLocked: false,
  pin: null,
  gatheringId: null,
  gatheringName: null,
  startTime: null,
  endTime: null,
  customMessage: null,
};

function loadState(): KioskState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as KioskState;
      if (parsed.isLocked) return parsed;
    }
  } catch {
    // ignore
  }
  return { ...emptyState };
}

function saveState(s: KioskState) {
  try {
    if (s.isLocked) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

const KioskContext = createContext<KioskContextType>({
  isLocked: false,
  lock: () => {},
  unlock: () => false,
  forceUnlock: () => {},
  gatheringId: null,
  gatheringName: null,
  startTime: null,
  endTime: null,
  customMessage: null,
});

export const useKiosk = () => useContext(KioskContext);

export const KioskProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<KioskState>(loadState);

  const lock = useCallback((pin: string, gatheringId: number, gatheringName: string, startTime: string, endTime: string, customMessage: string) => {
    const next: KioskState = { isLocked: true, pin, gatheringId, gatheringName, startTime, endTime, customMessage };
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

  return (
    <KioskContext.Provider value={{
      isLocked: state.isLocked,
      lock,
      unlock,
      forceUnlock,
      gatheringId: state.gatheringId,
      gatheringName: state.gatheringName,
      startTime: state.startTime,
      endTime: state.endTime,
      customMessage: state.customMessage,
    }}>
      {children}
    </KioskContext.Provider>
  );
};
