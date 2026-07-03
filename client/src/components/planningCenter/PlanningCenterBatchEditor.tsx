import React, { useEffect, useState } from 'react';
import { gatheringsAPI, integrationsAPI, SyncBatch, SyncBatchInput } from '../../services/api';
import logger from '../../utils/logger';
import MembershipAllowlistEditor from './MembershipAllowlistEditor';
import FieldFilterEditor, { FieldFilterRule } from './FieldFilterEditor';

interface GatheringOption { id: number; name: string; }

interface Props {
  batch: SyncBatch | null; // null = creating a new batch
  onSaved: (batch: SyncBatch) => void;
  onCancel: () => void;
}

export default function PlanningCenterBatchEditor({ batch, onSaved, onCancel }: Props) {
  const [name, setName] = useState(batch?.name || '');
  const [membershipFilterEnabled, setMembershipFilterEnabled] = useState(batch?.membershipFilterEnabled ?? true);
  const [membershipAllowlist, setMembershipAllowlist] = useState<string[]>(batch?.membershipAllowlist || []);
  const [fieldFilterEnabled, setFieldFilterEnabled] = useState(batch?.fieldFilterEnabled ?? false);
  const [fieldFilters, setFieldFilters] = useState<FieldFilterRule[]>(batch?.fieldFilters || []);
  const [defaultPeopleType, setDefaultPeopleType] = useState<SyncBatchInput['defaultPeopleType']>(batch?.defaultPeopleType || 'regular');
  const [gatheringMode, setGatheringMode] = useState<'none' | 'existing' | 'new'>(batch?.gatheringTypeId ? 'existing' : 'none');
  const [gatheringTypeId, setGatheringTypeId] = useState<number | null>(batch?.gatheringTypeId ?? null);
  const [newGatheringName, setNewGatheringName] = useState('');
  const [gatherings, setGatherings] = useState<GatheringOption[]>([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(batch?.scheduleEnabled ?? false);
  const [scheduleFrequency, setScheduleFrequency] = useState<SyncBatchInput['scheduleFrequency']>(batch?.scheduleFrequency || 'weekly');
  const [scheduleDay, setScheduleDay] = useState(batch?.scheduleDay ?? 1);
  const [membershipValues, setMembershipValues] = useState<{ membership: string; count: number }[]>([]);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    gatheringsAPI.getAll()
      .then((r: any) => setGatherings(r.data.gatherings || r.data || []))
      .catch(() => setGatherings([]));
    loadMembershipSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMembershipSummary = async () => {
    setMembershipLoading(true); setMembershipError(null);
    try {
      const sum = await integrationsAPI.getPlanningCenterMembershipSummary();
      setMembershipValues(sum.data.values || []);
    } catch (e: any) {
      setMembershipError(e.response?.data?.error || 'Failed to load membership categories.');
    } finally {
      setMembershipLoading(false);
    }
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      let finalGatheringTypeId: number | null = null;
      if (gatheringMode === 'existing') {
        finalGatheringTypeId = gatheringTypeId;
      } else if (gatheringMode === 'new') {
        if (!newGatheringName.trim()) { setError('Enter a name for the new gathering.'); setSaving(false); return; }
        const created = await gatheringsAPI.create({
          name: newGatheringName.trim(),
          attendanceType: 'standard',
          dayOfWeek: 'Sunday',
          startTime: '10:00',
          frequency: 'weekly',
        });
        finalGatheringTypeId = (created.data as any).id ?? null;
        if (!finalGatheringTypeId) { setError('Failed to create the new gathering.'); setSaving(false); return; }
      }
      const payload: SyncBatchInput = {
        name: name.trim(),
        membershipFilterEnabled,
        membershipAllowlist,
        fieldFilterEnabled,
        fieldFilters,
        defaultPeopleType,
        gatheringTypeId: finalGatheringTypeId,
        scheduleEnabled,
        scheduleFrequency,
        scheduleDay,
      };
      const res = batch
        ? await integrationsAPI.updatePlanningCenterSyncBatch(batch.id, payload)
        : await integrationsAPI.createPlanningCenterSyncBatch(payload);
      onSaved(res.data.batch);
    } catch (e: any) {
      logger.error('Failed to save PCO sync batch', e);
      setError(e.response?.data?.error || 'Failed to save sync batch.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 border border-gray-200 dark:border-gray-700 rounded-md p-4">
      <div>
        <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Batch name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Members, Youth Group, Visitors"
          className="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
        />
      </div>

      <div className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Filter by membership category</p>
          <button type="button" onClick={() => setMembershipFilterEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${membershipFilterEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
            role="switch" aria-checked={membershipFilterEnabled}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${membershipFilterEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        {membershipFilterEnabled && (
          <MembershipAllowlistEditor
            values={membershipValues}
            loading={membershipLoading}
            error={membershipError}
            selected={membershipAllowlist}
            onChange={setMembershipAllowlist}
            onReload={loadMembershipSummary}
          />
        )}
      </div>

      <div className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Filter by custom tab fields</p>
          <button type="button" onClick={() => setFieldFilterEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${fieldFilterEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
            role="switch" aria-checked={fieldFilterEnabled}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${fieldFilterEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        {fieldFilterEnabled && (
          <FieldFilterEditor rules={fieldFilters} onChange={setFieldFilters} />
        )}
      </div>

      {!membershipFilterEnabled && !fieldFilterEnabled && (
        <div className="text-sm text-yellow-700 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md px-3 py-2">
          No one will match this batch — enable at least one filter above.
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">New people from this batch are added as</label>
        <select
          value={defaultPeopleType}
          onChange={(e) => setDefaultPeopleType(e.target.value as SyncBatchInput['defaultPeopleType'])}
          className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
        >
          <option value="regular">Regulars</option>
          <option value="local_visitor">Local visitors</option>
          <option value="traveller_visitor">Traveller visitors</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Add everyone from this batch to a gathering</label>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={gatheringMode}
            onChange={(e) => setGatheringMode(e.target.value as 'none' | 'existing' | 'new')}
            className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
          >
            <option value="none">Don't assign a gathering</option>
            <option value="existing">Existing gathering</option>
            <option value="new">Create a new gathering</option>
          </select>
          {gatheringMode === 'existing' && (
            <select
              value={gatheringTypeId ?? ''}
              onChange={(e) => setGatheringTypeId(e.target.value ? Number(e.target.value) : null)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
            >
              <option value="">Choose…</option>
              {gatherings.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {gatheringMode === 'new' && (
            <input
              type="text"
              value={newGatheringName}
              onChange={(e) => setNewGatheringName(e.target.value)}
              placeholder="New gathering name"
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
            />
          )}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">Schedule</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setScheduleEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${scheduleEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
            role="switch" aria-checked={scheduleEnabled}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${scheduleEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
          <span className="text-sm text-gray-700 dark:text-gray-300">{scheduleEnabled ? 'Runs automatically' : 'Manual only'}</span>
          {scheduleEnabled && (
            <>
              <select
                value={scheduleFrequency}
                onChange={(e) => setScheduleFrequency(e.target.value as SyncBatchInput['scheduleFrequency'])}
                className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              {scheduleFrequency === 'weekly' && (
                <select
                  value={scheduleDay}
                  onChange={(e) => setScheduleDay(Number(e.target.value))}
                  className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
                >
                  <option value={0}>Sunday</option>
                  <option value={1}>Monday</option>
                  <option value={2}>Tuesday</option>
                  <option value={3}>Wednesday</option>
                  <option value={4}>Thursday</option>
                  <option value={5}>Friday</option>
                  <option value={6}>Saturday</option>
                </select>
              )}
            </>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !name.trim() || (!membershipFilterEnabled && !fieldFilterEnabled)}
          className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : batch ? 'Save batch' : 'Create batch'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm underline text-gray-600 dark:text-gray-300">Cancel</button>
      </div>
    </div>
  );
}
