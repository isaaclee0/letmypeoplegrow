# PCO Check-Ins Historical Attendance Import — Design

**Date:** 2026-06-03
**Status:** Approved for planning

## Overview & Persona

A reusable importer that lets a church pull its historical attendance out of
Planning Center Check-Ins and into LMPG. The target user is a church that has
decided PCO Check-Ins no longer fits their needs but does not want to lose the
attendance history they have accumulated there.

The importer reads historical check-ins, lets the user decide which PCO events
become which LMPG gatherings, and writes **present-only** attendance records. It
lives in Settings → Integrations as a re-runnable preview→commit tool. Onboarding
surfaces a non-blocking prompt that links into it when check-in history is
detected.

This mirrors the existing Historical CSV importer
(`/planning-center/historical-csv-preview` / `-execute`), reusing its
preview→commit shape and its session/record upsert approach.

## Guiding Principles

- **PCO is the source of truth for People only — never for attendance.** Once
  attendance exists in LMPG, LMPG is the source of truth. The import never
  overwrites an existing attendance record.
- **Present-only.** Check-in data only tells us who attended. We never fabricate
  absences. Absence is only knowable from live tracking going forward.
- **Preserve history without polluting the present.** Former members who attended
  historically are imported so the record is complete, but they are not added to
  today's active rolls or gathering lists.

## Architecture

### New service module

`server/services/planningCenter/checkinsImport.js` holds the pure logic
(fetch → group → map → build records), keeping the route handlers thin — the same
separation the CSV importer uses between `matchAndBuildRecords` and its route.

### Endpoints (in `server/routes/integrations.js`)

1. `GET /planning-center/checkins/events?startDate&endDate`
   Returns the distinct PCO events that have check-ins in the range, each with a
   check-in count and date span. Powers the event-mapping screen. If no range is
   supplied, defaults to all available history.

2. `POST /planning-center/import-checkins/preview`
   Body: date range + event→target mapping. Dry run, **no writes**. Returns a
   summary: sessions that would be created, present records that would be written,
   records skipped because LMPG data already exists, people that would be
   auto-created as inactive, and a per-event / per-date breakdown.

3. `POST /planning-center/import-checkins/execute`
   Same body as preview. Performs the writes inside a single transaction and
   returns the realised summary.

The current stubbed `POST /planning-center/import-checkins` (the handler whose
body ends at the `TODO: Map check-ins to gatherings and create attendance
records`) is **replaced** by these. The existing `GET /planning-center/checkins`
browse endpoint is left unchanged.

OAuth already requests the `check_ins` scope (`integrations.js`, the
`/planning-center/authorize` handler), so no re-authorisation is required for
already-connected churches.

## Data Flow

1. **Fetch** — page through
   `https://api.planningcenteronline.com/check-ins/v2/check_ins?filter=checked_in_at&where[checked_in_at][gte]=…&where[checked_in_at][lte]=…&per_page=100&include=event,person`,
   following `links.next` until exhausted. (Same call already used by the browse
   and stub endpoints.)

2. **Group** — bucket check-ins by `(event, date)`, where `date` is the calendar
   date of `checked_in_at` evaluated in the church's configured timezone (so an
   evening check-in does not roll over to the next day).

3. **Map events to gatherings** — for each PCO event the user chose to import, the
   target is either:
   - an existing `gathering_type` selected by the user, or
   - **create new**: auto-create a standard `gathering_type` named from the PCO
     event.
   Events the user did not select are skipped entirely.

4. **Resolve people** by `individuals.planning_center_id`:
   - **Matched** (active or archived) → use the existing individual. Their
     `is_active` status is left untouched.
   - **Unmatched** (former member never synced) → create an individual linked by
     `planning_center_id`, with `is_active = 0` and `people_type = 'regular'`,
     using the name from the check-in's included `person` resource.

5. **Write** per `(gathering, date)`:
   - Upsert `attendance_sessions` for `(gathering_type_id, session_date,
     church_id)` — reuse if it exists, else insert (`created_by` = current user).
   - For each present individual, write `attendance_records` with `present = 1`
     using `INSERT ... ON CONFLICT(session_id, individual_id) DO NOTHING`.
     **DO NOTHING, not DO UPDATE** — this is the key difference from the CSV
     importer and enforces "LMPG attendance is truth": any existing record
     (present *or* absent) is preserved.
   - No absent records are ever written.
   - Update `individuals.last_attendance_date` to the latest present date for that
     person, only moving it forward (never backward).

All execute writes run inside `Database.transaction`.

## Key Decisions & Edge Cases

- **Idempotent / re-runnable.** Re-running merges. Existing sessions gain present
  records they were missing; existing records are never touched. Running twice
  produces no duplicates and no overwrites.
- **Existing LMPG attendance wins.** If a date already has a live session where a
  person was manually marked absent (or present), the import leaves that record
  alone — it only inserts records that do not yet exist.
- **Auto-created historical people** are `is_active = 0` and are **not** added to
  any active gathering list, so they do not clutter current rolls. Their
  attendance records still exist and surface in historical reports.
- **Children & visitors.** PCO check-ins include kids and guests. v1 treats every
  attendee as `people_type = 'regular'` (inactive if unmatched). Family/household
  linking of auto-created people is out of scope for v1.
- **Timezone.** Date bucketing uses the church's configured timezone.
- **Default range.** All available history (earliest check-in → today), editable
  by the user.

## UI / Onboarding

### Settings → Integrations

A new "Import attendance history from PCO" card, available whenever PCO is
connected. Flow:

1. Date range picker — pre-filled to all available history, editable.
2. Event mapping screen — a selectable list. Each row is a PCO event with its
   check-in count, an import on/off toggle, and a target selector
   (existing gathering, or "create new gathering").
3. Preview summary — sessions to create, present records to write, records skipped
   (LMPG already has data), people to be auto-created as inactive, per-event /
   per-date breakdown.
4. Confirm → execute.

### Onboarding

After the PCO connection step, detect whether any check-ins exist for the church.
If so, show a non-blocking, skippable prompt — "We found check-in history in
Planning Center. Want to import it?" — that links into the importer in
Integrations. Churches that skip it, or that onboarded before this shipped, can
always run it later.

## Out of Scope (v1)

- Ongoing / live check-in sync (this is a one-time historical migration).
- Family/household linking of auto-created historical people.
- Distinguishing children or visitor types from check-in metadata.
- Headcount-mode gatherings (import targets standard-mode gatherings only).

## Testing

- Unit tests for the pure logic in `checkinsImport.js`: grouping by
  `(event, date)` with timezone handling; event→gathering mapping including
  create-new; person resolution (matched-active, matched-archived, unmatched →
  inactive create); present-record building.
- Tests asserting the **DO NOTHING** behaviour: a pre-existing absent record is
  preserved; a pre-existing present record is preserved; a missing record is
  inserted as present.
- Idempotency test: running execute twice yields identical state and no
  duplicates.
- Follow the existing `planningCenter/*.test.js` style.
