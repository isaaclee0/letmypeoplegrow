import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';
import { buildSelections, VisitorChoice } from './syncSelections';

interface CandidateDetail { pcoId: string; firstName: string; lastName: string; membership: string | null; }
interface AmbiguousEntry { individualId: number; firstName: string; lastName: string; candidates: string[]; candidateDetails: CandidateDetail[]; }
interface ExtraEntry { individualId: number; firstName: string; lastName: string; }
interface UnmatchedVisitorEntry { individualId: number; firstName: string; lastName: string; peopleType: string; }
interface VisitorMatchEntry {
  individualId: number;
  firstName: string;
  lastName: string;
  peopleType: string;
  candidate: { pcoId: string; firstName: string; lastName: string; membership: string | null };
}
interface Plan {
  link: { individualId: number; pcoId: string }[];
  restore: { individualId: number; pcoId: string }[];
  ambiguous: AmbiguousEntry[];
  visitorMatches: VisitorMatchEntry[];
  archiveExtras: ExtraEntry[];
  unmatchedVisitors: UnmatchedVisitorEntry[];
  add: { pcoId: string; firstName: string; lastName: string; isChild: boolean; householdId: string | null; membership: string | null }[];
  update: { individualId: number; firstName: string; lastName: string }[];
  archive: { individualId: number; pcoId: string }[];
  reactivate: { individualId: number; pcoId: string }[];
  pcoFetchedAt?: string;
}

