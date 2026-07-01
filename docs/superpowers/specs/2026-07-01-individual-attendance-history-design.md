# Individual Attendance History

## Problem

There's no way to see a single person's full attendance record. The closest existing feature, `AttendanceInfoButton` (`client/src/pages/PeoplePage.tsx:150-264`), only shows a small popup with the last-attendance date and a per-gathering regularity summary (e.g. "every week") — no chronological list of individual sessions, and no way to export the data.

## Solution

On the People page, checking exactly one person reveals a "View Attendance" button in the floating action button bar. Clicking it opens a modal showing that person's full attendance history as a table (one row per session, across all their gatherings), with a summary header carried over from the old popup, and a CSV export button. The old `AttendanceInfoButton` popup is removed — this modal replaces it.

## Data Model

No schema changes. History rows are derived from existing tables:

- `attendance_records` (`session_id`, `individual_id`, `present`) joined to
- `attendance_sessions` (`session_date`, `gathering_type_id`, `excluded_from_stats`) joined to
- `gathering_types` (`name`, `attendance_type`)

Headcount-mode gatherings (`attendance_type = 'headcount'`) have no per-individual records (`headcount_records` stores only an aggregate count) and are excluded from history. Sessions with `excluded_from_stats = 1` are excluded, consistent with how the existing regularity summary treats them.

## API

### `GET /api/individuals/:id/attendance-history` (existing endpoint, extended response)

`server/routes/individuals.js:599-728`. Auth unchanged: `verifyToken`, manual `church_id` ownership check (403 on mismatch). No new role restriction.

This is the only caller of this endpoint today (`AttendanceInfoButton`, being removed), so its response shape can change without a compatibility shim.

**Response:**
```json
{
  "lastAttendance": { "date": "2026-06-28", "gatheringName": "Sunday AM", "gatheringId": 1, "recordedAt": "..." } | null,
  "gatheringRegularity": [
    { "name": "Sunday AM", "regularity": "every week", "attendanceCount": 12 }
  ],
  "history": [
    { "date": "2026-06-28", "gatheringId": 1, "gatheringName": "Sunday AM", "present": true }
  ]
}
```

- `lastAttendance` and `gatheringRegularity` are unchanged from the current implementation.
- `history` is new: every non-excluded, non-headcount session for gatherings the individual has an `attendance_records` row for, all-time, ordered `session_date DESC`. Includes both present and absent rows (this is the key gap the old summary didn't cover, since it only counted `present = 1`).

## Frontend Changes

### `PeoplePage.tsx`

- Remove `AttendanceInfoButton` and its per-card info icon (already dead code in the current file — not rendered anywhere, only present in an untracked `.backup` file).
- Add a "View Attendance" button to the existing floating action button bar (the same bottom-right stack that already holds "Edit Selected" / "Archive Selected" / "Merge"), visible only when `selectedPeople.length === 1`.
- Clicking it opens `AttendanceHistoryModal` with `personId={selectedPeople[0]}`.

### `AttendanceHistoryModal.tsx` (new, in `client/src/components/people/`)

Follows the existing `createPortal`-to-`document.body` modal pattern (same structural conventions as `MassEditModal` / `FamilyEditorModal`). Props: `{ personId: number; personName: string; isOpen: boolean; onClose: () => void }`. Scoped to one person for now — the `personId` prop (rather than an array) is a deliberate v1 boundary, not a technical limitation; a future multi-person variant would take `personIds: number[]` without touching this component's internals.

Contents:
1. **Header**: person's name; summary line(s) built from `lastAttendance` + `gatheringRegularity` (the content the old popup showed).
2. **Gathering filter**: a dropdown defaulting to "All gatherings"; selecting a specific gathering narrows the table to just that one. Populated from the distinct `gatheringName`s present in the fetched `history`.
3. **Table**: columns `Date | Gathering | Status` (Present/Absent badge), newest-first, scrollable within the modal body. No pagination — history length is bounded by how long the church has tracked attendance weekly, not expected to be large enough to need it.
4. **Footer**: "Export CSV" button, "Close" button. Export respects the active gathering filter (exports what's currently shown in the table).

**Loading/error/empty states:**
- Loading: spinner while the fetch is in flight.
- Error: inline message with a retry button.
- Empty (`history` is `[]`): "No attendance history recorded."

### Export

Client-side, no new dependency. Reuses the exact pattern from `downloadPeopleTSV()` (`PeoplePage.tsx:1343`): build a CSV string from the already-fetched `history` array, wrap in a `Blob`, trigger download via a temporary `<a download>` element. No server round-trip.

## Scope

- Single-person only. No bulk/multi-select export in this pass.
- CSV export only — no `.xlsx` library added.
- All-time history, no date-range picker.
- Combined view across all of a person's gatherings by default, with a `Gathering` column and a filter dropdown to narrow to one gathering.
- Headcount-mode gatherings never appear in the history (no individual-level data exists for them).
- No new tests surfaced an existing pattern to extend for `individuals.js` routes during design research; verified manually via the Docker dev stack per project convention, not local builds.
