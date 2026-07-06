import React, { useEffect, useState, useCallback } from 'react';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';
import { buildReconciliationSelections } from './syncSelections';
import PcoPersonSearchPicker, { PcoPersonResult } from './PcoPersonSearchPicker';

interface ExtraEntry { individualId: number; firstName: string; lastName: string; }
interface UnmatchedVisitorEntry { individualId: number; firstName: string; lastName: string; peopleType: string; }
interface Plan {
  archiveExtras: ExtraEntry[];
  unmatchedVisitors: UnmatchedVisitorEntry[];
  pcoFetchedAt?: string;
}

export default function PlanningCenterReconciliationReview() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [skipArchiveExtras, setSkipArchiveExtras] = useState<Set<number>>(new Set());
  const [manualLinks, setManualLinks] = useState<Record<number, PcoPersonResult | null>>({});
  const [searchOpenFor, setSearchOpenFor] = useState<Set<number>>(new Set());

  const loadPlan = useCallback(async (opts?: { force?: boolean; preserveResult?: boolean }) => {
    setLoading(true); setError(null);
    if (!opts?.preserveResult) setResult(null);
    try {
      const res = await integrationsAPI.getPlanningCenterReconciliationPlan({ force: opts?.force });
      setPlan(res.data.plan);
      setSkipArchiveExtras(new Set());
      setManualLinks({});
      setSearchOpenFor(new Set());
    } catch (e: any) {
      logger.error('Failed to compute PCO reconciliation plan', e);
      setError(e.response?.data?.error || 'Failed to compute reconciliation plan.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  const toggleSkipExtra = (individualId: number) => {
    setSkipArchiveExtras((prev) => {
      const n = new Set(prev);
      if (n.has(individualId)) n.delete(individualId); else n.add(individualId);
      return n;
    });
  };

  const apply = async () => {
    setApplying(true); setError(null);
    try {
      const selections = buildReconciliationSelections(skipArchiveExtras, manualLinks);
      const res = await integrationsAPI.applyPlanningCenterReconciliation({ selections });
      setResult(res.data.result);
      await loadPlan({ preserveResult: true });
    } catch (e: any) {
      logger.error('Failed to apply PCO reconciliation', e);
      setError(e.response?.data?.error || 'Failed to apply reconciliation.');
    } finally {
      setApplying(false);
    }
  };

  if (loading) return <p className="text-sm text-gray-500 dark:text-gray-400">Checking Planning Center for people who left…</p>;
  if (error) return <div className="text-sm text-red-600 dark:text-red-400">{error} <button className="underline ml-1" onClick={() => loadPlan()}>Retry</button></div>;
  if (!plan) return null;

  return (
    <div className="space-y-6">
      {plan.archiveExtras.length === 0 && plan.unmatchedVisitors.length === 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-300">Everyone active in Let My People Grow was found in Planning Center. Nothing to review.</p>
      )}

      {plan.archiveExtras.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Not found in Planning Center — will be archived ({plan.archiveExtras.length - skipArchiveExtras.size} selected)
          </h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
            Active members in Let My People Grow whose name doesn't match anyone in Planning Center at all. Uncheck any you want to keep active.
          </p>
          <ul className="max-h-64 overflow-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {plan.archiveExtras.map((x) => (
              <li key={x.individualId} className="flex flex-col gap-1 px-3 py-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={!skipArchiveExtras.has(x.individualId) && !manualLinks[x.individualId]}
                    disabled={!!manualLinks[x.individualId]}
                    onChange={() => toggleSkipExtra(x.individualId)} />
                  <span>{x.firstName} {x.lastName}</span>
                  {manualLinks[x.individualId] ? (
                    <span className="text-xs text-green-700 dark:text-green-400">
                      → linking to {manualLinks[x.individualId]!.firstName} {manualLinks[x.individualId]!.lastName}
                      <button type="button" className="underline ml-1" onClick={() => setManualLinks((p) => ({ ...p, [x.individualId]: null }))}>undo</button>
                    </span>
                  ) : (
                    <button type="button" className="text-xs underline text-gray-600 dark:text-gray-300"
                      onClick={() => setSearchOpenFor((p) => {
                        const n = new Set(p);
                        if (n.has(x.individualId)) n.delete(x.individualId); else n.add(x.individualId);
                        return n;
                      })}>
                      Link instead
                    </button>
                  )}
                </div>
                {searchOpenFor.has(x.individualId) && !manualLinks[x.individualId] && (
                  <PcoPersonSearchPicker onPick={(person) => {
                    setManualLinks((p) => ({ ...p, [x.individualId]: person }));
                    setSearchOpenFor((p) => { const n = new Set(p); n.delete(x.individualId); return n; });
                  }} />
                )}
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

      {plan.archiveExtras.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={apply} disabled={applying || loading}
            className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
            {applying ? 'Applying…' : 'Archive selected'}
          </button>
          <button onClick={() => loadPlan()} disabled={applying || loading} className="text-sm underline text-gray-600 dark:text-gray-300">Re-run check</button>
          <button onClick={() => loadPlan({ force: true })} disabled={applying || loading} className="text-sm underline text-gray-600 dark:text-gray-300">Refresh from Planning Center</button>
        </div>
      )}

      {plan.pcoFetchedAt && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Planning Center data as of {new Date(plan.pcoFetchedAt).toLocaleTimeString()}.
        </p>
      )}

      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Archived: {result.archived}{result.linked ? `, linked: ${result.linked}` : ''}
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
    </div>
  );
}
