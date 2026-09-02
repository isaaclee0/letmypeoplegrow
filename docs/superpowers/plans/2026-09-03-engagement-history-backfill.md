# Engagement History Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically reconstruct useful tier movement from each church's reliable attendance history before the engagement report is first served.

**Architecture:** Extract a pure weekly-state reducer from the existing confirmation evaluator, then add a coordinator that calculates historical weeks in memory and atomically persists final state, reconstructed transitions, and a rules-version completion marker. Run the coordinator sequentially at startup and retry pending churches from the existing weekly scheduler.

**Tech Stack:** Node.js, better-sqlite3 through the repository database adapter, Node test runner, React/TypeScript, Vitest.

## Global Constraints

- Historical replay uses current engagement settings, gathering roles, active-regular eligibility, and individual assignments retroactively.
- Historical and prospective evaluation use the same opportunity calculator and tier-confirmation state machine.
- Reconstructed transitions must never generate retrospective pastoral alerts.
- Backfill is idempotent per `(church_id, rules_version)` and failures remain retryable.
- Churches are processed sequentially; one church failure must not block server startup or other churches.

---

### Task 1: Backfill schema and transition provenance

**Files:**
- Modify: `server/config/engagementSchema.js`
- Modify: `server/config/engagementSchema.dbintegration.test.js`
- Modify: `server/services/engagement/declines.js`
- Modify: `server/services/engagement/declines.dbintegration.test.js`

**Interfaces:**
- Produces table `engagement_history_backfills` keyed by `(church_id, rules_version)`.
- Produces nullable `engagement_tier_transitions.reconstructed_at`.
- Pastoral transition queries consume only rows where `reconstructed_at IS NULL`.

- [ ] **Step 1: Write failing schema tests**

Assert that a fresh and upgraded church database contains `engagement_history_backfills` with the exact columns and composite primary key from the design, and that `engagement_tier_transitions` contains nullable `reconstructed_at`.

- [ ] **Step 2: Run schema tests and verify failure**

Run: `cd server && node --test config/engagementSchema.dbintegration.test.js`

Expected: FAIL because the marker table and provenance column do not exist.

- [ ] **Step 3: Add the additive schema**

Add `reconstructed_at TEXT` to the transition table creation and additive upgrade path. Add:

```sql
CREATE TABLE IF NOT EXISTS engagement_history_backfills (
  church_id TEXT NOT NULL,
  rules_version INTEGER NOT NULL CHECK(rules_version >= 1),
  first_week_end TEXT,
  last_week_end TEXT NOT NULL,
  weeks_evaluated INTEGER NOT NULL CHECK(weeks_evaluated >= 0),
  transitions_reconstructed INTEGER NOT NULL CHECK(transitions_reconstructed >= 0),
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(church_id, rules_version)
);
```

- [ ] **Step 4: Write and verify the failing pastoral exclusion test**

Insert one ordinary and one reconstructed unprocessed primary decline, run `processConfirmedPrimaryTransitions`, and assert only the ordinary transition is processed.

Run: `cd server && node --test services/engagement/declines.dbintegration.test.js`

- [ ] **Step 5: Exclude reconstructed rows from pastoral processing**

Add `AND transition.reconstructed_at IS NULL` to every query that selects pending transitions for decline processing, then rerun both test files.

---

### Task 2: Share the weekly state reducer

**Files:**
- Modify: `server/services/engagement/tierConfirmationEvaluator.js`
- Modify: `server/services/engagement/tierConfirmationEvaluator.dbintegration.test.js`
- Create: `server/services/engagement/tierHistoryReplay.test.js`

**Interfaces:**
- Produces `evaluateProfileWeek({ profiles, previousStates, baselineOnly? })` returning `{ states, transitions, outcomes }` without database writes.
- Existing `evaluateEngagementTierConfirmations(churchId, options)` retains its public signature and result.

- [ ] **Step 1: Write a failing pure-reducer test**

