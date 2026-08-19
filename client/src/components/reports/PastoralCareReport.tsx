import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EngagementSettingsDto,
  PastoralInsightAction,
  PastoralInsightDto,
  PastoralInsightsDto,
} from '../../services/api';
import { reportsAPI, settingsAPI } from '../../services/api';
import { readPastoralInsightsCache, writePastoralInsightsCache } from '../../services/engagementReportCache';
import AccessibleDialog from './AccessibleDialog';
import CaregiverPicker from './CaregiverPicker';
import EngagementEvidence from './EngagementEvidence';
import EngagementTierBadge from './EngagementTierBadge';

interface PastoralCareReportProps {
  churchId: string;
}

const DEFAULT_SETTINGS: EngagementSettingsDto = {
  coreMinimum: 60,
  casualMinimum: 20,
  tiers: {
    core: { label: 'Core', colour: '#166534' },
    casual: { label: 'Casual', colour: '#B45309' },
    irregular: { label: 'Irregular', colour: '#B91C1C' },
  },
  gatheringRoles: [],
  calculationRulesVersion: 1,
  assignmentPreview: { primaryAssigned: 0, communityAssigned: 0, primaryNotAssigned: 0 },
};

const INSIGHT_LABELS: Record<PastoralInsightDto['type'], string> = {
  primary_decline: 'Recent Primary tier decline',
  community_primary_gap: 'Community-connected, Primary-irregular',
  visitor_next_step: 'Visitor next step',
  re_engagement: 'Re-engagement',
};

const INSIGHT_ACCENTS: Record<PastoralInsightDto['type'], string> = {
  primary_decline: 'border-l-amber-500',
  community_primary_gap: 'border-l-violet-500',
  visitor_next_step: 'border-l-sky-500',
  re_engagement: 'border-l-emerald-500',
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
}

function evidenceString(insight: PastoralInsightDto, key: string): string | null {
  const value = insight.evidence[key];
  return typeof value === 'string' ? value : null;
}

