# Confirmed Engagement Tier Transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make engagement tiers durable classifications that change only after at least eight new reliable opportunities support a candidate tier within a 13-completed-week attempt, for both Primary and Other participation.

**Architecture:** Keep the rolling 52-week opportunity calculation as the source of calculated evidence, then add a deterministic two-axis confirmation state machine and additive persisted tier state/history. Weekly evaluation advances state transactionally; durable confirmed Primary transitions are processed separately by the existing pastoral decline workflow. Reporting reads established state, uses calculated data only as a clearly labelled baseline-pending fallback, and exposes tokenised confirmation/transition drilldowns to a compact inline UI.

**Tech Stack:** Node.js 22, Express 5, better-sqlite3, React 19, TypeScript 6, Axios, Chart.js/react-chartjs-2, Tailwind CSS, Vitest/Testing Library, Node test runner.

## Global Constraints

- Treat `church_id` as mandatory on every state, history, pastoral, report, and lifecycle query. Derive it from authenticated context or the scheduler, never from client payloads.
- Keep internal role keys `primary`, `community`, and `other`; render them as **Primary**, **Other participation**, and **Excluded** respectively.
- Keep internal tier keys `core`, `casual`, and `irregular`; labels and colours remain church-configurable presentation values.
- Continue calculating rolling 52-completed-week rates from the existing 56-week source load. Do not add older-history queries or reconstruct historical candidates.
- Count only the existing reliable opportunity facts: Primary is deduplicated to one opportunity per person per church week; Other participation keeps one opportunity per eligible standard session.
- A candidate starts after the completed-week boundary where the calculated tier first differs. The crossing opportunity cannot also confirm the candidate.
- Confirmation requires at least eight reliable opportunities within the following 13 completed weeks. Evidence may confirm as soon as the eighth opportunity is available.
- Confirmation evidence must classify at the candidate tier or farther in the same direction. A direct two-tier candidate requires evidence for that farther target.
- Changing thresholds or gathering roles increments `calculation_rules_version` and causes a baseline-only evaluation. It must not create transition history, pastoral events, or notifications.
- Keep `engagement_evaluation_state` for compatibility, but remove it from raw-crossing decisions. Do not destructively migrate or drop it.
- Keep immediate and consecutive-absence handling independent from long-term tier confirmation.
- Only confirmed downward Primary transitions create decline events or caregiver deliveries. Other participation transitions never do.
- Preserve detection-time caregiver recipient selection and idempotent delivery retry semantics.
- Build on the report UI work already present in the branch. Do not discard or overwrite unrelated uncommitted changes.
- Do not change package manifests or lock files to repair the repository's pre-existing `tz-lookup` dependency mismatch. Use the existing compatible server dependency setup for focused tests when necessary.

---

## File Structure

### New server files

- `server/services/engagement/tiers.js` — shared tier classification, rank, direction, and evidence-support rules.
- `server/services/engagement/tiers.test.js` — exact threshold and direction tests.
- `server/services/engagement/tierConfirmation.js` — pure candidate baseline/start/advance/cancel/expire/confirm state machine.
- `server/services/engagement/tierConfirmation.test.js` — table-driven state-machine tests.
- `server/services/engagement/tierConfirmationEvaluator.js` — church-scoped bulk state/history persistence and weekly orchestration.
- `server/services/engagement/tierConfirmationEvaluator.dbintegration.test.js` — baselines, retries, isolation, corrections, rules versions, and bounded-query tests.

### Modified server files

- `server/config/engagementSchema.js` — additive per-axis tier state, transition history, indexes, and decline evidence columns.
- `server/config/engagementSchema.dbintegration.test.js` — fresh/upgrade schema parity and integrity tests.
- `server/services/engagement/opportunities.js` — expose reliable dated opportunities and use shared tier classification.
- `server/services/engagement/opportunities.dbintegration.test.js` — dated Primary/Other participation fact coverage.
- `server/services/engagement/declines.js` — consume durable confirmed Primary transitions rather than raw four-week comparisons.
- `server/services/engagement/declines.dbintegration.test.js` — confirmed decline/recovery, recipient freeze, and retry tests.
- `server/services/engagement/overview.js` — established distributions/matrix and confirmation/transition drilldowns.
- `server/services/engagement/overview.dbintegration.test.js` — schema-v2 overview, fallback, drilldown, and isolation tests.
- `server/services/engagement/settings.js` — return whether calculation rules changed.
- `server/routes/settings.js` — request immediate baseline evaluation after rule changes.
- `server/routes/reports/engagement.js` — serve the schema-v2 overview and new token selectors.
- `server/routes/reports.engagement.test.js` — route contract and obsolete-token rejection tests.
- `server/services/weeklyReviewScheduler.js` — run confirmation then durable pastoral processing on the weekly evaluation day.
- `server/services/weeklyReviewScheduler.test.js` — ordering, email-disabled, failure-containment, and retry tests.
- `server/routes/individuals.js` — merge/delete handling for tier state and transition history.
- `server/routes/families.dbintegration.test.js` — merge integrity with new engagement records.
- `server/routes/onboarding.js` — church reset deletion order for the new tables.
- `server/routes/onboarding.timezone.dbintegration.test.js` — reset coverage.
- `server/scripts/wipeChurchPeopleAndFamilies.js` — delete new church-scoped records before people.
- `server/scripts/seed-demo.js` — clear new records during reseeding.

