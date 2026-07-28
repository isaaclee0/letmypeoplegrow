# Provider-Neutral Boolean Sync Filter Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Planning Center and Elvanto sync batches the same bracketed AND/OR/NOT filter builder, cached match and overlap counts, strict reviewed draft promotion, and safe version-1 upgrades.

**Architecture:** Provider adapters project normalized people into a small common facts model. A pure version-2 evaluator is the only Boolean authority; a church/provider-scoped in-memory cache supplies previews without provider calls. Active filters remain immutable during editing, drafts are promoted inside the same database transaction as reviewed reconciliation, and version-1 batches keep their existing evaluators until explicitly upgraded.

**Tech Stack:** Node.js 22, Express 5, SQLite via `better-sqlite3`, `node:test`, React 19, TypeScript 6, Axios, Tailwind CSS, Testing Library, Vitest.

## Global Constraints

- Preserve church isolation on every cache key, query, mutation, and route.
- Both providers use the exact version-2 shape `{ branches: [{ groups: [{ dimensionId, mode, values }] }], exclusions: [{ dimensionId, values }] }`.
- Groups are AND-connected inside a branch; branches are OR-connected; exclusions veto every branch.
- Single-valued dimensions accept `any` only. Multi-valued dimensions default to `all` when first added.
- No branches and no exclusions matches nobody. Exclusions without branches form a valid NOT-only filter.
- Limit each filter to 20 branches, 50 groups, and 500 selected values.
- `$not_set` is the reserved missing-value ID; an `all` group cannot combine it with another value.
- Preview requests never call Planning Center or Elvanto. Only explicit refresh and existing full review/reconciliation paths may fetch people.
- A complete facts snapshot is fresh for 10 minutes, usable as stale for 24 hours, and never contains names, contact details, addresses, or family details.
- Saving a changed filter writes a draft only. It cannot change sync eligibility until a full reviewed reconciliation promotes it atomically.
- An enabled authoritative provider with a normal version-2 edit draft cannot run unattended sync. A version-1-to-version-2 migration draft does not pause the version-1 schedule.
- Version-1 batches continue running unchanged until an explicit reviewed upgrade.
- Upgrade compatibility compares exact matched external-person ID sets, not counts.
- Preserve the existing additive-only database migration convention and the legacy PCO table required for gathering provenance.
- Do not modify or stage `client/public/sw.js`; it is an unrelated pre-existing change.

## File and Interface Map

### New server modules

- `server/services/peopleSync/filterEngine.js` — canonical schema-v2 normalization, validation, evaluation, selected-dimension discovery, and deterministic summaries.
- `server/services/peopleSync/filterFactsCache.js` — bounded, TTL-aware, church/provider-scoped complete-snapshot cache.
- `server/services/peopleSync/filterSnapshot.js` — provider fact projection, canonical dimension construction, population gating, and complete snapshot capture.
- `server/services/peopleSync/filterPreview.js` — batch count, pairwise overlap, enabled-union, warning, and coverage calculation with no network access.
- `server/services/peopleSync/filterUpgrade.js` — deterministic v1 conversion, legacy fact evaluation, exact-set comparison, and signed upgrade tokens.
- `server/routes/integrations/filterBuilder.js` — provider-neutral metadata, refresh, preview, draft, and upgrade endpoints.

### New client modules

- `client/src/components/peopleSync/FilterBuilder.tsx` — shared branch/bracket/value editor.
- `client/src/components/peopleSync/FilterPreviewSummary.tsx` — debounced count, freshness, overlap, warnings, and refresh UI.
- `client/src/components/peopleSync/FilterUpgradePanel.tsx` — version-1 comparison and individual/bulk upgrade UI.

### Existing modules with changed responsibilities

- `server/config/{schema,database}.js` — additive draft/revision columns and existing-database migration.
- `server/services/peopleSync/batchRepository.js` — active/draft DTOs, draft persistence, and connection-aware atomic promotion.
- `server/services/peopleSync/{pcoAdapter,providerRegistry,orchestrator,scheduler,apply,planDigest}.js` — v2 adapter contract, shared eligibility, cache capture, strict draft blocking, promotion, and token binding.
- `server/services/elvanto/{adapter,filter}.js` and `server/services/planningCenter/eligibility.js` — retain v1 behavior and delegate schema version 2 to the common engine.
- `server/routes/integrations.js` and provider routers — mount shared filter routes, create v2 draft batches, preserve stale-client v1 bodies, and clear caches on disconnect/settings changes.
- `client/src/components/peopleSync/types.ts` and `client/src/services/api.ts` — exact shared contracts and API methods.
- `client/src/components/{planningCenter/PlanningCenterBatchEditor,elvanto/ElvantoBatchEditor}.tsx` — embed the same filter area while retaining provider-specific non-filter controls.
- Integration panels and onboarding components — display draft/review state and version-1 upgrade actions.

---

### Task 1: Add active/draft filter persistence and revision guards

**Files:**
- Modify: `server/config/schema.js`
- Modify: `server/config/database.js`
- Modify: `server/config/peopleSyncSchema.dbintegration.test.js`
- Modify: `server/config/database.test.js`
- Modify: `server/services/peopleSync/batchRepository.js`
- Modify: `server/services/peopleSync/batchRepository.dbintegration.test.js`

**Interfaces:**
- Produces: `PeopleSyncBatch` server DTO fields `filterRevision`, `draftFilterSchemaVersion`, `draftFilterConfig`, `draftFilterBaseRevision`, `draftFilterUpdatedAt`, and `needsFilterReview`.
- Produces: `saveFilterDraft(input)`, `discardFilterDraft(churchId, provider, batchId)`, and `promoteFilterDraftWithConnection(conn, input)`.
- Produces: `createBatch({ ..., initialDraftFilterConfig })`, which stores an active schema-v2 empty filter plus the proposed draft in one insert.

- [ ] **Step 1: Write failing schema migration tests**

Add assertions that a fresh and an upgraded church database contain exactly these columns and defaults:

```js
const columns = await Database.query('PRAGMA table_info(people_sync_batches)');
const byName = new Map(columns.map((column) => [column.name, column]));
assert.equal(byName.get('filter_revision').dflt_value, '1');
assert.ok(byName.has('draft_filter_schema_version'));
assert.ok(byName.has('draft_filter_config'));
assert.ok(byName.has('draft_filter_base_revision'));
assert.ok(byName.has('draft_filter_updated_at'));
```

