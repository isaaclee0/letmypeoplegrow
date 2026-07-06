import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';
import { buildSelections, VisitorChoice } from './syncSelections';
import PcoPersonSearchPicker, { PcoPersonResult } from './PcoPersonSearchPicker';

interface CandidateDetail { pcoId: string; firstName: string; lastName: string; membership: string | null; }
interface AmbiguousEntry { individualId: number; firstName: string; lastName: string; candidates: string[]; candidateDetails: CandidateDetail[]; }
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
  add: { pcoId: string; firstName: string; lastName: string; isChild: boolean; householdId: string | null; membership: string | null }[];
  update: { individualId: number; firstName: string; lastName: string }[];
  archive: { individualId: number; pcoId: string }[];
  reactivate: { individualId: number; pcoId: string }[];
  pcoFetchedAt?: string;
}

export default function PlanningCenterSyncReview({ connected, batchId }: { connected: boolean; batchId: number }) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, string | null>>({});
  const [skipAdd, setSkipAdd] = useState<Set<string>>(new Set());
  const [visitorChoices, setVisitorChoices] = useState<Record<string, VisitorChoice | null>>({});
  const [archiveAmbiguousIds, setArchiveAmbiguousIds] = useState<Set<number>>(new Set());
  const [manualPicks, setManualPicks] = useState<Record<number, PcoPersonResult | null>>({});

  // force: bypass the server-side PCO cache (explicit "Refresh from Planning Center").
  // preserveResult: keep the "Applied: …" message visible when reloading after an apply.
  const loadPlan = useCallback(async (opts?: { force?: boolean; preserveResult?: boolean }) => {
    setLoading(true); setError(null);
    if (!opts?.preserveResult) setResult(null);
    try {
      const res = await integrationsAPI.getPlanningCenterBatchPlan(batchId, { force: opts?.force });
      setPlan(res.data.plan);
      setAmbiguousChoices({});
      setSkipAdd(new Set());
      setVisitorChoices({});
      setArchiveAmbiguousIds(new Set());
      setManualPicks({});
    } catch (e: any) {
      logger.error('Failed to compute PCO batch sync plan', e);
      setError(e.response?.data?.error || 'Failed to compute sync plan.');
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => { if (connected) loadPlan(); }, [connected, batchId, loadPlan]);

  const apply = async () => {
    setApplying(true); setError(null);
    try {
      const selections = buildSelections(ambiguousChoices, skipAdd, visitorChoices, archiveAmbiguousIds);
      const res = await integrationsAPI.applyPlanningCenterBatch(batchId, { selections });
      setResult(res.data.result);
      // Refresh the plan so the lists reflect the post-apply DB state instead of
      // showing the rows we just acted on. PCO is unchanged, so this is a cache hit.
      await loadPlan({ preserveResult: true });
    } catch (e: any) {
      logger.error('Failed to apply PCO batch sync', e);
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
  if (error) return <div className="text-sm text-red-600 dark:text-red-400">{error} <button className="underline ml-1" onClick={() => loadPlan()}>Retry</button></div>;
  if (!plan) return null;

  const toggleSkip = (pcoId: string) => {
    setSkipAdd((prev) => { const n = new Set(prev); if (n.has(pcoId)) n.delete(pcoId); else n.add(pcoId); return n; });
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
                        onChange={() => {
                          setAmbiguousChoices((p) => ({ ...p, [a.individualId]: c.pcoId }));
                          setManualPicks((p) => ({ ...p, [a.individualId]: null }));
                          setArchiveAmbiguousIds((p) => { const n = new Set(p); n.delete(a.individualId); return n; });
                        }} />
                      <span>{c.firstName} {c.lastName}{c.membership ? ` — ${c.membership}` : ''}</span>
                    </label>
                  ))}
                  {manualPicks[a.individualId] && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`amb-${a.individualId}`}
                        checked={ambiguousChoices[a.individualId] === manualPicks[a.individualId]!.pcoId} readOnly />
                      <span>{manualPicks[a.individualId]!.firstName} {manualPicks[a.individualId]!.lastName} (found by search)</span>
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`amb-${a.individualId}`} checked={archiveAmbiguousIds.has(a.individualId)}
                      onChange={() => {
                        setArchiveAmbiguousIds((p) => new Set(p).add(a.individualId));
                        setAmbiguousChoices((p) => ({ ...p, [a.individualId]: null }));
                        setManualPicks((p) => ({ ...p, [a.individualId]: null }));
                      }} />
                    <span>Archive this person</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`amb-${a.individualId}`}
                      checked={!ambiguousChoices[a.individualId] && !archiveAmbiguousIds.has(a.individualId)}
                      onChange={() => {
                        setAmbiguousChoices((p) => ({ ...p, [a.individualId]: null }));
                        setArchiveAmbiguousIds((p) => { const n = new Set(p); n.delete(a.individualId); return n; });
                      }} />
                    <span>Skip (leave unlinked)</span>
                  </label>
                  <PcoPersonSearchPicker onPick={(person) => {
                    setManualPicks((p) => ({ ...p, [a.individualId]: person }));
                    setAmbiguousChoices((p) => ({ ...p, [a.individualId]: person.pcoId }));
                    setArchiveAmbiguousIds((p) => { const n = new Set(p); n.delete(a.individualId); return n; });
                  }} />
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
