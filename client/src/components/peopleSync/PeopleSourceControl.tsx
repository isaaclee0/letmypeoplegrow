import React, { useEffect, useRef, useState } from 'react';
import { peopleSyncAPI } from '../../services/api';
import Modal from '../Modal';
import SyncReview from './SyncReview';
import { peopleSyncErrorMessage, toPeopleSyncDisplayError } from './apiError';
import type {
  PeopleSyncReview,
  PeopleSyncSelections,
  PeopleSyncSettings,
  SyncProvider,
} from './types';

type SourceControlState =
  | 'idle'
  | 'previewing'
  | 'reviewing'
  | 'applying'
  | 'cancelling'
  | 'apply_refresh_pending'
  | 'refreshing_after_apply'
  | 'disabling'
  | 'error';

export interface PeopleSourceControlProps {
  provider: SyncProvider;
  hasEnabledBatch: boolean;
  settings: PeopleSyncSettings;
  connections: Record<SyncProvider, boolean>;
  onRefresh: () => void | Promise<void>;
}

const providerName = (provider: SyncProvider) =>
  provider === 'planning_center' ? 'Planning Center' : 'Elvanto';

export default function PeopleSourceControl({
  provider,
  hasEnabledBatch,
  settings,
  connections,
  onRefresh,
}: PeopleSourceControlProps) {
  const [state, setState] = useState<SourceControlState>('idle');
  const [pendingProvider, setPendingProvider] = useState<SyncProvider | null>(null);
  const [pendingReview, setPendingReview] = useState<PeopleSyncReview | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disableMutationSucceeded, setDisableMutationSucceeded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const switchDialogRef = useRef<HTMLDivElement>(null);
  const disableDialogRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLParagraphElement>(null);
  const reviewRegionRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const previewGenerationRef = useRef(0);
  const activeReviewTokenRef = useRef<string | null>(null);
  const ownedAuthorityPreviewRef = useRef<{
    provider: SyncProvider;
    authorityPreviewId: string;
  } | null>(null);
  const dialogWasOpen = useRef(false);
  const restoreSwitchOnDialogClose = useRef(true);
  const continueFocusPending = useRef(false);

  useEffect(() => () => {
    previewGenerationRef.current += 1;
    activeReviewTokenRef.current = null;
    const ownedPreview = ownedAuthorityPreviewRef.current;
    ownedAuthorityPreviewRef.current = null;
    if (ownedPreview) {
      void Promise.resolve(peopleSyncAPI.cancelAuthorityPreview(
        ownedPreview.provider,
        ownedPreview.authorityPreviewId,
      )).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const dialogOpen = confirmSwitch || confirmDisable;
    if (dialogOpen) {
      const dialog = confirmSwitch ? switchDialogRef.current : disableDialogRef.current;
      dialog?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )?.focus();
    } else if (dialogWasOpen.current) {
      if (restoreSwitchOnDialogClose.current) {
        toggleRef.current?.focus();
      }
      restoreSwitchOnDialogClose.current = true;
    }
    dialogWasOpen.current = dialogOpen;
  }, [confirmSwitch, confirmDisable]);

  useEffect(() => {
    if (!continueFocusPending.current || confirmSwitch) return;
    const target = state === 'previewing'
      ? progressRef.current
      : pendingReview
        ? reviewRegionRef.current
        : state === 'error'
          ? errorRef.current
          : null;
    target?.focus();
    if (state !== 'previewing') {
      continueFocusPending.current = false;
    }
  }, [confirmSwitch, pendingReview, state]);

  useEffect(() => {
    if (settings.authorityProvider !== provider && disableMutationSucceeded) {
      setDisableMutationSucceeded(false);
      setError(null);
    }
  }, [disableMutationSucceeded, provider, settings.authorityProvider]);

  useEffect(() => {
    const awaitingApplyRefresh = state === 'apply_refresh_pending' || state === 'refreshing_after_apply';
    if (awaitingApplyRefresh && pendingProvider && settings.authorityProvider === pendingProvider) {
      previewGenerationRef.current += 1;
      activeReviewTokenRef.current = null;
      ownedAuthorityPreviewRef.current = null;
      setPendingReview(null);
      setPendingProvider(null);
      setError(null);
      setState('idle');
    }
  }, [pendingProvider, settings.authorityProvider, state]);

  const discardSupersededPreview = (discardedProvider: SyncProvider, discardedReview: PeopleSyncReview) => {
    if (!discardedReview.authorityPreviewId) return;
    if (ownedAuthorityPreviewRef.current?.provider === discardedProvider
      && ownedAuthorityPreviewRef.current.authorityPreviewId === discardedReview.authorityPreviewId) {
      ownedAuthorityPreviewRef.current = null;
    }
    void Promise.resolve(peopleSyncAPI.cancelAuthorityPreview(
      discardedProvider,
      discardedReview.authorityPreviewId,
    )).catch(() => undefined);
  };

  const preview = async (nextProvider: SyncProvider) => {
    if (!connections[nextProvider] || !hasEnabledBatch || nextProvider === settings.authorityProvider) return;
    const generation = ++previewGenerationRef.current;
    const previousReview = pendingReview;
    activeReviewTokenRef.current = null;
    setState('previewing');
    setError(null);
    setPendingProvider(nextProvider);
    try {
      const response = await peopleSyncAPI.previewAuthority(nextProvider);
      if (generation !== previewGenerationRef.current) {
        discardSupersededPreview(nextProvider, response.data);
        return;
      }
      activeReviewTokenRef.current = response.data.reviewToken;
      ownedAuthorityPreviewRef.current = response.data.authorityPreviewId
        ? { provider: nextProvider, authorityPreviewId: response.data.authorityPreviewId }
        : null;
      setPendingReview(response.data);
      setState('reviewing');
    } catch (cause) {
      if (generation !== previewGenerationRef.current) return;
      setError(peopleSyncErrorMessage(cause, 'Failed to preview the authority change.'));
      if (previousReview) {
        // A refresh may already have replaced the previous server-side
        // intent before failing. Fail closed: retire that old exact intent
        // if it still exists, and never re-enable its now-uncertain token.
        discardSupersededPreview(nextProvider, previousReview);
        setPendingReview(null);
        setPendingProvider(null);
        setState('error');
      } else {
        setState('error');
      }
    }
  };

  const refreshAfterApply = async () => {
    setState('refreshing_after_apply');
    setError(null);
    try {
      await onRefresh();
    } catch (refreshCause) {
      const detail = peopleSyncErrorMessage(refreshCause, 'Refresh failed.');
      setError(`The authority change was applied, but its status could not be refreshed: ${detail}`);
      setState('apply_refresh_pending');
      return;
    }
    activeReviewTokenRef.current = null;
    setPendingReview(null);
    setPendingProvider(null);
    setState('idle');
  };

  const apply = async (reviewToken: string, selections: PeopleSyncSelections) => {
    if (!pendingProvider || activeReviewTokenRef.current !== reviewToken) return;
    const generation = ++previewGenerationRef.current;
    activeReviewTokenRef.current = null;
    setState('applying');
    setError(null);
    try {
      await peopleSyncAPI.applyAuthority(pendingProvider, reviewToken, selections);
    } catch (cause) {
      if (generation === previewGenerationRef.current) {
        activeReviewTokenRef.current = reviewToken;
        setState('reviewing');
      }
      throw toPeopleSyncDisplayError(cause, 'Failed to apply the authority change.');
    }
    if (generation !== previewGenerationRef.current) return;
    ownedAuthorityPreviewRef.current = null;
    await refreshAfterApply();
  };

  const refreshPreview = async () => {
    if (pendingProvider) await preview(pendingProvider);
  };

  const refreshAfterDisable = async () => {
    setState('disabling');
    setError(null);
    try {
      await onRefresh();
      setConfirmDisable(false);
      setDisableMutationSucceeded(false);
      setState('idle');
    } catch (cause) {
      const detail = peopleSyncErrorMessage(cause, 'Refresh failed.');
      setError(`The people source was disabled, but its status could not be refreshed: ${detail}`);
      setState('error');
    }
  };

  const disable = async () => {
    setState('disabling');
    setError(null);
    try {
      await peopleSyncAPI.disableAuthority();
    } catch (cause) {
      setError(peopleSyncErrorMessage(cause, 'Failed to disable the people source.'));
      setState('error');
      return;
    }
    setDisableMutationSucceeded(true);
    await refreshAfterDisable();
  };

  const clearReview = () => {
    activeReviewTokenRef.current = null;
    ownedAuthorityPreviewRef.current = null;
    setPendingProvider(null);
    setPendingReview(null);
    setError(null);
    setState('idle');
  };

  const cancelReview = async () => {
    if (!pendingProvider || !pendingReview || state === 'previewing' || state === 'applying' || state === 'cancelling') return;
    const providerToCancel = pendingProvider;
    const reviewToCancel = pendingReview;
    const generation = ++previewGenerationRef.current;
    activeReviewTokenRef.current = null;
    setError(null);

    if (!reviewToCancel.authorityPreviewId) {
      clearReview();
      return;
    }

    const ownedPreview = ownedAuthorityPreviewRef.current;
    if (ownedPreview?.provider === providerToCancel
      && ownedPreview.authorityPreviewId === reviewToCancel.authorityPreviewId) {
      ownedAuthorityPreviewRef.current = null;
    }
    setState('cancelling');
    try {
      await peopleSyncAPI.cancelAuthorityPreview(providerToCancel, reviewToCancel.authorityPreviewId);
    } catch (cause) {
      if (generation !== previewGenerationRef.current) return;
      activeReviewTokenRef.current = reviewToCancel.reviewToken;
      ownedAuthorityPreviewRef.current = ownedPreview;
      setError(peopleSyncErrorMessage(cause, 'Failed to cancel the authority change.'));
      setState('reviewing');
      return;
    }
    if (generation === previewGenerationRef.current) clearReview();
  };

  const summary = pendingReview?.summary;
  const linked = summary?.linkPeople || 0;
  const locked = linked
    + (summary?.updateManagedFields || 0)
    + (summary?.reactivate || 0)
    + (summary?.archive || 0);
  const checked = settings.authorityProvider === provider;
  const applyRefreshPending = state === 'apply_refresh_pending' || state === 'refreshing_after_apply';
  const busy = state === 'previewing'
    || state === 'reviewing'
    || state === 'applying'
    || state === 'cancelling'
    || state === 'disabling'
    || pendingReview !== null;
  const prerequisite = checked
    ? null
    : !connections[provider]
      ? `Connect ${providerName(provider)} before using it as your people source.`
      : !hasEnabledBatch
        ? provider === 'planning_center'
          ? 'Create a Planning Center sync batch first.'
          : 'Create and enable an Elvanto sync batch first.'
        : null;
  const toggleDisabled = busy || prerequisite !== null;
  const otherProvider = settings.authorityProvider !== 'none' && settings.authorityProvider !== provider
    ? settings.authorityProvider
    : null;

  const toggle = () => {
    if (checked) {
      setConfirmDisable(true);
    } else if (otherProvider) {
      setConfirmSwitch(true);
    } else {
      void preview(provider);
    }
  };

  const closeSwitchDialog = () => {
    if (state !== 'previewing' && state !== 'applying' && state !== 'disabling') {
      setConfirmSwitch(false);
    }
  };

  const closeDisableDialog = () => {
    if (state !== 'previewing' && state !== 'applying' && state !== 'disabling') {
      setConfirmDisable(false);
    }
  };

  const handleDialogKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    close: () => void,
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (controls.length === 0) {
      event.preventDefault();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Use {providerName(provider)} as source of truth
          </h5>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Enabling this first creates a review. Nothing changes until you apply that review.
          </p>
        </div>
        <button
          ref={toggleRef}
          type="button"
          role="switch"
          aria-label={`Use ${providerName(provider)} as source of truth`}
          aria-checked={checked}
          disabled={toggleDisabled}
          onClick={toggle}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
        >
          <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
      </div>
      {prerequisite && <p className="text-xs text-gray-500">{prerequisite}</p>}

      {state === 'previewing' && (
        <p ref={progressRef} role="status" tabIndex={-1} className="text-sm text-gray-600">
          Preparing authority review…
        </p>
      )}
      {error && !confirmDisable && !applyRefreshPending && <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-red-600">{error}</p>}
      {pendingReview && pendingProvider && (
        <div
          ref={reviewRegionRef}
          role="region"
          aria-label={`${providerName(pendingProvider)} authority review`}
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
                provider={pendingProvider}
                review={pendingReview}
                onRefresh={refreshPreview}
                onApply={apply}
                applying={state === 'applying'}
                interactionDisabled={state === 'previewing' || state === 'cancelling'}
                requireAllPlannedArchivesAccepted={pendingProvider === 'planning_center'}
              />
              <button type="button" onClick={() => void cancelReview()} disabled={state === 'previewing' || state === 'applying' || state === 'cancelling'} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
                Cancel authority change
              </button>
            </>
          )}
        </div>
      )}

      <Modal isOpen={confirmSwitch} onClose={closeSwitchDialog}>
        <div
          ref={switchDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="people-source-switch-title"
          onKeyDown={(event) => handleDialogKeyDown(event, closeSwitchDialog)}
          className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800"
        >
          <h6 id="people-source-switch-title" className="font-medium text-gray-900 dark:text-gray-100">
            Switch source of truth from {otherProvider ? providerName(otherProvider) : ''} to {providerName(provider)}?
          </h6>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            The new provider controls linked names, child status, family membership, people type, archive/reactivation, and scheduled people reconciliation. {otherProvider ? providerName(otherProvider) : 'The old provider'} stays connected.
          </p>
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={() => {
                restoreSwitchOnDialogClose.current = false;
                continueFocusPending.current = true;
                setConfirmSwitch(false);
                void preview(provider);
              }}
              className="rounded bg-green-600 px-3 py-2 text-sm text-white"
            >
              Continue to review
            </button>
            <button type="button" onClick={closeSwitchDialog} className="text-sm underline">
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={confirmDisable}
        onClose={closeDisableDialog}
      >
        <div
          ref={disableDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="people-source-disable-title"
          onKeyDown={(event) => handleDialogKeyDown(event, closeDisableDialog)}
          className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800"
        >
          <h6 id="people-source-disable-title" className="font-medium text-gray-900 dark:text-gray-100">
            Stop using a people source of truth?
          </h6>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Linked people will become editable in LMPG. Existing links are retained.</p>
          {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={() => void (disableMutationSucceeded ? refreshAfterDisable() : disable())}
              disabled={state === 'disabling'}
              className="rounded bg-red-600 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {state === 'disabling'
                ? disableMutationSucceeded ? 'Refreshing…' : 'Disabling…'
                : disableMutationSucceeded ? 'Retry status refresh' : 'Use no people source'}
            </button>
            <button type="button" onClick={closeDisableDialog} disabled={state === 'disabling'} className="text-sm underline disabled:opacity-50">Cancel</button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
