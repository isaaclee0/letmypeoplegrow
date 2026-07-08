# Planning Center: Remove Blind Apply, Notify on Review-Needed

**Date:** 2026-07-09
**Status:** Approved

## Problem

Two places apply a Planning Center sync batch with zero review — no ambiguous
matches resolved, no visitor promotions decided, no family name updates
confirmed:

1. The manual **"Run now"** button on each batch in Settings → Integrations
   (`PlanningCenterIntegrationPanel.tsx`), which calls
   `applyPlanningCenterBatch(batch.id, {})` directly instead of opening
   "Review & sync".
2. **Onboarding's first batch** (`OnboardingPage.tsx`), which does the exact
   same empty-selection apply immediately after the batch is created.

A human is present for both of these — unlike the nightly cron sync, where
blind-apply is unavoidable. Given the matching/eligibility logic has had
several real correctness bugs surface only after real usage (see
`docs/PCO_INTEGRATION_ANALYSIS.md`), skipping review when a human is right
there and could review is unnecessary risk with no offsetting benefit.

The nightly cron sync and scheduled reconciliation must stay unattended —
there's no human to review at 2 AM — but today they run completely silently.
An admin has no way to know a scheduled run left ambiguous matches unlinked,
visitor promotions undecided, family name updates pending, or that
reconciliation auto-archived a batch of people, unless they proactively open
Settings and check.

## Goals

1. Remove the manual "Run now" blind-apply path from Settings — batches are
   only ever run manually via "Review & sync".
2. Remove onboarding's blind auto-apply of the first batch — the admin goes
   through the same review screen used in Settings before continuing the
   wizard.
3. After a scheduled (cron) run leaves anything for a human to look at
   (ambiguous matches, visitor-match suggestions, pending family name
   updates, or reconciliation archives), notify every admin/coordinator in
   the church via the existing in-app notification system.
4. Don't re-notify every single night for the exact same unresolved
   situation — only notify when something is new or has changed since the
   last notification.

## Non-Goals

- No change to scheduled batch runs' or scheduled reconciliation's actual
  apply behavior — archive/reactivate/link/restore/add/update stay
  automatic on cron, exactly as today. This is visibility, not a new
  approval gate. (Explicit choice — see Design Decisions.)
- No deep-linking from the notification into a specific batch's review
  screen. Clicking it just marks it read, same as every other notification
  today; the message tells the admin where to go.
- No change to the underlying `notifications` table schema
  (`notification_type`/`reference_type` CHECK constraints) — reuses the
  existing `'system'` type with no reference, same as
  `weeklyReviewScheduler.js`'s nudge notification.
- No change to how "Review & sync" itself works, or to the manual
  reconciliation review screen.

## Design Decisions

(Captured from brainstorming — stated here so the rationale is preserved.)

- **Scheduled runs keep auto-applying everything they do today.** The
  alternative — holding reconciliation's archives for manual approval — was
  considered and explicitly rejected: it would turn an unattended nightly
  job into one that silently does nothing useful most nights, and archiving
  is already reversible (reactivate). The notification's job is to make the
  existing automatic behavior *visible*, not to gate it.
- **The notification covers the full held-back picture, not just what was
  literally named in the request.** Ambiguous matches, visitor-match
  suggestions, and family-name updates are all things a scheduled run
  already skips every time by existing design (see
  `docs/PCO_INTEGRATION_ANALYSIS.md`, "Family name updates skipped on
  unattended cron — correct per design") — an admin should see the whole
  set of pending review items in one place, not just part of it.
- **De-dup by comparing against the last-notified snapshot, not by time.**
  A family-name mismatch can sit pending indefinitely (it only clears when
  a human opens Review & Sync). Renotifying every single night with an
  identical count would make the notification easy to tune out. Comparing
  against what was last notified (stored per church) means a fresh
  notification only fires when the picture actually changes — new
  ambiguous matches appear, a count grows, or (after having gone quiet) new
  issues reappear.
- **One combined notification per church per cron run, not one per batch.**
  A church can have several batches; getting five separate notifications
  for one night's sync would be worse than one summary. Counts are summed
  across every batch that ran that cycle, plus reconciliation if it ran.
- **Onboarding gets a review step, not a "skip review" affordance that
  quietly reintroduces blind-apply.** The new `pco-review` wizard step
  reuses `PlanningCenterSyncReview` as-is (no new props) with a separate
  "Continue" button below it — consistent with how the check-in import step
  already has a "Skip" option. The admin isn't forced to click "Apply
  sync" before continuing (the batch is saved regardless and can be run
  later from Settings), but blind-apply is gone: nothing applies until the
  admin explicitly clicks "Apply sync" inside the review screen.

