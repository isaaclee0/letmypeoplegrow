# Individual Attendance History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select one person on the People page, click "View Attendance," and see that person's full attendance history in a table, exportable to CSV.

**Architecture:** Extend the existing `GET /api/individuals/:id/attendance-history` endpoint to also return a full session-level `history` array (in addition to its existing summary fields). Build a new `AttendanceHistoryModal` React component that fetches this endpoint, renders the history as a filterable table, and exports it to CSV client-side. Wire a "View Attendance" button into `PeoplePage.tsx`'s existing floating-action-button bar, visible only when exactly one person is checked. Remove the now-dead `AttendanceInfoButton`/`useAttendanceData` code that this replaces (already unused — see Task 4).

**Tech Stack:** Express + `better-sqlite3` (server), React 19 + TypeScript + Tailwind (client), Vitest for client unit tests. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-07-01-individual-attendance-history-design.md`

---

## Task 1: Backend — extend attendance-history endpoint with full session history

**Files:**
- Modify: `server/routes/individuals.js:713-723` (the response-building section of the existing `GET /:id/attendance-history` route, which starts at line 599)

- [ ] **Step 1: Confirm the expected query result against real dev data**

Before touching code, verify the exact SQL this task will add produces the right rows, using the local dev database directly (the server has no automated test runner — there is no `test` script in `server/package.json` and no test files under `server/` — so this is the verification substitute for that route).

Run:
```bash
sqlite3 "server/data/churches/devch1.sqlite" <<'EOF'
.headers on
.mode column
SELECT
  as_table.session_date,
  gt.name as gathering_name,
  gt.id as gathering_id,
  ar.present
FROM attendance_records ar
JOIN attendance_sessions as_table ON ar.session_id = as_table.id
JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
WHERE ar.individual_id = 2
  AND ar.church_id = 'devch1'
  AND gt.attendance_type != 'headcount'
  AND as_table.excluded_from_stats = 0
ORDER BY as_table.session_date DESC;
EOF
```

Expected: 12 rows, newest first, starting `2026-03-22|Sunday Morning Service|1|1` and ending `2026-01-04|Sunday Morning Service|1|1`, with `present` alternating (specifically: present=1 on 2026-03-22, 2026-03-15, then 0 on 2026-03-08, 2026-03-01, 2026-02-22, then 1 on 2026-02-15, 2026-02-08, then 0 on 2026-02-01, then 1 on 2026-01-25, 2026-01-18, then 0 on 2026-01-11, then 1 on 2026-01-04). This individual (id=2, "Sarah Anderson") is only assigned to one gathering in this dataset, so the query's headcount/excluded filters aren't exercised by this row set alone — that's expected; they're still correct per the schema (headcount-mode gatherings never have `attendance_records` rows at all, per `server/config/schema.js`, so the filter is defensive/documents intent rather than something this particular dataset can falsify).

- [ ] **Step 2: Add the query and extend the response**

Open `server/routes/individuals.js`. Find the existing response block:

```javascript
    const response = {
      lastAttendance: lastAttendance.length > 0 ? {
        date: lastAttendance[0].session_date,
        gatheringName: lastAttendance[0].gathering_name,
        gatheringId: lastAttendance[0].gathering_id,
        recordedAt: lastAttendance[0].updated_at
      } : null,
      gatheringRegularity: Array.from(gatheringRegularity.values())
    };

    res.json(response);
```

Replace it with:

```javascript
    // Get full session-level history (present and absent), all-time, across all
    // standard-mode gatherings. Headcount-mode gatherings have no per-individual
    // attendance_records rows, so the attendance_type filter is defensive.
    const fullHistory = await Database.query(`
      SELECT
        as_table.session_date,
        gt.name as gathering_name,
        gt.id as gathering_id,
        ar.present
      FROM attendance_records ar
      JOIN attendance_sessions as_table ON ar.session_id = as_table.id
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      WHERE ar.individual_id = ?
        AND ar.church_id = ?
        AND gt.attendance_type != 'headcount'
        AND as_table.excluded_from_stats = 0
      ORDER BY as_table.session_date DESC
    `, [id, req.user.church_id]);

    const response = {
      lastAttendance: lastAttendance.length > 0 ? {
        date: lastAttendance[0].session_date,
        gatheringName: lastAttendance[0].gathering_name,
        gatheringId: lastAttendance[0].gathering_id,
        recordedAt: lastAttendance[0].updated_at
      } : null,
      gatheringRegularity: Array.from(gatheringRegularity.values()),
      history: fullHistory.map(row => ({
        date: row.session_date,
        gatheringId: row.gathering_id,
        gatheringName: row.gathering_name,
        present: !!row.present
      }))
    };

    res.json(response);
