# One-Time Provider People Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reviewed, additive Planning Center/Elvanto people import on the People page and onboarding that retains dormant provider links without creating sync batches or authority effects.

**Architecture:** Add an import-specific provider read contract and a focused `peopleImport` orchestration layer. Reuse normalized provider snapshots, matching, review context, signed-plan verification, and the existing transactional apply engine, but project and validate an additive-only plan before apply. Expose import through its own router and client workflow; do not route it through sync-batch CRUD.

**Tech Stack:** Node.js 22, Express 5, SQLite/better-sqlite3, `node:test`, React 19, TypeScript 6, Axios, Vitest, Testing Library, Tailwind CSS.

## Global Constraints

- Every database read/write is scoped by `church_id`; background/provider work uses `Database.queryForChurch` or `Database.transactionForChurch`.
- One-time import creates no `people_sync_batches` row and changes no batch, source, schedule, gathering membership, lifecycle state, or authority state.
- Imported provider person and household IDs use the existing `external_person_links` and `external_family_links` tables; no duplicate dormant-link schema is introduced.
- Existing people, family names, family placement, people type, archive state, and managed fields are not mutated by import.
- With `authority_provider = 'none'`, unmatched eligible people are created as `regular` except normalized provider Contacts, which remain `local_visitor`.
- With any active authority, every unmatched import addition outside authoritative sync is created as `local_visitor`, including imports from the authoritative provider.
- Provider reads must be complete and paginated; partial snapshots fail closed.
- Preview and apply both fetch fresh provider state; changed provider, local, connection, or authority state rejects apply atomically.
- Import review tokens are single-use, expire after 30 minutes, and cannot be substituted for sync or authority tokens.
- No new npm dependencies.

---

## File structure

**New server units**

- `server/services/peopleImport/plan.js` — projects a sync-shaped provider/matcher result into the additive import action contract.
- `server/services/peopleImport/orchestrator.js` — preview/apply lifecycle for one-time imports.
- `server/services/peopleImport/plan.test.js` and `orchestrator.test.js` — pure/unit coverage.
- `server/services/peopleImport/orchestrator.dbintegration.test.js` — transactional, church-isolation, replay, and stale-state coverage.
- `server/routes/people-imports.js` and `people-imports.test.js` — admin-only HTTP contract and safe error mapping.

**New client units**

- `client/src/components/peopleImport/types.ts` — import-only request/response contracts.
- `client/src/components/peopleImport/PeopleImportDialog.tsx` — provider/source selection and reviewed apply workflow.
- `client/src/components/peopleImport/PeopleImportDialog.test.tsx` — workflow and copy coverage.

**Focused shared changes**

- Provider adapters gain `fetchImportSnapshot`; the existing sync `fetchSourceSnapshot` contract remains unchanged.
- `server/services/peopleSync/localProjectionState.js` owns church-scoped local people/family/link reads currently embedded in the sync orchestrator.
- `server/services/peopleSync/planDigest.js` signs an explicit `operationKind` while accepting existing legacy sync tokens.
- `server/services/peopleSync/apply.js` receives a defensive `allowedMutationBuckets` guard for import apply.
- `client/src/components/peopleSync/SyncReview.tsx` receives `operationKind="people_import" | "people_sync" | "authority_switch"` to change copy and hide import-forbidden correction/lifecycle controls.

---

### Task 1: Complete-provider import snapshots

**Files:**
- Modify: `server/services/peopleSync/providerRegistry.js`
- Modify: `server/services/peopleSync/providerRegistry.test.js`
- Modify: `server/services/planningCenter/sourceAdapter.js`
- Modify: `server/services/planningCenter/sourceAdapter.test.js`
- Modify: `server/services/peopleSync/pcoAdapter.js`
- Modify: `server/services/peopleSync/pcoAdapter.test.js`
- Modify: `server/services/elvanto/sourceAdapter.js`
- Modify: `server/services/elvanto/sourceAdapter.test.js`
- Modify: `server/services/elvanto/adapter.js`
- Modify: `server/services/elvanto/adapter.test.js`

**Interfaces:**
- Produces: `adapter.fetchImportSnapshot({ churchId, credentials, selection, signal }) -> Promise<ProviderSnapshot>`.
- `selection` is `{ kind: 'all' }` or `{ kind: SourceKind, externalId: string }`.
- A returned snapshot uses the existing complete source shape: `{ provider, source, complete, fetchedAt, memberExternalIds, people, contextPeople, families }`.
- For `kind: 'all'`, `source` is the virtual stable identity `{ kind: 'all', externalId: 'all', name: 'Everyone', memberCount, providerRefreshedAt: null }`.

