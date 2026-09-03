import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContextualEngagementSettingsDto,
  EngagementDrilldownPage,
  EngagementPersonDrilldownRow,
  EngagementSettingsDto,
  EngagementTierKey,
} from '../../services/api';
import { reportsAPI } from '../../services/api';
import EngagementEvidence from './EngagementEvidence';
import EngagementTierBadge from './EngagementTierBadge';

interface EngagementPeoplePanelProps {
  token: string;
  title: string;
  settings: EngagementSettingsDto | ContextualEngagementSettingsDto;
  variant?: 'legacy' | 'contextual';
  onClose: () => void;
}

interface ContextualRegularityRow {
  rowType: 'contextual_regularity';
  individualId: number;
  firstName: string;
  lastName: string;
  familyId: number | null;
  tier: EngagementTierKey;
  rate: number;
  evidence: { attendedWeeks: number; opportunityWeeks: number };
}

interface ContextualDeclineRow {
  rowType: 'contextual_decline';
  individualId: number;
  firstName: string;
  lastName: string;
  familyId: number | null;
  baseline: { attendedWeeks: number; opportunityWeeks: number; rate: number };
  recent: { attendedWeeks: number; opportunityWeeks: number; rate: number };
  summary: string;
}

type PeopleRow = EngagementPersonDrilldownRow | ContextualRegularityRow | ContextualDeclineRow;

type SortKey = 'surname' | 'attendance';
type SortDirection = 'ascending' | 'descending';

function surnameCompare(left: PeopleRow, right: PeopleRow): number {
  return left.lastName.localeCompare(right.lastName, undefined, { sensitivity: 'base' })
    || left.firstName.localeCompare(right.firstName, undefined, { sensitivity: 'base' });
}

function attendanceRate(row: PeopleRow): number | null {
  if (row.rowType === 'engagement_profile') return row.primary.rate;
  if (row.rowType === 'contextual_regularity') return row.rate;
  if (row.rowType === 'contextual_decline') return row.recent.rate;
  return null;
}

const formatPercent = (value: number) => Number(value.toFixed(1));

const formatDate = (value: string) => new Intl.DateTimeFormat('en-AU', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`));

const EngagementPeoplePanel: React.FC<EngagementPeoplePanelProps> = ({ token, title, settings, variant = 'legacy', onClose }) => {
  const [rows, setRows] = useState<PeopleRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('surname');
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
      const page = response.data as unknown as EngagementDrilldownPage<PeopleRow>;
      setRows((current) => nextCursor ? [...current, ...page.rows] : page.rows);
      setCursor(page.nextCursor);
    } catch {
      setError('Could not load these people.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const showCommunity = useMemo(() => rows.some((row) => row.rowType === 'engagement_profile' && row.community.status !== 'not_assigned'), [rows]);
  const isVisitorJourney = rows.length > 0 && rows.every((row) => row.rowType === 'visitor_journey');
  const isContextual = variant === 'contextual'
    || rows.some((row) => row.rowType === 'contextual_regularity' || row.rowType === 'contextual_decline');
  const showRecentChange = rows.some((row) => row.rowType === 'contextual_decline');
  const sortedRows = useMemo(() => [...rows].sort((left, right) => {
    if (sortKey === 'surname') return surnameCompare(left, right) * (sortDirection === 'ascending' ? 1 : -1);
    const leftRate = attendanceRate(left);
    const rightRate = attendanceRate(right);
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
        <h3 ref={headingRef} tabIndex={-1} className="font-semibold text-gray-900 outline-none dark:text-gray-100">{title}</h3>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Close</button>
      </div>
      {error && <p role="alert" className="px-4 py-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600 dark:bg-gray-900/60 dark:text-gray-400">
            <tr>
              <th scope="col" aria-sort={sortKey === 'surname' ? sortDirection : 'none'} className="px-4 py-2 font-medium"><button type="button" onClick={() => toggleSort('surname')} aria-label={`Sort by ${isContextual ? 'name' : 'surname'} ${nextDirection('surname')}`} className="font-medium hover:underline">{isContextual ? 'Name' : 'Surname'}</button></th>
              <th scope="col" aria-sort={sortKey === 'attendance' ? sortDirection : 'none'} className="px-4 py-2 font-medium">{isVisitorJourney ? 'First attendance' : <button type="button" onClick={() => toggleSort('attendance')} aria-label={`Sort by ${isContextual ? '' : 'Primary '}attendance ${nextDirection('attendance')}`} className="font-medium hover:underline">{isContextual ? 'Attendance' : 'Primary attendance'}</button>}</th>
              {!isContextual && showCommunity && <th scope="col" className="px-4 py-2 font-medium">Other participation</th>}
              {showRecentChange && <th scope="col" className="px-4 py-2 font-medium">Recent change</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {sortedRows.map((row) => {
              const name = `${row.firstName} ${row.lastName}`;
              if (row.rowType === 'contextual_regularity') {
                return <tr key={`${row.rowType}-${row.individualId}`} className="text-gray-900 dark:text-gray-100">
                  <th scope="row" className="whitespace-nowrap px-4 py-2 text-left font-medium">{name}</th>
                  <td className="whitespace-nowrap px-4 py-2">{row.evidence.attendedWeeks} of {row.evidence.opportunityWeeks} weeks ({formatPercent(row.rate)}%)</td>
                </tr>;
              }
              if (row.rowType === 'contextual_decline') {
                return <tr key={`${row.rowType}-${row.individualId}`} className="text-gray-900 dark:text-gray-100">
                  <th scope="row" className="whitespace-nowrap px-4 py-2 text-left font-medium">{name}</th>
                  <td className="whitespace-nowrap px-4 py-2">{row.baseline.attendedWeeks} of {row.baseline.opportunityWeeks} earlier weeks ({formatPercent(row.baseline.rate)}%)</td>
                  <td className="whitespace-nowrap px-4 py-2">{row.recent.attendedWeeks} of {row.recent.opportunityWeeks} recent weeks ({formatPercent(row.recent.rate)}%)</td>
                </tr>;
              }
              if (row.rowType === 'engagement_profile') {
                return <tr key={`${row.rowType}-${row.individualId}`} className="text-gray-900 dark:text-gray-100">
                  <th scope="row" className="whitespace-nowrap px-4 py-2 text-left font-medium">{name}</th>
                  <td className="whitespace-nowrap px-4 py-2"><EngagementTierBadge status={row.primary} settings={settings as EngagementSettingsDto} /> <EngagementEvidence status={row.primary} /></td>
                  {showCommunity && <td className="whitespace-nowrap px-4 py-2">{row.community.status === 'not_assigned' ? '—' : <><EngagementTierBadge status={row.community} settings={settings as EngagementSettingsDto} /> <EngagementEvidence status={row.community} /></>}</td>}
                </tr>;
              }
              return <tr key={`${row.rowType}-${row.individualId}`} className="text-gray-900 dark:text-gray-100">
                <th scope="row" className="whitespace-nowrap px-4 py-2 text-left font-medium">{name}</th>
                <td className="px-4 py-2" colSpan={(showCommunity ? 1 : 0) + 1}>{row.rowType === 'visitor_journey' ? formatDate(row.firstAttendanceDate) : 'Attendance record'}</td>
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
