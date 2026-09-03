import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';
import { Doughnut, Line } from 'react-chartjs-2';
import type {
  ContextualEngagementSettingsDto,
  ContextualLongTermOverviewDto,
  GatheringType,
} from '../../services/api';
import { reportsAPI } from '../../services/api';
import {
  clearLongTermTrendsCache,
  readLongTermTrendsCache,
  writeLongTermTrendsCache,
} from '../../services/engagementReportCache';
import AccessibleDialog from './AccessibleDialog';
import AttendanceHistoryPopover from './AttendanceHistoryPopover';
import EngagementDrilldown from './EngagementDrilldown';
import EngagementPeoplePanel from './EngagementPeoplePanel';
import RegularitySettings from './RegularitySettings';

ChartJS.register(ArcElement, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

interface LongTermTrendsProps {
  churchId: string;
  selectedGatherings: GatheringType[];
  canConfigure: boolean;
}

interface ScopedOverview {
  scopeKey: string;
  data: ContextualLongTermOverviewDto;
}

interface OpenPeoplePanel {
  token: string;
  title: string;
  placement: 'regularity' | 'declines';
}

interface OpenSessions {
  token: string;
  title: string;
}

const SERIES_COLOURS = ['#2563eb', '#0f766e', '#a16207', '#be123c', '#6d28d9', '#475569'];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
}