Also seed an existing v1 row before migration and assert its active filter and schedule are unchanged and all draft columns remain `NULL`.

- [ ] **Step 2: Run the schema tests and verify failure**

Run: `cd server && node --test config/peopleSyncSchema.dbintegration.test.js config/database.test.js`

Expected: FAIL because the draft and revision columns do not exist.

- [ ] **Step 3: Add the columns to fresh and existing databases**

Add to `people_sync_batches`:

```sql
filter_revision INTEGER NOT NULL DEFAULT 1,
draft_filter_schema_version INTEGER,
draft_filter_config TEXT,
draft_filter_base_revision INTEGER,
draft_filter_updated_at TEXT,
```

In `ensureProviderNeutralSyncSchema(db)`, inspect `PRAGMA table_info(people_sync_batches)` and add each missing column individually. Do not rewrite existing `filter_schema_version`, `filter_config`, schedules, or legacy IDs.

- [ ] **Step 4: Write failing repository lifecycle tests**

Cover these exact cases:

```js
assert.equal(created.filterSchemaVersion, 2);
assert.deepEqual(created.filterConfig, { branches: [], exclusions: [] });
assert.deepEqual(created.draftFilterConfig, proposed);
assert.equal(created.draftFilterBaseRevision, 1);
assert.equal(created.needsFilterReview, true);
```

Then assert draft save does not change `filterConfig`; discard clears only draft columns; promotion rejects an expected base revision mismatch; successful promotion increments `filterRevision`, copies draft version/config into active columns, and clears every draft column.

- [ ] **Step 5: Implement repository draft methods**

Use these signatures:

```js
async function saveFilterDraft({ churchId, provider, batchId, schemaVersion, filterConfig })
async function discardFilterDraft(churchId, provider, batchId)
async function promoteFilterDraftWithConnection(conn, {
  churchId, provider, batchId, expectedBaseRevision, expectedDraftDigest,
})
```

`promoteFilterDraftWithConnection` must select the row through `conn`, hash canonical draft JSON, compare both guards, then issue one guarded update:

```sql
UPDATE people_sync_batches
SET filter_schema_version = draft_filter_schema_version,
    filter_config = draft_filter_config,
    filter_revision = filter_revision + 1,
    draft_filter_schema_version = NULL,
    draft_filter_config = NULL,
    draft_filter_base_revision = NULL,
    draft_filter_updated_at = NULL,
    updated_at = datetime('now')
WHERE id = ? AND church_id = ? AND provider = ? AND filter_revision = ?
```

Throw `SYNC_FILTER_DRAFT_STALE` when the guarded row or digest differs.

- [ ] **Step 6: Run repository and schema tests**

Run: `cd server && node --test config/peopleSyncSchema.dbintegration.test.js config/database.test.js services/peopleSync/batchRepository.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/config/schema.js server/config/database.js server/config/peopleSyncSchema.dbintegration.test.js server/config/database.test.js server/services/peopleSync/batchRepository.js server/services/peopleSync/batchRepository.dbintegration.test.js
git commit -m "feat(sync): persist reviewed filter drafts"
```

### Task 2: Implement the canonical Boolean filter engine

**Files:**
- Create: `server/services/peopleSync/filterEngine.js`
- Create: `server/services/peopleSync/filterEngine.test.js`

**Interfaces:**
- Produces: `EMPTY_V2_FILTER`, `validateFilterV2(config, metadata, options)`, `evaluateFilterV2(facts, config)`, `selectedDimensionIds(config)`, `selectedPairs(config)`, `summarizeFilter(config, metadata)`.
- Consumes: canonical `FilterMetadata` and `PersonFilterFacts` shapes from the design.

- [ ] **Step 1: Write literal truth-table tests**

Define facts for four people and assert all of these outcomes explicitly:

```js
const filter = {
  branches: [
    { groups: [
      { dimensionId: 'status', mode: 'any', values: ['active'] },
      { dimensionId: 'groups', mode: 'all', values: ['youth', 'music'] },
    ] },
    { groups: [{ dimensionId: 'category', mode: 'any', values: ['member'] }] },
  ],
  exclusions: [{ dimensionId: 'groups', values: ['blocked', 'suspended'] }],
};
assert.equal(evaluateFilterV2(activeYouthMusician, filter), true);
assert.equal(evaluateFilterV2(categoryMember, filter), true);
assert.equal(evaluateFilterV2(activeYouthOnly, filter), false);
assert.equal(evaluateFilterV2(blockedCategoryMember, filter), false);
```

Add separate assertions for `$not_set`, multiple exclusions, NOT-only, empty filter, `any`, `all`, and order-independent summaries.

- [ ] **Step 2: Write strict validation tests**

Assert specific validation codes for: unknown root keys, 21 branches, 51 groups, 501 values, empty stored branch/group, repeated dimension within a branch, repeated exclusion dimension, duplicate values, single-valued `all`, `$not_set` plus another value in `all`, include/exclude conflict, unknown dimension/value, and malformed non-string values. Assert an unresolved pair is accepted only when supplied in `options.allowedUnresolvedPairs`.

- [ ] **Step 3: Run the test and verify failure**

Run: `cd server && node --test services/peopleSync/filterEngine.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement normalization, validation, and evaluation**

Export this stable contract:

```js
const EMPTY_V2_FILTER = Object.freeze({ branches: [], exclusions: [] });

function validateFilterV2(config, metadata, { allowedUnresolvedPairs = new Set() } = {}) {
  return { ok, value, errors, unresolved };
}