### New client files

- `client/src/components/reports/EngagementMovementPanel.tsx` — axis switch, confirmation cards, compact inline sortable table.
- `client/src/components/reports/EngagementMovementPanel.test.tsx` — switching, sorting, progress, empty, and accessible-label tests.

### Modified client files

- `client/src/services/api.ts` — schema-v2 overview and new drilldown row unions.
- `client/src/services/engagementReportCache.ts` — validate/cache only schema-v2 overview data.
- `client/src/services/engagementReportCache.test.ts` — old-cache invalidation and new-shape validation.
- `client/src/components/reports/LongTermHealthReport.tsx` — established tier presentation, baseline fallback, and new movement panel.
- `client/src/components/reports/LongTermHealthReport.test.tsx` — established-state, fallback, and integration tests.
- `client/src/components/reports/EngagementPeoplePanel.tsx` — established profile rows only; remove old previous-window movement presentation.
- `client/src/components/reports/EngagementMatrix.tsx` — Other participation terminology.
- `client/src/components/reports/EngagementSettings.tsx` — Other participation/Excluded terminology and definitions.
- `client/src/components/reports/EngagementSettings.test.tsx` — terminology and settings-definition coverage.
- `client/src/components/reports/PastoralCareReport.tsx` — Other participation terminology in user-facing insight copy.
- `client/src/components/reports/PastoralCareReport.test.tsx` — terminology in pastoral evidence and filters.
- `client/src/components/reports/ReportsPage.test.tsx` — report-shell regression and visible terminology coverage.

---

### Task 1: Add durable per-axis tier state and transition history

**Files:**
- Modify: `server/config/engagementSchema.js`
- Modify: `server/config/engagementSchema.dbintegration.test.js`

**Interfaces:**

- Produces `engagement_tier_state`, keyed by `(church_id, individual_id, axis)`.
- Produces `engagement_tier_transitions`, with one factual row per confirmed move.
- Adds confirmation evidence columns to `engagement_decline_events` without changing existing rows.
- Keeps the legacy `engagement_evaluation_state` table intact.

- [ ] **Step 1: Write failing fresh/upgrade schema tests**

Assert exact columns, checks, unique keys, church-leading indexes, and foreign keys on both a fresh church database and a legacy database upgraded by `ensureEngagementSchema`.

```js
assert.deepEqual(primaryKeyColumns(db, 'engagement_tier_state'), [
  'church_id', 'individual_id', 'axis',
]);
assert.equal(hasUniqueIndex(db, 'engagement_tier_transitions', [
  'church_id', 'individual_id', 'axis', 'from_tier', 'to_tier',
  'confirmed_week_end', 'rules_version',
]), true);
```

- [ ] **Step 2: Run the schema test and verify RED**

```bash
cd server && node --test config/engagementSchema.dbintegration.test.js
```

Expected: FAIL because the new tables and columns do not exist.

- [ ] **Step 3: Add the state table to `ENGAGEMENT_SCHEMA_SQL`**

Use this contract:

```sql
CREATE TABLE IF NOT EXISTS engagement_tier_state (
  church_id TEXT NOT NULL,
  individual_id INTEGER NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('primary','community')),
  rules_version INTEGER NOT NULL CHECK(rules_version >= 1),
  established_tier TEXT CHECK(established_tier IN ('core','casual','irregular')),
  candidate_tier TEXT CHECK(candidate_tier IN ('core','casual','irregular')),
  candidate_direction TEXT CHECK(candidate_direction IN ('higher','lower')),
  candidate_started_week_end TEXT,
  candidate_final_week_end TEXT,
  last_evaluated_week_end TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(church_id, individual_id, axis),
  CHECK((candidate_tier IS NULL AND candidate_direction IS NULL
         AND candidate_started_week_end IS NULL AND candidate_final_week_end IS NULL)
     OR (candidate_tier IS NOT NULL AND candidate_direction IS NOT NULL
         AND candidate_started_week_end IS NOT NULL AND candidate_final_week_end IS NOT NULL))
);
```

- [ ] **Step 4: Add transition history and indexes**

Create `engagement_tier_transitions` with `axis`, `from_tier`, `to_tier`, candidate/confirmation weeks, rules version, `long_term_attended`, `long_term_opportunities`, `long_term_rate`, `confirmation_attended`, `confirmation_opportunities`, `confirmation_rate`, nullable `pastoral_processed_at`, nullable `decline_event_id REFERENCES engagement_decline_events(id) ON DELETE SET NULL`, and `created_at`. Add indexes for church/person history, recent confirmations, and unprocessed Primary transitions.

```sql
CREATE INDEX IF NOT EXISTS idx_engagement_tier_transitions_unprocessed
  ON engagement_tier_transitions(church_id, axis, pastoral_processed_at, confirmed_week_end);
```