export default function PlanningCenterSyncReview({ connected }: { connected: boolean }) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, string | null>>({});
  const [skipAdd, setSkipAdd] = useState<Set<string>>(new Set());
  const [skipArchiveExtras, setSkipArchiveExtras] = useState<Set<number>>(new Set());
  const [visitorChoices, setVisitorChoices] = useState<Record<string, VisitorChoice | null>>({});

  // force: bypass the server-side PCO cache (explicit "Refresh from Planning Center").
  // preserveResult: keep the "Applied: …" message visible when reloading after an apply.
  const loadPlan = useCallback(async (opts?: { force?: boolean; preserveResult?: boolean }) => {
    setLoading(true); setError(null);
    if (!opts?.preserveResult) setResult(null);
    try {
      const res = await integrationsAPI.getPlanningCenterSyncPlan({ force: opts?.force });
      setPlan(res.data.plan);
      setAmbiguousChoices({});
      setSkipAdd(new Set());
      setSkipArchiveExtras(new Set());
      setVisitorChoices({});
    } catch (e: any) {
      logger.error('Failed to compute PCO sync plan', e);
      setError(e.response?.data?.error || 'Failed to compute sync plan.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (connected) loadPlan(); }, [connected, loadPlan]);

  const apply = async () => {
    setApplying(true); setError(null);
    try {
      const selections = buildSelections(ambiguousChoices, skipAdd, skipArchiveExtras, visitorChoices);
      const res = await integrationsAPI.applyPlanningCenterSync({ selections });
      setResult(res.data.result);
      // Refresh the plan so the lists reflect the post-apply DB state instead of
      // showing the rows we just acted on. PCO is unchanged, so this is a cache hit.
      await loadPlan({ preserveResult: true });
    } catch (e: any) {
      logger.error('Failed to apply PCO sync', e);
      setError(e.response?.data?.error || 'Failed to apply sync.');
    } finally {
      setApplying(false);
    }
  };

  if (!connected) {
    return (
      <div className="text-sm text-gray-600 dark:text-gray-300">
        Planning Center is not connected.{' '}
        <button className="underline" onClick={() => navigate('/app/settings?tab=integrations')}>Connect it in Settings</button>.
      </div>
    );
  }
  if (loading) return <p className="text-sm text-gray-500 dark:text-gray-400">Computing sync plan… (fetching everyone from Planning Center)</p>;
  if (error) return <div className="text-sm text-red-600 dark:text-red-400">{error} <button className="underline ml-1" onClick={loadPlan}>Retry</button></div>;
  if (!plan) return null;

  const toggleSkip = (pcoId: string) => {
    setSkipAdd((prev) => { const n = new Set(prev); if (n.has(pcoId)) n.delete(pcoId); else n.add(pcoId); return n; });
  };

  const toggleSkipExtra = (individualId: number) => {
    setSkipArchiveExtras((prev) => {
      const n = new Set(prev);
      if (n.has(individualId)) n.delete(individualId); else n.add(individualId);
      return n;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3 text-sm">
        {([
          ['Link', plan.link.length],
          ['Restore', plan.restore.length],
          ['Add', plan.add.length],
          ['Update', plan.update.length],
          ['Archive', plan.archive.length],
          ['Reactivate', plan.reactivate.length],
          ['Ambiguous', plan.ambiguous.length],
          ['Visitor matches', plan.visitorMatches.length],
          ['Archive extras', plan.archiveExtras.length],
          ['Unmatched visitors', plan.unmatchedVisitors.length],
        ] as [string, number][]).map(([label, n]) => (
          <span key={label} className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-100">{label}: {n}</span>
        ))}
      </div>

      {plan.ambiguous.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Needs your decision ({plan.ambiguous.length})</h4>
          <ul className="space-y-3">
            {plan.ambiguous.map((a) => (
              <li key={a.individualId} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                <p className="text-sm text-gray-900 dark:text-gray-100 mb-2">{a.firstName} {a.lastName} — choose the Planning Center match:</p>
                <div className="space-y-1">
                  {a.candidateDetails.map((c) => (
                    <label key={c.pcoId} className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`amb-${a.individualId}`} checked={ambiguousChoices[a.individualId] === c.pcoId}
                        onChange={() => setAmbiguousChoices((p) => ({ ...p, [a.individualId]: c.pcoId }))} />
                      <span>{c.firstName} {c.lastName}{c.membership ? ` — ${c.membership}` : ''}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`amb-${a.individualId}`} checked={!ambiguousChoices[a.individualId]}
                      onChange={() => setAmbiguousChoices((p) => ({ ...p, [a.individualId]: null }))} />
                    <span>Skip (leave unlinked)</span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.visitorMatches.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Visitors found in Planning Center — promote or keep? ({plan.visitorMatches.length})
          </h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
            These visitors share a name with someone in Planning Center. Promoting links them and makes them a regular member (Planning Center takes ownership). Keeping leaves them as a visitor and won't ask again.
          </p>
          <ul className="space-y-3">
            {plan.visitorMatches.map((v) => (
              <li key={v.individualId} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                <p className="text-sm text-gray-900 dark:text-gray-100 mb-2">
                  {v.firstName} {v.lastName} ({v.peopleType === 'local_visitor' ? 'local visitor' : 'traveller visitor'}) — matches {v.candidate.firstName} {v.candidate.lastName}{v.candidate.membership ? ` — ${v.candidate.membership}` : ''}
                </p>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`vis-${v.individualId}`}
                      checked={visitorChoices[v.individualId] === 'promote'}
                      onChange={() => setVisitorChoices((p) => ({ ...p, [v.individualId]: 'promote' }))}
                    />
                    <span>Promote to member (link to Planning Center)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`vis-${v.individualId}`}
                      checked={visitorChoices[v.individualId] === 'keep'}
                      onChange={() => setVisitorChoices((p) => ({ ...p, [v.individualId]: 'keep' }))}
                    />
                    <span>Keep as visitor (don't ask again)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`vis-${v.individualId}`}
                      checked={!visitorChoices[v.individualId]}
                      onChange={() => setVisitorChoices((p) => ({ ...p, [v.individualId]: null }))}
                    />
                    <span>Decide later (no change this run)</span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.add.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">New people to add ({plan.add.length - skipAdd.size} selected)</h4>
          <ul className="max-h-64 overflow-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {plan.add.map((p) => (
              <li key={p.pcoId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <input type="checkbox" checked={!skipAdd.has(p.pcoId)} onChange={() => toggleSkip(p.pcoId)} />
                <span>{p.firstName} {p.lastName}{p.isChild ? ' (child)' : ''} — {p.membership || 'no membership'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.archiveExtras.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Not in Planning Center — will be archived ({plan.archiveExtras.length - skipArchiveExtras.size} selected)
          </h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
            Active members in Let My People Grow that don't match anyone in Planning Center. Uncheck any you want to keep active.
          </p>
          <ul className="max-h-64 overflow-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {plan.archiveExtras.map((x) => (
              <li key={x.individualId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <input type="checkbox" checked={!skipArchiveExtras.has(x.individualId)} onChange={() => toggleSkipExtra(x.individualId)} />
                <span>{x.firstName} {x.lastName}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.unmatchedVisitors.length > 0 && (
        <details className="text-sm text-gray-600 dark:text-gray-300">
          <summary className="cursor-pointer">Unmatched visitors ({plan.unmatchedVisitors.length}) — no action; visitors are managed in Let My People Grow</summary>
          <ul className="mt-2 pl-4 list-disc">
            {plan.unmatchedVisitors.map((v) => (
              <li key={v.individualId}>{v.firstName} {v.lastName}</li>
            ))}
          </ul>
        </details>
      )}

      <details className="text-sm text-gray-600 dark:text-gray-300">
        <summary className="cursor-pointer">Auto-applied: {plan.link.length} link, {plan.restore.length} restore, {plan.update.length} update, {plan.archive.length} archive, {plan.reactivate.length} reactivate</summary>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={apply} disabled={applying || loading}
          className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
          {applying ? 'Applying…' : 'Apply sync'}
        </button>
        <button onClick={() => loadPlan()} disabled={applying || loading} className="text-sm underline text-gray-600 dark:text-gray-300">Re-run plan</button>
        <button onClick={() => loadPlan({ force: true })} disabled={applying || loading} className="text-sm underline text-gray-600 dark:text-gray-300">Refresh from Planning Center</button>
      </div>

      {plan.pcoFetchedAt && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Planning Center data as of {new Date(plan.pcoFetchedAt).toLocaleTimeString()}. Re-run plan reuses this snapshot; use “Refresh from Planning Center” to pull the latest.
        </p>
      )}

      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Applied: {result.added} added, {result.updated} updated, {result.archived} archived, {result.reactivated} reactivated, {result.linked} linked
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
    </div>
  );
}
