import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { EngagementOverviewDto, EngagementSettingsDto } from '../../services/api';
import { reportsAPI, settingsAPI } from '../../services/api';
import {
  clearEngagementOverviewCache,
  readEngagementOverviewCache,
  writeEngagementOverviewCache,
} from '../../services/engagementReportCache';
import EngagementDrilldown from './EngagementDrilldown';
import EngagementMatrix from './EngagementMatrix';
import EngagementMovementPanel from './EngagementMovementPanel';
import EngagementPeoplePanel from './EngagementPeoplePanel';
import EngagementSettings from './EngagementSettings';
import { percentage } from './EngagementEvidence';
import AccessibleDialog from './AccessibleDialog';

ChartJS.register(ArcElement, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

interface LongTermHealthReportProps {
  churchId: string;
  canConfigure: boolean;
}

interface OpenDrilldown {
  kind: 'people' | 'sessions';
  token: string;
  title: string;
}

interface OpenPeoplePanel {
  token: string;
  title: string;
  placement: 'distribution' | 'matrix' | 'visitors';
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T12:00:00Z`));
}

function people(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

function seriesName(role: string, attendanceType: string): string {
  const labels: Record<string, string> = {
    primary: 'Primary',
    community: 'Other participation',
    other: 'Excluded',
    unclassified: 'Unclassified',
  };
  return `${labels[role] || role} ${attendanceType}`;
}

function darkModeIsActive(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

const LongTermHealthReport: React.FC<LongTermHealthReportProps> = ({ churchId, canConfigure }) => {
  const [overviewState, setOverview] = useState<EngagementOverviewDto | null>(() => readEngagementOverviewCache(churchId));
  const [updating, setUpdating] = useState(true);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [sessionDrilldown, setSessionDrilldown] = useState<OpenDrilldown | null>(null);
  const [peoplePanel, setPeoplePanel] = useState<OpenPeoplePanel | null>(null);
  const [primarySelections, setPrimarySelections] = useState<Record<number, boolean>>({});
  const [savingPrimaryGatherings, setSavingPrimaryGatherings] = useState(false);
  const [primaryGatheringsError, setPrimaryGatheringsError] = useState('');
  const [isDarkMode, setIsDarkMode] = useState(darkModeIsActive);
  const overviewRequest = useRef(0);

  const overview = overviewState?.churchId === churchId ? overviewState : null;

  const refresh = useCallback(async (fallback: EngagementOverviewDto | null) => {
    const requestId = ++overviewRequest.current;
    setUpdating(true);
    setError('');
    try {
      const response = await reportsAPI.getEngagementOverview();
      if (requestId !== overviewRequest.current) return;
      if (response.data.churchId !== churchId) throw new Error('The report belongs to another church.');
      setOverview(response.data);
      writeEngagementOverviewCache(response.data);
    } catch {
      if (requestId !== overviewRequest.current) return;
      const hasCurrentFallback = fallback?.churchId === churchId;
      setError(hasCurrentFallback ? 'Could not refresh long-term health. You are showing saved data.' : 'Could not load long-term health. Please try again.');
    } finally {
      if (requestId === overviewRequest.current) setUpdating(false);
    }
  }, [churchId]);

  useEffect(() => {
    const cached = readEngagementOverviewCache(churchId);
    setOverview(cached);
    setShowSettings(false);
    setSessionDrilldown(null);
    setPeoplePanel(null);
    setPrimarySelections({});
    setPrimaryGatheringsError('');
    setError('');
    void refresh(cached);
  }, [churchId, refresh]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => setIsDarkMode(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const openPeople = (token: string, title: string, placement: OpenPeoplePanel['placement']) => setPeoplePanel({ token, title, placement });
  const openSessions = (token: string, title: string) => setSessionDrilldown({ kind: 'sessions', token, title });
  const loadMovementPeople = useCallback(async (token: string, cursor?: string) => {
    const response = await reportsAPI.getEngagementPeople({ segment: token, cursor, limit: 50 });
    return response.data;
  }, []);

  const distributionData = useMemo(() => overview ? ({
    labels: overview.primaryDistribution.classified.tiers.map((tier) => tier.label),
    datasets: [{
      data: overview.primaryDistribution.classified.tiers.map((tier) => tier.count),
      backgroundColor: overview.primaryDistribution.classified.tiers.map((tier) => tier.colour),
    }],
  }) : { labels: [], datasets: [] }, [overview]);

  const trendData = useMemo(() => {
    if (!overview) return { labels: [], datasets: [] };
    const keys = new Set<string>();
    overview.trend.buckets.forEach((bucket) => bucket.series.forEach((series) => keys.add(`${series.role}:${series.attendanceType}`)));
    const colours = ['#4f46e5', '#0891b2', '#7c3aed', '#c2410c', '#15803d', '#475569'];
    return {
      labels: overview.trend.buckets.map((bucket) => `${formatDate(bucket.startDate)} – ${formatDate(bucket.endDate)}`),
      datasets: [...keys].map((key, index) => {
        const [role, attendanceType] = key.split(':');
        return {
          label: seriesName(role, attendanceType),
          data: overview.trend.buckets.map((bucket) => bucket.series.find((series) => series.role === role && series.attendanceType === attendanceType)?.averageAttendance ?? null),
          borderColor: colours[index % colours.length],
          backgroundColor: colours[index % colours.length],
        };
      }),
    };
  }, [overview]);
  const distributionChartOptions = useMemo(() => {
    const textColour = isDarkMode ? '#e5e7eb' : '#4b5563';
    return { plugins: { legend: { labels: { color: textColour } } } };
  }, [isDarkMode]);
  const trendChartOptions = useMemo(() => {
    const textColour = isDarkMode ? '#e5e7eb' : '#4b5563';
    const gridColour = isDarkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)';
    return {
      plugins: { legend: { labels: { color: textColour } } },
      scales: {
        x: { ticks: { color: textColour }, grid: { color: gridColour } },
        y: { ticks: { color: textColour }, grid: { color: gridColour } },
      },
    };
  }, [isDarkMode]);

  if (!overview && (updating || (overviewState !== null && overviewState.churchId !== churchId))) return <div role="status" className="rounded-lg bg-white p-8 text-center shadow dark:bg-gray-800 dark:text-gray-100">Loading long-term health…</div>;
  if (!overview) return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">{error || 'Could not load long-term health.'}</div>;

  const { settings } = overview;
  const denominator = overview.primaryDistribution.classified.denominator;
  const availablePrimaryGatherings = settings.gatheringRoles.filter((gathering) => gathering.isActive && gathering.attendanceType === 'standard');
  const isPrimarySelected = (gatheringTypeId: number, role: EngagementSettingsDto['gatheringRoles'][number]['role']) => primarySelections[gatheringTypeId] ?? role === 'primary';
  const selectedPrimaryCount = availablePrimaryGatherings.filter((gathering) => isPrimarySelected(gathering.gatheringTypeId, gathering.role)).length;
  const onSettingsSaved = async (_saved: EngagementSettingsDto) => {
    setOverview(null);
    setSessionDrilldown(null);
    setPeoplePanel(null);
    setError('');
    setShowSettings(false);
    clearEngagementOverviewCache(churchId);
    await refresh(null);
  };
  const savePrimaryGatherings = async () => {
    setSavingPrimaryGatherings(true);
    setPrimaryGatheringsError('');
    try {
      const response = await settingsAPI.updateEngagementSettings({
        coreMinimum: settings.coreMinimum,
        casualMinimum: settings.casualMinimum,
        tiers: settings.tiers,
        gatheringRoles: settings.gatheringRoles.map((gathering) => ({
          gatheringTypeId: gathering.gatheringTypeId,
          role: availablePrimaryGatherings.some((available) => available.gatheringTypeId === gathering.gatheringTypeId)
            ? (isPrimarySelected(gathering.gatheringTypeId, gathering.role) ? 'primary' : gathering.role)
            : gathering.role,
        })),
      });
      await onSettingsSaved(response.data.settings);
    } catch {
      setPrimaryGatheringsError('Could not save Primary gatherings. Please try again.');
    } finally {
      setSavingPrimaryGatherings(false);
    }
  };
  const renderPeoplePanel = (placement: OpenPeoplePanel['placement']) => peoplePanel?.placement === placement
    ? <EngagementPeoplePanel
        key={peoplePanel.token}
        {...peoplePanel}
        settings={settings}
        onClose={() => setPeoplePanel(null)}
      />
    : null;

  return (
    <div className="space-y-6">
      <header className="rounded-lg bg-white p-5 shadow dark:bg-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Long-term health</h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{formatDate(overview.window.currentStart)} – {formatDate(overview.window.currentEnd)}</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">The latest 52 fully completed weeks. Selected period dates do not change this report.</p>
            <p className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">{overview.population.activeRegulars} active regulars</p>
          </div>
          {canConfigure && <button type="button" onClick={() => setShowSettings(true)} className="rounded border border-indigo-600 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-300 dark:bg-indigo-400 dark:text-gray-950 dark:hover:bg-indigo-300">Settings</button>}
        </div>
        {updating && <p role="status" className="mt-3 text-sm text-indigo-700 dark:text-indigo-300">Updating…</p>}
        {error && <p role="alert" className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">{error}</p>}
      </header>

      {!overview.setup.hasPrimaryRole || !overview.setup.hasStandardPrimaryRole ? (
        <section className="rounded-lg border border-blue-200 bg-blue-50 p-6 dark:border-blue-800 dark:bg-blue-950/50">
          <h2 className="text-lg font-semibold text-blue-950 dark:text-blue-100">Choose your Primary gatherings</h2>
          <p className="mt-2 text-sm text-blue-900 dark:text-blue-200">Primary gatherings are the main services used to calculate each person&apos;s long-term engagement. You can choose more than one when people attend alternative services.</p>
          <p className="mt-2 text-sm text-blue-900 dark:text-blue-200">Only standard gatherings are available because headcount gatherings do not create person-level tiers.</p>
          {canConfigure && (availablePrimaryGatherings.length > 0 ? (
            <div className="mt-4">
              <fieldset>
                <legend className="text-sm font-medium text-blue-950 dark:text-blue-100">Which gatherings are Primary?</legend>
                <div className="mt-2 space-y-2">
                  {availablePrimaryGatherings.map((gathering) => (
                    <label key={gathering.gatheringTypeId} className="flex items-center gap-2 text-sm text-blue-950 dark:text-blue-100">
                      <input
                        type="checkbox"
                        checked={isPrimarySelected(gathering.gatheringTypeId, gathering.role)}
                        onChange={(event) => setPrimarySelections((current) => ({ ...current, [gathering.gatheringTypeId]: event.target.checked }))}
                      />
                      {gathering.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              {primaryGatheringsError && <p role="alert" className="mt-3 text-sm text-red-800 dark:text-red-200">{primaryGatheringsError}</p>}
              <button type="button" onClick={savePrimaryGatherings} disabled={selectedPrimaryCount === 0 || savingPrimaryGatherings} className="mt-4 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60">
                {savingPrimaryGatherings ? 'Saving…' : 'Save Primary gatherings'}
              </button>
            </div>
          ) : <p className="mt-4 text-sm text-blue-900 dark:text-blue-200">There are no active standard gatherings to choose. Create or activate one under Gatherings first.</p>)}
          {!canConfigure && <p className="mt-4 text-sm text-blue-900 dark:text-blue-200">An administrator can choose the Primary gatherings here.</p>}
        </section>
      ) : (
        <>
          {!overview.setup.hasPrimaryAssignments && <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">No active regulars have a Primary assignment. Assign people to an active standard Primary gathering to build profiles.</p>}

          <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="primary-distribution-heading">
            <h2 id="primary-distribution-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Primary tier distribution</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{denominator} people</p>
            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              <div className="mx-auto max-w-sm"><Doughnut aria-label="Primary tier distribution chart" data={distributionData} options={distributionChartOptions} /></div>
              <div className="space-y-2">
                {overview.primaryDistribution.classified.tiers.map((tier) => {
                  const label = `${tier.label}: ${tier.count} (${percentage(tier.rate)}%)`;
                  return <button key={tier.tier} type="button" aria-label={label} onClick={() => openPeople(tier.peopleToken, `${tier.label} people`, 'distribution')} className="flex w-full items-center gap-2 rounded border border-gray-200 p-3 text-left text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700"><span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: tier.colour }} />{label}</button>;
                })}
                <button type="button" onClick={() => openPeople(overview.primaryDistribution.establishing.peopleToken, 'Establishing people', 'distribution')} className="block w-full rounded border border-gray-200 p-3 text-left text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700">Establishing: {people(overview.primaryDistribution.establishing.count)}</button>
                <button type="button" onClick={() => openPeople(overview.primaryDistribution.notAssigned.peopleToken, 'Not assigned people', 'distribution')} className="block w-full rounded border border-gray-200 p-3 text-left text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700">Not assigned: {people(overview.primaryDistribution.notAssigned.count)}</button>
                <p className="text-xs text-gray-500 dark:text-gray-400">Colour is a visual aid; every tier is also identified by name.</p>
              </div>
            </div>
            {renderPeoplePanel('distribution')}
          </section>

          <EngagementMovementPanel movement={overview.tierMovement} settings={settings} baselinePending={overview.baseline.pending} historyBackfill={overview.historyBackfill} loadPeople={loadMovementPeople} />

          <EngagementMatrix matrix={overview.matrix} labels={{ core: settings.tiers.core.label, casual: settings.tiers.casual.label, irregular: settings.tiers.irregular.label }} onOpen={(token, title) => openPeople(token, title, 'matrix')} panel={renderPeoplePanel('matrix')} />

          <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="trend-heading">
            <h2 id="trend-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Attendance trend</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Thirteen four-week buckets. The chart shows average attendance per held session.</p>
            <div className="mt-4"><Line aria-label="Attendance trend chart" data={trendData} options={trendChartOptions} /></div>
            <ul className="mt-4 space-y-2 text-sm">
              {overview.trend.buckets.flatMap((bucket) => bucket.series.map((series) => {
                const text = `${formatDate(bucket.startDate)} – ${formatDate(bucket.endDate)}: ${seriesName(series.role, series.attendanceType)} — average ${Number(series.averageAttendance.toFixed(1))} across ${series.heldSessions} held sessions; ${series.uniquePeople === null ? 'unique reach is unavailable' : `${series.uniquePeople} unique people`}`;
                return <li key={`${bucket.index}-${series.role}-${series.attendanceType}`}><button type="button" className="text-left text-indigo-700 underline dark:text-indigo-300" onClick={() => openSessions(series.sessionsToken, `${seriesName(series.role, series.attendanceType)} sessions`)}>{text}</button></li>;
              }))}
            </ul>
          </section>

          <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="visitor-heading">
            <h2 id="visitor-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Local visitor journey</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <button type="button" onClick={() => openPeople(overview.visitorJourney.local.firstTime.peopleToken, 'First-time local visitors', 'visitors')} className="rounded border border-gray-200 p-3 text-left text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700">First attended as a local visitor: {people(overview.visitorJourney.local.firstTime.count)}</button>
              <button type="button" onClick={() => openPeople(overview.visitorJourney.local.returnedWithinEightWeeks.peopleToken, 'Returning local visitors', 'visitors')} className="rounded border border-gray-200 p-3 text-left text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700">Returned within eight weeks: {people(overview.visitorJourney.local.returnedWithinEightWeeks.count)}</button>
              <button type="button" onClick={() => openPeople(overview.visitorJourney.local.currentRegular.peopleToken, 'Current regulars from local visitors', 'visitors')} className="rounded border border-gray-200 p-3 text-left text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700">Now a regular: {people(overview.visitorJourney.local.currentRegular.count)}</button>
            </div>
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Current conversion status is known; the exact historical conversion date is not known.</p>
            <button type="button" onClick={() => openPeople(overview.visitorJourney.traveller.firstTime.peopleToken, 'Traveller visitors', 'visitors')} className="mt-2 text-sm text-indigo-700 underline dark:text-indigo-300">Traveller visitors are separate: {people(overview.visitorJourney.traveller.firstTime.count)}</button>
            {renderPeoplePanel('visitors')}
          </section>

          <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="coverage-heading">
            <h2 id="coverage-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Coverage</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li><button type="button" className="text-left text-gray-900 underline dark:text-gray-100" onClick={() => openSessions(overview.coverage.sessionsTokens.eligible, 'Reliable person-level sessions')}>{overview.coverage.personLevelSessions.numerator} of {overview.coverage.personLevelSessions.denominator} held sessions had reliable person-level coverage ({percentage(overview.coverage.personLevelSessions.rate)}%)</button></li>
              <li><button type="button" className="text-left text-gray-900 underline dark:text-gray-100" onClick={() => openSessions(overview.coverage.sessionsTokens.legacy, 'Legacy roster sessions')}>{overview.coverage.legacyProvenance.numerator} of {overview.coverage.legacyProvenance.denominator} reliable sessions use legacy roster evidence ({percentage(overview.coverage.legacyProvenance.rate)}%)</button></li>
              <li>{overview.coverage.establishing.numerator} of {overview.coverage.establishing.denominator} active regulars are Establishing ({percentage(overview.coverage.establishing.rate)}%)</li>
              <li>{overview.coverage.primaryNotAssigned.numerator} of {overview.coverage.primaryNotAssigned.denominator} active regulars are Primary Not assigned ({percentage(overview.coverage.primaryNotAssigned.rate)}%)</li>
            </ul>
            {overview.coverage.personLevelSessions.excluded > 0 && <p className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">{overview.coverage.personLevelSessions.excluded} held sessions were excluded because their roster history is unknown.</p>}
            {overview.coverage.legacyProvenance.numerator > 0 && <p className="mt-2 rounded bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">Some person-level results use legacy roster snapshots. This share will reduce as newer evidence enters the window.</p>}
          </section>
        </>
      )}

      {!canConfigure && <EngagementSettings settings={settings} canEdit={false} onSaved={() => undefined} />}
      <p className="text-sm text-gray-600 dark:text-gray-300">Active rules: {settings.tiers.core.label} ≥ {settings.coreMinimum}%; {settings.tiers.casual.label} {settings.casualMinimum}–{settings.coreMinimum - 1}%; {settings.tiers.irregular.label} &lt; {settings.casualMinimum}%.</p>

      {showSettings && (
        <AccessibleDialog className="z-40" label="Configure engagement" onClose={() => setShowSettings(false)}>
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white p-6 dark:bg-gray-800">
            <div className="mb-4 text-right"><button type="button" aria-label="Close settings" onClick={() => setShowSettings(false)}>Close</button></div>
            <EngagementSettings settings={settings} canEdit onSaved={onSettingsSaved} />
          </div>
        </AccessibleDialog>
      )}
      {sessionDrilldown && <EngagementDrilldown {...sessionDrilldown} settings={settings} onClose={() => setSessionDrilldown(null)} />}
    </div>
  );
};

export default LongTermHealthReport;
