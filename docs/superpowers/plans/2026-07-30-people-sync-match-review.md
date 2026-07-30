# People Sync Match Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-neutral, family-aware sync review that lets administrators accept, redirect, create, defer, or permanently reject proposed identity pairings in Planning Center and Elvanto.

**Architecture:** Persist exact pair exclusions and external-identity review holds in church-scoped tables, feed them through the provider-neutral matcher, and attach a signed `reviewContext` to each recomputed plan. A versioned identity-decision contract is validated from that context and applied in the existing database transaction; the shared React review renders comparison cards from a lean family-aware display directory while retaining a strictly separate legacy payload path for stale PWA clients.

**Tech Stack:** Node.js 22-style CommonJS, Express 5, SQLite via `better-sqlite3`, Node's built-in test runner, React 19, TypeScript 6, Tailwind CSS 4, Vitest, and Testing Library.

## Global Constraints

- Every new table, query, unique constraint, and mutation must include `church_id`; provider-specific state must also include `provider`.
- Keep Planning Center and Elvanto behavior provider-neutral except for labels and provider adapters.
- Do not expose contact details, custom fields, notes, credentials, or raw provider attributes in review responses.
- A defer or rejected pairing must prevent unattended link/add behavior until an administrator resolves the external identity.
- An exact exclusion suppresses only `(church_id, provider, external_person_id, individual_id)` and cannot displace a durable link.
- Review tokens must continue rejecting stale plans before any mutation.
- Links, created people, holds, exclusions, source promotion, authority activation, and other accepted plan actions must commit in one church-scoped transaction.
- Existing PWA clients keep the current legacy selection semantics; absence of the new contract version must never imply a new-client accept or defer decision.
- The UI must support light/dark mode, keyboard operation, semantic labels, mobile stacking, and human-readable copy without ordinary raw IDs or internal reason codes.
- Add no npm dependencies.

---

## File Structure

### New server files

- `server/services/peopleSync/matchReviewRepository.js` — church-scoped persistence for exact exclusions and external review holds, including connection-aware transaction helpers.
- `server/services/peopleSync/matchReviewRepository.dbintegration.test.js` — schema, isolation, uniqueness, and transaction-helper coverage.
- `server/services/peopleSync/reviewContext.js` — pure construction/sanitization of signed identity-review metadata and family-aware display directories.
- `server/services/peopleSync/reviewContext.test.js` — directory privacy, family preview, manual-candidate, and deterministic ordering tests.
- `server/services/peopleSync/identityDecisions.js` — pure versioned decision validation and normalization, with the legacy validator remaining separate.
- `server/services/peopleSync/identityDecisions.test.js` — accept/link/create/defer/exclusion/collision validation tests.

### New client files

- `client/src/components/peopleSync/PersonIdentitySummary.tsx` — accessible provider/local name and family context renderer.
- `client/src/components/peopleSync/MatchDecisionCard.tsx` — one identity comparison and its decision/search controls.

### Existing files to modify

- `server/config/schema.js` — additive exclusion and hold tables/indexes.
- `server/services/peopleSync/matcher.js` and `.test.js` — exact-candidate filtering and held-identity review results.
- `server/services/peopleSync/orchestrator.js`, `.test.js`, and `.dbintegration.test.js` — load review state, build signed context, return versioned display data, and pass normalized decisions into apply.
- `server/services/peopleSync/apply.js`, `.test.js`, and `.dbintegration.test.js` — separate legacy/new validation paths and transactional identity outcomes.
- `server/services/peopleSync/reviewNotification.js` and `.dbintegration.test.js` — include held identities in review-required messaging/dedup counts.
- `client/src/components/peopleSync/types.ts` — exact v2 review and decision types.
- `client/src/components/peopleSync/syncSelections.ts` and `.test.ts` — v2 client decision state serialization while preserving destructive selections.
- `client/src/components/peopleSync/SyncReview.tsx` and `.test.tsx` — friendly summaries, sections, comparison cards, validation, alerts, and responsive styling.
- `client/src/components/planningCenter/PlanningCenterSyncReview.tsx` and `.test.tsx` — new shared payload and retry/result behavior.
- `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx` and `.test.tsx` — consistent expanded review container/actions.
- `client/src/components/integrations/ElvantoIntegrationPanel.tsx` and `.test.tsx` — matching shared container/actions.
- `client/src/components/peopleSync/PeopleSourceControl.tsx` and `.test.tsx` — authority-preview compatibility with the v2 review.
- `client/src/components/elvanto/ElvantoOnboarding.tsx` — onboarding compatibility with the v2 review.
- `client/src/services/api.ts` — versioned apply request types and removal of the obsolete PCO person-search method.
- `server/routes/integrations.js` — remove the obsolete PCO provider-person search route after the shared local picker is live.

### Files to remove after replacement

- `client/src/components/planningCenter/PcoPersonSearchPicker.tsx`
- `client/src/components/planningCenter/syncSelections.ts`
- `client/src/components/planningCenter/syncSelections.test.ts`
- `server/services/planningCenter/peopleSearch.js`
- `server/services/planningCenter/peopleSearch.test.js`

---

### Task 1: Persist Exact Exclusions and Review Holds

**Files:**
- Modify: `server/config/schema.js:30-205`
- Create: `server/services/peopleSync/matchReviewRepository.js`
- Create: `server/services/peopleSync/matchReviewRepository.dbintegration.test.js`

