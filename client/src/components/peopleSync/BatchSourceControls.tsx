import React, { useEffect, useMemo, useRef, useState } from 'react';
import { peopleSyncAPI } from '../../services/api';
import { sourceFreshness } from '../../utils/sourceFreshness';
import { useChurchTime } from '../../hooks/useChurchTime';
import type { PeopleSyncBatch, PeopleSyncSourceState, ProviderSource, SourceKind, SourceSelection, SyncProvider } from './types';

export interface BatchSourceControlsProps {
  provider: SyncProvider;
  batch: PeopleSyncBatch | null;
  value: SourceSelection | null;
  onChange: (value: SourceSelection | null) => void;
  onDiscarded: (batch: PeopleSyncSourceState) => void;
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const data = response.data;
      if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') return data.error;
    }
  }
  return 'People sources are unavailable.';
}

function optionLabel(source: ProviderSource): string {
  return source.memberCount === null ? source.name : `${source.name} (${source.memberCount} member${source.memberCount === 1 ? '' : 's'})`;
}

function sourceKindFor(provider: SyncProvider, selection: SourceSelection | null): SourceKind {
  if (provider === 'planning_center') return 'planning_center_list';
  return selection?.sourceKind === 'elvanto_group' ? 'elvanto_group' : 'elvanto_category';
}