```

- [ ] **Step 3: Restart the dev server and check for startup errors**

```bash
docker-compose -f docker-compose.dev.yml restart server
docker-compose -f docker-compose.dev.yml logs --tail=50 server
```

Expected: server logs show a normal startup (e.g. "Server running on port 3001") with no stack traces or syntax errors. Full HTTP-level verification of this endpoint happens in Task 5 via the browser, since it requires an authenticated session cookie.

- [ ] **Step 4: Commit**

```bash
git add server/routes/individuals.js
git commit -m "feat(individuals): return full session history from attendance-history endpoint"
```

---

## Task 2: Frontend — CSV/filter pure logic utilities (TDD)

**Files:**
- Create: `client/src/utils/attendanceHistoryCsv.ts`
- Test: `client/src/utils/attendanceHistoryCsv.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/attendanceHistoryCsv.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildAttendanceHistoryCsv, filterHistoryByGathering, AttendanceHistoryEntry } from './attendanceHistoryCsv';

describe('filterHistoryByGathering', () => {
  const history: AttendanceHistoryEntry[] = [
    { date: '2026-03-22', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: true },
    { date: '2026-03-15', gatheringId: 2, gatheringName: 'Kids Church', present: false }
  ];

  it('returns all rows when gatheringId is null', () => {
    expect(filterHistoryByGathering(history, null)).toHaveLength(2);
  });

  it('returns only rows matching the given gatheringId', () => {
    const result = filterHistoryByGathering(history, 2);
    expect(result).toHaveLength(1);
    expect(result[0].gatheringName).toBe('Kids Church');
  });

  it('returns an empty array when no rows match', () => {
    expect(filterHistoryByGathering(history, 99)).toHaveLength(0);
  });
});