function evidenceNumber(insight: PastoralInsightDto, key: string): number | null {
  const value = insight.evidence[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function tierLabel(value: string | null, settings: EngagementSettingsDto): string {
  if (value === 'core' || value === 'casual' || value === 'irregular') return settings.tiers[value].label;
  return value || 'Unknown';
}

function factualSummary(insight: PastoralInsightDto, settings: EngagementSettingsDto): string {
  if (insight.type === 'primary_decline') {
    return `Primary changed from ${tierLabel(evidenceString(insight, 'fromTier'), settings)} to ${tierLabel(evidenceString(insight, 'toTier'), settings)}`;
  }
  if (insight.type === 'community_primary_gap') {
    return `Community is ${tierLabel(evidenceString(insight, 'communityTier'), settings)} while Primary is ${tierLabel(evidenceString(insight, 'primaryTier'), settings)}`;
  }
  if (insight.type === 'visitor_next_step') {
    const date = evidenceString(insight, 'firstPrimaryAttendanceDate');
    const later = evidenceNumber(insight, 'laterPrimaryAttendances');
    if (!date || !isCanonicalDate(date) || later === null || !Number.isInteger(later) || later < 0) {
      return 'Visitor attendance evidence is unavailable.';
    }
    if (date && later === 0) return `First Primary attendance on ${formatDate(date)}; no later Primary attendance`;
    return `First Primary attendance on ${formatDate(date)}; ${later} later Primary attendances`;
  }
  if (insight.type === 're_engagement') {
    return `Primary is now above the ${tierLabel(evidenceString(insight, 'toTier'), settings)} decline tier`;
  }
  return 'The current evidence is shown below.';
}

function personName(insight: PastoralInsightDto): string {
  return `${insight.person.firstName} ${insight.person.lastName}`;
}

function replaceInsight(queue: PastoralInsightsDto, changed: PastoralInsightDto): PastoralInsightsDto {
  return { ...queue, insights: queue.insights.map((row) => row.id === changed.id ? changed : row) };
}

const WorkflowBadge: React.FC<{ insight: PastoralInsightDto }> = ({ insight }) => {
  if (insight.workflow.state === 'snoozed' && insight.workflow.snoozedUntil) {
    return <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">Snoozed until {formatDate(insight.workflow.snoozedUntil)}</span>;
  }
  if (insight.workflow.state === 'dismissed') {
    return <span className="rounded-full bg-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">Dismissed</span>;
  }
  if (insight.workflow.state === 'resolved') {
    return <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">Resolved</span>;
  }
  return <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-100">New</span>;
};

const PastoralCareReport: React.FC<PastoralCareReportProps> = ({ churchId }) => {
  const [queueState, setQueue] = useState<PastoralInsightsDto | null>(() => readPastoralInsightsCache(churchId));
  const [settings, setSettings] = useState<EngagementSettingsDto>(DEFAULT_SETTINGS);
  const [updating, setUpdating] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actingIds, setActingIds] = useState<Set<number>>(() => new Set());
  const [snoozeTarget, setSnoozeTarget] = useState<PastoralInsightDto | null>(null);
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const [dismissTarget, setDismissTarget] = useState<PastoralInsightDto | null>(null);
  const [caregiverFamilyId, setCaregiverFamilyId] = useState<number | null>(null);
  const queueRequest = useRef(0);
  const actionGeneration = useRef(0);
  const churchRef = useRef(churchId);
  const queueRef = useRef(queueState);
  churchRef.current = churchId;
  queueRef.current = queueState;

  const queue = queueState?.churchId === churchId ? queueState : null;

  const refresh = useCallback(async (fallback: PastoralInsightsDto | null) => {
    const requestedChurch = churchId;
    const requestId = ++queueRequest.current;
    setUpdating(true);
    setError('');
    try {
      const response = await reportsAPI.getPastoralInsights({ includeSnoozed: true });
      if (requestId !== queueRequest.current || churchRef.current !== requestedChurch) return;
      if (response.data.churchId !== requestedChurch) throw new Error('The report belongs to another church.');
      queueRef.current = response.data;
      setQueue(response.data);
      writePastoralInsightsCache(response.data);
    } catch {
      if (requestId !== queueRequest.current || churchRef.current !== requestedChurch) return;
      setError(fallback?.churchId === requestedChurch
        ? 'Could not refresh pastoral care. You are showing saved data.'
        : 'Could not load pastoral care. Please try again.');
    } finally {
      if (requestId === queueRequest.current && churchRef.current === requestedChurch) setUpdating(false);
    }
  }, [churchId]);

  useEffect(() => {
    const requestedChurch = churchId;
    const cached = readPastoralInsightsCache(requestedChurch);
    actionGeneration.current += 1;
    setQueue(cached);
    setSettings(DEFAULT_SETTINGS);
    setError('');
    setActionError('');
    setActingIds(new Set());
    setSnoozeTarget(null);
    setDismissTarget(null);
    setCaregiverFamilyId(null);
    void refresh(cached);
    void settingsAPI.getEngagementSettings()
      .then((response) => {
        if (churchRef.current === requestedChurch) setSettings(response.data.settings);
      })
      .catch(() => undefined);
  }, [churchId, refresh]);

  const applyAction = async (insight: PastoralInsightDto, action: PastoralInsightAction) => {
    const requestedChurch = churchId;
    const generation = actionGeneration.current;
    setActingIds((current) => new Set(current).add(insight.id));
    setActionError('');
    try {
      const response = await reportsAPI.applyPastoralInsightAction(insight.id, action);
      if (generation !== actionGeneration.current || churchRef.current !== requestedChurch) return;
      const current = queueRef.current;
      if (!current || current.churchId !== requestedChurch) return;
      const updated = replaceInsight(current, response.data.insight);
      queueRef.current = updated;
      setQueue(updated);
      writePastoralInsightsCache(updated);
      setSnoozeTarget(null);
      setDismissTarget(null);
      setSnoozeUntil('');
      void refresh(updated);
    } catch {
      if (generation === actionGeneration.current && churchRef.current === requestedChurch) {
        setActionError(`Could not update ${personName(insight)}. Please try again.`);
      }
    } finally {
      if (generation === actionGeneration.current && churchRef.current === requestedChurch) {
        setActingIds((current) => {
          const next = new Set(current);
          next.delete(insight.id);
          return next;
        });
      }
    }
  };

  if (!queue && (updating || (queueState !== null && queueState.churchId !== churchId))) {
    return <div role="status" className="rounded-xl bg-white p-8 text-center text-gray-600 shadow-sm dark:bg-gray-800 dark:text-gray-300">Loading pastoral care…</div>;
  }
  if (!queue) {
    return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error || 'Could not load pastoral care. Please try again.'}</div>;
  }

  return (
    <div className="space-y-5">
      <header className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500 dark:text-gray-400">Pastoral casebook</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-950 dark:text-gray-100">Pastoral care</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600 dark:text-gray-300">
              Factual follow-up signals from attendance through the completed week ending {formatDate(queue.window.completedWeekEnd)}.
            </p>
          </div>
          <div className="rounded-lg bg-stone-100 px-4 py-3 text-right dark:bg-gray-900">
            <span className="block text-2xl font-semibold text-gray-950 dark:text-gray-100">{queue.insights.length}</span>
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">current {queue.insights.length === 1 ? 'item' : 'items'}</span>
          </div>
        </div>
        {updating && <p role="status" className="mt-3 text-sm font-medium text-indigo-700 dark:text-indigo-300">Updating…</p>}
        {error && <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{error}</p>}
        {actionError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{actionError}</p>}
      </header>

      {queue.insights.length === 0 ? (
        <section className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-12 text-center shadow-sm dark:border-gray-600 dark:bg-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">No pastoral care follow-up is currently open.</h2>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">This queue will update when the underlying attendance evidence changes.</p>
        </section>
      ) : (
        <section aria-label="Pastoral follow-up queue" className="grid gap-4 xl:grid-cols-2">
          {queue.insights.map((insight) => {
            const name = personName(insight);
            const inactiveCaregivers = insight.caregivers.filter((caregiver) => !caregiver.isActive).length;
            return (
              <article
                key={insight.id}
                aria-labelledby={`pastoral-insight-${insight.id}`}
                className={`border-l-4 ${INSIGHT_ACCENTS[insight.type]} rounded-xl border-y border-r border-stone-200 bg-white p-5 shadow-sm dark:border-y-gray-700 dark:border-r-gray-700 dark:bg-gray-800`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-gray-400">{INSIGHT_LABELS[insight.type]}</p>
                    <h2 id={`pastoral-insight-${insight.id}`} className="mt-1 text-xl font-semibold text-gray-950 dark:text-gray-100">{name}</h2>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{insight.family?.name || 'No family assigned'}</p>
                  </div>
                  <WorkflowBadge insight={insight} />
                </div>

                <p className="mt-4 border-y border-stone-100 py-3 text-base font-medium leading-6 text-gray-900 dark:border-gray-700 dark:text-gray-100">{factualSummary(insight, settings)}</p>

                <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                  {(['primary', 'community'] as const).map((axis) => (
                    <div key={axis} className="rounded-lg bg-stone-50 p-3 dark:bg-gray-900">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{axis === 'primary' ? 'Primary' : 'Community'}</dt>
                      <dd className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                        <EngagementTierBadge status={insight.profiles[axis]} settings={settings} />
                        <EngagementEvidence status={insight.profiles[axis]} />
                      </dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-300">
                  <p>{insight.lastAttendance ? `Last attendance: ${formatDate(insight.lastAttendance.date)} at ${insight.lastAttendance.gatheringName}` : 'No recorded attendance'}</p>
                  <div>
                    <span className="font-semibold text-gray-800 dark:text-gray-200">Caregivers: </span>
                    {insight.caregivers.length > 0
                      ? insight.caregivers.map((caregiver) => `${caregiver.firstName} ${caregiver.lastName}${caregiver.isActive ? '' : ' (inactive)'}`).join(', ')
                      : 'No caregivers assigned'}
                  </div>
                  {inactiveCaregivers > 0 && <p className="text-xs text-amber-800 dark:text-amber-200">{inactiveCaregivers} inactive caregiver {inactiveCaregivers === 1 ? 'assignment is' : 'assignments are'} shown for context.</p>}
                  {insight.type === 'primary_decline' && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">Caregiver email: {insight.deliverySummary.pending} pending, {insight.deliverySummary.delivered} delivered, {insight.deliverySummary.cancelled} cancelled</p>
                  )}
                </div>

                <div className="mt-5 flex flex-wrap gap-2 border-t border-stone-100 pt-4 dark:border-gray-700">
                  <a href={`/app/people?search=${encodeURIComponent(name)}`} className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-stone-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">View person</a>
                  {insight.family && (
                    <>
                      <a href={`/app/people?familyId=${insight.family.id}`} className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-stone-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">View family</a>
                      <button type="button" onClick={() => setCaregiverFamilyId(insight.family!.id)} className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-stone-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Manage caregivers</button>
                    </>
                  )}
                  {insight.workflow.state === 'open' ? (
                    <>
                      <button type="button" disabled={actingIds.has(insight.id)} onClick={() => { setSnoozeTarget(insight); setSnoozeUntil(''); }} className="rounded-md bg-blue-50 px-3 py-2 text-sm font-medium text-blue-800 hover:bg-blue-100 disabled:opacity-50 dark:bg-blue-950 dark:text-blue-200">Snooze</button>
                      <button type="button" disabled={actingIds.has(insight.id)} onClick={() => setDismissTarget(insight)} className="rounded-md bg-stone-100 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-200 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200">Dismiss</button>
                    </>
                  ) : (insight.workflow.state === 'snoozed' || insight.workflow.state === 'dismissed') && (
                    <button type="button" disabled={actingIds.has(insight.id)} onClick={() => void applyAction(insight, { action: 'reopen' })} className="rounded-md bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-800 hover:bg-indigo-100 disabled:opacity-50 dark:bg-indigo-950 dark:text-indigo-200">Reopen</button>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}

      {snoozeTarget && (
        <AccessibleDialog label={`Snooze ${personName(snoozeTarget)}`} onClose={() => { setSnoozeTarget(null); setSnoozeUntil(''); }} className="z-40">
          <form
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800"
            onSubmit={(event) => {
              event.preventDefault();
              if (snoozeUntil) void applyAction(snoozeTarget, { action: 'snooze', snoozeUntil });
            }}
          >
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Snooze this follow-up</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">The item can return on this date only if the underlying evidence still applies.</p>
            <label htmlFor="pastoral-snooze-until" className="mt-4 block text-sm font-medium text-gray-800 dark:text-gray-200">Snooze until</label>
            <input id="pastoral-snooze-until" required type="date" value={snoozeUntil} onChange={(event) => setSnoozeUntil(event.target.value)} className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => { setSnoozeTarget(null); setSnoozeUntil(''); }} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium dark:border-gray-600">Cancel</button>
              <button type="submit" disabled={!snoozeUntil || actingIds.has(snoozeTarget.id)} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Confirm snooze</button>
            </div>
          </form>
        </AccessibleDialog>
      )}

      {dismissTarget && (
        <AccessibleDialog label={`Dismiss ${personName(dismissTarget)}'s insight?`} onClose={() => setDismissTarget(null)} className="z-40">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Dismiss this episode?</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">This dismisses the current factual episode. A later distinct episode may still appear.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setDismissTarget(null)} className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium dark:border-gray-600">Keep insight</button>
              <button type="button" disabled={actingIds.has(dismissTarget.id)} onClick={() => void applyAction(dismissTarget, { action: 'dismiss' })} className="rounded-md bg-stone-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-600">Dismiss insight</button>
            </div>
          </div>
        </AccessibleDialog>
      )}

      {caregiverFamilyId !== null && (
        <CaregiverPicker
          familyId={caregiverFamilyId}
          open
          onClose={() => setCaregiverFamilyId(null)}
          onChanged={() => refresh(queueRef.current?.churchId === churchId ? queueRef.current : null)}
        />
      )}
    </div>
  );
};

export default PastoralCareReport;
