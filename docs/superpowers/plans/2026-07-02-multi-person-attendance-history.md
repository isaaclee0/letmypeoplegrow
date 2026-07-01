# Multi-Person Attendance History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing "View Attendance" feature work for 1–15 selected people at once, showing a combined history table (with a Person column/filter) instead of hiding the button as soon as more than one person is checked.

**Architecture:** Change `AttendanceHistoryModal`'s props from a single `personId`/`personName` to a `people: Array<{id, name}>` list. With one person it behaves exactly as today (summary + single fetch). With 2+, it fetches every person's history in parallel via the existing single-person endpoint (`Promise.all`, no backend changes), tags each row with its person, merges and sorts by date, and adds a Person filter/column. `PeoplePage.tsx`'s button gating changes from "exactly 1 selected" to "1–15 selected."

**Tech Stack:** React 19 + TypeScript + Vite client, Vitest for unit tests. No new dependencies, no backend changes.

**Reference spec:** `docs/superpowers/specs/2026-07-02-multi-person-attendance-history-design.md`

---

## Task 1: CSV/filter pure logic — add person filtering and multi-person CSV format (TDD)

**Files:**
- Modify: `client/src/utils/attendanceHistoryCsv.ts`
- Modify: `client/src/utils/attendanceHistoryCsv.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `client/src/utils/attendanceHistoryCsv.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildAttendanceHistoryCsv,
  filterHistoryByGathering,
  filterHistoryByPerson,
  AttendanceHistoryEntry
} from './attendanceHistoryCsv';

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

