# Planning Center Check-in Import Improvements — Design

**Date:** 2026-06-08
**Status:** Approved (design)

## Problem

The Planning Center check-in import flow ([client/src/components/PCOCheckinImport.tsx](../../../client/src/components/PCOCheckinImport.tsx),
[server/routes/integrations.js](../../../server/routes/integrations.js)) has five gaps:

1. **No progress feedback** during the (potentially long) PCO fetch — a year of check-ins is ~160 paginated pages. The user has no idea how long it will take.
2. **Settings aren't remembered** — every import is a fresh start; event→gathering mappings, the date range, and which events were already imported are all lost.
3. **New gatherings have empty member rosters** — gatherings created during import don't get the people who attended them on their roll (outside the onboarding-only path).
4. **No quick staff-user assignment** when creating a new gathering — the new gathering has no users assigned to manage it.
5. **No scheduling for new gatherings** — created with only name + `attendance_type`; `day_of_week`/`start_time`/`frequency` are left null, and irregular events (e.g. Good Friday) need special handling.

## Decisions (from brainstorming)

- Progress mechanism: **WebSocket** (reuse existing Socket.io).
- New-gathering member roster: **recent + active attendees only**, with an adjustable recency window surfaced in the Settings importer.
- Req #3 "assign users": **staff users** (`user_gathering_assignments`), options None / Me / Copy from existing gathering.
- Persist: **event→gathering mappings**, **already-imported markers**, and **last date range**.
- Schedule fields: **day/time/frequency, pre-filled, editable, optional** (import proceeds even if blank).
- Irregular events: **auto-flag as irregular, leave schedule blank**.
- Re-runs stay **non-destructive** and re-fetch (progress bar mitigates the wait); already-imported events are **not** hard-skipped — they're shown with an "imported through `<date>`" badge and pre-selected mapping.
- New-gathering config (name, schedule, staff-user dropdown) renders as an **inline sub-panel** beneath the row when target = New gathering.

## Architecture

### A. Fetch progress indicator (WebSocket)

