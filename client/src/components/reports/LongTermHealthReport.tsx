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
import type { EngagementOverviewDto, EngagementSettingsDto, GatheringType } from '../../services/api';
import { gatheringsAPI, reportsAPI } from '../../services/api';
import {
  clearEngagementOverviewCache,
  readEngagementOverviewCache,
  writeEngagementOverviewCache,
} from '../../services/engagementReportCache';
import EngagementDrilldown from './EngagementDrilldown';
import EngagementMatrix from './EngagementMatrix';
import EngagementSettings from './EngagementSettings';
import { percentage } from './EngagementEvidence';

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

function formatDate(date: string): string {
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T12:00:00Z`));
}

function people(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

function seriesName(role: string, attendanceType: string): string {
  return `${role[0].toUpperCase()}${role.slice(1)} ${attendanceType}`;
}

const LongTermHealthReport: React.FC<LongTermHealthReportProps> = ({ churchId, canConfigure }) => {
  const [overview, setOverview] = useState<EngagementOverviewDto | null>(() => readEngagementOverviewCache(churchId));
  const [gatherings, setGatherings] = useState<GatheringType[]>([]);
  const [updating, setUpdating] = useState(!!overview);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [drilldown, setDrilldown] = useState<OpenDrilldown | null>(null);
  const overviewRequest = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++overviewRequest.current;
    setUpdating(true);
    setError('');
    try {
      const response = await reportsAPI.getEngagementOverview();
      if (requestId !== overviewRequest.current) return;
      if (response.data.churchId !== churchId) throw new Error('The report belongs to another church.');
      writeEngagementOverviewCache(response.data);
      setOverview(response.data);
    } catch {
      if (requestId !== overviewRequest.current) return;
      setError(overview ? 'Could not refresh long-term health. You are showing saved data.' : 'Could not load long-term health. Please try again.');
    } finally {
      if (requestId === overviewRequest.current) setUpdating(false);
    }
  }, [churchId, overview]);

  useEffect(() => {
    setOverview(readEngagementOverviewCache(churchId));
  }, [churchId]);

  useEffect(() => { void refresh(); }, [churchId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let active = true;
    gatheringsAPI.getAll().then((response) => {
      if (!active) return;
      setGatherings(response.data.gatherings || response.data.gatheringTypes || []);
    }).catch(() => { if (active) setGatherings([]); });
    return () => { active = false; };
  }, [churchId]);

  const openPeople = (token: string, title: string) => setDrilldown({ kind: 'people', token, title });
  const openSessions = (token: string, title: string) => setDrilldown({ kind: 'sessions', token, title });

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

  if (!overview && updating) return <div role="status" className="rounded-lg bg-white p-8 text-center shadow dark:bg-gray-800">Loading long-term health…</div>;
  if (!overview) return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5 text-red-800">{error || 'Could not load long-term health.'}</div>;

  const { settings } = overview;
  const denominator = overview.primaryDistribution.classified.denominator;
  const onSettingsSaved = async (_saved: EngagementSettingsDto) => {
    clearEngagementOverviewCache(churchId);
    setShowSettings(false);
    await refresh();
  };

  return (
    <div className="space-y-6">
      <header className="rounded-lg bg-white p-5 shadow dark:bg-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Long-term health</h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{formatDate(overview.window.currentStart)} – {formatDate(overview.window.currentEnd)}</p>
            <p className="text-sm text-gray-500">The latest 52 fully completed weeks. Selected period dates do not change this report.</p>
            <p className="mt-2 text-sm font-medium">{overview.population.activeRegulars} active regulars</p>
          </div>
          {canConfigure && <button type="button" onClick={() => setShowSettings(true)} className="rounded border border-indigo-600 px-4 py-2 text-sm font-medium text-indigo-700">Configure engagement</button>}
        </div>
        {updating && <p role="status" className="mt-3 text-sm text-indigo-700">Updating…</p>}
        {error && <p role="alert" className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-800">{error}</p>}
      </header>

      {!overview.setup.hasPrimaryRole || !overview.setup.hasStandardPrimaryRole ? (
        <section className="rounded-lg border border-blue-200 bg-blue-50 p-6">
          <h2 className="text-lg font-semibold text-blue-950">Choose a Primary gathering</h2>
          <p className="mt-2 text-sm text-blue-900">Assign at least one standard gathering as Primary before person-level engagement can be classified. Headcount gatherings do not create person tiers.</p>
        </section>
      ) : (
        <>
          {!overview.setup.hasPrimaryAssignments && <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">No active regulars have a Primary assignment. Assign people to an active standard Primary gathering to build profiles.</p>}

          <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="primary-distribution-heading">
            <h2 id="primary-distribution-heading" className="text-lg font-semibold">Primary tier distribution</h2>
            <p className="mt-1 text-sm text-gray-500">Among {denominator} classified active regulars.</p>
            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              <div className="mx-auto max-w-sm"><Doughnut aria-label="Primary tier distribution chart" data={distributionData} /></div>
              <div className="space-y-2">
                {overview.primaryDistribution.classified.tiers.map((tier) => {
                  const label = `${tier.label}: ${tier.count} of ${denominator} classified people (${percentage(tier.rate)}%)`;
                  return <button key={tier.tier} type="button" aria-label={label} onClick={() => openPeople(tier.peopleToken, `${tier.label} people`)} className="flex w-full items-center gap-2 rounded border border-gray-200 p-3 text-left hover:bg-gray-50 dark:border-gray-700"><span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: tier.colour }} />{label}</button>;
                })}
                <button type="button" onClick={() => openPeople(overview.primaryDistribution.establishing.peopleToken, 'Establishing people')} className="block w-full rounded border border-gray-200 p-3 text-left">Establishing: {people(overview.primaryDistribution.establishing.count)}</button>
                <button type="button" onClick={() => openPeople(overview.primaryDistribution.notAssigned.peopleToken, 'Not assigned people')} className="block w-full rounded border border-gray-200 p-3 text-left">Not assigned: {people(overview.primaryDistribution.notAssigned.count)}</button>
                <p className="text-xs text-gray-500">Colour is a visual aid; every tier is also identified by name.</p>
              </div>
            </div>
          </section>

          <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="movement-heading">
            <h2 id="movement-heading" className="text-lg font-semibold">Recent Primary movement</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              {Object.entries(overview.movement.categories).map(([key, category]) => {
                const labels: Record<string, string> = { higher: 'Higher', same: 'Unchanged', lower: 'Lower', nonComparable: 'Not comparable' };
                return <button key={key} type="button" onClick={() => openPeople(category.peopleToken, `${labels[key]} movement`)} className="rounded border border-gray-200 p-3 text-left"><span className="block text-2xl font-semibold">{category.count}</span>{labels[key]}</button>;
              })}
            </div>
          </section>

          <EngagementMatrix matrix={overview.matrix} labels={{ core: settings.tiers.core.label, casual: settings.tiers.casual.label, irregular: settings.tiers.irregular.label }} onOpen={openPeople} />

          <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="trend-heading">
            <h2 id="trend-heading" className="text-lg font-semibold">Attendance trend</h2>
            <p className="mt-1 text-sm text-gray-500">Thirteen four-week buckets. The chart shows average attendance per held session.</p>
            <div className="mt-4"><Line aria-label="Attendance trend chart" data={trendData} /></div>
            <ul className="mt-4 space-y-2 text-sm">
              {overview.trend.buckets.flatMap((bucket) => bucket.series.map((series) => {
                const text = `${formatDate(bucket.startDate)} – ${formatDate(bucket.endDate)}: ${seriesName(series.role, series.attendanceType)} — average ${Number(series.averageAttendance.toFixed(1))} across ${series.heldSessions} held sessions; ${series.uniquePeople === null ? 'unique reach is unavailable' : `${series.uniquePeople} unique people`}`;
                return <li key={`${bucket.index}-${series.role}-${series.attendanceType}`}><button type="button" className="text-left text-indigo-700 underline" onClick={() => openSessions(series.sessionsToken, `${seriesName(series.role, series.attendanceType)} sessions`)}>{text}</button></li>;
              }))}
            </ul>
          </section>

          <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="visitor-heading">
            <h2 id="visitor-heading" className="text-lg font-semibold">Local visitor journey</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <button type="button" onClick={() => openPeople(overview.visitorJourney.local.firstTime.peopleToken, 'First-time local visitors')} className="rounded border p-3 text-left">First attended as a local visitor: {people(overview.visitorJourney.local.firstTime.count)}</button>
              <button type="button" onClick={() => openPeople(overview.visitorJourney.local.returnedWithinEightWeeks.peopleToken, 'Returning local visitors')} className="rounded border p-3 text-left">Returned within eight weeks: {people(overview.visitorJourney.local.returnedWithinEightWeeks.count)}</button>
              <button type="button" onClick={() => openPeople(overview.visitorJourney.local.currentRegular.peopleToken, 'Current regulars from local visitors')} className="rounded border p-3 text-left">Now a regular: {people(overview.visitorJourney.local.currentRegular.count)}</button>
            </div>
            <p className="mt-3 text-sm text-gray-500">Current conversion status is known; the exact historical conversion date is not known.</p>
            <button type="button" onClick={() => openPeople(overview.visitorJourney.traveller.firstTime.peopleToken, 'Traveller visitors')} className="mt-2 text-sm text-indigo-700 underline">Traveller visitors are separate: {people(overview.visitorJourney.traveller.firstTime.count)}</button>
          </section>

          <section className="rounded-lg bg-white p-5 shadow dark:bg-gray-800" aria-labelledby="coverage-heading">
            <h2 id="coverage-heading" className="text-lg font-semibold">Coverage</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li><button type="button" className="text-left underline" onClick={() => openSessions(overview.coverage.sessionsTokens.eligible, 'Reliable person-level sessions')}>{overview.coverage.personLevelSessions.numerator} of {overview.coverage.personLevelSessions.denominator} held sessions had reliable person-level coverage ({percentage(overview.coverage.personLevelSessions.rate)}%)</button></li>
              <li><button type="button" className="text-left underline" onClick={() => openSessions(overview.coverage.sessionsTokens.legacy, 'Legacy roster sessions')}>{overview.coverage.legacyProvenance.numerator} of {overview.coverage.legacyProvenance.denominator} reliable sessions use legacy roster evidence ({percentage(overview.coverage.legacyProvenance.rate)}%)</button></li>
              <li>{overview.coverage.establishing.numerator} of {overview.coverage.establishing.denominator} active regulars are Establishing ({percentage(overview.coverage.establishing.rate)}%)</li>
              <li>{overview.coverage.primaryNotAssigned.numerator} of {overview.coverage.primaryNotAssigned.denominator} active regulars are Primary Not assigned ({percentage(overview.coverage.primaryNotAssigned.rate)}%)</li>
            </ul>
            {overview.coverage.personLevelSessions.excluded > 0 && <p className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900">{overview.coverage.personLevelSessions.excluded} held sessions were excluded because their roster history is unknown.</p>}
            {overview.coverage.legacyProvenance.numerator > 0 && <p className="mt-2 rounded bg-amber-50 p-3 text-sm text-amber-900">Some person-level results use legacy roster snapshots. This share will reduce as newer evidence enters the window.</p>}
          </section>
        </>
      )}

      {!canConfigure && <EngagementSettings settings={settings} gatherings={gatherings} canEdit={false} onSaved={() => undefined} />}
      <p className="text-sm text-gray-600">Active rules: {settings.tiers.core.label} ≥ {settings.coreMinimum}%; {settings.tiers.casual.label} {settings.casualMinimum}–{settings.coreMinimum - 1}%; {settings.tiers.irregular.label} &lt; {settings.casualMinimum}%.</p>

      {showSettings && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Configure engagement">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white p-6 dark:bg-gray-800">
            <div className="mb-4 text-right"><button type="button" aria-label="Close settings" onClick={() => setShowSettings(false)}>Close</button></div>
            <EngagementSettings settings={settings} gatherings={gatherings} canEdit onSaved={onSettingsSaved} />
          </div>
        </div>
      )}
      {drilldown && <EngagementDrilldown {...drilldown} settings={settings} onClose={() => setDrilldown(null)} />}
    </div>
  );
};

export default LongTermHealthReport;