- [ ] **Step 5: Add decline-event confirmation evidence columns idempotently**

Extend both the fresh table definition and `addMissingColumns` with:

```sql
confirmation_attended_at_detection INTEGER
confirmation_opportunities_at_detection INTEGER
confirmation_rate_at_detection REAL
```

Use the same non-negative and `0..1` checks as the existing Primary evidence fields.

- [ ] **Step 6: Run schema tests and verify GREEN**

```bash
cd server && node --test config/engagementSchema.dbintegration.test.js config/database.test.js
```

Expected: PASS for fresh creation, repeat migration, and legacy upgrade.

- [ ] **Step 7: Commit the schema slice**

```bash
git add server/config/engagementSchema.js server/config/engagementSchema.dbintegration.test.js
git commit -m "feat(engagement): add confirmed tier state schema"
```

---

### Task 2: Expose dated opportunity facts and centralise tier mathematics

**Files:**
- Create: `server/services/engagement/tiers.js`
- Create: `server/services/engagement/tiers.test.js`
- Modify: `server/services/engagement/opportunities.js`
- Modify: `server/services/engagement/opportunities.dbintegration.test.js`

**Interfaces:**

```js
classifyEvidence({ assigned, attended, opportunities }, settings)
tierDirection(fromTier, toTier) // 'higher' | 'lower' | null
evidenceSupportsCandidate({ establishedTier, candidateTier, evidenceTier })

buildOpportunityProfiles(source, settings, window) => {
  current,
  comparison,
  coverage,
  datedOpportunities: { primary: OpportunityFact[], community: OpportunityFact[] }
}
```

`OpportunityFact` is `{ individualId: number, date: 'YYYY-MM-DD', attended: boolean }` and contains only already-vetted reliable opportunities.

- [ ] **Step 1: Write failing shared-tier tests**

Cover exact configured thresholds, fewer than eight opportunities, not assigned, both directions, evidence farther in the same direction, and direct Core-to-Irregular/Irregular-to-Core candidates.

```js
assert.equal(classifyEvidence(
  { assigned: true, attended: 3, opportunities: 5 }, settings,
).status, 'establishing');
assert.equal(evidenceSupportsCandidate({
  establishedTier: 'core', candidateTier: 'irregular', evidenceTier: 'casual',
}), false);
```

- [ ] **Step 2: Run the unit test and verify RED**

```bash
cd server && node --test services/engagement/tiers.test.js
```

- [ ] **Step 3: Implement the shared tier helpers**

Move `TIER_RANK`, classified-tier recognition, and `axisResult` threshold logic into `tiers.js`. Keep `MINIMUM_CLASSIFIED_OPPORTUNITIES = 8` as one exported constant used by both rolling profiles and confirmation evidence.

```js
const TIER_RANK = Object.freeze({ irregular: 0, casual: 1, core: 2 });
const direction = Math.sign(TIER_RANK[candidateTier] - TIER_RANK[establishedTier]);
return direction > 0
  ? TIER_RANK[evidenceTier] >= TIER_RANK[candidateTier]
  : TIER_RANK[evidenceTier] <= TIER_RANK[candidateTier];
```

- [ ] **Step 4: Add dated opportunity expectations to the integration test**

Assert that alternative Primary services still produce one weekly fact, Other participation sessions remain separate, and open/cancelled/excluded/headcount/unknown-provenance sessions produce no facts.

- [ ] **Step 5: Return the reliable facts from `buildOpportunityProfiles`**

Expose the existing `primaryOpportunities` and `communityOpportunityList` as `datedOpportunities` after reliability filtering. Do not add queries or reimplement provenance rules in the confirmation evaluator.

- [ ] **Step 6: Run opportunity and tier tests**

```bash
cd server && node --test services/engagement/tiers.test.js services/engagement/opportunities.dbintegration.test.js
```

Expected: PASS with unchanged rolling-profile results and the new dated facts.

- [ ] **Step 7: Commit the calculation slice**

```bash
git add server/services/engagement/tiers.js server/services/engagement/tiers.test.js server/services/engagement/opportunities.js server/services/engagement/opportunities.dbintegration.test.js
git commit -m "refactor(engagement): expose reliable dated opportunities"
```

---

### Task 3: Implement the pure 13-week confirmation state machine

**Files:**
- Create: `server/services/engagement/tierConfirmation.js`
- Create: `server/services/engagement/tierConfirmation.test.js`

**Interfaces:**

```js
evaluateTierConfirmation({
  completedWeekEnd,
  rulesVersion,
  calculatedStatus,
  calculatedEvidence,
  previousState,
  datedOpportunities,
  settings,
}) => {
  nextState,
  transition: null | ConfirmedTransition,
  outcome: 'baseline' | 'unchanged' | 'started' | 'advanced' |
           'cancelled' | 'expired' | 'confirmed' | 'ineligible'
}
```

The pure function performs no I/O, does not read the clock, and does not accept formatted labels.

- [ ] **Step 1: Write the complete failing state-machine table**