function evaluateFilterV2(facts, config) {
  const excluded = config.exclusions.some((group) =>
    group.values.some((value) => factHas(facts, group.dimensionId, value)));
  const positive = config.branches.length > 0
    ? config.branches.some((branch) => branch.groups.every((group) => matchesGroup(facts, group)))
    : config.exclusions.length > 0;
  return positive && !excluded;
}
```

Canonicalize branch, group, exclusion, and value ordering before returning `value` so digests and summaries do not depend on input order. Escape a real provider value equal to `$not_set` as `$$not_set` at projection time; reserve only the exact internal literal.

- [ ] **Step 5: Run the engine tests**

Run: `cd server && node --test services/peopleSync/filterEngine.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/filterEngine.js server/services/peopleSync/filterEngine.test.js
git commit -m "feat(sync): add boolean filter engine"
```

### Task 3: Project provider people into common facts and dimensions

**Files:**
- Create: `server/services/peopleSync/filterSnapshot.js`
- Create: `server/services/peopleSync/filterSnapshot.test.js`
- Modify: `server/services/peopleSync/pcoAdapter.js`
- Modify: `server/services/peopleSync/pcoAdapter.test.js`
- Modify: `server/services/elvanto/adapter.js`
- Modify: `server/services/elvanto/adapter.test.js`
- Modify: `server/services/peopleSync/providerRegistry.js`
- Modify: `server/services/peopleSync/providerRegistry.test.js`

**Interfaces:**
- Produces adapter methods `toFilterFacts(person, coveredDimensionIds)`, `buildFilterDimensions({ facts, providerMetadata })`, and `isInFilterPopulation(person, settings)`.
- Produces `captureFilterSnapshotInput({ provider, snapshot, providerMetadata, settings, coveredDimensionIds, adapter })` returning facts, dimensions, coverage, and `populationGateDigest` without PII.

- [ ] **Step 1: Write PCO mapping tests**

Assert exact IDs and cardinality:

```js
assert.deepEqual(adapter.toFilterFacts(person, new Set(['membership', 'custom_field:12'])), {
  externalPersonId: 'p1',
  dimensions: { membership: ['Member'], 'custom_field:12': ['Choir', 'Youth'] },
});
assert.equal(dimensions.find((d) => d.id === 'membership').cardinality, 'single');
assert.equal(dimensions.find((d) => d.id === 'custom_field:12').cardinality, 'multi');
```

Assert archived PCO people fail `isInFilterPopulation` and no projected object contains `firstName`, `lastName`, `email`, `phone`, `address`, `familyId`, or raw payload fields.

- [ ] **Step 2: Write Elvanto mapping tests**

Use IDs `status`, `category`, `groups`, `demographics`, `departments`, `service_types`, `locations`, and `custom_field:<id>`. Assert status/category are single; group/demographic/department/service/location are multi; Elvanto `select_single` custom fields are single and `select_multi` fields are multi; `contact` is excluded only when `settings.includeContacts === false`; archived/deceased always fail the population gate.

Assert a covered but absent field omits the dimension key and therefore becomes `$not_set`, while a dimension absent from `coveredDimensionIds` is reported as uncovered rather than unset.

Assert terminal provider states are never emitted as selectable positive metadata values. Active/contact status values remain available only when they survive the current population gate.

- [ ] **Step 3: Run the adapter tests and verify failure**

Run: `cd server && node --test services/peopleSync/filterSnapshot.test.js services/peopleSync/pcoAdapter.test.js services/elvanto/adapter.test.js services/peopleSync/providerRegistry.test.js`

Expected: FAIL because the new adapter methods are absent.

- [ ] **Step 4: Extend and validate the adapter contract**

Add the three methods to `providerRegistry.js`'s required/allowed keys. Implement exact provider mappings in each adapter and keep v1 `validateFilter`/`isEligible` unchanged.

`captureFilterSnapshotInput` must first apply `isInFilterPopulation`, then project only external ID plus requested dimension values. Compute `populationGateDigest` from provider and the settings that affect the gate; do not retain the normalized people array.

- [ ] **Step 5: Run all mapping tests**

Run: `cd server && node --test services/peopleSync/filterSnapshot.test.js services/peopleSync/pcoAdapter.test.js services/elvanto/adapter.test.js services/peopleSync/providerRegistry.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/filterSnapshot.js server/services/peopleSync/filterSnapshot.test.js server/services/peopleSync/pcoAdapter.js server/services/peopleSync/pcoAdapter.test.js server/services/elvanto/adapter.js server/services/elvanto/adapter.test.js server/services/peopleSync/providerRegistry.js server/services/peopleSync/providerRegistry.test.js
git commit -m "feat(sync): project provider filter facts"
```

### Task 4: Add the complete-snapshot facts cache

**Files:**
- Create: `server/services/peopleSync/filterFactsCache.js`
- Create: `server/services/peopleSync/filterFactsCache.test.js`
- Modify: `server/routes/integrations/peopleSync.js`
- Modify: `server/routes/integrations/peopleSync.test.js`
- Modify: `server/routes/integrations/elvanto.js`
- Modify: `server/routes/integrations/elvanto.test.js`
- Modify: `server/routes/integrations.js`
- Modify: `server/services/planningCenterSync.js`
- Modify: `server/services/planningCenterSync.test.js`

**Interfaces:**
- Produces: `putComplete(entry)`, `get(churchId, provider, options)`, `clear(churchId, provider)`, and `clearAll()`.
- Cache entry: `{ snapshotId, provider, churchId, capturedAt, freshUntil, expiresAt, coveredDimensionIds, dimensions, facts, populationGateDigest }`.

- [ ] **Step 1: Write cache behavior tests**

Use an injected clock and assert: incomplete/incremental puts throw; only the latest complete entry survives per church/provider; two churches never share entries; `fresh` flips at exactly 10 minutes; `get` returns stale through 24 hours and `null` at expiry; LRU eviction keeps no more than 200 church/provider entries; clear removes only the requested key.

- [ ] **Step 2: Run the cache test and verify failure**

Run: `cd server && node --test services/peopleSync/filterFactsCache.test.js`

Expected: FAIL because the cache does not exist.

- [ ] **Step 3: Implement cache identity and TTL behavior**

Set constants exactly:

```js
const FRESH_MS = 10 * 60 * 1000;
const RETAIN_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
```

Compute `snapshotId` as SHA-256 of canonical sorted `{ provider, coveredDimensionIds, facts }`; never include timestamps. Freeze a copied entry on write so callers cannot mutate cached facts.

Add `peekCachedPcoPeople(churchId)` to `planningCenterSync.js`. It may return the current complete in-process PCO people entry or `null`, but must never fetch or refresh. Canonical metadata may use this to populate the filter-facts cache when PCO's existing ten-minute people cache is already warm.

- [ ] **Step 4: Invalidate cache on state changes**

Clear the provider entry after successful PCO or Elvanto disconnect. In `PUT /people-sync/settings`, clear Elvanto when `elvantoIncludeContacts` changes because its cached population gate is no longer valid. Add route tests proving another church/provider cache survives.

- [ ] **Step 5: Run cache and route tests**

Run: `cd server && node --test services/peopleSync/filterFactsCache.test.js services/planningCenterSync.test.js routes/integrations/peopleSync.test.js routes/integrations/elvanto.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/filterFactsCache.js server/services/peopleSync/filterFactsCache.test.js server/services/planningCenterSync.js server/services/planningCenterSync.test.js server/routes/integrations/peopleSync.js server/routes/integrations/peopleSync.test.js server/routes/integrations/elvanto.js server/routes/integrations/elvanto.test.js server/routes/integrations.js
git commit -m "feat(sync): cache complete filter snapshots"
```

### Task 5: Calculate cached counts, overlaps, and enabled union

**Files:**
- Create: `server/services/peopleSync/filterPreview.js`
- Create: `server/services/peopleSync/filterPreview.test.js`
- Modify: `server/services/peopleSync/batchRepository.js`
- Modify: `server/services/peopleSync/batchRepository.dbintegration.test.js`

**Interfaces:**
- Produces: `previewFilter({ churchId, provider, batchId, proposed, cacheEntry, batches, metadata, populationGateDigest })`.
- Produces: `eligibleIdsForBatch(batch, cacheEntry, adapter, { evaluateLegacy })` supporting active schema 1 and schema 2.
- Returns: `{ matchCount, snapshot, overlaps, uniqueEnabledPopulationCount, missingDimensionIds, warnings }`.

- [ ] **Step 1: Write preview tests with zero provider dependencies**

Inject only cache facts, metadata, batches, and evaluators. Assert exact count, pairwise overlap, enabled union, and these replacement rules:

```js
assert.equal(existingEdit.uniqueEnabledPopulationCount, 4); // active batch replaced by draft
assert.equal(newEnabledProposal.uniqueEnabledPopulationCount, 5); // proposal added
assert.equal(newDisabledProposal.uniqueEnabledPopulationCount, 4); // proposal omitted
```

Assert mixed v1/v2 batches participate, differing `gatheringTypeId` and `defaultPeopleType` add overlap warnings, and the preview function has no `fetchSnapshot`, credentials, or HTTP collaborator.

- [ ] **Step 2: Add unavailable/stale/broad warning tests**

Assert `matchCount` and union are `null` when the cache is absent, expired, has a gate-digest mismatch, or lacks any selected dimension. Assert `missingDimensionIds` contains exact IDs and never returns a fabricated zero. Assert NOT-only and whole-population filters produce `BROAD_FILTER`.

- [ ] **Step 3: Run the preview tests and verify failure**

Run: `cd server && node --test services/peopleSync/filterPreview.test.js`

Expected: FAIL because the preview service does not exist.

- [ ] **Step 4: Implement mixed-schema evaluation and deterministic output**

For schema 2 call `evaluateFilterV2`. For schema 1 call the required injected `evaluateLegacy` collaborator. No production route calls this service until Task 7, after Task 6 supplies the real default. Sort overlaps by batch ID and warning codes alphabetically.

Add repository `listEnabledBatches(churchId, provider)` as a church/provider-filtered query rather than filtering another church's rows in memory.

- [ ] **Step 5: Run preview and repository tests**

Run: `cd server && node --test services/peopleSync/filterPreview.test.js services/peopleSync/batchRepository.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/filterPreview.js server/services/peopleSync/filterPreview.test.js server/services/peopleSync/batchRepository.js server/services/peopleSync/batchRepository.dbintegration.test.js
git commit -m "feat(sync): preview batch counts and overlap"
```

### Task 6: Convert and securely upgrade version-1 filters

**Files:**
- Create: `server/services/peopleSync/filterUpgrade.js`
- Create: `server/services/peopleSync/filterUpgrade.test.js`
- Modify: `server/services/peopleSync/planDigest.js`
- Modify: `server/services/peopleSync/planDigest.test.js`
- Modify: `server/services/peopleSync/filterPreview.js`
- Modify: `server/services/peopleSync/filterPreview.test.js`
- Modify: `server/services/peopleSync/batchRepository.js`
- Modify: `server/services/peopleSync/batchRepository.dbintegration.test.js`

**Interfaces:**
- Produces: `convertV1Filter(provider, config)`, `evaluateLegacyFacts(provider, facts, config)`, `compareUpgradeSets(args)`, `createUpgradeToken(context)`, `verifyUpgradeToken(token, expected)`, and `applyCompatibleUpgrades(args)`.
- Consumes: active filter revision/config digest and current complete cache snapshot ID.

- [ ] **Step 1: Write conversion truth tests**

For PCO, assert membership values form one branch and all custom-field groups form a second OR branch. For Elvanto, assert every populated dimension is one AND-connected branch and existing `any`/`all` modes survive. Assert disabled/empty sources create no branch and neither provider creates exclusions.

Map legacy PCO's display sentinel `(none)` to canonical `$not_set` for membership and field values. Do not translate a real provider value that merely contains the word `none`.

- [ ] **Step 2: Write exact-set compatibility tests**

Evaluate legacy and converted filters over the same facts. Assert representative configurations yield identical sorted external ID sets. Include an equal-count/different-ID fixture and assert `compatible === false`.

- [ ] **Step 3: Write signed-token and atomic-bulk tests**

Bind the token to `kind: 'filter_upgrade'`, church, provider, batch ID, active revision, active config digest, snapshot ID, converted digest, compatibility result, and 30-minute expiry. Assert altered church/provider/batch/revision/config/snapshot/digest, expiry, and review-token substitution all fail. Assert one stale token rolls back an entire bulk upgrade transaction.

- [ ] **Step 4: Run tests and verify failure**

Run: `cd server && node --test services/peopleSync/filterUpgrade.test.js services/peopleSync/planDigest.test.js services/peopleSync/batchRepository.dbintegration.test.js`

Expected: FAIL because conversion and upgrade tokens do not exist.

- [ ] **Step 5: Implement conversion, comparison, and token domain separation**

Use canonical JSON for config digests. Do not expose either matched ID set in API results; return only old/new counts and compatibility. `applyCompatibleUpgrades` must re-read all rows and the cache snapshot inside one church transaction, verify every token first, then update all compatible rows to schema 2 and increment each revision.

Wire `evaluateLegacyFacts` as `filterPreview.js`'s production default while retaining dependency injection in its tests.

- [ ] **Step 6: Run upgrade tests**

Run: `cd server && node --test services/peopleSync/filterUpgrade.test.js services/peopleSync/planDigest.test.js services/peopleSync/batchRepository.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/peopleSync/filterUpgrade.js server/services/peopleSync/filterUpgrade.test.js server/services/peopleSync/filterPreview.js server/services/peopleSync/filterPreview.test.js server/services/peopleSync/planDigest.js server/services/peopleSync/planDigest.test.js server/services/peopleSync/batchRepository.js server/services/peopleSync/batchRepository.dbintegration.test.js
git commit -m "feat(sync): add reviewed v1 filter upgrades"
```

### Task 7: Expose provider-neutral filter APIs

**Files:**
- Create: `server/routes/integrations/filterBuilder.js`
- Create: `server/routes/integrations/filterBuilder.test.js`
- Modify: `server/routes/integrations.js`
- Modify: `server/routes/integrations/elvanto.js`
- Modify: `server/routes/integrations/elvanto.test.js`
- Modify: `server/services/planningCenterSync.js`
- Modify: `server/services/planningCenterSync.test.js`

**Interfaces:**
- Produces routes under `/api/integrations/people-sync/providers/:provider`:
  - `GET /filter-metadata`
  - `POST /filter-snapshot/refresh`
  - `POST /filter-preview`
  - `PUT /sync-batches/:id/filter-draft`
  - `DELETE /sync-batches/:id/filter-draft`
  - `POST /sync-batches/:id/filter-upgrade/preview`
  - `POST /sync-batches/:id/filter-upgrade/apply`
  - `POST /filter-upgrades/apply-compatible`

The request contracts are:

```ts
type PreviewBody = {
  batchId: number | null;
  filterConfig: BooleanFilterConfigV2;
  enabled: boolean;
  defaultPeopleType: PeopleType;
  gatheringTypeId: number | null;
};
type DraftBody = { filterConfig: BooleanFilterConfigV2; broadMatchAcknowledged: boolean };
type UpgradeApplyBody = { upgradeToken: string };
type BulkUpgradeBody = { upgrades: Array<{ batchId: number; upgradeToken: string }> };
```

Use stable codes `SYNC_FILTER_INVALID`, `SYNC_FILTER_CACHE_UNAVAILABLE`, `SYNC_FILTER_COVERAGE_MISSING`, `SYNC_FILTER_BROAD_ACK_REQUIRED`, `SYNC_FILTER_DRAFT_STALE`, and `SYNC_FILTER_UPGRADE_STALE` in safe error responses.

- [ ] **Step 1: Write route contract and security tests**

Assert every route requires admin auth and church isolation; rejects invalid provider/batch IDs; enforces JSON body size before evaluation; never returns `facts`, `externalPersonId`, matched IDs, credentials, or raw provider errors. Assert a church cannot preview, draft, or upgrade another church's batch.

- [ ] **Step 2: Write no-fetch preview and explicit-refresh tests**

Inject counters and assert `POST /filter-preview` calls only cache/repository/preview collaborators. Assert `POST /filter-snapshot/refresh` calls the selected adapter once with `mode: 'full'`, requests the union of custom-field dimensions from all active filters plus the proposed draft, passes that snapshot to `adapter.fetchMetadata` without a second people fetch, rejects an incomplete snapshot, and preserves an older cache on failure. Assert PCO `GET /filter-metadata` may consume `peekCachedPcoPeople` when warm but never calls a provider on a cold cache.

- [ ] **Step 3: Write draft and broad-match tests**

Assert save validates against canonical metadata, retains only previously saved unresolved selections, rejects a NOT-only or whole-population draft without `broadMatchAcknowledged: true`, and returns the unchanged active filter plus draft state. Assert discard never mutates active criteria.

- [ ] **Step 4: Run route tests and verify failure**

Run: `cd server && node --test routes/integrations/filterBuilder.test.js routes/integrations/elvanto.test.js services/planningCenterSync.test.js`

Expected: FAIL because the shared router is absent.

- [ ] **Step 5: Implement and mount the shared router**

Mount after common `verifyToken`, `ensureChurchIsolation`, and admin middleware:

```js
router.use('/people-sync/providers', createFilterBuilderRouter());
```

Use a strict provider allowlist. Keep preview response exactly:

```js
{
  success: true,
  matchCount,
  snapshot,
  overlaps,
  uniqueEnabledPopulationCount,
  missingDimensionIds,
  warnings,
}
```

- [ ] **Step 6: Make v2 batch creation atomic and preserve v1 clients**

Allow both provider create routes to accept `{ filterSchemaVersion: 2, draftFilterConfig }`. Store `EMPTY_V2_FILTER` as active and the supplied config as draft in the same insert. Continue accepting the existing legacy PCO body and Elvanto schema-1 body as v1 for stale PWA clients. During the client migration, make the PCO DTO additive: include every generic active/draft field while retaining flattened v1 membership/field fields for stale clients. Retain the legacy PCO row only for provenance and compatible non-filter dual writes.

- [ ] **Step 7: Run route/service tests**

Run: `cd server && node --test routes/integrations/filterBuilder.test.js routes/integrations/elvanto.test.js services/planningCenterSync.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/routes/integrations/filterBuilder.js server/routes/integrations/filterBuilder.test.js server/routes/integrations.js server/routes/integrations/elvanto.js server/routes/integrations/elvanto.test.js server/services/planningCenterSync.js server/services/planningCenterSync.test.js
git commit -m "feat(sync): expose shared filter APIs"
```

### Task 8: Use v2 filters in reconciliation and promote drafts atomically

**Files:**
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/orchestrator.dbintegration.test.js`
- Modify: `server/services/peopleSync/apply.js`
- Modify: `server/services/peopleSync/apply.dbintegration.test.js`
- Modify: `server/services/peopleSync/scheduler.js`
- Modify: `server/services/peopleSync/scheduler.test.js`
- Modify: `server/services/peopleSync/pcoAdapter.js`
- Modify: `server/services/elvanto/adapter.js`
- Modify: `server/services/elvanto/filter.js`
- Modify: `server/services/elvanto/filter.test.js`