- [ ] **Step 1: Write failing adapter-contract and all-snapshot tests**

Add contract coverage:

```js
for (const method of ['validateConnection', 'listSources', 'fetchSourceSnapshot', 'fetchImportSnapshot', 'isLifecycleEligible']) {
  test(`provider adapter requires ${method}`, () => {
    assert.throws(() => validateAdapter(adapter({ [method]: undefined })), new RegExp(method));
  });
}
```

Add PCO and Elvanto tests proving `all` reads every page, normalizes households, returns every member ID once, and rejects malformed/partial pages without returning accumulated people. Also assert a List/Category/Group import delegates to the existing `fetchSourceSnapshot` path.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/providerRegistry.test.js services/peopleSync/pcoAdapter.test.js services/planningCenter/sourceAdapter.test.js services/elvanto/adapter.test.js services/elvanto/sourceAdapter.test.js
```

Expected: FAIL because `fetchImportSnapshot`, PCO all-person snapshot, and Elvanto all-person snapshot do not exist.

- [ ] **Step 3: Implement the import snapshot contract**

Add the registry method and adapter dispatch:

```js
async fetchImportSnapshot({ credentials, selection, signal } = {}) {
  if (selection?.kind === 'all') {
    return resolved.fetchAllSnapshot({ credentials, signal });
  }
  return resolved.fetchSourceSnapshot({
    credentials,
    sourceKind: selection?.kind,
    sourceExternalId: selection?.externalId,
    signal,
  });
}
```

Implement `fetchPlanningCenterAllSnapshot` with the same read client, projection, household includes, bounded retry, and pagination validation as the List reader, using `/people?per_page=100&include=households.people,field_data`. Implement `fetchElvantoAllSnapshot` with `client.getAll(PEOPLE_PATH, {}, 'people', 'person')` and `normalizeSnapshot`. Neither implementation may return raw provider payloads.

- [ ] **Step 4: Run the focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/peopleSync/providerRegistry.js server/services/peopleSync/providerRegistry.test.js server/services/planningCenter/sourceAdapter.js server/services/planningCenter/sourceAdapter.test.js server/services/peopleSync/pcoAdapter.js server/services/peopleSync/pcoAdapter.test.js server/services/elvanto/sourceAdapter.js server/services/elvanto/sourceAdapter.test.js server/services/elvanto/adapter.js server/services/elvanto/adapter.test.js
git commit -m "feat(import): read complete provider populations"
```

---

### Task 2: Additive-only import plan policy

**Files:**
- Create: `server/services/peopleImport/plan.js`
- Create: `server/services/peopleImport/plan.test.js`
- Modify: `server/services/peopleSync/plan.js`
- Modify: `server/services/peopleSync/plan.test.js`

**Interfaces:**
- Consumes: existing `computePeopleSyncPlan(input)` normalized action plan.
- Produces: `computePeopleImportPlan(input) -> PeopleSyncPlan` with `operationKind: 'people_import'`, `authoritative: false`, and only additive/import review buckets populated.
- Produces: `assertAdditiveImportPlan(plan) -> void`.
- Allowed non-empty buckets: `linkPeople`, `linkFamilies`, `addPeople`, `addFamilies`, `ambiguousPeople`, `familyConflicts`, `skipped`.

- [ ] **Step 1: Write failing policy tests**

Cover no-authority regular creation, authority-forced visitors, normalized Contacts, existing auto-links, ambiguous matches, family creation/linking, and zero output in every forbidden bucket:

```js
const FORBIDDEN = [
  'updateManagedFields', 'promoteToRegular', 'demoteToLocalVisitor', 'archive',
  'reactivate', 'moveFamily', 'renameFamily', 'addToGathering', 'removeFromGathering',
  'unmatchedLocalRegulars',
];

test('authority forces every unmatched import addition to local visitor', () => {
  const plan = computePeopleImportPlan(fixture({ authorityProvider: 'planning_center' }));
  assert.deepEqual(plan.addPeople.map((action) => action.peopleType), ['local_visitor']);
  for (const bucket of FORBIDDEN) assert.deepEqual(plan[bucket], []);
});
```