Create profile fixtures for two chronological completed weeks. Assert the first call baselines and the second starts a candidate while leaving the supplied previous-state map unchanged.

- [ ] **Step 2: Run and verify failure**

Run: `cd server && node --test services/engagement/tierHistoryReplay.test.js`

Expected: FAIL because `evaluateProfileWeek` is not exported.

- [ ] **Step 3: Extract the pure reducer**

Move the per-profile/per-axis loop and absent-profile cleanup from `evaluateEngagementTierConfirmations` into `evaluateProfileWeek`. Keep `evaluateTierConfirmation` as the only tier state machine. Export the reducer for the replay service and tests.

- [ ] **Step 4: Adapt prospective persistence to the reducer**

Load persisted states, call `evaluateProfileWeek`, then use the existing `upsertTierStates` and `insertTransitions` paths. Preserve concurrency/version guards and returned outcome counts.

- [ ] **Step 5: Run evaluator tests**

Run: `cd server && node --test services/engagement/tierHistoryReplay.test.js services/engagement/tierConfirmationEvaluator.dbintegration.test.js`

Expected: PASS with the existing prospective semantics unchanged.

---

### Task 3: Historical replay and atomic marker persistence

**Files:**
- Create: `server/services/engagement/historyBackfill.js`
- Create: `server/services/engagement/historyBackfill.dbintegration.test.js`
- Modify: `server/services/engagement/tierConfirmationEvaluator.js` only if persistence helpers need exports.

**Interfaces:**
- Produces `backfillEngagementHistory(churchId, { asOf?, __deps? } = {})`.
- Returns `{ status: 'completed' | 'already_completed' | 'stale', rulesVersion, firstWeekEnd, lastWeekEnd, weeksEvaluated, transitionsReconstructed }`.

- [ ] **Step 1: Write failing replay-range and transition tests**

Seed reliable weekly attendance spanning more than 13 weeks with a sustained threshold crossing. Assert chronological profile calculations reconstruct the expected candidate and confirmed transition. Add short-history, excluded-session, and no-eligible-session cases.

- [ ] **Step 2: Run and verify failure**

Run: `cd server && node --test services/engagement/historyBackfill.dbintegration.test.js`

Expected: FAIL because the backfill service does not exist.

- [ ] **Step 3: Implement replay calculation**

Find the earliest reliable held standard session assigned a `primary` or `community` role. Convert it and `asOf` to completed church-local week ends using `getEngagementWindow`. Iterate in seven-day steps, call `calculateEngagementProfiles(churchId, { asOf: end-of-week instant })`, and reduce from an empty state map with `evaluateProfileWeek`.

- [ ] **Step 4: Implement atomic persistence**

Before calculation, return `already_completed` when the current marker exists. In the final transaction re-read the current rules version and marker; return `stale` if either changed. Upsert final states, insert reconstructed transitions with one shared `reconstructed_at`, and insert the marker in the same transaction.

- [ ] **Step 5: Add failure, idempotency, version, and metadata tests**

Assert calculation failure and transaction failure leave no marker; rerun does no calculation; a new rules version replays independently; existing duplicate transitions retain pastoral metadata; and reconstructed rows have `reconstructed_at`.

- [ ] **Step 6: Run the backfill and existing evaluator suites**

Run: `cd server && node --test services/engagement/historyBackfill.dbintegration.test.js services/engagement/tierConfirmationEvaluator.dbintegration.test.js`

---

### Task 4: Automatic startup and weekly retry coordinator

**Files:**
- Create: `server/services/engagement/historyBackfillCoordinator.js`
- Create: `server/services/engagement/historyBackfillCoordinator.test.js`
- Modify: `server/index.js`
- Modify: `server/services/weeklyReviewScheduler.js`
- Modify: `server/services/weeklyReviewScheduler.test.js`

