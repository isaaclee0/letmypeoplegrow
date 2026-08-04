import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { useNavigate } from 'react-router-dom';
import { elvantoSyncAPI, gatheringsAPI, integrationsAPI, peopleSyncAPI } from '../../services/api';
import ElvantoBatchEditor, { type ElvantoGatheringOption } from '../elvanto/ElvantoBatchEditor';
import ElvantoGatheringImport from '../elvanto/ElvantoGatheringImport';
import PeopleSourceControl from '../peopleSync/PeopleSourceControl';
import type {
  BatchOperationalState,
  PeopleSyncBatch,
  PeopleSyncRun,
  PeopleSyncSettings,
} from '../peopleSync/types';
import type { ElvantoStatus, PanelProps, PeopleSyncPanelProps } from './types';

type Props = PanelProps<ElvantoStatus> & PeopleSyncPanelProps & { initialAction?: 'disconnect' };

const BATCH_OPERATIONAL_STATE_LABELS: Record<BatchOperationalState, string> = {
  active: 'Active',
  prepared: 'Prepared for source switch',
  disabled: 'Disabled',
  source_review_required: 'Source review required',
};

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const responseError = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
    if (responseError) return responseError;
  }
  return error instanceof Error ? error.message : fallback;
}

function ConnectionSection({
  status,
  refreshStatus,
  authoritative,
  authorityKnown,
  retryAuthority,
  onConnectionChanged,
  initialAction,
}: {
  status: ElvantoStatus;
  refreshStatus: () => void | Promise<void>;
  authoritative: boolean;
  authorityKnown: boolean;
  retryAuthority: () => void | Promise<void>;
  onConnectionChanged?: () => void | Promise<void>;
  initialAction?: 'disconnect';
}) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(initialAction === 'disconnect');

  useEffect(() => {
    if (initialAction === 'disconnect') setConfirmDisconnect(true);
  }, [initialAction]);

  const connect = async () => {
    if (!apiKey.trim()) {
      setError('Enter an Elvanto API key.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await integrationsAPI.connectElvanto(apiKey.trim());
      setApiKey('');
      await refreshStatus();
      await onConnectionChanged?.();
    } catch (cause) {
      const detail = errorMessage(cause, 'Failed to connect to Elvanto.');
      setError(status.connected
        ? `Elvanto is still connected. The replacement key was not saved: ${detail}`
        : detail);
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    setError(null);
    try {
      await integrationsAPI.disconnectElvanto();
      setConfirmDisconnect(false);
      await refreshStatus();
    } catch (cause) {
      setError(errorMessage(cause, 'Failed to disconnect Elvanto.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">Elvanto</h4>
          <p className="text-sm text-gray-600 dark:text-gray-400">Import people and families once, or keep LMPG aligned with Elvanto.</p>
          {status.connected && <p className="mt-1 text-xs text-green-700">Connected to {status.elvantoAccount || 'Elvanto'}</p>}
        </div>
        {status.connected && (
          <button type="button" onClick={() => setConfirmDisconnect(true)} disabled={!authorityKnown} className="rounded border border-gray-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">
            Disconnect Elvanto
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 text-sm font-medium" htmlFor="elvanto-api-key">
          Elvanto API key
          <input
            id="elvanto-api-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={status.connected ? 'Enter a replacement key' : 'Paste your API key'}
            className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700"
          />
        </label>
        <button type="button" onClick={() => void connect()} disabled={saving || !apiKey.trim()} className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">
          {saving ? 'Saving…' : status.connected ? 'Replace API key' : 'Connect Elvanto'}
        </button>
      </div>
      <p className="text-xs text-gray-500">The saved key is never displayed. Enter a new key only when connecting or replacing it.</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {confirmDisconnect && (
        <div role="dialog" aria-modal="true" className="rounded-md border border-amber-300 bg-amber-50 p-4">
          <h5 className="font-medium">Disconnect Elvanto?</h5>
          {!authorityKnown ? (
            <><p className="mt-1 text-sm text-amber-900">The authoritative people source is not known, so disconnect is blocked.</p><button type="button" onClick={() => void retryAuthority()} className="mt-2 text-sm underline">Retry people source status</button></>
          ) : authoritative ? (
            <p className="mt-1 text-sm text-amber-900">Elvanto is your authoritative people source. Choose None or Planning Center and complete that change before disconnecting.</p>
          ) : (
            <p className="mt-1 text-sm">Existing imported people, links, and gatherings are retained.</p>
          )}
          <div className="mt-3 flex gap-3">
            {authorityKnown && !authoritative && <button type="button" onClick={() => void disconnect()} disabled={saving} className="rounded bg-red-600 px-3 py-2 text-sm text-white">Confirm disconnect</button>}
            <button type="button" onClick={() => setConfirmDisconnect(false)} className="text-sm underline">Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

function ElvantoOptions({
  settings,
  onChanged,
}: {
  settings: PeopleSyncSettings;
  onChanged: () => void | Promise<void>;
}) {
  const [values, setValues] = useState(settings);
  const [notice, setNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setValues(settings), [settings]);

  const update = async (key: 'elvantoIncludeContacts' | 'elvantoAlignPeopleType', value: boolean) => {
    const previous = values[key];
    setValues((current) => ({ ...current, [key]: value }));
    setError(null);
    try {
      const response = await peopleSyncAPI.updateSettings({ [key]: value });
      setValues(response.data.settings);
      setNotice(true);
      await onChanged();
    } catch {
      setValues((current) => ({ ...current, [key]: previous }));
      setError('Failed to save Elvanto sync settings.');
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div>
        <h5 className="text-sm font-medium">Elvanto people rules</h5>
        <p className="text-xs text-gray-500">These church-level settings apply to every Elvanto batch.</p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={values.elvantoIncludeContacts} onChange={(event) => void update('elvantoIncludeContacts', event.target.checked)} />
        <span><span className="font-medium">Include Contacts</span><span className="block text-xs text-gray-500">Contacts selected by a batch remain excluded when this is off.</span></span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={values.elvantoAlignPeopleType} onChange={(event) => void update('elvantoAlignPeopleType', event.target.checked)} />
        <span><span className="font-medium">Keep people type aligned</span><span className="block text-xs text-gray-500">Keep regular and visitor lifecycle aligned with Elvanto person status.</span></span>
      </label>
      {notice && <p className="text-xs text-amber-700">The next review may propose people type or lifecycle changes.</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

function RecentRuns({ runs }: { runs: PeopleSyncRun[] }) {
  const providerRuns = runs.filter((run) => run.provider === 'elvanto');
  return (
    <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <h5 className="text-sm font-medium">Recent Elvanto runs</h5>
      {providerRuns.length === 0 ? <p className="text-sm text-gray-500">No Elvanto sync runs yet.</p> : (
        <ul className="space-y-2">
          {providerRuns.map((run) => {
            const added = run.counts.addPeople || 0;
            const updated = run.counts.updateManagedFields || 0;
            const archived = run.counts.archive || 0;
            return (
              <li key={run.id} className="rounded bg-gray-50 p-3 text-sm dark:bg-gray-800">
                <p className="font-medium">{run.status.replace('_', ' ')} · {new Date(run.startedAt).toLocaleString()}</p>
                <p className="text-xs text-gray-600">{added} added, {updated} updated, {archived} archived.</p>
                {run.errorMessage && <p className="text-xs text-red-600">{run.errorMessage}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const ElvantoIntegrationPanel: React.FC<Props> = ({
  status,
  refreshStatus,
  onBack,
  initialAction,
  peopleSyncSettings,
  peopleSyncStatus,
  providerConnections,
  peopleSyncBatchRevision,
  refreshPeopleSync,
  retryPeopleSync,
}) => {
  const navigate = useNavigate();
  const [batches, setBatches] = useState<PeopleSyncBatch[]>([]);
  const [gatherings, setGatherings] = useState<ElvantoGatheringOption[]>([]);
  const [runs, setRuns] = useState<PeopleSyncRun[]>([]);
  const [editingBatch, setEditingBatch] = useState<PeopleSyncBatch | 'new' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const connectedRef = useRef(status.connected);
  const connectedDataGeneration = useRef(0);
  const lastSeenPeopleSyncBatchRevision = useRef(peopleSyncBatchRevision);
  connectedRef.current = status.connected;

  const loadConnectedData = useCallback(async () => {
    const generation = ++connectedDataGeneration.current;
    if (!connectedRef.current) {
      setBatches([]);
      setGatherings([]);
      setRuns([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [batchesResponse, gatheringsResponse, runsResponse] = await Promise.all([
        elvantoSyncAPI.listBatches(),
        gatheringsAPI.getAll(),
        peopleSyncAPI.getRuns(10),
      ]);
      if (generation !== connectedDataGeneration.current) return;
      setBatches(batchesResponse.data.batches);
      setGatherings((gatheringsResponse.data.gatherings || []).map((item: { id: number; name: string }) => ({ id: item.id, name: item.name })));
      setRuns(runsResponse.data.runs);
    } catch (cause) {
      if (generation !== connectedDataGeneration.current) return;
      setError(errorMessage(cause, 'Failed to load Elvanto sync data.'));
    } finally {
      if (generation === connectedDataGeneration.current) setLoading(false);
    }
  }, []);

  const reloadConnectionData = useCallback(async () => {
    setConnectionRevision((current) => current + 1);
    setBatches([]);
    setGatherings([]);
    setRuns([]);
    setEditingBatch(null);
    await loadConnectedData();
  }, [loadConnectedData]);

  const reloadAfterBatchMutation = useCallback(async () => {
    setBatches([]);
    await loadConnectedData();
  }, [loadConnectedData]);

  useEffect(() => {
    void loadConnectedData();
    return () => {
      connectedDataGeneration.current += 1;
    };
  }, [loadConnectedData, status.connected]);

  useEffect(() => {
    if (lastSeenPeopleSyncBatchRevision.current === peopleSyncBatchRevision) return;
    lastSeenPeopleSyncBatchRevision.current = peopleSyncBatchRevision;
    if (status.connected) void reloadAfterBatchMutation();
  }, [peopleSyncBatchRevision, reloadAfterBatchMutation, status.connected]);

  const deleteBatch = async (batch: PeopleSyncBatch) => {
    try {
      await elvantoSyncAPI.deleteBatch(batch.id);
      await reloadAfterBatchMutation();
    } catch (cause) {
      setError(errorMessage(cause, 'Failed to delete this batch.'));
    }
  };

  const discardDraft = async (batch: PeopleSyncBatch) => {
    try {
      await peopleSyncAPI.discardSourceDraft('elvanto', batch.id);
      await reloadAfterBatchMutation();
    } catch (cause) {
      setError(errorMessage(cause, 'Failed to discard the people source draft.'));
    }
  };

  const peopleSourceControl = peopleSyncStatus === 'known' ? (
    <PeopleSourceControl
      provider="elvanto"
      batches={batches}
      settings={peopleSyncSettings}
      connections={providerConnections}
      onRefresh={refreshPeopleSync}
    />
  ) : (
    <section role={peopleSyncStatus === 'error' ? 'alert' : undefined} className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p>{peopleSyncStatus === 'loading' ? 'Checking authoritative people source…' : 'Could not load the authoritative people source. Source controls are blocked.'}</p>
      {peopleSyncStatus === 'error' && <button type="button" onClick={() => void retryPeopleSync()} className="mt-2 underline">Retry people source status</button>}
    </section>
  );

  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="inline-flex items-center text-sm font-medium text-gray-600 dark:text-gray-300">
        <ArrowLeftIcon className="mr-1.5 h-4 w-4" /> Back to integrations
      </button>
      <ConnectionSection
        status={status}
        refreshStatus={refreshStatus}
        authoritative={peopleSyncSettings.authorityProvider === 'elvanto'}
        authorityKnown={peopleSyncStatus === 'known'}
        retryAuthority={retryPeopleSync}
        onConnectionChanged={status.connected ? reloadConnectionData : undefined}
        initialAction={initialAction}
      />
      {peopleSourceControl}

      {status.connected && (
        <>
          {peopleSyncStatus === 'known' && <ElvantoOptions settings={peopleSyncSettings} onChanged={refreshPeopleSync} />}

          <section className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h5 className="text-sm font-medium">Elvanto sync batches</h5>
                <p className="text-xs text-gray-500">Review every change before anything is applied.</p>
              </div>
              {editingBatch === null && <button type="button" onClick={() => { setBatchNotice(null); setEditingBatch('new'); }} className="rounded bg-green-600 px-3 py-2 text-sm text-white">New batch</button>}
            </div>
            {loading && <p className="text-sm text-gray-500">Loading Elvanto sync data…</p>}
            {editingBatch && (
              <ElvantoBatchEditor
                batch={editingBatch === 'new' ? null : editingBatch}
                gatherings={gatherings}
                onSaved={(savedBatch) => {
                  if (editingBatch === 'new') {
                    if (peopleSyncSettings.authorityProvider === 'none') {
                      navigate('/app/settings/integrations/elvanto/authority-review?reason=first-batch');
                      return;
                    }
                    if (peopleSyncSettings.authorityProvider === 'elvanto') {
                      navigate(`/app/settings/integrations/elvanto/batches/${savedBatch.id}/review`);
                      return;
                    }
                    setEditingBatch(null);
                    setBatchNotice('Batch prepared. Switch source of truth to review and activate it.');
                    void reloadAfterBatchMutation();
                    return;
                  }
                  setEditingBatch(null);
                  void reloadAfterBatchMutation();
                }}
                onCancel={() => setEditingBatch(null)}
              />
            )}
            <ul className="space-y-3">
              {batches.map((batch) => (
                <li key={batch.id} className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{batch.name}</p>
                      <p className="text-xs text-gray-500">{batch.scheduleEnabled ? `Runs ${batch.scheduleFrequency}` : 'Manual only'}{batch.lastSyncAt ? ` · Last run ${new Date(batch.lastSyncAt).toLocaleString()}` : ''}</p>
                      {batch.source && <p className="mt-1 text-xs text-gray-500">{batch.source.kind === 'elvanto_group' ? 'Elvanto Group' : 'Elvanto Category'}: {batch.source.name}</p>}
                      {batch.sourceStatus === 'missing' && <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-300">Source missing</p>}
                      {batch.sourceStatus === 'error' && <p role="status" className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">Source check failed{batch.sourceStatusErrorCode ? ` · ${batch.sourceStatusErrorCode}` : ''}</p>}
                      <p className="mt-1 text-xs font-medium text-gray-700 dark:text-gray-300">{BATCH_OPERATIONAL_STATE_LABELS[batch.operationalState]}</p>
                      {batch.operationalState === 'prepared' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Switch source of truth to activate this batch.</p>}
                      {batch.operationalState === 'source_review_required' && <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">Needs full review · the selected people source will not run until reviewed.</p>}
                    </div>
                    <div className="flex flex-wrap gap-3 text-sm">
                      <button type="button" onClick={() => setEditingBatch(batch)} className="underline">Edit</button>
                      {batch.reviewable && <button type="button" aria-label={`${batch.operationalState === 'source_review_required' ? 'Review source & sync' : 'Review & sync'} ${batch.name}`} onClick={() => navigate(`/app/settings/integrations/elvanto/batches/${batch.id}/review`)} className="rounded-md bg-green-600 px-3 py-2 font-medium text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2">{batch.operationalState === 'source_review_required' ? 'Review source & sync' : 'Review & sync'}</button>}
                      {batch.needsSourceReview && !batch.initialSourceReviewPending && <button type="button" onClick={() => void discardDraft(batch)} className="underline">Discard source draft</button>}
                      <button type="button" onClick={() => void deleteBatch(batch)} className="text-red-600 underline">Delete</button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {!loading && batches.length === 0 && <p className="text-sm text-gray-500">No Elvanto batches yet.</p>}
            {batchNotice && <p role="status" className="text-sm text-green-700 dark:text-green-300">{batchNotice}</p>}
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          </section>

          <RecentRuns runs={runs} />
          <ElvantoGatheringImport key={connectionRevision} connected={status.connected} />
        </>
      )}
    </div>
  );
};

export default ElvantoIntegrationPanel;
