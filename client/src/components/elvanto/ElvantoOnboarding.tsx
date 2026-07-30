import React, { useReducer, useState } from 'react';
import { elvantoSyncAPI, gatheringsAPI, integrationsAPI, peopleSyncAPI } from '../../services/api';
import ElvantoBatchEditor, { type ElvantoGatheringOption } from './ElvantoBatchEditor';
import SyncReview from '../peopleSync/SyncReview';
import type { PeopleSyncBatch, PeopleSyncReview, PeopleSyncSelections } from '../peopleSync/types';

export type ElvantoOnboardingStep = 'elvanto-connect' | 'elvanto-batch' | 'elvanto-review' | 'elvanto-authority';

interface Props {
  step: ElvantoOnboardingStep;
  onStepChange: (step: ElvantoOnboardingStep) => void;
  onContinueToGatherings: () => void;
}

interface ElvantoConnectionState { apiKey: string; connected: boolean }
type ElvantoConnectionAction = { type: 'api-key-changed'; value: string } | { type: 'connected' };

export function reduceElvantoConnection(state: ElvantoConnectionState, action: ElvantoConnectionAction): ElvantoConnectionState {
  if (action.type === 'api-key-changed') return { ...state, apiKey: action.value };
  return { apiKey: '', connected: true };
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const responseMessage = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
    if (responseMessage) return responseMessage;
  }
  return error instanceof Error ? error.message : fallback;
}