**Interfaces:**
- Changes: `adapter.isEligible(person, filterConfig, filterSchemaVersion)` supports v1 and v2.
- Changes: `buildReview` substitutes the requested batch's draft while every other batch remains active.
- Changes: `applyPeopleSyncPlan({ ..., filterPromotion })` calls `promoteFilterDraftWithConnection` before committing.
- Produces review-token filter context `{ activeRevision, draftDigest, snapshotId }`.

- [ ] **Step 1: Write mixed-schema and population-gate tests**

Assert `buildEligibleByBatch` calls the same v2 evaluator used by cached preview and first applies `adapter.isInFilterPopulation`. Prove PCO and Elvanto equivalent facts/configs yield identical eligible IDs. Prove v1 behavior remains byte-for-byte compatible with current eligibility tests.

- [ ] **Step 2: Write draft review tests**

For a target batch with a draft, assert the review plan uses that draft and all other batches' active filters. Assert a normal review with no draft uses active filters only. Assert a full snapshot capture occurs after successful complete fetch, uses provider metadata derived from that same snapshot or an existing persisted metadata cache, and an incremental Elvanto fetch never replaces the cache.

- [ ] **Step 3: Write atomic promotion integration tests**

Assert successful reviewed apply mutates people and promotes the draft in one transaction. Inject a failure after person mutation but before promotion and assert both people and filter remain unchanged. Assert stale active revision, draft digest, provider, church, snapshot ID, or review token prevents all writes and leaves the draft available.