Assert `assertAdditiveImportPlan` rejects a hand-built plan containing one archive, managed-field update, gathering action, source promotion, or `authoritative: true`.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleImport/plan.test.js services/peopleSync/plan.test.js
```

Expected: FAIL because the import policy module does not exist.

- [ ] **Step 3: Export the narrow reusable plan helpers**

From `peopleSync/plan.js`, export only the helpers required to avoid duplicating normalization/family logic:

```js
module.exports = {
  BUCKETS,
  computePeopleSyncPlan,
  summarizePlan,
  desiredPeopleType,
  projectAdditiveImportPlan,
};
```

Implement `projectAdditiveImportPlan(syncPlan, authorityProvider)` beside the existing plan internals so it can clone the validated plan, clear every forbidden bucket, set `operationKind`, force unmatched additions to visitors when authority is active, and attach `reason: 'authority_requires_visitor'` to those additions. It must preserve identity/family conflicts for review.

- [ ] **Step 4: Implement and defensively validate the import plan**

`peopleImport/plan.js` constructs one synthetic, gathering-free eligibility batch around the selected member set, asks the shared planner for matching/family actions, then projects it:

```js
function computePeopleImportPlan(input) {
  const eligible = new Set(input.memberExternalIds.map(String));
  const syncPlan = computePeopleSyncPlan({
    ...input,
    authoritative: true,
    activeAuthority: input.authorityProvider,
    trigger: 'manual',
    batches: [{ id: 1, enabled: true, defaultPeopleType: 'regular', gatheringTypeId: null }],
    eligibleByBatch: new Map([[1, eligible]]),
  });
  const plan = projectAdditiveImportPlan(syncPlan, input.authorityProvider);
  assertAdditiveImportPlan(plan);
  return plan;
}
```

Validation must enumerate every `BUCKETS` entry so a newly added future mutation bucket fails closed until explicitly classified.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleImport/plan.js server/services/peopleImport/plan.test.js server/services/peopleSync/plan.js server/services/peopleSync/plan.test.js
git commit -m "feat(import): define additive people import policy"
```

---

### Task 3: Import audit trigger and operation-bound review tokens

**Files:**
- Modify: `server/config/schema.js`
- Modify: `server/config/database.js`
- Modify: `server/config/database.test.js`
- Modify: `server/services/peopleSync/runRepository.js`
- Modify: `server/services/peopleSync/runRepository.dbintegration.test.js`
- Modify: `server/services/peopleSync/planDigest.js`
- Modify: `server/services/peopleSync/planDigest.test.js`
- Modify: `server/services/peopleSync/apply.js`
- Modify: `server/services/peopleSync/apply.test.js`

**Interfaces:**
- Produces: run trigger `people_import` with `batchId: null`.
- Import audit provenance accepts `batchId: null` and source kind `all`; sync
  provenance continues to require a positive batch ID.
- Changes token calls to `createReviewToken({ operationKind, churchId, provider, batchId, planDigest, ... })`.
- Changes verification to require `operationKind` for new tokens while accepting existing signed legacy payload shapes.
- Produces: `applyPeopleSyncPlan({ ..., allowedMutationBuckets?: Set<string> })` defensive guard.

- [ ] **Step 1: Write failing schema, repository, token-substitution, and apply-guard tests**

Add tests proving:

```js
const token = createReviewToken({
  operationKind: 'people_import', churchId: 'c1', provider: 'elvanto',
  batchId: null, planDigest: 'a'.repeat(64), expiresInSeconds: 60,
});
assert.equal(verifyReviewToken(token, {
  operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto',
  batchId: null, planDigest: 'a'.repeat(64),
}).ok, false);
```

Add a database migration test starting from the old `people_sync_runs` CHECK constraint, running schema initialization, preserving an existing run ID, and successfully inserting `trigger = 'people_import'`. Add run-repository tests for batchless import provenance `{ batchId: null, sourceKind: 'all' }` and rejection of batchless ordinary sync provenance. Add an apply test proving `allowedMutationBuckets` rejects a plan with `archive` before opening a transaction.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test config/database.test.js services/peopleSync/runRepository.dbintegration.test.js services/peopleSync/planDigest.test.js services/peopleSync/apply.test.js
```

Expected: FAIL on the new trigger, operation-bound token, and mutation guard.

- [ ] **Step 3: Add the SQLite trigger migration**

Update the canonical table CHECK to include `people_import`. Add an idempotent migration in `database.js` that detects an old `people_sync_runs` SQL definition, creates `people_sync_runs_next` with the canonical columns/checks/FK, copies all rows preserving IDs, replaces the table, and recreates both indexes inside one transaction with foreign keys handled using the repository's existing migration pattern. Record a unique migration version such as `v2.2.0_people_import_run_trigger`.

- [ ] **Step 4: Bind operation kind and guard apply**

New tokens include exactly `operationKind` in the signed payload. Existing payload layouts remain valid only when callers omit `expected.operationKind`; all new import and sync call sites added after this task must pass it. `applyPeopleSyncPlan` passes `reviewedApply.operationKind` into `verifyReviewToken`, so endpoint separation is checked again inside the transaction. Add:

```js
function assertAllowedMutationBuckets(plan, allowed) {
  if (!allowed) return;
  for (const bucket of BUCKETS) {
    if (!allowed.has(bucket) && Array.isArray(plan[bucket]) && plan[bucket].length > 0) {
      throw reviewedApplyError('SYNC_REVIEW_INVALID', `Plan contains forbidden ${bucket} actions`, 400);
    }
  }
}
```

Call it before `Database.transactionForChurch`.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS with old audit rows preserved.

- [ ] **Step 6: Commit**

```bash
git add server/config/schema.js server/config/database.js server/config/database.test.js server/services/peopleSync/runRepository.js server/services/peopleSync/runRepository.dbintegration.test.js server/services/peopleSync/planDigest.js server/services/peopleSync/planDigest.test.js server/services/peopleSync/apply.js server/services/peopleSync/apply.test.js
git commit -m "feat(import): bind reviews and audit import runs"
```

---

### Task 4: Shared church-scoped projection state

**Files:**
- Create: `server/services/peopleSync/localProjectionState.js`
- Create: `server/services/peopleSync/localProjectionState.dbintegration.test.js`
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`

