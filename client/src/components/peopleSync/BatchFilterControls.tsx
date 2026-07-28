import React, { useCallback, useEffect, useState } from 'react';
import { peopleSyncAPI } from '../../services/api';
import FilterBuilder from './FilterBuilder';
import FilterPreviewSummary from './FilterPreviewSummary';
import type { BooleanFilterConfigV2, FilterMetadata, FilterPreviewResult, PeopleSyncBatch, PeopleType, SyncProvider } from './types';

export interface BatchFilterControlsProps {
  provider: SyncProvider;
  batch: PeopleSyncBatch<BooleanFilterConfigV2> | null;
  value: BooleanFilterConfigV2;
  onChange: (value: BooleanFilterConfigV2) => void;
  enabled: boolean;
  defaultPeopleType: PeopleType;
  gatheringTypeId: number | null;
  broadAcknowledged: boolean;
  onBroadAcknowledgedChange: (value: boolean) => void;
  onBroadWarningChange: (value: boolean) => void;
  onDiscarded: (batch: PeopleSyncBatch<BooleanFilterConfigV2>) => void;
}

function message(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const data = response.data;
      if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') return data.error;
    }
  }
  return fallback;
}

export default function BatchFilterControls({ provider, batch, value, onChange, enabled, defaultPeopleType, gatheringTypeId, broadAcknowledged, onBroadAcknowledgedChange, onBroadWarningChange, onDiscarded }: BatchFilterControlsProps) {
  const [metadata, setMetadata] = useState<FilterMetadata | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(true);
  const [warnings, setWarnings] = useState<FilterPreviewResult['warnings']>([]);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const handlePreview = useCallback((result: FilterPreviewResult | null) => {
    setWarnings(result?.warnings ?? []);
  }, []);

  const loadMetadata = async () => {
    setLoadingMetadata(true);
    setMetadataError(null);
    try {
      const response = await peopleSyncAPI.getFilterMetadata(provider);
      setMetadata(response.data.metadata);
    } catch (error) {
      // Deliberately retain the current filter value: the user may have a
      // previously saved draft even when the provider cache is unavailable.
      setMetadataError(message(error, 'Filter metadata is unavailable.'));
    } finally {
      setLoadingMetadata(false);
    }
  };

  useEffect(() => { void loadMetadata(); }, [provider]);
  useEffect(() => { onBroadWarningChange(warnings.includes('BROAD_FILTER')); }, [onBroadWarningChange, warnings]);

  const discard = async () => {
    if (!batch || !batch.draftFilterConfig) return;
    setDiscarding(true);
    setDiscardError(null);
    try {
      const response = await peopleSyncAPI.discardFilterDraft(provider, batch.id);
      onDiscarded(response.data.batch);
    } catch (error) {
      setDiscardError(message(error, 'Failed to discard the filter draft.'));
    } finally {
      setDiscarding(false);
    }
  };

  return <section className="space-y-4 border-t border-gray-200 pt-4 dark:border-gray-700">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Who qualifies?</h2>
        {batch?.filterSchemaVersion === 2 ? <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">Active criteria are unchanged until you complete a full review.</p> : null}
      </div>
      {batch?.draftFilterConfig ? <button type="button" onClick={() => { void discard(); }} disabled={discarding} className="text-sm font-medium text-gray-700 underline disabled:opacity-50 dark:text-gray-200">{discarding ? 'Discarding draft…' : 'Discard draft'}</button> : null}
    </div>
    {discardError ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{discardError}</p> : null}
    {loadingMetadata ? <p className="text-sm text-gray-600 dark:text-gray-300">Loading filter metadata…</p> : null}
    {metadataError ? <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"><p>{metadataError}</p><button type="button" onClick={() => { void loadMetadata(); }} className="mt-2 underline">Retry filter metadata</button></div> : null}
    {metadata ? <>
      <FilterBuilder metadata={metadata} value={value} onChange={onChange} />
      <FilterPreviewSummary provider={provider} batchId={batch?.id ?? null} value={value} enabled={enabled} defaultPeopleType={defaultPeopleType} gatheringTypeId={gatheringTypeId} onMetadata={setMetadata} onPreview={handlePreview} />
      {warnings.includes('BROAD_FILTER') ? <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"><input type="checkbox" aria-label="Acknowledge broad filter" checked={broadAcknowledged} onChange={(event) => onBroadAcknowledgedChange(event.target.checked)} className="mt-0.5" /><span>A broad filter needs acknowledgement before it can be saved.</span></label> : null}
    </> : null}
  </section>;
}