**Interfaces:**
- Produces: `listMatchReviewState(churchId, provider) -> { exclusions, holds }`
- Produces: `upsertExclusionWithConnection(conn, input)`, `deleteExclusionWithConnection(conn, input)`, `upsertHoldWithConnection(conn, input)`, and `deleteHoldWithConnection(conn, input)`
- Produces: transaction-wrapped `upsertExclusion(input)`, `deleteExclusion(input)`, `upsertHold(input)`, and `deleteHold(input)` for focused callers/tests
- Consumes: `Database.queryForChurch` and the existing connection object passed by `Database.transactionForChurch`

- [ ] **Step 1: Write failing schema and repository integration tests**

Add tests that initialize a temporary church database, insert two churches' rows, and assert scoped reads, exact-pair uniqueness, hold uniqueness, idempotent upserts, deletion, and author IDs:

```js
test('match review state is isolated by church and provider', async () => {
  await repository.upsertExclusion({ churchId: churchA, provider: 'elvanto', externalPersonId: 'ext-1', individualId: personA, userId: userA });
  await repository.upsertHold({ churchId: churchA, provider: 'elvanto', externalPersonId: 'ext-1', reason: 'pair_rejected', userId: userA });

  assert.deepEqual(await repository.listMatchReviewState(churchB, 'elvanto'), { exclusions: [], holds: [] });
  assert.equal((await repository.listMatchReviewState(churchA, 'planning_center')).exclusions.length, 0);
  const state = await repository.listMatchReviewState(churchA, 'elvanto');
  assert.deepEqual(state.exclusions.map((row) => [row.externalPersonId, row.individualId]), [['ext-1', personA]]);
  assert.equal(state.holds[0].reason, 'pair_rejected');
});
```

- [ ] **Step 2: Run the repository test and verify the schema is missing**

Run: `cd server && node --test services/peopleSync/matchReviewRepository.dbintegration.test.js`

Expected: FAIL because the repository/module or new tables do not exist.

- [ ] **Step 3: Add the additive schema**

Add these tables inside `PROVIDER_NEUTRAL_SYNC_SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS people_sync_match_exclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('planning_center', 'elvanto')),
  external_person_id TEXT NOT NULL,
  individual_id INTEGER NOT NULL,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, provider, external_person_id, individual_id),
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_people_sync_match_exclusions_lookup
  ON people_sync_match_exclusions(church_id, provider, external_person_id);

CREATE TABLE IF NOT EXISTS people_sync_match_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('planning_center', 'elvanto')),
  external_person_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('deferred', 'pair_rejected')),
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, provider, external_person_id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_people_sync_match_holds_lookup
  ON people_sync_match_holds(church_id, provider, external_person_id);
```

- [ ] **Step 4: Implement the focused repository**

Validate providers, positive local IDs, non-empty external IDs, and allowed hold reasons. Every query must include church and provider. Connection-aware helpers use `ON CONFLICT ... DO UPDATE` and return no cross-church data:

```js
async function listMatchReviewState(churchId, provider) {
  assertProvider(provider);
  const [exclusions, holds] = await Promise.all([
    Database.queryForChurch(churchId, `SELECT external_person_id, individual_id FROM people_sync_match_exclusions WHERE church_id = ? AND provider = ? ORDER BY external_person_id, individual_id`, [churchId, provider]),
    Database.queryForChurch(churchId, `SELECT external_person_id, reason FROM people_sync_match_holds WHERE church_id = ? AND provider = ? ORDER BY external_person_id`, [churchId, provider]),
  ]);
  return {
    exclusions: exclusions.map((row) => ({ externalPersonId: row.external_person_id, individualId: Number(row.individual_id) })),
    holds: holds.map((row) => ({ externalPersonId: row.external_person_id, reason: row.reason })),
  };
}
```

Implement each public mutation wrapper with `Database.transactionForChurch(input.churchId, (conn) => correspondingWithConnectionHelper(conn, input))`; do not open nested transactions from the connection-aware helpers used by apply.

- [ ] **Step 5: Run the focused integration test**

Run: `cd server && node --test services/peopleSync/matchReviewRepository.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/config/schema.js server/services/peopleSync/matchReviewRepository.js server/services/peopleSync/matchReviewRepository.dbintegration.test.js
git commit -m "feat(sync): persist match review decisions"
```

---

### Task 2: Apply Exclusions and Holds in the Matcher

**Files:**
- Modify: `server/services/peopleSync/matcher.js`
- Modify: `server/services/peopleSync/matcher.test.js`

**Interfaces:**
- Consumes: `matchPeople({ ..., excludedPairs, heldExternalIds })`
- Produces: the existing matcher result shape, with held unresolved identities emitted in `ambiguous` using reason `review_deferred`

- [ ] **Step 1: Add failing matcher tests**

Cover exact-pair filtering, alternate candidates, all-candidates-excluded, held deterministic matches, held unmatched people, and durable-link precedence:

```js
test('a held deterministic match is returned for review instead of automatic linking', () => {
  const result = matchPeople({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [local(7, 'Alex', 'Smith')],
    heldExternalIds: new Set(['ext-1']),
  });
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.ambiguous, [{ externalPersonId: 'ext-1', candidateIndividualIds: [7], reason: 'review_deferred' }]);
});

test('an exclusion removes only the exact candidate pair', () => {
  const result = matchPeople({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [local(7, 'Alex', 'Smith'), local(8, 'Alex', 'Smith')],
    excludedPairs: new Set(['ext-1\u00007']),
  });
  assert.deepEqual(result.matches.map((row) => row.individualId), [8]);
});
```

- [ ] **Step 2: Run the matcher tests and verify failure**

Run: `cd server && node --test services/peopleSync/matcher.test.js`

Expected: FAIL because `excludedPairs` and `heldExternalIds` are ignored.

- [ ] **Step 3: Filter candidates before regular/review decisions**

Add normalized helpers and apply them to regular, visitor, and archived candidate lists:

```js
function pairKey(externalPersonId, individualId) {
  return `${stableString(externalPersonId)}\u0000${Number(individualId)}`;
}

function candidateAllowed(externalPersonId, localPerson, excludedPairs) {
  return !excludedPairs.has(pairKey(externalPersonId, localPerson.id));
}
```

Durable links are resolved before exclusion filtering and therefore continue to win.

- [ ] **Step 4: Convert held outcomes to review entries**

Before pushing an automatic `matches`, `visitorMatches`, `archivedMatches`, or unmatched external result, check `heldExternalIds`. Emit:

```js
result.ambiguous.push({
  externalPersonId,
  candidateIndividualIds: decision?.candidates.map((person) => Number(person.id)) || [],
  reason: 'review_deferred',
});
```

For a held deterministic proposal, use its one proposed individual ID. For a held external person with no remaining candidates, use an empty candidate array so no `addPeople` action is generated unattended.

- [ ] **Step 5: Run matcher and plan regression tests**

Run: `cd server && node --test services/peopleSync/matcher.test.js services/peopleSync/plan.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/matcher.js server/services/peopleSync/matcher.test.js
git commit -m "feat(sync): respect match exclusions and holds"
```

---

### Task 3: Build Signed Review Context and Family-Aware Display Data

**Files:**
- Create: `server/services/peopleSync/reviewContext.js`
- Create: `server/services/peopleSync/reviewContext.test.js`
- Modify: `server/services/peopleSync/plan.js`
- Modify: `server/services/peopleSync/plan.test.js`
- Modify: `server/services/peopleSync/orchestrator.js:286-326,650-850`
- Modify: `server/services/peopleSync/orchestrator.test.js`

**Interfaces:**
- Produces: `buildReviewContext({ plan, externalPeople, localPeople, personLinks, exclusions, holds, batches, eligibleByBatch })`
- Produces: `buildReviewDirectory({ externalPeople, externalFamilies, localPeople, localFamilies, reviewContext })`
- Produces: review response fields `decisionContractVersion: 2`, `plan.reviewContext`, and family-aware `plan.people`

- [ ] **Step 1: Write failing pure tests for the new context**

Assert that context includes every external identity from `linkPeople`, `ambiguousPeople`, and `addPeople`; manual candidates exclude durable-linked locals; exclusions and holds are represented deterministically; and create data is available for matched as well as unmatched external people:

```js
assert.deepEqual(context.identities['ext-1'], {
  suggestedIndividualId: 7,
  candidateIndividualIds: [7, 8],
  excludedIndividualIds: [9],
  held: true,
  canCreate: true,
  createPerson: {
    firstName: 'Alex', lastName: 'Smith', isChild: false,
    externalFamilyId: 'house-1', peopleType: 'regular',
  },
});
assert.deepEqual(context.manualCandidateIndividualIds, [7, 8, 9]);
```

Assert that the display directory returns names, family names, deterministic member previews, explicit `none` versus `unavailable` family states, and no email/phone/custom attributes.

- [ ] **Step 2: Run the review-context test and verify failure**

Run: `cd server && node --test services/peopleSync/reviewContext.test.js`

Expected: FAIL because `reviewContext.js` does not exist.

- [ ] **Step 3: Implement `buildReviewContext`**

Use a stable versioned shape that is included on the internal plan before `digestPlan(plan)`:

```js
const DECISION_CONTRACT_VERSION = 2;

function buildReviewContext(input) {
  return {
    version: DECISION_CONTRACT_VERSION,
    manualCandidateIndividualIds: eligibleManualIds(input.localPeople, input.personLinks),
    identities: buildIdentityEntries(input),
  };
}
```

`suggestedIndividualId` comes from an unestablished `linkPeople` action or a single ambiguity candidate; `candidateIndividualIds` is the sorted union exposed by the plan; `createPerson` comes from the fresh external snapshot and the batch-derived desired people type. Export the existing pure `desiredPeopleType(externalPerson, qualifyingBatches)` helper from `plan.js` and reuse it here with batches selected from `eligibleByBatch`; do not duplicate its active/contact/default precedence. Do not include durable `linked` identities.

- [ ] **Step 4: Implement the lean family-aware directory**

Return this client-facing shape for each person:

```js
{
  firstName: 'Alex',
  lastName: 'Smith',
  family: {
    state: 'known',
    name: 'Smith Household',
    members: [{ firstName: 'Jamie', lastName: 'Smith' }],
    totalOtherMembers: 1,
  },
  matchEligible: true,
}
```

