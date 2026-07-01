# Multi-Person Attendance History

## Problem

The individual attendance history feature (`docs/superpowers/specs/2026-07-01-individual-attendance-history-design.md`) only works for exactly one selected person — the "View Attendance" button on the People page is hidden as soon as a second person is checked. There's no way to view or export combined attendance history for a small group (e.g. a family, or a few people you're checking in on) without opening the modal once per person.

## Solution

Extend the existing "View Attendance" button and `AttendanceHistoryModal` to work for 1–15 selected people. With one person selected, behavior is unchanged. With 2–15 selected, the modal shows a combined table (all selected people's history merged, sorted by date) with an added "Person" column, a "Person" filter dropdown alongside the existing "Gathering" filter, and a CSV export that includes everyone currently shown. Above 15 people selected, the button is hidden — larger exports belong on the Reports page.

## Component Changes

### `AttendanceHistoryModal.tsx`

Props change from `personId: number | null; personName: string` to:

```typescript
interface AttendanceHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  people: Array<{ id: number; name: string }>;
}
```

Behavior branches on `people.length`:

- **`=== 1`** (unchanged from today): single fetch via `individualsAPI.getAttendanceHistory(id)`, summary header (`lastAttendance` + `gatheringRegularity`) shown, table has no Person column, no Person filter.
- **`> 1`**: fetch every selected person's history in parallel via `Promise.all(people.map(p => individualsAPI.getAttendanceHistory(p.id)))`. Merge each person's `history` array, tagging every row with `personId`/`personName` from the corresponding `people` entry. Sort the merged list by `date` descending. No summary header (regularity/last-attendance don't combine meaningfully across people) — the modal title becomes `Attendance History: {N} people` instead of a name. A "Person" filter dropdown appears (mirrors the existing "Gathering" dropdown: "All people" default, select one to narrow), and the table gains a "Person" column between Date and Gathering.
- **`=== 0`**: modal doesn't render (`isOpen` will never be true with zero people selected, per the button-gating change below, but the component still guards on an empty array defensively the same way it currently guards on `personId === null`).

**Fetch failure handling**: if any of the parallel requests rejects, the whole fetch is treated as failed — existing error UI (message + "Retry" button, which re-fires all requests) — no partial-results UI. Keeps single-person and multi-person error handling identical.

**Filters compose independently**: selecting a Gathering and a Person at the same time narrows by both (each filter is a plain array filter over the merged rows; applying both is just applying both functions in sequence).

**CSV export** always reflects both active filters, same as the single-person case today.

### `attendanceHistoryCsv.ts`

`AttendanceHistoryEntry` gains an optional field:

```typescript
export interface AttendanceHistoryEntry {
  date: string;
  gatheringId: number;
  gatheringName: string;
  present: boolean;
  personId?: number;
  personName?: string;
}
```

New pure function, mirroring `filterHistoryByGathering`:

```typescript
export function filterHistoryByPerson(
  history: AttendanceHistoryEntry[],
  personId: number | null
): AttendanceHistoryEntry[] {
  if (personId === null) {
    return history;
  }
  return history.filter(row => row.personId === personId);
}
```

`buildAttendanceHistoryCsv` changes to detect whether any row carries a `personName`:

- If **no** row has `personName` (the single-person case — rows built without tagging), output is byte-identical to today: `Date,Gathering,Status`.
- If **any** row has `personName` (the multi-person case), the header becomes `Date,Person,Gathering,Status` and every row includes the person's name (CSV-escaped the same way gathering names already are).

This keeps the single-person path fully backward compatible — existing single-person CSV exports don't change format at all. (Edge case: if a multi-person selection has zero combined history rows, the header detection has nothing to inspect and falls back to the two-column format — harmless, since the Export CSV button is already disabled whenever there are zero rows to export, single- or multi-person.)

## Selection & Button Gating (`PeoplePage.tsx`)

- The "View Attendance" FAB condition changes from `selectedPeople.length === 1` to `selectedPeople.length >= 1 && selectedPeople.length <= 15`. Above 15, the button is hidden entirely (same show/hide pattern the "Merge" button already uses for its own `>= 2` condition — no disabled-with-tooltip state, since no existing FAB in this file uses that pattern).
- The `selectedPersonForHistory` single-value derivation is replaced with a `selectedPeopleForHistory` array derivation:
  ```typescript
  const selectedPeopleForHistory = selectedPeople
    .map(id => people.find(person => person.id === id))
    .filter((p): p is Person => !!p)
    .map(p => ({ id: p.id, name: `${p.firstName} ${p.lastName}` }));
  ```
- The modal render passes `people={selectedPeopleForHistory}` instead of the current `personId`/`personName` props.

## Scope

- Cap of 15 selected people (matches the largest expected family size; larger jobs use the Reports page export, which already exists for bulk data).
- No backend changes — reuses the existing single-person endpoint via parallel client-side requests. Not a bulk endpoint; acceptable given the 15-person cap keeps the request count small.
- No partial-failure UI — one failed request fails the whole fetch, same as today's single-person error handling.
- No new automated component tests (matches this codebase's existing convention of testing only extracted pure logic, not full components). The new `filterHistoryByPerson` function and the CSV header-detection behavior get unit tests, following the same TDD pattern as the original `attendanceHistoryCsv.test.ts`.
- Single-person CSV export format is unchanged (no `Person` column) — this is a hard backward-compatibility requirement, not just an implementation detail.
