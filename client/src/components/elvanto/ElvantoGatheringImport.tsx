import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { integrationsAPI } from '../../services/api';

interface ElvantoGroup {
  id: string;
  name: string;
  description?: string;
  meeting_day?: string;
  meeting_time?: string;
  meeting_frequency?: string;
}

interface ElvantoService {
  service_type?: { id: string; name: string };
}

interface ServiceType {
  id: string;
  name: string;
  count: number;
}

interface GatheringDraft {
  id: string;
  name: string;
  description: string;
  dayOfWeek: string;
  startTime: string;
  frequency: string;
  duplicate: boolean;
}

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function normalizedTime(value?: string): string {
  if (!value) return '10:00';
  const match = value.match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!match) return '10:00';
  let hour = Number(match[1]);
  const period = match[3]?.toUpperCase();
  if (period === 'PM' && hour < 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function normalizedFrequency(value?: string): string {
  const lower = value?.toLowerCase() || '';
  if (lower.includes('fortnight') || lower.includes('biweek')) return 'biweekly';
  if (lower.includes('month')) return 'monthly';
  return 'weekly';
}

export default function ElvantoGatheringImport({ connected }: { connected: boolean }) {
  const [groups, setGroups] = useState<ElvantoGroup[]>([]);
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [selectedServiceTypes, setSelectedServiceTypes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [drafts, setDrafts] = useState<GatheringDraft[]>([]);
  const [currentDraft, setCurrentDraft] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    try {
      const [groupsResponse, servicesResponse] = await Promise.all([
        integrationsAPI.getElvantoGroups({ per_page: 100 }),
        integrationsAPI.getElvantoServices({ per_page: 100 }),
      ]);
      setGroups(groupsResponse.data?.groups?.group || []);
      const services: ElvantoService[] = servicesResponse.data?.services?.service || [];
      const byId = new Map<string, ServiceType>();
      services.forEach((service) => {
        const type = service.service_type;
        if (!type?.id) return;
        const current = byId.get(type.id);
        byId.set(type.id, current ? { ...current, count: current.count + 1 } : { ...type, count: 1 });
      });
      setServiceTypes(Array.from(byId.values()));
    } catch {
      setError('Failed to load Elvanto gatherings.');
    } finally {
      setLoading(false);
    }
  }, [connected]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedCount = selectedGroups.size + selectedServiceTypes.size;
  const chosenGroups = useMemo(
    () => groups.filter((group) => selectedGroups.has(group.id)),
    [groups, selectedGroups],
  );

  const prepareImport = async () => {
    if (!selectedCount) return;
    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await integrationsAPI.checkGatheringDuplicates({
        groupIds: Array.from(selectedGroups),
        serviceTypeIds: Array.from(selectedServiceTypes),
      });
      const duplicateIds = new Set<string>((response.data?.duplicates || []).map((item: { id: string }) => item.id));
      const nextDrafts: GatheringDraft[] = [
        ...chosenGroups.map((group) => ({
          id: group.id,
          name: group.name,
          description: group.description || '',
          dayOfWeek: days.includes(group.meeting_day || '') ? group.meeting_day! : 'Sunday',
          startTime: normalizedTime(group.meeting_time),
          frequency: normalizedFrequency(group.meeting_frequency),
          duplicate: duplicateIds.has(group.id),
        })),
        ...serviceTypes.filter((type) => selectedServiceTypes.has(type.id)).map((type) => ({
          id: type.id,
          name: type.name,
          description: '',
          dayOfWeek: 'Sunday',
          startTime: '10:00',
          frequency: 'weekly',
          duplicate: duplicateIds.has(type.id),
        })),
      ];
      setDrafts(nextDrafts);
      setCurrentDraft(0);
    } catch {
      setError('Failed to check gathering details.');
    } finally {
      setImporting(false);
    }
  };

  const updateDraft = (patch: Partial<GatheringDraft>) => {
    setDrafts((current) => current.map((draft, index) => index === currentDraft ? { ...draft, ...patch } : draft));
  };

  const importGatherings = async () => {
    setImporting(true);
    setError(null);
    try {
      const gatheringInfo = Object.fromEntries(drafts.map((draft) => [draft.id, {
        name: draft.name,
        description: draft.description,
        dayOfWeek: draft.dayOfWeek,
        startTime: draft.startTime,
        frequency: draft.frequency,
      }]));
      const nameOverrides = Object.fromEntries(drafts.map((draft) => [draft.id, draft.name]));
      await integrationsAPI.importGatheringsFromElvanto({
        groupIds: Array.from(selectedGroups),
        serviceTypeIds: Array.from(selectedServiceTypes),
        gatheringInfo,
        nameOverrides,
      });
      setDrafts([]);
      setSelectedGroups(new Set());
      setSelectedServiceTypes(new Set());
      setMessage('Gatherings imported successfully.');
      await load();
    } catch {
      setError('Failed to import Elvanto gatherings.');
    } finally {
      setImporting(false);
    }
  };

  const draft = drafts[currentDraft];

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">One-time gathering import</h5>
          <p className="text-xs text-gray-500 dark:text-gray-400">Import Elvanto groups or service types as LMPG gatherings.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="text-sm underline">
          {loading ? 'Loading…' : 'Refresh gatherings'}
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <fieldset>
          <legend className="text-sm font-medium">Groups</legend>
          {groups.length === 0 && <p className="mt-1 text-xs text-gray-500">No groups found.</p>}
          {groups.map((group) => (
            <label key={group.id} className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selectedGroups.has(group.id)} onChange={() => setSelectedGroups((current) => {
                const next = new Set(current);
                if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                return next;
              })} />
              {group.name}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">Service types</legend>
          {serviceTypes.length === 0 && <p className="mt-1 text-xs text-gray-500">No service types found.</p>}
          {serviceTypes.map((type) => (
            <label key={type.id} className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selectedServiceTypes.has(type.id)} onChange={() => setSelectedServiceTypes((current) => {
                const next = new Set(current);
                if (next.has(type.id)) next.delete(type.id); else next.add(type.id);
                return next;
              })} />
              {type.name} ({type.count})
            </label>
          ))}
        </fieldset>
      </div>
      <button type="button" onClick={() => void prepareImport()} disabled={!selectedCount || importing} className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50">
        Review {selectedCount || ''} gathering{selectedCount === 1 ? '' : 's'}
      </button>

      {draft && (
        <div className="space-y-3 rounded-md bg-gray-50 p-4 dark:bg-gray-800">
          <p className="text-sm font-medium">Gathering {currentDraft + 1} of {drafts.length}</p>
          {draft.duplicate && <p className="text-sm text-amber-700">A gathering with this name already exists. Choose a different name.</p>}
          <label className="block text-sm">Name<input aria-label="Gathering name" className="mt-1 block w-full rounded border-gray-300" value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} /></label>
          <label className="block text-sm">Description<textarea aria-label="Gathering description" className="mt-1 block w-full rounded border-gray-300" value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })} /></label>
          <div className="grid grid-cols-3 gap-2">
            <select aria-label="Day of week" value={draft.dayOfWeek} onChange={(event) => updateDraft({ dayOfWeek: event.target.value })}>{days.map((day) => <option key={day}>{day}</option>)}</select>
            <input aria-label="Start time" type="time" value={draft.startTime} onChange={(event) => updateDraft({ startTime: event.target.value })} />
            <select aria-label="Frequency" value={draft.frequency} onChange={(event) => updateDraft({ frequency: event.target.value })}><option value="weekly">Weekly</option><option value="biweekly">Bi-weekly</option><option value="monthly">Monthly</option></select>
          </div>
          <div className="flex gap-3">
            {currentDraft < drafts.length - 1 ? (
              <button type="button" onClick={() => setCurrentDraft((index) => index + 1)}>Next</button>
            ) : (
              <button type="button" onClick={() => void importGatherings()} disabled={importing || drafts.some((item) => !item.name.trim())} className="rounded bg-green-600 px-3 py-2 text-sm text-white disabled:opacity-50">Import gatherings</button>
            )}
            <button type="button" onClick={() => setDrafts([])} className="text-sm underline">Cancel</button>
          </div>
        </div>
      )}
      {message && <p className="text-sm text-green-700">{message}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
