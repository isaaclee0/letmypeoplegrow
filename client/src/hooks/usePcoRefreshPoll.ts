import { useEffect, useRef } from 'react';

const POLL_INTERVAL_MS = 3000;

// Re-runs `check` every POLL_INTERVAL_MS while `refreshing` is true, and stops as soon
// as it becomes false (or the component unmounts). `check` is expected to update
// `refreshing` itself once its fetch resolves — each call either flips `refreshing` to
// false (stopping the loop) or schedules the next one.
export function usePcoRefreshPoll(refreshing: boolean, check: () => void): void {
  const checkRef = useRef(check);
  checkRef.current = check;

  useEffect(() => {
    if (!refreshing) return;
    const timeoutId = setTimeout(() => checkRef.current(), POLL_INTERVAL_MS);
    return () => clearTimeout(timeoutId);
  }, [refreshing]);
}
