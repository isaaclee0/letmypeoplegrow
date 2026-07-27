import React, { useState } from 'react';
import { elvantoSyncAPI, gatheringsAPI } from '../../services/api';
import type { ElvantoFilterConfig, ElvantoMetadata, ElvantoSyncBatchInput, PeopleSyncBatch, PeopleType } from '../peopleSync/types';
import Modal from '../Modal';
import { ordinalDay } from '../../utils/pcoSchedule';
import ElvantoFilterEditor, { defaultElvantoFilter } from './ElvantoFilterEditor';

export interface ElvantoGatheringOption { id: number; name: string; }

export interface ElvantoBatchEditorProps {
  // Task 17's listBatches client method currently returns the shared generic
  // PeopleSyncBatch default, so accept that DTO at this boundary and narrow
  // the provider-owned filter config once inside the editor.
  batch: PeopleSyncBatch | null;
  metadata: ElvantoMetadata;
  gatherings: ElvantoGatheringOption[];
  onSaved: (batch: PeopleSyncBatch) => void;
  onCancel: () => void;
}

function validSchedule(frequency: 'daily' | 'weekly' | 'monthly', day: number): boolean {
  return frequency === 'daily' || (frequency === 'weekly' ? day >= 0 && day <= 6 : day >= 1 && day <= 31);
}

