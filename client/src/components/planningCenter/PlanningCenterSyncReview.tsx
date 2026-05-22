import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';
import { buildSelections } from './syncSelections';

interface AmbiguousEntry { individualId: number; firstName?: string; lastName?: string; candidates: string[]; }
interface Plan {
  link: { individualId: number; pcoId: string }[];
  ambiguous: AmbiguousEntry[];
  unmatched: number[];
  add: { pcoId: string; firstName: string; lastName: string; isChild: boolean; householdId: string | null; membership: string | null }[];
  update: { individualId: number; firstName: string; lastName: string }[];
  archive: { individualId: number; pcoId: string }[];
  reactivate: { individualId: number; pcoId: string }[];
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

  const loadPlan = useCallback(async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await integrationsAPI.getPlanningCenterSyncPlan();
      setPlan(res.data.plan);
      setAmbiguousChoices({});
      setSkipAdd(new Set());
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
      const selections = buildSelections(ambiguousChoices, skipAdd);
      const res = await integrationsAPI.applyPlanningCenterSync({ selections });
      setResult(res.data.result);
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3 text-sm">
        {([['Link', plan.link.length], ['Add', plan.add.length], ['Update', plan.update.length], ['Archive', plan.archive.length], ['Reactivate', plan.reactivate.length], ['Ambiguous', plan.ambiguous.length], ['Unmatched', plan.unmatched.length]] as [string, number][]).map(([label, n]) => (
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
                  {a.candidates.map((pcoId) => (
                    <label key={pcoId} className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`amb-${a.individualId}`} checked={ambiguousChoices[a.individualId] === pcoId}
                        onChange={() => setAmbiguousChoices((p) => ({ ...p, [a.individualId]: pcoId }))} />
                      <span>PCO #{pcoId}</span>
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
        <summary className="cursor-pointer">Auto-applied: {plan.link.length} link, {plan.update.length} update, {plan.archive.length} archive, {plan.reactivate.length} reactivate; {plan.unmatched.length} unmatched (stay unlinked)</summary>
      </details>

      <div className="flex items-center gap-3">
        <button onClick={apply} disabled={applying}
          className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
          {applying ? 'Applying…' : 'Apply sync'}
        </button>
        <button onClick={loadPlan} disabled={applying} className="text-sm underline text-gray-600 dark:text-gray-300">Re-run plan</button>
      </div>

      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Applied: {result.added} added, {result.updated} updated, {result.archived} archived, {result.reactivated} reactivated, {result.linked} linked
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
    </div>
  );
}
