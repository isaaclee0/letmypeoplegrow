import React, { useEffect, useState } from 'react';
import { elvantoSyncAPI, integrationsAPI } from '../../services/api';
import { authorityLabel } from '../../utils/authorityLock';
import type { PeopleSyncBatch, SyncProvider } from '../peopleSync/types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function scheduleDescription(batch: PeopleSyncBatch): string {
  if (!batch.enabled) return 'batch disabled';
  if (batch.needsSourceReview || !batch.source) return 'sync blocked until an administrator reviews the source';
  if (batch.sourceStatus === 'missing') return 'sync blocked because the source is missing';
  if (!batch.scheduleEnabled) return 'manual sync only';
  if (batch.scheduleFrequency === 'daily') return 'daily overnight';
  if (batch.scheduleFrequency === 'weekly' && WEEKDAYS[batch.scheduleDay]) {
    return `weekly on ${WEEKDAYS[batch.scheduleDay]} (overnight)`;
  }
  if (batch.scheduleFrequency === 'monthly' && batch.scheduleDay >= 1 && batch.scheduleDay <= 31) {
    return `monthly on day ${batch.scheduleDay} (overnight; last day in shorter months)`;
  }
  return 'schedule unavailable — ask an administrator to check the sync settings';
}

interface Props {
  provider: SyncProvider;
  syncEnabled: boolean;
  editingLocked?: boolean;
}

const ProviderManagedPeopleNote: React.FC<Props> = ({ provider, syncEnabled, editingLocked = true }) => {
  const [batches, setBatches] = useState<PeopleSyncBatch[] | null>(null);
  const [failed, setFailed] = useState(false);
  const label = authorityLabel(provider);

  useEffect(() => {
    let current = true;
    setBatches(null);
    setFailed(false);
    if (syncEnabled) {
      const request = provider === 'planning_center'
        ? integrationsAPI.getPlanningCenterSyncBatches()
        : elvantoSyncAPI.listBatches();
      request.then(response => {
        if (current) setBatches(response.data.batches);
      }).catch(() => {
        if (current) setFailed(true);
      });
    }
    return () => { current = false; };
  }, [provider, syncEnabled]);

  return (
    <div role="note" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
      <p className="font-medium">People managed by {label}</p>
      <p className="mt-1">Make edits or remove people in {label}. {editingLocked
        ? 'Provider-managed details, archiving, and deletion are controlled there. You can still change badges and gathering assignments in LMPG.'
        : 'Local editing is enabled, but provider-managed details may be overwritten by the next sync.'}</p>
      {!syncEnabled ? (
        <p className="mt-2">Automatic syncing is paused. Changes in {label} will appear in LMPG after an administrator resumes syncing or completes a manual sync.</p>
      ) : failed ? (
        <p className="mt-2">The sync schedule could not be loaded. Ask an administrator to check Settings → Integrations for when changes will appear in LMPG.</p>
      ) : batches === null ? (
        <p className="mt-2" role="status">Loading sync schedule…</p>
      ) : batches.length === 0 ? (
        <p className="mt-2">No sync batches are configured. An administrator must set up syncing before changes in {label} can appear in LMPG.</p>
      ) : (
        <>
          <p className="mt-2">Changes appear in LMPG after the next successful sync of the source containing that person. Some changes need administrator review before they appear.</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {batches.map(batch => <li key={batch.id}>{batch.name}: {scheduleDescription(batch)}</li>)}
          </ul>
        </>
      )}
    </div>
  );
};

export default ProviderManagedPeopleNote;
