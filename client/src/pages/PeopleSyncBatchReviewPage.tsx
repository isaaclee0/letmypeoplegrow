import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import SyncReview from '../components/peopleSync/SyncReview';
import HouseholdChoiceEditor, { householdChoiceEditsMatch } from '../components/peopleSync/HouseholdChoiceEditor';
import { isRefreshOnlyReviewError, peopleSyncErrorMessage } from '../components/peopleSync/apiError';
import { batchReviewApi } from '../components/peopleSync/batchReviewApi';
import type {
  EstablishedLinkCorrection,
  HouseholdChoiceEdits,
  PeopleReviewToken,
  PeopleSyncBatch,
  PeopleSyncOperationCorrectionPreview,
  PeopleSyncOperationReview,
  PeopleSyncSelections,
} from '../components/peopleSync/types';
import { useToast } from '../components/ToastContainer';
import { useUnsavedReviewGuard } from '../hooks/useUnsavedReviewGuard';
import { gatheringsAPI, peopleSyncAPI, PEOPLE_SYNC_BATCH_PREPARED_MESSAGE } from '../services/api';
import type { KeptReconciliation } from '../components/peopleSync/types';

// Exercise the prototype against real signed reviews only in development.
const DevDecisionList = import.meta.env.DEV
  ? React.lazy(() => import('../components/peopleSync/SyncDecisionList'))
  : null;

const secondaryButtonClass = 'inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

function positiveBatchId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export default function PeopleSyncBatchReviewPage({ integrationWide = false }: { integrationWide?: boolean }) {
  const { provider } = useParams();
  const location = useLocation();
  if (!integrationWide && provider === 'planning-center') {
    return <Navigate replace to={`/app/settings/integrations/planning-center/review${location.search}`} />;
  }
  return <PeopleSyncReviewWorkspace integrationWide={integrationWide} />;
}