export default function ElvantoBatchEditor({ batch, metadata, gatherings, onSaved, onCancel }: ElvantoBatchEditorProps) {
  const [name, setName] = useState(batch?.name || 'Elvanto people');
  const [enabled, setEnabled] = useState(batch?.enabled ?? true);
  const [filterConfig, setFilterConfig] = useState<ElvantoFilterConfig>((batch?.filterConfig as ElvantoFilterConfig | undefined) || defaultElvantoFilter());
  const [defaultPeopleType, setDefaultPeopleType] = useState<PeopleType>(batch?.defaultPeopleType || 'regular');
  const [gatheringMode, setGatheringMode] = useState<'none' | 'existing' | 'new'>(batch?.gatheringTypeId ? 'existing' : 'none');
  const [gatheringTypeId, setGatheringTypeId] = useState<number | null>(batch?.gatheringTypeId ?? null);
  const [newGatheringName, setNewGatheringName] = useState('');
  const [gatheringAutoRemoveEnabled, setGatheringAutoRemoveEnabled] = useState(batch?.gatheringAutoRemoveEnabled ?? false);
  const [confirmAutoRemove, setConfirmAutoRemove] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(batch?.scheduleEnabled ?? false);
  const [scheduleFrequency, setScheduleFrequency] = useState<'daily' | 'weekly' | 'monthly'>(batch?.scheduleFrequency || 'weekly');
  const [scheduleDay, setScheduleDay] = useState(batch?.scheduleDay ?? 1);
  const [currentMetadata, setCurrentMetadata] = useState(metadata);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeFrequency = (frequency: 'daily' | 'weekly' | 'monthly') => {
    setScheduleFrequency(frequency);
    setScheduleDay((current) => frequency === 'weekly' ? (current >= 0 && current <= 6 ? current : 1) : frequency === 'monthly' ? (current >= 1 && current <= 31 ? current : 1) : current);
  };

  const refreshMetadata = async () => {
    setRefreshing(true);
    try { const response = await elvantoSyncAPI.refreshMetadata(); setCurrentMetadata(response.data.metadata); }
    catch { setError('Failed to refresh Elvanto metadata.'); }
    finally { setRefreshing(false); }
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) { setError('Enter a batch name.'); return; }
    if (scheduleEnabled && !validSchedule(scheduleFrequency, scheduleDay)) { setError('Choose a valid schedule day.'); return; }
    if (gatheringMode === 'existing' && !gatheringTypeId) { setError('Choose a gathering.'); return; }
    setSaving(true);
    try {
      let finalGatheringTypeId: number | null = null;
      if (gatheringMode === 'existing') finalGatheringTypeId = gatheringTypeId;
      if (gatheringMode === 'new') {
        if (!newGatheringName.trim()) { setError('Enter a name for the new gathering.'); return; }
        const created = await gatheringsAPI.create({ name: newGatheringName.trim(), attendanceType: 'standard', dayOfWeek: 'Sunday', startTime: '10:00', frequency: 'weekly' });
        finalGatheringTypeId = created.data.id ?? null;
        if (!finalGatheringTypeId) { setError('Failed to create the new gathering.'); return; }
      }
      const payload: ElvantoSyncBatchInput<ElvantoFilterConfig> = {
        name: name.trim(), enabled, filterSchemaVersion: 1, filterConfig, defaultPeopleType,
        gatheringTypeId: finalGatheringTypeId,
        gatheringAutoRemoveEnabled: finalGatheringTypeId === null ? false : gatheringAutoRemoveEnabled,
        scheduleEnabled, scheduleFrequency, scheduleDay,
      };
      const response = batch ? await elvantoSyncAPI.updateBatch(batch.id, payload) : await elvantoSyncAPI.createBatch(payload);
      onSaved(response.data.batch);
    } catch { setError('Failed to save sync batch.'); }
    finally { setSaving(false); }
  };

  const included = new Set(filterConfig.statuses);
  return <div className="space-y-5 border border-gray-200 dark:border-gray-700 rounded-md p-4">
    <div><label htmlFor="elvanto-batch-name" className="block text-sm font-medium mb-1">Batch name</label><input id="elvanto-batch-name" value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700" /></div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enable this batch</label>
    <div className="border-t border-gray-200 dark:border-gray-700 pt-4"><div className="flex flex-wrap items-center justify-between gap-2 mb-3"><h2 className="text-base font-medium">Who qualifies?</h2><button type="button" onClick={refreshMetadata} disabled={refreshing} className="text-sm underline">{refreshing ? 'Refreshing metadata…' : 'Refresh metadata'}</button></div><ElvantoFilterEditor metadata={currentMetadata} value={filterConfig} onChange={setFilterConfig} /></div>
    <div className="rounded border border-gray-200 dark:border-gray-700 p-3"><p className="text-sm font-medium mb-2">Qualifying people by status</p><div className="grid grid-cols-2 gap-1 text-sm">{(['active', 'contact', 'archived', 'deceased'] as Status[]).map((status) => <span key={status}>{status[0].toUpperCase() + status.slice(1)} — {included.has(status) ? 'included' : 'excluded'}</span>)}</div></div>
    <div><label className="block text-sm font-medium mb-1" htmlFor="elvanto-people-type">New people from this batch are added as</label><select id="elvanto-people-type" value={defaultPeopleType} onChange={(event) => setDefaultPeopleType(event.target.value as PeopleType)}><option value="regular">Regulars</option><option value="local_visitor">Local visitors</option><option value="traveller_visitor">Traveller visitors</option></select></div>
    <div><label className="block text-sm font-medium mb-1" htmlFor="elvanto-gathering-mode">Add everyone from this batch to a gathering</label><select id="elvanto-gathering-mode" aria-label="Gathering assignment" value={gatheringMode} onChange={(event) => { const mode = event.target.value as 'none' | 'existing' | 'new'; setGatheringMode(mode); if (mode === 'none') setGatheringAutoRemoveEnabled(false); }}><option value="none">Don't assign a gathering</option><option value="existing">Existing gathering</option><option value="new">Create a new gathering</option></select>
      {gatheringMode === 'existing' && <select aria-label="Existing gathering" value={gatheringTypeId ?? ''} onChange={(event) => setGatheringTypeId(event.target.value ? Number(event.target.value) : null)}><option value="">Choose…</option>{gatherings.map((gathering) => <option key={gathering.id} value={gathering.id}>{gathering.name}</option>)}</select>}
      {gatheringMode === 'new' && <input aria-label="New gathering name" value={newGatheringName} onChange={(event) => setNewGatheringName(event.target.value)} placeholder="New gathering name" />}
    </div>
    {gatheringMode !== 'none' && <label className="flex items-center gap-2 text-sm"><button type="button" role="switch" aria-label="Automatically remove people from this gathering" aria-checked={gatheringAutoRemoveEnabled} disabled={gatheringMode === 'existing' && gatheringTypeId === null} onClick={() => gatheringAutoRemoveEnabled ? setGatheringAutoRemoveEnabled(false) : setConfirmAutoRemove(true)} className="h-6 w-11 rounded-full bg-gray-200 dark:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50" /><span>Automatically remove people from this gathering when they no longer match this batch</span></label>}
    <div><p className="text-sm font-medium mb-2">Schedule</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scheduleEnabled} onChange={(event) => setScheduleEnabled(event.target.checked)} />Runs automatically</label>{scheduleEnabled && <div className="mt-2 flex flex-wrap gap-2"><select aria-label="Schedule frequency" value={scheduleFrequency} onChange={(event) => changeFrequency(event.target.value as 'daily' | 'weekly' | 'monthly')}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>{scheduleFrequency === 'weekly' && <select aria-label="Schedule day" value={scheduleDay} onChange={(event) => setScheduleDay(Number(event.target.value))}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option key={day} value={index}>{day}</option>)}</select>}{scheduleFrequency === 'monthly' && <select aria-label="Schedule day" value={scheduleDay} onChange={(event) => setScheduleDay(Number(event.target.value))}>{Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{ordinalDay(day)}</option>)}</select>}</div>}</div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <div className="flex gap-3"><button type="button" onClick={save} disabled={saving} className="rounded bg-green-600 px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? 'Saving…' : batch ? 'Save batch' : 'Create batch'}</button><button type="button" onClick={onCancel} className="text-sm underline">Cancel</button></div>
    <Modal isOpen={confirmAutoRemove} onClose={() => setConfirmAutoRemove(false)}><div className="rounded bg-white dark:bg-gray-800 p-6"><h3 className="text-lg font-medium">Enable automatic removal for this batch?</h3><p className="mt-2 text-sm">This can remove people from the gathering when they no longer match the batch.</p><div className="mt-4 flex gap-3"><button type="button" onClick={() => { setGatheringAutoRemoveEnabled(true); setConfirmAutoRemove(false); }}>Enable automatic removal</button><button type="button" onClick={() => setConfirmAutoRemove(false)}>Cancel</button></div></div></Modal>
  </div>;
}

type Status = ElvantoFilterConfig['statuses'][number];
