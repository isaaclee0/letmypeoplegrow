import React, { useMemo, useState } from 'react';
import { elvantoSyncAPI, gatheringsAPI, peopleSyncAPI } from '../../services/api';
import BatchFilterControls from '../peopleSync/BatchFilterControls';
import type { BooleanFilterConfigV2, ElvantoMetadata, ElvantoSyncBatchInput, PeopleSyncBatch, PeopleType } from '../peopleSync/types';
import Modal from '../Modal';
import { ordinalDay } from '../../utils/pcoSchedule';

export interface ElvantoGatheringOption { id: number; name: string; }
export interface ElvantoBatchEditorProps {
  batch: PeopleSyncBatch<BooleanFilterConfigV2> | null;
  /** @deprecated Task 11 uses canonical provider-neutral metadata instead. */
  metadata: ElvantoMetadata;
  gatherings: ElvantoGatheringOption[];
  onSaved: (batch: PeopleSyncBatch<BooleanFilterConfigV2>) => void;
  onCancel: () => void;
}
const emptyFilter = (): BooleanFilterConfigV2 => ({ branches: [], exclusions: [] });
function validSchedule(frequency: 'daily' | 'weekly' | 'monthly', day: number) { return frequency === 'daily' || frequency === 'weekly' ? day >= 0 && day <= 6 : day >= 1 && day <= 31; }
function message(error: unknown, fallback: string): string { if (typeof error === 'object' && error !== null && 'response' in error) { const response = error.response; if (typeof response === 'object' && response !== null && 'data' in response) { const data = response.data; if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') return data.error; } } return fallback; }
function isV2Filter(value: unknown): value is BooleanFilterConfigV2 {
  return typeof value === 'object' && value !== null && 'branches' in value && Array.isArray(value.branches) &&
    'exclusions' in value && Array.isArray(value.exclusions);
}
function normaliseReturnedBatch(batch: PeopleSyncBatch): PeopleSyncBatch<BooleanFilterConfigV2> {
  return {
    ...batch,
    filterConfig: isV2Filter(batch.filterConfig) ? batch.filterConfig : emptyFilter(),
    draftFilterConfig: isV2Filter(batch.draftFilterConfig) ? batch.draftFilterConfig : null,
  };
}

export default function ElvantoBatchEditor({ batch: initialBatch, metadata: _metadata, gatherings, onSaved, onCancel }: ElvantoBatchEditorProps) {
  const initial = useMemo(() => initialBatch, [initialBatch]);
  const [currentBatch, setCurrentBatch] = useState(initial);
  const [name, setName] = useState(initial?.name || 'Elvanto people');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [defaultPeopleType, setDefaultPeopleType] = useState<PeopleType>(initial?.defaultPeopleType || 'regular');
  const [filterConfig, setFilterConfig] = useState(initial?.draftFilterConfig ?? initial?.filterConfig ?? emptyFilter());
  const [gatheringMode, setGatheringMode] = useState<'none' | 'existing' | 'new'>(initial?.gatheringTypeId ? 'existing' : 'none');
  const [gatheringTypeId, setGatheringTypeId] = useState<number | null>(initial?.gatheringTypeId ?? null);
  const [newGatheringName, setNewGatheringName] = useState('');
  const [gatheringAutoRemoveEnabled, setGatheringAutoRemoveEnabled] = useState(initial?.gatheringAutoRemoveEnabled ?? false);
  const [confirmAutoRemove, setConfirmAutoRemove] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(initial?.scheduleEnabled ?? false);
  const [scheduleFrequency, setScheduleFrequency] = useState<'daily' | 'weekly' | 'monthly'>(initial?.scheduleFrequency || 'weekly');
  const [scheduleDay, setScheduleDay] = useState(initial?.scheduleDay ?? 1);
  const [broadAcknowledged, setBroadAcknowledged] = useState(false);
  const [hasBroadWarning, setHasBroadWarning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeFrequency = (frequency: 'daily' | 'weekly' | 'monthly') => { setScheduleFrequency(frequency); setScheduleDay((day) => frequency === 'weekly' ? (day >= 0 && day <= 6 ? day : 1) : frequency === 'monthly' ? (day >= 1 && day <= 31 ? day : 1) : day); };
  const save = async () => {
    setError(null);
    if (!name.trim()) { setError('Enter a batch name.'); return; }
    if (scheduleEnabled && !validSchedule(scheduleFrequency, scheduleDay)) { setError('Choose a valid schedule day.'); return; }
    if (gatheringMode === 'existing' && !gatheringTypeId) { setError('Choose a gathering.'); return; }
    if (hasBroadWarning && !broadAcknowledged) { setError('Acknowledge the broad filter before saving.'); return; }
    setSaving(true);
    try {
      let finalGatheringTypeId: number | null = gatheringMode === 'existing' ? gatheringTypeId : null;
      if (gatheringMode === 'new') { if (!newGatheringName.trim()) { setError('Enter a name for the new gathering.'); return; } const created = await gatheringsAPI.create({ name: newGatheringName.trim(), attendanceType: 'standard', dayOfWeek: 'Sunday', startTime: '10:00', frequency: 'weekly' }); finalGatheringTypeId = created.data.id ?? null; if (!finalGatheringTypeId) { setError('Failed to create the new gathering.'); return; } }
      const common = { name: name.trim(), enabled, defaultPeopleType, gatheringTypeId: finalGatheringTypeId, gatheringAutoRemoveEnabled: finalGatheringTypeId === null ? false : gatheringAutoRemoveEnabled, scheduleEnabled, scheduleFrequency, scheduleDay };
      if (!currentBatch) {
        const payload: ElvantoSyncBatchInput<BooleanFilterConfigV2> & { draftFilterConfig: BooleanFilterConfigV2; broadMatchAcknowledged: boolean } = { ...common, filterSchemaVersion: 2, filterConfig: emptyFilter(), draftFilterConfig: filterConfig, broadMatchAcknowledged: broadAcknowledged };
        const created = await elvantoSyncAPI.createBatch(payload);
        onSaved(normaliseReturnedBatch(created.data.batch));
        return;
      }
      let updated;
      try { updated = await elvantoSyncAPI.updateBatch(currentBatch.id, common); }
      catch (saveError) { setError(message(saveError, 'Failed to save batch settings.')); return; }
      try { await peopleSyncAPI.saveFilterDraft('elvanto', currentBatch.id, { filterConfig, broadMatchAcknowledged: broadAcknowledged }); }
      catch (draftError) { setError(message(draftError, 'Failed to save filter draft.')); return; }
      onSaved(normaliseReturnedBatch(updated.data.batch));
    } catch (saveError) { setError(message(saveError, 'Failed to save sync batch.')); }
    finally { setSaving(false); }
  };
  return <div className="space-y-5 rounded-md border border-gray-200 p-4 dark:border-gray-700">
    <div><label htmlFor="elvanto-batch-name" className="mb-1 block text-sm font-medium">Batch name</label><input id="elvanto-batch-name" value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700" /></div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enable this batch</label>
    <BatchFilterControls provider="elvanto" batch={currentBatch} value={filterConfig} onChange={(value) => { setFilterConfig(value); setBroadAcknowledged(false); }} enabled={enabled} defaultPeopleType={defaultPeopleType} gatheringTypeId={gatheringMode === 'existing' ? gatheringTypeId : null} broadAcknowledged={broadAcknowledged} onBroadAcknowledgedChange={setBroadAcknowledged} onBroadWarningChange={setHasBroadWarning} onDiscarded={(discarded) => { setCurrentBatch(discarded); setFilterConfig(discarded.filterConfig); setBroadAcknowledged(false); }} />
    <div><label className="mb-1 block text-sm font-medium" htmlFor="elvanto-people-type">New people from this batch are added as</label><select id="elvanto-people-type" value={defaultPeopleType} onChange={(event) => setDefaultPeopleType(event.target.value as PeopleType)}><option value="regular">Regulars</option><option value="local_visitor">Local visitors</option><option value="traveller_visitor">Traveller visitors</option></select></div>
    <div><label className="mb-1 block text-sm font-medium" htmlFor="elvanto-gathering-mode">Add everyone from this batch to a gathering</label><select id="elvanto-gathering-mode" aria-label="Gathering assignment" value={gatheringMode} onChange={(event) => { const mode = event.target.value as 'none' | 'existing' | 'new'; setGatheringMode(mode); if (mode === 'none') setGatheringAutoRemoveEnabled(false); }}><option value="none">Don't assign a gathering</option><option value="existing">Existing gathering</option><option value="new">Create a new gathering</option></select>{gatheringMode === 'existing' ? <select aria-label="Existing gathering" value={gatheringTypeId ?? ''} onChange={(event) => setGatheringTypeId(event.target.value ? Number(event.target.value) : null)}><option value="">Choose…</option>{gatherings.map((gathering) => <option key={gathering.id} value={gathering.id}>{gathering.name}</option>)}</select> : null}{gatheringMode === 'new' ? <input aria-label="New gathering name" value={newGatheringName} onChange={(event) => setNewGatheringName(event.target.value)} placeholder="New gathering name" /> : null}</div>
    {gatheringMode !== 'none' ? <label className="flex items-center gap-2 text-sm"><button type="button" role="switch" aria-label="Automatically remove people from this gathering" aria-checked={gatheringAutoRemoveEnabled} disabled={gatheringMode === 'existing' && gatheringTypeId === null} onClick={() => gatheringAutoRemoveEnabled ? setGatheringAutoRemoveEnabled(false) : setConfirmAutoRemove(true)} className="h-6 w-11 rounded-full bg-gray-200 dark:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50" /><span>Automatically remove people from this gathering when they no longer match this batch</span></label> : null}
    <div><p className="mb-2 text-sm font-medium">Schedule</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scheduleEnabled} onChange={(event) => setScheduleEnabled(event.target.checked)} />Runs automatically</label>{scheduleEnabled ? <div className="mt-2 flex flex-wrap gap-2"><select aria-label="Schedule frequency" value={scheduleFrequency} onChange={(event) => changeFrequency(event.target.value as 'daily' | 'weekly' | 'monthly')}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>{scheduleFrequency === 'weekly' ? <select aria-label="Schedule day" value={scheduleDay} onChange={(event) => setScheduleDay(Number(event.target.value))}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option key={day} value={index}>{day}</option>)}</select> : null}{scheduleFrequency === 'monthly' ? <select aria-label="Schedule day" value={scheduleDay} onChange={(event) => setScheduleDay(Number(event.target.value))}>{Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{ordinalDay(day)}</option>)}</select> : null}</div> : null}</div>
    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}<div className="flex gap-3"><button type="button" onClick={() => { void save(); }} disabled={saving || hasBroadWarning && !broadAcknowledged} className="rounded bg-green-600 px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? 'Saving…' : currentBatch ? 'Save batch' : 'Create batch'}</button><button type="button" onClick={onCancel} className="text-sm underline">Cancel</button></div>
    <Modal isOpen={confirmAutoRemove} onClose={() => setConfirmAutoRemove(false)}><div className="rounded bg-white p-6 dark:bg-gray-800"><h3 className="text-lg font-medium">Enable automatic removal for this batch?</h3><p className="mt-2 text-sm">This can remove people from the gathering when they no longer match the batch.</p><div className="mt-4 flex gap-3"><button type="button" onClick={() => { setGatheringAutoRemoveEnabled(true); setConfirmAutoRemove(false); }}>Enable automatic removal</button><button type="button" onClick={() => setConfirmAutoRemove(false)}>Cancel</button></div></div></Modal>
  </div>;
}