Use `state: 'none'` when a known null family ID is present and `state: 'unavailable'` when the provider did not supply household context. Limit the embedded preview to the first three deterministically sorted other members while retaining `totalOtherMembers`. Only local entries expose `matchEligible`.

- [ ] **Step 5: Attach context before signing and directory after signing**

In `runPipelineBody`, retain the union of source `contextPeople` and `families`. After computing the plan, attach `plan.reviewContext = buildReviewContext(...)`. In `buildReview` and `previewAuthoritySwitch`, calculate the digest only after this attachment, then sanitize with `buildReviewDirectory(...)` and return top-level `decisionContractVersion: 2`.

The apply path must rebuild the identical internal `reviewContext` before verifying the token.

- [ ] **Step 6: Run focused server tests**

Run: `cd server && node --test services/peopleSync/reviewContext.test.js services/peopleSync/orchestrator.test.js services/peopleSync/plan.test.js services/peopleSync/planDigest.test.js`

Expected: PASS, including stable digest behavior when directory presentation ordering is unchanged.

- [ ] **Step 7: Commit**

```bash
git add server/services/peopleSync/reviewContext.js server/services/peopleSync/reviewContext.test.js server/services/peopleSync/plan.js server/services/peopleSync/plan.test.js server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js
git commit -m "feat(sync): sign family-aware review context"
```

---

### Task 4: Validate the Versioned Identity-Decision Contract

**Files:**
- Create: `server/services/peopleSync/identityDecisions.js`
- Create: `server/services/peopleSync/identityDecisions.test.js`
- Modify: `server/services/peopleSync/apply.js:48-158`
- Modify: `server/services/peopleSync/apply.test.js`

**Interfaces:**
- Consumes: `validateIdentityDecisions(plan, selections)` where `selections.decisionContractVersion === 2`
- Produces: `{ contractVersion, linkActions, createExternalIds, deferredReasons, exclusionsToAdd, exclusionsToRemove, skippedAddExternalIds, suppressedSuggestedPairs, acceptedArchiveIndividualIds, acceptedFamilyRenameIds }`, where deferred reasons are a `Map<externalPersonId, 'deferred' | 'pair_rejected'>`, pair collections are arrays of `{ externalPersonId, individualId }`, and `suppressedSuggestedPairs` contains deterministic suggestions not accepted as proposed
- Preserves: `validateLegacySelections(plan, selections)` with today's exact behavior

- [ ] **Step 1: Write failing validation tests**

Use a signed-style `plan.reviewContext` fixture and test every outcome plus incomplete decisions, arbitrary local IDs, external IDs outside context, duplicate claims, invalid exclusion targets, create/link contradictions, and excluded-pair override:

```js
const selections = {
  decisionContractVersion: 2,
  identityDecisions: {
    'ext-accept': { outcome: 'accept' },
    'ext-link': { outcome: 'link', individualId: 12, excludeIndividualId: 11 },
    'ext-create': { outcome: 'create', excludeIndividualId: 13 },
    'ext-defer': { outcome: 'defer' },
  },
};

const accepted = validateIdentityDecisions(plan, selections);
assert.deepEqual(accepted.linkActions.map((row) => [row.externalPersonId, row.individualId]), [
  ['ext-accept', 10], ['ext-link', 12],
]);
assert.deepEqual([...accepted.createExternalIds], ['ext-create']);
assert.deepEqual([...accepted.deferredReasons], [['ext-defer', 'deferred']]);
```

- [ ] **Step 2: Run the validator test and verify failure**

Run: `cd server && node --test services/peopleSync/identityDecisions.test.js`

Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement strict v2 shape validation**

Define the only permitted outcomes and exact field combinations:

```js
const OUTCOMES = new Set(['accept', 'link', 'create', 'defer']);

function validateIdentityDecisions(plan, selections) {
  if (selections.decisionContractVersion !== 2) throw new Error('Unsupported identity decision contract version');
  const context = plan.reviewContext;
  if (!context || context.version !== 2) throw new Error('This plan does not support identity decisions');
  return normalizeAndValidate(context, selections.identityDecisions);
}
```

Require one decision for every `reviewContext.identities` entry. `accept` requires a suggested individual. `link` requires a positive ID in `manualCandidateIndividualIds`. `create` requires `canCreate` and create data. `defer` claims neither side. `excludeIndividualId`, when present, must equal a candidate exposed for that same external person and must differ from an accepted target. Normalize a deferred decision with an exclusion to reason `pair_rejected`; normalize one without an exclusion to `deferred`.

When a deterministic suggestion is redirected, created separately, or deferred, add its exact `{ externalPersonId, suggestedIndividualId }` to `suppressedSuggestedPairs`. This tells apply to withhold dependent actions that the old match caused the plan to calculate.

Extract the current archive and family-rename checks into a shared pure helper and run them for both contract versions. Include their accepted sets in both discriminated normalized results so the later archive/rename transaction code remains unchanged.

- [ ] **Step 4: Rename and preserve the legacy validator**

Move the current function body to `validateLegacySelections`. Dispatch without inference:

```js
function validateSelections(plan, selections = {}) {
  return selections?.decisionContractVersion === 2
    ? validateIdentityDecisions(plan, selections)
    : validateLegacySelections(plan, selections);
}
```

