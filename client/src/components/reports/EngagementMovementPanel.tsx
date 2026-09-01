import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EngagementDrilldownPage,
  EngagementOverviewDto,
  EngagementPersonDrilldownRow,
  EngagementSettingsDto,
  EngagementTierKey,
} from '../../services/api';
import { percentage } from './EngagementEvidence';

type MovementCategory = 'confirmingHigher' | 'confirmingLower' | 'confirmedRecently';
type SortKey = 'surname' | 'attendance';
type SortDirection = 'ascending' | 'descending';

interface EngagementMovementPanelProps {
  movement: EngagementOverviewDto['tierMovement'];
  settings: EngagementSettingsDto;
  loadPeople: (
    token: string,
    cursor?: string,
  ) => Promise<EngagementDrilldownPage<EngagementPersonDrilldownRow>>;
}

const CATEGORY_LABELS: Record<MovementCategory, string> = {
  confirmingHigher: 'Confirming higher',
  confirmingLower: 'Confirming lower',
  confirmedRecently: 'Confirmed recently',
};

const CATEGORIES: MovementCategory[] = ['confirmingHigher', 'confirmingLower', 'confirmedRecently'];

function people(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

function surnameCompare(left: EngagementPersonDrilldownRow, right: EngagementPersonDrilldownRow): number {
  return left.lastName.localeCompare(right.lastName, undefined, { sensitivity: 'base' })
    || left.firstName.localeCompare(right.firstName, undefined, { sensitivity: 'base' });
}

function attendanceRate(row: EngagementPersonDrilldownRow): number | null {
  if (row.rowType === 'engagement_confirmation') return row.rate;
  if (row.rowType === 'engagement_transition') return row.confirmationEvidence.rate;
  return null;
}

function evidence(attended: number, opportunities: number, rate: number): string {
  return `${attended} of ${opportunities} (${percentage(rate)}%)`;
}

const EngagementMovementPanel: React.FC<EngagementMovementPanelProps> = ({ movement, settings, loadPeople }) => {
  const [axis, setAxis] = useState<'primary' | 'community'>('primary');
  const [selected, setSelected] = useState<MovementCategory | null>(null);
  const [rows, setRows] = useState<EngagementPersonDrilldownRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('surname');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const request = useRef(0);

  const load = useCallback(async (category: MovementCategory, nextCursor?: string) => {
    const requestId = ++request.current;
    setLoading(true);
    setError('');
    try {
      const page = await loadPeople(movement.axes[axis][category].peopleToken, nextCursor);
      if (requestId !== request.current) return;
      setRows((current) => nextCursor ? [...current, ...page.rows] : page.rows);
      setCursor(page.nextCursor);
    } catch {
      if (requestId !== request.current) return;
      setError('Could not load movement details. Please try again.');
    } finally {
      if (requestId === request.current) setLoading(false);
    }
  }, [axis, loadPeople, movement.axes]);

  useEffect(() => {
    if (selected) void load(selected);
    return () => { request.current += 1; };
  }, [load, selected]);

  const chooseAxis = (nextAxis: 'primary' | 'community') => {
    if (nextAxis === axis) return;
    request.current += 1;
    setAxis(nextAxis);
    setSelected(null);
    setRows([]);
    setCursor(null);
    setError('');
  };

  const chooseCategory = (category: MovementCategory) => {
    if (selected === category) {
      request.current += 1;
      setSelected(null);
      setRows([]);
      setCursor(null);
      setError('');
      return;
    }
    setRows([]);
    setCursor(null);
    setSortKey('surname');
    setSortDirection('ascending');
    setSelected(category);
  };

  const close = () => {
    request.current += 1;
    setSelected(null);
    setRows([]);
    setCursor(null);
    setError('');
  };

  const sortedRows = useMemo(() => [...rows].sort((left, right) => {
    if (sortKey === 'surname') {
      return surnameCompare(left, right) * (sortDirection === 'ascending' ? 1 : -1);
    }
    const leftRate = attendanceRate(left);
    const rightRate = attendanceRate(right);
    if (leftRate === null && rightRate === null) return surnameCompare(left, right);
    if (leftRate === null) return 1;
    if (rightRate === null) return -1;
    return (leftRate - rightRate) * (sortDirection === 'ascending' ? 1 : -1)
      || surnameCompare(left, right);
  }), [rows, sortDirection, sortKey]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection((current) => current === 'ascending' ? 'descending' : 'ascending');
      return;
    }
    setSortKey(key);
    setSortDirection(key === 'surname' ? 'ascending' : 'descending');
  };

  const nextDirection = (key: SortKey): SortDirection => {
    if (key !== sortKey) return key === 'surname' ? 'ascending' : 'descending';
    return sortDirection === 'ascending' ? 'descending' : 'ascending';
  };

  const axisLabel = axis === 'primary' ? 'Primary' : 'Other participation';
  const selectedLabel = selected ? CATEGORY_LABELS[selected] : '';
  const isConfirmed = selected === 'confirmedRecently';

  const tierLabel = (tier: EngagementTierKey): string => settings.tiers[tier].label;

  return (
    <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="movement-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="movement-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Tier movement</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Confirmed changes from the last {movement.recentWindowWeeks} weeks, plus changes still gathering evidence.</p>
        </div>
        <div role="group" aria-label="Movement axis" className="inline-flex rounded-md border border-gray-300 bg-gray-50 p-0.5 dark:border-gray-600 dark:bg-gray-900">
          {(['primary', 'community'] as const).map((option) => {
            const label = option === 'primary' ? 'Primary' : 'Other participation';
            const active = option === axis;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                onClick={() => chooseAxis(option)}
                className={`rounded px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 ${active ? 'bg-white text-gray-950 shadow-sm dark:bg-gray-700 dark:text-white' : 'text-gray-600 hover:text-gray-950 dark:text-gray-300 dark:hover:text-white'}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {CATEGORIES.map((category) => {
          const count = movement.axes[axis][category].count;
          const active = selected === category;
          const label = CATEGORY_LABELS[category];
          return (
            <button
              key={category}
              type="button"
              aria-label={`${label}, ${people(count)}`}
              aria-pressed={active}
              aria-expanded={active}
              onClick={() => chooseCategory(category)}
              className={`rounded-md border px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 ${active ? 'border-indigo-600 bg-indigo-50 text-indigo-950 dark:border-indigo-300 dark:bg-indigo-950/60 dark:text-indigo-100' : 'border-gray-200 text-gray-900 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600 dark:hover:bg-gray-700'}`}
            >
              <span className="block text-xl font-semibold leading-none">{count}</span>
              <span className="mt-1 block text-sm font-medium">{label}</span>
            </button>
          );
        })}
      </div>

      {selected && (
        <section className="mt-4 rounded-md border border-gray-200 dark:border-gray-700" aria-label={`${axisLabel} — ${selectedLabel}`}>
          <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-950 dark:text-gray-100">{axisLabel} · {selectedLabel}</h3>
            <button type="button" onClick={close} aria-label="Close movement details" className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-300 dark:hover:bg-gray-700">Close</button>
          </div>
          {error && <p role="alert" className="px-3 py-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600 dark:bg-gray-900/60 dark:text-gray-300">
                {isConfirmed ? (
                  <tr>
                    <th scope="col" aria-sort={sortKey === 'surname' ? sortDirection : 'none'} className="px-3 py-2 font-medium"><button type="button" onClick={() => toggleSort('surname')} aria-label={`Sort by surname ${nextDirection('surname')}`} className="font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Surname</button></th>
                    <th scope="col" className="px-3 py-2 font-medium">Change</th>
                    <th scope="col" className="px-3 py-2 font-medium">Axis</th>
                    <th scope="col" className="px-3 py-2 font-medium">Confirmation week</th>
                    <th scope="col" className="px-3 py-2 font-medium">52-week evidence</th>
                    <th scope="col" aria-sort={sortKey === 'attendance' ? sortDirection : 'none'} className="px-3 py-2 font-medium"><button type="button" onClick={() => toggleSort('attendance')} aria-label={`Sort by attendance percentage ${nextDirection('attendance')}`} className="font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Confirmation evidence</button></th>
                  </tr>
                ) : (
                  <tr>
                    <th scope="col" aria-sort={sortKey === 'surname' ? sortDirection : 'none'} className="px-3 py-2 font-medium"><button type="button" onClick={() => toggleSort('surname')} aria-label={`Sort by surname ${nextDirection('surname')}`} className="font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Surname</button></th>
                    <th scope="col" className="px-3 py-2 font-medium">Established → Candidate</th>
                    <th scope="col" className="px-3 py-2 font-medium">Observed</th>
                    <th scope="col" aria-sort={sortKey === 'attendance' ? sortDirection : 'none'} className="px-3 py-2 font-medium"><button type="button" onClick={() => toggleSort('attendance')} aria-label={`Sort by attendance percentage ${nextDirection('attendance')}`} className="font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Attendance</button></th>
                    <th scope="col" className="px-3 py-2 font-medium">Progress</th>
                  </tr>
                )}
              </thead>
              <tbody className="divide-y divide-gray-200 text-gray-900 dark:divide-gray-700 dark:text-gray-100">
                {sortedRows.map((row) => {
                  const name = `${row.firstName} ${row.lastName}`;
                  if (row.rowType === 'engagement_confirmation') {
                    return (
                      <tr key={`confirmation-${row.individualId}`}>
                        <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">{name}</th>
                        <td className="whitespace-nowrap px-3 py-2">{tierLabel(row.establishedTier)} → {tierLabel(row.candidateTier)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{row.observedOpportunities}/8 opportunities observed</td>
                        <td className="whitespace-nowrap px-3 py-2">{row.attended} attended ({row.rate === null ? '—' : `${percentage(row.rate)}%`})</td>
                        <td className="whitespace-nowrap px-3 py-2">{row.currentWeek === 0 ? 'awaiting the first confirmation week' : `week ${row.currentWeek} of ${movement.recentWindowWeeks}`}</td>
                      </tr>
                    );
                  }
                  if (row.rowType === 'engagement_transition') {
                    return (
                      <tr key={`transition-${row.individualId}-${row.confirmedWeekEnd}`}>
                        <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">{name}</th>
                        <td className="whitespace-nowrap px-3 py-2">{tierLabel(row.fromTier)} → {tierLabel(row.toTier)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{row.axis === 'primary' ? 'Primary' : 'Other participation'}</td>
                        <td className="whitespace-nowrap px-3 py-2">{formatDate(row.confirmedWeekEnd)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{evidence(row.longTermEvidence.attended, row.longTermEvidence.opportunities, row.longTermEvidence.rate)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{evidence(row.confirmationEvidence.attended, row.confirmationEvidence.opportunities, row.confirmationEvidence.rate)}</td>
                      </tr>
                    );
                  }
                  return null;
                })}
              </tbody>
            </table>
          </div>
          {loading && <p role="status" className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">Loading movement details…</p>}
          {!loading && !error && rows.length === 0 && (
            <p className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
              {isConfirmed ? `No tier changes were confirmed in the last ${movement.recentWindowWeeks} weeks.` : 'No people are currently gathering evidence for this change.'}
            </p>
          )}
          {cursor && !loading && <div className="border-t border-gray-200 px-3 py-3 dark:border-gray-700"><button type="button" onClick={() => void load(selected, cursor)} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800">Load more</button></div>}
        </section>
      )}
    </section>
  );
};

export default EngagementMovementPanel;
