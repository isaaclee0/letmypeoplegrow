import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { gatheringsAPI, peopleSyncAPI, settingsAPI } from '../../services/api';
import AuthorityReviewWorkspace from './AuthorityReviewWorkspace';
import PlanningCenterBatchEditor from '../planningCenter/PlanningCenterBatchEditor';
import ElvantoBatchEditor from '../elvanto/ElvantoBatchEditor';
import { peopleSyncErrorMessage } from './apiError';
import type { PeopleSyncBatch, PeopleSyncSettings, SyncProvider } from './types';

interface Props { provider: SyncProvider; onCancel: () => void; }

export default function PeopleSyncSetup({ provider, onCancel }: Props) {
  const [settings, setSettings] = useState<PeopleSyncSettings | null>(null);
  const [gatherings, setGatherings] = useState<{ id: number; name: string }[]>([]);
  const [savedBatch, setSavedBatch] = useState<PeopleSyncBatch | null>(null);
  const [completed, setCompleted] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const name = provider === 'planning_center' ? 'Planning Center' : 'Elvanto';
  const slug = provider === 'planning_center' ? 'planning-center' : 'elvanto';

  const load = async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const [sync, groups] = await Promise.all([peopleSyncAPI.getSettings(), gatheringsAPI.getAll()]);
      if (current !== generation.current) return;
      setSettings(sync.data.settings);
      setGatherings(Array.isArray(groups.data) ? groups.data : groups.data.gatherings ?? []);
    } catch (cause) {
      if (current === generation.current) setError(peopleSyncErrorMessage(cause, 'Could not load sync setup.'));
    }
  };

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [provider]);

  const prepareReview = async (batch: PeopleSyncBatch) => {
    const current = ++generation.current;
    setSavedBatch(batch);
    setBusy(true);
    setError(null);
    try {
      // New batches remain blocked by their initial source review. Selecting
      // automatic scheduling explicitly also resumes the provider's master gate.
      if (batch.scheduleEnabled) {
        if (provider === 'planning_center') await settingsAPI.updateIntegrationSettings({ planningCenterSyncEnabled: true });
        if (current !== generation.current) return;
        if (settings?.authorityProvider === provider && !settings.syncEnabled) {
          await peopleSyncAPI.updateSettings({ syncEnabled: true });
        }
      }
      if (current === generation.current) setReady(true);
    } catch (cause) {
      if (current === generation.current) setError(peopleSyncErrorMessage(cause, 'The mapping was saved, but automatic syncing could not be enabled.'));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const reviewPath = savedBatch && settings?.authorityProvider === provider
    ? `/app/settings/integrations/${slug}/batches/${savedBatch.id}/review`
    : `/app/settings/integrations/${slug}/authority-review?reason=first-batch`;

  return <section aria-label={`${name} sync setup`} className="space-y-4 text-gray-900 dark:text-gray-100">
    <h3 className="text-lg font-semibold">Keep people in sync with {name}</h3>
    <p className="text-sm text-gray-600 dark:text-gray-300">Choose a people list and the gathering it feeds. Add another mapping for each group you want to track separately.</p>
    {provider === 'planning_center' && <p className="text-sm text-gray-600 dark:text-gray-300">Leaving a List can remove a gathering assignment, but will not archive the person. Only an explicit Inactive status in Planning Center People can archive them in LMPG.</p>}
    {!settings && !error && <p role="status">Loading sync setup…</p>}
    {error && <div role="alert" className="space-y-2 text-sm text-red-700 dark:text-red-300"><p>{error}</p><button type="button" disabled={busy} className="underline" onClick={() => void (savedBatch ? prepareReview(savedBatch) : load())}>Try again</button></div>}
    {settings && !savedBatch && <>
      <p className="rounded-md bg-primary-50 p-3 text-sm dark:bg-primary-950">Your first sync starts automatically when there are no conflicts or existing records to change. By choosing sync, you give {name} control of synced people in LMPG, including their details and active status. Change these in {name}. When a list or group manages a gathering, people joining or leaving it are added or removed automatically at the next sync, without another approval. Choosing “Runs automatically” enables automatic syncing for this provider, including its other enabled schedules.</p>
      {provider === 'planning_center'
        ? <PlanningCenterBatchEditor batch={null} defaultScheduleEnabled defaultGatheringAutoRemoveEnabled createLabel="Start syncing" onSaved={(batch) => void prepareReview(batch)} onCancel={onCancel} />
        : <ElvantoBatchEditor batch={null} gatherings={gatherings} defaultScheduleEnabled defaultGatheringAutoRemoveEnabled createLabel="Start syncing" onSaved={(batch) => void prepareReview(batch)} onCancel={onCancel} />}
    </>}
    {savedBatch && busy && <p role="status">Preparing your sync review…</p>}
    {savedBatch && ready && settings?.authorityProvider === 'none' ? <AuthorityReviewWorkspace
      provider={provider} autoStart activateInitialSync onCancel={onCancel}
      onApplied={() => { setReady(false); setCompleted(true); }}
    /> : savedBatch && ready && <div className="space-y-3">
      <p role="status">Your mapping is saved. Review the proposed changes to activate it.</p>
      <Link className="inline-flex rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white" to={reviewPath}>Review and activate sync</Link>
      <p className="text-sm text-gray-500 dark:text-gray-400">After the review, you can add more list-to-gathering mappings in {name} settings.</p>
    </div>}
    {completed && <div className="space-y-3"><p role="status">People synced. Your gathering mapping is active.</p><Link to={`/app/settings?tab=integrations&integration=${slug}`}>Manage sync settings</Link></div>}
  </section>;
}
