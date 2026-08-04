import React, { useEffect, useRef, useState } from 'react';
import { peopleSyncAPI } from '../../services/api';
import Modal from '../Modal';
import AuthorityReviewWorkspace from './AuthorityReviewWorkspace';
import { peopleSyncErrorMessage } from './apiError';
import type { PeopleSyncSettings, SyncProvider } from './types';

type DisableState = 'idle' | 'disabling' | 'error';

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
  const [disableState, setDisableState] = useState<DisableState>('idle');
  const [reviewActive, setReviewActive] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);
  const [disableMutationSucceeded, setDisableMutationSucceeded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const switchDialogRef = useRef<HTMLDivElement>(null);
  const disableDialogRef = useRef<HTMLDivElement>(null);
  const dialogWasOpen = useRef(false);
  const restoreSwitchOnDialogClose = useRef(true);

  useEffect(() => {
    const dialogOpen = confirmSwitch || confirmDisable;
    if (dialogOpen) {
      const dialog = confirmSwitch ? switchDialogRef.current : disableDialogRef.current;
      dialog?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )?.focus();
    } else if (dialogWasOpen.current) {
      if (restoreSwitchOnDialogClose.current) toggleRef.current?.focus();
      restoreSwitchOnDialogClose.current = true;
    }
    dialogWasOpen.current = dialogOpen;
  }, [confirmSwitch, confirmDisable]);

  useEffect(() => {
    if (settings.authorityProvider !== provider && disableMutationSucceeded) {
      setDisableMutationSucceeded(false);
      setDisableError(null);
    }
  }, [disableMutationSucceeded, provider, settings.authorityProvider]);

  useEffect(() => {
    if (reviewActive && settings.authorityProvider === provider) setReviewActive(false);
  }, [provider, reviewActive, settings.authorityProvider]);

  const refreshAfterDisable = async () => {
    setDisableState('disabling');
    setDisableError(null);
    try {
      await onRefresh();
      setConfirmDisable(false);
      setDisableMutationSucceeded(false);
      setDisableState('idle');
    } catch (cause) {
      const detail = peopleSyncErrorMessage(cause, 'Refresh failed.');
      setDisableError(`The people source was disabled, but its status could not be refreshed: ${detail}`);
      setDisableState('error');
    }
  };

  const disable = async () => {
    setDisableState('disabling');
    setDisableError(null);
    try {
      await peopleSyncAPI.disableAuthority();
    } catch (cause) {
      setDisableError(peopleSyncErrorMessage(cause, 'Failed to disable the people source.'));
      setDisableState('error');
      return;
    }
    setDisableMutationSucceeded(true);
    await refreshAfterDisable();
  };

  const checked = settings.authorityProvider === provider;
  const prerequisite = checked
    ? null
    : !connections[provider]
      ? `Connect ${providerName(provider)} before using it as your people source.`
      : !hasEnabledBatch
        ? provider === 'planning_center'
          ? 'Create a Planning Center sync batch first.'
          : 'Create and enable an Elvanto sync batch first.'
        : null;
  const toggleDisabled = reviewActive || disableState === 'disabling' || prerequisite !== null;
  const otherProvider = settings.authorityProvider !== 'none' && settings.authorityProvider !== provider
    ? settings.authorityProvider
    : null;

  const toggle = () => {
    if (checked) {
      setConfirmDisable(true);
    } else if (otherProvider) {
      setConfirmSwitch(true);
    } else {
      setReviewActive(true);
    }
  };

  const closeSwitchDialog = () => setConfirmSwitch(false);

  const closeDisableDialog = () => {
    if (disableState !== 'disabling') setConfirmDisable(false);
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

      {reviewActive && (
        <AuthorityReviewWorkspace
          provider={provider}
          autoStart
          onApplied={async () => {
            await onRefresh();
            setReviewActive(false);
          }}
          onCancel={() => setReviewActive(false)}
        />
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
            Linked people and families become managed by {providerName(provider)}. Local edits and lifecycle actions are restricted, and {providerName(provider)} schedules may run. {otherProvider ? providerName(otherProvider) : 'The other provider'} remains connected, but its batches become inactive.
          </p>
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={() => {
                restoreSwitchOnDialogClose.current = false;
                setConfirmSwitch(false);
                setReviewActive(true);
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

      <Modal isOpen={confirmDisable} onClose={closeDisableDialog}>
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
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Linked people will become editable in LMPG. Existing links and provider connections are retained.</p>
          {disableError && <p role="alert" className="mt-3 text-sm text-red-600">{disableError}</p>}
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={() => void (disableMutationSucceeded ? refreshAfterDisable() : disable())}
              disabled={disableState === 'disabling'}
              className="rounded bg-red-600 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {disableState === 'disabling'
                ? disableMutationSucceeded ? 'Refreshing…' : 'Disabling…'
                : disableMutationSucceeded ? 'Retry status refresh' : 'Use no people source'}
            </button>
            <button type="button" onClick={closeDisableDialog} disabled={disableState === 'disabling'} className="text-sm underline disabled:opacity-50">Cancel</button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
