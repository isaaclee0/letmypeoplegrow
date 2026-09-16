import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../Modal';
import SyncReview from '../peopleSync/SyncReview';
import PeopleSyncSetup from '../peopleSync/PeopleSyncSetup';
import type { PeopleSyncApplyResult, PeopleSyncSelections, ProviderSource, SyncProvider } from '../peopleSync/types';
import { integrationsAPI, peopleImportAPI } from '../../services/api';
import type { ImportSelection, PeopleImportReview } from './types';

type ImportState = 'provider' | 'connect' | 'sources' | 'sync' | 'previewing' | 'review' | 'applying' | 'applied';
export type PeopleTransferMode = 'import' | 'sync';

interface PeopleImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onApplied: (result: PeopleSyncApplyResult) => void | Promise<void>;
  initialProvider?: SyncProvider | null;
  initialMode?: PeopleTransferMode;
  allowImport?: boolean;
  embedded?: boolean;
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

function selectionFor(source: ProviderSource): Exclude<ImportSelection, { kind: 'all' }> {
  return { kind: source.kind, externalId: source.externalId };
}

function sourceType(source: ProviderSource): string {
  if (source.kind === 'planning_center_list') return 'List';
  return source.kind === 'elvanto_category' ? 'Category' : 'Group';
}

