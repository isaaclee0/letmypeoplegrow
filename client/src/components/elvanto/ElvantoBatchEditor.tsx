import React, { useState } from 'react';
import { elvantoSyncAPI, gatheringsAPI, peopleSyncAPI } from '../../services/api';
import BatchSourceControls from '../peopleSync/BatchSourceControls';
import type { ElvantoSyncBatchInput, PeopleSyncBatch, PeopleSyncSourceState, PeopleType, SourceSelection } from '../peopleSync/types';
import Modal from '../Modal';
import { ordinalDay } from '../../utils/pcoSchedule';

export interface ElvantoGatheringOption { id: number; name: string; }
export interface ElvantoBatchEditorProps { batch: PeopleSyncBatch | null; gatherings: ElvantoGatheringOption[]; onSaved: (batch: PeopleSyncBatch) => void; onCancel: () => void; }
type CreatePayload = ElvantoSyncBatchInput & SourceSelection;
function message(error: unknown, fallback: string): string { if (typeof error === 'object' && error !== null && 'response' in error) { const response = error.response; if (typeof response === 'object' && response !== null && 'data' in response) { const data = response.data; if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') return data.error; } } return fallback; }

export default function ElvantoBatchEditor({ batch: initialBatch, gatherings, onSaved, onCancel }: ElvantoBatchEditorProps) {
  const [currentBatch, setCurrentBatch] = useState<PeopleSyncBatch | null>(initialBatch);
  const [enabled, setEnabled] = useState(initialBatch?.enabled ?? true);
  const [defaultPeopleType, setDefaultPeopleType] = useState<PeopleType>(initialBatch?.defaultPeopleType ?? 'regular');
  const [gatheringMode, setGatheringMode] = useState<'none' | 'existing' | 'new'>(initialBatch?.gatheringTypeId ? 'existing' : 'none');
  const [gatheringTypeId, setGatheringTypeId] = useState<number | null>(initialBatch?.gatheringTypeId ?? null);
  const [newGatheringName, setNewGatheringName] = useState('');
  const [createdGathering, setCreatedGathering] = useState<{ id: number; name: string } | null>(null);
  const [gatheringAutoRemoveEnabled, setGatheringAutoRemoveEnabled] = useState(initialBatch?.gatheringAutoRemoveEnabled ?? false);
  const [confirmAutoRemove, setConfirmAutoRemove] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(initialBatch?.scheduleEnabled ?? false);
  const [scheduleFrequency, setScheduleFrequency] = useState<'daily' | 'weekly' | 'monthly'>(initialBatch?.scheduleFrequency ?? 'weekly');
  const [scheduleDay, setScheduleDay] = useState(initialBatch?.scheduleDay ?? 1);
  const [selection, setSelection] = useState<SourceSelection | null>(initialBatch?.draftSource ? { sourceKind: initialBatch.draftSource.kind, sourceExternalId: initialBatch.draftSource.externalId } : initialBatch?.source ? { sourceKind: initialBatch.source.kind, sourceExternalId: initialBatch.source.externalId } : null);
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  // A draft source is already the effective editor selection. Saving another
  // field must not create a new source draft unless that identity changed.
  const selectedSource = currentBatch?.draftSource ?? currentBatch?.source ?? null;
  const sourceChanged = !!currentBatch && !!selection && (!selectedSource || selection.sourceKind !== selectedSource.kind || selection.sourceExternalId !== selectedSource.externalId);
  const sourceReviewPending = currentBatch?.needsSourceReview ?? false;
  const changeFrequency = (frequency: 'daily' | 'weekly' | 'monthly') => { setScheduleFrequency(frequency); setScheduleDay(day => frequency === 'weekly' ? (day >= 0 && day <= 6 ? day : 1) : frequency === 'monthly' ? (day >= 1 && day <= 31 ? day : 1) : day); };
  const save = async () => {
    setError(null); if (!selection) { setError('Choose a people source.'); return; }
    if (scheduleEnabled && (scheduleFrequency === 'weekly' && (scheduleDay < 0 || scheduleDay > 6) || scheduleFrequency === 'monthly' && (scheduleDay < 1 || scheduleDay > 31))) { setError('Choose a valid schedule day.'); return; }
    setSaving(true); let savedGathering = createdGathering;
    try {
      let finalGatheringTypeId: number | null = gatheringMode === 'existing' ? gatheringTypeId : null;
      if (gatheringMode === 'existing' && !finalGatheringTypeId) { setError('Choose a gathering.'); return; }
      if (gatheringMode === 'new') { if (!newGatheringName.trim()) { setError('Enter a name for the new gathering.'); return; } if (createdGathering?.name === newGatheringName.trim()) finalGatheringTypeId = createdGathering.id; else { const created = await gatheringsAPI.create({ name: newGatheringName.trim(), attendanceType: 'standard', dayOfWeek: 'Sunday', startTime: '10:00', frequency: 'weekly' }); finalGatheringTypeId = created.data.id ?? null; if (finalGatheringTypeId) { savedGathering = { id: finalGatheringTypeId, name: newGatheringName.trim() }; setCreatedGathering(savedGathering); } } if (!finalGatheringTypeId) { setError('Failed to create the new gathering.'); return; } }
      const common = { enabled, defaultPeopleType, gatheringTypeId: finalGatheringTypeId, gatheringAutoRemoveEnabled: finalGatheringTypeId === null ? false : gatheringAutoRemoveEnabled, scheduleEnabled, scheduleFrequency, scheduleDay };
      if (!currentBatch) { const created = await elvantoSyncAPI.createBatch({ ...common, ...selection } as CreatePayload); onSaved(created.data.batch); return; }
      try { await elvantoSyncAPI.updateBatch(currentBatch.id, common); } catch (cause) { setError(savedGathering ? `The gathering was created, but batch settings were not saved: ${message(cause, 'Failed to save batch settings.')}` : message(cause, 'Failed to save batch settings.')); return; }
      if (!sourceChanged) { onSaved(currentBatch); return; }
      try { const draft = await peopleSyncAPI.saveSourceDraft('elvanto', currentBatch.id, selection); onSaved(draft.data.batch as PeopleSyncBatch); } catch (cause) { setError(`${savedGathering ? 'The gathering was created and ' : ''}Batch settings were saved, but people source draft was not: ${message(cause, 'Failed to save people source draft.')}`); }
    } catch (cause) { setError(savedGathering ? `The gathering was created, but the batch was not saved: ${message(cause, 'Failed to save sync batch.')}` : message(cause, 'Failed to save sync batch.')); } finally { setSaving(false); }
  };
  return <div className="space-y-5 rounded-md border border-gray-200 p-4 dark:border-gray-700">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enable this batch</label>
    <BatchSourceControls provider="elvanto" batch={currentBatch} value={selection} onChange={setSelection} onDiscarded={(state: PeopleSyncSourceState) => { const next = { ...currentBatch!, ...state }; setCurrentBatch(next); setSelection(next.source ? { sourceKind: next.source.kind, sourceExternalId: next.source.externalId } : null); }} />
    <div><label className="mb-1 block text-sm font-medium" htmlFor="elvanto-people-type">New people from this batch are added as</label><select id="elvanto-people-type" value={defaultPeopleType} onChange={e => setDefaultPeopleType(e.target.value as PeopleType)}><option value="regular">Regulars</option><option value="local_visitor">Local visitors</option><option value="traveller_visitor">Traveller visitors</option></select></div>
    <div><label className="mb-1 block text-sm font-medium" htmlFor="elvanto-gathering-mode">Add everyone from this batch to a gathering</label><select id="elvanto-gathering-mode" aria-label="Gathering assignment" value={gatheringMode} onChange={e => { const mode = e.target.value as 'none' | 'existing' | 'new'; setGatheringMode(mode); setCreatedGathering(null); if (mode === 'none') setGatheringAutoRemoveEnabled(false); }}><option value="none">Don't assign a gathering</option><option value="existing">Existing gathering</option><option value="new">Create a new gathering</option></select>{gatheringMode === 'existing' && <select aria-label="Existing gathering" value={gatheringTypeId ?? ''} onChange={e => setGatheringTypeId(e.target.value ? Number(e.target.value) : null)}><option value="">Choose…</option>{gatherings.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}{gatheringMode === 'new' && <input aria-label="New gathering name" value={newGatheringName} onChange={e => { setNewGatheringName(e.target.value); setCreatedGathering(null); }} placeholder="New gathering name" />}</div>
    {gatheringMode !== 'none' && <label className="flex items-center gap-2 text-sm"><button type="button" role="switch" aria-label="Automatically remove people from this gathering" aria-checked={gatheringAutoRemoveEnabled} disabled={gatheringMode === 'existing' && gatheringTypeId === null} onClick={() => gatheringAutoRemoveEnabled ? setGatheringAutoRemoveEnabled(false) : setConfirmAutoRemove(true)} className="h-6 w-11 rounded-full bg-gray-200 dark:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50" /><span>Automatically remove people from this gathering when they no longer match this batch</span></label>}
    <div><p className="mb-2 text-sm font-medium">Schedule</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scheduleEnabled} disabled={sourceReviewPending} onChange={e => setScheduleEnabled(e.target.checked)} />Runs automatically</label>{sourceReviewPending && <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">Scheduled runs are blocked until you complete a full review.</p>}{scheduleEnabled && <div className="mt-2 flex flex-wrap gap-2"><select aria-label="Schedule frequency" value={scheduleFrequency} disabled={sourceReviewPending} onChange={e => changeFrequency(e.target.value as 'daily' | 'weekly' | 'monthly')}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>{scheduleFrequency === 'weekly' && <select aria-label="Schedule day" value={scheduleDay} disabled={sourceReviewPending} onChange={e => setScheduleDay(Number(e.target.value))}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day, i) => <option key={day} value={i}>{day}</option>)}</select>}{scheduleFrequency === 'monthly' && <select aria-label="Schedule day" value={scheduleDay} disabled={sourceReviewPending} onChange={e => setScheduleDay(Number(e.target.value))}>{Array.from({ length: 31 }, (_, i) => i + 1).map(day => <option key={day} value={day}>{ordinalDay(day)}</option>)}</select>}</div>}</div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}<div className="flex gap-3"><button type="button" onClick={() => void save()} disabled={saving} className="rounded bg-green-600 px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? 'Saving…' : currentBatch ? 'Save batch' : 'Create batch'}</button><button type="button" onClick={onCancel} className="text-sm underline">Cancel</button></div>
    <Modal isOpen={confirmAutoRemove} onClose={() => setConfirmAutoRemove(false)}><div className="rounded bg-white p-6 dark:bg-gray-800"><h3 className="text-lg font-medium">Enable automatic removal for this batch?</h3><p className="mt-2 text-sm">This can remove people from the gathering when they no longer match the batch.</p><div className="mt-4 flex gap-3"><button type="button" onClick={() => { setGatheringAutoRemoveEnabled(true); setConfirmAutoRemove(false); }}>Enable automatic removal</button><button type="button" onClick={() => setConfirmAutoRemove(false)}>Cancel</button></div></div></Modal>
  </div>;
}
