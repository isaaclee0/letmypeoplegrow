# Batch-Scoped Identity Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each people-sync batch review show and decide only identities in that batch, allow resolved decisions to commit while unresolved identities remain pending, and surface accurate per-batch pending counts for Planning Center and Elvanto.

**Architecture:** Continue acquiring and planning against the complete provider-wide union, but add an explicit signed identity-decision scope derived from the selected batch's effective source. Store source-aware unresolved identity attribution in two provider-neutral projection tables, refresh it only from complete reads, and replace it through the existing church-scoped apply transaction. Keep durable links, holds, and exclusions authoritative; the projection exists only to answer which current batch cards contain unresolved identities.

**Tech Stack:** Node.js 22, Express 5, SQLite/better-sqlite3, `node:test`, React 19, TypeScript 6, React Router 7, Axios, Vitest, Testing Library, Tailwind CSS.

## Global Constraints

- A normal batch review fetches every participating enabled source but signs identity decisions and established-link corrections only for the selected batch's effective active or draft source.
- Authority-switch review remains provider-wide.
- Provider-wide lifecycle, managed-field, family, overlap, and gathering safety calculations remain unchanged.
- An unestablished identity outside the decision scope is not implicitly accepted; suggestion-dependent mutations for that identity are suppressed.
- Omitted signed identity decisions are canonicalized by the server to deferred outcomes.
- Apply remains blocked for collisions, stale or expired tokens, changed source/connection/authority/batch fences, unsigned correction previews, incomplete required archive review, unconfirmed destructive changes, and malformed or cross-church input.
- Holds and exclusions remain authoritative; batch pending rows are a source-aware UI projection only.
- Incomplete or failed provider reads never replace a valid pending projection.
- Preview may refresh observational projection after a complete validated read; user decisions change only during Apply.
- Source promotion, identity mutations, holds/exclusions, projection replacement, gathering changes, and authority activation remain in one guarded church transaction.
- `unresolvedIdentityCount` is `number | null`: `0` means a current source has been observed with no unresolved identities; `null` means the current effective source has not been observed.
- No provider records, names, contacts, or source membership rules are stored in the pending projection.
- All reads and writes include `church_id` and provider even though batch IDs are globally unique.
- No startup migration performs a provider network call.
- No new npm dependencies and no unrelated integration refactor.
- Preserve the existing uncommitted tab-aware identity-search work in `IdentityReviewTable.tsx` and its test while implementing the remaining client tasks.

---

## File structure

**New server unit**

- `server/services/peopleSync/pendingIdentityProjection.js` — validate observation contracts, derive source-aware unresolved rows, replace observations with or without an existing transaction, and read current per-batch counts.
- `server/services/peopleSync/pendingIdentityProjection.dbintegration.test.js` — schema, replacement, overlap, source-staleness, cascade, failure-preservation, and church-isolation coverage.

**Existing server units**

- `server/config/schema.js` and `server/config/peopleSyncSchema.dbintegration.test.js` — additive projection tables, constraints, indexes, and cascade contracts.
- `server/services/peopleSync/reviewContext.js` — build only the explicitly scoped identity directory and sign out-of-scope suggestion suppression metadata.
- `server/services/peopleSync/orchestrator.js` — derive batch/authority/unattended decision scopes, refresh preview observations, and pass fresh projection observations into reviewed and unattended apply.
- `server/services/peopleSync/identityDecisions.js` — canonicalize omitted signed decisions to `defer` while retaining strict validation of submitted keys and fields.
- `server/services/peopleSync/apply.js` — suppress unaccepted suggestions and replace the fresh projection inside the critical transaction.
- `server/services/peopleSync/batchRepository.js` — decorate batch DTOs with source-matching unresolved counts.
- `server/services/planningCenterSync.js` and `server/routes/integrations/sourceBuilder.js` — preserve the count through Planning Center compatibility and safe source-draft DTOs.

**Client units**

- `client/src/components/peopleSync/types.ts` — add the nullable count and provider-specific review-table contract.
- `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx` and `ElvantoIntegrationPanel.tsx` — render batch warnings and open positive-count reviews in Needs attention.
- `client/src/pages/PeopleSyncBatchReviewPage.tsx` — pass the batch-derived initial filter into the review workspace.
- `client/src/components/peopleSync/SyncReview.tsx`, `syncSelections.ts`, and `IdentityReviewTable.tsx` — allow partial identity apply, disclose pending identities separately, select the initial filter, and render provider terminology.

