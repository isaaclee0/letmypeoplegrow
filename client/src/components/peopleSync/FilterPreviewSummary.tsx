import React, { useCallback, useEffect, useRef, useState } from 'react';
import { peopleSyncAPI } from '../../services/api';
import type { BooleanFilterConfigV2, FilterMetadata, FilterPreviewResult, PeopleType, SyncProvider } from './types';

export interface FilterPreviewSummaryProps {
  provider: SyncProvider;
  batchId: number | null;
  value: BooleanFilterConfigV2;
  enabled: boolean;
  defaultPeopleType: PeopleType;
  gatheringTypeId: number | null;
  onMetadata: (metadata: FilterMetadata) => void;
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  return `${Math.floor(seconds / 3600)} hours ago`;
}

function warningText(warning: FilterPreviewResult['warnings'][number]): string {
  if (warning === 'BROAD_FILTER') return 'This filter matches the whole available population.';
  if (warning === 'OVERLAP_GATHERING_TYPE') return 'Overlapping batches use a different gathering.';
  return 'Overlapping batches use a different default people type.';
}

export default function FilterPreviewSummary({ provider, batchId, value, enabled, defaultPeopleType, gatheringTypeId, onMetadata }: FilterPreviewSummaryProps) {
  const [result, setResult] = useState<FilterPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const preview = useCallback(async () => {
    const current = ++sequence.current;
    setError(null);
    try {
      const response = await peopleSyncAPI.previewFilter(provider, { batchId, filterConfig: value, enabled, defaultPeopleType, gatheringTypeId });
      if (!mounted.current || current !== sequence.current) return;
      setResult(response.data);
    } catch {
      if (!mounted.current || current !== sequence.current) return;
      setResult(null);
      setError('Count unavailable');
    }
  }, [batchId, defaultPeopleType, enabled, gatheringTypeId, provider, value]);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => { void preview(); }, 350);
    return () => { window.clearTimeout(timer); mounted.current = false; sequence.current += 1; };
  }, [preview]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await peopleSyncAPI.refreshFilterSnapshot(provider, { filterConfig: value });
      const metadata = await peopleSyncAPI.getFilterMetadata(provider);
      if (!mounted.current) return;
      onMetadata(metadata.data.metadata);
      await preview();
    } catch {
      if (mounted.current) { setResult(null); setError('Count unavailable'); }
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };

  const snapshot = result?.snapshot;
  const unavailable = !result || result.matchCount === null;
  return <section aria-label="Filter preview" className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Match preview</h3><p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{unavailable ? 'Count unavailable' : `${result.matchCount === 1 ? '1 person matches' : `${result.matchCount} people match`}`}</p>{snapshot ? <p title={snapshot.capturedAt} className="mt-1 text-xs text-gray-600 dark:text-gray-300">Data updated {relativeTime(snapshot.capturedAt)}{snapshot.fresh ? '' : ' · Data is stale'}</p> : <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">No cached people snapshot is available.</p>}</div><button type="button" disabled={refreshing} onClick={() => { void refresh(); }} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700">{refreshing ? 'Refreshing people data…' : 'Refresh people data'}</button></div>
    {error ? <p role="alert" className="mt-3 text-sm text-amber-800 dark:text-amber-200">{error}</p> : null}
    {result?.overlaps.length ? <details className="mt-3 rounded-md bg-gray-50 p-3 dark:bg-gray-900/40"><summary className="cursor-pointer text-sm font-medium text-gray-800 dark:text-gray-100">Overlap with enabled batches</summary><ul className="mt-2 space-y-1 text-sm text-gray-700 dark:text-gray-200">{result.overlaps.map((overlap) => <li key={overlap.batchId}>{overlap.count} also match {overlap.batchName}</li>)}</ul>{result.uniqueEnabledPopulationCount !== null ? <p className="mt-2 text-sm font-medium text-gray-800 dark:text-gray-100">{result.uniqueEnabledPopulationCount} people across enabled batches</p> : null}</details> : null}
    {result && (result.missingDimensionIds.length > 0 || result.warnings.length > 0) ? <div role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{result.missingDimensionIds.length ? <p>Count coverage is missing for: {result.missingDimensionIds.map((id) => id.replace(/(^|_)([a-z])/g, (_, prefix: string, letter: string) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`)).join(', ')}.</p> : null}{result.warnings.map((warning) => <p key={warning}>{warningText(warning)}</p>)}</div> : null}
  </section>;
}
