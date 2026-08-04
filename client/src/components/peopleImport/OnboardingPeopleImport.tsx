import React, { useCallback, useEffect, useRef, useState } from 'react';
import { peopleImportAPI } from '../../services/api';
import SyncReview from '../peopleSync/SyncReview';
import type { PeopleSyncSelections, ProviderSource, SyncProvider } from '../peopleSync/types';
import type { ImportSelection, PeopleImportReview } from './types';

type ImportState = 'sources' | 'previewing' | 'review' | 'applying' | 'applied';

interface Props {
  provider: SyncProvider;
  onComplete: () => void;
  onSkip: () => void;
}

const secondaryButtonClass = 'rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50';
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

export default function OnboardingPeopleImport({ provider, onComplete, onSkip }: Props) {
  const [state, setState] = useState<ImportState>('sources');
  const [sources, setSources] = useState<ProviderSource[]>([]);
  const [allOption, setAllOption] = useState<{ kind: 'all'; name: 'Everyone' }>({ kind: 'all', name: 'Everyone' });
  const [selection, setSelection] = useState<ImportSelection | null>(null);
  const [review, setReview] = useState<PeopleImportReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const generationRef = useRef(0);
  const applyInFlightRef = useRef(false);

  const nextGeneration = () => {
    generationRef.current += 1;
    return generationRef.current;
  };

  const loadSources = useCallback(async () => {
    const generation = nextGeneration();
    setState('sources');
    setSources([]);
    setSelection(null);
    setReview(null);
    setError(null);
    setLoadingSources(true);
    try {
      const response = await peopleImportAPI.listSources(provider);
      if (generation !== generationRef.current) return;
      setSources(response.data.sources);
      setAllOption(response.data.allOption);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(displayError(cause, 'Could not load people sources.'));
    } finally {
      if (generation === generationRef.current) setLoadingSources(false);
    }
  }, [provider]);

  useEffect(() => {
    void loadSources();
    return () => {
      generationRef.current += 1;
      applyInFlightRef.current = false;
    };
  }, [loadSources]);

  const preview = useCallback(async () => {
    if (!selection) return;
    const generation = nextGeneration();
    setError(null);
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
    if (!selection || applyInFlightRef.current) return;
    const generation = nextGeneration();
    applyInFlightRef.current = true;
    setState('applying');
    try {
      await peopleImportAPI.apply(provider, { selection, reviewToken, selections });
      if (generation !== generationRef.current) return;
      applyInFlightRef.current = false;
      setState('applied');
      onComplete();
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setState('review');
      throw cause;
    } finally {
      if (generation === generationRef.current) applyInFlightRef.current = false;
    }
  }, [onComplete, provider, selection]);

  const providerName = provider === 'planning_center' ? 'Planning Center' : 'Elvanto';

  return (
    <section aria-label={`${providerName} people import`} className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Import people from {providerName}</h2>
        <p className="mt-1 text-sm text-gray-600">Choose who to import, review the matches, then apply this one-time import.</p>
      </div>

      {state === 'sources' && (
        <div className="space-y-4">
          {loadingSources && !error && <p role="status" className="text-sm text-gray-500">Loading people sources…</p>}
          {error && (
            <div role="alert" className="space-y-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              <p>{error}</p>
              <button type="button" className={secondaryButtonClass} onClick={() => void loadSources()}>Try again</button>
            </div>
          )}
          {!loadingSources && !error && (
            <fieldset className="space-y-2">
              <legend className="sr-only">People source</legend>
              <label className="flex cursor-pointer items-center gap-3 rounded border border-gray-200 p-3">
                <input type="radio" aria-label={allOption.name} name="onboarding-people-import-source" checked={selection?.kind === 'all'} onChange={() => setSelection({ kind: 'all' })} />
                <span><span className="font-medium">{allOption.name}</span><span className="ml-2 text-xs text-gray-500">All people</span></span>
              </label>
              {sources.map((source) => {
                const nextSelection = selectionFor(source);
                const checked = selection !== null
                  && selection.kind !== 'all'
                  && selection.kind === source.kind
                  && selection.externalId === source.externalId;
                return (
                  <label key={`${source.kind}:${source.externalId}`} className="flex cursor-pointer items-center gap-3 rounded border border-gray-200 p-3">
                    <input type="radio" name="onboarding-people-import-source" checked={checked} onChange={() => setSelection(nextSelection)} />
                    <span><span className="font-medium">{source.name}</span><span className="ml-2 text-xs text-gray-500">{sourceType(source)}{source.memberCount === null ? '' : ` · ${source.memberCount} people`}</span></span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <button type="button" className={primaryButtonClass} disabled={!selection || loadingSources || !!error} onClick={() => void preview()}>Review import</button>
        </div>
      )}

      {state === 'previewing' && <p role="status" className="text-sm text-gray-500">Preparing import review…</p>}

      {(state === 'review' || state === 'applying') && review && (
        <SyncReview
          operationKind="people_import"
          provider={provider}
          review={review}
          onRefresh={preview}
          onApply={apply}
          applying={state === 'applying'}
          interactionDisabled={state === 'applying'}
        />
      )}

      {state === 'applied' && <p role="status" className="text-sm font-medium text-green-700">Import applied. Continuing…</p>}

      <button type="button" className="text-sm underline" onClick={onSkip} disabled={state === 'applying'}>Skip people import</button>
    </section>
  );
}