---

### Task 1: Add the source-aware pending projection schema and repository

**Files:**
- Modify: `server/config/schema.js` inside `PROVIDER_NEUTRAL_SYNC_SCHEMA`
- Modify: `server/config/peopleSyncSchema.dbintegration.test.js`
- Create: `server/services/peopleSync/pendingIdentityProjection.js`
- Create: `server/services/peopleSync/pendingIdentityProjection.dbintegration.test.js`

**Interfaces:**
- Produces: `buildPendingIdentityObservations({ batches, eligibleByBatch, personLinks, holds, resolvedExternalPersonIds? }) -> BatchIdentityObservation[]`.
- Produces: `replacePendingIdentityObservations(churchId, provider, observations) -> Promise<void>`.
- Produces: `replacePendingIdentityObservationsWithConnection(conn, { churchId, provider, observations }) -> Promise<void>`.
- Produces: `listCurrentUnresolvedIdentityCounts(churchId, provider, batches) -> Promise<Map<number, number | null>>`.
- `BatchIdentityObservation` is `{ batchId, sourceRole, sourceIdentityDigest, sourceRevision, sourceBaseRevision, observedAt, items: Array<{ externalPersonId, reason }> }`.
- Allowed reasons are `identity_decision_required`, `deferred`, and `pair_rejected`.

- [ ] **Step 1: Write failing schema and repository tests**

Add schema assertions for both tables, both cascades, provider checks, and the unique item key. Add repository tests with two overlapping batches:

```js
const observations = buildPendingIdentityObservations({
  batches: [batch(11, 'list-a'), batch(12, 'list-b')],
  eligibleByBatch: new Map([[11, new Set(['shared', 'a-only'])], [12, new Set(['shared'])]]),
  personLinks: [{ externalPersonId: 'a-only', individualId: 41 }],
  holds: [{ externalPersonId: 'shared', reason: 'deferred' }],
});
assert.deepEqual(observations.map(({ batchId, items }) => [batchId, items]), [
  [11, [{ externalPersonId: 'shared', reason: 'deferred' }]],
  [12, [{ externalPersonId: 'shared', reason: 'deferred' }]],
]);
```

Persist those observations, assert counts `11 -> 1` and `12 -> 1`, replace with `resolvedExternalPersonIds: new Set(['shared'])`, and assert both become `0`. Also assert:

