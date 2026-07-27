import React, { useState } from 'react';
import { peopleSyncAPI } from '../../services/api';
import SyncReview from './SyncReview';
import type {
  PeopleSyncReview,
  PeopleSyncSelections,
  PeopleSyncSettings,
  SyncProvider,
} from './types';

type SourceControlState = 'idle' | 'previewing' | 'reviewing' | 'applying' | 'disabling' | 'error';

export interface PeopleSourceControlProps {
  settings: PeopleSyncSettings;
  connections: Record<SyncProvider, boolean>;
  onRefresh: () => void | Promise<void>;
}

const providerName = (provider: SyncProvider) =>
  provider === 'planning_center' ? 'Planning Center' : 'Elvanto';

export default function PeopleSourceControl({ settings, connections, onRefresh }: PeopleSourceControlProps) {
  const [state, setState] = useState<SourceControlState>('idle');
  const [pendingProvider, setPendingProvider] = useState<SyncProvider | null>(null);
  const [pendingReview, setPendingReview] = useState<PeopleSyncReview | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partialSuccess, setPartialSuccess] = useState<string | null>(null);

  const preview = async (nextProvider: SyncProvider) => {
    if (!connections[nextProvider] || nextProvider === settings.authorityProvider) return;
    setState('previewing');
    setError(null);
    setPendingProvider(nextProvider);
    try {
      const response = await peopleSyncAPI.previewAuthority(nextProvider);
      setPendingReview(response.data);
      setState('reviewing');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to preview the authority change.');
      setState('error');
    }
  };

  const apply = async (reviewToken: string, selections: PeopleSyncSelections) => {
    if (!pendingProvider) return;
    setState('applying');
    setError(null);
    setPartialSuccess(null);
    try {
      const response = await peopleSyncAPI.applyAuthority(pendingProvider, reviewToken, selections);
      if (response.data.authorityCommitError) {
        setPartialSuccess(response.data.authorityCommitError);
        setState('error');
        try {
          await onRefresh();
        } catch (refreshCause) {
          const detail = refreshCause instanceof Error ? refreshCause.message : 'Refresh failed.';
          setError(`Could not refresh authoritative source status: ${detail}`);
        }
        return;
      }
      await onRefresh();
      setPendingReview(null);
      setPendingProvider(null);
      setState('idle');
    } catch (cause) {
      setState('reviewing');
      throw cause;
    }
  };

  const refreshPreview = async () => {
    if (pendingProvider) await preview(pendingProvider);
  };

  const disable = async () => {
    setState('disabling');
    setError(null);
    try {
      await peopleSyncAPI.disableAuthority();
      await onRefresh();
      setConfirmDisable(false);
      setState('idle');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to disable the people source.');
      setState('error');
    }
  };

  const cancelReview = () => {
    setPendingProvider(null);
    setPendingReview(null);
    setError(null);
    setPartialSuccess(null);
    setState('idle');
  };

  const summary = pendingReview?.summary;
  const linked = summary?.linkPeople || 0;
  const locked = linked
    + (summary?.updateManagedFields || 0)
    + (summary?.reactivate || 0)
    + (summary?.archive || 0);

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div>
        <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">Authoritative people source</h5>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Choosing a provider first creates a review. Nothing changes until you apply that review.
        </p>
      </div>
      <fieldset className="space-y-2" disabled={state === 'previewing' || state === 'applying' || state === 'disabling'}>
        <legend className="sr-only">People source of truth</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="people-source"
            checked={settings.authorityProvider === 'none'}
            onChange={() => setConfirmDisable(true)}
          />
          None
        </label>
        {(['planning_center', 'elvanto'] as const).map((provider) => (
          <div key={provider}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="people-source"
                checked={settings.authorityProvider === provider}
                disabled={!connections[provider]}
                onChange={() => void preview(provider)}
              />
              {providerName(provider)}
            </label>
            {!connections[provider] && (
              <p className="ml-6 text-xs text-gray-500">
                Connect {providerName(provider)} before selecting it as your people source.
              </p>
            )}
          </div>
        ))}
      </fieldset>

      {state === 'previewing' && <p className="text-sm text-gray-600">Preparing authority review…</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {partialSuccess && (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p>{partialSuccess}</p>
          <p className="mt-1">The reviewed people changes were applied, but the authoritative source did not change. Refresh the plan before trying again.</p>
        </div>
      )}

      {pendingReview && pendingProvider && (
        <div className="space-y-4 border-t border-gray-200 pt-4 dark:border-gray-700">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-blue-50 px-2 py-1 text-blue-800">Coverage: {linked} linked</span>
            <span className="rounded bg-blue-50 px-2 py-1 text-blue-800">{locked} locked after apply</span>
            <span className="rounded bg-gray-100 px-2 py-1">{summary?.addPeople || 0} adds</span>
            <span className="rounded bg-gray-100 px-2 py-1">{summary?.updateManagedFields || 0} updates</span>
            <span className="rounded bg-gray-100 px-2 py-1">{summary?.reactivate || 0} restore{summary?.reactivate === 1 ? '' : 's'}</span>
            <span className="rounded bg-gray-100 px-2 py-1">{summary?.archive || 0} archives</span>
          </div>
          <SyncReview
            provider={pendingProvider}
            review={pendingReview}
            onRefresh={refreshPreview}
            onApply={apply}
            applying={state === 'applying'}
          />
          <button type="button" onClick={cancelReview} disabled={state === 'applying'} className="text-sm underline">
            Cancel authority change
          </button>
        </div>
      )}

      {confirmDisable && (
        <div role="dialog" aria-modal="true" className="rounded-md border border-amber-300 bg-amber-50 p-4">
          <h6 className="font-medium text-amber-900">Stop using a people source of truth?</h6>
          <p className="mt-1 text-sm text-amber-800">Linked people will become editable in LMPG. Existing links are retained.</p>
          <div className="mt-3 flex gap-3">
            <button type="button" onClick={() => void disable()} disabled={state === 'disabling'} className="rounded bg-red-600 px-3 py-2 text-sm text-white">
              {state === 'disabling' ? 'Disabling…' : 'Use no people source'}
            </button>
            <button type="button" onClick={() => setConfirmDisable(false)} className="text-sm underline">Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
