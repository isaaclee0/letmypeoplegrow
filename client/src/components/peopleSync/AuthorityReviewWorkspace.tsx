import React, { useCallback, useEffect, useRef, useState } from 'react';
import { peopleSyncAPI } from '../../services/api';
import SyncReview from './SyncReview';
import { peopleSyncErrorMessage, toPeopleSyncDisplayError } from './apiError';
import {
  cancelAuthorityPreviewWithRetry,
  type AuthorityPreviewCancellation,
} from './authorityPreviewCancellation';
import type {
  AuthoritySwitchReview,
  PeopleReviewToken,
  PeopleSyncSelections,
  SyncProvider,
} from './types';
import { tagLegacyPeopleReview } from './types';

type AuthorityReviewState =
  | 'idle'
  | 'previewing'
  | 'reviewing'
  | 'applying'
  | 'cancelling'
  | 'refreshing_after_apply'
  | 'apply_refresh_pending'
  | 'error';

export interface AuthorityReviewWorkspaceProps {
  provider: SyncProvider;
  autoStart: boolean;
  onApplied: () => void | Promise<void>;
  onCancel: () => void;
}

interface AcceptedReviewOwnership {
  provider: SyncProvider;
  authorityPreviewId: string | null;
}

interface InFlightAuthorityPreview {
  generation: number;
  provider: SyncProvider;
}

const providerName = (provider: SyncProvider) =>
  provider === 'planning_center' ? 'Planning Center' : 'Elvanto';

