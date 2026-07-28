import React, { useEffect, useMemo, useRef, useState } from 'react';
import { peopleSyncAPI } from '../../services/api';
import type { BooleanFilterConfigV2, FilterUpgradePreview, PeopleSyncBatch, SyncProvider } from './types';

interface Props {
  provider: SyncProvider;
  batches: PeopleSyncBatch[];
  onChanged: () => void | Promise<void>;
}

type PreviewState = FilterUpgradePreview & { loading?: boolean; error?: string };

function expression(config: BooleanFilterConfigV2): string {
  const group = (item: { dimensionId: string; mode?: string; values: string[] }) =>
    `${item.dimensionId} ${item.mode === 'all' ? 'contains all' : item.mode === undefined ? 'is not' : 'is'} ${item.values.join(' or ')}`;
  const includes = config.branches.map((branch) => branch.groups.map(group).join(' and ')).filter(Boolean);
  const exclusions = config.exclusions.map(group).filter(Boolean);
  return [...includes.map((value) => includes.length > 1 ? `(${value})` : value), ...exclusions.map((item) => `not ${group(item)}`)].join(' and ') || 'Matches nobody';
}

function snapshotAge(capturedAt: string): string {
  const millis = Date.now() - new Date(capturedAt).getTime();
  if (!Number.isFinite(millis) || millis < 60_000) return 'Snapshot captured just now';
  return `Snapshot captured ${Math.floor(millis / 60_000)} minutes ago`;
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
    if (message) return message;
  }
  return 'Unable to compare this legacy filter. Refresh the snapshot and try again.';
}

export default function FilterUpgradePanel({ provider, batches, onChanged }: Props) {
  const legacy = useMemo(() => batches.filter((batch) => batch.filterSchemaVersion === 1), [batches]);
  const [previews, setPreviews] = useState<Record<number, PreviewState>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const generation = useRef(0);
  const mutationInFlight = useRef(false);

  useEffect(() => {
    generation.current += 1;
    setPreviews((current) => Object.fromEntries(Object.entries(current).filter(([id]) => legacy.some((batch) => batch.id === Number(id)))));
  }, [legacy]);

  const loadPreview = async (batch: PeopleSyncBatch) => {
    const requestGeneration = generation.current;
    setPreviews((current) => ({ ...current, [batch.id]: { ...(current[batch.id] || {} as PreviewState), loading: true } }));
    try {
      const response = await peopleSyncAPI.previewFilterUpgrade(provider, batch.id);
      if (requestGeneration !== generation.current) return;
      setPreviews((current) => ({ ...current, [batch.id]: response.data }));
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      setPreviews((current) => ({ ...current, [batch.id]: { ...(current[batch.id] || {} as PreviewState), loading: false, error: errorMessage(error) } }));
    }
  };

  const compatible = legacy.flatMap((batch) => {
    const preview = previews[batch.id];
    return preview?.compatible && preview.upgradeToken ? [{ batchId: batch.id, upgradeToken: preview.upgradeToken }] : [];
  });

  const upgradeCompatible = async () => {
    if (!compatible.length || busy || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await peopleSyncAPI.applyCompatibleFilterUpgrades(provider, compatible);
      await onChanged();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  const upgradeExact = async (batch: PeopleSyncBatch, preview: PreviewState) => {
    if (!preview.compatible || !preview.upgradeToken || busy || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await peopleSyncAPI.applyFilterUpgrade(provider, batch.id, preview.upgradeToken);
      await onChanged();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  const reviewMismatch = async (batch: PeopleSyncBatch, preview: PreviewState) => {
    if (!preview.convertedFilterConfig || busy || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      // Choosing this action is the explicit acknowledgement that the
      // converted criteria needs the normal full-review/promotion path.
      await peopleSyncAPI.saveFilterDraft(provider, batch.id, {
        filterConfig: preview.convertedFilterConfig,
        broadMatchAcknowledged: true,
      });
      await onChanged();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  if (!legacy.length) return null;
  return <section aria-label="Legacy filter upgrades" className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold">Legacy filter upgrades</h3><p className="mt-1 text-xs">A comparison never changes a batch. Exact matches can upgrade directly; any difference goes through full review.</p></div>
      <button type="button" onClick={() => void upgradeCompatible()} disabled={busy || compatible.length === 0} className="rounded border border-amber-400 px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Updating…' : 'Upgrade all compatible batches'}</button>
    </div>
    {actionError && <p role="alert" className="text-red-700 dark:text-red-300">{actionError}</p>}
    <ul className="space-y-3">
      {legacy.map((batch) => {
        const preview = previews[batch.id];
        const delta = preview ? Math.abs(preview.newCount - preview.oldCount) : 0;
        return <li key={batch.id} className="rounded border border-amber-200 bg-white p-3 dark:border-amber-800 dark:bg-gray-900">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">Legacy batch: {batch.name}</p><p className="text-xs text-gray-600 dark:text-gray-300">{batch.scheduleEnabled ? `Runs ${batch.scheduleFrequency}` : 'Manual only'} · Active criteria still running</p></div><button type="button" aria-label={`Upgrade filter ${batch.name}`} onClick={() => void loadPreview(batch)} disabled={busy || preview?.loading} className="underline disabled:opacity-50">{preview?.loading ? 'Comparing…' : 'Upgrade filter'}</button></div>
          {preview?.error && <p role="alert" className="mt-2 text-red-700">{preview.error}</p>}
          {preview && !preview.loading && !preview.error && <div className="mt-3 space-y-1 border-t border-amber-100 pt-3 text-xs dark:border-amber-900"><p><span className="font-medium">Converted expression:</span> {expression(preview.convertedFilterConfig)}</p><p>{preview.oldCount} legacy matches → {preview.newCount} converted matches</p><p>{snapshotAge(preview.snapshot.capturedAt)}</p>{preview.compatible ? <><p className="font-medium text-green-700 dark:text-green-300">Exact-compatible</p><button type="button" aria-label={`Apply upgrade ${batch.name}`} onClick={() => void upgradeExact(batch, preview)} disabled={busy} className="underline disabled:opacity-50">Apply upgrade</button></> : <><p>Overlap impact: {delta} {delta === 1 ? 'person changes' : 'people change'}</p><p className="font-medium text-amber-800 dark:text-amber-200">Needs full review</p><button type="button" aria-label={`Review converted filter ${batch.name}`} onClick={() => void reviewMismatch(batch, preview)} disabled={busy} className="underline disabled:opacity-50">Review converted filter</button></>}</div>}
        </li>;
      })}
    </ul>
  </section>;
}