- [ ] **Step 4: Write unattended blocking tests**

Assert an enabled authoritative schema-2 batch with a draft throws `SYNC_FILTER_REVIEW_REQUIRED` before `startRun` or provider fetch. Assert a schema-1 active filter with a schema-2 migration draft continues its existing schedule. Assert non-authoritative providers remain blocked by the existing authority gate.

- [ ] **Step 5: Run orchestration tests and verify failure**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/apply.dbintegration.test.js services/peopleSync/scheduler.test.js services/elvanto/filter.test.js`

Expected: FAIL on draft substitution, promotion, and blocking assertions.

- [ ] **Step 6: Implement shared schema dispatch and reviewed promotion**

Pass `filterSchemaVersion` through all eligibility calls. Extend review-token payload validation with the filter context and snapshot ID. In `applyReviewed`, rebuild from a new complete snapshot, verify plan and filter context, validate selections, then pass:

```js
filterPromotion: batch.draftFilterConfig ? {
  batchId: batch.id,
  expectedBaseRevision: batch.draftFilterBaseRevision,
  expectedDraftDigest: digestFilter(batch.draftFilterConfig),
} : null
```

to the existing critical transaction. Do not promote during preview, failed apply, unattended sync, or authority-only review.

- [ ] **Step 7: Run orchestration tests**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/apply.dbintegration.test.js services/peopleSync/scheduler.test.js services/elvanto/filter.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/orchestrator.dbintegration.test.js server/services/peopleSync/apply.js server/services/peopleSync/apply.dbintegration.test.js server/services/peopleSync/scheduler.js server/services/peopleSync/scheduler.test.js server/services/peopleSync/pcoAdapter.js server/services/elvanto/adapter.js server/services/elvanto/filter.js server/services/elvanto/filter.test.js
git commit -m "feat(sync): promote filter drafts with reconciliation"
```

