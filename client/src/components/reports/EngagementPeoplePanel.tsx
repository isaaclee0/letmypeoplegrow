import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { EngagementPersonDrilldownRow, EngagementSettingsDto } from '../../services/api';
import { reportsAPI } from '../../services/api';
import EngagementEvidence from './EngagementEvidence';
import EngagementTierBadge from './EngagementTierBadge';

interface EngagementPeoplePanelProps {
  token: string;
  title: string;
  settings: EngagementSettingsDto;
  movementWindow?: { currentEnd: string; previousEnd: string };
  onClose: () => void;
}

type SortKey = 'surname' | 'attendance';
type SortDirection = 'ascending' | 'descending';

function surnameCompare(left: EngagementPersonDrilldownRow, right: EngagementPersonDrilldownRow): number {
  return left.lastName.localeCompare(right.lastName, undefined, { sensitivity: 'base' })
    || left.firstName.localeCompare(right.firstName, undefined, { sensitivity: 'base' });
}

function primaryRate(row: EngagementPersonDrilldownRow): number | null {
  return row.rowType === 'engagement_profile' ? row.primary.rate : null;
}

const EngagementPeoplePanel: React.FC<EngagementPeoplePanelProps> = ({ token, title, settings, movementWindow, onClose }) => {
  const [rows, setRows] = useState<EngagementPersonDrilldownRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('surname');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');

  const load = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setError('');
    try {
      const response = await reportsAPI.getEngagementPeople({ segment: token, cursor: nextCursor, limit: 50 });
      setRows((current) => nextCursor ? [...current, ...response.data.rows] : response.data.rows);
      setCursor(response.data.nextCursor);
    } catch {
      setError('Could not load these people.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const showCommunity = useMemo(() => rows.some((row) => row.rowType === 'engagement_profile' && row.community.status !== 'not_assigned'), [rows]);
  const showPreviousPrimary = useMemo(() => rows.some((row) => row.rowType === 'engagement_profile' && row.previousPrimary), [rows]);
  const sortedRows = useMemo(() => [...rows].sort((left, right) => {
    if (sortKey === 'surname') return surnameCompare(left, right) * (sortDirection === 'ascending' ? 1 : -1);
    const leftRate = primaryRate(left);
    const rightRate = primaryRate(right);
    if (leftRate === null && rightRate === null) return surnameCompare(left, right);
    if (leftRate === null) return 1;
    if (rightRate === null) return -1;
    return (leftRate - rightRate) * (sortDirection === 'ascending' ? 1 : -1) || surnameCompare(left, right);
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
    <section className="mt-5 rounded-lg border border-gray-200 dark:border-gray-700" aria-label={title}>
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Close</button>
      </div>
      {error && <p role="alert" className="px-4 py-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600 dark:bg-gray-900/60 dark:text-gray-400">
            <tr>
              <th scope="col" aria-sort={sortKey === 'surname' ? sortDirection : 'none'} className="px-4 py-2 font-medium"><button type="button" onClick={() => toggleSort('surname')} aria-label={`Sort by surname ${nextDirection('surname')}`} className="font-medium hover:underline">Surname</button></th>
              <th scope="col" aria-sort={sortKey === 'attendance' ? sortDirection : 'none'} className="px-4 py-2 font-medium"><button type="button" onClick={() => toggleSort('attendance')} aria-label={`Sort by Primary attendance ${nextDirection('attendance')}`} className="font-medium hover:underline">{showPreviousPrimary && movementWindow ? `52 weeks ending ${movementWindow.currentEnd}` : 'Primary attendance'}</button></th>
              {showPreviousPrimary && <th scope="col" className="px-4 py-2 font-medium">{movementWindow ? `52 weeks ending ${movementWindow.previousEnd}` : 'Previous Primary'}</th>}
              {showCommunity && <th scope="col" className="px-4 py-2 font-medium">Community</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {sortedRows.map((row) => {
              const name = `${row.firstName} ${row.lastName}`;
              if (row.rowType === 'engagement_profile') {
                return <tr key={`${row.rowType}-${row.individualId}`} className="text-gray-900 dark:text-gray-100">
                  <th scope="row" className="whitespace-nowrap px-4 py-2 text-left font-medium">{name}</th>
                  <td className="whitespace-nowrap px-4 py-2"><EngagementTierBadge status={row.primary} settings={settings} /> <EngagementEvidence status={row.primary} /></td>
                  {showPreviousPrimary && <td className="whitespace-nowrap px-4 py-2">{row.previousPrimary ? <><EngagementTierBadge status={row.previousPrimary} settings={settings} /> <EngagementEvidence status={row.previousPrimary} /></> : '—'}</td>}
                  {showCommunity && <td className="whitespace-nowrap px-4 py-2">{row.community.status === 'not_assigned' ? '—' : <><EngagementTierBadge status={row.community} settings={settings} /> <EngagementEvidence status={row.community} /></>}</td>}
                </tr>;
              }
              return <tr key={`${row.rowType}-${row.individualId}`} className="text-gray-900 dark:text-gray-100">
                <th scope="row" className="whitespace-nowrap px-4 py-2 text-left font-medium">{name}</th>
                <td className="px-4 py-2" colSpan={(showPreviousPrimary ? 1 : 0) + (showCommunity ? 1 : 0) + 1}>{row.rowType === 'visitor_journey' ? `First attendance ${row.firstAttendanceDate}` : 'Attendance record'}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      {loading && <p role="status" className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">Loading…</p>}
      {!loading && rows.length === 0 && !error && <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">No matching people.</p>}
      {cursor && !loading && <div className="px-4 py-3"><button type="button" className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white" onClick={() => void load(cursor)}>Load more</button></div>}
    </section>
  );
};

export default EngagementPeoplePanel;
