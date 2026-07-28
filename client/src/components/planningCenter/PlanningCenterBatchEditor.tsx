import React, { useEffect, useMemo, useState } from 'react';
import { gatheringsAPI, integrationsAPI, peopleSyncAPI, type SyncBatch, type SyncBatchInput, type SyncBatchSettingsInput } from '../../services/api';
import BatchFilterControls from '../peopleSync/BatchFilterControls';
import type { BooleanFilterConfigV2, PeopleSyncBatch, PeopleType } from '../peopleSync/types';
import { ordinalDay } from '../../utils/pcoSchedule';
import Modal from '../Modal';

interface GatheringOption { id: number; name: string; }
type LegacyPcoBatch = SyncBatch;
type PcoBatchBoundary = PeopleSyncBatch | LegacyPcoBatch;
const emptyFilter = (): BooleanFilterConfigV2 => ({ branches: [], exclusions: [] });

interface Props {
  /** @deprecated The legacy half of this boundary is removed with the panel migration in Task 12. */
  batch: PcoBatchBoundary | null;
  onSaved: (batch: PeopleSyncBatch<BooleanFilterConfigV2>) => void;
  onCancel: () => void;
}

function isV2FilterConfig(value: unknown): value is BooleanFilterConfigV2 {
  return typeof value === 'object' && value !== null && 'branches' in value && Array.isArray(value.branches) &&
    'exclusions' in value && Array.isArray(value.exclusions);
}

function isGenericBatch(batch: PcoBatchBoundary): batch is PeopleSyncBatch<BooleanFilterConfigV2> {
  return 'provider' in batch && batch.provider === 'planning_center' &&
    'filterSchemaVersion' in batch && batch.filterSchemaVersion === 2 &&
    'filterRevision' in batch && typeof batch.filterRevision === 'number' &&
    isV2FilterConfig(batch.filterConfig) &&
    (batch.draftFilterConfig === null || isV2FilterConfig(batch.draftFilterConfig));
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const data = response.data;
      if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') return data.error;
    }
  }
  return fallback;
}