**Interfaces:**
- Produces `backfillPendingChurches({ churches?, asOf?, __deps? } = {})` returning per-church results without throwing for individual church failures.
- Startup awaits the coordinator after database initialization and before `server.listen()`.
- Weekly scheduler invokes the coordinator before normal weekly church work.

- [ ] **Step 1: Write failing sequential coordinator tests**

Use deferred promises to prove church B does not start until church A settles. Assert an A failure is captured and B still completes. Assert only approved churches are selected by default.

- [ ] **Step 2: Run and verify failure**

Run: `cd server && node --test services/engagement/historyBackfillCoordinator.test.js`

- [ ] **Step 3: Implement the coordinator**

Load `Database.listChurches()`, filter `is_approved`, await `backfillEngagementHistory` in a `for...of` loop, and emit aggregate-only timing/result logs.

- [ ] **Step 4: Wire startup and weekly retry with dependency seams**

Await the coordinator in a non-fatal `try/catch` before `server.listen()`. Invoke it once per scheduler tick before per-church email timing gates so a disabled weekly email does not disable engagement retry.

- [ ] **Step 5: Run coordinator and scheduler tests**

Run: `cd server && node --test services/engagement/historyBackfillCoordinator.test.js services/weeklyReviewScheduler.test.js`

---

### Task 5: Expose reconstruction metadata and explain it in the report

**Files:**
- Modify: `server/services/engagement/overview.js`
- Modify: `server/services/engagement/overview.dbintegration.test.js`
- Modify: `client/src/services/api.ts`
- Modify: `client/src/services/engagementReportCache.ts`
- Modify: `client/src/services/engagementReportCache.test.ts`
- Modify: `client/src/components/reports/EngagementMovementPanel.tsx`
- Modify: `client/src/components/reports/LongTermHealthReport.tsx`
- Modify: `client/src/components/reports/LongTermHealthReport.test.tsx`

**Interfaces:**
- Adds `historyBackfill: { completed: boolean; firstWeekEnd: string | null; lastWeekEnd: string | null; weeksEvaluated: number; transitionsReconstructed: number }` to `EngagementOverviewDto`.
- Adds optional `historyBackfill` prop to `EngagementMovementPanel`.

- [ ] **Step 1: Write failing overview and cache-contract tests**

Assert the current rules-version marker is returned, another rules version is ignored, and cached overview validation requires well-formed backfill metadata for the incremented schema version.

- [ ] **Step 2: Run and verify server/client failures**

Run: `cd server && node --test services/engagement/overview.dbintegration.test.js`

Run: `cd client && npm test -- --run src/services/engagementReportCache.test.ts src/components/reports/LongTermHealthReport.test.tsx`

- [ ] **Step 3: Add overview metadata and client contract**

Load the marker for the active rules version alongside tier activity, include the normalized object in the overview response, increment the overview schema version, and update TypeScript/cache validation.

- [ ] **Step 4: Add quiet reconstruction copy**

When completed historical replay contains at least one evaluated week, show beneath Tier movement: “Historical movement was reconstructed using current engagement settings and assignments.” Do not render it as an alert or banner.

- [ ] **Step 5: Run focused verification**

Run: `cd server && node --test config/engagementSchema.dbintegration.test.js services/engagement/tierHistoryReplay.test.js services/engagement/tierConfirmationEvaluator.dbintegration.test.js services/engagement/historyBackfill.dbintegration.test.js services/engagement/historyBackfillCoordinator.test.js services/engagement/declines.dbintegration.test.js services/engagement/overview.dbintegration.test.js services/weeklyReviewScheduler.test.js`

Run: `cd client && npm test -- --run src/services/engagementReportCache.test.ts src/components/reports/LongTermHealthReport.test.tsx src/components/reports/ReportsPage.test.tsx`

Run: `cd client && npm run build`

Run: `git diff --check`

Expected: all selected suites and the client production build pass; generated service-worker timestamp changes are reverted without disturbing user work.