**Interfaces:**
- Produces: `loadLocalProjectionState(churchId, provider) -> Promise<{ individuals, families, personLinks, familyLinks, gatheringMemberships, matchReviewState }>`.
- Produces dependency-injectable `createLocalProjectionStateLoader(deps)` for unit tests.

- [ ] **Step 1: Write failing church-isolation tests**

Seed two churches with the same provider external IDs and different local IDs. Assert the loader returns only the requested church and normalizes DTOs exactly as the current orchestrator does.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/localProjectionState.dbintegration.test.js services/peopleSync/orchestrator.test.js
```

Expected: FAIL because the loader does not exist.

- [ ] **Step 3: Extract the existing reads without changing behavior**

Move `defaultListLocalIndividuals`, `defaultListLocalFamilies`, `defaultListGatheringMemberships`, and the coordinated link/review-state load behind:

```js
async function loadLocalProjectionState(churchId, provider) {
  const [individuals, families, personLinks, familyLinks, gatheringMemberships, matchReviewState] =
    await Promise.all([
      listLocalIndividuals(churchId),
      listLocalFamilies(churchId),
      linkRepository.listPersonLinks(churchId, provider),
      linkRepository.listFamilyLinks(churchId, provider),
      listGatheringMemberships(churchId),
      matchReviewRepository.listMatchReviewState(churchId, provider),
    ]);
  return { individuals, families, personLinks, familyLinks, gatheringMemberships, matchReviewState };
}
```

Refactor `peopleSync/orchestrator.js` to consume this loader through `defaultDeps.loadLocalProjectionState`; delete its duplicate query functions.

- [ ] **Step 4: Run tests**

Run the Step 2 command.

Expected: PASS with existing orchestrator behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/services/peopleSync/localProjectionState.js server/services/peopleSync/localProjectionState.dbintegration.test.js server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js
git commit -m "refactor(sync): share local projection state"
```

---

### Task 5: One-time import preview and apply orchestrator

**Files:**
- Create: `server/services/peopleImport/orchestrator.js`
- Create: `server/services/peopleImport/orchestrator.test.js`
- Create: `server/services/peopleImport/orchestrator.dbintegration.test.js`
- Modify: `server/services/peopleSync/reviewContext.js`
- Modify: `server/services/peopleSync/reviewContext.test.js`

**Interfaces:**
- Produces: `previewImport({ churchId, provider, selection, signal? }) -> PeopleImportReview`.
- Produces: `applyImport({ churchId, provider, selection, reviewToken, selections, userId }) -> PeopleSyncApplyResult`.
- `selection`: `{ kind: 'all' } | { kind: SourceKind, externalId: string }`.
- `PeopleImportReview` reuses `PeopleSyncReview` fields and adds `operationKind: 'people_import'` and `selection`.

- [ ] **Step 1: Write failing orchestration unit tests**

Cover the exact pipeline order and failure boundaries:

```js
test('preview imports without reading or creating batches', async () => {
  const review = await previewImport(input, deps({
    listBatches: () => { throw new Error('must not read batches'); },
  }));
  assert.equal(review.operationKind, 'people_import');
  assert.equal(review.plan.operationKind, 'people_import');
  assert.equal(review.plan.authoritative, false);
});
```

Also cover disconnected/invalid connection before run creation, incomplete snapshot after run creation (failed audit), source selection mismatch, authority-forced visitor plan, token operation substitution, changed authority/local identity/provider snapshot, replay, and no source-health mutation.