describe('buildAttendanceHistoryCsv', () => {
  it('produces a header row plus one row per entry', () => {
    const csv = buildAttendanceHistoryCsv([
      { date: '2026-03-22', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: true },
      { date: '2026-03-15', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: false }
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Date,Gathering,Status');
    expect(lines[1]).toBe('2026-03-22,Sunday Morning Service,Present');
    expect(lines[2]).toBe('2026-03-15,Sunday Morning Service,Absent');
  });

  it('quotes gathering names containing a comma', () => {
    const csv = buildAttendanceHistoryCsv([
      { date: '2026-03-22', gatheringId: 1, gatheringName: 'Youth, Group', present: true }
    ]);
    expect(csv.split('\n')[1]).toBe('2026-03-22,"Youth, Group",Present');
  });

  it('returns just the header for an empty list', () => {
    expect(buildAttendanceHistoryCsv([])).toBe('Date,Gathering,Status');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker-compose -f docker-compose.dev.yml exec client npx vitest run src/utils/attendanceHistoryCsv.test.ts
```

Expected: FAIL — `Cannot find module './attendanceHistoryCsv'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `client/src/utils/attendanceHistoryCsv.ts`:

```typescript
export interface AttendanceHistoryEntry {
  date: string;
  gatheringId: number;
  gatheringName: string;
  present: boolean;
}

export function filterHistoryByGathering(
  history: AttendanceHistoryEntry[],
  gatheringId: number | null
): AttendanceHistoryEntry[] {
  if (gatheringId === null) {
    return history;
  }
  return history.filter(row => row.gatheringId === gatheringId);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildAttendanceHistoryCsv(rows: AttendanceHistoryEntry[]): string {
  const headers = ['Date', 'Gathering', 'Status'];
  const lines = rows.map(row => [
    row.date,
    csvEscape(row.gatheringName),
    row.present ? 'Present' : 'Absent'
  ].join(','));
  return [headers.join(','), ...lines].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
docker-compose -f docker-compose.dev.yml exec client npx vitest run src/utils/attendanceHistoryCsv.test.ts
```

Expected: PASS, 7 tests passing (3 in `filterHistoryByGathering`, 4 in `buildAttendanceHistoryCsv`).

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/attendanceHistoryCsv.ts client/src/utils/attendanceHistoryCsv.test.ts
git commit -m "feat(people): add pure CSV/filter helpers for attendance history"
```

---

## Task 3: Frontend — `AttendanceHistoryModal` component

**Files:**
- Create: `client/src/components/people/AttendanceHistoryModal.tsx`

This component has no automated test — the codebase has no full-component test coverage anywhere under `client/src/components/` (existing `.test.ts` files test extracted pure logic only, per Task 2's pattern). It's verified manually in Task 5.

- [ ] **Step 1: Create the component**

Create `client/src/components/people/AttendanceHistoryModal.tsx`:

```tsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { format, parseISO } from 'date-fns';
import { individualsAPI } from '../../services/api';
import { buildAttendanceHistoryCsv, filterHistoryByGathering, AttendanceHistoryEntry } from '../../utils/attendanceHistoryCsv';

interface AttendanceHistoryResponse {
  lastAttendance: {
    date: string;
    gatheringName: string;
    gatheringId: number;
    recordedAt: string;
  } | null;
  gatheringRegularity: Array<{
    name: string;
    regularity: string;
    attendanceCount: number;
  }>;
  history: AttendanceHistoryEntry[];
}

interface AttendanceHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  personId: number | null;
  personName: string;
}

const formatDate = (dateString: string) => {
  try {
    return format(parseISO(dateString), 'MMM d, yyyy');
  } catch {
    return dateString;
  }
};

const AttendanceHistoryModal: React.FC<AttendanceHistoryModalProps> = ({
  isOpen,
  onClose,
  personId,
  personName
}) => {
  const [data, setData] = useState<AttendanceHistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedGatheringId, setSelectedGatheringId] = useState<number | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!personId) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await individualsAPI.getAttendanceHistory(personId);
      setData(response.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch attendance history');
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    if (isOpen && personId) {
      setSelectedGatheringId(null);
      fetchHistory();
    }
  }, [isOpen, personId, fetchHistory]);

  const gatheringOptions = useMemo(() => {
    if (!data) return [];
    const seen = new Map<number, string>();
    data.history.forEach(row => seen.set(row.gatheringId, row.gatheringName));
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [data]);

  const filteredHistory = useMemo(() => {
    if (!data) return [];
    return filterHistoryByGathering(data.history, selectedGatheringId);
  }, [data, selectedGatheringId]);

  const handleExportCsv = () => {
    const csv = buildAttendanceHistoryCsv(filteredHistory);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${personName.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!isOpen || !personId) return null;

  return createPortal(
    <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-10 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-2/3 shadow-lg rounded-md bg-white dark:bg-gray-800">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            Attendance History: {personName}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">Loading attendance history...</div>
        ) : error ? (
          <div className="text-center py-8">
            <div className="text-red-500 mb-3">{error}</div>
            <button
              onClick={fetchHistory}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              Retry
            </button>
          </div>
        ) : data ? (
          <div className="space-y-4">
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300">
              {data.lastAttendance ? (
                <div>Last attended {formatDate(data.lastAttendance.date)} at {data.lastAttendance.gatheringName}</div>
              ) : (
                <div>No attendance records</div>
              )}
              {data.gatheringRegularity.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-x-4">
                  {data.gatheringRegularity.map(g => (
                    <span key={g.name}>{g.name}: {g.regularity} ({g.attendanceCount}x)</span>
                  ))}
                </div>
              )}
            </div>

            {gatheringOptions.length > 1 && (
              <div>
                <label htmlFor="gatheringFilter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Gathering
                </label>
                <select
                  id="gatheringFilter"
                  value={selectedGatheringId ?? ''}
                  onChange={(e) => setSelectedGatheringId(e.target.value ? Number(e.target.value) : null)}
                  className="w-full sm:w-64 px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">All gatherings</option>
                  {gatheringOptions.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="max-h-96 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md">
              {filteredHistory.length === 0 ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">No attendance history recorded</div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Gathering</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {filteredHistory.map((row, index) => (
                      <tr key={`${row.gatheringId}-${row.date}-${index}`}>
                        <td className="px-4 py-2 text-sm text-gray-900 dark:text-gray-100">{formatDate(row.date)}</td>
                        <td className="px-4 py-2 text-sm text-gray-900 dark:text-gray-100">{row.gatheringName}</td>
                        <td className="px-4 py-2 text-sm">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${row.present ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                            {row.present ? 'Present' : 'Absent'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : null}

        <div className="mt-6 flex justify-end space-x-3">
          <button
            onClick={handleExportCsv}
            disabled={!data || filteredHistory.length === 0}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AttendanceHistoryModal;
```

- [ ] **Step 2: Check the client container builds without errors**

```bash
docker-compose -f docker-compose.dev.yml restart client
docker-compose -f docker-compose.dev.yml logs --tail=50 client
```

Expected: Vite dev server logs show a clean rebuild (e.g. "ready in ...ms" / HMR update) with no TypeScript or import errors. The component isn't wired into any page yet, so nothing renders it — this step just confirms it compiles standalone.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/people/AttendanceHistoryModal.tsx
git commit -m "feat(people): add AttendanceHistoryModal component"
```

---

## Task 4: Wire into `PeoplePage.tsx` and remove dead code

**Files:**
- Modify: `client/src/pages/PeoplePage.tsx`

`AttendanceInfoButton` and its backing `useAttendanceData` hook (lines 102-264) are currently **dead code** — grepping the file confirms `<AttendanceInfoButton` is never rendered anywhere in the current `PeoplePage.tsx` (only in an untracked `.backup` file, which is not part of the codebase). This task deletes that dead code as part of replacing its former functionality with the new modal, per the design spec.

- [ ] **Step 1: Remove the dead `useAttendanceData` hook and `AttendanceInfoButton` component**

Delete lines 102-264 of `client/src/pages/PeoplePage.tsx` — the block starting at:
```typescript
// Custom hook for attendance data
const useAttendanceData = (personId: number | null) => {
```
and ending at the closing `};` of `AttendanceInfoButton`, immediately before `const PeoplePage: React.FC = () => {`.

- [ ] **Step 2: Remove the now-unused `InformationCircleIcon` import**

In the icon import block near the top of the file:

```typescript
import {
  UserGroupIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  XMarkIcon,
  ArrowPathIcon,
  DocumentTextIcon,
  InformationCircleIcon
} from '@heroicons/react/24/outline';
```

Remove `InformationCircleIcon` and add `CalendarDaysIcon` (used by the new button in Step 5):

```typescript
import {
  UserGroupIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  XMarkIcon,
  ArrowPathIcon,
  DocumentTextIcon,
  CalendarDaysIcon
} from '@heroicons/react/24/outline';
```

- [ ] **Step 3: Import `AttendanceHistoryModal`**

Add this import alongside the other modal imports (near `import NotesModal from '../components/people/NotesModal';`):

```typescript
import AttendanceHistoryModal from '../components/people/AttendanceHistoryModal';
```

- [ ] **Step 4: Add modal-open state**

Find the `showNotesModal` state declaration:
```typescript
const [showNotesModal, setShowNotesModal] = useState(false);
```

Add immediately after it:
```typescript
const [showAttendanceHistoryModal, setShowAttendanceHistoryModal] = useState(false);
```

- [ ] **Step 5: Add a `selectedPersonForHistory` derived value**

Find the `downloadPeopleTSV` function definition (it ends with a closing `};` right before `if (isLoading) {`). Add this immediately after `downloadPeopleTSV`'s closing `};` and before `if (isLoading) {`:

```typescript
  const selectedPersonForHistory = selectedPeople.length === 1
    ? people.find(person => person.id === selectedPeople[0])
    : undefined;
```

- [ ] **Step 6: Add the "View Attendance" floating action button**

Find the "Edit Selected" floating action button block — it starts with:
```typescript
       {/* Floating Action Buttons */}
       {selectedPeople.length > 0 ? (
         <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 flex flex-col space-y-2 z-[9999]">
           <div className="flex items-center justify-end space-x-3">
             <div className="bg-white dark:bg-gray-800 px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
                Edit Selected
             </div>
```
and its `<button>...</button>` for editing ends with:
```typescript
               <PencilIcon className="h-6 w-6" />
             </button>
           </div>
```
(immediately followed by the `{/* Archive Button ... */}` comment).

Insert this new block right after that `</div>` (i.e., between the Edit Selected block and the Archive Button comment):

```tsx
           {selectedPeople.length === 1 && (
             <div className="flex items-center justify-end space-x-3">
               <div className="bg-white dark:bg-gray-800 px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
                  View Attendance
               </div>
               <button
                  onClick={() => setShowAttendanceHistoryModal(true)}
                 className="w-14 h-14 bg-green-600 hover:bg-green-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
                  title="View Attendance"
               >
                 <CalendarDaysIcon className="h-6 w-6" />
               </button>
             </div>
           )}
```

- [ ] **Step 7: Render the modal**

Find where `NotesModal` is rendered near the end of the file:

```tsx
      {/* Family Notes Modal */}
      <NotesModal
        isOpen={showNotesModal}
        onClose={() => setShowNotesModal(false)}
        onSuccess={async (message, updatedFamily) => {
          // Update the local family data
          setFamilies(families.map(family =>
            family.id === updatedFamily.id
              ? { ...family, familyNotes: updatedFamily.familyNotes }
              : family
          ));
          showSuccess(message);
        }}
        family={selectedFamilyForNotes}
      />
   </div>
 );
};
```

Add the new modal's render right after `NotesModal`'s closing `/>` and before the final `</div>`:

```tsx
      <AttendanceHistoryModal
        isOpen={showAttendanceHistoryModal}
        onClose={() => setShowAttendanceHistoryModal(false)}
        personId={selectedPersonForHistory?.id ?? null}
        personName={selectedPersonForHistory ? `${selectedPersonForHistory.firstName} ${selectedPersonForHistory.lastName}` : ''}
      />
   </div>
 );
};
```

- [ ] **Step 8: Check the client container builds without errors**

```bash
docker-compose -f docker-compose.dev.yml restart client
docker-compose -f docker-compose.dev.yml logs --tail=80 client
```

Expected: clean Vite rebuild, no TypeScript errors (in particular, no "unused variable" or "cannot find name" errors relating to `InformationCircleIcon`, `useAttendanceData`, or `AttendanceInfoButton`), no HMR error overlay reported by the dev server.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/PeoplePage.tsx
git commit -m "feat(people): add View Attendance button and wire up AttendanceHistoryModal"
```

---

## Task 5: End-to-end manual verification

No automated test covers the full flow (backend route → HTTP → React fetch → render → export), since it crosses process boundaries and requires an authenticated browser session. Verify manually against the running dev stack, per this project's standing convention of testing UI changes in a real browser rather than relying on type-checks alone.

- [ ] **Step 1: Start the full dev stack**

```bash
docker-compose -f docker-compose.dev.yml up -d
docker-compose -f docker-compose.dev.yml logs -f
```

Confirm `server`, `client`, and `nginx` all report healthy startup with no errors.

- [ ] **Step 2: Log in and navigate to People**

Log into the app as you normally would in local development, then go to the People page. Switch to "Individual View" (uncheck "Group by Family") if needed so people are listed individually rather than grouped.

- [ ] **Step 3: Verify the button only appears for a single selection**

Check zero people: confirm no "View Attendance" button is shown. Check two people: confirm the "View Attendance" button is **not** shown (only single-selection). Check exactly one person: confirm a green "View Attendance" floating button appears near the other floating action buttons (bottom-right).

- [ ] **Step 4: Verify the modal contents**

Click "View Attendance". Confirm:
- The modal title shows the selected person's name.
- A summary line shows their last attendance date/gathering (or "No attendance records" if none).
- The table lists one row per session, newest date first, with a "Present"/"Absent" badge per row.
- If the person has records across more than one gathering, a "Gathering" filter dropdown appears above the table; selecting a specific gathering narrows the table to just that gathering's rows, and selecting "All gatherings" restores the full list.

- [ ] **Step 5: Verify CSV export**

Click "Export CSV" with "All gatherings" selected. Confirm a `.csv` file downloads named like `attendance-<firstname>-<lastname>-<today's date>.csv`, and that opening it shows a header row `Date,Gathering,Status` followed by one row per session matching what's on screen. Then select a specific gathering in the filter and export again — confirm the exported file only contains that gathering's rows.

- [ ] **Step 6: Verify empty and error states**

Find or temporarily use a person with no attendance history (e.g. a newly added person) and confirm the modal shows "No attendance history recorded" instead of an empty table. Confirm the "Export CSV" button is disabled when there's nothing to export.

- [ ] **Step 7: Regression check**

Confirm other People page functionality still works: multi-select still enables "Edit Selected"/"Archive Selected"/"Merge" as before, and the People page loads without any console errors related to the removed `AttendanceInfoButton`/`useAttendanceData` code.