Include: first baseline; no candidate for `establishing`/`not_assigned`; crossing starts at zero evidence; crossing-week opportunity exclusion; exact eighth-opportunity upward/downward confirmation; unsupported evidence; farther-same-direction support; direct two-tier rejection; return cancellation; target-change restart; inactivity/unassignment cancellation represented by an ineligible calculated status; 13-week expiry; next-week restart; rules-version rebaseline; and same-week idempotency.

```js
assert.deepEqual(result.nextState, {
  rulesVersion: 4,
  establishedTier: 'casual',
  candidateTier: 'core',
  candidateDirection: 'higher',
  candidateStartedWeekEnd: '2026-06-07',
  candidateFinalWeekEnd: '2026-09-06',
  lastEvaluatedWeekEnd: '2026-06-07',
});
assert.equal(result.transition, null);
```

- [ ] **Step 2: Run the state-machine test and verify RED**

```bash
cd server && node --test services/engagement/tierConfirmation.test.js
```

- [ ] **Step 3: Implement baseline, candidate start, and cancellation**

Use `candidate_final_week_end = candidate_started_week_end + 91 days`. Filter evidence with `date > candidate_started_week_end && date <= completedWeekEnd`; this explicitly excludes the crossing boundary.

- [ ] **Step 4: Implement confirmation progress and success**

Derive confirmation numerator/denominator on every evaluation from dated facts. Once there are eight facts, classify them with the same thresholds and call `evidenceSupportsCandidate`. On success, establish exactly `candidateTier`, even when the confirmation evidence lies farther in the same direction.

```js
const transition = {
  fromTier: previousState.establishedTier,
  toTier: previousState.candidateTier,
  candidateStartedWeekEnd: previousState.candidateStartedWeekEnd,
  confirmedWeekEnd: completedWeekEnd,
  longTermEvidence: calculatedEvidence,
  confirmationEvidence,
};
```

- [ ] **Step 5: Implement expiry without same-run restart**

When the final eligible week is reached without support, clear the candidate and return `expired`. A later completed-week evaluation may start a new attempt if the calculated tier still differs.

- [ ] **Step 6: Run the state-machine tests and verify GREEN**

```bash
cd server && node --test services/engagement/tiers.test.js services/engagement/tierConfirmation.test.js
```

- [ ] **Step 7: Commit the pure state machine**

```bash
git add server/services/engagement/tierConfirmation.js server/services/engagement/tierConfirmation.test.js
git commit -m "feat(engagement): confirm tier changes over thirteen weeks"
```

---

### Task 4: Persist weekly confirmation state and transition history atomically

**Files:**
- Create: `server/services/engagement/tierConfirmationEvaluator.js`
- Create: `server/services/engagement/tierConfirmationEvaluator.dbintegration.test.js`

**Interfaces:**

```js
evaluateEngagementTierConfirmations(churchId, {
  asOf = new Date(),
  baselineOnly = false,
} = {}) => Promise<{
  completedWeekEnd,
  baselined,
  candidatesStarted,
  candidatesCancelled,
  candidatesExpired,
  transitionsConfirmed,
}>;
```

- [ ] **Step 1: Write failing persistence/integration tests**

Seed both axes for multiple people and two churches. Test first baseline, weekly advancement, correction-driven recomputation, cancellation, expiry/restart, exact transition evidence, repeated same-week runs, rules-version baseline, transaction rollback, inactive people, and no cross-church reads/writes.

- [ ] **Step 2: Add a bounded-query regression test**

Instrument the database calls for a representative roster and assert the evaluator uses a constant number of source/state/upsert queries rather than one query per person.

```js
assert.ok(queryCount <= EXPECTED_BULK_QUERY_CEILING);
assert.equal(queryLog.some((sql) => /WHERE individual_id = \?/i.test(sql)), false);
```

- [ ] **Step 3: Run the integration test and verify RED**

```bash
cd server && node --test services/engagement/tierConfirmationEvaluator.dbintegration.test.js
```

- [ ] **Step 4: Bulk-load profiles and current state**

Call `calculateEngagementProfiles` once, group `datedOpportunities` by person and axis in memory, and load all `engagement_tier_state` rows for the church/rules version in one query.

- [ ] **Step 5: Evaluate both axes deterministically**

For every active regular profile, call the pure state machine for `primary` and `community`. Pass `baselineOnly` by treating all classified calculated statuses as fresh established baselines and clearing candidates. Create state rows with a nullable established tier for ineligible axes so reassignment can baseline later without inventing a transition.

- [ ] **Step 6: Persist state and transitions in one church transaction**

Use JSON-backed bulk upserts, matching the existing engagement persistence style. Insert transition rows with `ON CONFLICT ... DO NOTHING` and never advance `pastoral_processed_at` here.

```sql
ON CONFLICT(church_id, individual_id, axis) DO UPDATE SET
  rules_version = excluded.rules_version,
  established_tier = excluded.established_tier,
  candidate_tier = excluded.candidate_tier,
  candidate_direction = excluded.candidate_direction,
  candidate_started_week_end = excluded.candidate_started_week_end,
  candidate_final_week_end = excluded.candidate_final_week_end,
  last_evaluated_week_end = excluded.last_evaluated_week_end,
  updated_at = datetime('now')
```