### Task 9: Add exact TypeScript contracts and client API methods

**Files:**
- Modify: `client/src/components/peopleSync/types.ts`
- Modify: `client/src/services/api.ts`
- Create: `client/src/services/filterConfig.ts`
- Create: `client/src/services/filterConfig.test.ts`

**Interfaces:**
- Produces: `BooleanFilterConfigV2`, `FilterDimension`, `FilterMetadata`, `FilterPreviewResult`, `FilterUpgradePreview`, and expanded `PeopleSyncBatch`.
- Produces: `emptyBooleanFilter()`, `setValueState(config, dimensionId, valueId, state)`, `addBranch`, `addGroup`, `removeBranch`, `removeGroup`.
- Produces API methods matching all Task 7 routes.

- [ ] **Step 1: Write reducer/helper tests**

Assert first positive selection creates Branch 1 and an `all` group for multi-valued dimensions; single dimensions use `any`; selecting `not` removes the pair from every branch and adds one global exclusion; selecting include removes the exclusion; duplicates never appear; removing the final value removes the empty group/branch.

- [ ] **Step 2: Run helper tests and verify failure**

Run: `cd client && npm test -- src/services/filterConfig.test.ts`

Expected: FAIL because the shared types/helpers do not exist.

- [ ] **Step 3: Add exact types**

Use discriminated value state and avoid `any`:

```ts
export type FilterValueState = 'off' | 'include' | 'not';
export interface BooleanFilterConfigV2 {
  branches: Array<{ groups: Array<{ dimensionId: string; mode: 'any' | 'all'; values: string[] }> }>;
  exclusions: Array<{ dimensionId: string; values: string[] }>;
}
```

Extend `PeopleSyncBatch` with Task 1 fields. Keep the legacy `SyncBatch` type temporarily for untouched PCO call sites in this task; mark it for removal in Task 12 after the panels and onboarding use the generic DTO.

- [ ] **Step 4: Add typed API methods**

Implement `getFilterMetadata`, `refreshFilterSnapshot`, `previewFilter`, `saveFilterDraft`, `discardFilterDraft`, `previewFilterUpgrade`, `applyFilterUpgrade`, and `applyCompatibleFilterUpgrades` under `peopleSyncAPI`. Give refresh/review/apply calls 120-second timeouts; cached preview uses the normal timeout.

- [ ] **Step 5: Run helper tests and TypeScript build**

Run: `cd client && npm test -- src/services/filterConfig.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/peopleSync/types.ts client/src/services/api.ts client/src/services/filterConfig.ts client/src/services/filterConfig.test.ts
git commit -m "feat(sync): add shared filter client contracts"
```

### Task 10: Build the shared accessible filter editor and preview summary

**Files:**
- Create: `client/src/components/peopleSync/FilterBuilder.tsx`
- Create: `client/src/components/peopleSync/FilterBuilder.test.tsx`
- Create: `client/src/components/peopleSync/FilterPreviewSummary.tsx`
- Create: `client/src/components/peopleSync/FilterPreviewSummary.test.tsx`

**Interfaces:**
- `FilterBuilder({ metadata, value, onChange, disabled })`.
- `FilterPreviewSummary({ provider, batchId, value, enabled, defaultPeopleType, gatheringTypeId, onMetadata })`.

- [ ] **Step 1: Write interaction and accessibility tests**

Test Branch 1 creation, `+ AND filter type`, `+ OR alternative branch`, group/branch removal, dimension uniqueness within one branch, reuse across branches, multi `Match any`/`Match all`, hidden `all` for single dimensions, and multiple NOT values. Use accessible roles/names rather than class selectors.

Assert selecting NOT removes the same pair from every positive branch and the persistent `Always exclude` region can remove it. Assert NOT-only remains editable and empty means nobody.

- [ ] **Step 2: Write long-list and unresolved-value tests**

Assert search filters only the open dimension's values, keyboard activation changes state, focus returns to the originating control after removal, `$not_set` displays as `Not set`, and unresolved saved dimensions/values remain visible with warning text.