export default function PlanningCenterBatchEditor({ batch: boundaryBatch, onSaved, onCancel }: Props) {
  const initial = useMemo(() => boundaryBatch && isGenericBatch(boundaryBatch) ? boundaryBatch : null, [boundaryBatch]);
  const initialSettings = boundaryBatch;
  const [currentBatch, setCurrentBatch] = useState(initial);
  const [name, setName] = useState(initialSettings?.name || '');
  const [defaultPeopleType, setDefaultPeopleType] = useState<PeopleType>(initialSettings?.defaultPeopleType || 'regular');
  const [gatherings, setGatherings] = useState<GatheringOption[]>([]);
  const [gatheringMode, setGatheringMode] = useState<'none' | 'existing' | 'new'>(initialSettings?.gatheringTypeId ? 'existing' : 'none');
  const [gatheringTypeId, setGatheringTypeId] = useState<number | null>(initialSettings?.gatheringTypeId ?? null);
  const [newGatheringName, setNewGatheringName] = useState('');
  const [gatheringAutoRemoveEnabled, setGatheringAutoRemoveEnabled] = useState(initialSettings?.gatheringAutoRemoveEnabled ?? false);
  const [confirmAutoRemove, setConfirmAutoRemove] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(initialSettings?.scheduleEnabled ?? false);
  const [scheduleFrequency, setScheduleFrequency] = useState<'daily' | 'weekly' | 'monthly'>(initialSettings?.scheduleFrequency || 'weekly');
  const [scheduleDay, setScheduleDay] = useState(initialSettings?.scheduleDay ?? 1);
  const [filterConfig, setFilterConfig] = useState<BooleanFilterConfigV2>(initial?.draftFilterConfig ?? initial?.filterConfig ?? emptyFilter());
  const [broadAcknowledged, setBroadAcknowledged] = useState(false);
  const [hasBroadWarning, setHasBroadWarning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdGathering, setCreatedGathering] = useState<{ id: number; name: string } | null>(null);
  const readOnlyLegacy = boundaryBatch !== null && initial === null;

  useEffect(() => { gatheringsAPI.getAll().then((response: { data: GatheringOption[] | { gatherings?: GatheringOption[] } }) => setGatherings(Array.isArray(response.data) ? response.data : response.data.gatherings || [])).catch(() => setGatherings([])); }, []);

  const changeFrequency = (frequency: 'daily' | 'weekly' | 'monthly') => {
    setScheduleFrequency(frequency);
    setScheduleDay((day) => frequency === 'weekly' ? (day >= 0 && day <= 6 ? day : 1) : frequency === 'monthly' ? (day >= 1 && day <= 31 ? day : 1) : day);
  };

  const save = async () => {
    setError(null);
    if (readOnlyLegacy) return;
    if (!name.trim()) { setError('Enter a batch name.'); return; }
    if (hasBroadWarning && !broadAcknowledged) { setError('Acknowledge the broad filter before saving.'); return; }
    setSaving(true);
    try {
      let savedGathering = createdGathering;
      let finalGatheringTypeId: number | null = null;
      if (gatheringMode === 'existing') {
        if (!gatheringTypeId) { setError('Choose a gathering.'); return; }
        finalGatheringTypeId = gatheringTypeId;
      }
      if (gatheringMode === 'new') {
        if (!newGatheringName.trim()) { setError('Enter a name for the new gathering.'); return; }
        if (createdGathering?.name === newGatheringName.trim()) finalGatheringTypeId = createdGathering.id;
        else {
          const created = await gatheringsAPI.create({ name: newGatheringName.trim(), attendanceType: 'standard', dayOfWeek: 'Sunday', startTime: '10:00', frequency: 'weekly' });
          finalGatheringTypeId = created.data.id ?? null;
          if (finalGatheringTypeId) {
            savedGathering = { id: finalGatheringTypeId, name: newGatheringName.trim() };
            setCreatedGathering(savedGathering);
          }
        }
        if (!finalGatheringTypeId) { setError('Failed to create the new gathering.'); return; }
      }
      const common = { name: name.trim(), defaultPeopleType, gatheringTypeId: finalGatheringTypeId,
        gatheringAutoRemoveEnabled: finalGatheringTypeId === null ? false : gatheringAutoRemoveEnabled,
        scheduleEnabled, scheduleFrequency, scheduleDay };
      if (!currentBatch) {
        const payload: SyncBatchInput & { filterSchemaVersion: 2; draftFilterConfig: BooleanFilterConfigV2; broadMatchAcknowledged: boolean } = {
          ...common, membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [],
          filterSchemaVersion: 2, draftFilterConfig: filterConfig, broadMatchAcknowledged: broadAcknowledged,
        };
        const created = await integrationsAPI.createPlanningCenterSyncBatch(payload);
        if (!isGenericBatch(created.data.batch)) { setError('The server returned a batch with unsupported filter criteria.'); return; }
        onSaved(created.data.batch);
        return;
      }
      const nonFilterPayload: SyncBatchSettingsInput = common;
      try { await integrationsAPI.updatePlanningCenterSyncBatch(currentBatch.id, nonFilterPayload); }
      catch (saveError) { setError(savedGathering ? `The gathering was created, but batch settings were not saved: ${errorMessage(saveError, 'Failed to save batch settings.')}` : errorMessage(saveError, 'Failed to save batch settings.')); return; }
      let draft;
      try {
        draft = await peopleSyncAPI.saveFilterDraft('planning_center', currentBatch.id, { filterConfig, broadMatchAcknowledged: broadAcknowledged });
      } catch (draftError) { setError(`${savedGathering ? 'The gathering was created and ' : ''}Batch settings were saved, but filter draft was not: ${errorMessage(draftError, 'Failed to save filter draft.')}`); return; }
      if (!isGenericBatch(draft.data.batch)) { setError('The server returned a batch with unsupported filter criteria.'); return; }
      onSaved(draft.data.batch);
    } catch (saveError) { setError(savedGathering ? `The gathering was created, but the batch was not saved: ${errorMessage(saveError, 'Failed to save sync batch.')}` : errorMessage(saveError, 'Failed to save sync batch.')); }
    finally { setSaving(false); }
  };

  const selectedGathering = gatheringMode === 'existing' ? gatheringTypeId : null;
  return <div className="space-y-5 rounded-md border border-gray-200 p-4 dark:border-gray-700">
    <div><label htmlFor="pco-batch-name" className="mb-1 block text-sm font-medium">Batch name</label><input id="pco-batch-name" value={name} disabled={readOnlyLegacy} onChange={(event) => setName(event.target.value)} className="w-full rounded-md border-gray-300 text-sm dark:border-gray-600 dark:bg-gray-700" /></div>
    {readOnlyLegacy ? <section className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"><h2 className="font-semibold">Who qualifies?</h2><p className="mt-1">This legacy batch’s criteria must be upgraded from the integration panel before editing.</p></section> : <BatchFilterControls provider="planning_center" batch={currentBatch} value={filterConfig} onChange={(value) => { setFilterConfig(value); setBroadAcknowledged(false); }} enabled={currentBatch?.enabled ?? true} defaultPeopleType={defaultPeopleType} gatheringTypeId={selectedGathering} broadAcknowledged={broadAcknowledged} onBroadAcknowledgedChange={setBroadAcknowledged} onBroadWarningChange={setHasBroadWarning} onDiscarded={(discarded) => { setCurrentBatch(discarded); setFilterConfig(discarded.filterConfig); setBroadAcknowledged(false); }} />}
    <div><label className="mb-1 block text-sm font-medium" htmlFor="pco-people-type">New people from this batch are added as</label><select id="pco-people-type" value={defaultPeopleType} disabled={readOnlyLegacy} onChange={(event) => setDefaultPeopleType(event.target.value as PeopleType)}><option value="regular">Regulars</option><option value="local_visitor">Local visitors</option><option value="traveller_visitor">Traveller visitors</option></select></div>
    <div><label className="mb-1 block text-sm font-medium" htmlFor="pco-gathering-mode">Add everyone from this batch to a gathering</label><select id="pco-gathering-mode" aria-label="Gathering assignment" value={gatheringMode} disabled={readOnlyLegacy} onChange={(event) => { const mode = event.target.value as 'none' | 'existing' | 'new'; setGatheringMode(mode); setCreatedGathering(null); if (mode === 'none') setGatheringAutoRemoveEnabled(false); }}><option value="none">Don't assign a gathering</option><option value="existing">Existing gathering</option><option value="new">Create a new gathering</option></select>{gatheringMode === 'existing' ? <select aria-label="Existing gathering" value={gatheringTypeId ?? ''} disabled={readOnlyLegacy} onChange={(event) => setGatheringTypeId(event.target.value ? Number(event.target.value) : null)}><option value="">Choose…</option>{gatherings.map((gathering) => <option key={gathering.id} value={gathering.id}>{gathering.name}</option>)}</select> : null}{gatheringMode === 'new' ? <input aria-label="New gathering name" value={newGatheringName} disabled={readOnlyLegacy} onChange={(event) => { setNewGatheringName(event.target.value); setCreatedGathering(null); }} placeholder="New gathering name" /> : null}</div>
    {gatheringMode !== 'none' ? <label className="flex items-center gap-2 text-sm"><button type="button" role="switch" aria-label="Automatically remove people from this gathering" aria-checked={gatheringAutoRemoveEnabled} disabled={readOnlyLegacy || gatheringMode === 'existing' && gatheringTypeId === null} onClick={() => gatheringAutoRemoveEnabled ? setGatheringAutoRemoveEnabled(false) : setConfirmAutoRemove(true)} className="h-6 w-11 rounded-full bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-600" /><span>Automatically remove people from this gathering when they no longer match this batch</span></label> : null}
    <div><p className="mb-2 text-sm font-medium">Schedule</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scheduleEnabled} disabled={readOnlyLegacy} onChange={(event) => setScheduleEnabled(event.target.checked)} />Runs automatically</label>{scheduleEnabled ? <div className="mt-2 flex flex-wrap gap-2"><select aria-label="Schedule frequency" value={scheduleFrequency} disabled={readOnlyLegacy} onChange={(event) => changeFrequency(event.target.value as 'daily' | 'weekly' | 'monthly')}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>{scheduleFrequency === 'weekly' ? <select aria-label="Schedule day" value={scheduleDay} disabled={readOnlyLegacy} onChange={(event) => setScheduleDay(Number(event.target.value))}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option key={day} value={index}>{day}</option>)}</select> : null}{scheduleFrequency === 'monthly' ? <select aria-label="Schedule day" value={scheduleDay} disabled={readOnlyLegacy} onChange={(event) => setScheduleDay(Number(event.target.value))}>{Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{ordinalDay(day)}</option>)}</select> : null}</div> : null}</div>
    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    <div className="flex gap-3"><button type="button" onClick={() => { void save(); }} disabled={readOnlyLegacy || saving || hasBroadWarning && !broadAcknowledged} className="rounded bg-green-600 px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? 'Saving…' : boundaryBatch ? 'Save batch' : 'Create batch'}</button><button type="button" onClick={onCancel} className="text-sm underline">Cancel</button></div>
    <Modal isOpen={confirmAutoRemove} onClose={() => setConfirmAutoRemove(false)}><div className="rounded bg-white p-6 dark:bg-gray-800"><h3 className="text-lg font-medium">Enable automatic removal for this batch?</h3><p className="mt-2 text-sm">This can remove people from the gathering when they no longer match the batch.</p><div className="mt-4 flex gap-3"><button type="button" onClick={() => { setGatheringAutoRemoveEnabled(true); setConfirmAutoRemove(false); }}>Enable automatic removal</button><button type="button" onClick={() => setConfirmAutoRemove(false)}>Cancel</button></div></div></Modal>
  </div>;
}