describe('filterHistoryByPerson', () => {
  const history: AttendanceHistoryEntry[] = [
    { date: '2026-03-22', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: true, personId: 10, personName: 'Andrea Abetz' },
    { date: '2026-03-15', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: false, personId: 20, personName: 'Skip Koa' }
  ];

  it('returns all rows when personId is null', () => {
    expect(filterHistoryByPerson(history, null)).toHaveLength(2);
  });

  it('returns only rows matching the given personId', () => {
    const result = filterHistoryByPerson(history, 20);
    expect(result).toHaveLength(1);
    expect(result[0].personName).toBe('Skip Koa');
  });

  it('returns an empty array when no rows match', () => {
    expect(filterHistoryByPerson(history, 99)).toHaveLength(0);
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

  it('adds a Person column when rows carry personName', () => {
    const csv = buildAttendanceHistoryCsv([
      { date: '2026-03-22', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: true, personId: 10, personName: 'Andrea Abetz' },
      { date: '2026-03-15', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: false, personId: 20, personName: 'Skip Koa' }
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Date,Person,Gathering,Status');
    expect(lines[1]).toBe('2026-03-22,Andrea Abetz,Sunday Morning Service,Present');
    expect(lines[2]).toBe('2026-03-15,Skip Koa,Sunday Morning Service,Absent');
  });

  it('quotes person names containing a comma', () => {
    const csv = buildAttendanceHistoryCsv([
      { date: '2026-03-22', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: true, personId: 10, personName: 'Koa, Skip' }
    ]);
    expect(csv.split('\n')[1]).toBe('2026-03-22,"Koa, Skip",Sunday Morning Service,Present');
  });

  it('keeps the two-column format when no row carries personName', () => {
    const csv = buildAttendanceHistoryCsv([
      { date: '2026-03-22', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: true }
    ]);
    expect(csv.split('\n')[0]).toBe('Date,Gathering,Status');
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

```bash
docker exec church_attendance_client_dev npx vitest run src/utils/attendanceHistoryCsv.test.ts
```

Expected: FAIL — `filterHistoryByPerson` is not exported yet (`Cannot find module` or `undefined is not a function` depending on how the test runner reports missing named exports), and the two new `buildAttendanceHistoryCsv` tests fail because `personName`/`Person` column support doesn't exist yet. The 4 pre-existing tests (gathering filter + first 3 CSV tests) should still pass.

- [ ] **Step 3: Update the implementation**

Replace the full contents of `client/src/utils/attendanceHistoryCsv.ts` with:

```typescript
export interface AttendanceHistoryEntry {
  date: string;
  gatheringId: number;
  gatheringName: string;
  present: boolean;
  personId?: number;
  personName?: string;
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

export function filterHistoryByPerson(
  history: AttendanceHistoryEntry[],
  personId: number | null
): AttendanceHistoryEntry[] {
  if (personId === null) {
    return history;
  }
  return history.filter(row => row.personId === personId);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildAttendanceHistoryCsv(rows: AttendanceHistoryEntry[]): string {
  const isMultiPerson = rows.some(row => row.personName !== undefined);
  const headers = isMultiPerson
    ? ['Date', 'Person', 'Gathering', 'Status']
    : ['Date', 'Gathering', 'Status'];
  const lines = rows.map(row => {
    const cells = isMultiPerson
      ? [row.date, csvEscape(row.personName || ''), csvEscape(row.gatheringName), row.present ? 'Present' : 'Absent']
      : [row.date, csvEscape(row.gatheringName), row.present ? 'Present' : 'Absent'];
    return cells.join(',');
  });
  return [headers.join(','), ...lines].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they all pass**

```bash
docker exec church_attendance_client_dev npx vitest run src/utils/attendanceHistoryCsv.test.ts
```

Expected: PASS, 12 tests passing (3 `filterHistoryByGathering` + 3 `filterHistoryByPerson` + 6 `buildAttendanceHistoryCsv`).

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/attendanceHistoryCsv.ts client/src/utils/attendanceHistoryCsv.test.ts
git commit -m "feat(people): add person filtering and multi-person CSV format"
```

---

## Task 2: `AttendanceHistoryModal` — support multiple people

**Files:**
- Modify: `client/src/components/people/AttendanceHistoryModal.tsx`

No automated test for this file — matches the existing convention already established for this component (full-component tests aren't used anywhere in this codebase; the pure logic it depends on is tested in Task 1). Verified manually in Task 4.

- [ ] **Step 1: Replace the component**

Replace the full contents of `client/src/components/people/AttendanceHistoryModal.tsx` with:

```tsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { format, parseISO } from 'date-fns';
import { individualsAPI } from '../../services/api';
import {
  buildAttendanceHistoryCsv,
  filterHistoryByGathering,
  filterHistoryByPerson,
  AttendanceHistoryEntry
} from '../../utils/attendanceHistoryCsv';

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
  people: Array<{ id: number; name: string }>;
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
  people
}) => {
  const [summary, setSummary] = useState<{
    lastAttendance: AttendanceHistoryResponse['lastAttendance'];
    gatheringRegularity: AttendanceHistoryResponse['gatheringRegularity'];
  } | null>(null);
  const [history, setHistory] = useState<AttendanceHistoryEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedGatheringId, setSelectedGatheringId] = useState<number | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);

  const isMultiPerson = people.length > 1;

  const fetchHistory = useCallback(async () => {
    if (people.length === 0) return;
    setIsLoading(true);
    setError(null);
    try {
      if (people.length === 1) {
        const response = await individualsAPI.getAttendanceHistory(people[0].id);
        const data: AttendanceHistoryResponse = response.data;
        setSummary({ lastAttendance: data.lastAttendance, gatheringRegularity: data.gatheringRegularity });
        setHistory(data.history);
      } else {
        const responses = await Promise.all(people.map(p => individualsAPI.getAttendanceHistory(p.id)));
        const merged: AttendanceHistoryEntry[] = [];
        responses.forEach((response, index) => {
          const data: AttendanceHistoryResponse = response.data;
          const person = people[index];
          data.history.forEach(row => {
            merged.push({ ...row, personId: person.id, personName: person.name });
          });
        });
        merged.sort((a, b) => b.date.localeCompare(a.date));
        setSummary(null);
        setHistory(merged);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch attendance history');
      setSummary(null);
      setHistory(null);
    } finally {
      setIsLoading(false);
    }
  }, [people]);

  useEffect(() => {
    if (isOpen && people.length > 0) {
      setSelectedGatheringId(null);
      setSelectedPersonId(null);
      fetchHistory();
    }
  }, [isOpen, people, fetchHistory]);

  const gatheringOptions = useMemo(() => {
    if (!history) return [];
    const seen = new Map<number, string>();
    history.forEach(row => seen.set(row.gatheringId, row.gatheringName));
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [history]);

  const filteredHistory = useMemo(() => {
    if (!history) return [];
    const byGathering = filterHistoryByGathering(history, selectedGatheringId);
    return filterHistoryByPerson(byGathering, selectedPersonId);
  }, [history, selectedGatheringId, selectedPersonId]);

  const handleExportCsv = () => {
    const csv = buildAttendanceHistoryCsv(filteredHistory);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateSuffix = new Date().toISOString().split('T')[0];
    a.download = isMultiPerson
      ? `attendance-${people.length}-people-${dateSuffix}.csv`
      : `attendance-${people[0].name.replace(/\s+/g, '-').toLowerCase()}-${dateSuffix}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!isOpen || people.length === 0) return null;

  const title = isMultiPerson
    ? `Attendance History: ${people.length} people`
    : `Attendance History: ${people[0].name}`;

  return createPortal(
    <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
      <div className="relative top-10 mx-auto p-5 border w-11/12 md:w-3/4 lg:w-2/3 shadow-lg rounded-md bg-white dark:bg-gray-800">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {title}
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
        ) : history ? (
          <div className="space-y-4">
            {!isMultiPerson && summary && (
              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300">
                {summary.lastAttendance ? (
                  <div>Last attended {formatDate(summary.lastAttendance.date)} at {summary.lastAttendance.gatheringName}</div>
                ) : (
                  <div>No attendance records</div>
                )}
                {summary.gatheringRegularity.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-4">
                    {summary.gatheringRegularity.map(g => (
                      <span key={g.name}>{g.name}: {g.regularity} ({g.attendanceCount}x)</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-4">
              {isMultiPerson && (
                <div>
                  <label htmlFor="personFilter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Person
                  </label>
                  <select
                    id="personFilter"
                    value={selectedPersonId ?? ''}
                    onChange={(e) => setSelectedPersonId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full sm:w-64 px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="">All people</option>
                    {people.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}

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
            </div>

            <div className="max-h-96 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md">
              {filteredHistory.length === 0 ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">No attendance history recorded</div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
                      {isMultiPerson && (
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Person</th>
                      )}
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Gathering</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {filteredHistory.map((row, index) => (
                      <tr key={`${row.personId ?? ''}-${row.gatheringId}-${row.date}-${index}`}>
                        <td className="px-4 py-2 text-sm text-gray-900 dark:text-gray-100">{formatDate(row.date)}</td>
                        {isMultiPerson && (
                          <td className="px-4 py-2 text-sm text-gray-900 dark:text-gray-100">{row.personName}</td>
                        )}
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
            disabled={!history || filteredHistory.length === 0}
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

**Important implementation note on the `people` dependency:** `fetchHistory`'s `useCallback` and the fetching `useEffect` both depend directly on the `people` array (object reference), not a derived key. This only avoids re-fetch loops if the caller (`PeoplePage.tsx`, Task 3) passes a `people` array that's referentially stable across re-renders when the actual selection hasn't changed (i.e., wrapped in `useMemo`). Task 3 handles this — don't "fix" it here by inventing a string-key workaround; the correct fix belongs at the call site.

- [ ] **Step 2: Check the client container builds without errors**

```bash
docker exec church_attendance_client_dev sh -c "cd /app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i AttendanceHistoryModal || echo 'no AttendanceHistoryModal errors'"
docker logs --tail 30 church_attendance_client_dev
```

Expected: `no AttendanceHistoryModal errors`, and clean Vite logs. `PeoplePage.tsx` will show a TypeScript error at this point (it still passes the old `personId`/`personName` props) — that's expected and gets fixed in Task 3. Confirm the *only* new errors are in `PeoplePage.tsx`, not in `AttendanceHistoryModal.tsx` itself.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/people/AttendanceHistoryModal.tsx
git commit -m "feat(people): support multiple people in AttendanceHistoryModal"
```

---

## Task 3: Wire multi-select into `PeoplePage.tsx`

**Files:**
- Modify: `client/src/pages/PeoplePage.tsx`

- [ ] **Step 1: Replace the single-person derivation with a memoized multi-person one**

Find this block (currently right after `downloadPeopleTSV`'s closing `};` and before `if (isLoading) {`):

```typescript
  const selectedPersonForHistory = selectedPeople.length === 1
    ? people.find(person => person.id === selectedPeople[0])
    : undefined;
```

Replace it with:

```typescript
  const selectedPeopleForHistory = useMemo(() => {
    return selectedPeople
      .map(id => people.find(person => person.id === id))
      .filter((p): p is Person => !!p)
      .map(p => ({ id: p.id, name: `${p.firstName} ${p.lastName}` }));
  }, [selectedPeople, people]);
```

(`useMemo` is already imported at the top of this file — `import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';` — no import change needed. This memoization matters: `AttendanceHistoryModal`'s fetch effect (Task 2) depends on the `people` prop's object reference to avoid re-fetching on every unrelated re-render of `PeoplePage`; without `useMemo` here, a new array/objects would be created on every render and the modal would re-fetch constantly while open.)

- [ ] **Step 2: Change the "View Attendance" button's visibility condition and cap**

Find:

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

Replace the opening condition only:

```tsx
           {selectedPeople.length >= 1 && selectedPeople.length <= 15 && (
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

- [ ] **Step 3: Update the modal render to pass the `people` array**

Find:

```tsx
      <AttendanceHistoryModal
        isOpen={showAttendanceHistoryModal}
        onClose={() => setShowAttendanceHistoryModal(false)}
        personId={selectedPersonForHistory?.id ?? null}
        personName={selectedPersonForHistory ? `${selectedPersonForHistory.firstName} ${selectedPersonForHistory.lastName}` : ''}
      />
```

Replace with:

```tsx
      <AttendanceHistoryModal
        isOpen={showAttendanceHistoryModal}
        onClose={() => setShowAttendanceHistoryModal(false)}
        people={selectedPeopleForHistory}
      />
```

- [ ] **Step 4: Check the client container builds without errors**

```bash
docker exec church_attendance_client_dev sh -c "cd /app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i PeoplePage || echo 'no PeoplePage errors'"
docker logs --tail 80 church_attendance_client_dev
```

Expected: `no PeoplePage errors` (this should now also clear the `AttendanceHistoryModal` prop-mismatch error noted at the end of Task 2), clean Vite rebuild, no HMR error overlay.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/PeoplePage.tsx
git commit -m "feat(people): allow selecting 1-15 people for View Attendance"
```

---

## Task 4: Manual end-to-end verification

No automated test covers the full flow (multi-select → parallel fetch → merged table → filtered CSV export). Verify manually against the running dev stack in a real browser, per this project's standing convention for UI changes.

- [ ] **Step 1: Confirm the dev stack is up**

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep church_attendance
```

Expected: `church_attendance_client_dev`, `church_attendance_server_dev` (and admin/nginx) all `Up`.

- [ ] **Step 2: Single-person behavior is unchanged**

On the People page, switch to Individual View, select exactly one person, click "View Attendance". Confirm: title shows the person's name (not "1 people"), the summary block (last attendance + regularity) still appears, the table has no "Person" column, and Export CSV produces the same two-column `Date,Gathering,Status` format as before.

- [ ] **Step 3: Multi-person combined view**

Select 2–3 people who have attendance records (e.g. via search, matching family members or any group). Confirm the "View Attendance" button still appears (was previously hidden at 2+). Click it. Confirm:
- Title reads "Attendance History: N people" (no summary block shown).
- A "Person" filter dropdown appears (default "All people") alongside "Gathering" (if applicable).
- The table has a "Person" column, rows from all selected people merged and sorted newest-first.

- [ ] **Step 4: Filters compose correctly**

With 2–3 people selected and the modal open, pick a specific person in the "Person" filter — confirm the table narrows to just their rows. Additionally pick a specific gathering — confirm the table narrows to rows matching *both* the selected person and gathering. Reset both to "All" and confirm the full combined table returns.

- [ ] **Step 5: CSV export in multi-person mode**

With a person filter and/or gathering filter active, click "Export CSV". Confirm the downloaded filename matches `attendance-{N}-people-{date}.csv` (where N is the number of *selected* people, not the filtered subset), and the file's header row is `Date,Person,Gathering,Status` with rows matching exactly what's shown in the (filtered) table.

- [ ] **Step 6: Selection cap**

Select more than 15 people (e.g. via "Select All" if the church has more than 15 people, or select 16+ individually). Confirm the "View Attendance" button is hidden once the count exceeds 15, and reappears once the selection drops back to 15 or fewer.

- [ ] **Step 7: Regression check**

Confirm other floating action buttons (Edit Selected, Archive Selected, Merge, Assign Caregiver) still behave exactly as before at their own thresholds, and that single-person "View Attendance" (Step 2 above) still works identically to the pre-existing behavior.