- Thread an optional `onProgress` callback through `fetchAllCheckinsUncached` ([integrations.js:2134](../../../server/routes/integrations.js#L2134)).
  After the first page (total known) and after each parallel page batch, call
  `onProgress({ fetched, total, percent })`. `fetchAllCheckins` forwards the callback;
  cache hits invoke `onProgress` once at 100%.
- The client generates a `jobId` (uuid) per fetch and sends it to the events-list
  (`GET /planning-center/checkins/events`) and execute (`POST .../import-checkins/execute`) calls.
- The route emits progress with
  `webSocketService.broadcastToChurch(churchId, 'pco:import_progress', { jobId, phase, percent, fetched, total })`.
- Phases:
  - `fetching` — page-based percent (both events-list load and execute).
  - `writing` — during execute, records written / total writes.
- Client: subscribes to `pco:import_progress`, filters by its own `jobId`, renders a `%` bar
  with the current phase label. The bar shows during the initial auto-load fetch and during execute.

**Isolation note:** `jobId` in the payload prevents concurrent users/imports in the same church
from reading each other's progress; the church-scoped broadcast is fine because the client filters.

### B. Persist import settings (#1)

- New column: `church_settings.planning_center_checkin_import_state TEXT` (JSON).
  Added via the existing additive-migration pattern in
  [database.js:127](../../../server/config/database.js#L127) (PRAGMA `table_info` check + `ALTER TABLE … ADD COLUMN`),
  and added to [schema.js](../../../server/config/schema.js) for fresh DBs.
- Shape:
  ```json
  {
    "lastRange": { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" },
    "mappings": {
      "<pcoEventId>": {
        "target": "skip|existing|new",
        "gatheringTypeId": 0,
        "newGatheringName": "",
        "schedule": { "dayOfWeek": "", "startTime": "", "frequency": "", "irregular": false },
        "userAssignment": { "mode": "none|me|copy", "sourceGatheringTypeId": 0 }
      }
    },
    "imported": {
      "<pcoEventId>": { "lastImportedDate": "YYYY-MM-DD", "gatheringTypeId": 0 }
    }
  }
  ```
- Written on successful execute (merge, not overwrite — preserve other events' markers).
- `GET /planning-center/checkins/events` merges saved state into its response: each event gains
  `savedMapping` and `alreadyImportedThrough` (date or null). The client pre-selects mapping
  choices and pre-fills schedule/assignment from `savedMapping`, and shows an
  "Imported through `<date>`" badge when `alreadyImportedThrough` is set.
- New `GET /planning-center/checkin-import-state` returns `{ lastRange }` so the client can
  pre-fill the date inputs before fetching. (No separate save endpoint — execute persists.)

### C. Member roster auto-fill for new gatherings (#2)

- Reuse `checkinsImport.buildGatheringListAdds` (recent + active attendees).
- Currently gated behind onboarding's `assignToGatherings`. Change: during **any** import,
  auto-fill `gathering_lists` **only for newly-created gatherings** (target = `new`).
  Existing-gathering rosters are never touched.
- Surface the recency-weeks control (default 8) in the Settings importer UI
  (today onboarding-only — see `assignToGatherings`/`recencyWeeks` props in PCOCheckinImport).
- Implementation: in `runCheckinImport` commit path, compute the set of newly-created
  `gatheringTypeId`s, then run `buildGatheringListAdds` filtered to those gatherings (active +
  within recency window), inserting with the existing `ON CONFLICT DO NOTHING`.

### D. Staff-user assignment for new gatherings (#3)

- Mapping payload (new rows) gains `userAssignment: { mode: 'none'|'me'|'copy', sourceGatheringTypeId? }`.
- UI: dropdown in the new-gathering sub-panel — `None` / `Me` / `Copy from <existing gathering>`
  (existing gatherings listed from the already-loaded `gatherings`).
- On execute, after creating the gathering, write `user_gathering_assignments`:
  - `none` → nothing.
  - `me` → current `userId`.
  - `copy` → `SELECT user_id FROM user_gathering_assignments WHERE gathering_type_id = sourceGatheringTypeId`
    and insert each for the new gathering (`ON CONFLICT(user_id, gathering_type_id) DO NOTHING`).

### E. Schedule fields for new gatherings (#4)

- New pure helper `checkinsImport.deriveSchedule(eventSessions)` returns
  `{ dayOfWeek, startTime, frequency, irregular }`:
  - `dayOfWeek` — most common weekday across the event's session dates.
  - `startTime` — from `event_times` / most common service time of day (`HH:MM`).
  - `frequency` — infer from the median gap between consecutive session dates:
    ~7d → `weekly`, ~14d → `biweekly`, ~28–31d → `monthly`.
  - `irregular: true` — when dates don't fit a consistent weekday + regular gap
    (high variance, or annual-scale gaps). When irregular, `dayOfWeek`/`frequency` are returned null.
- `GET /planning-center/checkins/events` includes `suggestedSchedule` per event.
- UI (new-gathering sub-panel): editable day-of-week select, time input, frequency select,
  pre-filled from `suggestedSchedule` (or saved mapping). When `irregular`, show an
  "Irregular (no fixed schedule)" state with fields blank; user can still override.
  All fields optional.
- On create, write `day_of_week`, `start_time`, `frequency` into `gathering_types`
  (NULL for `day_of_week`/`frequency` when irregular). `start_time` may still be set if known.

### UI layout

- The summary table keeps: PCO Event, Check-ins, Dates, Import-as `<select>`.
- When a row's target is `new`, render an inline **sub-panel** (full-width row beneath) containing:
  gathering name, schedule controls (day / time / frequency, or Irregular), and the staff-user
  assignment dropdown. Keeps the table scannable while giving new gatherings room to configure.
- A progress bar component (`%` + phase label) shows during fetch (auto-load and `Find events`)
  and during execute.

## Data flow

1. Mount → `GET /checkin-import-state` (pre-fill dates) → auto-load `GET /checkins/events?jobId=…`
   (progress via WS) → response merges `savedMapping`, `alreadyImportedThrough`, `suggestedSchedule`.
2. User adjusts mappings / schedule / assignment (sub-panels for new rows).
3. `POST /import-checkins/preview` → counts (unchanged, plus respects new fields where relevant).
4. `POST /import-checkins/execute?jobId=…` → fetch (WS `fetching`) → transaction:
   create people → create gatherings (with schedule) → write attendance (WS `writing`) →
   roster auto-fill for new gatherings → staff-user assignments for new gatherings →
   persist `planning_center_checkin_import_state` (mappings + imported markers + lastRange).

## Error handling

- Progress is best-effort: a WS emit failure never fails the import (wrapped/logged).
- Mapping validation unchanged (new/existing require name/id). New optional fields are validated
  only when present (e.g. `userAssignment.mode === 'copy'` requires a valid `sourceGatheringTypeId`).
- All writes remain inside the existing single transaction; import-state persistence happens
  after the transaction commits (a persistence failure logs but doesn't roll back imported data).
- Church isolation: every new query filters by `church_id` (state column, user-assignment copy).

## Testing

Unit tests alongside existing `server/services/planningCenter/*.test.js`:

- `deriveSchedule`: weekly, biweekly, monthly, and irregular/annual (Good Friday-style) inputs.
- Import-state merge: new markers don't clobber existing ones; lastRange updates.
- `userAssignment` resolution: none/me/copy → expected `user_gathering_assignments` rows.
- Roster auto-fill: only newly-created gatherings get adds; recency/active filtering respected.
- `onProgress`: invoked with monotonically non-decreasing percent ending at 100.

## Out of scope

- Changing how existing gatherings' rosters or schedules behave.
- Hard-skipping already-imported events (kept non-destructive + re-fetch by choice).
- Background/queued import jobs (fetch stays request-scoped; progress is live via WS).