- [ ] **Step 3: Write preview race/freshness tests**

Use fake timers to assert one request after 350 ms of inactivity, zero explicit refresh calls during editing, older responses cannot replace newer results, and unmount cancels updates. Assert fresh, stale, unavailable, overlap, unique-union, conflicting gathering/default, broad-match, and exact timestamp states.

- [ ] **Step 4: Run component tests and verify failure**

Run: `cd client && npm test -- src/components/peopleSync/FilterBuilder.test.tsx src/components/peopleSync/FilterPreviewSummary.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 5: Implement the visual structure**

Render one bordered card per branch, an `AND` divider between brackets, and a full-width `OR` divider between branches. Each value row has one three-state control labeled `Off`, `Include`, and `NOT`; do not render per-row Boolean operators. Put global exclusions in a persistent red-tinted `Always exclude` region. Default a newly added multi bracket to `Match all (AND)` and hide the mode control until it has at least two included values.

- [ ] **Step 6: Implement debounced preview and explicit refresh**

Sequence each preview request with a monotonically increasing ref and ignore responses with an older sequence. The refresh button calls `refreshFilterSnapshot` and only after it completes requests metadata and preview again.

- [ ] **Step 7: Run component tests**

Run: `cd client && npm test -- src/components/peopleSync/FilterBuilder.test.tsx src/components/peopleSync/FilterPreviewSummary.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/peopleSync/FilterBuilder.tsx client/src/components/peopleSync/FilterBuilder.test.tsx client/src/components/peopleSync/FilterPreviewSummary.tsx client/src/components/peopleSync/FilterPreviewSummary.test.tsx
git commit -m "feat(sync): build shared boolean filter UI"
```

### Task 11: Embed the shared builder in both batch editors

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`
- Create: `client/src/components/planningCenter/PlanningCenterBatchEditor.test.tsx`
- Modify: `client/src/components/elvanto/ElvantoBatchEditor.tsx`
- Modify: `client/src/components/elvanto/ElvantoBatchEditor.test.tsx`
- Delete: `client/src/components/elvanto/ElvantoFilterEditor.tsx`
- Delete: `client/src/components/elvanto/ElvantoFilterEditor.test.tsx`
- Delete: `client/src/components/planningCenter/MembershipAllowlistEditor.tsx`
- Delete: `client/src/components/planningCenter/FieldFilterEditor.tsx`

**Interfaces:**
- Both editors consume `PeopleSyncBatch<BooleanFilterConfigV2>` and render the same `FilterBuilder` and `FilterPreviewSummary` subtree.
- New batches submit `{ filterSchemaVersion: 2, draftFilterConfig }`; existing v2 batches save non-filter fields and draft criteria without changing active criteria.

- [ ] **Step 1: Write parity and save-flow tests**

Render both editors with the same canonical metadata and assert identical `Who qualifies?`, branch, mode, value-state, exclusion, count, overlap, and refresh controls. Assert provider-specific schedule/gathering/default controls remain present.

For new batches, assert exactly one create request contains `filterSchemaVersion: 2` and `draftFilterConfig`, and the returned batch reports `needsFilterReview`. For existing batches, assert non-filter update and draft save complete before `onSaved`; if either fails, show a specific error and keep the editor open.

- [ ] **Step 2: Write broad acknowledgement and active/draft tests**

Assert a broad warning requires an explicit checkbox before save. Assert reopening uses `draftFilterConfig ?? filterConfig`, labels active criteria as unchanged, and provides `Discard draft` only when a draft exists.

- [ ] **Step 3: Run editor tests and verify failure**

Run: `cd client && npm test -- src/components/planningCenter/PlanningCenterBatchEditor.test.tsx src/components/elvanto/ElvantoBatchEditor.test.tsx`

Expected: FAIL because each editor still owns a v1 filter UI.

- [ ] **Step 4: Replace provider-specific filter controls**

Keep PCO/Elvanto connection, schedule, gathering creation, auto-removal confirmation, and people-type controls. Remove only the old membership/field checkbox editor and Elvanto-specific filter editor. Fetch canonical metadata through `peopleSyncAPI.getFilterMetadata(provider)` and show unavailable metadata without erasing a saved draft.

- [ ] **Step 5: Run editor and integration-panel tests**

Run: `cd client && npm test -- src/components/planningCenter/PlanningCenterBatchEditor.test.tsx src/components/elvanto/ElvantoBatchEditor.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterBatchEditor.tsx client/src/components/planningCenter/PlanningCenterBatchEditor.test.tsx client/src/components/elvanto/ElvantoBatchEditor.tsx client/src/components/elvanto/ElvantoBatchEditor.test.tsx client/src/components/elvanto/ElvantoFilterEditor.tsx client/src/components/elvanto/ElvantoFilterEditor.test.tsx client/src/components/planningCenter/MembershipAllowlistEditor.tsx client/src/components/planningCenter/FieldFilterEditor.tsx
git commit -m "feat(sync): share batch filter builder"
```

### Task 12: Add reviewed upgrade, draft status, and onboarding flows

**Files:**
- Create: `client/src/components/peopleSync/FilterUpgradePanel.tsx`
- Create: `client/src/components/peopleSync/FilterUpgradePanel.test.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.test.tsx`
- Modify: `client/src/pages/OnboardingPage.tsx`
- Modify: `client/src/pages/OnboardingPage.integrations.test.tsx`
- Modify: `client/src/components/elvanto/ElvantoOnboarding.tsx`
- Modify: `client/src/components/elvanto/ElvantoOnboarding.test.tsx`
- Modify: `client/src/services/api.ts`

**Interfaces:**
- `FilterUpgradePanel({ provider, batches, onChanged })` previews and applies exact-compatible upgrades.
- Panel batch rows show `Needs full review`, `Active criteria still running`, and schema-v1 `Upgrade filter` states.

- [ ] **Step 1: Write upgrade UI tests**

Assert preview displays converted expression, old/new counts, snapshot age, overlap impact, and exact-compatible status. Assert `Upgrade all compatible batches` submits only batches with valid tokens. Assert mismatches cannot bulk-upgrade and offer `Review converted filter`, which saves the conversion as a migration draft while leaving the v1 schedule active.

- [ ] **Step 2: Write panel state tests**

Assert both provider panels show the same draft status copy. `Review & sync` opens the existing shared `SyncReview`; after apply it reloads batches and the promoted active filter. Discard removes only the draft. A v1 batch continues to display its schedule until upgraded.

