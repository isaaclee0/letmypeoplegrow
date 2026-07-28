import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SyncReview from '../peopleSync/SyncReview';
import type { PeopleSyncReview, PeopleSyncSelections } from '../peopleSync/types';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';

export default function PlanningCenterSyncReview({ connected, batchId, onApplied }: { connected: boolean; batchId: number; onApplied?: () => void | Promise<void> }) {
  const navigate = useNavigate();
  const [review, setReview] = useState<PeopleSyncReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const loadReview = useCallback(async (opts?: { force?: boolean; preserveResult?: boolean }) => {
    setLoading(true);
    setError(null);
    if (!opts?.preserveResult) setResult(null);
    try {
      const response = await integrationsAPI.getPlanningCenterBatchPlan(batchId, { force: opts?.force });
      setReview(response.data);
    } catch (caught: any) {
      logger.error('Failed to compute Planning Center batch sync plan', caught);
      setError(caught.response?.data?.error || 'Failed to compute sync plan.');
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    if (connected) void loadReview();
  }, [connected, loadReview]);

  if (!connected) {
    return <div className="text-sm text-gray-600 dark:text-gray-300">Planning Center is not connected. <button className="underline" onClick={() => navigate('/app/settings?tab=integrations')}>Connect it in Settings</button>.</div>;
  }
  if (loading && !review) return <p className="text-sm text-gray-500 dark:text-gray-400">Computing sync plan… (fetching everyone from Planning Center)</p>;
  if (error && !review) return <div className="text-sm text-red-600 dark:text-red-400">{error} <button className="underline ml-1" onClick={() => void loadReview()}>Retry</button></div>;
  if (!review) return null;

  const apply = async (reviewToken: string, selections: PeopleSyncSelections) => {
    setApplying(true);
    setError(null);
    try {
      const response = await integrationsAPI.applyPlanningCenterBatch(batchId, { reviewToken, selections });
      setResult(`Applied sync run ${response.data.runId}.`);
      await loadReview({ preserveResult: true });
      await onApplied?.();
    } catch (caught: any) {
      logger.error('Failed to apply Planning Center batch sync', caught);
      setError(caught.response?.data?.error || 'Failed to apply sync.');
      throw caught;
    } finally {
      setApplying(false);
    }
  };

  return <div className="space-y-4">
    <SyncReview provider="planning_center" review={review} onRefresh={() => loadReview()} onApply={apply} applying={applying} requireAllPlannedArchivesAccepted />
    <button type="button" className="text-sm underline text-gray-600 dark:text-gray-300" disabled={applying || loading} onClick={() => void loadReview({ force: true })}>Refresh from Planning Center</button>
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    {result && <div className="text-sm text-green-700 dark:text-green-400">{result}</div>}
  </div>;
}
