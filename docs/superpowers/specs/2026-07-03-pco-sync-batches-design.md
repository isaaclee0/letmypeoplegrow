# Planning Center Sync: Batch-Based Import/Sync

**Date:** 2026-07-03
**Status:** Approved

## Problem

Planning Center sync today is a single, global, all-or-nothing filter per
church (`church_settings.planning_center_membership_allowlist` +
`planning_center_field_filters`). Every sync re-evaluates that one filter
against the entire PCO population. This doesn't match how churches actually
want to bring people in: the first time, they may want to import members;
later, come back and import visitors; later still, pull in the youth group
using a different custom field — each as its own pass, without being
constrained by, or having to recreate, whatever filter was used before. There
is also no way to assign an imported group of people to a gathering as part
of importing them — gathering assignment today is entirely decoupled and
handled later via check-in import.

## Goals

1. Let a church define multiple independent, named, saved filter
   combinations ("batches"), each re-runnable at any time with any
   combination of membership allowlist / custom field rules.
2. Let each batch optionally set a default `people_type` for newly-created
   people and optionally assign an existing/new gathering that
   linked/imported people get added to.
3. Preserve today's plan/review/apply safety model (dry-run, bucketed diff,
   manual selection, re-validation on apply) per batch.
4. Let each batch have its own independent schedule (or be manual-only).
5. Correctly detect people who no longer belong to *any* saved batch
   (replacing the current single-filter "archive extras" check), without
   batches interfering with each other.
6. Migrate existing churches' single global filter into an equivalent batch
   with no loss of configuration.
7. Fold onboarding's PCO import step into the same batch mechanism.

## Non-Goals

- No cross-church or cross-batch bulk operations UI beyond what's described
  here.
- No per-person override of gathering assignment within a batch's review
  screen (batch either has one optional gathering or none — see Design
  Decisions).
- No change to check-in import (`checkin-import/*` routes) — that remains
  the separate mechanism for mapping PCO events/attendance to gatherings.
- No change to the `ambiguous`/`visitorMatches` resolution UX within a
  batch's review screen — reused as-is.
- No day-of-month picker, staggering, or catch-up/backfill logic for
  schedules — same constraints as the existing
  [2026-07-02-pco-sync-schedule-design.md](2026-07-02-pco-sync-schedule-design.md).

## Design Decisions

(Captured from brainstorming — stated here so the rationale is preserved.)

- **Batches are named and saved**, not ad hoc, so a church can re-run
  "Youth Group" every month without rebuilding the filter.
- **Archive detection unions all saved batches.** A person only gets
  flagged as a true "extra" if they match *none* of the church's saved
  batches — not just the one currently running. This is why archive-extra
  detection is pulled out into its own reconciliation action (below) rather
  than computed per-batch.
- **Gathering assignment is optional, single-gathering-per-batch.** No
  per-person override; a batch either has one associated gathering (applied
  to everyone it imports/links) or none.
- **Scheduling is per-batch.** Each batch independently opts into
  daily/weekly/monthly auto-apply, or stays manual-only.
- **Existing global filter auto-migrates** into a batch called "Main Sync"
  on upgrade, carrying over its existing schedule.
- **Onboarding's PCO step becomes "create your first batch"** using the same
  UI as Settings, with gathering assignment inline since the roster starts
  empty. The separate `pco-gatherings` onboarding step is removed.
- **New people get a batch-level default `people_type`.**

## Data Model

### New table: `planning_center_sync_batches`

Defined in `server/config/schema.js`, created per-church (same pattern as
other per-church tables):

```
planning_center_sync_batches
  id                          INTEGER PRIMARY KEY
  church_id                   TEXT (existing per-church convention)
  name                        TEXT NOT NULL
  membership_filter_enabled   INTEGER DEFAULT 0
  membership_allowlist        TEXT (JSON array of membership category strings)
  field_filter_enabled        INTEGER DEFAULT 0
  field_filters                TEXT (JSON array of {fieldDefinitionId, values[]})
  default_people_type         TEXT DEFAULT 'regular'  -- 'regular' | 'local_visitor' | 'traveller_visitor'
  gathering_type_id           INTEGER NULL (FK -> gathering_types.id)
  schedule_enabled            INTEGER DEFAULT 0
  schedule_frequency          TEXT DEFAULT 'weekly'   -- 'daily' | 'weekly' | 'monthly'
  schedule_day                INTEGER DEFAULT 1       -- 0-6, weekly only
  last_sync_at                TEXT (ISO)
  last_sync_result            TEXT (JSON summary — same shape as today's per-sync result)
  created_at, updated_at
```

