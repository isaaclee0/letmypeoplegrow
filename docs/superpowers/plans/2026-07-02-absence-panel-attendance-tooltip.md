# Absence Panel Attendance Tooltip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Reports page's "Regulars With Recent Absences" panel, hovering (desktop) or tapping (mobile) a person's or family's name reveals their last 3 all-time present dates in a small floating panel.

**Architecture:** A new presentational component, `AttendanceHistoryPopover`, wraps each name in the absence list. It lazily fetches attendance history via the existing `individualsAPI.getAttendanceHistory(id)` endpoint (already returns all-time `present`/`absent` records per session, no date-range filtering), caches responses per individual in a module-level `Map` for the page session, and derives "last 3 present dates" client-side. `ReportsPage.tsx`'s absence-grouping logic is extended to carry the individual ID(s) needed to drive the popover for both single-person and family-grouped rows.

**Tech Stack:** React 19 + TypeScript, Tailwind CSS, `date-fns` (already a dependency, used by `AttendanceHistoryModal.tsx`), existing `individualsAPI` client.

**Reference spec:** `docs/superpowers/specs/2026-07-02-absence-panel-attendance-tooltip-design.md`

**Implementation note (refines spec's visibility mechanism):** The spec describes CSS `group-hover` for desktop plus a JS `isOpen` flag for tap. In practice, a purely JS-driven `visible` boolean (set `true` on `onMouseEnter` and toggled on `onClick`/`onMouseLeave`) is simpler and avoids relying on Tailwind's `group` utility being available on the wrapping element. This plan uses that JS-only approach — it satisfies the same requirement (hover shows it on desktop, tap toggles it on touch devices, outside-click/Escape closes it) without a CSS dependency. No spec change needed; this is an implementation detail.

---

### Task 1: Extend `groupedAbsences` state to carry individual IDs

**Files:**
- Modify: `client/src/pages/ReportsPage.tsx:71` (state type)
- Modify: `client/src/pages/ReportsPage.tsx:327` (local `grouped` array type, inside `loadAbsenceAndVisitorDetails`)
- Modify: `client/src/pages/ReportsPage.tsx:370` (family row push)
- Modify: `client/src/pages/ReportsPage.tsx:377` (individual row push)

- [ ] **Step 1: Update the `groupedAbsences` state type**

In `client/src/pages/ReportsPage.tsx`, find this line (currently line 71):

```typescript
const [groupedAbsences, setGroupedAbsences] = useState<Array<{ key: string; name: string; streak: number; familyId?: number | null }>>([]);
```

Replace it with:

```typescript
const [groupedAbsences, setGroupedAbsences] = useState<Array<{ key: string; name: string; streak: number; familyId?: number | null; individualId?: number; members?: Array<{ individualId: number; name: string }> }>>([]);
```

- [ ] **Step 2: Update the local `grouped` array type inside `loadAbsenceAndVisitorDetails`**

Find this line (currently line 327):

```typescript
      const grouped: Array<{ key: string; name: string; streak: number }> = [];
```

Replace it with:

```typescript
      const grouped: Array<{ key: string; name: string; streak: number; familyId?: number | null; individualId?: number; members?: Array<{ individualId: number; name: string }> }> = [];
```

- [ ] **Step 3: Populate `members` for family rows**

Find this block (currently lines 368-371):

```typescript
        if (allAbsent && minStreak !== Number.MAX_SAFE_INTEGER) {
          meta.memberIds.forEach(id => groupedMemberIds.add(id));
          grouped.push({ key: `fam:${famId}`, name: formatFamilyLabel(meta.familyName), streak: minStreak, familyId: famId });
        }
```

Replace it with:

```typescript
        if (allAbsent && minStreak !== Number.MAX_SAFE_INTEGER) {
          meta.memberIds.forEach(id => groupedMemberIds.add(id));
          const members = meta.memberIds.map(id => {
            const entry = regularMap.get(id)!;
            return { individualId: id, name: `${entry.firstName} ${entry.lastName}` };
          });
          grouped.push({ key: `fam:${famId}`, name: formatFamilyLabel(meta.familyName), streak: minStreak, familyId: famId, members });
        }
```

- [ ] **Step 4: Populate `individualId` for individual rows**

Find this block (currently lines 375-379):

```typescript
      // Add remaining individuals who are absent but not part of a fully-absent family
      absenceArr.forEach(a => {
        if (!groupedMemberIds.has(a.individualId)) {
          grouped.push({ key: `ind:${a.individualId}`, name: `${a.firstName} ${a.lastName}`, streak: a.streak, familyId: a.familyId ?? null });
        }
      });
```

Replace it with:

```typescript
      // Add remaining individuals who are absent but not part of a fully-absent family
      absenceArr.forEach(a => {
        if (!groupedMemberIds.has(a.individualId)) {
          grouped.push({ key: `ind:${a.individualId}`, name: `${a.firstName} ${a.lastName}`, streak: a.streak, familyId: a.familyId ?? null, individualId: a.individualId });
        }
      });
```

- [ ] **Step 5: Verify the dev container picks up the change with no compile errors**

The client container mounts `./client` as a live volume with Vite HMR (see `docker-compose.dev.yml`), so no rebuild is needed for source edits — but the container must be running.

Run:
```bash
docker-compose -f docker-compose.dev.yml up -d client
docker-compose -f docker-compose.dev.yml logs --tail=50 client
```
Expected: no TypeScript/Vite compile errors in the log tail (look for `error TS` or a red Vite overlay message; ordinary HMR "update" messages are fine).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/ReportsPage.tsx
git commit -m "feat(reports): carry individual IDs on grouped absence rows"
```

---

### Task 2: Create the `AttendanceHistoryPopover` component

**Files:**
- Create: `client/src/components/reports/AttendanceHistoryPopover.tsx`

- [ ] **Step 1: Write the component**

Create `client/src/components/reports/AttendanceHistoryPopover.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { individualsAPI } from '../../services/api';
import { AttendanceHistoryEntry } from '../../utils/attendanceHistoryCsv';

interface AttendanceHistoryResponse {
  history: AttendanceHistoryEntry[];
}

interface AttendanceHistoryPopoverProps {
  people: Array<{ individualId: number; name: string }>;
  children: React.ReactNode;
}

type Status = 'idle' | 'loading' | 'loaded' | 'error';

// Module-level so every popover instance (and every re-open within the page
// session) reuses in-flight/completed requests instead of refetching.
const historyCache = new Map<number, Promise<AttendanceHistoryResponse>>();

function fetchHistoryCached(individualId: number): Promise<AttendanceHistoryResponse> {
  let cached = historyCache.get(individualId);
  if (!cached) {
    cached = individualsAPI.getAttendanceHistory(individualId).then(res => res.data as AttendanceHistoryResponse);
    historyCache.set(individualId, cached);
  }
  return cached;
}

function formatDate(dateString: string): string {
  try {
    return format(parseISO(dateString), 'MMM d, yyyy');
  } catch {
    return dateString;
  }
}

export function getLastPresentDates(history: AttendanceHistoryEntry[], limit = 3): string[] {
  return history.filter(row => row.present).slice(0, limit).map(row => row.date);
}

const AttendanceHistoryPopover: React.FC<AttendanceHistoryPopoverProps> = ({ people, children }) => {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [datesByPerson, setDatesByPerson] = useState<Map<number, string[]>>(new Map());
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setStatus('loading');
    Promise.all(
      people.map(p =>
        fetchHistoryCached(p.individualId).then(
          res => [p.individualId, getLastPresentDates(res.history)] as const
        )
      )
    )
      .then(entries => {
        if (cancelled) return;
        setDatesByPerson(new Map(entries));
        setStatus('loaded');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [visible, people]);

  useEffect(() => {
    if (!visible) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setVisible(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVisible(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible]);

  return (
    <span ref={containerRef} className="relative inline-block">
      <span
        role="button"
        tabIndex={0}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onClick={() => setVisible(v => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setVisible(v => !v);
          }
        }}
        className="cursor-pointer"
      >
        {children}
      </span>
      {visible && (
        <div className="absolute z-10 mt-1 left-0 w-64 bg-white dark:bg-gray-800 shadow-lg rounded border border-gray-200 dark:border-gray-700 p-3 text-sm">
          {status === 'loading' && (
            <div className="text-gray-500 dark:text-gray-400">Loading…</div>
          )}
          {status === 'error' && (
            <div className="text-red-500 dark:text-red-400">Couldn't load attendance history.</div>
          )}
          {status === 'loaded' && (
            <div className="space-y-2">
              {people.map(p => {
                const dates = datesByPerson.get(p.individualId) ?? [];
                return (
                  <div key={p.individualId}>
                    {people.length > 1 && (
                      <div className="font-semibold text-gray-900 dark:text-gray-100">{p.name}</div>
                    )}
                    {dates.length === 0 ? (
                      <div className="text-gray-500 dark:text-gray-400">No attendance on record.</div>
                    ) : (
                      <ul className="text-gray-700 dark:text-gray-300">
                        {dates.map(d => (
                          <li key={d}>{formatDate(d)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </span>
  );
};

export default AttendanceHistoryPopover;
```

- [ ] **Step 2: Verify no compile errors**

Run:
```bash
docker-compose -f docker-compose.dev.yml logs --tail=50 client
```
Expected: no new TypeScript/Vite errors referencing `AttendanceHistoryPopover.tsx`.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/reports/AttendanceHistoryPopover.tsx
git commit -m "feat(reports): add AttendanceHistoryPopover component"
```

---

### Task 3: Wire the popover into the absence list

**Files:**
- Modify: `client/src/pages/ReportsPage.tsx:1` (import)
- Modify: `client/src/pages/ReportsPage.tsx:1347` (name cell)

- [ ] **Step 1: Add the import**

Find the import block at the top of `client/src/pages/ReportsPage.tsx` (currently line 3):

```typescript
import { reportsAPI, gatheringsAPI, settingsAPI, GatheringType, attendanceAPI, familiesAPI, usersAPI, contactsAPI } from '../services/api';
```

Leave this line as-is — `ReportsPage.tsx` doesn't need to call `individualsAPI` itself; `AttendanceHistoryPopover` imports it internally. Add a new import line directly after it instead:

```typescript
import AttendanceHistoryPopover from '../components/reports/AttendanceHistoryPopover';
```

- [ ] **Step 2: Wrap the name cell**

Find this line inside the absence list `.map((g) => ...)` render (currently line 1347):

```tsx
                          <span className="font-medium text-gray-900 dark:text-gray-100 truncate">{g.name}</span>
```

Replace it with:

```tsx
                          <AttendanceHistoryPopover
                            people={g.members ?? (g.individualId != null ? [{ individualId: g.individualId, name: g.name }] : [])}
                          >
                            <span className="font-medium text-gray-900 dark:text-gray-100 truncate">{g.name}</span>
                          </AttendanceHistoryPopover>
```

(The empty-array fallback only matters defensively — every row is either a `fam:` row with `members` set in Task 1 Step 3, or an `ind:` row with `individualId` set in Task 1 Step 4, so one of the two branches always applies in practice.)

- [ ] **Step 3: Verify no compile errors**

Run:
```bash
docker-compose -f docker-compose.dev.yml logs --tail=50 client
```
Expected: no new TypeScript/Vite errors referencing `ReportsPage.tsx`.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/ReportsPage.tsx
git commit -m "feat(reports): show attendance history popover on absence row names"
```

---

### Task 4: Manual verification in the browser

There are no automated component tests for this feature (matches this codebase's convention of testing only extracted pure logic, not full React components — the one pure function here, `getLastPresentDates`, is a two-line array filter/slice that doesn't warrant a dedicated test module, per the approved spec). Verify by hand instead:

- [ ] **Step 1: Ensure the app is running and reachable**

```bash
docker-compose -f docker-compose.dev.yml up -d
```

Confirm `client`, `server`, and `nginx` containers are up via `docker-compose -f docker-compose.dev.yml ps`.

- [ ] **Step 2: Navigate to the Reports page and find an absence row**

Using the browser preview tool, open `http://localhost` (nginx-proxied) or `http://localhost:3000` directly, log in, go to Reports, and select a gathering/date range that produces at least one row in "Regulars With Recent Absences". If no data currently produces absences, this step may require picking a church/gathering with existing attendance history in the dev database — check with `docker-compose -f docker-compose.dev.yml logs server` for any errors if the panel stays empty unexpectedly.

- [ ] **Step 3: Verify hover behavior (desktop)**

Hover the mouse over a name in the absence list. Confirm a panel appears below the name showing "Loading…" briefly, then either up to 3 dates or "No attendance on record." Move the mouse away and confirm the panel disappears.

- [ ] **Step 4: Verify tap behavior (mobile viewport)**

Resize the preview to a mobile viewport (e.g. via `preview_resize` with `preset: "mobile"`). Tap/click a name and confirm the panel opens and stays open. Tap elsewhere on the page and confirm it closes.

- [ ] **Step 5: Verify a family row shows a per-member breakdown**

If any row is a family-grouped row (name ending in "family"), hover/tap it and confirm the panel shows one sub-heading per family member, each with their own up-to-3-dates list.

- [ ] **Step 6: Check the browser console for errors**

Use the preview tool's console-log inspection to confirm no new JavaScript errors were introduced.

No commit needed for this task — it's verification only. If any step fails, fix the issue in the relevant task's file and re-verify.