function people(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

function formatPercent(value: number): string {
  return String(Number(Math.abs(value).toFixed(1)));
}

function sameSelection(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function directionSummary(direction: ContextualLongTermOverviewDto['direction']): string {
  if (direction.status === 'unavailable' || direction.percentChange === null) {
    return `There is not enough completed attendance history to compare the latest ${direction.comparisonWeeks} weeks.`;
  }
  if (direction.status === 'steady') {
    return `Average attendance is steady compared with the previous ${direction.comparisonWeeks} weeks.`;
  }
  return `Average attendance is ${direction.status} ${formatPercent(direction.percentChange)}% compared with the previous ${direction.comparisonWeeks} weeks.`;
}

const LongTermTrends: React.FC<LongTermTrendsProps> = ({ churchId, selectedGatherings, canConfigure }) => {
  const selectionKey = useMemo(
    () => selectedGatherings.map(({ id }) => id).sort((a, b) => a - b).join(','),
    [selectedGatherings],
  );
  const gatheringTypeIds = useMemo(
    () => selectionKey ? selectionKey.split(',').map(Number) : [],
    [selectionKey],
  );
  const scopeKey = `${churchId}:${selectionKey}`;
  const [overviewState, setOverviewState] = useState<ScopedOverview | null>(() => {
    if (!selectionKey) return null;
    const cached = readLongTermTrendsCache(churchId, gatheringTypeIds);
    return cached ? { scopeKey, data: cached } : null;
  });
  const [updating, setUpdating] = useState(selectionKey.length > 0);
  const [error, setError] = useState('');
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [peoplePanel, setPeoplePanel] = useState<OpenPeoplePanel | null>(null);
  const [sessions, setSessions] = useState<OpenSessions | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const requestGeneration = useRef(0);

  const overview = overviewState?.scopeKey === scopeKey
    && overviewState.data.churchId === churchId
    && sameSelection(overviewState.data.gatheringTypeIds, gatheringTypeIds)
    ? overviewState.data
    : null;

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setPeoplePanel(null);
    setSessions(null);
    setShowSettings(false);
    setError('');

    if (gatheringTypeIds.length === 0) {
      setOverviewState(null);
      setUpdating(false);
      return () => { requestGeneration.current += 1; };
    }

    const cached = readLongTermTrendsCache(churchId, gatheringTypeIds);
    setOverviewState(cached ? { scopeKey, data: cached } : null);
    setUpdating(true);

    void reportsAPI.getLongTermTrends(gatheringTypeIds).then((response) => {
      if (requestGeneration.current !== generation) return;
      if (response.data.churchId !== churchId
          || !sameSelection(response.data.gatheringTypeIds, gatheringTypeIds)) {
        throw new Error('The report does not match the current selection.');
      }
      setOverviewState({ scopeKey, data: response.data });
      writeLongTermTrendsCache(response.data);
    }).catch(() => {
      if (requestGeneration.current !== generation) return;
      setError(cached
        ? 'Could not refresh long-term trends. You are showing saved data.'
        : 'Could not load long-term trends. Please try again.');
    }).finally(() => {
      if (requestGeneration.current === generation) setUpdating(false);
    });

    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [churchId, selectionKey, retryGeneration]); // IDs are represented canonically by selectionKey.

  const trendData = useMemo(() => {
    if (!overview) return { labels: [], datasets: [] };
    const labels = overview.direction.series[0]?.buckets.map(
      (bucket) => `${formatDate(bucket.startDate)} – ${formatDate(bucket.endDate)}`,
    ) || [];
    return {
      labels,
      datasets: overview.direction.series.map((series, index) => ({
        label: series.name,
        data: series.buckets.map(({ averageAttendance }) => averageAttendance),
        borderColor: SERIES_COLOURS[index % SERIES_COLOURS.length],
        backgroundColor: SERIES_COLOURS[index % SERIES_COLOURS.length],
        tension: 0.25,
      })),
    };
  }, [overview]);

  const regularityData = useMemo(() => overview?.regularity ? ({
    labels: overview.regularity.tiers.map(({ label }) => label),
    datasets: [{
      data: overview.regularity.tiers.map(({ count }) => count),
      backgroundColor: overview.regularity.tiers.map(({ colour }) => colour),
    }],
  }) : { labels: [], datasets: [] }, [overview]);

  const openPeople = (token: string, title: string, placement: OpenPeoplePanel['placement']) => {
    setPeoplePanel({ token, title, placement });
  };
  const renderPeoplePanel = (placement: OpenPeoplePanel['placement']) => peoplePanel?.placement === placement && overview
    ? <EngagementPeoplePanel
        key={peoplePanel.token}
        token={peoplePanel.token}
        title={peoplePanel.title}
        settings={overview.settings}
        variant="contextual"
        gatheringIds={gatheringTypeIds}
        onClose={() => setPeoplePanel(null)}
      />
    : null;

  const onSettingsSaved = (_settings: ContextualEngagementSettingsDto) => {
    setShowSettings(false);
    setPeoplePanel(null);
    setOverviewState(null);
    clearLongTermTrendsCache(churchId);
    setRetryGeneration((generation) => generation + 1);
  };

  return (
    <section className="space-y-5 border-t border-gray-200 pt-8 dark:border-gray-700" aria-labelledby="long-term-trends-heading">
      <header className="rounded-xl bg-slate-900 px-5 py-6 text-white shadow-sm dark:bg-slate-950">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-300">Completed-week view</p>
        <h2 id="long-term-trends-heading" className="mt-1 text-2xl font-bold">Long-term trends</h2>
        {selectionKey && overview && (
          <div className="mt-2 space-y-1 text-sm text-slate-200">
            {overview.dataAvailability.availableWeeks < overview.window.maximumWeeks ? (
              <p>Based on {overview.dataAvailability.availableWeeks} weeks of available attendance history. {formatDate(overview.window.startDate)} – {formatDate(overview.window.endDate)}.</p>
            ) : (
              <p>Based on the latest 52 completed weeks. {formatDate(overview.window.startDate)} – {formatDate(overview.window.endDate)}.</p>
            )}
            <p>The date range above does not affect these trends.</p>
            {overview.dataAvailability.standardGatherings > 1 && <p>Attendance at any selected gathering counts once per week.</p>}
            {overview.dataAvailability.standardGatherings > 0 && overview.dataAvailability.headcountGatherings > 0 && (
              <p className="text-amber-200">Attendance direction includes all selected gatherings. Person-level results use only the selected standard {overview.dataAvailability.standardGatherings === 1 ? 'gathering' : 'gatherings'}.</p>
            )}
          </div>
        )}
      </header>

      {!selectionKey ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300">
          Choose one or more gatherings to see long-term trends.
        </div>
      ) : !overview && updating ? (
        <div role="status" className="rounded-xl bg-white p-6 text-sm text-gray-600 shadow-sm dark:bg-gray-800 dark:text-gray-300">Loading long-term trends…</div>
      ) : !overview ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">
          <p>{error || 'Could not load long-term trends.'}</p>
          <button type="button" onClick={() => setRetryGeneration((generation) => generation + 1)} className="mt-3 rounded bg-red-700 px-3 py-2 font-medium text-white hover:bg-red-800">Try again</button>
        </div>
      ) : (
        <>
          {updating && <p role="status" className="text-sm font-medium text-indigo-700 dark:text-indigo-300">Updating…</p>}
          {error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">{error}</p>}

          <section className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800" aria-labelledby="attendance-direction-heading">
            <h3 id="attendance-direction-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Attendance direction</h3>
            <p className="mt-1 text-sm font-medium text-gray-800 dark:text-gray-200">{directionSummary(overview.direction)}</p>
            <div className="mt-5 min-h-56"><Line aria-label="Attendance direction chart" data={trendData} /></div>
            <ul className="mt-4 flex flex-wrap gap-2 text-sm">
              {overview.direction.series.map((series) => {
                const latest = [...series.buckets].reverse().find(({ heldSessions }) => heldSessions > 0);
                if (!latest) return <li key={series.gatheringTypeId} className="rounded border border-gray-200 px-3 py-2 text-gray-500 dark:border-gray-700 dark:text-gray-400">{series.name}: no held sessions</li>;
                const bucketRange = `${formatDate(latest.startDate)} – ${formatDate(latest.endDate)}`;
                return <li key={series.gatheringTypeId}>
                  <button type="button" onClick={() => setSessions({ token: latest.sessionsToken, title: `${series.name} attendance sessions — ${bucketRange}` })} className="rounded border border-gray-200 px-3 py-2 text-indigo-700 hover:bg-indigo-50 dark:border-gray-700 dark:text-indigo-300 dark:hover:bg-gray-700">View {series.name} attendance sessions for {bucketRange}</button>
                </li>;
              })}
            </ul>
          </section>

          <section className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800" aria-labelledby="regularity-heading">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="regularity-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Regularity</h3>
                {overview.regularity && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{overview.regularity.population} assigned active regulars</p>}
              </div>
              {canConfigure && overview.regularity && <button type="button" onClick={() => setShowSettings(true)} className="rounded border border-indigo-600 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-300 dark:text-indigo-300 dark:hover:bg-gray-700">Regularity settings</button>}
            </div>
            {overview.dataAvailability.unclassifiedBecauseNoEvidence > 0 && (
              <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                {people(overview.dataAvailability.unclassifiedBecauseNoEvidence)} could not be classified because they have no reliable attendance evidence.
              </p>
            )}
            {!overview.regularity ? (
              <p className="mt-3 rounded-lg bg-blue-50 p-4 text-sm text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">Person-level trends require a standard attendance gathering because headcount gatherings do not identify attendees.</p>
            ) : overview.regularity.population === 0 ? (
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">No active regulars are currently assigned to the selected standard gatherings.</p>
            ) : (
              <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,18rem)_1fr] lg:items-center">
                <Doughnut aria-label="Regularity chart" data={regularityData} />
                <div className="space-y-2">
                  {overview.regularity.tiers.map((tier) => (
                    <button key={tier.tier} type="button" onClick={() => openPeople(tier.peopleToken, `${tier.label} people`, 'regularity')} className="flex w-full items-center gap-3 rounded-lg border border-gray-200 p-3 text-left text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700">
                      <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: tier.colour }} />
                      <span>{tier.label}: {people(tier.count)} ({formatPercent(tier.rate)}%)</span>
                    </button>
                  ))}
                  <p className="text-xs text-gray-500 dark:text-gray-400">Each person is counted once. Labels identify every tier without relying on colour.</p>
                </div>
              </div>
            )}
            {renderPeoplePanel('regularity')}
          </section>

          <section className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800" aria-labelledby="declines-heading">
            <h3 id="declines-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">People attending less often</h3>
            {!overview.declines ? (
              <p className="mt-3 rounded-lg bg-blue-50 p-4 text-sm text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">Select a standard attendance gathering to see person-level changes.</p>
            ) : overview.declines.total === 0 ? (
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">No meaningful recent declines were found in the available history.</p>
            ) : (
              <>
                <ul className="mt-4 divide-y divide-gray-200 dark:divide-gray-700">
                  {overview.declines.rows.slice(0, 10).map((row) => (
                    <li key={row.individualId} className="py-3">
                      <AttendanceHistoryPopover
                        people={[{ individualId: row.individualId, name: `${row.firstName} ${row.lastName}` }]}
                        gatheringIds={gatheringTypeIds}
                      >
                        <span className="block">
                          <span className="block font-medium text-gray-900 dark:text-gray-100">{row.firstName} {row.lastName}</span>
                          <span className="mt-0.5 block text-sm text-gray-600 dark:text-gray-300">{row.summary}</span>
                        </span>
                      </AttendanceHistoryPopover>
                    </li>
                  ))}
                </ul>
                {overview.declines.total > overview.declines.rows.length && (
                  <button type="button" onClick={() => openPeople(overview.declines!.peopleToken, 'People attending less often', 'declines')} className="mt-4 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">View all {overview.declines.total} people</button>
                )}
              </>
            )}
            {renderPeoplePanel('declines')}
          </section>

          {overview.dataAvailability.excludedWeeks > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{overview.dataAvailability.excludedWeeks} completed {overview.dataAvailability.excludedWeeks === 1 ? 'week was' : 'weeks were'} excluded from person-level results because reliable attendance evidence was unavailable.</p>
          )}
        </>
      )}

      {showSettings && overview && (
        <AccessibleDialog label="Regularity settings" className="z-40" onClose={() => setShowSettings(false)}>
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <div className="mb-4 text-right"><button type="button" aria-label="Close settings" onClick={() => setShowSettings(false)} className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Close</button></div>
            <RegularitySettings settings={overview.settings} onSaved={onSettingsSaved} />
          </div>
        </AccessibleDialog>
      )}
      {sessions && overview && (
        <EngagementDrilldown
          kind="sessions"
          token={sessions.token}
          title={sessions.title}
          settings={overview.settings}
          onClose={() => setSessions(null)}
        />
      )}
    </section>
  );
};

export default LongTermTrends;