Return a discriminated normalized result: add `contractVersion: 1` to the existing legacy result and `contractVersion: 2` to the new result. The transactional apply path branches only on that discriminator and never re-reads raw request fields.

- [ ] **Step 5: Run pure apply/decision tests**

Run: `cd server && node --test services/peopleSync/identityDecisions.test.js services/peopleSync/apply.test.js`

Expected: PASS for v2 and unchanged legacy fixtures.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/identityDecisions.js server/services/peopleSync/identityDecisions.test.js server/services/peopleSync/apply.js server/services/peopleSync/apply.test.js
git commit -m "feat(sync): validate identity review decisions"
```

---

### Task 5: Apply Identity Decisions Atomically

**Files:**
- Modify: `server/services/peopleSync/apply.js:220-560`
- Modify: `server/services/peopleSync/apply.dbintegration.test.js`
- Modify: `server/services/peopleSync/matchReviewRepository.js`
- Modify: `server/services/peopleSync/matchReviewRepository.dbintegration.test.js`

**Interfaces:**
- Consumes: the normalized validation result from Task 4
- Consumes: Task 1 connection-aware repository helpers
- Produces: atomic links, created individuals, holds, exclusions, and exclusion overrides

- [ ] **Step 1: Add failing database integration scenarios**

Cover these complete transactions:

1. accept deterministic suggestion and clear a hold;
2. link to another local person, add exclusion for the rejected suggestion, and clear a hold;
3. create a new person from `reviewContext.createPerson`, link it, and clear a hold;
4. defer and upsert a `deferred` hold without linking/creating;
5. reject a pair and persist both exclusion and `pair_rejected` hold;
6. manually select an excluded pair, remove that exclusion, and clear the hold;
7. reject a deterministic suggestion and assert its managed-field, lifecycle, family, and gathering actions do not touch the suggested local person; and
8. force a later source-promotion failure and assert every identity mutation rolls back.

```js
const reviewContext = {
  version: 2,
  manualCandidateIndividualIds: [],
  identities: {
    'ext-1': {
      suggestedIndividualId: null,
      candidateIndividualIds: [],
      excludedIndividualIds: [],
      held: false,
      canCreate: true,
      createPerson: {
        firstName: 'Alex', lastName: 'Smith', isChild: false,
        externalFamilyId: null, peopleType: 'regular',
      },
    },
  },
};
const before = await counts(churchId);
await assert.rejects(() => applyPeopleSyncPlan({
  churchId,
  provider: 'elvanto',
  plan: emptyPlan({ reviewContext }),
  selections: {
    decisionContractVersion: 2,
    identityDecisions: { 'ext-1': { outcome: 'create' } },
  },
  userId: null,
  sourcePromotion: {
    batchId: 999999,
    expectedBaseRevision: 1,
    expectedDraftDigest: '0'.repeat(64),
  },
}));
assert.deepEqual(await counts(churchId), before);
const holds = await Database.query('SELECT id FROM people_sync_match_holds WHERE church_id = ?', [churchId]);
assert.equal(holds.length, 0);
```

- [ ] **Step 2: Run the focused integration test and verify failure**

Run: `cd server && node --test services/peopleSync/apply.dbintegration.test.js`

Expected: FAIL because v2 outcomes do not yet drive transaction mutations.

- [ ] **Step 3: Replace implicit auto links only for v2 requests**

For legacy normalized results, retain current deterministic `linkPeople` behavior. For v2, use only normalized `linkActions`; otherwise a rejected default suggestion would still link implicitly:

```js
const linkActions = accepted.contractVersion === 2
  ? accepted.linkActions
  : [...asArray(plan.linkPeople).filter((action) => !action.reviewRequired), ...accepted.acceptedLinks];
```

- [ ] **Step 4: Create v2-selected new individuals**

Unify ordinary `addPeople` creations and `createExternalIds` so each external person is created at most once. For v2, skip every `addPeople` action whose external ID is in `skippedAddExternalIds`, and synthesize an add action for a selected create whose external ID was originally a link/ambiguity. Use only `plan.reviewContext.identities[externalPersonId].createPerson`, resolve external family IDs through `external_family_links`, and preserve Planning Center's compatibility column update.

- [ ] **Step 5: Suppress actions derived from rejected suggestions**

Build exact external and local suppression sets from `accepted.suppressedSuggestedPairs`. For v2 only, filter `updateManagedFields`, `promoteToRegular`, `demoteToLocalVisitor`, `archive`, `reactivate`, `moveFamily`, `addToGathering`, and `removeFromGathering` when the action targets the rejected external identity or its suggested individual. Do not recompute those changes against a manually selected replacement in the same apply; the durable manual link is established now and its dependent changes are calculated on the next fresh review.

- [ ] **Step 6: Mutate holds and exclusions inside the same transaction**

After links/creates succeed but before source promotion and authority activation:

```js
for (const [externalPersonId, reason] of accepted.deferredReasons) {
  await matchReviewRepository.upsertHoldWithConnection(conn, {
    churchId, provider, externalPersonId,
    reason,
    userId,
  });
}
for (const action of accepted.linkActions) {
  await matchReviewRepository.deleteHoldWithConnection(conn, { churchId, provider, externalPersonId: action.externalPersonId });
}
```

Also clear holds for successful creates, add exact exclusions, and remove exclusions when an excluded pair is deliberately linked.

- [ ] **Step 7: Run apply and repository integration tests**

Run: `cd server && node --test services/peopleSync/apply.test.js services/peopleSync/apply.dbintegration.test.js services/peopleSync/matchReviewRepository.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/services/peopleSync/apply.js server/services/peopleSync/apply.dbintegration.test.js server/services/peopleSync/matchReviewRepository.js server/services/peopleSync/matchReviewRepository.dbintegration.test.js
git commit -m "feat(sync): apply match decisions atomically"
```

---

### Task 6: Wire Review State Through Orchestration and Notifications

**Files:**
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/orchestrator.dbintegration.test.js`
- Modify: `server/services/peopleSync/reviewNotification.js`
- Modify: `server/services/peopleSync/reviewNotification.dbintegration.test.js`
- Modify: `server/routes/integrations/planningCenterPeopleSync.test.js`
- Modify: `server/routes/integrations/elvanto.test.js`
- Modify: `server/routes/integrations/peopleSync.test.js`