- [ ] **Step 3: Write onboarding tests**

For both providers assert: create v2 batch with a nobody-matching active filter and proposed draft; immediately load a full review; apply promotes the draft; only then advance to authority selection/next onboarding step. Assert failed apply leaves onboarding on review and does not activate criteria.

- [ ] **Step 4: Run UI flow tests and verify failure**

Run: `cd client && npm test -- src/components/peopleSync/FilterUpgradePanel.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/pages/OnboardingPage.integrations.test.tsx src/components/elvanto/ElvantoOnboarding.test.tsx`

Expected: FAIL on upgrade, draft status, and v2 onboarding assertions.

- [ ] **Step 5: Implement upgrade and status flows**

Keep upgrade previews transient; do not save a normal draft for exact-compatible direct upgrades. For mismatches, save the converted v2 config as a migration draft (`active schema === 1`, `draft schema === 2`) and route it through the same full review/promotion flow as any other draft.

After every PCO editor, panel, and onboarding caller consumes `PeopleSyncBatch`, remove the legacy client `SyncBatch`, `SyncBatchInput`, and object-shaped `SyncBatchLastResult` types. Render recent status from the generic `lastSyncAt`/`lastSyncResult` fields and ignore the additive flattened v1 fields retained server-side for stale clients.

- [ ] **Step 6: Run UI flow tests**

Run: `cd client && npm test -- src/components/peopleSync/FilterUpgradePanel.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/pages/OnboardingPage.integrations.test.tsx src/components/elvanto/ElvantoOnboarding.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/peopleSync/FilterUpgradePanel.tsx client/src/components/peopleSync/FilterUpgradePanel.test.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx client/src/components/integrations/ElvantoIntegrationPanel.tsx client/src/components/integrations/ElvantoIntegrationPanel.test.tsx client/src/pages/OnboardingPage.tsx client/src/pages/OnboardingPage.integrations.test.tsx client/src/components/elvanto/ElvantoOnboarding.tsx client/src/components/elvanto/ElvantoOnboarding.test.tsx client/src/services/api.ts
git commit -m "feat(sync): add reviewed filter upgrade flows"
```

### Task 13: Verify the complete safety contract and document operation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-provider-neutral-boolean-sync-filter-builder-design.md`
- Modify: `AGENTS.md`
- Test: all changed server and client test files from Tasks 1–12

**Interfaces:**
- Produces operational documentation for cache freshness, draft review, v1 upgrade, and source-of-truth scheduling.

- [ ] **Step 1: Add a cross-layer acceptance test matrix to the design document**

Record the implemented endpoint names, cache constants, error codes, and these verified flows: `(A AND B) OR (C AND D) NOT E`, multiple NOT, NOT-only, empty, missing coverage, stale cache, mixed v1/v2 overlap, atomic promotion, stale-token rollback, authoritative draft scheduling block, exact-compatible upgrade, incompatible reviewed upgrade, and both onboarding paths.

- [ ] **Step 2: Update repository guidance**

In `AGENTS.md`, replace provider-specific filter notes with the canonical engine paths and state clearly that new filter logic must go through `filterEngine.js`, previews must remain cache-only, and drafts must be promoted only through reviewed reconciliation.

- [ ] **Step 3: Run the focused server suite**

Run:

```bash
cd server && node --test \
  config/peopleSyncSchema.dbintegration.test.js \
  config/database.test.js \
  services/peopleSync/filterEngine.test.js \
  services/peopleSync/filterSnapshot.test.js \
  services/peopleSync/filterFactsCache.test.js \
  services/peopleSync/filterPreview.test.js \
  services/peopleSync/filterUpgrade.test.js \
  services/peopleSync/batchRepository.dbintegration.test.js \
  services/peopleSync/pcoAdapter.test.js \
  services/peopleSync/providerRegistry.test.js \
  services/peopleSync/orchestrator.test.js \
  services/peopleSync/orchestrator.dbintegration.test.js \
  services/peopleSync/apply.dbintegration.test.js \
  services/peopleSync/scheduler.test.js \
  services/elvanto/adapter.test.js \
  services/elvanto/filter.test.js \
  routes/integrations/filterBuilder.test.js \
  routes/integrations/peopleSync.test.js \
  routes/integrations/elvanto.test.js
```

Expected: all tests PASS with no provider network calls.

- [ ] **Step 4: Run the focused client suite**

Run:

```bash
cd client && npm test -- \
  src/services/filterConfig.test.ts \
  src/components/peopleSync/FilterBuilder.test.tsx \
  src/components/peopleSync/FilterPreviewSummary.test.tsx \
  src/components/peopleSync/FilterUpgradePanel.test.tsx \
  src/components/planningCenter/PlanningCenterBatchEditor.test.tsx \
  src/components/elvanto/ElvantoBatchEditor.test.tsx \
  src/components/integrations/PlanningCenterIntegrationPanel.test.tsx \
  src/components/integrations/ElvantoIntegrationPanel.test.tsx \
  src/pages/OnboardingPage.integrations.test.tsx \
  src/components/elvanto/ElvantoOnboarding.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 5: Run full regression and production build**

Run: `cd server && node --test`

Expected: PASS.

Preserve the pre-existing service worker bytes around the build:

```bash
SYNC_SW_BACKUP=$(mktemp)
cp client/public/sw.js "$SYNC_SW_BACKUP"
cd client && npm test && npm run build
cd ..
cp "$SYNC_SW_BACKUP" client/public/sw.js
rm "$SYNC_SW_BACKUP"
```

Expected: PASS and a successful Vite/service-worker production build, followed by the exact pre-build `client/public/sw.js` content restored and still unstaged.

- [ ] **Step 6: Inspect the final diff for safety regressions**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors, no credential/cache facts in client responses, no unrelated files staged, and only intentional implementation/documentation changes.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-07-28-provider-neutral-boolean-sync-filter-builder-design.md
git commit -m "docs: document boolean sync filter operation"
```

## Completion Gate

Do not call the work complete until every acceptance flow in Task 13 passes and the final diff confirms:

- count preview, reviewed reconciliation, and unattended sync share the same versioned evaluator and population gate;
- no filter edit reaches active eligibility without successful full reviewed promotion;
- version-1 schedules remain unchanged until explicit upgrade;
- exact-compatible bulk upgrades are all-or-nothing;
- both provider editors render the same filter-builder subtree;
- `client/public/sw.js` remains outside every feature commit.