This is the same shape as today's global config, just multiplied and named,
plus the two new fields (`default_people_type`, `gathering_type_id`).

### `church_settings` changes

- `planning_center_sync_enabled` — repurposed as the church-level master
  switch; gates whether *any* batch (scheduled or manual) may run. No longer
  paired with a single filter.
- `planning_center_membership_filter_enabled`,
  `planning_center_membership_allowlist`, `planning_center_field_filter_enabled`,
  `planning_center_field_filters`, `planning_center_sync_frequency`,
  `planning_center_sync_day` — removed after the one-time migration reads
  them (see Migration below).
- New columns for the reconciliation action (it's a per-church singleton,
  not a list, so it stays in `church_settings` rather than getting its own
  table):
  - `planning_center_reconciliation_schedule_enabled INTEGER DEFAULT 0`
  - `planning_center_reconciliation_frequency TEXT DEFAULT 'weekly'`
  - `planning_center_reconciliation_day INTEGER DEFAULT 1`
  - `planning_center_reconciliation_last_run_at TEXT`
  - `planning_center_reconciliation_last_result TEXT (JSON)`
- `planning_center_last_sync`, `planning_center_last_sync_archived`,
  `planning_center_last_sync_result` — removed; superseded by
  per-batch `last_sync_at`/`last_sync_result` and the reconciliation
  columns above.

## Batch Lifecycle & API

Routes in `server/routes/integrations.js`, replacing the single-config
routes:

- `GET /planning-center/sync-batches` — list all batches for the church.
- `POST /planning-center/sync-batches` — create a batch.
- `PUT /planning-center/sync-batches/:id` — update a batch's config
  (filters, people_type, gathering, schedule).
- `DELETE /planning-center/sync-batches/:id` — delete a batch. Deleting a
  batch does not unlink or archive anyone already imported through it — it
  only stops future runs of that specific filter. (Their continued
  eligibility is picked up by whichever other batches still match them, or
  flagged by reconciliation if none do.)
- `GET /planning-center/sync-batches/:id/plan?refresh=1` — dry-run for one
  batch. Reuses `computePlanForChurch`/`diffEngine.js` scoped to this
  batch's filter, returning buckets: `link`, `restore`, `ambiguous`,
  `visitorMatches`, `add`, `update`, `archive`, `reactivate`. **Does not**
  include `archiveExtras` or `unmatchedVisitors` — those move to
  reconciliation.
- `POST /planning-center/sync-batches/:id/apply` — re-validates selections
  against a fresh plan (same anti-staleness/injection guard as today) and
  applies. New people in the `add` bucket are created with
  `people_type = batch.default_people_type`. If `gathering_type_id` is set,
  every linked/added individual from this run is also added to that
  gathering's roster (new `gathering_lists` insert, reusing whatever
  insert path check-in import / manual roster management already uses for
  "add this individual to this gathering").

Because each batch's `add`/`link` step only considers people matching that
batch's own filter, batches naturally don't interfere with each other:
someone already linked via Batch A simply won't appear in Batch B's `add`
bucket; if they also match Batch B's filter they appear as an informational
"already linked" entry, not a duplicate create.

The `archive`/`reactivate`/`update` buckets are unaffected by any of this —
they're driven by the PCO person's own status/name/age on an
*already-linked* individual, independent of which batch's filter matched
them, so no union logic is needed there.

## Reconciliation: "Check for people who left"

A separate, church-level action, not tied to any one batch.

