import React, { useEffect, useRef, useState } from 'react';
import { integrationsAPI, gatheringsAPI } from '../services/api';
import { useWebSocket } from '../contexts/WebSocketContext';
import Modal from './Modal';

interface ScheduleSuggestion {
  dayOfWeek: string | null;
  startTime: string | null;
  frequency: string | null;
  irregular: boolean;
}

interface PcoEvent {
  pcoEventId: string;
  eventName: string;
  checkinCount: number;
  sessionCount: number;
  firstDate: string | null;
  lastDate: string | null;
  serviceTime?: string;
  suggestedGatheringTypeId?: number | null;
  suggestedSchedule?: ScheduleSuggestion;
  savedMapping?: Mapping | null;
  alreadyImportedThrough?: string | null;
}

interface Gathering { id: number; name: string; }

type UserAssignment = { mode: 'none' | 'me' | 'copy'; sourceGatheringTypeId?: number };

type Mapping = {
  target: 'skip' | 'existing' | 'new';
  gatheringTypeId?: number;
  newGatheringName?: string;
  schedule?: ScheduleSuggestion;
  userAssignment?: UserAssignment;
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
  const [notLinked, setNotLinked] = useState(false);
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [recencyWeeks, setRecencyWeeks] = useState(defaultRecencyWeeks);
  const autoLoadStarted = useRef(false);

  const { socket } = useWebSocket();
  const [progress, setProgress] = useState<{ phase: string; percent: number } | null>(null);
  const jobIdRef = useRef<string>('');

  const newJobId = () => {
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    jobIdRef.current = id;
    return id;
  };

  useEffect(() => {
    gatheringsAPI.getAll()
      .then((r: any) => setGatherings(r.data.gatherings || r.data || []))
      .catch(() => setGatherings([]));
  }, []);

  useEffect(() => {
    integrationsAPI.getCheckinImportState()
      .then((r: any) => {
        const lr = r.data?.lastRange;
        if (lr) { setStartDate(lr.startDate || ''); setEndDate(lr.endDate || ''); }
      })
      .catch(() => { /* no saved state */ });
  }, []);

  useEffect(() => {
    if (!socket) return;
    const handler = (data: { jobId: string; phase: string; percent: number }) => {
      if (data.jobId !== jobIdRef.current) return;
      setProgress({ phase: data.phase, percent: data.percent });
    };
    socket.on('pco:import_progress', handler);
    return () => { socket.off('pco:import_progress', handler); };
  }, [socket]);

  const buildMappingsPayload = () =>
    Object.entries(mappings)
      .filter(([, m]) => m.target !== 'skip')
      .map(([pcoEventId, m]) => ({
        pcoEventId,
        target: m.target as 'existing' | 'new',
        gatheringTypeId: m.target === 'existing' ? m.gatheringTypeId : undefined,
        newGatheringName: m.target === 'new' ? m.newGatheringName : undefined,
        schedule: m.target === 'new' ? m.schedule : undefined,
        userAssignment: m.target === 'new' ? m.userAssignment : undefined,
      }));

  const validMappings = () =>
    buildMappingsPayload().filter(m =>
      (m.target === 'new' && !!m.newGatheringName && m.newGatheringName.trim() !== '') ||
      (m.target === 'existing' && !!m.gatheringTypeId)
    );

  const findEvents = async (range?: { startDate: string; endDate: string }) => {
    const query = range ?? { startDate, endDate };
    setLoading(true); setError(null); setNotLinked(false); setPreview(null); setDone(null);
    const jobId = newJobId(); setProgress({ phase: 'fetching', percent: 0 });
    try {
      const r = await integrationsAPI.getCheckinEvents({ ...query, jobId });
      setEvents(r.data.events || []);
      setStartDate(r.data.startDate ?? '');
      setEndDate(r.data.endDate ?? '');
      const defaults: Record<string, Mapping> = {};
      for (const e of r.data.events || []) {
        if (e.savedMapping) {
          defaults[e.pcoEventId] = e.savedMapping;
        } else if (e.suggestedGatheringTypeId) {
          defaults[e.pcoEventId] = { target: 'existing', gatheringTypeId: e.suggestedGatheringTypeId };
        } else {
          defaults[e.pcoEventId] = {
            target: 'new',
            newGatheringName: e.eventName,
            schedule: e.suggestedSchedule || { dayOfWeek: null, startTime: null, frequency: null, irregular: false },
            userAssignment: { mode: 'none' },
          };
        }
      }
      setMappings(defaults);
    } catch (e: any) {
      if (e.response?.data?.code === 'PCO_NOT_LINKED') {
        setNotLinked(true);
      } else {
        setError(e.response?.data?.error || 'Failed to load events.');
      }
    } finally { setLoading(false); setProgress(null); }
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
    if (showSkip && autoLoaded && !error && !notLinked && events.length === 0 && onSkip) {
      onSkip();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoaded, events.length, error, notLinked, showSkip]);

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
    setConfirmOpen(false);
    setLoading(true); setError(null);
    const jobId = newJobId(); setProgress({ phase: 'fetching', percent: 0 });
    try {
      const body: any = { startDate, endDate, jobId, mappings: validMappings() };
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
    } finally { setLoading(false); setProgress(null); }
  };

  const setMap = (id: string, patch: Partial<Mapping>) =>
    setMappings((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const setSchedule = (id: string, patch: Partial<ScheduleSuggestion>) =>
    setMappings((prev) => ({
      ...prev,
      [id]: { ...prev[id], schedule: { dayOfWeek: null, startTime: null, frequency: null, irregular: false, ...prev[id]?.schedule, ...patch } },
    }));

  const setAssignment = (id: string, patch: Partial<UserAssignment>) =>
    setMappings((prev) => ({
      ...prev,
      [id]: { ...prev[id], userAssignment: { mode: 'none', ...prev[id]?.userAssignment, ...patch } },
    }));

  const renderNewGatheringPanel = (ev: PcoEvent, m: Mapping) => {
    const sched = m.schedule || { dayOfWeek: null, startTime: null, frequency: null, irregular: false };
    const ua = m.userAssignment || { mode: 'none' as const };
    const inputCls = 'mt-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-2 py-1 text-sm';
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-gray-700 dark:text-gray-300">Name
            <input value={m.newGatheringName || ''} placeholder="Gathering name"
              onChange={(e) => setMap(ev.pcoEventId, { newGatheringName: e.target.value })}
              className={`block w-56 ${inputCls}`} />
          </label>
          <label className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-1 self-center">
            <input type="checkbox" checked={sched.irregular}
              onChange={(e) => setSchedule(ev.pcoEventId, { irregular: e.target.checked })} />
            Irregular (no fixed schedule)
          </label>
        </div>
        {!sched.irregular && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm text-gray-700 dark:text-gray-300">Day
              <select value={sched.dayOfWeek || ''} onChange={(e) => setSchedule(ev.pcoEventId, { dayOfWeek: e.target.value || null })}
                className={`block ${inputCls}`}>
                <option value="">—</option>
                {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="text-sm text-gray-700 dark:text-gray-300">Time
              <input type="time" value={sched.startTime || ''} onChange={(e) => setSchedule(ev.pcoEventId, { startTime: e.target.value || null })}
                className={`block ${inputCls}`} />
            </label>
            <label className="text-sm text-gray-700 dark:text-gray-300">Frequency
              <select value={sched.frequency || ''} onChange={(e) => setSchedule(ev.pcoEventId, { frequency: e.target.value || null })}
                className={`block ${inputCls}`}>
                <option value="">—</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
          </div>
        )}
        <label className="text-sm text-gray-700 dark:text-gray-300 block">Assign staff users
          <select
            value={ua.mode === 'copy' && ua.sourceGatheringTypeId ? `copy:${ua.sourceGatheringTypeId}` : (ua.mode === 'copy' ? 'none' : ua.mode)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'none' || v === 'me') setAssignment(ev.pcoEventId, { mode: v, sourceGatheringTypeId: undefined });
              else if (v.startsWith('copy:')) {
                const parsed = Number(v.slice(5));
                if (parsed) setAssignment(ev.pcoEventId, { mode: 'copy', sourceGatheringTypeId: parsed });
              }
            }}
            className={`block ${inputCls}`}>
            <option value="none">None</option>
            <option value="me">Me</option>
            {gatherings.map((g) => <option key={g.id} value={`copy:${g.id}`}>Same as {g.name}</option>)}
          </select>
        </label>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Import attendance history from Planning Center</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Pull historical check-ins into LMPG as present-only attendance. Existing LMPG attendance is never overwritten.
          Leave dates blank to import all available history.
        </p>
      </div>

      {notLinked ? (
        <div className="rounded-md bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 px-4 py-3 space-y-2">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Link your people to Planning Center first — set up and run a sync batch — before importing check-in history.
            Importing now would create a new record for every attendee instead of matching them to your existing people.
          </p>
          {showSkip && onSkip && (
            <button type="button" onClick={() => onSkip()} className="text-sm underline text-amber-800 dark:text-amber-200">
              Skip this step
            </button>
          )}
        </div>
      ) : (
        <>
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

      {progress && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-600 dark:text-gray-300">
            <span>{progress.phase === 'writing' ? 'Writing attendance…' : 'Fetching from Planning Center…'}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded h-2 overflow-hidden">
            <div className="bg-primary-600 h-2 transition-all duration-300" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="space-y-3">
          <div className="space-y-3">
            {events.map((ev) => {
              const m = mappings[ev.pcoEventId] || { target: 'skip' };
              return (
                <div key={ev.pcoEventId}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100">{ev.eventName}</span>
                        {ev.alreadyImportedThrough && (
                          <span className="inline-block text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                            Imported through {ev.alreadyImportedThrough}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {ev.checkinCount} check-ins · {ev.sessionCount} dates · {ev.firstDate ?? '—'} to {ev.lastDate ?? '—'}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select value={m.target}
                        onChange={(e) => setMap(ev.pcoEventId, { target: e.target.value as Mapping['target'] })}
                        className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-2 py-1 text-sm">
                        <option value="skip">Skip</option>
                        <option value="new">New gathering</option>
                        <option value="existing">Existing gathering</option>
                      </select>
                      {m.target === 'existing' && (
                        <select value={m.gatheringTypeId || ''}
                          onChange={(e) => setMap(ev.pcoEventId, { gatheringTypeId: Number(e.target.value) })}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-2 py-1 text-sm">
                          <option value="">Choose…</option>
                          {gatherings.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  {m.target === 'new' && (
                    <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3">
                      {renderNewGatheringPanel(ev, m)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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
          <button onClick={() => setConfirmOpen(true)} disabled={loading}
            className="mt-2 bg-green-600 hover:bg-green-700 text-white rounded px-3 py-2 disabled:opacity-50">
            Confirm import
          </button>
        </div>
      )}

      <Modal isOpen={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-5 space-y-4">
          <h4 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Import check-ins?</h4>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Import these check-ins as attendance? Existing LMPG records will not be changed.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmOpen(false)}
              className="rounded px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button onClick={runExecute}
              className="rounded px-3 py-2 text-sm bg-green-600 hover:bg-green-700 text-white">
              Import
            </button>
          </div>
        </div>
      </Modal>


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
      </>
      )}
    </div>
  );
};

export default PCOCheckinImport;