- [ ] **Step 2: Run unit tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleImport/orchestrator.test.js services/peopleSync/reviewContext.test.js
```

Expected: FAIL because import orchestration and import review context are absent.

- [ ] **Step 3: Implement preview**

Preview must:

```js
const connection = await deps.getConnection(churchId, provider);
const credentials = await deps.getCredentials(churchId, provider);
const authorityState = await deps.getAuthority(churchId);
const run = await deps.startRun({ churchId, provider, batchId: null, trigger: 'people_import', fetchMode: 'full' });
const snapshot = await adapter.fetchImportSnapshot({ churchId, credentials, selection, signal });
const local = await deps.loadLocalProjectionState(churchId, provider);
const externalPeople = [...snapshot.people, ...snapshot.contextPeople];
const sourceExternalIds = new Set(snapshot.memberExternalIds.map(String));
const matched = deps.matchPeople({
  externalPeople,
  localPeople: local.individuals,
  existingLinks: local.personLinks,
  excludedPairs: new Set((local.matchReviewState.exclusions || []).map((entry) =>
    `${String(entry.externalPersonId)}\u0000${Number(entry.individualId)}`)),
  heldExternalIds: new Set((local.matchReviewState.holds || []).map((entry) =>
    String(entry.externalPersonId))),
  externalFamilyMembers: groupMembersByFamily(externalPeople),
  localFamilyMembers: groupMembersByFamily(local.individuals),
});
const matcher = memberOnlyMatcherResult(matched, sourceExternalIds);
const plan = deps.computePeopleImportPlan({
  provider, authorityProvider: authorityState.active,
  externalPeople: snapshot.people, externalFamilies: snapshot.families,
  householdPeople: externalPeople, memberExternalIds: snapshot.memberExternalIds,
  localPeople: local.individuals, localFamilies: local.families,
  matcher, personLinks: local.personLinks, familyLinks: local.familyLinks,
  snapshot: { fetchedAt: snapshot.fetchedAt, mode: 'full', complete: true },
});
plan.reviewContext = deps.buildReviewContext({
  plan, externalPeople, localPeople: local.individuals, localFamilies: local.families,
  basePersonLinks: local.personLinks, projectedPersonLinks: local.personLinks,
  baseExclusions: local.matchReviewState.exclusions || [],
  projectedExclusions: local.matchReviewState.exclusions || [],
  baseHolds: local.matchReviewState.holds || [],
  projectedHolds: local.matchReviewState.holds || [],
  sourceExternalIds, linkCorrections: [], batches: [], eligibleByBatch: new Map(),
});
plan.sourceContext = { operationKind: 'people_import', selection, connectionGeneration, snapshotDigest };
```

Define and unit-test local pure `groupMembersByFamily` and `memberOnlyMatcherResult` helpers so household-only context can corroborate a selected member without itself becoming an import identity. Validate the snapshot identity and completeness using extracted pure validators from `peopleSync/orchestrator.js`; do not update batch source health. Sign with `operationKind: 'people_import'`, finish the preview run as `review_required`, and return sanitized people/review data.

- [ ] **Step 4: Implement apply**

Apply repeats the complete pipeline and verifies the token against the fresh digest. It calls `applyPeopleSyncPlan` with:

```js
{
  activateAuthority: false,
  sourcePromotion: null,
  sourceExpectations: null,
  authorityExpectation: { active: authorityState.active, pending: authorityState.pending },
  connectionExpectation,
  requireConnection: true,
  allowedMutationBuckets: new Set([
    'linkPeople', 'linkFamilies', 'addPeople', 'addFamilies',
    'ambiguousPeople', 'familyConflicts', 'skipped',
  ]),
  reviewedApply: {
    operationKind: 'people_import', reviewToken, planDigest,
    batchId: null, verifyReviewToken: deps.verifyReviewToken,
  },
}
```

Do not call presence accounting, source promotion, provider extras, review notifications, or authority activation.

- [ ] **Step 5: Add database integration coverage**

Prove one transaction creates families, people, and dormant links; a later repeat links/recognizes without duplicating; authority forces visitors; cross-church tokens fail; a stale local record or changed authority rolls back; and the import creates zero batch/gathering/source rows. Query every affected table directly.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd server
node --test services/peopleImport/orchestrator.test.js services/peopleImport/orchestrator.dbintegration.test.js services/peopleSync/reviewContext.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/peopleImport/orchestrator.js server/services/peopleImport/orchestrator.test.js server/services/peopleImport/orchestrator.dbintegration.test.js server/services/peopleSync/reviewContext.js server/services/peopleSync/reviewContext.test.js
git commit -m "feat(import): preview and apply provider people imports"
```

---

### Task 6: Admin-only import routes