export default function BatchSourceControls({ provider, batch, value, onChange, onDiscarded }: BatchSourceControlsProps) {
  const { timeZone, formatInstant } = useChurchTime();
  const [sources, setSources] = useState<ProviderSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<SourceKind>(() => sourceKindFor(provider, value));
  const [discarding, setDiscarding] = useState(false);
  const previousProvider = useRef(provider);
  const locallyClearedKind = useRef<SourceKind | null>(null);

  const loadSources = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await peopleSyncAPI.listSources(provider);
      setSources(response.data.sources);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadSources(); }, [provider]);
  useEffect(() => {
    const providerChanged = previousProvider.current !== provider;
    previousProvider.current = provider;
    if (providerChanged || provider === 'planning_center' || value !== null || locallyClearedKind.current === null) {
      setKind(sourceKindFor(provider, value));
      if (value !== null) locallyClearedKind.current = null;
    }
  }, [provider, value?.sourceKind]);

  const visibleSources = useMemo(
    () => (sources ?? []).filter((source) => source.kind === kind),
    [kind, sources],
  );
  const visibleSelection = sources?.find((source) => source.kind === value?.sourceKind && source.externalId === value?.sourceExternalId) ?? null;
  const savedSelection = [batch?.draftSource, batch?.source].find((source) =>
    source !== null && source !== undefined && source.kind === value?.sourceKind && source.externalId === value?.sourceExternalId,
  ) ?? null;
  const selectedName = visibleSelection?.name ?? savedSelection?.name ?? null;
  const missing = batch?.sourceStatus === 'missing' || (sources !== null && value !== null && visibleSelection === null);

  const choose = (externalId: string) => {
    if (!externalId) {
      onChange(null);
      return;
    }
    onChange({ sourceKind: kind, sourceExternalId: externalId });
  };

  const changeElvantoKind = (nextKind: 'elvanto_category' | 'elvanto_group') => {
    setKind(nextKind);
    locallyClearedKind.current = nextKind;
    onChange(null);
  };

  const discard = async () => {
    if (!batch?.draftSource || batch.initialSourceReviewPending) return;
    setDiscarding(true);
    setError(null);
    try {
      const response = await peopleSyncAPI.discardSourceDraft(provider, batch.id);
      onDiscarded(response.data.batch);
    } catch (discardError) {
      setError(errorMessage(discardError));
    } finally {
      setDiscarding(false);
    }
  };

  const freshness = provider === 'planning_center' ? sourceFreshness(visibleSelection?.providerRefreshedAt ?? null, timeZone) : null;

  return <section className="space-y-4 border-t border-gray-200 pt-4 dark:border-gray-700">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">People source</h2>
        {batch?.source ? <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Active source: {batch.source.name}</p> : null}
        {batch?.draftSource ? <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Pending source: {batch.draftSource.name}</p> : null}
      </div>
      {batch?.draftSource && !batch.initialSourceReviewPending ? <button type="button" onClick={() => { void discard(); }} disabled={discarding} className="text-sm font-medium text-gray-700 underline disabled:opacity-50 dark:text-gray-200">{discarding ? 'Discarding source draft…' : 'Discard source draft'}</button> : null}
    </div>
    {batch?.sourceStatus === 'error' ? <p role="status" className="text-sm font-medium text-amber-700 dark:text-amber-300">Source check failed{batch.sourceStatusErrorCode ? ` · ${batch.sourceStatusErrorCode}` : ''}</p> : null}

    {error ? <div role="alert" className="text-sm text-red-700 dark:text-red-300"><p>{error}</p><button type="button" onClick={() => { void loadSources(); }} className="mt-1 underline">Retry source list</button></div> : null}
    {loading ? <p className="text-sm text-gray-600 dark:text-gray-300">Loading people sources…</p> : null}
    {!loading && !error && sources?.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-300">No people sources are available.</p> : null}

    {provider === 'planning_center' ? <div>
      <label htmlFor="planning-center-source" className="mb-1 block text-sm font-medium">Planning Center List</label>
      <select id="planning-center-source" value={value?.sourceKind === 'planning_center_list' && visibleSelection ? value.sourceExternalId : ''} onChange={(event) => choose(event.target.value)} disabled={loading || !!error} className="w-full rounded-md border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-700">
        <option value="">Choose a List…</option>
        {visibleSources.map((source) => <option key={source.externalId} value={source.externalId}>{optionLabel(source)}</option>)}
      </select>
      {selectedName ? <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">{selectedName}</p> : null}
      {missing ? <p className="mt-1 text-sm font-medium text-red-700 dark:text-red-300">Source missing</p> : null}
      <p data-testid="planning-center-freshness" title={freshness?.title} className={`source-freshness-${freshness?.band} mt-2 text-sm ${freshness?.className}`}>Planning Center refresh: {freshness?.text}</p>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">If recent members are missing, refresh this List in Planning Center.</p>
    </div> : <div className="space-y-2">
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Elvanto source type</legend>
        <label className="mr-4 inline-flex items-center gap-2 text-sm"><input type="radio" name="elvanto-source-kind" checked={kind === 'elvanto_category'} onChange={() => changeElvantoKind('elvanto_category')} />Category</label>
        <label className="inline-flex items-center gap-2 text-sm"><input type="radio" name="elvanto-source-kind" checked={kind === 'elvanto_group'} onChange={() => changeElvantoKind('elvanto_group')} />Group</label>
      </fieldset>
      <label htmlFor="elvanto-source" className="mb-1 block text-sm font-medium">Elvanto {kind === 'elvanto_group' ? 'Group' : 'Category'}</label>
      <select id="elvanto-source" value={value?.sourceKind === kind && visibleSelection ? value.sourceExternalId : ''} onChange={(event) => choose(event.target.value)} disabled={loading || !!error} className="w-full rounded-md border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-700">
        <option value="">Choose a {kind === 'elvanto_group' ? 'Group' : 'Category'}…</option>
        {visibleSources.map((source) => <option key={source.externalId} value={source.externalId}>{optionLabel(source)}</option>)}
      </select>
      {selectedName ? <p className="text-sm text-gray-700 dark:text-gray-200">{selectedName}</p> : null}
      {missing ? <p className="text-sm font-medium text-red-700 dark:text-red-300">Source missing</p> : null}
      {batch?.sourceStatusCheckedAt ? <p className="text-sm text-gray-600 dark:text-gray-300">Last checked by LMPG {formatInstant(batch.sourceStatusCheckedAt, { dateStyle: 'medium', timeStyle: 'short' })}</p> : null}
    </div>}
  </section>;
}
