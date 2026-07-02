import React, { useEffect, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { individualsAPI } from '../../services/api';
import { AttendanceHistoryEntry } from '../../utils/attendanceHistoryCsv';

interface AttendanceHistoryResponse {
  history: AttendanceHistoryEntry[];
}

interface AttendanceHistoryPopoverProps {
  people: Array<{ individualId: number; name: string }>;
  children: React.ReactNode;
}

type Status = 'idle' | 'loading' | 'loaded' | 'error';

// Module-level so every popover instance (and every re-open within the page
// session) reuses in-flight/completed requests instead of refetching.
const historyCache = new Map<number, Promise<AttendanceHistoryResponse>>();

function fetchHistoryCached(individualId: number): Promise<AttendanceHistoryResponse> {
  let cached = historyCache.get(individualId);
  if (!cached) {
    cached = individualsAPI.getAttendanceHistory(individualId).then(res => res.data as AttendanceHistoryResponse);
    historyCache.set(individualId, cached);
  }
  return cached;
}

function formatDate(dateString: string): string {
  try {
    return format(parseISO(dateString), 'MMM d, yyyy');
  } catch {
    return dateString;
  }
}

export function getLastPresentDates(history: AttendanceHistoryEntry[], limit = 3): string[] {
  return history.filter(row => row.present).slice(0, limit).map(row => row.date);
}

const AttendanceHistoryPopover: React.FC<AttendanceHistoryPopoverProps> = ({ people, children }) => {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [datesByPerson, setDatesByPerson] = useState<Map<number, string[]>>(new Map());
  const containerRef = useRef<HTMLSpanElement>(null);
  const peopleKey = people.map(p => p.individualId).join(',');

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setStatus('loading');
    Promise.all(
      people.map(p =>
        fetchHistoryCached(p.individualId).then(
          res => [p.individualId, getLastPresentDates(res.history)] as const
        )
      )
    )
      .then(entries => {
        if (cancelled) return;
        setDatesByPerson(new Map(entries));
        setStatus('loaded');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, peopleKey]);

  useEffect(() => {
    if (!visible) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setVisible(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVisible(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible]);

  return (
    <span ref={containerRef} className="relative inline-block">
      <span
        role="button"
        tabIndex={0}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onClick={() => setVisible(v => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setVisible(v => !v);
          }
        }}
        className="cursor-pointer"
      >
        {children}
      </span>
      {visible && (
        <div className="absolute z-10 mt-1 left-0 w-64 bg-white dark:bg-gray-800 shadow-lg rounded border border-gray-200 dark:border-gray-700 p-3 text-sm">
          {status === 'loading' && (
            <div className="text-gray-500 dark:text-gray-400">Loading…</div>
          )}
          {status === 'error' && (
            <div className="text-red-500 dark:text-red-400">Couldn't load attendance history.</div>
          )}
          {status === 'loaded' && (
            <div className="space-y-2">
              {people.map(p => {
                const dates = datesByPerson.get(p.individualId) ?? [];
                return (
                  <div key={p.individualId}>
                    {people.length > 1 && (
                      <div className="font-semibold text-gray-900 dark:text-gray-100">{p.name}</div>
                    )}
                    {dates.length === 0 ? (
                      <div className="text-gray-500 dark:text-gray-400">No attendance on record.</div>
                    ) : (
                      <ul className="text-gray-700 dark:text-gray-300">
                        {dates.map(d => (
                          <li key={d}>{formatDate(d)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </span>
  );
};

export default AttendanceHistoryPopover;