**Files:**
- Create: `server/routes/people-imports.js`
- Create: `server/routes/people-imports.test.js`
- Modify: `server/index.js`
- Modify: `server/routes/integrations/routeTimeout.js` only if its helper must be exported for the new router

**Interfaces:**
- `GET /api/people-imports/:provider/sources` -> `{ success: true, sources, allOption }`.
- `POST /api/people-imports/:provider/preview` body `{ selection }` -> `PeopleImportReview`.
- `POST /api/people-imports/:provider/apply` body `{ selection, reviewToken, selections }` -> `PeopleSyncApplyResult`.

- [ ] **Step 1: Write failing route tests**

Build the router with injected dependencies and assert authentication, admin role, church ID forwarding, provider/selection allowlists, 120-second timeout use, body-size safety, curated provider errors, stale/expired status codes, and no raw credential/internal error leakage.

```js
assert.equal(previewCalls[0].churchId, 'church-a');
assert.equal(previewCalls[0].provider, 'planning_center');
assert.deepEqual(previewCalls[0].selection, {
  kind: 'planning_center_list', externalId: '42',
});
assert.ok(previewCalls[0].signal instanceof AbortSignal);
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test routes/people-imports.test.js
```

Expected: FAIL because the router is absent.

- [ ] **Step 3: Implement and mount the router**

Export `createPeopleImportsRouter(overrides = {})` and a production router. Apply `verifyToken`, `ensureChurchIsolation`, and `requireRole(['admin'])` inside this top-level router. Add `'people-imports'` to `server/index.js`'s route list so it mounts at `/api/people-imports`.

Selection validation accepts exactly:

```js
{ kind: 'all' }
{ kind: 'planning_center_list', externalId: nonEmptyString }
{ kind: 'elvanto_category', externalId: nonEmptyString }
{ kind: 'elvanto_group', externalId: nonEmptyString }
```

and verifies kind/provider compatibility before provider work.

- [ ] **Step 4: Run route and bootstrap smoke tests**

Run:

```bash
cd server
node --test routes/people-imports.test.js
node --check index.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/people-imports.js server/routes/people-imports.test.js server/index.js server/routes/integrations/routeTimeout.js
git commit -m "feat(import): expose reviewed people import API"
```

---

### Task 7: Client contracts and import-aware review surface

**Files:**
- Create: `client/src/components/peopleImport/types.ts`
- Create: `client/src/components/peopleImport/importReviewModel.test.ts`
- Modify: `client/src/services/api.ts`
- Modify: `client/src/components/peopleSync/types.ts`
- Modify: `client/src/components/peopleSync/SyncReview.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.test.tsx`
- Modify: `client/src/components/peopleSync/SyncPlanSections.tsx`
- Modify: `client/src/components/peopleSync/SyncPlanSections.test.tsx`

**Interfaces:**
- Produces `peopleImportAPI.listSources(provider)`, `.preview(provider, selection)`, and `.apply(provider, request)`.
- Produces `ImportSelection`, `PeopleImportReview`, and `PeopleImportApplyRequest` types.
- Changes `SyncReviewProps` to require `operationKind: 'people_sync' | 'authority_switch' | 'people_import'`.

- [ ] **Step 1: Write failing client contract/review tests**

Assert import copy says “Import people”/“Apply import,” never “sync,” “archive,” “managed fields,” or “correction.” Assert the component rejects/render-errors a malformed import review containing any forbidden mutation bucket.

```tsx
render(<SyncReview operationKind="people_import" provider="elvanto" review={review} {...handlers} />);
expect(screen.getByRole('button', { name: 'Apply import' })).toBeInTheDocument();
expect(screen.queryByText(/archive/i)).not.toBeInTheDocument();
```

- [ ] **Step 2: Run focused client tests and confirm failure**

Run:

```bash
cd client
npm test -- src/components/peopleSync/SyncReview.test.tsx src/components/peopleSync/SyncPlanSections.test.tsx src/components/peopleImport/importReviewModel.test.ts
```

Expected: FAIL because import types/API/operation copy do not exist.

- [ ] **Step 3: Add typed API methods**

Implement exact Axios methods with the existing 120-second preview/apply timeout:

```ts
export const peopleImportAPI = {
  listSources: (provider: SyncProvider) => api.get<PeopleImportSourcesResponse>(`/people-imports/${provider}/sources`),
  preview: (provider: SyncProvider, selection: ImportSelection) =>
    api.post<PeopleImportReview>(`/people-imports/${provider}/preview`, { selection }, { timeout: 120000 }),
  apply: (provider: SyncProvider, request: PeopleImportApplyRequest) =>
    api.post<PeopleSyncApplyResult>(`/people-imports/${provider}/apply`, request, { timeout: 120000 }),
};
```