export default function PeopleImportDialog({ isOpen, onClose, onApplied, initialProvider, initialMode = 'import', allowImport = true, embedded = false }: PeopleImportDialogProps) {
  const [mode, setMode] = useState<PeopleTransferMode>(initialMode);
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
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
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
    setApiKey('');
    setConnecting(false);
  }, []);

  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen, reset]);

  const loadSources = useCallback(async (nextProvider: SyncProvider, nextMode: PeopleTransferMode = 'import') => {
    const generation = nextGeneration();
    setProvider(nextProvider);
    setMode(nextMode);
    setSources([]);
    setLoadingSources(true);
    setSelection(null);
    setReview(null);
    setError(null);
    setRefreshError(null);
    setState('sources');
    try {
      if (nextMode === 'sync') {
        const status = nextProvider === 'planning_center'
          ? await integrationsAPI.getPlanningCenterStatus()
          : await integrationsAPI.getElvantoStatus();
        if (generation !== generationRef.current) return;
        setLoadingSources(false);
        setState(status.data.connected ? 'sync' : 'connect');
        return;
      }
      const response = await peopleImportAPI.listSources(nextProvider);
      if (generation !== generationRef.current) return;
      setSources(response.data.sources);
      setAllOption(response.data.allOption);
      setLoadingSources(false);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      const code = (cause as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'SYNC_NOT_CONNECTED' || code === 'SYNC_CONNECTION_INVALID' || code === 'SYNC_SOURCE_AUTH') {
        setState('connect');
      } else {
        setError(displayError(cause, 'Could not load people sources.'));
      }
      setLoadingSources(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const nextMode = allowImport ? initialMode : 'sync';
    setMode(nextMode);
    if (initialProvider) void loadSources(initialProvider, nextMode);
  }, [isOpen, initialProvider, initialMode, allowImport, loadSources]);

  const connect = async () => {
    if (!provider || connecting || (provider === 'elvanto' && !apiKey.trim())) return;
    const generation = nextGeneration();
    setConnecting(true);
    setError(null);
    try {
      if (provider === 'planning_center') {
        const response = await integrationsAPI.authorizePlanningCenter(`/app/people?import=planning_center${mode === 'sync' ? '&mode=sync' : ''}`);
        if (generation !== generationRef.current) return;
        window.location.href = response.data.authUrl;
      } else {
        await integrationsAPI.connectElvanto(apiKey.trim());
        if (generation !== generationRef.current) return;
        setApiKey('');
        setConnecting(false);
        await loadSources(provider, mode);
      }
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(displayError(cause, 'Could not connect. Please try again.'));
      setConnecting(false);
    }
  };

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
    setApiKey('');
    setConnecting(false);
  };

  const content = (
      <section role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : true} aria-label="Import people" className={embedded ? "w-full" : "w-full max-w-4xl rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900"}>
        {!embedded && <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{mode === 'sync' ? 'Sync people' : 'Import people'}</h2>
            {state === 'review' || state === 'applying' ? <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">People import review</p> : null}
          </div>
          <button type="button" className={secondaryButtonClass} onClick={close} disabled={state === 'applying'}>Close</button>
        </header>}

        {state === 'provider' && (
          <div className="space-y-4">
            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-3 text-sm font-medium text-gray-900 dark:text-gray-100">How would you like to manage your people?</legend>
              <label className={`rounded-lg border p-4 ${mode === 'import' ? 'border-primary-500 bg-primary-50 dark:bg-primary-950' : 'border-gray-300 dark:border-gray-600'}`}>
                <span className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100"><input type="radio" name="people-transfer-mode" aria-label="One-time import" checked={mode === 'import'} disabled={!allowImport} onChange={() => setMode('import')} />One-time import</span>
                <span className="mt-2 block text-sm text-gray-600 dark:text-gray-300">Move your people into LMPG and manage them here.</span>
              </label>
              <label className={`rounded-lg border p-4 ${mode === 'sync' ? 'border-primary-500 bg-primary-50 dark:bg-primary-950' : 'border-gray-300 dark:border-gray-600'}`}>
                <span className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100"><input type="radio" name="people-transfer-mode" aria-label="Keep in sync" checked={mode === 'sync'} onChange={() => setMode('sync')} />Keep in sync</span>
                <span className="mt-2 block text-sm text-gray-600 dark:text-gray-300">Keep managing people in your other service. Sync its lists to your gatherings on a schedule.</span>
              </label>
            </fieldset>
            {!allowImport && <p className="text-sm text-gray-500 dark:text-gray-400">One-time imports are unavailable while provider-managed people editing is locked.</p>}
            <p className="text-sm text-gray-700 dark:text-gray-200">{mode === 'sync' ? 'Choose the provider that manages your people.' : 'Choose the provider to import people from.'}</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={primaryButtonClass} onClick={() => void loadSources('planning_center', mode)}>Planning Center</button>
              <button type="button" className={primaryButtonClass} onClick={() => void loadSources('elvanto', mode)}>Elvanto</button>
            </div>
          </div>
        )}

        {state === 'connect' && provider && (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-medium text-gray-900 dark:text-gray-100">Connect {provider === 'planning_center' ? 'Planning Center' : 'Elvanto'}</h3>
              <button type="button" className={secondaryButtonClass} onClick={backToProviders}>Back</button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300">{mode === 'sync' ? 'Connect your account to choose which lists feed your gatherings. You’ll review changes before activating sync.' : 'Connect your account to choose who to import. You’ll review the people before importing them.'}</p>
            {provider === 'elvanto' ? (
              <div className="space-y-2">
                <label htmlFor="people-import-elvanto-key" className="block text-sm font-medium text-gray-900 dark:text-gray-100">Elvanto API key</label>
                <input id="people-import-elvanto-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={connecting} placeholder="Paste your API key" className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
                <p className="text-sm text-gray-500 dark:text-gray-400">Ask an Elvanto administrator for your organisation’s API key.</p>
              </div>
            ) : <p className="text-sm text-gray-600 dark:text-gray-300">You’ll sign in to Planning Center, then return here to continue setup.</p>}
            {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
            <button type="submit" className={primaryButtonClass} disabled={connecting || (provider === 'elvanto' && !apiKey.trim())}>
              {connecting ? 'Connecting…' : `Connect ${provider === 'planning_center' ? 'Planning Center' : 'Elvanto'}`}
            </button>
          </form>
        )}

        {state === 'sync' && provider && <PeopleSyncSetup provider={provider} onCancel={backToProviders} />}

        {state === 'sources' && provider && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3"><p className="text-sm text-gray-700 dark:text-gray-200">{mode === 'sync' ? 'Set up sync with ' : 'Choose who to import from '}{provider === 'planning_center' ? 'Planning Center' : 'Elvanto'}</p><button type="button" className={secondaryButtonClass} onClick={backToProviders}>Back</button></div>
            {loadingSources && !error ? <p role="status" className="text-sm text-gray-500">Loading people sources…</p> : null}
            {error ? <div role="alert" className="space-y-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"><p>{error}</p><button type="button" className={secondaryButtonClass} onClick={() => void loadSources(provider, mode)}>Try again</button></div> : null}
            {mode === 'import' && !loadingSources && !error && (
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
            {mode === 'import' && <button type="button" className={primaryButtonClass} disabled={!selection || !!error} onClick={() => void preview()}>Review import</button>}
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
  );
  return embedded ? (isOpen ? content : null) : <Modal isOpen={isOpen} onClose={close} className="max-w-4xl mx-auto">{content}</Modal>;
}