**Interfaces:**
- Consumes: `listMatchReviewState(churchId, provider)` from Task 1
- Passes: `excludedPairs` and `heldExternalIds` into `matchPeople`
- Returns: `decisionContractVersion: 2` from batch and authority previews

- [ ] **Step 1: Add failing orchestrator tests**

Assert that build/apply/unattended all load the same church/provider review state, pass normalized sets to the matcher, and rebuild identical signed context. Add an unattended scenario where a held unmatched external person creates no individual, produces an `ambiguousPeople` held count, finishes `review_required`, and notifies once.

- [ ] **Step 2: Run focused orchestration tests and verify failure**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js`

Expected: FAIL because the new repository state is not loaded or forwarded.

- [ ] **Step 3: Add the repository to `defaultDeps` and pipeline loading**

Load state alongside local data:

```js
const [individuals, families, personLinks, familyLinks, gatheringMemberships, matchReviewState] = await Promise.all([
  deps.listLocalIndividuals(churchId),
  deps.listLocalFamilies(churchId),
  deps.listPersonLinks(churchId, provider),
  deps.listFamilyLinks(churchId, provider),
  deps.listGatheringMemberships(churchId),
  deps.listMatchReviewState(churchId, provider),
]);
```

Convert exclusions to pair keys and holds to external-ID sets for `matchPeople`, while passing the structured rows to `buildReviewContext`.

- [ ] **Step 4: Include held identities in review-required reporting**

Held identities already surface as `ambiguousPeople`; verify `heldCounts`, `hasHeldItems`, run counts, and notification copy report them as matches waiting for review. Map `review_deferred` to friendly wording only at the response/UI boundary; do not put names into notification fingerprints or messages.

Broaden the existing notification label so it remains true for both genuine ambiguity and a deferred deterministic match:

```js
if (counts.ambiguousPeople) {
  parts.push(pluralize(counts.ambiguousPeople, 'person match', 'person matches'));
}
```

- [ ] **Step 5: Assert route transparency and legacy payload forwarding**

Update PCO, Elvanto, and authority route tests to confirm `decisionContractVersion: 2` passes through unchanged and v2 selections are forwarded verbatim. Retain an explicit legacy request fixture proving the old payload is still forwarded as legacy.

- [ ] **Step 6: Run all provider-neutral orchestration and route tests**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/reviewNotification.dbintegration.test.js routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js routes/integrations/peopleSync.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/orchestrator.dbintegration.test.js server/services/peopleSync/reviewNotification.js server/services/peopleSync/reviewNotification.dbintegration.test.js server/routes/integrations/planningCenterPeopleSync.test.js server/routes/integrations/elvanto.test.js server/routes/integrations/peopleSync.test.js
git commit -m "feat(sync): orchestrate held identity reviews"
```

---

### Task 7: Add Exact Client Contracts and Decision Serialization

**Files:**
- Modify: `client/src/components/peopleSync/types.ts`
- Modify: `client/src/components/peopleSync/syncSelections.ts`
- Modify: `client/src/components/peopleSync/syncSelections.test.ts`
- Modify: `client/src/services/api.ts`

**Interfaces:**
- Produces: `IdentityDecision`, `PeopleSyncReviewContext`, `PeopleSyncPersonDisplay`, and v2 `PeopleSyncSelections`
- Produces: `initializeIdentityDecisions(review) -> Record<string, IdentityDecision | null>`, `incompleteIdentityExternalIds(state, reviewContext) -> string[]`, and `buildSyncSelections(state) -> PeopleSyncSelections`
- Consumes: server contract version and review-context fields from Tasks 3–6

- [ ] **Step 1: Write failing serializer tests**

Test stable key ordering and all four outcomes, rejected-pair IDs, destructive selections, and default acceptance initialization:

```ts
expect(buildSyncSelections(state)).toEqual({
  decisionContractVersion: 2,
  identityDecisions: {
    'ext-1': { outcome: 'accept' },
    'ext-2': { outcome: 'link', individualId: 12, excludeIndividualId: 11 },
    'ext-3': { outcome: 'create' },
    'ext-4': { outcome: 'defer' },
  },
  acceptArchiveIndividualIds: [9],
  acceptFamilyRenameIds: ['renameFamily:4'],
});
```

- [ ] **Step 2: Run the serializer test and verify failure**