- `GET /planning-center/reconciliation/plan?refresh=1` — computes the union
  of eligibility across every saved batch (a person counts as "still
  expected" if they match *any* batch's filter). Fetches all active,
  PCO-linked LMPG individuals and flags any whose PCO person no longer
  matches that union — this is today's `archiveExtras` bucket, correctly
  scoped. Also includes `unmatchedVisitors` (LMPG-owned visitors with no PCO
  match at all), since that's likewise a whole-roster concern.
- `POST /planning-center/reconciliation/apply` — same
  review-then-select-then-apply pattern, reusing
  `PlanningCenterSyncReview.tsx`'s bucket-list UI for these two buckets.
- Independently schedulable via the `church_settings` columns above,
  defaulting to manual-only (`schedule_enabled = 0`). When scheduled and
  due, runs and applies with empty selections (same unattended-apply
  precedent as today's batch cron), but because archiving is more
  consequential than adding, the result must remain visible in the UI
  (`planning_center_reconciliation_last_result`) rather than being a silent
  background action.

## Scheduling

`server/services/planningCenterSync.js`'s nightly 2 AM cron
(`cron.schedule('0 2 * * *', ...)`) is restructured from "one config check
per church" to "iterate every batch with `schedule_enabled = 1` across every
church with `planning_center_sync_enabled = 1`, plus each church's
reconciliation config if scheduled." The existing `isDueToday(frequency,
day)` helper is reused unchanged, just called per-batch/per-reconciliation
instead of once per church. Due batches run
`computePlanForChurch`/`applyForChurch` (scoped to that batch) and
auto-apply with empty selections, exactly as today. Manual "Run now" per
batch, and manual "Check for people who left" for reconciliation, bypass the
schedule gate entirely, same as today's manual sync button.

## Migration

A one-time migration (`server/config/database.js`, alongside existing
`planning_center_*` `ALTER TABLE` migrations):

1. Create the `planning_center_sync_batches` table.
2. Add the new `planning_center_reconciliation_*` columns to
   `church_settings`.
3. For each church where `planning_center_membership_filter_enabled` or
   `planning_center_field_filter_enabled` is set, insert one row into
   `planning_center_sync_batches` named `"Main Sync"`, copying
   `membership_allowlist`, `field_filters`, and the existing
   `planning_center_sync_frequency`/`planning_center_sync_day` as its
   schedule (with `schedule_enabled = 1`, `default_people_type = 'regular'`,
   `gathering_type_id = NULL`).
4. Drop the superseded `church_settings` columns listed above.

This runs once per per-church SQLite file, consistent with how other
`ALTER TABLE`/backfill migrations in `database.js` are applied.

## Client Changes

- `PlanningCenterIntegrationPanel.tsx`: the single membership/field filter
  editor is replaced with a batch list (name, filter summary, gathering,
  schedule, last result, Edit/Run now/Delete), plus a "Check for people who
  left" card showing the reconciliation schedule and last result. A "New
  batch" button opens the batch editor.
- New `PlanningCenterBatchEditor.tsx` component: name field, reuses existing
  `MembershipAllowlistEditor.tsx` and `FieldFilterEditor.tsx`, adds a
  `people_type` select and a gathering picker (existing gathering dropdown +
  "create new gathering" affordance, reusing whatever the current
  gathering-creation form component is), and a schedule
  frequency/day picker (reusing the select pattern from
  [2026-07-02-pco-sync-schedule-design.md](2026-07-02-pco-sync-schedule-design.md)).
- `PlanningCenterSyncReview.tsx`: takes a `batchId` (or `mode: 'reconciliation'`)
  prop instead of assuming the single global plan; otherwise unchanged.
- `OnboardingPage.tsx`: the `pco-people` step renders `PlanningCenterBatchEditor`
  + its plan/review/apply flow directly (creating the church's first batch),
  with the gathering picker surfaced prominently since the roster is empty.
  The `pco-gatherings` step is removed.

## Testing

- Server: unit tests for the batch-scoped `computePlanForChurch` (verify a
  person matching only Batch B never appears in Batch A's `add` bucket, and
  appears as informational "already linked" if they match both). Unit tests
  for reconciliation's union-eligibility logic (person matching any one of
  N batches is excluded from `archiveExtras`). Unit test for the migration
  script's one-time batch creation from existing global settings, run
  against a fixture per-church DB.
- Client: no existing test harness for the integration panel (consistent
  with prior PCO specs) — manual verification: create two batches with
  different filters, run each, confirm no cross-contamination; run
  reconciliation and confirm someone matching a second batch isn't flagged;
  verify onboarding's first-batch flow end-to-end against a fresh church.