- replacing only batch 11 leaves batch 12 unchanged;
- a thrown transaction preserves the prior rows;
- a changed draft digest/revision returns `null` rather than a stale count;
- deleting projection state deletes its items;
- deleting a batch deletes only that batch's state/items and retains `people_sync_match_holds`;
- a second church using the same external ID cannot affect the first church's count.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test config/peopleSyncSchema.dbintegration.test.js services/peopleSync/pendingIdentityProjection.dbintegration.test.js
```

Expected: FAIL because the tables and repository do not exist.

- [ ] **Step 3: Add the two additive tables**

Add this shape to `PROVIDER_NEUTRAL_SYNC_SCHEMA` so `ensureProviderNeutralSyncSchema()` creates it for both new and existing church databases:

```sql
CREATE TABLE IF NOT EXISTS people_sync_batch_identity_projection_states (
  batch_id INTEGER PRIMARY KEY,
  church_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('planning_center', 'elvanto')),
  source_role TEXT NOT NULL CHECK(source_role IN ('active', 'draft')),
  source_identity_digest TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
  source_base_revision INTEGER,
  observed_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (batch_id) REFERENCES people_sync_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS people_sync_batch_identity_projection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('planning_center', 'elvanto')),
  batch_id INTEGER NOT NULL,
  external_person_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('identity_decision_required', 'deferred', 'pair_rejected')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, provider, batch_id, external_person_id),
  FOREIGN KEY (batch_id) REFERENCES people_sync_batch_identity_projection_states(batch_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_people_sync_batch_identity_projection_state_lookup
  ON people_sync_batch_identity_projection_states(church_id, provider, batch_id);
CREATE INDEX IF NOT EXISTS idx_people_sync_batch_identity_projection_item_lookup
  ON people_sync_batch_identity_projection_items(church_id, provider, batch_id);
```

- [ ] **Step 4: Implement observation derivation and replacement**

Use `digestSourceIdentity()` from `sourceModel.js`. Select `draftSource` when present, otherwise `source`; bind draft observations to `draftSourceBaseRevision` and active observations to `sourceRevision` with a null base revision. Exclude IDs found in durable `personLinks` or `resolvedExternalPersonIds`. Prefer an existing hold reason, otherwise use `identity_decision_required`.

Replacement must validate every batch ID, source digest, revision, timestamp, item ID, and reason before the first query. For each represented batch, delete its state row and insert one state plus sorted item rows. The public wrapper opens `Database.transactionForChurch`; the connection form performs no nested transaction.

`listCurrentUnresolvedIdentityCounts()` must initialize every supplied batch to `null`, load state/items with `church_id` and provider predicates, and return a numeric count only when the stored role/digest/revision/base revision equals the batch's currently visible draft-or-active source.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/config/schema.js server/config/peopleSyncSchema.dbintegration.test.js server/services/peopleSync/pendingIdentityProjection.js server/services/peopleSync/pendingIdentityProjection.dbintegration.test.js
git commit -m "feat(sync): store pending identities by batch"
```

---

### Task 2: Add unresolved counts to every batch DTO path

**Files:**
- Modify: `server/services/peopleSync/batchRepository.js`
- Modify: `server/services/peopleSync/batchRepository.dbintegration.test.js`
- Modify: `server/services/planningCenterSync.js`
- Modify: `server/services/planningCenterSync.test.js`
- Modify: `server/routes/integrations/sourceBuilder.js`
- Modify: `server/routes/integrations/sourceBuilder.test.js`
- Modify: `server/routes/integrations/elvanto.test.js`

**Interfaces:**
- Consumes: `listCurrentUnresolvedIdentityCounts(churchId, provider, batches)` from Task 1.
- Produces: every public `PeopleSyncBatch` DTO contains `unresolvedIdentityCount: number | null`.
- `listBatches()` and `getBatch()` return source-matching counts; newly created/updated/source-draft DTOs return `null` until observed unless their current source still matches an existing projection.

- [ ] **Step 1: Write failing DTO tests**

Seed a valid active projection with two items and assert generic and Planning Center compatibility list responses contain:

```js
assert.equal(batch.unresolvedIdentityCount, 2);
```

Change the source revision/digest and assert:

```js
assert.equal(batch.unresolvedIdentityCount, null);
```

Assert Elvanto GET, Planning Center compatibility listing, source-draft save, and draft discard all preserve the nullable property. A discarded/replaced draft must never expose the old draft count.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/batchRepository.dbintegration.test.js services/planningCenterSync.test.js routes/integrations/sourceBuilder.test.js routes/integrations/elvanto.test.js
```

Expected: FAIL because batch DTOs omit `unresolvedIdentityCount`.

- [ ] **Step 3: Decorate repository reads**

Keep `toBatch(row)` synchronous. Add:

```js
async function withUnresolvedIdentityCounts(churchId, provider, batches) {
  const counts = await pendingIdentityProjection.listCurrentUnresolvedIdentityCounts(churchId, provider, batches);
  return batches.map((batch) => ({
    ...batch,
    unresolvedIdentityCount: counts.get(Number(batch.id)) ?? null,
  }));
}
```

Use it in `listBatches()` and `getBatch()`. After create/update/source-draft mutations, re-read through `getBatch()` instead of fabricating a DTO without a count. Retain all existing church/provider predicates.

- [ ] **Step 4: Preserve the field at compatibility and safe-response boundaries**

Add this exact field to `toLegacyPcoBatchDto()` and `safeBatch()`:

```js
unresolvedIdentityCount: Number.isSafeInteger(batch.unresolvedIdentityCount)
  ? batch.unresolvedIdentityCount
  : null,
```

Do not turn `null` into `0`.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/batchRepository.js server/services/peopleSync/batchRepository.dbintegration.test.js server/services/planningCenterSync.js server/services/planningCenterSync.test.js server/routes/integrations/sourceBuilder.js server/routes/integrations/sourceBuilder.test.js server/routes/integrations/elvanto.test.js
git commit -m "feat(sync): return pending identity counts"
```

---

### Task 3: Sign only the selected batch's identity decisions

**Files:**
- Modify: `server/services/peopleSync/reviewContext.js`
- Modify: `server/services/peopleSync/reviewContext.test.js`
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`

**Interfaces:**
- Produces: `decisionScopeExternalIds(eligibleByBatch, { batchId, authoritySwitch, unattended }) -> Set<string>` in `orchestrator.js`.
- `buildReviewContext(input)` consumes `decisionScopeExternalIds` and emits identities only for that set.
- `PeopleSyncReviewContext` gains signed `unreviewedSuggestedLinks: Array<{ externalPersonId: string, individualId: number }>`.
- Established links and correction validation use the identical decision scope.

- [ ] **Step 1: Write failing review-context tests**

Build a plan containing target `clancy`, other-batch `ava`, and established links for both. Assert:

```js
assert.deepEqual(Object.keys(context.identities), ['clancy']);
assert.deepEqual(Object.keys(context.establishedLinks), ['clancy-linked']);
assert.deepEqual(context.unreviewedSuggestedLinks, [
  { externalPersonId: 'ava', individualId: 52 },
]);
```

Add orchestrator tests proving:

- all enabled effective sources are fetched for a target review;
- only target active membership is signed when no draft exists;
- the target draft replaces only that target's active membership for scope;
- other-batch membership still prevents archive and gathering removal;
- authority-switch preview signs the complete participating union;
- unattended planning signs no decisions;
- a correction for an external ID outside target membership is rejected.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/reviewContext.test.js services/peopleSync/orchestrator.test.js
```

Expected: FAIL because `buildReviewContext()` currently includes reviewable actions from the full plan union.

- [ ] **Step 3: Make decision scope explicit**

Replace the batch-null special case with an explicit helper:

```js
function decisionScopeExternalIds(eligibleByBatch, { batchId = null, authoritySwitch = false, unattended = false } = {}) {
  if (unattended) return new Set();
  if (authoritySwitch) return new Set(
    [...eligibleByBatch.values()].flatMap((ids) => [...ids].map(String))
  );
  return correctionScopeExternalIds(eligibleByBatch, batchId);
}
```

Pass this set as both `decisionScopeExternalIds` and `sourceExternalIds` for normal review/correction preview. Pass the full union for authority review/apply and an empty set for unattended runs.

- [ ] **Step 4: Filter identity context and sign suppressed suggestions**

In `buildReviewContext()`, filter `reviewableExternalIds(plan)` through `decisionScopeExternalIds`. Build `unreviewedSuggestedLinks` from deterministic `plan.linkPeople` proposals outside the scope, sorted by external ID then individual ID. Do not include established durable links in that list.

Keep `localIdentityDigest` provider-wide so a stale local link/hold/exclusion still invalidates Apply.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/reviewContext.js server/services/peopleSync/reviewContext.test.js server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js
git commit -m "feat(sync): scope identity review to batch"
```

---

### Task 4: Refresh observational pending projection after complete reads

**Files:**
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/orchestrator.dbintegration.test.js`

**Interfaces:**
- Consumes: `buildPendingIdentityObservations()` and `replacePendingIdentityObservations()` from Task 1.
- Produces: `pendingIdentityObservations` on acquired pipeline state after a complete validated source union and local-link read.
- Preview writes observations before returning the signed review; unattended and reviewed apply pass the same fresh observation set to the transaction instead of writing it early.

- [ ] **Step 1: Write failing orchestration tests**

Inject spies for `replacePendingIdentityObservations` and `applyPeopleSyncPlan`. Assert:

```js
assert.equal(fetchCalls.length, 2);
assert.equal(replaceCalls.length, 1);
assert.deepEqual(replaceCalls[0].observations.map((entry) => entry.batchId), [11, 12]);
```

Cover these cases:

- backing out after `buildReview()` still leaves fresh unresolved counts;
- an overlapping unresolved ID is attributed to both batches;
- a complete read after removal from one source retains only the other attribution;
- provider error, pagination/completeness failure, connection-generation failure, or source-identity mismatch makes zero projection writes;
- failed draft reads do not replace active-source projection or health;
- unattended runs pass observations into apply only after the complete read;
- no migration/startup path calls a provider solely to populate projection.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js
```

Expected: FAIL because orchestration does not derive or persist pending observations.

- [ ] **Step 3: Derive observations only after complete acquisition**

After `loadLocalProjectionState()` succeeds in `acquirePipelineState()`, call:

```js
const pendingIdentityObservations = deps.buildPendingIdentityObservations({
  batches: input.batches,
  eligibleByBatch: providerState.eligibleByBatch,
  personLinks,
  holds: matchReviewState.holds,
});
```

Return the observations on acquired state. This position guarantees a complete provider union and the current durable link/hold state.

- [ ] **Step 4: Write preview observations and forward apply observations**

In `buildReview()` and successful correction preview, call the public replacement function only after plan computation and source-context construction succeed. In `applyReviewed()` and `runUnattended()`, pass:

```js
pendingIdentityObservations: body.pendingIdentityObservations,
```

to `applyPeopleSyncPlan()`. Do not catch and continue on a projection write failure before Apply; return a failed review/run without changing user decisions.

Update the `buildReview()` comment: it performs no people/link/hold decisions, but it may refresh observational pending projection after a complete read.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/orchestrator.dbintegration.test.js
git commit -m "feat(sync): refresh batch identity projection"
```

---

### Task 5: Canonicalize omitted decisions and suppress unaccepted identities

**Files:**
- Modify: `server/services/peopleSync/identityDecisions.js`
- Modify: `server/services/peopleSync/identityDecisions.test.js`
- Modify: `server/services/peopleSync/apply.js`
- Modify: `server/services/peopleSync/apply.test.js`

**Interfaces:**
- `validateIdentityDecisions(plan, selections)` returns the existing accepted structure, but every omitted signed identity appears in `deferredReasons` with `deferred`.
- `accepted.suppressedSuggestedPairs` contains both explicitly non-accepted in-scope suggestions and signed `reviewContext.unreviewedSuggestedLinks`.
- Unrecognized submitted external IDs, invalid outcomes/fields, collisions, and exclusion misuse still throw.

- [ ] **Step 1: Write failing canonicalization tests**

Given identities `resolved` and `omitted`, submit only:

```js
const accepted = validateIdentityDecisions(plan, {
  decisionContractVersion: 2,
  identityDecisions: { resolved: { outcome: 'accept' } },
});
assert.deepEqual([...accepted.deferredReasons], [['omitted', 'deferred']]);
assert.deepEqual(accepted.linkActions, [
  { externalPersonId: 'resolved', individualId: 41, linkSource: 'matched' },
]);
```

Add tests that an omitted create action is skipped, an omitted suggestion suppresses its dependent managed/gathering actions, a signed out-of-scope suggestion is suppressed, and a claimed-local-person collision still fails.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/identityDecisions.test.js services/peopleSync/apply.test.js
```

Expected: FAIL because omitted identities are currently rejected as missing.

- [ ] **Step 3: Canonicalize omissions before validation**

Keep rejection of submitted keys outside `context.identities`. Replace the required-key loop with:

```js
const canonicalDecisions = Object.fromEntries(contextExternalIds.map((externalPersonId) => [
  externalPersonId,
  Object.hasOwn(decisions, externalPersonId)
    ? decisions[externalPersonId]
    : { outcome: 'defer' },
]));
```

Run all existing outcome, signed-create, candidate, exclusion, and collision validation against `canonicalDecisions`.

- [ ] **Step 4: Merge signed out-of-scope suppression**

Validate every `reviewContext.unreviewedSuggestedLinks` entry as a non-empty external ID and positive local ID. Seed `suppressedSuggestedPairs` with those entries, then add the existing rejected in-scope suggestion pairs. Deduplicate by `externalPersonId + individualId` and sort deterministically.

`planWithSuppressedSuggestions()` must continue filtering only `SUGGESTION_DEPENDENT_BUCKETS`; it must not suppress provider-wide actions for already durably linked people.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/identityDecisions.js server/services/peopleSync/identityDecisions.test.js server/services/peopleSync/apply.js server/services/peopleSync/apply.test.js
git commit -m "feat(sync): defer omitted identity decisions"
```

---

### Task 6: Replace pending projection inside partial Apply and prove persistence

**Files:**
- Modify: `server/services/peopleSync/apply.js`
- Modify: `server/services/peopleSync/apply.dbintegration.test.js`
- Modify: `server/services/peopleSync/orchestrator.dbintegration.test.js`

**Interfaces:**
- Consumes: `pendingIdentityObservations` from Task 4.
- Consumes: `replacePendingIdentityObservationsWithConnection()` from Task 1.
- `applyPeopleSyncPlan()` accepts optional `pendingIdentityObservations = null`.
- Accepted link/create external IDs are removed from every represented batch observation; deferred IDs remain.

- [ ] **Step 1: Write failing transaction and regression tests**

Create a reviewed two-identity plan where `resolved` is accepted and `pending` is omitted. Assert after Apply:

```js
assert.deepEqual(await durableLinks(), ['resolved']);
assert.deepEqual(await holds(), [{ external_person_id: 'pending', reason: 'deferred' }]);
assert.deepEqual(await projectedIds(), ['pending']);
```

Add rollback tests that force failure during source promotion and projection replacement; links, created people, holds, exclusions, source promotion, and prior projection must all remain unchanged.

Add persistence/regression cases:

- restart/re-open the test church DB and confirm deferred/rejected decisions reappear;
- a resolved match is established and absent from the next complete review;
- a `legacy_backfill` Planning Center link plus matching `individuals.planning_center_id` remains established after Planning Center authority activation and never resurfaces in `identities`;
- resolving one overlapping identity removes it from both fresh batch observations;
- batch deletion cascades projection rows but retains the provider hold;
- a cross-church batch/external ID cannot be mutated by another church's reviewed token.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/apply.dbintegration.test.js services/peopleSync/orchestrator.dbintegration.test.js
```

Expected: FAIL because projection replacement is not part of Apply and omissions do not yet persist.

- [ ] **Step 3: Replace observations after identity state is finalized**

Inside `Database.transactionForChurch()`, after link/create mutations and hold/exclusion updates but before source promotion/authority activation, derive:

```js
const resolvedExternalPersonIds = new Set([
  ...accepted.linkActions.map((action) => action.externalPersonId),
  ...newIndividualIdByExternal.keys(),
]);
```

Filter those IDs from every supplied observation and call `replacePendingIdentityObservationsWithConnection(conn, ...)`. Do not perform projection writes when `pendingIdentityObservations === null`; this preserves one-time import and older direct apply callers.

- [ ] **Step 4: Make unattended application explicitly version 2**

In `runUnattended()`, pass:

```js
selections: { decisionContractVersion: 2, identityDecisions: {} },
```

This makes all unestablished unattended identities remain pending while allowing safe actions for already durable links. Keep `reviewRequiredWhenHeld: true` and the existing notification path.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/apply.js server/services/peopleSync/apply.dbintegration.test.js server/services/peopleSync/orchestrator.dbintegration.test.js server/services/peopleSync/orchestrator.js
git commit -m "feat(sync): apply resolved identities partially"
```

---

### Task 7: Show pending notes on Planning Center and Elvanto batch cards

**Files:**
- Modify: `client/src/components/peopleSync/types.ts`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.test.tsx`
- Modify: `client/src/pages/PeopleSyncBatchReviewPage.tsx`
- Modify: `client/src/pages/PeopleSyncBatchReviewPage.test.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.tsx`
- Modify: `client/src/components/peopleSync/IdentityReviewTable.tsx`

**Interfaces:**
- `PeopleSyncBatch.unresolvedIdentityCount: number | null` is required.
- `SyncReview` accepts `initialIdentityFilter?: 'all' | 'needs_attention'`.
- `IdentityReviewTable` accepts the same prop and initializes its Decisions filter once per loaded review token.

- [ ] **Step 1: Write failing batch-card and navigation tests**

For both provider panels, test `1`, `3`, `0`, and `null`. The positive cases must render exactly:

```text
1 identity decision still needs review.
3 identity decisions still need review.
```

Zero and null render no warning. Clicking Review on a positive batch must load `PeopleSyncBatchReviewPage` with Needs attention pressed; zero/null initialize All. Add a rerender/navigation test proving a newly loaded review token resets the initial filter without preventing later manual filter changes.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd client
npm test -- src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/pages/PeopleSyncBatchReviewPage.test.tsx src/components/peopleSync/IdentityReviewTable.test.tsx
```

Expected: FAIL because the count and initial filter are absent.

- [ ] **Step 3: Add the typed nullable count and card copy**

Add to `PeopleSyncBatch`:

```ts
unresolvedIdentityCount: number | null;
```

Render the note only when `count !== null && count > 0`, using `decision` for one and `decisions` otherwise. Keep it directly beneath source/operational notes and use amber status styling without making it an error alert.

- [ ] **Step 4: Initialize Needs attention from the loaded batch**

Pass from `PeopleSyncBatchReviewPage`:

```tsx
initialIdentityFilter={visibleBatch.unresolvedIdentityCount !== null
  && visibleBatch.unresolvedIdentityCount > 0
  ? 'needs_attention'
  : 'all'}
```

Thread the prop through `SyncReview`. In `IdentityReviewTable`, initialize filter from the prop and reset it only when `review.reviewToken` changes. Do not reset it on ordinary decision-state rerenders.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/peopleSync/types.ts client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx client/src/components/integrations/ElvantoIntegrationPanel.tsx client/src/components/integrations/ElvantoIntegrationPanel.test.tsx client/src/pages/PeopleSyncBatchReviewPage.tsx client/src/pages/PeopleSyncBatchReviewPage.test.tsx client/src/components/peopleSync/SyncReview.tsx client/src/components/peopleSync/IdentityReviewTable.tsx
git commit -m "feat(sync): show pending decisions on batches"
```

---

### Task 8: Make unresolved identities non-blocking in the review UI

**Files:**
- Modify: `client/src/components/peopleSync/syncSelections.ts`
- Modify: `client/src/components/peopleSync/syncSelections.test.ts`
- Modify: `client/src/components/peopleSync/SyncReview.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.test.tsx`

**Interfaces:**
- `buildSyncSelections()` continues omitting null decisions; the server from Task 5 canonicalizes them.
- `incompleteIdentityExternalIds()` remains available for pending counts/focus, not Apply blocking.
- Selected-change count excludes pending identities.

- [ ] **Step 1: Write failing partial-apply UI tests**

Create a review with one accepted match and one null decision. Assert:

```ts
expect(screen.getByRole('button', { name: 'Apply 1 selected change' })).toBeEnabled();
expect(screen.getByText('Ava will remain pending after this sync.')).toBeVisible();
```

Click Apply and assert the payload contains only the accepted identity. Add tests proving collisions, unsigned corrections, unaccepted required archives, destructive confirmation, expired/stale errors, and unsafe review context still disable Apply.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd client
npm test -- src/components/peopleSync/syncSelections.test.ts src/components/peopleSync/SyncReview.test.tsx
```

Expected: FAIL because `incompleteExternalIds.length > 0` currently disables Apply and uses blocking copy.

- [ ] **Step 3: Separate pending disclosure from true blockers**

Remove only this term from `applyDisabled`:

```ts
incompleteExternalIds.length > 0
```

Retain collisions and every other existing blocker. Keep `affectedExternalId` and the Needs attention chip for navigation.

Replace the blocking warning with non-blocking text. For one pending identity use its safe display name; for multiple use `N identities will remain pending after this sync.` Include the existing focus shortcut. The Apply selected count must continue using `selectedChangeCount()` and must not add pending rows.

- [ ] **Step 4: Confirm selection serialization**

Keep `sortedRecord(state.identityDecisions)` in `buildSyncSelections()` so null entries are omitted and submitted decisions are deterministic. Add an assertion that no fabricated `{ outcome: 'defer' }` is sent by the client; canonical deferral belongs to the server.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/peopleSync/syncSelections.ts client/src/components/peopleSync/syncSelections.test.ts client/src/components/peopleSync/SyncReview.tsx client/src/components/peopleSync/SyncReview.test.tsx
git commit -m "feat(sync): allow partial identity apply"
```

---

### Task 9: Use provider names in the identity table and preserve cross-tab search

**Files:**
- Modify: `client/src/components/peopleSync/IdentityReviewTable.tsx`
- Modify: `client/src/components/peopleSync/IdentityReviewTable.test.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.tsx`

**Interfaces:**
- Consumes: the existing signed/reviewed provider passed to `SyncReview`.
- `IdentityReviewTable` accepts `provider: 'planning_center' | 'elvanto'`.
- Desktop headings are `${providerLabel} name` and `${providerLabel} family/household`; mobile heading is the provider label.

- [ ] **Step 1: Extend the existing table tests**

Keep the current cross-tab search assertions, including searching an established person such as Clancy while Decisions is active. Add provider matrix assertions:

```ts
expect(pcoTable).toHaveTextContent('Planning Center name');
expect(pcoTable).toHaveTextContent('Planning Center family/household');
expect(elvantoTable).toHaveTextContent('Elvanto name');
expect(elvantoTable).toHaveTextContent('Elvanto family/household');
```

In mobile layout assert `Planning Center` or `Elvanto`. Assert `External source` and `Integration source` are absent.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd client
npm test -- src/components/peopleSync/IdentityReviewTable.test.tsx src/components/peopleSync/SyncReview.test.tsx
```

Expected: provider-heading assertions FAIL; existing tab-aware search tests must remain PASS before the heading edit.

- [ ] **Step 3: Thread and render the safe provider label**

Pass `provider` from `SyncReview` to `IdentityReviewTable` and derive:

```ts
const externalProviderLabel = provider === 'planning_center' ? 'Planning Center' : 'Elvanto';
```

Use it in both desktop headers and the mobile provider label. Leave LMPG headings unchanged. Do not derive the label from source names or URL text.

- [ ] **Step 4: Preserve the current search implementation**

Retain per-tab queries and the effect that switches tabs only when the active tab has no matches and the other tab does. Verify the query remains in the input after the tab switch and that filtering/pagination are calculated against the destination tab.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/peopleSync/IdentityReviewTable.tsx client/src/components/peopleSync/IdentityReviewTable.test.tsx client/src/components/peopleSync/SyncReview.tsx
git commit -m "fix(sync): label review identities by provider"
```

---

### Task 10: Run end-to-end verification and Kingston operational checks

**Files:**
- Modify only if a verification failure exposes a defect in a file already named by Tasks 1-9.

**Interfaces:**
- Consumes: all prior task contracts.
- Produces: one verified batch-scoped, partial-apply workflow for both providers with no regression to authority, lifecycle, source fencing, or legacy links.

- [ ] **Step 1: Run the complete focused server suite**

```bash
cd server
node --test config/peopleSyncSchema.dbintegration.test.js services/peopleSync/pendingIdentityProjection.dbintegration.test.js services/peopleSync/batchRepository.dbintegration.test.js services/peopleSync/reviewContext.test.js services/peopleSync/identityDecisions.test.js services/peopleSync/apply.test.js services/peopleSync/apply.dbintegration.test.js services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/planningCenterSync.test.js routes/integrations/sourceBuilder.test.js routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run the complete focused client suite**

```bash
cd client
npm test -- src/components/peopleSync/syncSelections.test.ts src/components/peopleSync/SyncReview.test.tsx src/components/peopleSync/IdentityReviewTable.test.tsx src/pages/PeopleSyncBatchReviewPage.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx
```

Expected: PASS with zero failed tests.

- [ ] **Step 3: Run static validation**

```bash
cd client
npx tsc --noEmit
npm run build
```

Expected: both commands PASS. If repository-pre-existing TypeScript failures remain, record the exact diagnostics and demonstrate that none point to files changed by this plan; do not claim a clean typecheck.

- [ ] **Step 4: Validate the Kingston CRC workflow against a disposable DB copy**

Start the development services, copy the Kingston church SQLite database to a temporary test location, and exercise Review without mutating the original. Confirm:

1. the Random Helpers review fetches the provider-wide sources but displays only that List's identities;
2. searching `Clancy` switches to Already linked and preserves the query;
3. resolving one identity while leaving another pending commits the link plus hold and returns to batch cards;
4. only batches containing the pending external ID show a warning;
5. a fresh review does not resurface the resolved identity;
6. all unique `individuals.planning_center_id` values still match durable `external_person_links` after authority mode is active; and
7. failed/incomplete source reads leave the previous card counts unchanged.

Do not apply a sync to Kingston's original database during verification.

- [ ] **Step 5: Review the final diff for scope and church isolation**

```bash
git diff --check
git status --short
git diff -- server/config/schema.js server/services/peopleSync client/src/components/peopleSync client/src/components/integrations client/src/pages/PeopleSyncBatchReviewPage.tsx
```

Expected: no whitespace errors; every new SQL read/write visibly carries church and provider scope; unrelated `PeoplePage` changes remain untouched.

- [ ] **Step 6: Commit verification fixes, if any**

If Steps 1-5 required code changes, stage only the affected files already listed in Tasks 1-9 and commit:

```bash
git commit -m "test(sync): verify batch-scoped identity review"
```

If no verification fixes were required, do not create an empty commit.