- [ ] **Step 7: Run evaluator tests and verify GREEN**

```bash
cd server && node --test services/engagement/tierConfirmationEvaluator.dbintegration.test.js
```

- [ ] **Step 8: Commit the persisted evaluator**

```bash
git add server/services/engagement/tierConfirmationEvaluator.js server/services/engagement/tierConfirmationEvaluator.dbintegration.test.js
git commit -m "feat(engagement): persist confirmed tier transitions"
```

---

### Task 5: Drive pastoral decline and recovery from durable Primary transitions

**Files:**
- Modify: `server/services/engagement/declines.js`
- Modify: `server/services/engagement/declines.dbintegration.test.js`

**Interfaces:**

```js
processConfirmedPrimaryTransitions(churchId, { throughWeekEnd } = {}) => Promise<{
  transitionsProcessed,
  eventsCreated,
  eventsRecovered,
  deliveriesCreated,
}>;
```

Keep `createEligibleDeliveryRowsWithConnection` available for existing callers/tests. Retain `evaluateEngagementDeclines` temporarily as an orchestration-compatible wrapper until the scheduler is changed in Task 6.

- [ ] **Step 1: Replace raw-crossing expectations with failing confirmed-transition tests**

Prove that a raw lower calculated tier and an active lower candidate create no event; a durable downward Primary transition creates one; Other participation creates none; an upward Primary transition recovers the correct open events; and a deeper later decline creates a distinct next episode.

- [ ] **Step 2: Add failure/retry and recipient-freeze tests**

Simulate failure after the tier transition commits but before pastoral processing completes. Retry and assert one decline event, one detection-time recipient set, no caregiver added later, and one processed marker/link on the transition.

- [ ] **Step 3: Run decline tests and verify RED**

```bash
cd server && node --test services/engagement/declines.dbintegration.test.js
```

- [ ] **Step 4: Load only durable unprocessed Primary transitions**

Select `axis = 'primary'`, `pastoral_processed_at IS NULL`, and optionally `confirmed_week_end <= throughWeekEnd`, ordered by confirmation week and ID. Never inspect rolling comparison profiles in this service.

- [ ] **Step 5: Process downward transitions transactionally**

Insert the decline event from transition `from_tier`/`to_tier`, copy both long-term and confirmation evidence, create eligible delivery rows immediately, then set the transition's `decline_event_id` and `pastoral_processed_at` in the same transaction.

- [ ] **Step 6: Process upward transitions using existing recovery semantics**

Recover only open decline events whose `to_tier` is below the newly established tier; resolve/cancel their existing pastoral/delivery state through the current mechanisms; then mark the upward transition processed.

- [ ] **Step 7: Retire legacy raw-crossing decisions**

Remove `comparison`, `current_tier`, `active_lowest_decline_tier`, and `baseline_suppressed` from decision logic while leaving the old table/schema untouched. Make `evaluateEngagementDeclines` call confirmation evaluation followed by durable transition processing so any remaining internal caller remains safe.

- [ ] **Step 8: Run pastoral regression tests**

```bash
cd server && node --test services/engagement/declines.dbintegration.test.js services/engagement/pastoral.dbintegration.test.js services/weeklyCaregiverEmail.dbintegration.test.js
```

Expected: PASS with no event from pending candidates and unchanged delivery/workflow behavior after confirmation.

- [ ] **Step 9: Commit the pastoral integration**

```bash
git add server/services/engagement/declines.js server/services/engagement/declines.dbintegration.test.js
git commit -m "feat(pastoral): process confirmed primary tier changes"
```

---

### Task 6: Integrate weekly evaluation and immediate settings baselines

**Files:**
- Modify: `server/services/weeklyReviewScheduler.js`
- Modify: `server/services/weeklyReviewScheduler.test.js`
- Modify: `server/services/engagement/settings.js`
- Modify: `server/routes/settings.js`
- Modify: `server/routes/settings.engagement.test.js`

**Interfaces:**

- `updateEngagementSettings` returns `{ settings, rulesChanged }` to its route.
- `PUT /api/settings/engagement` keeps `{ settings }` and adds `baselinePending: boolean`.
- Weekly Primary-day processing calls confirmation evaluation before pastoral transition processing, even when weekly review email is disabled.

- [ ] **Step 1: Write failing scheduler-order tests**

Inject `evaluateEngagementTierConfirmations` and `processConfirmedPrimaryTransitions`; assert `['confirm', 'pastoral']` order on the configured primary day, no duplicate evaluation on retry day, continued evaluation with email disabled, pastoral backlog processing even when confirmation evaluation fails, church-level error containment, and ordinary weekly email behavior after either failure.

- [ ] **Step 2: Write failing settings-baseline route tests**