function PeopleSyncReviewWorkspace({ integrationWide }: { integrationWide: boolean }) {
  const { provider, batchId: batchIdParam } = useParams();
  const providerSlug = integrationWide ? 'planning-center' : provider;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const decisionLayout = !!DevDecisionList && searchParams.get('layout') === 'decisions';
  const { showError, showSuccess, showWarning } = useToast();
  const adapter = useMemo(() => batchReviewApi(providerSlug || ''), [providerSlug]);
  const batchId = integrationWide ? null : positiveBatchId(batchIdParam);
  const requestGeneration = useRef(0);
  const [participatingBatches, setParticipatingBatches] = useState<PeopleSyncBatch[]>([]);
  const [gatherings, setGatherings] = useState<Array<{ id: number; name: string }>>([]);
  const [batch, setBatch] = useState<PeopleSyncBatch | null>(null);
  const [review, setReview] = useState<PeopleSyncOperationReview | null>(null);
  const [loadedContextKey, setLoadedContextKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewDirty, setDirty] = useState(false);
  const baseReviewRef = useRef<PeopleSyncOperationReview | null>(null);
  const [householdEdits, setHouseholdEdits] = useState<HouseholdChoiceEdits>({});
  const [householdPreviewing, setHouseholdPreviewing] = useState(false);
  const [householdError, setHouseholdError] = useState<string | null>(null);
  const [householdRefreshRequired, setHouseholdRefreshRequired] = useState(false);
  const householdContractUnsupported = !!review?.plan.householdChoices && review.plan.householdChoices.version !== 2;
  const householdNeedsPreview = !householdChoiceEditsMatch(householdEdits, review?.plan.householdChoices?.edits || {});
  const householdDirty = Object.keys(householdEdits).length > 0 || Object.keys(review?.plan.householdChoices?.edits || {}).length > 0;
  const dirty = reviewDirty || householdDirty;
  const providerLabel = adapter?.provider === 'planning_center' ? 'Planning Center' : 'Elvanto';
  const routeContextKey = adapter && (integrationWide || batchId !== null) ? `${adapter.provider}:${integrationWide ? 'integration' : batchId}` : null;
  const visibleBatch = !loading && loadedContextKey === routeContextKey ? batch : null;
  const scopeReady = !loading && loadedContextKey === routeContextKey;
  const visibleReview = scopeReady ? review : null;
  const reviewedLists = visibleReview?.plan.sourceContext?.reviewedLists || [];
  const ignoreConfirmedDiscard = useCallback(() => undefined, []);
  const { confirmAction } = useUnsavedReviewGuard({
    dirty,
    onConfirmDiscard: ignoreConfirmedDiscard,
  });

  const loadReview = useCallback(async (): Promise<boolean> => {
    if (!adapter || (!integrationWide && batchId === null)) return false;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setLoadError(null);
    setLoadedContextKey(null);
    setReview(null);
    baseReviewRef.current = null;
    try {
      const [batches, settingsResponse, gatheringResponse] = await Promise.all([
        adapter.listBatches(),
        integrationWide ? peopleSyncAPI.getSettings() : Promise.resolve(null),
        integrationWide ? gatheringsAPI.getAll().catch(() => null) : Promise.resolve(null),
      ]);
      if (generation !== requestGeneration.current) return false;
      let nextBatch: PeopleSyncBatch | null = null;
      if (integrationWide) {
        const settings = settingsResponse?.data.settings;
        if (settings?.authorityProvider !== 'planning_center') {
          throw new Error('Set Planning Center as the people source of truth and complete its authority review before syncing.');
        }
        if (settings.pendingAuthorityProvider) {
          throw new Error('Complete or cancel the pending people source switch before reviewing this sync.');
        }
        const enabled = batches.filter((candidate) => candidate.provider === 'planning_center' && candidate.enabled && candidate.legacyProviderBatchId === null);
        setParticipatingBatches(enabled);
        const gatheringData = gatheringResponse?.data;
        setGatherings(Array.isArray(gatheringData) ? gatheringData : gatheringData?.gatherings || gatheringData?.gatheringTypes || []);
        if (enabled.length === 0) {
          setBatch(null);
          setLoadedContextKey(routeContextKey);
          setHouseholdEdits({});
          setDirty(false);
          return true;
        }
        for (const candidate of enabled) {
          if (candidate.operationalState === 'prepared') throw new Error(PEOPLE_SYNC_BATCH_PREPARED_MESSAGE);
          if (!candidate.reviewable) throw new Error(`The synced list “${candidate.name}” is not available for review. Check its configuration in Planning Center settings.`);
          if (!candidate.draftSource && !candidate.source) throw new Error(`Choose a Planning Center list for “${candidate.name}” before reviewing this sync.`);
        }
      } else {
        nextBatch = batches.find((candidate) => candidate.id === batchId) || null;
        if (!nextBatch) throw new Error('This sync batch is no longer available.');
      }
      const nextReview = await adapter.loadReview(nextBatch);
      if (generation !== requestGeneration.current) return false;
      if (integrationWide && !nextReview.plan.authoritative) throw new Error('Planning Center must be the people source of truth before reviewing this sync.');
      setBatch(nextBatch);
      setReview(nextReview);
      baseReviewRef.current = nextReview;
      setHouseholdEdits(nextReview.plan.householdChoices?.edits || {});
      setHouseholdError(null);
      setHouseholdRefreshRequired(false);
      setHouseholdPreviewing(false);
      setLoadedContextKey(routeContextKey);
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
  }, [adapter, batchId, integrationWide, routeContextKey]);

  useEffect(() => {
    if (!adapter || (!integrationWide && batchId === null)) {
      showError('This sync review link is invalid.');
      navigate(adapter?.returnTo || '/app/settings?tab=integrations', { replace: true });
      return undefined;
    }
    setBatch(null);
    setParticipatingBatches([]);
    setGatherings([]);
    setReview(null);
    baseReviewRef.current = null;
    setHouseholdEdits({});
    setHouseholdError(null);
    setHouseholdRefreshRequired(false);
    setHouseholdPreviewing(false);
    setLoadedContextKey(null);
    setLoadError(null);
    setDirty(false);
    setApplying(false);
    void loadReview();
    return () => {
      requestGeneration.current += 1;
    };
  }, [adapter, batchId, integrationWide, loadReview, navigate, showError]);

  const back = useCallback(() => {
    if (adapter) navigate(adapter.returnTo);
  }, [adapter, navigate]);

  const refresh = useCallback(async () => {
    await confirmAction(loadReview);
  }, [confirmAction, loadReview]);

  const previewCorrections = useCallback((
    baseReviewToken: PeopleReviewToken<'people_sync'>,
    linkCorrections: Record<string, EstablishedLinkCorrection>,
  ): Promise<PeopleSyncOperationCorrectionPreview> => {
    if (!adapter || !scopeReady || (!integrationWide && !visibleBatch)) return Promise.reject(new Error('This sync review link is invalid.'));
    if (householdDirty || householdNeedsPreview || householdPreviewing) {
      const message = 'Reset household choices and preview them, or refresh the review, before correcting a linked person. Apply the household choices first if you want to save them.';
      setHouseholdError(message);
      return Promise.reject(new Error(message));
    }
    return adapter.previewCorrections(visibleBatch, baseReviewRef.current?.reviewToken || baseReviewToken, linkCorrections);
  }, [adapter, visibleBatch, scopeReady, integrationWide, householdDirty, householdNeedsPreview, householdPreviewing]);

  const previewHouseholdChoices = useCallback(async () => {
    if (!adapter?.previewHouseholdChoices || !scopeReady || (!integrationWide && !visibleBatch) || !baseReviewRef.current || householdPreviewing) return;
    // A new household destination produces different signed move proposals.
    // Keep other choices intact if the reviewer declines to recalculate them.
    if (reviewDirty && !window.confirm('Previewing household choices recalculates this review and resets your other unsaved review choices. Continue?')) return;
    const originalReview = baseReviewRef.current;
    const generation = ++requestGeneration.current;
    setHouseholdPreviewing(true);
    setHouseholdError(null);
    try {
      const preview = await adapter.previewHouseholdChoices(visibleBatch, originalReview.reviewToken, householdEdits);
      if (generation !== requestGeneration.current) return;
      setReview({ ...preview, runId: originalReview.runId });
      setHouseholdEdits(preview.plan.householdChoices?.edits || {});
      setHouseholdRefreshRequired(false);
      setDirty(false);
    } catch (cause) {
      if (generation === requestGeneration.current) {
        setHouseholdError(peopleSyncErrorMessage(cause, 'Failed to preview household choices.'));
        setHouseholdRefreshRequired(isRefreshOnlyReviewError(cause));
      }
    } finally {
      if (generation === requestGeneration.current) setHouseholdPreviewing(false);
    }
  }, [adapter, visibleBatch, scopeReady, integrationWide, householdEdits, householdPreviewing, reviewDirty]);

  const applyReview = useCallback(async (reviewToken: PeopleReviewToken<'people_sync'>, selections: PeopleSyncSelections) => {
    if (!adapter || !scopeReady || (!integrationWide && !visibleBatch)) throw new Error('This sync review link is invalid.');
    if (householdContractUnsupported || householdRefreshRequired) throw new Error('Refresh this review before applying household choices.');
    if (householdNeedsPreview || householdPreviewing) throw new Error('Preview the latest household choices before applying.');
    const signedEdits = visibleReview?.plan.householdChoices?.edits;
    if (signedEdits && Object.keys(signedEdits).length > 0 && reviewToken !== visibleReview?.reviewToken) {
      throw new Error('The household choices and person-link corrections need separate reviews. Refresh this review before applying.');
    }
    const submitted = signedEdits && reviewToken === visibleReview?.reviewToken
      ? { ...selections, householdChoices: signedEdits } : selections;
    const generation = ++requestGeneration.current;
    setApplying(true);
    try {
      await adapter.applyReview(visibleBatch, reviewToken, submitted);
      if (generation !== requestGeneration.current) return;
      setDirty(false);
      setHouseholdEdits({});
      setReview(null);
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
  }, [adapter, navigate, showSuccess, showWarning, visibleBatch, scopeReady, integrationWide, visibleReview, householdNeedsPreview, householdPreviewing, householdRefreshRequired, householdContractUnsupported]);

  const askAgain = useCallback(async (kept: KeptReconciliation) => {
    if (!adapter) return;
    await confirmAction(async () => {
      await peopleSyncAPI.forgetReconciliationKeep(adapter.provider, kept.keepId);
      await loadReview();
    });
  }, [adapter, confirmAction, loadReview]);

  if (!adapter || (!integrationWide && batchId === null)) return null;

  return (
    <section aria-label={`${providerLabel} ${integrationWide ? "integration" : "batch"} review`} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" className={secondaryButtonClass} onClick={() => confirmAction(back)}>
          Back to {providerLabel}
        </button>
        <p className="text-sm text-gray-500 dark:text-gray-400">Review every proposed change before applying the sync.</p>
      </div>

      {integrationWide && <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Planning Center review &amp; sync</h1>}

      {loading && !visibleReview && (
        <p role="status" className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
          Loading sync review…
        </p>
      )}

      {DevDecisionList && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <p>Development review · Applying changes updates this local LMPG database.</p>
        <button type="button" className={secondaryButtonClass} disabled={loading || applying || householdPreviewing}
          onClick={() => confirmAction(() => {
            const next = new URLSearchParams(searchParams);
            if (decisionLayout) next.delete('layout'); else next.set('layout', 'decisions');
            setDirty(false);
            setHouseholdEdits({});
            if (!householdRefreshRequired) setHouseholdError(null);
            setReview(baseReviewRef.current);
            setSearchParams(next);
          })}>
          {decisionLayout ? 'Use current review' : 'Try new review'}
        </button>
      </div>}

      {loadError && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          <p>{loadError}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" className={secondaryButtonClass} disabled={loading || applying || householdPreviewing} onClick={() => void refresh()}>
              Retry review
            </button>
          </div>
        </div>
      )}

      {integrationWide && scopeReady && participatingBatches.length === 0 && !loadError && (
        <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          <h1 className="font-semibold text-gray-900 dark:text-gray-100">No enabled Planning Center lists</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Add or enable a synced list in Planning Center settings, then return here to review all lists together.</p>
        </div>
      )}

      {integrationWide && visibleReview && (
        <section aria-label="Lists included in this review" className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">Lists included in this review</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">All enabled lists are reviewed together.{reviewedLists.some((list) => list.isDraft) && ' Applying this review also saves the pending source changes shown below.'}</p>
          <ul className="mt-3 space-y-3 text-sm">
            {reviewedLists.map((sourceBatch) => (
              <li key={sourceBatch.batchId}>
                <p className="font-medium text-gray-900 dark:text-gray-100">{sourceBatch.name}</p>
                {sourceBatch.isDraft ? <div className="text-gray-600 dark:text-gray-300">
                  <span className="font-medium text-amber-700 dark:text-amber-300">{sourceBatch.activeSource ? 'Pending source change' : 'New list — pending review'}</span>
                  <p>{sourceBatch.activeSource && <><span>{sourceBatch.activeSource.name}</span> → </>}<span>{sourceBatch.selectedSource.name}</span></p>
                </div> : sourceBatch.selectedSource.name !== sourceBatch.name && <p className="text-gray-600 dark:text-gray-300">{sourceBatch.selectedSource.name}</p>}
                {sourceBatch.gatheringTypeId !== null && <p className="text-xs text-gray-500 dark:text-gray-400">Attendance list: {gatherings.find((gathering) => gathering.id === sourceBatch.gatheringTypeId)?.name || `Gathering ${sourceBatch.gatheringTypeId}`}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {visibleReview?.plan.householdChoices && adapter.previewHouseholdChoices && <HouseholdChoiceEditor
        plan={visibleReview.plan.householdChoices}
        baseGroups={baseReviewRef.current?.plan.householdChoices?.groups || []}
        edits={householdEdits}
        onChange={(edits) => { setHouseholdEdits(edits); if (!householdRefreshRequired) setHouseholdError(null); }}
        onPreview={previewHouseholdChoices}
        needsPreview={householdNeedsPreview}
        previewing={householdPreviewing}
        disabled={loading || applying}
        error={householdError}
      />}

      {visibleReview && (integrationWide || visibleBatch) && (
        decisionLayout && DevDecisionList ? <React.Suspense fallback={<p role="status">Loading review layout…</p>}>
          <DevDecisionList
            key={`${visibleReview.runId}:${visibleReview.reviewToken}`}
            review={visibleReview}
            provider={adapter.provider}
            batchName={integrationWide ? 'All enabled lists' : visibleBatch!.name}
            gatherings={integrationWide ? gatherings : undefined}
            onRefresh={refresh}
            onApply={applyReview}
            onAskAgain={askAgain}
            onDirtyChange={setDirty}
            applying={applying || loading}
            interactionDisabled={householdPreviewing}
            applyBlocked={householdNeedsPreview || householdPreviewing || householdRefreshRequired || householdContractUnsupported}
          />
        </React.Suspense> : <SyncReview
          key={`${visibleReview.runId}:${visibleReview.reviewToken}`}
          operationKind="people_sync"
          provider={adapter.provider}
          review={visibleReview}
          batchName={integrationWide ? 'All enabled lists' : visibleBatch!.name}
          gatherings={integrationWide ? gatherings : undefined}
          sourceName={integrationWide ? undefined : (visibleBatch?.draftSource || visibleBatch?.source)?.name}
          onRefresh={refresh}
          onPreviewCorrections={previewCorrections}
          onApply={applyReview}
          onDirtyChange={setDirty}
          applying={applying || loading}
          interactionDisabled={loading || householdPreviewing}
          applyBlocked={householdNeedsPreview || householdPreviewing || householdRefreshRequired || householdContractUnsupported}
          requireAllPlannedArchivesAccepted={adapter.provider === 'planning_center'}
          initialIdentityFilter={!integrationWide && visibleBatch?.unresolvedIdentityCount && visibleBatch.unresolvedIdentityCount > 0
            ? 'needs_attention'
            : 'all'}
        />
      )}
    </section>
  );
}
