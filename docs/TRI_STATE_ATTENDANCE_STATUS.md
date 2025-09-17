## Tri‑state attendance with Explained Absence (E)

This document specifies the changes required to add a third attendance state, “Explained Absence” (E), alongside the current Present/Absent model. The goal is to allow a user to mark an attendee as excused in a way that is excluded from both Present and Absent counts for reports and summaries.

### Summary
- **unchecked**: Absent
- **checked**: Present
- **double‑tap within 2 seconds** on the same checkbox toggles to: **E = Explained Absence**
- Explained Absences are excluded from statistics for Present and Absent.

### Scope of change
- **Database**: add a tri‑state field to `attendance_records` and backfill.
- **Server API**: read/write tri‑state while maintaining backward compatibility with the existing boolean `present`.
- **Client**: tri‑state UX and request payloads; adjust summaries and polling reconciliation.
- **Reports/analytics/notifications**: treat `excused` as neither present nor absent; keep “last attendance” based on Present only.

---

## UX and interaction design

### Interactions
- **Single tap** toggles between Absent ↔ Present (unchanged from today).
- **Double tap** on the same person within 2 seconds sets status to **Excused**.
- **From Excused**, the next single tap returns to **Absent**.

Rationale: preserves fast single‑tap present/absent workflow and adds a quick path for excused. The double‑tap window is local per person.

### Visuals and accessibility
- Present: existing green check state (no change).
- Absent: existing unchecked state (no change).
- Excused: distinct style (e.g., amber border/background) with a small "E" glyph. Tooltip/aria‑label: "Explained absence".

### Families and visitors
- Family “Check all / Uncheck all” continues to set Present/Absent only; no family‑wide “Excused” action initially.
- Visitors section remains unchanged; no tri‑state for visitors at this time.

### Summary counters
- Total Present = Regulars with `status = 'present'` + current selected visitors count.
- Absent = Regulars with `status = 'absent'` only.
- Visitors = unchanged.
- Excused is not counted in Present or Absent.

---

## API and data model

### Database: `attendance_records`
Add a new column to hold tri‑state status while preserving the existing boolean `present` for compatibility.

```sql
ALTER TABLE attendance_records
  ADD COLUMN status ENUM('present', 'absent', 'excused') NOT NULL DEFAULT 'absent' AFTER present;

-- Backfill from existing boolean present
UPDATE attendance_records SET status = 'present' WHERE present = 1;
UPDATE attendance_records SET status = 'absent' WHERE present = 0;

-- Optional: helpful index for filtering by status
CREATE INDEX idx_status ON attendance_records (status);
```

Notes:
- Keep `present` for now; derive it from `status` in writes/reads, then schedule removal in a future migration once all code paths stop using it.

### Server API: `server/routes/attendance.js`

- GET `/attendance/:gatheringTypeId/:date`
  - When selecting attendance, prefer `ar.status` if the column exists; derive `present` as `status = 'present'` for backward compatibility.
  - Return a new field on each regular attendee: `attendanceStatus: 'present' | 'absent' | 'excused'`.

- POST `/attendance/:gatheringTypeId/:date`
  - Accept payload items as either of:
    - `{ individualId: number, status: 'present' | 'absent' | 'excused' }`
    - `{ individualId: number, present: boolean }` (legacy)
  - On write:
    - If `status` is provided, set `status` accordingly and also set boolean `present = (status = 'present')` for compatibility.
    - If only `present` is provided, set `status = present ? 'present' : 'absent'`.
    - Update `individuals.last_attendance_date` only when `status = 'present'`.

- Backward compatibility
  - Gate tri‑state logic with `columnExists('attendance_records', 'status')` to allow zero‑downtime migration.

No changes to visitor endpoints are required.

### Client API: `client/src/services/api.ts`
- Extend `Individual` with `attendanceStatus?: 'present' | 'absent' | 'excused'`.
- Allow `attendanceAPI.record` payload items to include optional `status` as above.
- Continue to accept/emit `present` during the transition; the server will derive one from the other.

---

## Client implementation (UI)

### Local state
- Introduce `statusById: Record<number, 'present' | 'absent' | 'excused'>` alongside (or replacing) `presentById`.
- Maintain `savingById` and the existing per‑id write queue to serialize updates.
- Polling merge logic should compare/merge `attendanceStatus` (tri‑state) and retain the 15s "don’t clobber user edits" behavior.

### Toggle behavior
- On single tap:
  - If current is `absent` → set `present`.
  - If current is `present` → set `absent`.
  - If current is `excused` → set `absent`.
- On double tap within 2s (per person): set `excused`.

Implementation notes:
- Keep current immediate write behavior. If a user single‑taps then quickly double‑taps, two writes will occur (present → excused). This is acceptable given the existing write queue.
- Optionally, add a short debounce/coalescing window (e.g., 200–300ms) to turn an incoming second tap into a single write; not required for v1.

### Summaries and filters
- Update counters to use tri‑state logic as described above.
- UI styling adds an “E” indicator and distinct color for excused.

---

## Reports, analytics, notifications

- Any present/absent counts: treat `excused` as excluded from both.
- “Last attendance” and any present‑based metrics remain tied to `status = 'present'` (unchanged).
- If any absence notifications exist, decide whether excused should suppress notifications (recommended: yes, excused should not trigger absence alerts for that service).

---

## Migration and rollout plan

1) Database migration
- Add `status` column and backfill from `present`.
- Deploy with no app code changes first.

2) Server release (compatible)
- Update reads to return `attendanceStatus` and derive `present` from `status`.
- Update writes to accept `status` or `present` and to set both appropriately.

3) Client release
- Switch UI to consume `attendanceStatus` and to send `status` in updates.
- Update counters and visuals.

4) Cleanup (later)
- Remove reliance on boolean `present` throughout server and DB once clients are fully migrated.

Zero‑downtime: each step is backward compatible with both old/new clients.

---

## Testing strategy

- Unit tests (server)
  - Write with each of `present=true/false` and `status='present'|'absent'|'excused'` and verify DB state and `last_attendance_date` updates.
  - GET returns both `present` (derived) and `attendanceStatus` correctly.

- Integration tests (client ↔ server)
  - Toggle flows for single tap and double tap; verify final status server‑side.
  - Polling does not clobber recent local changes; tri‑state preserved.
  - Summary numbers exclude excused from both present and absent.

- UI tests
  - Visual state indicates E clearly; accessible labels and keyboard navigation behave as expected.

---

## Open questions

- Do we need an explicit family‑wide “Mark excused” action? (Proposed: not for v1.)
- Should visitors also support “excused”? (Proposed: not required now.)
- Double‑tap threshold: 2 seconds confirmed? (Alternatives: 1–1.5s for better responsiveness.)

---

## Implementation checklist (files to touch)

- Database migration: `server/migrations/023_add_attendance_status.sql` (new)
- Server
  - `server/routes/attendance.js`: GET and POST tri‑state support
  - `server/utils/attendanceNotifications.js`: ensure only `status='present'` triggers last attendance logic
- Client
  - `client/src/services/api.ts`: types and payloads
  - `client/src/pages/AttendancePage.tsx`: tri‑state state, toggle logic, counters, visuals, polling merge
  - Optional: small style additions for the E state

No code has been changed yet; this is a design/spec to guide the implementation.