## Client Changes

### Settings (`PlanningCenterIntegrationPanel.tsx`)

- Remove the "Run now" `<button>`, the `runBatchNow` handler, and the
  `runningBatchId` state. Batch list actions become: Edit / Review & sync /
  Delete.

### Onboarding (`OnboardingPage.tsx`)

- Add `'pco-review'` to the `step` union, inserted between `'pco-people'`
  and `'pco-gatherings'`.
- Add state to hold the newly created batch's id (e.g. `firstBatchId`).
- `onFirstBatchSaved(batch)`: stop calling `applyPlanningCenterBatch`
  entirely. Just `setFirstBatchId(batch.id)` and `setStep('pco-review')`.
- Remove the `importingPeople` state and its "Importing…" branch — no
  longer needed, since there's no synchronous apply call blocking the UI
  at this step anymore.
- New `'pco-review'` branch renders `<PlanningCenterSyncReview
  connected={true} batchId={firstBatchId} />` plus a "Continue" button
  that calls `setStep('pco-gatherings')`.

## Server Changes

### Aggregating scheduled-run results (`planningCenterSync.js`)

- `runBatchSync()` currently computes a `summary` object, persists it to
  the batch row, and discards it. Change it to also `return summary` (or
  `null` if it caught an error) so the caller can aggregate.
- Add `familyNameUpdatesPending: plan.familyNameUpdates.length` to that
  summary — the count of family-name proposals this run *skipped* (as
  opposed to `familyNamesUpdated`, which is how many were actually
  applied — always 0 on cron, since they're always skipped there).
- `runReconciliationSync()` similarly should `return summary` (or `null` on
  error) instead of discarding it.
- In `syncChurch()`, after the `dueBatches` loop and the reconciliation
  call, sum across every non-null summary returned this cycle:
  - `ambiguous` (from batch summaries)
  - `visitorMatches` (from batch summaries)
  - `familyNameUpdatesPending` (from batch summaries)
  - `archived` (from the reconciliation summary, if reconciliation ran)
- Call `maybeNotifyPcoReviewNeeded(churchId, totals)` with those four
  numbers.

### `maybeNotifyPcoReviewNeeded(churchId, totals)` (new, `planningCenterSync.js`)

1. Read `church_settings.planning_center_last_notified_review` (new JSON
   column, nullable) for this church.
2. If every value in `totals` is zero: if a snapshot was stored, clear it
   (`UPDATE ... SET planning_center_last_notified_review = NULL`) so a
   future reappearance notifies fresh; return without notifying.
3. If `totals` deep-equals the stored snapshot: return without notifying
   (nothing has changed since the last notification).
4. Otherwise: build a message from whichever counts are nonzero (e.g. "3
   ambiguous matches, 2 possible visitor matches, and 1 family name update
   are waiting in Review & Sync. Reconciliation also archived 4 people you
   may want to double-check."), query
   `SELECT id FROM users WHERE role IN ('admin','coordinator') AND
   is_active = 1 AND church_id = ?` (same query
   `weeklyReviewScheduler.js` uses), insert one
   `INSERT INTO notifications (user_id, title, message, notification_type,
   church_id) VALUES (?, ?, ?, 'system', ?)` per admin, and persist
   `totals` as the new snapshot.

### Schema

- Add `planning_center_last_notified_review TEXT` (nullable JSON) to
  `church_settings` in `server/config/schema.js`, plus the corresponding
  `ALTER TABLE ... ADD COLUMN` in `server/config/database.js`'s existing
  additive-migration block, next to the other PCO columns.

## Testing

- Unit test `maybeNotifyPcoReviewNeeded`'s decision logic (all-zero →
  clear + no notify; unchanged from snapshot → no notify; changed/new →
  notify + snapshot updated) — this is DB-touching, so follow whatever
  pattern is used for other DB-touching PCO tests, or test the pure
  comparison logic as an extracted function if that's cleaner (existing
  PCO service tests only cover pure functions — see
  `docs/PCO_INTEGRATION_ANALYSIS.md` cross-review addendum for why
  DB/network-coupled PCO code has no existing test convention to follow).
- Manual verification: run a scheduled sync (`pcoSync.runNow()` bypasses
  the schedule check, per existing comment) against a church with a known
  ambiguous match, confirm one notification appears per admin; run it
  again unchanged, confirm no duplicate notification; resolve the
  ambiguous match, run again with a new unrelated issue, confirm a fresh
  notification fires.
- Manual verification in the browser: confirm "Run now" is gone from
  Settings; confirm onboarding's PCO path shows the review screen and
  "Continue" advances the wizard without requiring an apply.
