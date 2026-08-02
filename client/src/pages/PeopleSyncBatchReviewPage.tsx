import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import SyncReview from '../components/peopleSync/SyncReview';
import { peopleSyncErrorMessage } from '../components/peopleSync/apiError';
import { batchReviewApi } from '../components/peopleSync/batchReviewApi';
import type {
  EstablishedLinkCorrection,
  PeopleSyncBatch,
  PeopleSyncCorrectionPreview,
  PeopleSyncReview,
  PeopleSyncSelections,
} from '../components/peopleSync/types';
import { useToast } from '../components/ToastContainer';
import { useUnsavedReviewGuard } from '../hooks/useUnsavedReviewGuard';

const secondaryButtonClass = 'inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

function positiveBatchId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export default function PeopleSyncBatchReviewPage() {
  const { provider: providerSlug, batchId: batchIdParam } = useParams();
  const navigate = useNavigate();
  const { showError, showSuccess, showWarning } = useToast();
  const adapter = useMemo(() => batchReviewApi(providerSlug || ''), [providerSlug]);
  const batchId = positiveBatchId(batchIdParam);
  const requestGeneration = useRef(0);
  const [batch, setBatch] = useState<PeopleSyncBatch | null>(null);
  const [review, setReview] = useState<PeopleSyncReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const providerLabel = adapter?.provider === 'planning_center' ? 'Planning Center' : 'Elvanto';
  const ignoreConfirmedDiscard = useCallback(() => undefined, []);
  const { confirmAction } = useUnsavedReviewGuard({
    dirty,
    onConfirmDiscard: ignoreConfirmedDiscard,
  });

  const loadReview = useCallback(async (): Promise<boolean> => {
    if (!adapter || batchId === null) return false;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [batches, nextReview] = await Promise.all([
        adapter.listBatches(),
        adapter.loadReview(batchId),
      ]);
      if (generation !== requestGeneration.current) return false;
      const nextBatch = batches.find((candidate) => candidate.id === batchId);
      if (!nextBatch) throw new Error('This sync batch is no longer available.');
      setBatch(nextBatch);
      setReview(nextReview);
      setDirty(false);
      return true;
    } catch (cause) {
      if (generation === requestGeneration.current) {
        setLoadError(peopleSyncErrorMessage(cause, 'Failed to load this sync review.'));
      }
      return false;
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [adapter, batchId]);

  useEffect(() => {
    if (!adapter || batchId === null) {
      showError('This sync review link is invalid.');
      navigate(adapter?.returnTo || '/app/settings?tab=integrations', { replace: true });
      return undefined;
    }
    void loadReview();
    return () => {
      requestGeneration.current += 1;
    };
  }, [adapter, batchId, loadReview, navigate, showError]);

  const back = useCallback(() => {
    if (adapter) navigate(adapter.returnTo);
  }, [adapter, navigate]);

  const refresh = useCallback(async () => {
    await confirmAction(loadReview);
  }, [confirmAction, loadReview]);

  const previewCorrections = useCallback((
    baseReviewToken: string,
    linkCorrections: Record<string, EstablishedLinkCorrection>,
  ): Promise<PeopleSyncCorrectionPreview> => {
    if (!adapter || batchId === null) return Promise.reject(new Error('This sync review link is invalid.'));
    return adapter.previewCorrections(batchId, baseReviewToken, linkCorrections);
  }, [adapter, batchId]);

  const applyReview = useCallback(async (reviewToken: string, selections: PeopleSyncSelections) => {
    if (!adapter || batchId === null) throw new Error('This sync review link is invalid.');
    const generation = ++requestGeneration.current;
    setApplying(true);
    try {
      await adapter.applyReview(batchId, reviewToken, selections);
      if (generation !== requestGeneration.current) return;
      setDirty(false);
      showSuccess('Sync applied successfully.');
      try {
        await adapter.listBatches();
      } catch {
        if (generation === requestGeneration.current) {
          showWarning('Sync applied, but the latest batch status could not be loaded.');
        }
      }
      if (generation === requestGeneration.current) navigate(adapter.returnTo);
    } finally {
      if (generation === requestGeneration.current) setApplying(false);
    }
  }, [adapter, batchId, navigate, showSuccess, showWarning]);

  if (!adapter || batchId === null) return null;

  return (
    <section aria-label={`${providerLabel} batch review`} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" className={secondaryButtonClass} onClick={() => confirmAction(back)}>
          Back to {providerLabel}
        </button>
        <p className="text-sm text-gray-500 dark:text-gray-400">Review every proposed change before applying the sync.</p>
      </div>

      {loading && !review && (
        <p role="status" className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
          Loading sync review…
        </p>
      )}

      {loadError && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          <p>{loadError}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" className={secondaryButtonClass} disabled={loading || applying} onClick={() => void refresh()}>
              Retry review
            </button>
          </div>
        </div>
      )}

      {review && batch && (
        <SyncReview
          provider={adapter.provider}
          review={review}
          batchName={batch.name}
          sourceName={(batch.draftSource || batch.source)?.name}
          onRefresh={refresh}
          onPreviewCorrections={previewCorrections}
          onApply={applyReview}
          onDirtyChange={setDirty}
          applying={applying || loading}
          interactionDisabled={loading}
          requireAllPlannedArchivesAccepted={adapter.provider === 'planning_center'}
        />
      )}
    </section>
  );
}
