import React, { useEffect, useRef, useState } from 'react';
import { integrationsAPI, gatheringsAPI } from '../services/api';

interface PcoEvent {
  pcoEventId: string;
  eventName: string;
  checkinCount: number;
  sessionCount: number;
  firstDate: string | null;
  lastDate: string | null;
}

interface Gathering { id: number; name: string; }

type Mapping = {
  target: 'skip' | 'existing' | 'new';
  gatheringTypeId?: number;
  newGatheringName?: string;
};

interface PCOCheckinImportProps {
  /** Onboarding mode: also auto-assign active recent attendees to gathering rolls. */
  assignToGatherings?: boolean;
  /** Recency window (weeks) for auto-assignment; shown as an editable input when assignToGatherings. */
  defaultRecencyWeeks?: number;
  /** Show a Skip button (onboarding). */
  showSkip?: boolean;
  /** Called when the user skips the step (onboarding). */
  onSkip?: () => void;
  /** Called after a successful import (onboarding advances). */
  onComplete?: (result: any) => void;
}

const PCOCheckinImport: React.FC<PCOCheckinImportProps> = ({
  assignToGatherings = false,
  defaultRecencyWeeks = 8,
  showSkip = false,
  onSkip,
  onComplete,
}) => {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [events, setEvents] = useState<PcoEvent[]>([]);
  const [gatherings, setGatherings] = useState<Gathering[]>([]);
  const [mappings, setMappings] = useState<Record<string, Mapping>>({});
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [recencyWeeks, setRecencyWeeks] = useState(defaultRecencyWeeks);
  const autoLoadStarted = useRef(false);

  useEffect(() => {
    gatheringsAPI.getAll()
      .then((r: any) => setGatherings(r.data.gatherings || r.data || []))
      .catch(() => setGatherings([]));
  }, []);

  const buildMappingsPayload = () =>
    Object.entries(mappings)
      .filter(([, m]) => m.target !== 'skip')
      .map(([pcoEventId, m]) => ({
        pcoEventId,
        target: m.target as 'existing' | 'new',
        gatheringTypeId: m.target === 'existing' ? m.gatheringTypeId : undefined,
        newGatheringName: m.target === 'new' ? m.newGatheringName : undefined,
      }));

  const validMappings = () =>
    buildMappingsPayload().filter(m =>
      (m.target === 'new' && !!m.newGatheringName && m.newGatheringName.trim() !== '') ||
      (m.target === 'existing' && !!m.gatheringTypeId)
    );

  const findEvents = async (range?: { startDate: string; endDate: string }) => {
    const query = range ?? { startDate, endDate };
    setLoading(true); setError(null); setPreview(null); setDone(null);
    try {
      const r = await integrationsAPI.getCheckinEvents(query);
      setEvents(r.data.events || []);
      setStartDate(r.data.startDate ?? '');
      setEndDate(r.data.endDate ?? '');
      const defaults: Record<string, Mapping> = {};
      for (const e of r.data.events || []) {
        defaults[e.pcoEventId] = { target: 'new', newGatheringName: e.eventName };
      }
      setMappings(defaults);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load events.');
    } finally { setLoading(false); }
  };

  // Auto-load all available check-ins once on mount so the user sees what's
  // available without clicking. The "Find events" button still re-queries with
  // a custom date range afterwards.
  useEffect(() => {
    if (autoLoadStarted.current) return;
    autoLoadStarted.current = true;
    findEvents({ startDate: '', endDate: '' })
      .catch(() => { /* errors surface via the error state in findEvents */ })
      .finally(() => setAutoLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (showSkip && autoLoaded && !error && events.length === 0 && onSkip) {
      onSkip();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoaded, events.length, error, showSkip]);

  const runPreview = async () => {
    setLoading(true); setError(null);
    try {
      const r = await integrationsAPI.previewCheckinImport({ startDate, endDate, mappings: validMappings() });
      setPreview(r.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Preview failed.');
    } finally { setLoading(false); }
  };

  const runExecute = async () => {
    if (!window.confirm('Import these check-ins as attendance? Existing LMPG records will not be changed.')) return;
    setLoading(true); setError(null);
    try {
      const body: any = { startDate, endDate, mappings: validMappings() };
      if (assignToGatherings) {
        body.assignToGatherings = true;
        body.recencyWeeks = recencyWeeks;
      }
      const r = await integrationsAPI.executeCheckinImport(body);
      setDone(r.data);
      setPreview(null);
      if (onComplete) onComplete(r.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Import failed.');
    } finally { setLoading(false); }
  };

  const setMap = (id: string, patch: Partial<Mapping>) =>
    setMappings((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Import attendance history from Planning Center</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Pull historical check-ins into LMPG as present-only attendance. Existing LMPG attendance is never overwritten.
          Leave dates blank to import all available history.
        </p>
      </div>

      {events.length > 0 && (
        <div className="rounded bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-sm px-3 py-2">
          Found {events.reduce((n, e) => n + e.checkinCount, 0)} check-ins across {events.length} event{events.length === 1 ? '' : 's'} available to import.
        </div>
      )}

      {autoLoaded && !error && events.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">No Planning Center check-ins found.</div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-700 dark:text-gray-300">Start
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="block border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-2 py-1" />
        </label>
        <label className="text-sm text-gray-700 dark:text-gray-300">End
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="block border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-2 py-1" />
        </label>
        <button onClick={() => findEvents()} disabled={loading}
          className="bg-primary-600 text-white rounded px-3 py-2 disabled:opacity-50">
          {loading ? 'Loading…' : 'Find events'}
        </button>
        {assignToGatherings && (
          <label className="text-sm text-gray-700 dark:text-gray-300">
            Treat as a current regular if they attended in the last
            <input
              type="number"
              min={1}
              value={recencyWeeks}
              onChange={(e) => setRecencyWeeks(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="mx-2 w-16 border rounded px-2 py-1 border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
            weeks
          </label>
        )}
      </div>

      {error && <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>}

      {events.length > 0 && (
        <div className="space-y-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400">
                <th className="py-1">PCO Event</th><th>Check-ins</th><th>Dates</th><th>Import as</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => {
                const m = mappings[ev.pcoEventId] || { target: 'skip' };
                return (
                  <tr key={ev.pcoEventId} className="border-t border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100">
                    <td className="py-2">{ev.eventName}</td>
                    <td>{ev.checkinCount} ({ev.sessionCount} dates)</td>
                    <td>{ev.firstDate ?? '—'} → {ev.lastDate ?? '—'}</td>
                    <td className="space-x-2">
                      <select value={m.target}
                        onChange={(e) => setMap(ev.pcoEventId, { target: e.target.value as Mapping['target'] })}
                        className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-1 py-1">
                        <option value="skip">Skip</option>
                        <option value="new">New gathering</option>
                        <option value="existing">Existing gathering</option>
                      </select>
                      {m.target === 'new' && (
                        <input value={m.newGatheringName || ''} placeholder="Gathering name"
                          onChange={(e) => setMap(ev.pcoEventId, { newGatheringName: e.target.value })}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-1 py-1" />
                      )}
                      {m.target === 'existing' && (
                        <select value={m.gatheringTypeId || ''}
                          onChange={(e) => setMap(ev.pcoEventId, { gatheringTypeId: Number(e.target.value) })}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-1 py-1">
                          <option value="">Choose…</option>
                          {gatherings.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button onClick={runPreview} disabled={loading || validMappings().length === 0}
            className="bg-gray-700 dark:bg-gray-600 text-white rounded px-3 py-2 disabled:opacity-50">Preview import</button>
          {showSkip && (
            <button
              onClick={() => onSkip && onSkip()}
              className="text-gray-600 dark:text-gray-300 underline text-sm"
            >
              Skip this step
            </button>
          )}
          {validMappings().length === 0 && events.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">Select at least one event and choose where to import it.</p>
          )}
        </div>
      )}

      {preview && (
        <div className="rounded bg-gray-50 dark:bg-gray-800 p-3 text-sm space-y-1 text-gray-900 dark:text-gray-100">
          <div className="font-medium">Preview</div>
          <div>Records to write (present): <strong>{preview.recordsToWrite}</strong></div>
          <div>Sessions involved: {preview.sessionsInvolved}</div>
          <div>Matched people: {preview.matchedPeople}</div>
          <div>New (inactive) people to create: {preview.peopleToCreate}</div>
          <button onClick={runExecute} disabled={loading}
            className="mt-2 bg-green-600 hover:bg-green-700 text-white rounded px-3 py-2 disabled:opacity-50">
            Confirm import
          </button>
        </div>
      )}

      {done && (
        <div className="rounded bg-green-50 dark:bg-green-900/30 p-3 text-sm space-y-1 text-green-800 dark:text-green-200">
          <div className="font-medium text-green-800 dark:text-green-200">Import complete</div>
          <div>Records written: {done.recordsWritten}</div>
          <div>Records skipped (already in LMPG): {done.recordsSkipped}</div>
          <div>Sessions created: {done.sessionsCreated}</div>
          <div>Gatherings created: {done.gatheringsCreated}</div>
          <div>People created (inactive): {done.createdPeople}</div>
        </div>
      )}
    </div>
  );
};

export default PCOCheckinImport;