export default function ElvantoOnboarding({ step, onStepChange, onContinueToGatherings }: Props) {
  const [{ apiKey, connected }, dispatchConnection] = useReducer(reduceElvantoConnection, { apiKey: '', connected: false });
  const [gatherings, setGatherings] = useState<ElvantoGatheringOption[]>([]);
  const [batch, setBatch] = useState<PeopleSyncBatch | null>(null);
  const [batchReview, setBatchReview] = useState<PeopleSyncReview | null>(null);
  const [authorityReview, setAuthorityReview] = useState<PeopleSyncReview | null>(null);
  const [authorityStarted, setAuthorityStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      const gatheringsResponse = await gatheringsAPI.getAll();
      setGatherings((gatheringsResponse.data.gatherings || []).map((item: { id: number; name: string }) => ({ id: item.id, name: item.name })));
      onStepChange('elvanto-batch');
    } catch {
      setError('Elvanto is unavailable right now. Your connection was saved; retry when the provider is available.');
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError('Enter an Elvanto API key.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await integrationsAPI.connectElvanto(key);
      dispatchConnection({ type: 'connected' });
      await loadSetup();
    } catch (cause) {
      setError(errorMessage(cause, 'Failed to connect to Elvanto.'));
      setBusy(false);
    }
  };

  const loadBatchReview = async (savedBatch: PeopleSyncBatch) => {
    setBusy(true);
    setError(null);
    try {
      const response = await elvantoSyncAPI.getBatchPlan(savedBatch.id);
      setBatchReview(response.data);
    } catch (cause) {
      setError(errorMessage(cause, 'Failed to prepare the Elvanto sync review.'));
    } finally {
      setBusy(false);
    }
  };

  const saveBatch = (savedBatch: PeopleSyncBatch) => {
    if (!savedBatch.draftSource || !savedBatch.needsSourceReview) {
      setError('Elvanto did not create a reviewable people source draft. Please try again.');
      return;
    }
    setBatch(savedBatch);
    setBatchReview(null);
    onStepChange('elvanto-review');
    void loadBatchReview(savedBatch);
  };

  const applyBatch = async (reviewToken: string, selections: PeopleSyncSelections) => {
    if (!batch) return;
    setBusy(true);
    setError(null);
    try {
      await elvantoSyncAPI.applyBatch(batch.id, { reviewToken, selections });
      const refreshed = await elvantoSyncAPI.listBatches();
      const promoted = refreshed.data.batches.find((candidate) => candidate.id === batch.id);
      const expectedSource = batch.draftSource ?? batch.source;
      if (!promoted || promoted.draftSource || !promoted.source || !expectedSource
        || promoted.source.kind !== expectedSource.kind || promoted.source.externalId !== expectedSource.externalId) {
        setError('Elvanto applied the review, but the promoted people source could not be confirmed. Refresh and try again.');
        return;
      }
      setBatch(promoted);
      onStepChange('elvanto-authority');
    } catch (cause) {
      setError(errorMessage(cause, 'Failed to apply the Elvanto source review.'));
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const previewAuthority = async () => {
    setAuthorityStarted(true);
    setBusy(true);
    setError(null);
    try {
      const response = await peopleSyncAPI.previewAuthority('elvanto');
      setAuthorityReview(response.data);
    } catch (cause) {
      setError(errorMessage(cause, 'Failed to prepare the Elvanto authority review.'));
    } finally {
      setBusy(false);
    }
  };

  const applyAuthority = async (reviewToken: string, selections: PeopleSyncSelections) => {
    setBusy(true);
    try {
      await peopleSyncAPI.applyAuthority('elvanto', reviewToken, selections);
      onContinueToGatherings();
    } finally {
      setBusy(false);
    }
  };

  if (step === 'elvanto-connect') {
    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Connect Elvanto</h2>
          <p className="mt-1 text-sm text-gray-600">Connect securely, then choose and review the people you want to bring into LMPG.</p>
        </div>
        {!connected ? <>
          <label htmlFor="onboarding-elvanto-api-key" className="block text-sm font-medium text-gray-700">
            Elvanto API key
            <input
              id="onboarding-elvanto-api-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => dispatchConnection({ type: 'api-key-changed', value: event.target.value })}
              className="mt-1 block w-full rounded-md border-gray-300"
            />
          </label>
          <p className="text-xs text-gray-500">The key is encrypted after validation and is never displayed again.</p>
        </> : <p className="text-sm text-green-700">Elvanto connected. Loading available people sources…</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex flex-wrap gap-3">
          {!connected ? (
            <button type="button" onClick={() => void connect()} disabled={busy || !apiKey.trim()} className="rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? 'Connecting…' : 'Connect Elvanto'}
            </button>
          ) : (
            <button type="button" onClick={() => void loadSetup()} disabled={busy} className="rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? 'Loading…' : 'Retry loading Elvanto'}
            </button>
          )}
          <button type="button" onClick={onContinueToGatherings} disabled={busy} className="text-sm underline">Skip Elvanto</button>
        </div>
      </section>
    );
  }

  if (step === 'elvanto-batch') {
    return (
      <section className="space-y-4">
        <p className="text-sm text-gray-700">Choose one Elvanto Category or Group, then optionally assign those people to a gathering.</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <ElvantoBatchEditor batch={null} gatherings={gatherings} onSaved={saveBatch} onCancel={onContinueToGatherings} />
      </section>
    );
  }

  if (step === 'elvanto-review') {
    return (
      <section className="space-y-4">
        <p className="text-sm text-gray-700">Review every match and change before importing. Applying this review promotes the selected people source before you continue.</p>
        {busy && <p className="text-sm text-gray-500">Preparing review…</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {batchReview && (
          <div role="region" aria-label="Elvanto onboarding batch sync review" className="rounded-lg border border-gray-200 bg-gray-50/50 p-4 dark:border-gray-700 dark:bg-gray-900/20">
            <SyncReview provider="elvanto" review={batchReview} onRefresh={() => batch ? loadBatchReview(batch) : undefined} onApply={applyBatch} applying={busy} />
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {error && batch && <button type="button" onClick={() => void loadBatchReview(batch)} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500">Refresh review</button>}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {!authorityStarted ? <>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Keep LMPG aligned with Elvanto?</h2>
          <p className="mt-1 text-sm text-gray-600">If enabled, linked names, child status, family membership and active status are managed in Elvanto.</p>
        </div>
        <div className="flex flex-col gap-3">
          <button type="button" onClick={() => void previewAuthority()} className="rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white">Use Elvanto as source of truth</button>
          <button type="button" onClick={onContinueToGatherings} className="text-sm underline">Not now</button>
        </div>
      </> : <>
        {busy && <p className="text-sm text-gray-500">Preparing authority review…</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {authorityReview && (
          <div role="region" aria-label="Elvanto onboarding authority review" className="rounded-lg border border-gray-200 bg-gray-50/50 p-4 dark:border-gray-700 dark:bg-gray-900/20">
            <SyncReview provider="elvanto" review={authorityReview} onRefresh={previewAuthority} onApply={applyAuthority} applying={busy} />
          </div>
        )}
        {error && <button type="button" onClick={() => void previewAuthority()} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500">Refresh authority review</button>}
      </>}
    </section>
  );
}