- [ ] **Step 4: Make shared review primitives operation-aware**

For import, hide established-link correction controls and every sync/lifecycle section, use import labels, and fail closed if the server returns forbidden non-empty buckets. Existing batch callers pass `operationKind="people_sync"`; authority callers pass `operationKind="authority_switch"` with no behavioral change.

- [ ] **Step 5: Run focused tests and TypeScript build**

Run:

```bash
cd client
npm test -- src/components/peopleSync/SyncReview.test.tsx src/components/peopleSync/SyncPlanSections.test.tsx src/components/peopleImport/importReviewModel.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/peopleImport/types.ts client/src/components/peopleImport/importReviewModel.test.ts client/src/services/api.ts client/src/components/peopleSync/types.ts client/src/components/peopleSync/SyncReview.tsx client/src/components/peopleSync/SyncReview.test.tsx client/src/components/peopleSync/SyncPlanSections.tsx client/src/components/peopleSync/SyncPlanSections.test.tsx
git commit -m "feat(import): add typed import review surface"
```

---

### Task 8: People import dialog workflow

**Files:**
- Create: `client/src/components/peopleImport/PeopleImportDialog.tsx`
- Create: `client/src/components/peopleImport/PeopleImportDialog.test.tsx`

**Interfaces:**
- Produces `PeopleImportDialog({ isOpen, onClose, onApplied })`.
- `onApplied(result: PeopleSyncApplyResult): void | Promise<void>` refreshes People-page data after commit.

- [ ] **Step 1: Write failing workflow tests**

Cover provider choice, disconnected-source response, loading sources, List/Category/Group/all choice, preview progress, review render, apply, stale refresh, close-before-preview, late-response fencing, double-apply prevention, and committed-but-refresh-failed copy.

```tsx
fireEvent.click(screen.getByRole('button', { name: 'Planning Center' }));
fireEvent.click(await screen.findByRole('radio', { name: 'Everyone' }));
fireEvent.click(screen.getByRole('button', { name: 'Review import' }));
await screen.findByRole('button', { name: 'Apply import' });
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
cd client
npm test -- src/components/peopleImport/PeopleImportDialog.test.tsx
```

Expected: FAIL because the dialog does not exist.

- [ ] **Step 3: Implement the state machine**

Use explicit states:

```ts
type ImportState = 'provider' | 'sources' | 'previewing' | 'review' | 'applying' | 'applied';
```

Fence list/preview/apply requests with a monotonically increasing generation ref. Do not close while apply is in flight. On stale/expired apply, retain the selected source and return to a refreshable review state. After successful apply, never expose the old apply action even if `onApplied` fails.

- [ ] **Step 4: Run dialog tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/peopleImport/PeopleImportDialog.tsx client/src/components/peopleImport/PeopleImportDialog.test.tsx
git commit -m "feat(import): build provider import dialog"
```

---

### Task 9: Place import on the People page

**Files:**
- Modify: `client/src/pages/PeoplePage.tsx`
- Create: `client/src/pages/PeoplePage.import.test.tsx`

**Interfaces:**
- Consumes: `PeopleImportDialog` from Task 8.
- Produces: admin-only **Import people** action available whether authority is `none` or active.

- [ ] **Step 1: Write failing People-page tests**

Assert administrators see **Import people** with an empty or populated roster and with any authority. Coordinators/attendance takers do not. Applying refreshes people and families exactly once and shows success. The existing floating manual-add button retains its current authority restriction.

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
cd client
npm test -- src/pages/PeoplePage.import.test.tsx
```

Expected: FAIL because no import entry exists.

- [ ] **Step 3: Add the header action and dialog**

Add an admin-only secondary action in the Manage People header, not inside the authority-gated floating add button:

```tsx
{isAdmin && (
  <button type="button" onClick={() => setShowPeopleImport(true)}>
    Import people
  </button>
)}
```

On applied, call `loadPeople()` and `loadFamilies()` and show “People imported successfully.”

- [ ] **Step 4: Run focused page tests**

Run:

```bash
cd client
npm test -- src/pages/PeoplePage.import.test.tsx src/pages/PeoplePage.externalSource.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/PeoplePage.tsx client/src/pages/PeoplePage.import.test.tsx
git commit -m "feat(import): add provider import to People page"
```

---

### Task 10: Replace onboarding batch imports with one-time import

**Files:**
- Modify: `client/src/pages/OnboardingPage.tsx`
- Modify: `client/src/pages/OnboardingPage.integrations.test.tsx`
- Modify: `client/src/components/elvanto/ElvantoOnboarding.tsx`
- Modify: `client/src/components/elvanto/ElvantoOnboarding.test.tsx`
- Create: `client/src/components/peopleImport/OnboardingPeopleImport.tsx`
- Create: `client/src/components/peopleImport/OnboardingPeopleImport.test.tsx`