Assert label/colour-only changes do not evaluate, threshold/role changes request `baselineOnly: true`, successful evaluation returns `baselinePending: false`, and an evaluation failure still saves settings and returns `baselinePending: true` rather than a misleading failed save.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd server && node --test services/weeklyReviewScheduler.test.js routes/settings.engagement.test.js
```

- [ ] **Step 4: Return the rules-change signal from the settings service**

Keep the settings transaction atomic and return the already-computed `rulesChanged` alongside the reloaded settings.

```js
return {
  settings: await getEngagementSettings(churchId),
  rulesChanged,
};
```

- [ ] **Step 5: Request the immediate baseline after the settings transaction**

Call `evaluateEngagementTierConfirmations(churchId, { asOf: new Date(), baselineOnly: true })` only after a successful rules-changing save. Catch/log evaluator failure separately and respond with `baselinePending: true`; do not roll back or repeat the settings mutation.

- [ ] **Step 6: Wire the weekly scheduler to the two durable stages**

At the existing Primary-day evaluation point, call the evaluator and then the transition processor. Give each stage its own error boundary so durable unprocessed transitions are still retried when the current confirmation evaluation fails. Keep the current local-time/send-day gates and per-church failure boundary.

- [ ] **Step 7: Run scheduler/settings tests and verify GREEN**

```bash
cd server && node --test services/weeklyReviewScheduler.test.js routes/settings.engagement.test.js services/engagement/settings.dbintegration.test.js
```

- [ ] **Step 8: Commit scheduler and settings integration**

```bash
git add server/services/weeklyReviewScheduler.js server/services/weeklyReviewScheduler.test.js server/services/engagement/settings.js server/routes/settings.js server/routes/settings.engagement.test.js
git commit -m "feat(engagement): schedule confirmation and baseline rules"
```

---

### Task 7: Serve established tiers and confirmation drilldowns in overview schema v2

**Files:**
- Modify: `server/services/engagement/overview.js`
- Modify: `server/services/engagement/overview.dbintegration.test.js`
- Modify: `server/routes/reports/engagement.js`
- Modify: `server/routes/reports.engagement.test.js`
- Modify: `client/src/services/api.ts`
- Modify: `client/src/services/engagementReportCache.ts`
- Modify: `client/src/services/engagementReportCache.test.ts`

**Interfaces:**

```ts
interface EngagementMovementAxisDto {
  confirmingHigher: EngagementCountDrilldown;
  confirmingLower: EngagementCountDrilldown;
  confirmedRecently: EngagementCountDrilldown;
}

