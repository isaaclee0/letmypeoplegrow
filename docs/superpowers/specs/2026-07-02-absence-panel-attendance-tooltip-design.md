# Absence Panel Attendance Tooltip

## Problem

The "Regulars With Recent Absences" panel on the Reports page ([ReportsPage.tsx:1322](../../../client/src/pages/ReportsPage.tsx#L1322)) shows each absent person/family and their consecutive-absence streak, but gives no quick way to see when they last actually attended. An admin deciding whether to follow up has to leave the Reports page to check. We want hovering (desktop) or tapping (mobile) a name in this panel to reveal the last 3 dates that person was marked present — even if those dates fall outside the report's selected date range — without navigating away.

## Data Source

No backend changes. Reuse the existing `individualsAPI.getAttendanceHistory(id)` call ([api.ts:635](../../../client/src/services/api.ts#L635) → `GET /individuals/:id/attendance-history`, [individuals.js:599](../../../server/routes/individuals.js#L599)). Its response already includes a `history` array: full all-time session records (standard-mode gatherings only) sorted by `session_date DESC`, each with `{ date, gatheringId, gatheringName, present }`. The client filters this array to `present === true` and takes the first 3 entries — no new query needed, and results are correctly all-time (not bounded by the report's date range) because this endpoint has no date filtering.

## State Changes: `ReportsPage.tsx`

`groupedAbsences` currently has shape `{ key: string; name: string; streak: number; familyId?: number | null }`. It gains an optional field for family rows:

```typescript
{
  key: string;
  name: string;
  streak: number;
  familyId?: number | null;
  members?: Array<{ individualId: number; name: string }>;
}
```

`members` is populated only when pushing a `fam:${famId}` entry (currently [ReportsPage.tsx:370](../../../client/src/pages/ReportsPage.tsx#L370)), built from the `familyMembers` map already constructed in the same effect ([ReportsPage.tsx:332](../../../client/src/pages/ReportsPage.tsx#L332)) — for each `memberId` in `meta.memberIds`, look up the name from `regularMap`. Individual (`ind:`) rows don't need `members`; the render site derives a single-person list inline from `g.individualId`/`g.name` (note: `individualId` isn't currently on the grouped-row type for `ind:` rows either — add it alongside `members` as optional, populated only on `ind:` rows, mirroring how `familyId` is already optional-and-conditional today).

## New Component: `AttendanceHistoryPopover.tsx`

Location: `client/src/components/reports/AttendanceHistoryPopover.tsx` (new `reports` subdirectory under `components/`, since this is Reports-page-specific, unlike the People-page `AttendanceHistoryModal`).

```typescript
interface AttendanceHistoryPopoverProps {
  people: Array<{ individualId: number; name: string }>;
  children: React.ReactNode; // the trigger content (the name text)
}
```

**Trigger & visibility:**
- Renders `children` inside a `<span className="relative inline-block group">` with `onClick` toggling local `isOpen` state, and `role="button" tabIndex={0}` with an `onKeyDown` handler for Enter/Space (keyboard accessibility).
- The floating panel's className includes `isOpen ? 'block' : 'hidden group-hover:block'` — hover shows it via pure CSS on desktop, `isOpen` forces it open on tap (covers touch devices, which generally don't sustain `:hover`), and either mechanism alone works if the other's assumption doesn't hold on a given device.
- Clicking outside (a `mousedown` document listener added only while `isOpen`) or pressing `Escape` sets `isOpen` back to `false`.

**Fetching:**
- A module-level cache: `const historyCache = new Map<number, Promise<AttendanceHistoryResponse>>()`. On first open (and only then — not on every hover), for each person in `props.people` not yet in the cache, call `individualsAPI.getAttendanceHistory(individualId)` and store the promise. Reuses in-flight/completed requests across every popover instance and every re-open within the same page session (the cache is never invalidated within a session — attendance history for past dates doesn't change during a reporting session).
- Local component state tracks `status: 'idle' | 'loading' | 'loaded' | 'error'` for the current open panel, derived from awaiting the cached promises for `props.people`.

**Rendering the panel:**
- Container: `absolute z-10 mt-1 left-0 w-64 bg-white dark:bg-gray-800 shadow-lg rounded border border-gray-200 dark:border-gray-700 p-3 text-sm`.
- `status === 'loading'`: small spinner + "Loading…".
- `status === 'error'`: "Couldn't load attendance history."
- `status === 'loaded'`:
  - If `people.length === 1`: a plain list of up to 3 dates (formatted `format(parseISO(date), 'MMM d, yyyy')`, matching `AttendanceHistoryModal.tsx`), most recent first. If zero present records exist, show "No attendance on record."
  - If `people.length > 1` (family row): for each person, a bold name sub-heading followed by their own up-to-3-dates list (or "No attendance on record." for that person), in the same order as `props.people`.

## Integration: `ReportsPage.tsx`

At the name cell in the absence list ([ReportsPage.tsx:1347](../../../client/src/pages/ReportsPage.tsx#L1347)):

```tsx
<AttendanceHistoryPopover
  people={g.familyId != null && g.members ? g.members : [{ individualId: g.individualId!, name: g.name }]}
>
  <span className="font-medium text-gray-900 dark:text-gray-100 truncate">{g.name}</span>
</AttendanceHistoryPopover>
```

(Exact conditional expression will match whichever of `g.members` vs single-person shape is actually populated per row — `fam:` rows have `members` set, `ind:` rows don't.)

## Scope

- No backend/API changes.
- No date-range filtering on the tooltip's 3 dates — always the person's true last 3 present dates, all-time, regardless of the report's selected date range or gathering filter. This was an explicit requirement, not an oversight.
- No automated component tests planned, matching this codebase's convention of testing only extracted pure logic rather than full React components (there is no pure logic to extract here beyond simple array slicing, which doesn't warrant a dedicated test module).
- Caching is session-only (module-level `Map`, cleared on full page reload) — acceptable since attendance history for past dates is immutable during a session.
- No new backend endpoint for batch-fetching a family's histories in one request; family rows fan out into N parallel calls to the existing per-individual endpoint (family sizes are small, matching the precedent set in the sibling multi-person attendance history feature, which caps at 15 people for the same reason).
