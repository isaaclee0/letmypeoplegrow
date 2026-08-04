import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SyncReview from '../peopleSync/SyncReview';
import {
  tagLegacyPeopleReview,
  type EstablishedLinkCorrection,
  type PeopleReviewToken,
  type PeopleSyncOperationReview,
  type PeopleSyncSelections,
} from '../peopleSync/types';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';
import { isRetiredLegacyBatchError, planningCenterBatchErrorMessage, RETIRED_LEGACY_BATCH_MESSAGE } from '../../utils/pcoBatchError';

const reviewSurfaceClass = 'space-y-4 rounded-lg border border-gray-200 bg-gray-50/50 p-4 dark:border-gray-700 dark:bg-gray-900/20';
const secondaryButtonClass = 'inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

interface PlanningCenterSyncReviewProps {
  connected: boolean;
  batchId: number;
  batchName?: string;
  sourceName?: string;
  onApplied?: () => void | Promise<void>;
}

export default function PlanningCenterSyncReview({
  connected,
  batchId,
  batchName,
  sourceName,
  onApplied,
}: PlanningCenterSyncReviewProps) {
  const navigate = useNavigate();
  const [review, setReview] = useState<PeopleSyncOperationReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [appliedRefreshPending, setAppliedRefreshPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const loadReview = useCallback(async (opts?: { force?: boolean; preserveResult?: boolean }): Promise<boolean> => {
    setLoading(true);
    setError(null);
    if (!opts?.preserveResult) setResult(null);
    try {
      const response = await integrationsAPI.getPlanningCenterBatchPlan(batchId, { force: opts?.force });
      setReview(tagLegacyPeopleReview(response.data, 'people_sync'));
      return true;
    } catch (caught: any) {
      logger.error('Failed to compute Planning Center batch sync plan', caught);
      setError(planningCenterBatchErrorMessage(caught, 'Failed to compute sync plan.'));
      return false;
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    if (connected) void loadReview();
  }, [connected, loadReview]);

  if (!connected) {
    return <div className="text-sm text-gray-600 dark:text-gray-300">Planning Center is not connected. <button className={secondaryButtonClass} onClick={() => navigate('/app/settings?tab=integrations')}>Connect it in Settings</button>.</div>;
  }
  if (loading && !review) return <div role="region" aria-label="Planning Center batch sync review" className={reviewSurfaceClass}><p className="text-sm text-gray-500 dark:text-gray-400">Computing sync plan… (fetching everyone from Planning Center)</p></div>;
  if (error && !review) return <div role="region" aria-label="Planning Center batch sync review" className={reviewSurfaceClass}><p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p><button className={secondaryButtonClass} onClick={() => void loadReview()}>Refresh plan</button></div>;
  if (!review) return null;

  const apply = async (reviewToken: PeopleReviewToken<'people_sync'>, selections: PeopleSyncSelections) => {
    setApplying(true);
    setError(null);
    try {
      const response = await integrationsAPI.applyPlanningCenterBatch(batchId, { reviewToken, selections });
      setResult(`Applied sync run ${response.data.runId}.`);
      if (onApplied) {
        await onApplied();
        return;
      }
      setAppliedRefreshPending(true);
      if (await loadReview({ preserveResult: true })) setAppliedRefreshPending(false);
    } catch (caught: any) {
      logger.error('Failed to apply Planning Center batch sync', caught);
      if (isRetiredLegacyBatchError(caught)) {
        setError(null);
        throw new Error(RETIRED_LEGACY_BATCH_MESSAGE);
      }
      throw caught;
    } finally {
      setApplying(false);
    }
  };

  const refreshReview = async (force = false) => {
    if (await loadReview({ force, preserveResult: appliedRefreshPending })) {
      setAppliedRefreshPending(false);
    }
  };

  const previewLinkCorrections = async (
    baseReviewToken: PeopleReviewToken<'people_sync'>,
    linkCorrections: Record<string, EstablishedLinkCorrection>,
  ) => {
    const response = await integrationsAPI.previewPlanningCenterLinkCorrections(batchId, {
      baseReviewToken,
      linkCorrections,
    });
    return tagLegacyPeopleReview(response.data, 'people_sync');
  };

  return <div role="region" aria-label="Planning Center batch sync review" className={reviewSurfaceClass}>
    {!appliedRefreshPending && <SyncReview operationKind="people_sync" provider="planning_center" review={review} batchName={batchName} sourceName={sourceName} onRefresh={() => refreshReview()} onPreviewCorrections={previewLinkCorrections} onApply={apply} applying={applying || loading} requireAllPlannedArchivesAccepted />}
    {appliedRefreshPending && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">Sync applied. Refresh the plan before reviewing another run.</p>}
    {appliedRefreshPending && <button type="button" className={secondaryButtonClass} disabled={applying || loading} onClick={() => void refreshReview(true)}>Retry plan refresh</button>}
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    {result && <div className="text-sm text-green-700 dark:text-green-400">{result}</div>}
  </div>;
}
