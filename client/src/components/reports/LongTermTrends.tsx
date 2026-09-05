import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
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
import EngagementPeoplePanel from './EngagementPeoplePanel';
import RegularitySettings from './RegularitySettings';
import { ReportPanel, ReportPanelExpansion, ReportPanelSectionHeading } from './ReportPanelGrid';

ChartJS.register( CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

interface LongTermTrendsProps {
  churchId: string;
  selectedGatherings: GatheringType[];
  canConfigure: boolean;
  embedded?: boolean;
}

interface ScopedOverview {
  scopeKey: string;
  data: ContextualLongTermOverviewDto;
}

interface OpenPeoplePanel {
  token: string;
  title: string;
  placement: 'regularity' | 'changes';
  selector: 'core' | 'casual' | 'irregular' | 'increases' | 'declines';
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

function directionSummary(direction: Pick<ContextualLongTermOverviewDto['direction'], 'comparisonWeeks' | 'percentChange' | 'status'>): string {
  if (direction.status === 'unavailable' || direction.percentChange === null) {
    return `There is not enough completed attendance history to compare the latest ${direction.comparisonWeeks} weeks.`;
  }
  if (direction.status === 'steady') {
    return `Average attendance is steady compared with the previous ${direction.comparisonWeeks} weeks.`;
  }
  return `Average attendance is ${direction.status} ${formatPercent(direction.percentChange)}% compared with the previous ${direction.comparisonWeeks} weeks.`;
}

const LongTermTrends: React.FC<LongTermTrendsProps> = ({ churchId, selectedGatherings, canConfigure, embedded = false }) => {
  const [isDarkMode, setIsDarkMode] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) => setIsDarkMode(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

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
  const [changeTab, setChangeTab] = useState<'increases' | 'declines'>('declines');
  const [showHistory, setShowHistory] = useState(false);
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
    setShowSettings(false);
    setShowHistory(false);
    setChangeTab('declines');
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

  const historyAxes = useMemo(() => {
    const series = overview?.direction.series ?? [];
    const ranked = series.map((item) => {
      const populated = item.buckets.filter((bucket) => bucket.averageAttendance !== null);
      const sessions = populated.reduce((total, bucket) => total + bucket.heldSessions, 0);
      const average = sessions ? populated.reduce((total, bucket) => total + bucket.averageAttendance! * bucket.heldSessions, 0) / sessions : 0;
      return { id: item.gatheringTypeId, average };
    }).sort((left, right) => left.average - right.average);
    let split = 1;
    let largestGap = -1;
    for (let index = 1; index < ranked.length; index += 1) {
      const gap = (ranked[index].average + 1) / (ranked[index - 1].average + 1);
      if (gap > largestGap) { largestGap = gap; split = index; }
    }
    return new Map(ranked.map((item, index) => [item.id, index < split ? 'y' : 'yRight']));
  }, [overview]);

  const historyRange = useMemo(() => {
    const series = overview?.direction.series ?? [];
    const populated = series.flatMap((item) => item.buckets.flatMap((bucket, index) =>
      bucket.averageAttendance !== null ? [index] : []));
    return populated.length ? { start: Math.min(...populated), end: Math.max(...populated) + 1 } : { start: 0, end: 0 };
  }, [overview]);

  const trendData = useMemo(() => {
    if (!overview) return { labels: [], datasets: [] };
    const labels = overview.direction.series[0]?.buckets.slice(historyRange.start, historyRange.end).map(
      (bucket) => new Intl.DateTimeFormat('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${bucket.startDate}T12:00:00Z`)),
    ) || [];
    return {
      labels,
      datasets: overview.direction.series.map((series, index) => ({
        label: series.name,
        yAxisID: historyAxes.get(series.gatheringTypeId),
        data: series.buckets.slice(historyRange.start, historyRange.end).map(({ averageAttendance }) => averageAttendance === null ? null : Math.round(averageAttendance)),
        borderColor: SERIES_COLOURS[index % SERIES_COLOURS.length],
        backgroundColor: SERIES_COLOURS[index % SERIES_COLOURS.length],
        tension: 0.25,
      })),
    };
  }, [overview, historyAxes, historyRange]);

  const historyOptions = useMemo<ChartOptions<'line'>>(() => {
    const series = overview?.direction.series ?? [];
    const axis = (id: string, position: 'left' | 'right') => {
      const members = series.filter((item) => historyAxes.get(item.gatheringTypeId) === id);
      const colour = members.length === 1 ? SERIES_COLOURS[series.indexOf(members[0]) % SERIES_COLOURS.length] : '#64748b';
      return {
        type: 'linear' as const,
        position,
        display: members.length > 0,
        beginAtZero: true,
        title: { display: true, text: members.map((item) => item.name).join(' / '), color: colour },
        ticks: { precision: 0, color: colour },
        grid: { drawOnChartArea: position === 'left' },
      };
    };
    return {
      maintainAspectRatio: false,
      responsive: true,
      scales: {
        x: { ticks: { color: isDarkMode ? '#d1d5db' : '#374151', autoSkip: false, maxRotation: 0, callback: (_value, index) => index === 0 || trendData.labels[index] !== trendData.labels[index - 1] ? trendData.labels[index] : '' } },
        y: axis('y', 'left'),
        yRight: axis('yRight', 'right'),
      },
      plugins: { tooltip: { callbacks: { title: (items) => {
        const item = items[0];
        const bucket = item && series[item.datasetIndex]?.buckets[item.dataIndex + historyRange.start];
        return bucket ? `${formatDate(bucket.startDate)} – ${formatDate(bucket.endDate)}` : '';
      } } } },
    };
  }, [overview, historyAxes, trendData.labels, historyRange.start, isDarkMode]);

  const changes = overview?.[changeTab];
  const changeTitle = changeTab === 'increases' ? 'People attending more often' : 'People attending less often';
  const selectChangeTab = (tab: 'increases' | 'declines') => {
    setPeoplePanel(null);
    setChangeTab(tab);
  };

  const openPeople = (token: string, title: string, placement: OpenPeoplePanel['placement'], selector: OpenPeoplePanel['selector']) => {
    setPeoplePanel({ token, title, placement, selector });
  };
  const refreshPeopleToken = useCallback(async (): Promise<boolean> => {
    const pendingPanel = peoplePanel;
    if (!pendingPanel) return false;
    try {
      const response = await reportsAPI.getLongTermTrends(gatheringTypeIds);
      const freshOverview = response.data;
      if (freshOverview.churchId !== churchId
          || !sameSelection(freshOverview.gatheringTypeIds, gatheringTypeIds)) return false;
      const freshToken = pendingPanel.placement === 'regularity'
        ? freshOverview.regularity?.tiers.find((tier) => tier.tier === pendingPanel.selector)?.peopleToken
        : (pendingPanel.selector === 'increases' || pendingPanel.selector === 'declines'
          ? freshOverview[pendingPanel.selector]?.peopleToken
          : null);
      if (!freshToken) return false;
      setOverviewState({ scopeKey, data: freshOverview });
      writeLongTermTrendsCache(freshOverview);
      setPeoplePanel((current) => current?.token === pendingPanel.token
        ? { ...current, token: freshToken }
        : current);
      return true;
    } catch {
      return false;
    }
  }, [churchId, gatheringTypeIds, peoplePanel, scopeKey]);
  const renderPeoplePanel = (placement: OpenPeoplePanel['placement']) => peoplePanel?.placement === placement && overview
    ? <EngagementPeoplePanel
        key={peoplePanel.token}
        token={peoplePanel.token}
        title={peoplePanel.title}
        gatheringIds={gatheringTypeIds}
        onClose={() => setPeoplePanel(null)}
        onTokenExpired={refreshPeopleToken}
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
    <section className={embedded ? 'contents' : 'space-y-5 border-t border-gray-200 pt-8 dark:border-gray-700'} aria-labelledby="long-term-trends-heading">
      {embedded ? (
        <ReportPanelSectionHeading
          ids={['attendance-direction', 'regularity', 'attendance-changes']}
          description={selectionKey && overview ? <>
            <p>Based on {overview.dataAvailability.availableWeeks} weeks of available attendance history.</p>
            <p>The date range above does not affect these trends.</p>
          </> : undefined}
        >
          Long-term trends
        </ReportPanelSectionHeading>
      ) : <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-1">
        <div>
          <h2 id="long-term-trends-heading" className="text-2xl font-bold text-gray-900 dark:text-gray-100">Long-term trends</h2>
          {selectionKey && overview && (
            <div className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
              <p>Based on {overview.dataAvailability.availableWeeks} weeks of available attendance history.</p>
              <p>The date range above does not affect these trends.</p>
            </div>
          )}
        </div>
        {updating && overview && <p role="status" className="pt-1 text-sm font-medium text-gray-500 dark:text-gray-400">Updating…</p>}
      </header>}

      {!selectionKey ? (
        <ReportPanel id="attendance-direction"><div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300">
          Choose one or more gatherings to see long-term trends.
        </div></ReportPanel>
      ) : !overview && updating ? (
        <ReportPanel id="attendance-direction"><div role="status" className="rounded-xl bg-white p-6 text-sm text-gray-600 shadow-sm dark:bg-gray-800 dark:text-gray-300">Loading long-term trends…</div></ReportPanel>
      ) : !overview ? (
        <ReportPanel id="attendance-direction"><div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">
          <p>{error || 'Could not load long-term trends.'}</p>
          <button type="button" onClick={() => setRetryGeneration((generation) => generation + 1)} className="mt-3 rounded bg-red-700 px-3 py-2 font-medium text-white hover:bg-red-800">Try again</button>
        </div></ReportPanel>
      ) : (
        <>
          {error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">{error}</p>}

          <div className={embedded ? 'contents' : 'grid items-stretch gap-5 lg:grid-cols-2'}>
          <ReportPanel id="attendance-direction"><section className="h-full min-w-0 rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800" aria-labelledby="attendance-direction-heading">
            <h3 id="attendance-direction-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Attendance direction</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {overview.direction.series.map((series) => {
                const comparison = series.comparison;
                return <section key={series.gatheringTypeId} aria-label={`${series.name} attendance trend`} className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                  <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">{series.name}</h4>
                  {!comparison ? <p className="text-sm text-gray-500 dark:text-gray-400">Refresh the report to see this gathering’s averages.</p> : <>
                    <p className={`text-2xl font-semibold tracking-tight ${comparison.status === 'up' ? 'text-emerald-700 dark:text-emerald-300' : comparison.status === 'down' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-900 dark:text-gray-100'}`}>
                      {comparison.status === 'unavailable' || comparison.percentChange === null ? 'Not enough history'
                        : comparison.status === 'steady' ? 'Steady'
                        : `${comparison.status === 'up' ? '↑' : '↓'} ${formatPercent(comparison.percentChange)}%`}
                    </p>
                    <p className="sr-only">{directionSummary(comparison)}</p>
                    <dl className="mt-3 grid grid-cols-2 gap-4">
                      <div><dt className="text-xs text-gray-500 dark:text-gray-400">Latest {comparison.comparisonWeeks} weeks</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{comparison.recentAverage === null ? '—' : Math.round(comparison.recentAverage)}<span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">avg.</span></dd></div>
                      <div><dt className="text-xs text-gray-500 dark:text-gray-400">Previous {comparison.comparisonWeeks} weeks</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{comparison.previousAverage === null ? '—' : Math.round(comparison.previousAverage)}<span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">avg.</span></dd></div>
                    </dl>
                  </>}
                </section>;
              })}
            </div>
            <button type="button" aria-expanded={showHistory} aria-controls="attendance-history-detail" onClick={() => setShowHistory(!showHistory)} className="mt-5 rounded text-sm font-medium text-indigo-700 hover:underline focus-visible:outline focus-visible:outline-2 dark:text-indigo-300">{showHistory ? 'Hide attendance history' : 'View attendance history'}</button>
          </section></ReportPanel>
          {showHistory && (
            <ReportPanelExpansion after="attendance-direction"><section id="attendance-history-detail" aria-label="Attendance history" className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
              <div className="h-64 sm:h-72"><Line aria-label="Attendance direction chart" data={trendData} options={historyOptions} /></div>
            </section></ReportPanelExpansion>
          )}

          <ReportPanel id="regularity"><section className="h-full rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800" aria-labelledby="regularity-heading">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="regularity-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Regularity</h3>
                {overview.regularity && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{overview.regularity.population} assigned active regulars</p>}
              </div>
              {canConfigure && overview.regularity && <button type="button" onClick={() => setShowSettings(true)} className="rounded border border-indigo-600 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-300 dark:text-indigo-300 dark:hover:bg-gray-700">Regularity settings</button>}
            </div>
            {!overview.regularity ? (
              <p className="mt-3 rounded-lg bg-blue-50 p-4 text-sm text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">Person-level trends require a standard attendance gathering because headcount gatherings do not identify attendees.</p>
            ) : overview.regularity.population === 0 ? (
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">No active regulars are currently assigned to the selected standard gatherings.</p>
            ) : (
              <div className="mt-5 space-y-4">
                <div role="img" aria-label="Regularity distribution" className="flex h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
                  {overview.regularity.tiers.map((tier) => <span key={tier.tier} style={{ width: `${tier.rate}%`, backgroundColor: tier.colour }} />)}
                </div>
                <div className="space-y-2">
                  {overview.regularity.tiers.map((tier) => (
                    <button key={tier.tier} type="button" onClick={() => openPeople(tier.peopleToken, `${tier.label} people`, 'regularity', tier.tier)} className="flex w-full items-center gap-3 rounded-lg border border-gray-200 p-3 text-left text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700">
                      <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: tier.colour }} />
                      <span>{tier.label}: {people(tier.count)} ({formatPercent(tier.rate)}%)</span>
                    </button>
                  ))}
                  <p className="text-xs text-gray-500 dark:text-gray-400">Each person with attendance evidence is counted once.</p>
                </div>
              </div>
            )}
          </section></ReportPanel>
          {peoplePanel?.placement === 'regularity' && (
            <ReportPanelExpansion after="regularity">
              {renderPeoplePanel('regularity')}
            </ReportPanelExpansion>
          )}
          </div>

          <ReportPanel id="attendance-changes"><div className="space-y-3"><section className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800" aria-labelledby="attendance-changes-heading">
            <h3 id="attendance-changes-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Attendance changes</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Notice growing connections and people you may want to check in with.</p>
            <div role="tablist" aria-label="Attendance changes" className="mt-4 flex gap-1 border-b border-gray-200 dark:border-gray-700">
              {(['increases', 'declines'] as const).map((tab) => (
                <button key={tab} type="button" role="tab" id={`attendance-${tab}-tab`} aria-controls="attendance-changes-panel" aria-selected={changeTab === tab} tabIndex={changeTab === tab ? 0 : -1}
                  onClick={() => selectChangeTab(tab)}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const next = event.key === 'Home' ? 'increases' : event.key === 'End' ? 'declines' : tab === 'increases' ? 'declines' : 'increases';
                    selectChangeTab(next);
                    document.getElementById(`attendance-${next}-tab`)?.focus();
                  }}
                  className={`flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 ${changeTab === tab ? 'border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300' : 'border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'}`}>
                  {tab === 'increases' ? 'Attending more often' : 'Attending less often'}
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs tabular-nums dark:bg-gray-700">{overview[tab]?.total ?? '—'}</span>
                </button>
              ))}
            </div>
            <div role="tabpanel" id="attendance-changes-panel" aria-labelledby={`attendance-${changeTab}-tab`} tabIndex={0}>
            <section aria-label={changeTitle} className="pt-4">
            {!changes ? (
              <p className="text-sm text-gray-600 dark:text-gray-300">{overview.dataAvailability.standardGatherings === 0 ? 'Select a standard attendance gathering to see person-level changes.' : 'Refresh this report to load people attending more often.'}</p>
            ) : changes.total === 0 ? (
              <p className="text-sm text-gray-600 dark:text-gray-300">No meaningful recent {changeTab === 'increases' ? 'increases' : 'declines'} were found in the available history.</p>
            ) : (
              <>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {changes.rows.slice(0, 4).map((row) => (
                    <li key={`${changeTab}-${row.individualId}`} className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                      <AttendanceHistoryPopover
                        people={[{ individualId: row.individualId, name: `${row.firstName} ${row.lastName}` }]}
                        gatheringIds={gatheringTypeIds}
                      >
                        <span className="block">
                          <span className="flex items-start justify-between gap-3">
                            <span className="font-medium text-gray-900 dark:text-gray-100">{row.firstName} {row.lastName}</span>
                            <span aria-hidden="true" className={changeTab === 'increases' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>{changeTab === 'increases' ? '↗' : '↘'}</span>
                          </span>
                          <span className="mt-2 block text-sm leading-relaxed text-gray-600 dark:text-gray-300">{row.summary}</span>
                        </span>
                      </AttendanceHistoryPopover>
                    </li>
                  ))}
                </ul>
                {changes.total > Math.min(4, changes.rows.length) && (
                  <button type="button" onClick={() => openPeople(changes.peopleToken, changeTitle, 'changes', changeTab)} className="mt-4 rounded px-1 py-2 text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300">View all {changes.total} people</button>
                )}
              </>
            )}
            {renderPeoplePanel('changes')}
            </section>
            </div>
          </section>

          {overview.dataAvailability.excludedWeeks > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{overview.dataAvailability.excludedWeeks} completed {overview.dataAvailability.excludedWeeks === 1 ? 'week was' : 'weeks were'} excluded from person-level results because reliable attendance evidence was unavailable.</p>
          )}
          </div></ReportPanel>
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
    </section>
  );
};

export default LongTermTrends;
