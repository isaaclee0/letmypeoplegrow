import React, { useCallback, useEffect, useState } from 'react';
import type {
  ContextualEngagementSettingsDto,
  EngagementDrilldownPage,
  EngagementPersonDrilldownRow,
  EngagementSessionDrilldownRow,
  EngagementSettingsDto,
} from '../../services/api';
import { reportsAPI } from '../../services/api';
import EngagementEvidence from './EngagementEvidence';
import EngagementTierBadge from './EngagementTierBadge';
import AccessibleDialog from './AccessibleDialog';

type DrilldownRow = EngagementPersonDrilldownRow | EngagementSessionDrilldownRow;

const formatDate = (value: string) => new Intl.DateTimeFormat('en-AU', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`));

interface EngagementDrilldownProps {
  kind: 'people' | 'sessions';
  token: string;
  title: string;
  selectedGatheringNames?: string[];
  settings: EngagementSettingsDto | ContextualEngagementSettingsDto;
  onClose: () => void;
}

function gatheringList(names: string[]): string {
  return new Intl.ListFormat('en-AU', { style: 'long', type: 'conjunction' }).format(names);
}

const EngagementDrilldown: React.FC<EngagementDrilldownProps> = ({ kind, token, title, selectedGatheringNames, settings, onClose }) => {
  const [rows, setRows] = useState<DrilldownRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setError('');
    try {
      const response = kind === 'people'
        ? await reportsAPI.getEngagementPeople({ segment: token, cursor: nextCursor, limit: 50 })
        : await reportsAPI.getEngagementSessions({ series: token, cursor: nextCursor, limit: 50 });
      const page = response.data as EngagementDrilldownPage<DrilldownRow>;
      setRows((current) => nextCursor ? [...current, ...page.rows] : page.rows);
      setCursor(page.nextCursor);
    } catch {
      setError('Could not load these details.');
    } finally {
      setLoading(false);
    }
  }, [kind, token]);

  useEffect(() => { void load(); }, [load]);

  const displayedTitle = kind === 'sessions' && selectedGatheringNames?.length
    ? `${gatheringList(selectedGatheringNames)} attendance sessions`
    : title;

  return (
    <AccessibleDialog className="z-50" label={displayedTitle} onClose={onClose}>
      <div className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{displayedTitle}</h2>
          <button type="button" onClick={onClose} aria-label="Close details" className="rounded px-2 py-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Close</button>
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p>}
        <ul className="mt-4 divide-y divide-gray-200 text-gray-900 dark:divide-gray-700 dark:text-gray-100">
          {rows.map((row) => {
            if (row.rowType === 'attendance_session') {
              return <li key={`session-${row.sessionId}`} className="py-3"><strong>{row.gatheringName}</strong> — {formatDate(row.sessionDate)}; attendance {row.attendance}{row.uniquePeople === null ? '' : `; ${row.uniquePeople} unique people`}</li>;
            }
            const name = `${row.firstName} ${row.lastName}`;
            return (
              <li key={`${row.rowType}-${row.individualId}`} className="py-3">
                <strong>{name}</strong>
                {row.rowType === 'engagement_profile' && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div>Primary: <EngagementTierBadge status={row.primary} settings={settings as EngagementSettingsDto} /> <EngagementEvidence status={row.primary} /></div>
                    {row.community.status !== 'not_assigned' && <div>Other participation: <EngagementTierBadge status={row.community} settings={settings as EngagementSettingsDto} /> <EngagementEvidence status={row.community} /></div>}
                  </div>
                )}
                {row.rowType === 'visitor_journey' && <div className="mt-1 text-sm">First attendance {formatDate(row.firstAttendanceDate)}</div>}
              </li>
            );
          })}
        </ul>
        {loading && <p role="status" className="mt-4 text-sm text-gray-500 dark:text-gray-400">Loading…</p>}
        {!loading && rows.length === 0 && !error && <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">No matching records.</p>}
        {cursor && !loading && <button type="button" className="mt-4 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white" onClick={() => void load(cursor)}>Load more</button>}
      </div>
    </AccessibleDialog>
  );
};

export default EngagementDrilldown;