interface EngagementOverviewDto {
  schemaVersion: 2;
  baseline: { pending: boolean; pendingAxes: number };
  tierMovement: {
    recentWindowWeeks: 13;
    axes: Record<'primary' | 'community', EngagementMovementAxisDto>;
  };
  // existing distribution/matrix/trend/visitor/coverage fields remain
}
```

New people rows are `engagement_confirmation` and `engagement_transition`; old `movement` selectors are invalid.

- [ ] **Step 1: Write failing overview contract tests**

Seed calculated profiles, matching/mismatching state versions, active candidates, and recent/old transitions. Assert distributions and matrix use established tiers, baseline-pending axes use calculated fallback with an explicit flag, counts are per axis, and “recent” means the latest 13 completed weeks.

- [ ] **Step 2: Write failing drilldown and isolation tests**

Verify selectors:

```js
{ type: 'confirmation', axis: 'primary', direction: 'higher' }
{ type: 'transition', axis: 'community', recentWeeks: 13 }
```

Assert confirmation rows contain established/candidate tiers, observed opportunities, attended, rate, start/final/current week; transition rows contain from/to tiers, axis, confirmation week, and both evidence blocks. Reject old `movement` tokens and cross-church tokens.

- [ ] **Step 3: Run server overview tests and verify RED**

```bash
cd server && node --test services/engagement/overview.dbintegration.test.js routes/reports.engagement.test.js
```

- [ ] **Step 4: Bulk-load state/history in `buildState`**

Load current rules-version state and transitions confirmed on or after `completedWeekEnd - 84 days` in bounded church-scoped queries; that inclusive range contains the latest 13 completed week endings. Build established axis results by combining persisted tier with current rolling attended/opportunity/rate facts. If state is missing or version-mismatched, use the calculated status only as `statusSource: 'calculated_fallback'` and set `baseline.pending`.

- [ ] **Step 5: Replace old movement aggregation**

Remove `higher`, `same`, `lower`, and `nonComparable`. Issue tokens only for active confirmation directions and recent transitions on each axis. Stable people receive no movement token or row.

- [ ] **Step 6: Add the new drilldown row builders**

Derive confirmation progress from dated facts after the candidate start, not stored counters. Compute `currentWeek` as the number of completed evidence weeks since the candidate boundary and clamp it to `0..13`; the client renders zero as “awaiting the first confirmation week” rather than implying the crossing week counted. Preserve cursor pagination and surname ordering.

- [ ] **Step 7: Bump and validate the client contract**

Change `schemaVersion` to `2`, replace the `movement` type with `tierMovement`, add discriminated row types, and update cache validation. Prefix new cache keys with `v2`; schema-v1 values must be ignored without migration.

- [ ] **Step 8: Run server and cache tests**

```bash
cd server && node --test services/engagement/overview.dbintegration.test.js routes/reports.engagement.test.js
cd client && npm test -- --run src/services/engagementReportCache.test.ts
```

- [ ] **Step 9: Commit the API/cache slice**

```bash
git add server/services/engagement/overview.js server/services/engagement/overview.dbintegration.test.js server/routes/reports/engagement.js server/routes/reports.engagement.test.js client/src/services/api.ts client/src/services/engagementReportCache.ts client/src/services/engagementReportCache.test.ts
git commit -m "feat(reports): expose established engagement tiers"
```

---

### Task 8: Replace threshold movement UI and finish user-facing terminology

**Files:**
- Create: `client/src/components/reports/EngagementMovementPanel.tsx`
- Create: `client/src/components/reports/EngagementMovementPanel.test.tsx`
- Modify: `client/src/components/reports/LongTermHealthReport.tsx`
- Modify: `client/src/components/reports/LongTermHealthReport.test.tsx`
- Modify: `client/src/components/reports/EngagementPeoplePanel.tsx`
- Modify: `client/src/components/reports/EngagementMatrix.tsx`
- Modify: `client/src/components/reports/EngagementSettings.tsx`
- Modify: `client/src/components/reports/EngagementSettings.test.tsx`
- Modify: `client/src/components/reports/PastoralCareReport.tsx`
- Modify: `client/src/components/reports/PastoralCareReport.test.tsx`
- Modify: `client/src/components/reports/ReportsPage.test.tsx`

**Interfaces:**

- The movement panel receives `overview.tierMovement`, tier settings, and a token loader.
- Axis switch labels are `Primary` and `Other participation`.
- Card labels are `Confirming higher`, `Confirming lower`, and `Confirmed recently`.
- Clicking a card expands a compact table below the cards; no modal is used.

- [ ] **Step 1: Write failing movement-panel tests**

Cover Primary/Other participation switching, selected state, three counts, token loading, close/reselection, pending progress copy, confirmed evidence, empty states, sortable surname and percentage columns, keyboard operation, and colour-independent accessible labels.

```tsx
expect(screen.getByText('6/8 opportunities observed')).toBeInTheDocument();
expect(screen.getByText('4 attended (67%)')).toBeInTheDocument();
expect(screen.getByText('week 7 of 13')).toBeInTheDocument();
```

- [ ] **Step 2: Run component tests and verify RED**

```bash
cd client && npm test -- --run src/components/reports/EngagementMovementPanel.test.tsx src/components/reports/LongTermHealthReport.test.tsx
```

- [ ] **Step 3: Implement the compact movement panel**

Use the existing inline bordered-panel/table styling and dark-mode tokens. Pending rows show `Established → Candidate`, observed count, attended/rate, and week; a zero-week candidate says “awaiting the first confirmation week.” Confirmed rows show from/to, confirmation week, 52-week evidence, and confirmation evidence. Do not list stable people.

- [ ] **Step 4: Integrate it into Long-term health**

Replace the old “Recent Primary movement” four-card section and its shifted-window copy. Keep distribution and matrix drilldowns inline. Add a baseline-pending callout that says calculated tiers are shown temporarily and makes no movement claim.

- [ ] **Step 5: Simplify the general people panel**

Remove `movementWindow` and `previousPrimary`. Keep surname/attendance sorting for established distribution and matrix rows, and continue hiding the second axis when it is unassigned.

- [ ] **Step 6: Apply terminology consistently**

Change visible copy as follows without renaming API keys:

```ts
const ROLE_LABELS = {
  primary: 'Primary',
  community: 'Other participation',
  other: 'Excluded',
  unclassified: 'Unclassified',
};
```

Update matrix headings/captions/ARIA labels, settings definitions/options/assignment counts, drilldown headings, pastoral evidence text, trend series labels, and empty states.

- [ ] **Step 7: Add a terminology regression assertion**

Render the affected report/settings surfaces and assert no user-facing standalone `Community` label or excluded role labelled merely `Other` remains. Internal keys and pastoral insight type names may remain unchanged.

- [ ] **Step 8: Run report UI tests and build**

```bash
cd client && npm test -- --run src/components/reports/EngagementMovementPanel.test.tsx src/components/reports/LongTermHealthReport.test.tsx src/components/reports/EngagementSettings.test.tsx src/components/reports/PastoralCareReport.test.tsx src/components/reports/ReportsPage.test.tsx
cd client && npm run build
```

Expected: PASS in light/dark class assertions and production TypeScript build. Do not commit generated service-worker timestamp churn unless the repository's normal build contract requires it.

- [ ] **Step 9: Commit the UI slice**

```bash
git add client/src/components/reports/EngagementMovementPanel.tsx client/src/components/reports/EngagementMovementPanel.test.tsx client/src/components/reports/LongTermHealthReport.tsx client/src/components/reports/LongTermHealthReport.test.tsx client/src/components/reports/EngagementPeoplePanel.tsx client/src/components/reports/EngagementMatrix.tsx client/src/components/reports/EngagementSettings.tsx client/src/components/reports/EngagementSettings.test.tsx client/src/components/reports/PastoralCareReport.tsx client/src/components/reports/PastoralCareReport.test.tsx client/src/components/reports/ReportsPage.test.tsx
git commit -m "feat(reports): show confirmed engagement movement"
```

---

### Task 9: Preserve lifecycle integrity and complete regression/performance verification

**Files:**
- Modify: `server/routes/individuals.js`
- Modify: `server/routes/families.dbintegration.test.js`
- Modify: `server/routes/onboarding.js`
- Modify: `server/routes/onboarding.timezone.dbintegration.test.js`
- Modify: `server/scripts/wipeChurchPeopleAndFamilies.js`
- Modify: `server/scripts/seed-demo.js`
- Modify only if a verified finding requires it: engagement/pastoral/client files from Tasks 1–8

**Interfaces:**

- Person merge preserves factual transition history under the surviving individual without violating the transition uniqueness key.
- Person deletion/reset clears dependent state in foreign-key-safe order.
- Archive/inactive evaluation cancels candidates without deleting history.

- [ ] **Step 1: Write failing merge/reset integrity tests**

Seed source and survivor tier-state rows, duplicate/non-duplicate transition history, decline links, and pastoral state. Assert merge chooses the survivor's current rules-version state, moves unique history, deduplicates exact transitions, preserves decline linkage, and remains church-scoped. Assert onboarding reset removes both new tables before individuals.

- [ ] **Step 2: Run lifecycle tests and verify RED**

```bash
cd server && node --test routes/families.dbintegration.test.js routes/onboarding.timezone.dbintegration.test.js
```

- [ ] **Step 3: Extend individual merge/delete handling**

Before deleting a merged source person, delete its replaceable `engagement_tier_state`, update transition rows to the survivor where uniqueness permits, and delete only exact duplicate transition rows after preserving any decline linkage. Keep every statement constrained by `church_id`.

- [ ] **Step 4: Extend reset and seed deletion order**

Delete `engagement_tier_transitions` before `engagement_decline_events` and `engagement_tier_state` before `individuals` in onboarding reset, wipe script, and demo reseed flows.

- [ ] **Step 5: Run lifecycle tests and verify GREEN**

```bash
cd server && node --test routes/families.dbintegration.test.js routes/onboarding.timezone.dbintegration.test.js
```

- [ ] **Step 6: Run the focused server regression matrix**

Use the repository's compatible server dependencies if the default tree still lacks `tz-lookup`:

```bash
cd server && NODE_PATH='/Users/isaaclee/Projects/Let My People Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules' node --test \
  config/engagementSchema.dbintegration.test.js \
  services/engagement/tiers.test.js \
  services/engagement/opportunities.dbintegration.test.js \
  services/engagement/tierConfirmation.test.js \
  services/engagement/tierConfirmationEvaluator.dbintegration.test.js \
  services/engagement/declines.dbintegration.test.js \
  services/engagement/overview.dbintegration.test.js \
  services/engagement/pastoral.dbintegration.test.js \
  services/weeklyCaregiverEmail.dbintegration.test.js \
  services/weeklyReviewScheduler.test.js \
  routes/reports.engagement.test.js \
  routes/reports.pastoral.test.js \
  routes/families.dbintegration.test.js \
  routes/onboarding.timezone.dbintegration.test.js
