import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../Modal';
import SyncReview from '../peopleSync/SyncReview';
import type { PeopleSyncApplyResult, PeopleSyncSelections, ProviderSource, SyncProvider } from '../peopleSync/types';
import { peopleImportAPI } from '../../services/api';
import type { ImportSelection, PeopleImportReview } from './types';

type ImportState = 'provider' | 'sources' | 'previewing' | 'review' | 'applying' | 'applied';

interface PeopleImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onApplied: (result: PeopleSyncApplyResult) => void | Promise<void>;
}

const secondaryButtonClass = 'rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';
const primaryButtonClass = 'rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50';

function displayError(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const data = response.data;
      if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') return data.error;
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function selectionFor(source: ProviderSource): ImportSelection {
  return { kind: source.kind, externalId: source.externalId };
}

function sourceType(source: ProviderSource): string {
  if (source.kind === 'planning_center_list') return 'List';
  return source.kind === 'elvanto_category' ? 'Category' : 'Group';
}

export default function PeopleImportDialog({ isOpen, onClose, onApplied }: PeopleImportDialogProps) {
  const [state, setState] = useState<ImportState>('provider');
  const [provider, setProvider] = useState<SyncProvider | null>(null);
  const [sources, setSources] = useState<ProviderSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [allOption, setAllOption] = useState<{ kind: 'all'; name: 'Everyone' }>({ kind: 'all', name: 'Everyone' });
  const [selection, setSelection] = useState<ImportSelection | null>(null);
  const [review, setReview] = useState<PeopleImportReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PeopleSyncApplyResult | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const applyInFlightRef = useRef(false);

  const nextGeneration = () => {
    generationRef.current += 1;
    return generationRef.current;
  };

  const reset = useCallback(() => {
    nextGeneration();
    applyInFlightRef.current = false;
    setState('provider');
    setProvider(null);
    setSources([]);
    setLoadingSources(false);
    setSelection(null);
    setReview(null);
    setError(null);
    setResult(null);
    setRefreshError(null);
  }, []);

  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen, reset]);

  const loadSources = useCallback(async (nextProvider: SyncProvider) => {
    const generation = nextGeneration();
    setProvider(nextProvider);
    setSources([]);
    setLoadingSources(true);
    setSelection(null);
    setReview(null);
    setError(null);
    setRefreshError(null);
    setState('sources');
    try {
      const response = await peopleImportAPI.listSources(nextProvider);
      if (generation !== generationRef.current) return;
      setSources(response.data.sources);
      setAllOption(response.data.allOption);
      setLoadingSources(false);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(displayError(cause, 'Could not load people sources.'));
      setLoadingSources(false);
    }
  }, []);

  const preview = useCallback(async () => {
    if (!provider || !selection) return;
    const generation = nextGeneration();
    setError(null);
    setRefreshError(null);
    setState('previewing');
    try {
      const response = await peopleImportAPI.preview(provider, selection);
      if (generation !== generationRef.current) return;
      setReview(response.data);
      setState('review');
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(displayError(cause, 'Could not prepare this import review.'));
      setState('sources');
    }
  }, [provider, selection]);

  const apply = useCallback(async (reviewToken: PeopleImportReview['reviewToken'], selections: PeopleSyncSelections) => {
    if (!provider || !selection || applyInFlightRef.current) return;
    const generation = nextGeneration();
    applyInFlightRef.current = true;
    setError(null);
    setState('applying');
    try {
      const response = await peopleImportAPI.apply(provider, { selection, reviewToken, selections });
      if (generation !== generationRef.current) return;
      applyInFlightRef.current = false;
      setResult(response.data);
      setState('applied');
      try {
        await onApplied(response.data);
      } catch (cause) {
        if (generation === generationRef.current) setRefreshError(displayError(cause, 'The import was applied, but the People page could not refresh.'));
      }
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setState('review');
      throw cause;
    } finally {
      if (generation === generationRef.current) applyInFlightRef.current = false;
    }
  }, [onApplied, provider, selection]);

  const close = () => {
    if (state === 'applying' || applyInFlightRef.current) return;
    reset();
    onClose();
  };

  const backToProviders = () => {
    if (state === 'applying') return;
    nextGeneration();
    setState('provider');
    setProvider(null);
    setSelection(null);
    setReview(null);
    setError(null);
    setLoadingSources(false);
  };

  return (
    <Modal isOpen={isOpen} onClose={close} className="max-w-4xl">
      <section role="dialog" aria-modal="true" aria-label="Import people" className="w-full max-w-4xl rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Import people</h2>
            {state === 'review' || state === 'applying' ? <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">People import review</p> : null}
          </div>
          <button type="button" className={secondaryButtonClass} onClick={close} disabled={state === 'applying'}>Close</button>
        </header>

        {state === 'provider' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-200">Choose the provider to import people from.</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={primaryButtonClass} onClick={() => void loadSources('planning_center')}>Planning Center</button>
              <button type="button" className={primaryButtonClass} onClick={() => void loadSources('elvanto')}>Elvanto</button>
            </div>
          </div>
        )}

        {state === 'sources' && provider && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3"><p className="text-sm text-gray-700 dark:text-gray-200">Choose who to import from {provider === 'planning_center' ? 'Planning Center' : 'Elvanto'}</p><button type="button" className={secondaryButtonClass} onClick={backToProviders}>Back</button></div>
            {loadingSources && !error ? <p role="status" className="text-sm text-gray-500">Loading people sources…</p> : null}
            {error ? <div role="alert" className="space-y-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"><p>{error}</p><button type="button" className={secondaryButtonClass} onClick={() => void loadSources(provider)}>Try again</button></div> : null}
            {!loadingSources && !error && (
              <fieldset className="space-y-2">
                <legend className="sr-only">People source</legend>
                <label className="flex cursor-pointer items-center gap-3 rounded border border-gray-200 p-3 dark:border-gray-700"><input type="radio" aria-label={allOption.name} name="people-import-source" checked={selection?.kind === 'all'} onChange={() => setSelection({ kind: 'all' })} /><span><span className="font-medium">{allOption.name}</span><span className="ml-2 text-xs text-gray-500">All people</span></span></label>
                {sources.map((source) => {
                  const sourceSelection = selectionFor(source);
                  const checked = selection?.kind === sourceSelection.kind && selection.kind !== 'all' && selection.externalId === sourceSelection.externalId;
                  return <label key={`${source.kind}:${source.externalId}`} className="flex cursor-pointer items-center gap-3 rounded border border-gray-200 p-3 dark:border-gray-700"><input type="radio" name="people-import-source" checked={checked} onChange={() => setSelection(sourceSelection)} /><span><span className="font-medium">{source.name}</span><span className="ml-2 text-xs text-gray-500">{sourceType(source)}{source.memberCount === null ? '' : ` · ${source.memberCount} people`}</span></span></label>;
                })}
              </fieldset>
            )}
            <button type="button" className={primaryButtonClass} disabled={!selection || !!error} onClick={() => void preview()}>Review import</button>
          </div>
        )}

        {state === 'previewing' && <p role="status" className="text-sm text-gray-500">Preparing import review…</p>}

        {(state === 'review' || state === 'applying') && review && provider && (
          <SyncReview operationKind="people_import" provider={provider} review={review} onRefresh={() => preview()} onApply={apply} applying={state === 'applying'} interactionDisabled={state === 'applying'} />
        )}

        {state === 'applied' && result && (
          <div className="space-y-3">
            <p role="status" className="font-medium text-green-700 dark:text-green-300">Import applied.</p>
            <p className="text-sm text-gray-600 dark:text-gray-300">The selected people have been imported.</p>
            {refreshError && <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">{refreshError}</p>}
          </div>
        )}
      </section>
    </Modal>
  );
}