export default function AuthorityReviewWorkspace({
  provider,
  autoStart,
  onApplied,
  onCancel,
}: AuthorityReviewWorkspaceProps) {
  const [state, setState] = useState<AuthorityReviewState>('idle');
  const [review, setReview] = useState<AuthoritySwitchReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const activeReviewTokenRef = useRef<PeopleReviewToken<'authority_switch'> | null>(null);
  const acceptedReviewOwnershipRef = useRef<AcceptedReviewOwnership | null>(null);
  const ownedAuthorityPreviewRef = useRef<AuthorityPreviewCancellation | null>(null);
  const inFlightPreviewRef = useRef<InFlightAuthorityPreview | null>(null);
  const pendingPreviewCancellationRef = useRef<InFlightAuthorityPreview | null>(null);
  const mountedRef = useRef(false);
  const autoStartedProviderRef = useRef<SyncProvider | null>(null);
  const progressRef = useRef<HTMLParagraphElement>(null);
  const reviewRegionRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const retireAuthorityPreview = useCallback((preview: AuthorityPreviewCancellation) => {
    const cancellation = cancelAuthorityPreviewWithRetry(preview);
    void cancellation.then(
      () => {
        if (ownedAuthorityPreviewRef.current?.provider === preview.provider
          && ownedAuthorityPreviewRef.current.authorityPreviewId === preview.authorityPreviewId) {
          ownedAuthorityPreviewRef.current = null;
        }
      },
      () => undefined,
    );
    return cancellation;
  }, []);

  const discardSupersededPreview = useCallback((discardedReview: AuthoritySwitchReview) => {
    if (!discardedReview.authorityPreviewId) return;
    void retireAuthorityPreview({
      provider,
      authorityPreviewId: discardedReview.authorityPreviewId,
    });
  }, [provider, retireAuthorityPreview]);

  const preview = useCallback(async () => {
    if (pendingPreviewCancellationRef.current) return;
    const generation = ++generationRef.current;
    const requestProvider = provider;
    const previousReview = review;
    const previousOwnedPreview = ownedAuthorityPreviewRef.current;
    inFlightPreviewRef.current = { generation, provider: requestProvider };
    activeReviewTokenRef.current = null;
    setState('previewing');
    setError(null);
    try {
      const response = await peopleSyncAPI.previewAuthority(requestProvider);
      const nextReview = tagLegacyPeopleReview(response.data, 'authority_switch');
      if (generation !== generationRef.current) {
        discardSupersededPreview(nextReview);
        return;
      }
      if (inFlightPreviewRef.current?.generation === generation) inFlightPreviewRef.current = null;
      activeReviewTokenRef.current = nextReview.reviewToken;
      const nextOwnedPreview = nextReview.authorityPreviewId
        ? { provider: requestProvider, authorityPreviewId: nextReview.authorityPreviewId }
        : null;
      if (previousOwnedPreview && (!nextOwnedPreview
        || previousOwnedPreview.provider !== nextOwnedPreview.provider
        || previousOwnedPreview.authorityPreviewId !== nextOwnedPreview.authorityPreviewId)) {
        void retireAuthorityPreview(previousOwnedPreview);
      }
      ownedAuthorityPreviewRef.current = nextOwnedPreview;
      acceptedReviewOwnershipRef.current = {
        provider: requestProvider,
        authorityPreviewId: nextReview.authorityPreviewId ?? null,
      };

      const pendingCancellation = pendingPreviewCancellationRef.current;
      if (pendingCancellation?.generation === generation) {
        setReview(null);
        if (!nextOwnedPreview) {
          pendingPreviewCancellationRef.current = null;
          acceptedReviewOwnershipRef.current = null;
          activeReviewTokenRef.current = null;
          setState('idle');
          onCancel();
          return;
        }
        try {
          await retireAuthorityPreview(nextOwnedPreview);
        } catch (cause) {
          if (generation !== generationRef.current) return;
          setError(peopleSyncErrorMessage(cause, 'Failed to cancel the authority change.'));
          setState('error');
          return;
        }
        if (generation !== generationRef.current) return;
        pendingPreviewCancellationRef.current = null;
        acceptedReviewOwnershipRef.current = null;
        ownedAuthorityPreviewRef.current = null;
        activeReviewTokenRef.current = null;
        setError(null);
        setState('idle');
        onCancel();
        return;
      }
      setReview(nextReview);
      setState('reviewing');
    } catch (cause) {
      if (generation !== generationRef.current) return;
      if (inFlightPreviewRef.current?.generation === generation) inFlightPreviewRef.current = null;
      if (pendingPreviewCancellationRef.current?.generation === generation) {
        if (previousOwnedPreview) {
          try {
            await retireAuthorityPreview(previousOwnedPreview);
          } catch (cancellationCause) {
            if (generation !== generationRef.current) return;
            setError(peopleSyncErrorMessage(cancellationCause, 'Failed to cancel the authority change.'));
            setState('error');
            return;
          }
          if (generation !== generationRef.current) return;
        }
        pendingPreviewCancellationRef.current = null;
        acceptedReviewOwnershipRef.current = null;
        ownedAuthorityPreviewRef.current = null;
        activeReviewTokenRef.current = null;
        setReview(null);
        setError(null);
        setState('idle');
        onCancel();
        return;
      }
      setError(peopleSyncErrorMessage(cause, 'Failed to preview the authority change.'));
      if (previousReview) {
        // A replacement may have invalidated the old server-side intent even
        // when its response failed. Retire that exact intent and fail closed.
        if (previousOwnedPreview) void retireAuthorityPreview(previousOwnedPreview);
        acceptedReviewOwnershipRef.current = null;
        setReview(null);
      }
      setState('error');
    }
  }, [discardSupersededPreview, onCancel, provider, retireAuthorityPreview, review]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // React Strict Mode immediately replays effect setup after its simulated
      // cleanup. Deferring ownership retirement one microtask distinguishes
      // that replay from a real unmount without duplicating the preview.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        generationRef.current += 1;
        activeReviewTokenRef.current = null;
        acceptedReviewOwnershipRef.current = null;
        inFlightPreviewRef.current = null;
        pendingPreviewCancellationRef.current = null;
        const ownedPreview = ownedAuthorityPreviewRef.current;
        if (ownedPreview) void retireAuthorityPreview(ownedPreview);
      });
    };
  }, [retireAuthorityPreview]);

  useEffect(() => {
    if (!autoStart) {
      autoStartedProviderRef.current = null;
      return;
    }
    if (autoStartedProviderRef.current === provider) return;
    autoStartedProviderRef.current = provider;
    void preview();
  }, [autoStart, preview, provider]);

  useEffect(() => {
    const target = state === 'previewing'
      ? progressRef.current
      : state === 'reviewing'
        ? reviewRegionRef.current
        : state === 'error'
          ? errorRef.current
          : null;
    target?.focus();
  }, [state]);

  const refreshAfterApply = async () => {
    const generation = generationRef.current;
    setState('refreshing_after_apply');
    setError(null);
    try {
      await onApplied();
    } catch (refreshCause) {
      if (generation !== generationRef.current) return;
      const detail = peopleSyncErrorMessage(refreshCause, 'Refresh failed.');
      setError(`The authority change was applied, but its status could not be refreshed: ${detail}`);
      setState('apply_refresh_pending');
      return;
    }
    if (generation !== generationRef.current) return;
    activeReviewTokenRef.current = null;
    setReview(null);
    setState('idle');
  };

  const apply = async (
    reviewToken: PeopleReviewToken<'authority_switch'>,
    selections: PeopleSyncSelections,
  ) => {
    const acceptedOwnership = acceptedReviewOwnershipRef.current;
    if (!acceptedOwnership || activeReviewTokenRef.current !== reviewToken) return;
    const generation = ++generationRef.current;
    activeReviewTokenRef.current = null;
    setState('applying');
    setError(null);
    try {
      await peopleSyncAPI.applyAuthority(acceptedOwnership.provider, reviewToken, selections);
    } catch (cause) {
      if (generation === generationRef.current) {
        activeReviewTokenRef.current = reviewToken;
        setState('reviewing');
      }
      throw toPeopleSyncDisplayError(cause, 'Failed to apply the authority change.');
    }
    if (generation !== generationRef.current) return;
    ownedAuthorityPreviewRef.current = null;
    acceptedReviewOwnershipRef.current = null;
    await refreshAfterApply();
  };

  const clearReview = () => {
    activeReviewTokenRef.current = null;
    acceptedReviewOwnershipRef.current = null;
    ownedAuthorityPreviewRef.current = null;
    pendingPreviewCancellationRef.current = null;
    setReview(null);
    setError(null);
    setState('idle');
  };

  const cancelReview = async () => {
    if (state === 'applying' || state === 'cancelling') return;
    if (state === 'previewing') {
      const inFlightPreview = inFlightPreviewRef.current;
      if (!inFlightPreview) return;
      pendingPreviewCancellationRef.current = inFlightPreview;
      activeReviewTokenRef.current = null;
      setReview(null);
      setError(null);
      setState('cancelling');
      return;
    }
    if (!review) return;
    const reviewToCancel = review;
    const acceptedOwnership = acceptedReviewOwnershipRef.current;
    if (!acceptedOwnership) return;
    const generation = ++generationRef.current;
    activeReviewTokenRef.current = null;
    setError(null);

    if (!acceptedOwnership.authorityPreviewId) {
      clearReview();
      onCancel();
      return;
    }

    const previewToCancel = {
      provider: acceptedOwnership.provider,
      authorityPreviewId: acceptedOwnership.authorityPreviewId,
    };
    setState('cancelling');
    try {
      await retireAuthorityPreview(previewToCancel);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      activeReviewTokenRef.current = reviewToCancel.reviewToken;
      setError(peopleSyncErrorMessage(cause, 'Failed to cancel the authority change.'));
      setState('reviewing');
      return;
    }
    if (generation !== generationRef.current) return;
    clearReview();
    onCancel();
  };

  const retryPendingPreviewCancellation = async () => {
    const pendingCancellation = pendingPreviewCancellationRef.current;
    const acceptedOwnership = acceptedReviewOwnershipRef.current;
    if (!pendingCancellation || !acceptedOwnership?.authorityPreviewId) return;
    const generation = pendingCancellation.generation;
    setError(null);
    setState('cancelling');
    try {
      await retireAuthorityPreview({
        provider: acceptedOwnership.provider,
        authorityPreviewId: acceptedOwnership.authorityPreviewId,
      });
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(peopleSyncErrorMessage(cause, 'Failed to cancel the authority change.'));
      setState('error');
      return;
    }
    if (generation !== generationRef.current) return;
    pendingPreviewCancellationRef.current = null;
    acceptedReviewOwnershipRef.current = null;
    ownedAuthorityPreviewRef.current = null;
    activeReviewTokenRef.current = null;
    setError(null);
    setState('idle');
    onCancel();
  };

  const summary = review?.summary;
  const linked = summary?.linkPeople || 0;
  const locked = linked
    + (summary?.updateManagedFields || 0)
    + (summary?.reactivate || 0)
    + (summary?.archive || 0);
  const applyRefreshPending = state === 'apply_refresh_pending' || state === 'refreshing_after_apply';
  const reviewProvider = acceptedReviewOwnershipRef.current?.provider ?? provider;
  const cancellingPendingPreview = pendingPreviewCancellationRef.current !== null;

  return (
    <div className="space-y-4">
      {state === 'previewing' && !review && (
        <div className="space-y-3">
          <p ref={progressRef} role="status" tabIndex={-1} className="text-sm text-gray-600">
            Preparing authority review…
          </p>
          <button type="button" onClick={() => void cancelReview()} className="text-sm underline">
            Cancel authority change
          </button>
        </div>
      )}
      {state === 'cancelling' && cancellingPendingPreview && (
        <p role="status" className="text-sm text-gray-600">Cancelling authority change…</p>
      )}
      {error && !applyRefreshPending && (
        <div ref={errorRef} role="alert" tabIndex={-1} className="space-y-3 text-sm text-red-600">
          <p>{error}</p>
          {!review && cancellingPendingPreview ? (
            <button type="button" onClick={() => void retryPendingPreviewCancellation()} className="text-sm underline">
              Retry cancellation
            </button>
          ) : !review && (
            <div className="flex gap-3">
              <button type="button" onClick={() => void preview()} className="text-sm underline">
                Retry authority review
              </button>
              <button type="button" onClick={onCancel} className="text-sm underline">
                Cancel authority change
              </button>
            </div>
          )}
        </div>
      )}
      {review && (
        <div
          ref={reviewRegionRef}
          role="region"
          aria-label={`${providerName(reviewProvider)} authority review`}
          tabIndex={-1}
          className="space-y-4 rounded-lg border border-gray-200 bg-gray-50/50 p-4 dark:border-gray-700 dark:bg-gray-900/20"
        >
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-blue-50 px-2 py-1 text-blue-800">Coverage: {linked} linked</span>
            <span className="rounded bg-blue-50 px-2 py-1 text-blue-800">{locked} locked after apply</span>
            <span className="rounded bg-gray-100 px-2 py-1">{summary?.addPeople || 0} adds</span>
            <span className="rounded bg-gray-100 px-2 py-1">{summary?.updateManagedFields || 0} updates</span>
            <span className="rounded bg-gray-100 px-2 py-1">{summary?.reactivate || 0} restore{summary?.reactivate === 1 ? '' : 's'}</span>
            <span className="rounded bg-gray-100 px-2 py-1">{summary?.archive || 0} archives</span>
          </div>
          {applyRefreshPending ? (
            <div className="space-y-3">
              {error ? (
                <p role="alert" className="text-sm text-red-600">{error}</p>
              ) : (
                <p role="status" className="text-sm text-gray-600">
                  Authority change applied. Refreshing authoritative source status…
                </p>
              )}
              <button
                type="button"
                onClick={() => void refreshAfterApply()}
                disabled={state === 'refreshing_after_apply'}
                className="rounded bg-green-600 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                {state === 'refreshing_after_apply' ? 'Refreshing…' : 'Retry status refresh'}
              </button>
            </div>
          ) : (
            <>
              <SyncReview
                operationKind="authority_switch"
                provider={reviewProvider}
                review={review}
                onRefresh={preview}
                onApply={apply}
                applying={state === 'applying'}
                interactionDisabled={state === 'previewing' || state === 'cancelling'}
                requireAllPlannedArchivesAccepted={reviewProvider === 'planning_center'}
              />
              <button
                type="button"
                onClick={() => void cancelReview()}
                disabled={state === 'applying' || state === 'cancelling'}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel authority change
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
