import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import type {
  ContextualPeopleDrilldownRow,
  EngagementDrilldownPage,
} from '../../services/api';
import { reportsAPI } from '../../services/api';
import AttendanceHistoryPopover from './AttendanceHistoryPopover';

interface EngagementPeoplePanelProps {
  token: string;
  title: string;
  gatheringIds?: number[];
  onClose: () => void;
  onTokenExpired?: () => Promise<boolean>;
}
type PeopleRow = ContextualPeopleDrilldownRow;

type SortKey = 'relevance' | 'surname' | 'earlier' | 'recent';
type SortDirection = 'ascending' | 'descending';

function surnameCompare(left: PeopleRow, right: PeopleRow): number {
  return left.lastName.localeCompare(right.lastName, undefined, { sensitivity: 'base' })
    || left.firstName.localeCompare(right.firstName, undefined, { sensitivity: 'base' });
}

function attendanceRate(row: PeopleRow, period: 'earlier' | 'recent'): number {
  if (row.rowType === 'contextual_regularity') return row.rate;
  return period === 'earlier' ? row.baseline.rate : row.recent.rate;
}

const formatPercent = (value: number) => Number(value.toFixed(1));

const EngagementPeoplePanel: React.FC<EngagementPeoplePanelProps> = ({ token, title, gatheringIds, onClose, onTokenExpired }) => {
  const [rows, setRows] = useState<PeopleRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('relevance');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.scrollIntoView?.({ block: 'nearest' });
    headingRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const load = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setError('');
    try {
      const response = await reportsAPI.getEngagementPeople({ segment: token, cursor: nextCursor, limit: 50 });
      const page = response.data as EngagementDrilldownPage<PeopleRow>;
      setRows((current) => nextCursor ? [...current, ...page.rows] : page.rows);
      setCursor(page.nextCursor);
    } catch (cause) {
      const invalidToken = axios.isAxiosError<{ code?: string }>(cause)
        && cause.response?.data?.code === 'INVALID_DRILLDOWN_TOKEN';
      if (invalidToken && onTokenExpired && await onTokenExpired().catch(() => false)) return;
      setError('Could not load these people.');
    } finally {
      setLoading(false);
    }
  }, [onTokenExpired, token]);

  useEffect(() => { void load(); }, [load]);

  const showRecentChange = rows.some((row) => (row.rowType === 'contextual_decline' || row.rowType === 'contextual_increase'));
  const showRegularityGrid = rows.some((row) => row.rowType === 'contextual_regularity') && !showRecentChange;
  const sortedRows = useMemo(() => [...rows].sort((left, right) => {
    if (sortKey === 'relevance') return 0;
    if (sortKey === 'surname') return surnameCompare(left, right) * (sortDirection === 'ascending' ? 1 : -1);
    return (attendanceRate(left, sortKey) - attendanceRate(right, sortKey)) * (sortDirection === 'ascending' ? 1 : -1)
      || surnameCompare(left, right);
  }), [rows, sortDirection, sortKey]);
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection((direction) => direction === 'ascending' ? 'descending' : 'ascending');
      return;
    }
    setSortKey(key);
    setSortDirection(key === 'surname' ? 'ascending' : 'descending');
  };
  const nextDirection = (key: SortKey): SortDirection => {
    if (key !== sortKey) return key === 'surname' ? 'ascending' : 'descending';
    return sortDirection === 'ascending' ? 'descending' : 'ascending';
  };

  return (
    <section className="mt-5 rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800" aria-label={title}>
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h3 ref={headingRef} tabIndex={-1} className="font-semibold text-gray-900 outline-none dark:text-gray-100">{title}</h3>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Close</button>
      </div>
      {error && <p role="alert" className="px-4 py-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      {showRegularityGrid ? <>
        <div className="flex flex-wrap items-center justify-end gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-900/60 dark:text-gray-400">
          <span className="font-medium uppercase tracking-wide">Sort by</span>
          <button
            type="button"
            onClick={() => toggleSort('surname')}
            aria-label={`Sort by name ${nextDirection('surname')}`}
            className={`rounded-full px-3 py-1 font-medium hover:bg-gray-200 dark:hover:bg-gray-700 ${sortKey === 'surname' ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100' : ''}`}
          >
            Name {sortKey === 'surname' && (sortDirection === 'ascending' ? '↑' : '↓')}
          </button>
          <button
            type="button"
            onClick={() => toggleSort('earlier')}
            aria-label={`Sort by attendance ${nextDirection('earlier')}`}
            className={`rounded-full px-3 py-1 font-medium hover:bg-gray-200 dark:hover:bg-gray-700 ${sortKey === 'earlier' ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100' : ''}`}
          >
            Attendance {sortKey === 'earlier' && (sortDirection === 'ascending' ? '↑' : '↓')}
          </button>
        </div>
        <ul aria-label="People" className="grid grid-cols-1 gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
          {sortedRows.map((row) => {
            if (row.rowType !== 'contextual_regularity') return null;
            const name = `${row.firstName} ${row.lastName}`;
            return <li key={`${row.rowType}-${row.individualId}`} className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700/60 dark:text-gray-100">
              <span className="min-w-0 truncate font-medium" title={name}>{name}</span>
              <span className="shrink-0 whitespace-nowrap text-gray-600 dark:text-gray-200">{row.evidence.attendedWeeks} of {row.evidence.opportunityWeeks} weeks ({formatPercent(row.rate)}%)</span>
            </li>;
          })}
        </ul>
      </> : <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600 dark:bg-gray-900/60 dark:text-gray-400">
            <tr>
              <th scope="col" aria-sort={sortKey === 'surname' ? sortDirection : 'none'} className="px-4 py-2 font-medium"><button type="button" onClick={() => toggleSort('surname')} aria-label={`Sort by name ${nextDirection('surname')}`} className="font-medium hover:underline">Name</button></th>
              <th scope="col" aria-sort={sortKey === 'earlier' ? sortDirection : 'none'} className="px-4 py-2 font-medium"><button type="button" onClick={() => toggleSort('earlier')} aria-label={`Sort by ${showRecentChange ? 'earlier attendance' : 'attendance'} ${nextDirection('earlier')}`} className="font-medium hover:underline">{showRecentChange ? 'Earlier attendance' : 'Attendance'}</button></th>
              {showRecentChange && <th scope="col" aria-sort={sortKey === 'recent' ? sortDirection : 'none'} className="px-4 py-2 font-medium"><button type="button" onClick={() => toggleSort('recent')} aria-label={`Sort by recent attendance ${nextDirection('recent')}`} className="font-medium hover:underline">Recent attendance</button></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {sortedRows.map((row) => {
              const name = `${row.firstName} ${row.lastName}`;
              if ((row.rowType === 'contextual_decline' || row.rowType === 'contextual_increase')) {
                return <tr key={`${row.rowType}-${row.individualId}`} className="text-gray-900 dark:text-gray-100">
                  <th scope="row" className="whitespace-nowrap px-4 py-2 text-left font-medium">
                    <AttendanceHistoryPopover people={[{ individualId: row.individualId, name }]} gatheringIds={gatheringIds}>
                      <span className="block">{name}</span>
                    </AttendanceHistoryPopover>
                  </th>
                  <td className="whitespace-nowrap px-4 py-2">{row.baseline.attendedWeeks} of {row.baseline.opportunityWeeks} earlier weeks ({formatPercent(row.baseline.rate)}%)</td>
                  <td className="whitespace-nowrap px-4 py-2">{row.recent.attendedWeeks} of {row.recent.opportunityWeeks} recent weeks ({formatPercent(row.recent.rate)}%)</td>
                </tr>;
              }
              return null;
            })}
          </tbody>
        </table>
      </div>}
      {loading && <p role="status" className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">Loading…</p>}
      {!loading && rows.length === 0 && !error && <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">No matching people.</p>}
      {cursor && !loading && <div className="px-4 py-3"><button type="button" className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white" onClick={() => void load(cursor)}>Load more</button></div>}
    </section>
  );
};

export default EngagementPeoplePanel;