**Interfaces:**
- Produces: `OnboardingPeopleImport({ provider, onComplete, onSkip })` using the Task 8 source/review workflow without sync-batch creation.
- Removes onboarding calls to `createPlanningCenterSyncBatch`, `elvantoSyncAPI.createBatch`, per-batch apply, and authority preview/apply.

- [ ] **Step 1: Rewrite onboarding tests first**

Assert both providers connect, select List/Category/Group/all, preview one-time import, apply, and continue without creating a batch or showing a source-of-truth review. Skip remains available. Failed/stale apply stays on import review.

- [ ] **Step 2: Run focused onboarding tests and confirm failure**

Run:

```bash
cd client
npm test -- src/components/peopleImport/OnboardingPeopleImport.test.tsx src/pages/OnboardingPage.integrations.test.tsx src/components/elvanto/ElvantoOnboarding.test.tsx
```

Expected: FAIL because onboarding still creates sync batches.

- [ ] **Step 3: Implement the shared onboarding wrapper**

Reuse the same source selection/review API and components, but render inline rather than as a modal. On successful apply, advance to the existing gathering/check-in onboarding step. Do not offer authority or schedule configuration during one-time import.

- [ ] **Step 4: Remove retired onboarding batch-review state**

Delete `firstBatch`, `pco-review`, `elvanto-batch`, `elvanto-review`, and `elvanto-authority` transitions that exist only for the old import-via-batch workflow. Keep integration connection and gathering/check-in import paths intact.

- [ ] **Step 5: Run onboarding and build verification**

Run:

```bash
cd client
npm test -- src/components/peopleImport/OnboardingPeopleImport.test.tsx src/pages/OnboardingPage.integrations.test.tsx src/components/elvanto/ElvantoOnboarding.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/OnboardingPage.tsx client/src/pages/OnboardingPage.integrations.test.tsx client/src/components/elvanto/ElvantoOnboarding.tsx client/src/components/elvanto/ElvantoOnboarding.test.tsx client/src/components/peopleImport/OnboardingPeopleImport.tsx client/src/components/peopleImport/OnboardingPeopleImport.test.tsx
git commit -m "feat(import): use one-time import during onboarding"
```

---

### Task 11: End-to-end import regression verification

**Files:**
- Modify only files required to correct failures caused by Tasks 1–10; do not broaden scope.

**Interfaces:**
- Verifies the complete one-time import deliverable before authoritative-batch semantics are changed by the second implementation plan.

- [ ] **Step 1: Run all server people-import and affected sync tests**

```bash
cd server
node --test \
  services/peopleImport/*.test.js \
  services/peopleSync/providerRegistry.test.js \
  services/peopleSync/pcoAdapter.test.js \
  services/peopleSync/plan.test.js \
  services/peopleSync/planDigest.test.js \
  services/peopleSync/apply.test.js \
  services/peopleSync/orchestrator.test.js \
  services/planningCenter/sourceAdapter.test.js \
  services/elvanto/adapter.test.js \
  services/elvanto/sourceAdapter.test.js \
  routes/people-imports.test.js
```

Expected: PASS.

- [ ] **Step 2: Run database integration coverage**

```bash
cd server
node --test \
  config/database.test.js \
  services/peopleImport/orchestrator.dbintegration.test.js \
  services/peopleSync/localProjectionState.dbintegration.test.js \
  services/peopleSync/runRepository.dbintegration.test.js
```

Expected: PASS with no cross-church or partial-write failures.

- [ ] **Step 3: Run affected client tests and production build**

```bash
cd client
npm test -- \
  src/components/peopleImport \
  src/components/peopleSync/SyncReview.test.tsx \
  src/components/peopleSync/SyncPlanSections.test.tsx \
  src/pages/PeoplePage.import.test.tsx \
  src/pages/PeoplePage.externalSource.test.tsx \
  src/pages/OnboardingPage.integrations.test.tsx \
  src/components/elvanto/ElvantoOnboarding.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 4: Inspect the final diff for forbidden coupling**

Run:

```bash
git diff --check HEAD~10..HEAD
rg -n "createBatch|sync-batches|people-authority" client/src/components/peopleImport client/src/pages/OnboardingPage.tsx client/src/components/elvanto/ElvantoOnboarding.tsx
```

Expected: `git diff --check` is clean; the import components contain no batch/authority mutation call. Any remaining onboarding matches are gathering/check-in features, not people import.