Run: `cd client && npm test -- --run src/components/peopleSync/syncSelections.test.ts`

Expected: FAIL because the v2 types and state do not exist.

- [ ] **Step 3: Define exact TypeScript contracts**

Add:

```ts
export type IdentityDecision =
  | { outcome: 'accept'; excludeIndividualId?: never }
  | { outcome: 'link'; individualId: number; excludeIndividualId?: number }
  | { outcome: 'create'; excludeIndividualId?: number }
  | { outcome: 'defer'; excludeIndividualId?: number };

export interface PeopleSyncReviewContext {
  version: 2;
  manualCandidateIndividualIds: number[];
  identities: Record<string, IdentityReviewEntry>;
}

export interface PeopleSyncSelections {
  decisionContractVersion?: 2;
  identityDecisions?: Record<string, IdentityDecision>;
  acceptArchiveIndividualIds?: number[];
  acceptFamilyRenameIds?: string[];
  ambiguous?: Record<string, number>;
  skipExternalPersonIds?: string[];
  visitorChoices?: Record<string, 'promote' | 'keep'>;
}
```

Keep legacy fields optional and documented as compatibility-only.

Add `reviewContext?: PeopleSyncReviewContext` to `PeopleSyncPlan`, add `decisionContractVersion?: 2` to `PeopleSyncReview`, and exclude `reviewContext` from `PeopleSyncBucketName` alongside `provider`, `authoritative`, `snapshot`, and `people` so summary/count types remain limited to the 17 real action buckets.

- [ ] **Step 4: Implement v2 state initialization and serialization**

Initialize deterministic suggestions to `accept`, existing unmatched additions to `create`, and ambiguous/held identities to no decision. Implement `incompleteIdentityExternalIds` to return sorted unresolved external IDs; the UI uses that result to block apply instead of fabricating deferrals.

- [ ] **Step 5: Update API request typing**

Use the same `PeopleSyncSelections` for Planning Center batch apply, Elvanto batch apply, and authority apply. No endpoint-specific adapter may reverse external/local IDs.

- [ ] **Step 6: Run client contract tests and TypeScript build**

Run: `cd client && npm test -- --run src/components/peopleSync/syncSelections.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/peopleSync/types.ts client/src/components/peopleSync/syncSelections.ts client/src/components/peopleSync/syncSelections.test.ts client/src/services/api.ts
git commit -m "feat(sync): add match decision client contract"
```

---

### Task 8: Build Comparison Cards and Restyle the Shared Review

**Files:**
- Create: `client/src/components/peopleSync/PersonIdentitySummary.tsx`
- Create: `client/src/components/peopleSync/MatchDecisionCard.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.test.tsx`

**Interfaces:**
- `PersonIdentitySummary({ label, person })`
- `MatchDecisionCard({ provider, externalId, entry, directory, decision, claimedIndividualIds, onChange })`
- `SyncReview` keeps its existing public props and submits v2 selections when `decisionContractVersion === 2`

- [ ] **Step 1: Replace the shared-review tests with behavior-first failing cases**

Keep destructive/stale tests and add:

- friendly summary labels with no raw bucket names;
- provider and LMPG comparison sides;
- family name/member preview, `No family`, and unavailable household copy;
- deterministic default accept;
- ambiguous apply disabled until link/create/defer;
- inline local search by name and family member;
- claimed/durable-linked results disabled with explanation;
- create, defer, exact rejection, and excluded-pair override confirmation;
- top and bottom apply controls;
- semantic disclosures, alerts, labels, and mobile stacking classes.

```tsx
expect(screen.getByText('Planning Center person')).toBeInTheDocument();
expect(screen.getByText('Smith Household')).toBeInTheDocument();
expect(screen.getByText(/Jamie Smith/)).toBeInTheDocument();
expect(screen.queryByText(/linkPeople:/)).not.toBeInTheDocument();
await user.click(screen.getByRole('radio', { name: 'Choose someone else' }));
await user.type(screen.getByRole('searchbox', { name: 'Search Let My People Grow people' }), 'Taylor');
```

- [ ] **Step 2: Run the component test and verify failure**

Run: `cd client && npm test -- --run src/components/peopleSync/SyncReview.test.tsx`

Expected: FAIL against the current raw list UI.

- [ ] **Step 3: Implement `PersonIdentitySummary`**

Render semantic headings, name, family state, first three other members, and a disclosure for remaining members. Do not render IDs. Use neutral gray family text and no colour-only meaning.

- [ ] **Step 4: Implement `MatchDecisionCard`**

Use a responsive two-column comparison grid (`grid-cols-1 md:grid-cols-2`) above a radio group. The local picker filters `directory.local` client-side, matches person/family/member names, excludes IDs outside `manualCandidateIndividualIds`, and marks currently claimed IDs disabled. Show the persistent rejection checkbox only after the suggested pair is rejected.

- [ ] **Step 5: Recompose `SyncReview` into app-style sections**

Create friendly summary cards and disclosure sections for matches, new people, managed updates, gatherings, destructive changes, and skipped/unchanged items. Keep destructive confirmation and `requireAllPlannedArchivesAccepted`. Map known reasons through a fixed copy table:

```ts
const MATCH_REASON_COPY: Record<string, string> = {
  unique_name: 'Same full name',
  child_narrowing: 'Same full name and child status',
  family_corroboration: 'Same full name with a linked family member',
  duplicate_name: 'More than one person has this name',
  review_deferred: 'Previously left for review',
};
```

Unknown reasons use a generic `Needs review` label, never the raw code.

- [ ] **Step 6: Implement readiness and retry behavior**

Disable apply for incomplete required identity decisions, collisions, destructive confirmation, archive acceptance policy, or active request. Keep decisions after a non-stale apply error; reset them when the review token changes. Show the affected person names for client-known collisions. For `SYNC_PLAN_STALE`, list the display names involved in the client's manual choices and explain that at least one choice may no longer be available before offering **Refresh plan**; do not attempt a blind retry.

- [ ] **Step 7: Run shared component tests and build**

Run: `cd client && npm test -- --run src/components/peopleSync/SyncReview.test.tsx src/components/peopleSync/syncSelections.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/peopleSync/PersonIdentitySummary.tsx client/src/components/peopleSync/MatchDecisionCard.tsx client/src/components/peopleSync/SyncReview.tsx client/src/components/peopleSync/SyncReview.test.tsx
git commit -m "feat(sync): add family-aware match review cards"
```

---

### Task 9: Integrate Both Providers, Remove Dead Legacy UI, and Verify

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`
- Modify: `client/src/components/planningCenter/PlanningCenterSyncReview.test.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.test.tsx`
- Modify: `client/src/components/peopleSync/PeopleSourceControl.tsx`
- Modify: `client/src/components/peopleSync/PeopleSourceControl.test.tsx`
- Modify: `client/src/components/elvanto/ElvantoOnboarding.tsx`
- Modify: `client/src/services/api.ts`
- Modify: `server/routes/integrations.js`
- Delete: `client/src/components/planningCenter/PcoPersonSearchPicker.tsx`
- Delete: `client/src/components/planningCenter/syncSelections.ts`
- Delete: `client/src/components/planningCenter/syncSelections.test.ts`
- Delete: `server/services/planningCenter/peopleSearch.js`
- Delete: `server/services/planningCenter/peopleSearch.test.js`

**Interfaces:**
- Consumes: the unchanged `SyncReview` prop interface and v2 shared API contract
- Produces: consistent nested review presentation in Planning Center, Elvanto, onboarding, and authority preview

- [ ] **Step 1: Add failing provider-integration tests**

Assert both batch panels render the shared nested surface and consistent primary/secondary button classes; PCO and Elvanto submit the same v2 decision direction (`externalPersonId -> local individualId`); authority preview and onboarding render the v2 review; successful apply refreshes stats/batch state; stale errors offer refresh without blind retry.

- [ ] **Step 2: Run provider component tests and verify failure**

Run: `cd client && npm test -- --run src/components/planningCenter/PlanningCenterSyncReview.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/components/peopleSync/PeopleSourceControl.test.tsx`

Expected: FAIL until wrappers and containers use the refreshed shared behavior.

- [ ] **Step 3: Align provider wrappers and expanded containers**

Use a nested `rounded-lg border bg-gray-50/50 p-4 dark:bg-gray-900/20` review surface, proper bordered secondary buttons instead of bare underlines for primary actions, and identical loading/error spacing. Preserve provider-specific connection and archive-acceptance behavior.

- [ ] **Step 4: Update authority preview and onboarding**

Pass v2 reviews and selections without adapters. Ensure cancel/close actions remain outside `SyncReview`, and reset wrapper state only when closing or receiving a new review token.

- [ ] **Step 5: Remove the obsolete opposite-direction search path**

Delete the unused Planning Center provider-person picker and legacy selection adapter. Remove `integrationsAPI.searchPlanningCenterPeople`, the `/planning-center/people-search` route, its `searchPcoPeople` import, and the now-unreferenced service/tests. Confirm no references remain:

Run: `rg -n "PcoPersonSearchPicker|searchPlanningCenterPeople|toLegacyPcoSelections|people-search|searchPcoPeople" client/src server`

Expected: no output.

- [ ] **Step 6: Run the full focused server suite**

Run: `cd server && node --test services/peopleSync/*.test.js routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js routes/integrations/peopleSync.test.js`

Expected: PASS.

- [ ] **Step 7: Run the full client suite and production build**

Run: `cd client && npm test && npm run build`

Expected: all Vitest tests pass and Vite/service-worker production build succeeds.

- [ ] **Step 8: Run final static and repository checks**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; status lists only the intended Task 9 files before commit.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterSyncReview.tsx client/src/components/planningCenter/PlanningCenterSyncReview.test.tsx client/src/components/planningCenter/PcoPersonSearchPicker.tsx client/src/components/planningCenter/syncSelections.ts client/src/components/planningCenter/syncSelections.test.ts client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx client/src/components/integrations/ElvantoIntegrationPanel.tsx client/src/components/integrations/ElvantoIntegrationPanel.test.tsx client/src/components/peopleSync/PeopleSourceControl.tsx client/src/components/peopleSync/PeopleSourceControl.test.tsx client/src/components/elvanto/ElvantoOnboarding.tsx client/src/services/api.ts server/routes/integrations.js server/services/planningCenter/peopleSearch.js server/services/planningCenter/peopleSearch.test.js
git commit -m "feat(sync): integrate redesigned match review"
```