```

- [ ] **Step 7: Run the focused client regression matrix and production build**

```bash
cd client && npm test -- --run \
  src/services/engagementReportCache.test.ts \
  src/components/reports/EngagementMovementPanel.test.tsx \
  src/components/reports/LongTermHealthReport.test.tsx \
  src/components/reports/EngagementSettings.test.tsx \
  src/components/reports/PastoralCareReport.test.tsx \
  src/components/reports/ReportsPage.test.tsx
cd client && npm run build
```

- [ ] **Step 8: Verify performance, isolation, and repository hygiene**

Confirm the bounded-query test passes for a representative large roster; inspect query plans for the state/history lookups; rerun same-week and concurrent evaluator tests; verify a second church cannot use the first church's drilldown token; and check that package/lock files and unrelated worktree changes were not modified.

```bash
git status --short
git diff --check
git diff -- package.json package-lock.json client/package.json client/package-lock.json server/package.json server/package-lock.json
```

- [ ] **Step 9: Commit lifecycle changes and any verified fixes**

```bash
git add server/routes/individuals.js server/routes/families.dbintegration.test.js server/routes/onboarding.js server/routes/onboarding.timezone.dbintegration.test.js server/scripts/wipeChurchPeopleAndFamilies.js server/scripts/seed-demo.js
git commit -m "fix(engagement): preserve tier history through lifecycle changes"
```

- [ ] **Step 10: Conduct final whole-branch review**

Review the complete branch against `docs/superpowers/specs/2026-08-28-confirmed-engagement-tier-transitions-design.md`, with particular attention to crossing-week exclusion, exact week arithmetic, rule-version baselines, church isolation, duplicate prevention, recipient freezing, terminology, dark-mode contrast, and cached schema invalidation. Resolve every finding and rerun the narrowest affected verification before integration.
