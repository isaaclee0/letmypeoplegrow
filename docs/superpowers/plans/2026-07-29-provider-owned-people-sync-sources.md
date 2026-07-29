# Provider-Owned People Sync Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LMPG's Planning Center/Elvanto Boolean batch filters with exactly one provider-owned source per batch: a Planning Center List, an Elvanto People Category, or an Elvanto Group.

**Architecture:** Keep the existing provider-neutral matcher, plan engine, reviewed apply transaction, authority controls, gathering provenance, and scheduler. Replace full-roster-plus-local-filter eligibility with complete, read-only source snapshots. Store active and draft source identities on each batch, promote a draft only inside reviewed apply, compute authoritative presence from the union of enabled source memberships, and fail closed on missing or incomplete sources.

**Tech Stack:** Node.js 20+, Express 5, CommonJS, `node:test`, `better-sqlite3`, native `https`/`crypto`, React 19, TypeScript 6, Axios, Tailwind CSS, date-fns, Vitest, Testing Library.

## Global Constraints

- Each batch has exactly one source: `planning_center_list`, `elvanto_category`, or `elvanto_group`.
- Provider/source-kind combinations are strict: Planning Center accepts only Lists; Elvanto accepts only Categories or Groups.
- Stable provider IDs are identity. Source names are display snapshots and may change without breaking a batch.
- Planning Center source access is GET-only. Never call a List run action and never create, edit, archive, or delete a List.
- A complete source snapshot is all-or-nothing. A failed page, malformed envelope, retry exhaustion, or missing relationship must never be returned as an empty or partial source.
- Planning Center membership pagination is sequential with `per_page=100`; dynamic rate headers and `Retry-After` govern bounded retries. Elvanto pagination is sequential with bounded transient retries.
- Household people fetched only as matching context are never eligible unless their own person ID is in the source membership set.
- A legitimately empty, completely fetched source is valid and follows the existing reviewed/unattended policy.
- New and changed source selections are drafts. Unattended sync is blocked before run creation and before provider access while any enabled batch has no active source or has a pending draft.
- Reviewed apply promotes the target draft and applies people/link/family/gathering mutations in the same church-scoped database transaction.
- A missing active source is persisted, skips reconciliation, never clears or archives the roster, and atomically notifies active admins once per transition into `missing`. A later successful read restores `available` and permits a future missing transition to notify again.
- Draft-source failures never alter the active source's operational status.
- Planning Center `refreshed_at` is informational only: green through 7 days, orange over 7 through 30 days, red over 30 days, grey when absent/invalid. It never blocks or confirms a run.
- Preserve church isolation in every query, route, transaction, notification, background job, review token, and source digest.
- Preserve all unrelated user changes already present in the worktree. Do not overwrite or revert them while completing these tasks.
- Keep legacy filter columns/tables in SQLite under the additive-only migration convention, but remove all runtime reads and writes of them after cutover.
- Use test-first development and make the exact commit at the end of every task. Do not combine task commits.

## Delivery Order

1. **Persistence:** source value model, additive schema, active/draft lifecycle.
2. **Provider reads:** Planning Center Lists, then Elvanto Categories/Groups.
3. **Application boundary:** provider contract, admin routes, and source-aware batch creation.
4. **Safety:** operational source health and deduplicated missing-source notifications.
5. **Reconciliation:** source snapshot union, review binding, atomic source promotion.
6. **Frontend:** shared contracts, source picker, freshness display, batch/panel integration.
7. **Removal and release:** delete the unshipped filter system, run the full matrix, and perform the coordinated production cutover.

## Target Runtime Contracts

Use these exact semantic shapes in server JavaScript and mirror them in client TypeScript:

```ts
type SyncProvider = 'planning_center' | 'elvanto';
type SourceKind = 'planning_center_list' | 'elvanto_category' | 'elvanto_group';
type SourceStatus = 'unknown' | 'available' | 'missing' | 'error';

interface ProviderSource {
  kind: SourceKind;
  externalId: string;
  name: string;
  memberCount: number | null;
  providerRefreshedAt: string | null;
}

interface ProviderSourceSnapshot {
  provider: SyncProvider;
  source: ProviderSource;
  complete: true;
  fetchedAt: string;
  memberExternalIds: string[];
  people: NormalizedPerson[];
  contextPeople: NormalizedPerson[];
  families: NormalizedFamily[];
}
```

`people` contains source members. `contextPeople` contains non-member household context only. The orchestrator may pass both to matching, but it builds `eligibleByBatch` and full-fetch presence only from `memberExternalIds` after the provider lifecycle gate.

The provider registry contract becomes:

```js
{
  provider,
  validateConnection,
  listSources,
  fetchSourceSnapshot,
  isLifecycleEligible,
}
```

`isLifecycleEligible(person, settings)` is non-configurable source hygiene: Planning Center excludes non-active terminal records; Elvanto excludes archived/deceased records and respects the existing church-level Contacts setting. It is not a replacement local filter.

---

### Task 1: Add the Source Model, Additive Schema, and Draft Lifecycle

**Files:**
- Create: `server/services/peopleSync/sourceModel.js`
- Create: `server/services/peopleSync/sourceModel.test.js`
- Modify: `server/config/schema.js`
- Modify: `server/config/database.js`
- Modify: `server/config/peopleSyncSchema.dbintegration.test.js`
- Modify: `server/services/peopleSync/batchRepository.js`
- Modify: `server/services/peopleSync/batchRepository.dbintegration.test.js`

**Interfaces:**
- `sourceModel.assertSourceForProvider(provider, source)` validates the exact kind/ID/name shape.
- `sourceModel.digestSourceIdentity(source)` hashes only `{ kind, externalId }` using canonical JSON.
- `sourceModel.digestSourceSnapshot(snapshot)` hashes stable source metadata, sorted member IDs, and canonically sorted normalized people/context/families, excluding `fetchedAt`.
- `batchRepository.saveSourceDraft(...)`, `discardSourceDraft(...)`, and `promoteSourceDraftWithConnection(...)` replace the filter-draft lifecycle.

- [ ] **Step 1: Write failing pure source-model tests**

Create `sourceModel.test.js` covering every accepted/rejected provider-kind pair, whitespace/empty IDs, deterministic identity digests, order-independent snapshot digests, and a changed member/name/managed field producing a changed snapshot digest.

```js
test('source kinds are provider-exact', () => {
  assert.doesNotThrow(() => assertSourceForProvider('planning_center', {
    kind: 'planning_center_list', externalId: '42', name: 'Sunday Attendance',
  }));
  assert.throws(() => assertSourceForProvider('planning_center', {
    kind: 'elvanto_group', externalId: '42', name: 'Youth',
  }), { code: 'SYNC_SOURCE_INVALID' });
});

test('snapshot digest is stable across provider page order', () => {
  assert.equal(
    digestSourceSnapshot(snapshot({ memberExternalIds: ['2', '1'] })),
    digestSourceSnapshot(snapshot({ memberExternalIds: ['1', '2'] })),
  );
});
```

- [ ] **Step 2: Run the source-model test and verify failure**

Run: `cd server && node --test services/peopleSync/sourceModel.test.js`

Expected: FAIL because `sourceModel.js` does not exist.

- [ ] **Step 3: Implement the source constants, validation, normalization, and SHA-256 digests**

Export exact constants and helpers:

```js
const SOURCE_KINDS_BY_PROVIDER = Object.freeze({
  planning_center: new Set(['planning_center_list']),
  elvanto: new Set(['elvanto_category', 'elvanto_group']),
});
const SOURCE_STATUSES = new Set(['unknown', 'available', 'missing', 'error']);

module.exports = {
  SOURCE_KINDS_BY_PROVIDER,
  SOURCE_STATUSES,
  assertSourceForProvider,
  normalizeProviderSource,
  digestSourceIdentity,
  digestSourceSnapshot,
};
```

The snapshot digest must not include credentials, raw provider records, fetch time, or arbitrary attributes. Include stable identity and matching inputs only: person ID/name/state/child/family ID, family ID/name/primary-contact ID, context/member distinction, source ID/name/member count/provider refresh time, and sorted `memberExternalIds`.

- [ ] **Step 4: Run the pure test and verify pass**

Run: `cd server && node --test services/peopleSync/sourceModel.test.js`

Expected: PASS.

- [ ] **Step 5: Write failing schema and repository tests**

Extend the schema integration test to assert these additive columns and defaults:

```sql
source_kind TEXT
source_external_id TEXT
source_name TEXT
source_revision INTEGER NOT NULL DEFAULT 1
draft_source_kind TEXT
draft_source_external_id TEXT
draft_source_name TEXT
draft_source_base_revision INTEGER
draft_source_updated_at TEXT
source_status TEXT NOT NULL DEFAULT 'unknown'
source_status_checked_at TEXT
source_status_error_code TEXT
```

Add repository tests proving:

- a new batch can be created with no active source and one resolved `initialDraftSource`;
- `initialSourceReviewPending` and `needsSourceReview` are true;
- saving a different draft captures the current `sourceRevision`;
- a normal draft can be discarded but an initial draft cannot be discarded into a runnable state;
- promotion is compare-and-swap guarded by base revision and identity digest;
- successful promotion increments the revision, sets active source, clears draft fields, and resets status to `unknown`;
- wrong-church, wrong-provider, stale-revision, and changed-draft promotion attempts fail without mutation.

- [ ] **Step 6: Run the integration tests and verify failure**

Run: `cd server && node --test config/peopleSyncSchema.dbintegration.test.js services/peopleSync/batchRepository.dbintegration.test.js`

Expected: FAIL because source columns and repository methods do not exist.

- [ ] **Step 7: Add columns to both new-database and existing-database paths**

Add the fields to `PROVIDER_NEUTRAL_SYNC_SCHEMA` in `schema.js`, then add every field to `ensureProviderNeutralSyncSchema()`'s `missingBatchColumns` array in `database.js`. Keep filter columns untouched.

Use a source-status check on new databases:

```sql
source_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(source_status IN ('unknown', 'available', 'missing', 'error'))
```

- [ ] **Step 8: Replace the repository's runtime filter state with source state**

Change `toBatch()` to return source fields instead of filter fields:

```js
source: row.source_external_id ? {
  kind: row.source_kind,
  externalId: row.source_external_id,
  name: row.source_name,
} : null,
sourceRevision: Number(row.source_revision),
draftSource: row.draft_source_external_id ? {
  kind: row.draft_source_kind,
  externalId: row.draft_source_external_id,
  name: row.draft_source_name,
} : null,
draftSourceBaseRevision: row.draft_source_base_revision === null ? null : Number(row.draft_source_base_revision),
draftSourceUpdatedAt: row.draft_source_updated_at,
needsSourceReview: row.draft_source_external_id !== null,
initialSourceReviewPending: row.source_external_id === null,
sourceStatus: row.source_status,
sourceStatusCheckedAt: row.source_status_checked_at,
sourceStatusErrorCode: row.source_status_error_code,
```

Do not read, parse, validate, or write filter fields in normal batch CRUD. Leave their database values inert. Replace the filter methods and exports with:

```js
saveSourceDraft({ churchId, provider, batchId, source })
discardSourceDraft(churchId, provider, batchId)
promoteSourceDraftWithConnection(conn, {
  churchId, provider, batchId, expectedBaseRevision, expectedDraftDigest,
})
```

- [ ] **Step 9: Run the schema/repository tests and the adjacent database suite**

Run: `cd server && node --test config/peopleSyncSchema.dbintegration.test.js config/database.test.js services/peopleSync/batchRepository.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 10: Commit Task 1**

```bash
git add server/services/peopleSync/sourceModel.js server/services/peopleSync/sourceModel.test.js server/config/schema.js server/config/database.js server/config/peopleSyncSchema.dbintegration.test.js server/services/peopleSync/batchRepository.js server/services/peopleSync/batchRepository.dbintegration.test.js
git commit -m "feat: add people sync source lifecycle"
```

---

### Task 2: Implement Read-Only Planning Center List Sources

**Files:**
- Create: `server/services/planningCenter/readClient.js`
- Create: `server/services/planningCenter/readClient.test.js`
- Create: `server/services/planningCenter/sourceAdapter.js`
- Create: `server/services/planningCenter/sourceAdapter.test.js`
- Modify: `server/services/peopleSync/pcoAdapter.js`
- Modify: `server/services/peopleSync/pcoAdapter.test.js`

**Interfaces:**
- `createPcoReadClient({ accessToken, request, sleep, maxRetries })` exposes GET-only `getJson(url)` and `getAll(url)`.
- `listPlanningCenterSources(...)` enumerates all Lists by stable ID.
- `fetchPlanningCenterSourceSnapshot(...)` resolves one List and reads all membership pages.

- [ ] **Step 1: Write failing read-client tests**

Cover:

- Authorization is attached without appearing in errors;
- pagination follows `links.next` sequentially and starts with `per_page=100`;
- a repeated or >1,000-page next link fails with `SYNC_SOURCE_INCOMPLETE`;
- HTTP 429 honours numeric and HTTP-date `Retry-After` with a maximum of three retries;
- dynamic `X-PCO-API-Request-Rate-Limit`, `X-PCO-API-Request-Rate-Period`, and `X-PCO-API-Request-Rate-Count` values cause injected `sleep` before quota exhaustion rather than relying on a hard-coded quota;
- 401 and account-wide 403 responses are non-retryable `SYNC_SOURCE_AUTH` failures; a 404, or a source-specific 403 after the connection itself has been validated, is `SYNC_SOURCE_UNAVAILABLE`; malformed JSON/envelopes are incomplete-source failures;
- accumulated pages are never returned after any later page fails.

- [ ] **Step 2: Run the read-client test and verify failure**

Run: `cd server && node --test services/planningCenter/readClient.test.js`

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement the bounded GET-only client**

The production transport must expose response headers and accept only GET:

```js
async function getJson(url) { /* bounded retry and safe typed errors */ }
async function getAll(url) { /* sequential links.next traversal */ }
return Object.freeze({ getJson, getAll });
```

Do not expose `post`, `patch`, `delete`, or a generic `request(method, ...)` method from this module. Normalize header names case-insensitively and cap both retry count and pagination depth.

- [ ] **Step 4: Run the read-client tests and verify pass**

Run: `cd server && node --test services/planningCenter/readClient.test.js`

Expected: PASS.

- [ ] **Step 5: Write failing Planning Center source-adapter tests**

Use injected pages to prove:

- `GET /people/v2/lists?per_page=100` returns sorted `planning_center_list` DTOs;
- `refreshed_at`, name, stable List ID, and result/member count are mapped defensively;
- fetching by ID first resolves the List resource, so a deleted, archived, inaccessible, or wrong-type resource becomes `SYNC_SOURCE_UNAVAILABLE` rather than an empty source;
- `/people/v2/lists/{id}/people?per_page=100&include=households,field_data` follows every page;
- source members and household-only context remain separate;
- `memberExternalIds` contains only List members;
- family projection and existing `toNormalizedPcoPerson` normalization are reused;
- every captured transport method is GET and no URL contains a List run action.

- [ ] **Step 6: Run the source-adapter tests and verify failure**

Run: `cd server && node --test services/planningCenter/sourceAdapter.test.js services/peopleSync/pcoAdapter.test.js`

Expected: FAIL because source methods are not wired.

- [ ] **Step 7: Implement List enumeration and complete snapshots**

Construct source DTOs with:

```js
{
  kind: 'planning_center_list',
  externalId: String(list.id),
  name: String(list.attributes?.name || '').trim(),
  memberCount: finiteIntegerOrNull(list.attributes?.result_count),
  providerRefreshedAt: validIsoOrNull(list.attributes?.refreshed_at),
}
```

Fetch member pages at `per_page=100`. Project source members immediately to avoid retaining raw pages. If additional household calls are required, use a fixed small worker pool through the same rate-aware read client; never `Promise.all()` one call per person.

- [ ] **Step 8: Wire source methods into `createPcoAdapter()`**

Replace filter-related adapter methods with `listSources`, `fetchSourceSnapshot`, and `isLifecycleEligible`. Keep `validateConnection` and existing normalization dependencies. Do not make source enumeration reuse or mutate the old full-people cache.

- [ ] **Step 9: Run all Planning Center adapter tests**

Run: `cd server && node --test services/planningCenter/readClient.test.js services/planningCenter/sourceAdapter.test.js services/peopleSync/pcoAdapter.test.js services/planningCenter/projection.test.js`

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add server/services/planningCenter/readClient.js server/services/planningCenter/readClient.test.js server/services/planningCenter/sourceAdapter.js server/services/planningCenter/sourceAdapter.test.js server/services/peopleSync/pcoAdapter.js server/services/peopleSync/pcoAdapter.test.js
git commit -m "feat: read Planning Center list sources"
```

---

### Task 3: Implement Elvanto Category and Group Sources

**Files:**
- Modify: `server/services/elvanto/httpClient.js`
- Modify: `server/services/elvanto/httpClient.test.js`
- Create: `server/services/elvanto/sourceAdapter.js`
- Create: `server/services/elvanto/sourceAdapter.test.js`
- Modify: `server/services/elvanto/adapter.js`
- Modify: `server/services/elvanto/adapter.test.js`

**Interfaces:**
- Existing `createElvantoClient()` retains `get`, `post`, and sequential `getAll`, adding bounded transient retry support.
- `listElvantoSources(...)` returns both Categories and Groups.
- `fetchElvantoSourceSnapshot(...)` reads category or group membership completely and normalizes it.

- [ ] **Step 1: Add failing HTTP retry tests**

Extend `httpClient.test.js` to prove:

- response headers are preserved by the default transport;
- 429 honours `Retry-After` through an injected `sleep`;
- 429, 5xx, and transport failures retry at most three times;
- 401/account-wide 403, malformed bodies, provider-declared validation errors, and missing-source responses are not retried as transient failures; a source-specific permission loss is classified as `SYNC_SOURCE_UNAVAILABLE`, while an invalid account key is `SYNC_SOURCE_AUTH`;
- `getAll` remains sequential and discards accumulated pages on final failure.

- [ ] **Step 2: Run the HTTP tests and verify failure**

Run: `cd server && node --test services/elvanto/httpClient.test.js`

Expected: FAIL because retries and headers are not implemented.

- [ ] **Step 3: Add bounded retries without changing credential redaction**

Extend the factory signature to accept `sleep`, `maxRetries`, and `now`. Keep authorization redaction intact. Retry only semantically read operations; Elvanto `people/search` may use POST transport but is still a read and must never mutate provider data.

- [ ] **Step 4: Write failing source-adapter tests**

Cover:

- `people/categories/getAll` maps to `elvanto_category`;
- `groups/getAll` maps to `elvanto_group`;
- duplicate IDs within one kind are rejected as malformed, while identical ID text across different kinds remains distinct;
- category snapshots use `people/getAll` with `category_id` and sequential pagination;
- group snapshots use `people/search` with `search[groups]` and sequential pagination;
- the selected source is resolved before membership, so missing/permission/wrong-kind failures throw `SYNC_SOURCE_UNAVAILABLE`;
- `normalizeSnapshot()` is reused for people/families and group membership context;
- returned `providerRefreshedAt` is always `null`, `fetchedAt` is LMPG's successful read time, and empty complete sources succeed.

- [ ] **Step 5: Run the adapter tests and verify failure**

Run: `cd server && node --test services/elvanto/sourceAdapter.test.js services/elvanto/adapter.test.js`

Expected: FAIL because source methods are absent.

- [ ] **Step 6: Implement Elvanto source enumeration and snapshots**

Return both kinds from `listElvantoSources()` and sort within kind by case-insensitive name then ID. Group reads must not reuse an account-wide group-membership cache as proof of source completeness; execute the selected group search itself.

- [ ] **Step 7: Wire the source contract into `createElvantoAdapter()`**

Replace filter operations with:

```js
async listSources({ credentials }) { /* categories + groups */ }
async fetchSourceSnapshot({ credentials, sourceKind, sourceExternalId }) { /* complete source */ }
isLifecycleEligible(person, settings) {
  if (person.state === 'archived' || person.state === 'deceased') return false;
  return person.state !== 'contact' || settings.includeContacts !== false;
}
```

- [ ] **Step 8: Run the Elvanto unit suite**

Run: `cd server && node --test services/elvanto/httpClient.test.js services/elvanto/sourceAdapter.test.js services/elvanto/adapter.test.js services/elvanto/normalizer.test.js`

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add server/services/elvanto/httpClient.js server/services/elvanto/httpClient.test.js server/services/elvanto/sourceAdapter.js server/services/elvanto/sourceAdapter.test.js server/services/elvanto/adapter.js server/services/elvanto/adapter.test.js
git commit -m "feat: read Elvanto people sources"
```

---

### Task 4: Replace Filter Endpoints with Source Endpoints and Source-Aware Batch CRUD

**Files:**
- Modify: `server/services/peopleSync/providerRegistry.js`
- Modify: `server/services/peopleSync/providerRegistry.test.js`
- Create: `server/services/peopleSync/sourceSelection.js`
- Create: `server/services/peopleSync/sourceSelection.test.js`
- Create: `server/routes/integrations/sourceBuilder.js`
- Create: `server/routes/integrations/sourceBuilder.test.js`
- Modify: `server/routes/integrations.js`
- Modify: `server/routes/integrations.test.js`
- Modify: `server/routes/integrations/elvanto.js`
- Modify: `server/routes/integrations/elvanto.test.js`
- Modify: `server/services/planningCenterSync.js`
- Modify: `server/services/planningCenterSync.test.js`

**HTTP API:**

```text
GET    /api/integrations/people-sync/providers/:provider/sources
PUT    /api/integrations/people-sync/providers/:provider/sync-batches/:id/source-draft
DELETE /api/integrations/people-sync/providers/:provider/sync-batches/:id/source-draft
```

- [ ] **Step 1: Write failing provider-contract and source-resolution tests**

Update registry tests so the exact allowed adapter keys are the target runtime contract. Add `sourceSelection.test.js` proving `resolveVisibleSource()`:

- loads church-scoped credentials;
- resolves by exact kind plus exact external ID;
- returns the provider-supplied name/count/refresh time;
- rejects a missing or mismatched source with `SYNC_SOURCE_UNAVAILABLE`;
- never accepts client-supplied source names.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd server && node --test services/peopleSync/providerRegistry.test.js services/peopleSync/sourceSelection.test.js`

Expected: FAIL against the filter-era adapter contract.

- [ ] **Step 3: Implement the new registry and resolution service**

The resolver signature is:

```js
resolveVisibleSource({ churchId, provider, sourceKind, sourceExternalId })
```

It obtains credentials from `connectionStore`, calls the registered adapter's `listSources`, and returns the exact provider DTO. Throw credential-safe typed errors only.

- [ ] **Step 4: Write failing route tests**

Assert:

- all three routes require admin role and church isolation;
- GET returns only safe source DTO fields;
- PUT accepts exactly `sourceKind` and `sourceExternalId`, resolves server-side name, and saves a draft;
- DELETE rejects discarding an initial draft but discards a normal draft;
- invalid provider, ID, body size/shape, cross-church batch, and provider-kind mismatch are rejected;
- no credentials, people, raw records, or provider error bodies appear in responses.

- [ ] **Step 5: Run route tests and verify failure**

Run: `cd server && node --test routes/integrations/sourceBuilder.test.js`

Expected: FAIL because `sourceBuilder.js` does not exist.

- [ ] **Step 6: Implement and mount the source router**

Mount it at the same provider root currently occupied by `filterBuilder`:

```js
router.use('/people-sync/providers', createSourceBuilderRouter());
```

Use a safe DTO constructor; never spread adapter or repository objects into responses.

- [ ] **Step 7: Write failing PCO and Elvanto batch-create tests**

Change batch create request bodies to require `sourceKind` and `sourceExternalId`. Prove both provider routes:

- resolve the source server-side before insert;
- create no active source and save the resolved source as `initialDraftSource`;
- return `initialSourceReviewPending: true`;
- reject creates without a source;
- keep existing name/default-people-type/gathering/schedule behavior;
- do not accept filter-schema/config/draft-filter/broad-warning fields.

Update batch PATCH/PUT allowlists to exclude every filter field. Source changes use only the dedicated source-draft route.

- [ ] **Step 8: Run provider route tests and verify failure**

Run: `cd server && node --test routes/integrations.test.js routes/integrations/elvanto.test.js services/planningCenterSync.test.js`

Expected: FAIL against filter-era batch bodies.

- [ ] **Step 9: Implement source-aware create/update flows**

Remove PCO legacy DTO filter flattening and Elvanto filter validation from runtime CRUD. Continue leaving the legacy Planning Center table physically present, but stop dual-writing filter semantics. Existing generic `people_sync_batches` is canonical.

- [ ] **Step 10: Run the route/registry/repository suite**

Run: `cd server && node --test services/peopleSync/providerRegistry.test.js services/peopleSync/sourceSelection.test.js routes/integrations/sourceBuilder.test.js routes/integrations.test.js routes/integrations/elvanto.test.js services/planningCenterSync.test.js`

Expected: PASS.

- [ ] **Step 11: Commit Task 4**

```bash
git add server/services/peopleSync/providerRegistry.js server/services/peopleSync/providerRegistry.test.js server/services/peopleSync/sourceSelection.js server/services/peopleSync/sourceSelection.test.js server/routes/integrations/sourceBuilder.js server/routes/integrations/sourceBuilder.test.js server/routes/integrations.js server/routes/integrations.test.js server/routes/integrations/elvanto.js server/routes/integrations/elvanto.test.js server/services/planningCenterSync.js server/services/planningCenterSync.test.js
git commit -m "feat: expose people sync source selection"
```

---

### Task 5: Persist Source Health and Notify Once per Missing Transition

**Files:**
- Create: `server/services/peopleSync/sourceHealth.js`
- Create: `server/services/peopleSync/sourceHealth.dbintegration.test.js`
- Modify: `server/services/peopleSync/batchRepository.js`
- Modify: `server/services/peopleSync/batchRepository.dbintegration.test.js`

**Interfaces:**

```js
recordActiveSourceAvailable({ churchId, provider, batchId, expectedSource, observedSource, checkedAt })
recordActiveSourceFailure({ churchId, provider, batchId, expectedSource, code, checkedAt })
```

- [ ] **Step 1: Write failing database integration tests**

Prove:

- a successful read updates active `source_name`, `source_status='available'`, checked time, and clears error code without changing revision;
- rename-by-stable-ID updates only the display snapshot;
- `SYNC_SOURCE_UNAVAILABLE` transitions active status to `missing` and inserts exactly one notification per active `admin`, not coordinators or inactive admins;
- repeated missing checks insert no more notifications;
- `available -> missing` after recovery notifies once again;
- transient/incomplete/auth errors set `error` with a safe code and send no missing notification;
- compare-and-swap on expected source ID prevents a late fetch from changing a newly promoted source;
- draft-source failures do not call this service and therefore cannot modify active health.

- [ ] **Step 2: Run the health tests and verify failure**

Run: `cd server && node --test services/peopleSync/sourceHealth.dbintegration.test.js`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement atomic missing transition plus notifications**

Use `Database.transactionForChurch(churchId, async (conn) => ...)`. Inside the same transaction:

1. Read the batch using `id + church_id + provider`.
2. Verify active `source_kind + source_external_id` still equal `expectedSource`.
3. Detect whether the prior status differs from `missing`.
4. Update status/check/error fields.
5. Only on a transition, query active users with `role = 'admin'` and insert system notifications.

Use fixed message structure with only batch and last-known source names:

```text
Planning Center sync source missing
The source “Sunday Attendance” for batch “Members” is no longer available. Select a replacement in Settings → Integrations.
```

Never include external IDs, credentials, raw errors, or person data.

- [ ] **Step 4: Run health and repository tests**

Run: `cd server && node --test services/peopleSync/sourceHealth.dbintegration.test.js services/peopleSync/batchRepository.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add server/services/peopleSync/sourceHealth.js server/services/peopleSync/sourceHealth.dbintegration.test.js server/services/peopleSync/batchRepository.js server/services/peopleSync/batchRepository.dbintegration.test.js
git commit -m "feat: track missing sync sources"
```

---

### Task 6: Rewire Review, Apply, Presence, Audit, and Scheduling to Sources

**Files:**
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/orchestrator.dbintegration.test.js`
- Modify: `server/services/peopleSync/apply.js`
- Modify: `server/services/peopleSync/apply.test.js`
- Modify: `server/services/peopleSync/apply.dbintegration.test.js`
- Modify: `server/services/peopleSync/planDigest.js`
- Modify: `server/services/peopleSync/planDigest.test.js`
- Modify: `server/services/peopleSync/runRepository.js`
- Modify: `server/services/peopleSync/runRepository.dbintegration.test.js`
- Modify: `server/config/schema.js`
- Modify: `server/config/database.js`
- Modify: `server/services/peopleSync/scheduler.js`
- Modify: `server/services/peopleSync/scheduler.test.js`
- Modify: `server/routes/integrations/peopleSync.js`
- Modify: `server/routes/integrations/peopleSync.test.js`

**Pipeline:**

```text
load batches -> reject missing/pending source intent -> start run
-> fetch each enabled source sequentially -> mark active source health
-> union member IDs + matching context -> match -> plan
-> review token OR unattended apply -> atomic draft promotion on reviewed apply
-> record member-only full-fetch presence -> persist source provenance -> finish run
```

- [ ] **Step 1: Replace filter-era orchestrator tests with failing source tests**

Remove assertions about schema versions, facts caches, metadata, filter snapshots, `validateFilter`, and `isEligible`. Add tests proving:

- target review substitutes only the target batch's draft source; other enabled batches use active sources;
- all enabled sources are fetched sequentially, not with unbounded `Promise.all`;
- duplicate people across sources are normalized once while each batch retains its own eligible ID set;
- context-only household people can corroborate matching but never enter an eligible set, presence set, add/link/restore output, or gathering assignment;
- lifecycle-ineligible records are removed from eligibility even when a source returns them;
- a complete empty source is accepted;
- missing or incomplete active source fails before planning/apply/presence and records health;
- a draft-source fetch failure leaves active health untouched;
- enabled batches with no active source or any draft block unattended sync before `startRun` and adapter calls with `SYNC_SOURCE_SELECTION_REQUIRED` or `SYNC_SOURCE_REVIEW_REQUIRED`;
- old `refreshed_at` and missing `refreshed_at` do not block either run mode;
- every later scheduled attempt resolves a missing source again, allowing recovery.

- [ ] **Step 2: Run orchestrator tests and verify failure**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js`

Expected: FAIL against the full-roster/filter pipeline.

- [ ] **Step 3: Implement source-set acquisition**

Add a focused internal helper with this return shape:

```js
{
  snapshot: {
    provider,
    mode: 'full',
    complete: true,
    fetchedAt,
    watermark: null,
    people,
    families,
  },
  eligibleByBatch,
  seenMemberExternalIds,
  sourceProvenance,
}
```

For each effective batch, call `fetchSourceSnapshot` in a `for...of` loop. Build source provenance records containing only:

```js
{
  batchId,
  sourceKind,
  sourceExternalId,
  sourceName,
  memberCount,
  providerRefreshedAt,
  fetchedAt,
  snapshotDigest,
}
```

Do not call filter cache/metadata/evaluation services anywhere in the pipeline.

- [ ] **Step 4: Bind review/apply to source context**

Replace `plan.filterContext` with an internal `plan.sourceContext`:

```js
{
  activeRevision,
  draftDigest,
  snapshots: sourceProvenance.map(({ batchId, sourceKind, sourceExternalId, snapshotDigest }) => ({
    batchId, sourceKind, sourceExternalId, snapshotDigest,
  })),
}
```

Sort snapshots by numeric batch ID before digesting. `fetchedAt` is deliberately outside this signed context, so an identical complete re-read can verify; changed membership, managed matching input, source identity, source revision, or draft identity changes the digest and produces `SYNC_PLAN_STALE`.

- [ ] **Step 5: Write failing apply/promotion tests**

Replace `filterPromotion` fixtures with `sourcePromotion`. Prove a reviewed apply promotes the draft in the same transaction as people/gathering mutations, and any stale source base revision/digest rolls the entire transaction back.

- [ ] **Step 6: Implement atomic source promotion in apply**

Use:

```js
sourcePromotion: reviewedBatch?.draftSource ? {
  batchId: reviewedBatch.id,
  expectedBaseRevision: reviewedBatch.draftSourceBaseRevision,
  expectedDraftDigest: digestSourceIdentity(reviewedBatch.draftSource),
} : null
```

Call `promoteSourceDraftWithConnection()` before committing authority, within the existing transaction.

- [ ] **Step 7: Add run-level source provenance persistence**

Add nullable `source_provenance TEXT` to `people_sync_runs` in both schema paths. Extend `finishRun()` and the recent-runs DTO with a validated, size-bounded, PII-free array matching `sourceProvenance` above. Tests must reject extra keys, raw people, credentials, and oversized payloads.

- [ ] **Step 8: Make source runs full-snapshot only and preserve presence safety**

Source membership has no provider-neutral incremental contract. Set scheduled source runs to `fetchMode: 'full'`; stop consulting `lastExternalWatermark` for source reads. Call `recordFullFetchPresence()` exactly once after successful apply/classification using `seenMemberExternalIds`, never context IDs and never a partial/failed fetch.

- [ ] **Step 9: Update scheduler and safe error reporting**

Scheduler tests must prove missing-source failures are isolated to that due batch, do not call `recordBatchResult` as applied, and do not prevent later due batches from running. Add safe recent-run messages for:

```text
SYNC_SOURCE_SELECTION_REQUIRED
SYNC_SOURCE_REVIEW_REQUIRED
SYNC_SOURCE_UNAVAILABLE
SYNC_SOURCE_INCOMPLETE
SYNC_SOURCE_AUTH
SYNC_SOURCE_RATE_LIMIT
```

- [ ] **Step 10: Run the full backend reconciliation slice**

Run: `cd server && node --test services/peopleSync/sourceModel.test.js services/peopleSync/sourceHealth.dbintegration.test.js services/peopleSync/planDigest.test.js services/peopleSync/runRepository.dbintegration.test.js services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/apply.test.js services/peopleSync/apply.dbintegration.test.js services/peopleSync/scheduler.test.js routes/integrations/peopleSync.test.js routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js`

Expected: PASS.

- [ ] **Step 11: Commit Task 6**

```bash
git add server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/orchestrator.dbintegration.test.js server/services/peopleSync/apply.js server/services/peopleSync/apply.test.js server/services/peopleSync/apply.dbintegration.test.js server/services/peopleSync/planDigest.js server/services/peopleSync/planDigest.test.js server/services/peopleSync/runRepository.js server/services/peopleSync/runRepository.dbintegration.test.js server/config/schema.js server/config/database.js server/services/peopleSync/scheduler.js server/services/peopleSync/scheduler.test.js server/routes/integrations/peopleSync.js server/routes/integrations/peopleSync.test.js
git commit -m "feat: reconcile provider source snapshots"
```

---

### Task 7: Add Client Source Contracts, API Methods, Freshness, and the Shared Picker

**Files:**
- Modify: `client/src/components/peopleSync/types.ts`
- Modify: `client/src/services/api.ts`
- Create: `client/src/utils/sourceFreshness.ts`
- Create: `client/src/utils/sourceFreshness.test.ts`
- Create: `client/src/components/peopleSync/BatchSourceControls.tsx`
- Create: `client/src/components/peopleSync/BatchSourceControls.test.tsx`

**Client API:**

```ts
peopleSyncAPI.listSources(provider)
peopleSyncAPI.saveSourceDraft(provider, batchId, { sourceKind, sourceExternalId })
peopleSyncAPI.discardSourceDraft(provider, batchId)
```

- [ ] **Step 1: Write failing freshness tests with a fixed clock**

Cover exact boundaries:

```ts
expect(sourceFreshness(nowMinusDays(7), now).band).toBe('green');
expect(sourceFreshness(nowMinusMs(days(7) + 1), now).band).toBe('orange');
expect(sourceFreshness(nowMinusDays(30), now).band).toBe('orange');
expect(sourceFreshness(nowMinusMs(days(30) + 1), now).band).toBe('red');
expect(sourceFreshness(null, now).band).toBe('unknown');
expect(sourceFreshness('not-a-date', now).band).toBe('unknown');
```

Also assert text contains relative age and `title` contains the exact localized timestamp for valid values.

- [ ] **Step 2: Run freshness tests and verify failure**

Run: `cd client && npm test -- --run src/utils/sourceFreshness.test.ts`

Expected: FAIL because the utility does not exist.

- [ ] **Step 3: Implement source types, batch fields, API methods, and freshness utility**

Replace Boolean-filter types in runtime DTOs with `ProviderSource`, `SourceSelection`, and source lifecycle fields. Keep review plan/action types intact. Do not use `any`.

Use Tailwind class mapping in the utility/component:

```ts
green: 'text-green-700 dark:text-green-300'
orange: 'text-orange-700 dark:text-orange-300'
red: 'text-red-700 dark:text-red-300'
unknown: 'text-gray-600 dark:text-gray-400'
```

- [ ] **Step 4: Write failing picker tests**

Prove the shared control:

- loads and renders visible sources;
- PCO offers one List selector;
- Elvanto offers Category/Group type controls, and changing type clears selection;
- stores stable kind/ID while displaying name;
- shows member count when known;
- shows active and pending source names for an existing draft;
- allows discarding only a non-initial draft;
- retains the last-known name and displays `Source missing` when the selected ID is absent;
- shows PCO refresh text, exact timestamp, required helper copy, and all four colour bands;
- shows `Last checked by LMPG` from `sourceStatusCheckedAt` for Elvanto;
- does not render “stale”, a warning banner, confirmation checkbox, or a refresh/run action.

- [ ] **Step 5: Run picker tests and verify failure**

Run: `cd client && npm test -- --run src/components/peopleSync/BatchSourceControls.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 6: Implement the accessible source control**

Use labelled native controls, loading/empty/error states, and text in addition to colour. Include this exact Planning Center helper:

```text
If recent members are missing, refresh this List in Planning Center.
```

The component may retry enumeration, but it must not present a button that claims to refresh the Planning Center List itself.

- [ ] **Step 7: Run types/API/freshness/control tests**

Run: `cd client && npm test -- --run src/utils/sourceFreshness.test.ts src/components/peopleSync/BatchSourceControls.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit Task 7**

```bash
git add client/src/components/peopleSync/types.ts client/src/services/api.ts client/src/utils/sourceFreshness.ts client/src/utils/sourceFreshness.test.ts client/src/components/peopleSync/BatchSourceControls.tsx client/src/components/peopleSync/BatchSourceControls.test.tsx
git commit -m "feat: add people source picker"
```

---

### Task 8: Replace Both Batch Editors and Integration Panels

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`
- Modify: `client/src/components/planningCenter/PlanningCenterBatchEditor.test.tsx`
- Modify: `client/src/components/elvanto/ElvantoBatchEditor.tsx`
- Modify: `client/src/components/elvanto/ElvantoBatchEditor.test.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.test.tsx`
- Modify: `client/src/components/elvanto/ElvantoOnboarding.tsx`
- Modify: `client/src/components/elvanto/ElvantoOnboarding.test.tsx`

- [ ] **Step 1: Rewrite editor tests first**

For both providers, prove:

- create requires one selected source and sends only `sourceKind`/`sourceExternalId` plus normal batch settings;
- create response remains pending review and the editor calls `onSaved`;
- edit saves normal settings, then calls `saveSourceDraft` only if selection changed;
- a source-name-only rename does not create a draft;
- source draft failure reports the existing partial-save boundary clearly;
- schedule validation, gathering creation, and gathering auto-remove confirmation are preserved;
- no Boolean filter, broad-filter acknowledgement, legacy upgrade, or read-only-v1 UI remains.

- [ ] **Step 2: Run editor tests and verify failure**

Run: `cd client && npm test -- --run src/components/planningCenter/PlanningCenterBatchEditor.test.tsx src/components/elvanto/ElvantoBatchEditor.test.tsx`

Expected: FAIL against filter-era editors.

- [ ] **Step 3: Replace `BatchFilterControls` with `BatchSourceControls`**

The section heading is **People source**. Keep all unrelated batch settings in their current order. For a new batch, include source identity in the provider-specific create call. For an existing batch, use the dedicated source-draft endpoint.

- [ ] **Step 4: Rewrite integration-panel and onboarding tests**

Prove panels:

- show active source name and source kind;
- show `Source missing` without clearing last-known name;
- show `Needs full review` for initial/pending source selection;
- block/disable scheduled-run affordances when source review is pending while keeping **Review & sync** available;
- discard a normal source draft through `discardSourceDraft`;
- do not offer discard for initial source selection;
- no longer render `FilterUpgradePanel` or filter revision/schema language;
- refresh their source/batch state after reviewed apply;
- preserve PCO check-in controls and Elvanto connection/gathering import controls.

Update Elvanto onboarding's configure step to select a Category/Group and proceed into the existing reviewed reconciliation.

- [ ] **Step 5: Run panel tests and verify failure**

Run: `cd client && npm test -- --run src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/components/elvanto/ElvantoOnboarding.test.tsx`

Expected: FAIL until source state replaces filters.

- [ ] **Step 6: Implement panel/onboarding source state**

Use source status as operational copy, not a destructive state. Missing sources keep edit/replacement controls available. Old Planning Center refresh times remain coloured text only; they must not disable Review & sync, manual apply, or schedule toggles.

- [ ] **Step 7: Run the complete integration UI slice**

Run: `cd client && npm test -- --run src/components/peopleSync/BatchSourceControls.test.tsx src/components/planningCenter/PlanningCenterBatchEditor.test.tsx src/components/elvanto/ElvantoBatchEditor.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/components/elvanto/ElvantoOnboarding.test.tsx src/components/peopleSync/SyncReview.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit Task 8**

```bash
git add client/src/components/planningCenter/PlanningCenterBatchEditor.tsx client/src/components/planningCenter/PlanningCenterBatchEditor.test.tsx client/src/components/elvanto/ElvantoBatchEditor.tsx client/src/components/elvanto/ElvantoBatchEditor.test.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx client/src/components/integrations/ElvantoIntegrationPanel.tsx client/src/components/integrations/ElvantoIntegrationPanel.test.tsx client/src/components/elvanto/ElvantoOnboarding.tsx client/src/components/elvanto/ElvantoOnboarding.test.tsx
git commit -m "feat: use provider sources in sync batches"
```

---

### Task 9: Remove the Boolean Filter System and Legacy Runtime Paths

**Files:**
- Delete: `server/routes/integrations/filterBuilder.js`
- Delete: `server/routes/integrations/filterBuilder.test.js`
- Delete: `server/services/peopleSync/filterEngine.js`
- Delete: `server/services/peopleSync/filterEngine.test.js`
- Delete: `server/services/peopleSync/filterFactsCache.js`
- Delete: `server/services/peopleSync/filterFactsCache.test.js`
- Delete: `server/services/peopleSync/filterPreview.js`
- Delete: `server/services/peopleSync/filterPreview.test.js`
- Delete: `server/services/peopleSync/filterSnapshot.js`
- Delete: `server/services/peopleSync/filterSnapshot.test.js`
- Delete: `server/services/peopleSync/filterUpgrade.js`
- Delete: `server/services/peopleSync/filterUpgrade.test.js`
- Delete: `server/services/planningCenter/eligibility.js`
- Delete: `server/services/planningCenter/eligibility.test.js`
- Delete: `server/services/elvanto/filter.js`
- Delete: `server/services/elvanto/filter.test.js`
- Delete: `client/src/components/peopleSync/BatchFilterControls.tsx`
- Delete: `client/src/components/peopleSync/BatchFilterControls.test.tsx`
- Delete: `client/src/components/peopleSync/FilterBuilder.tsx`
- Delete: `client/src/components/peopleSync/FilterBuilder.test.tsx`
- Delete: `client/src/components/peopleSync/FilterPreviewSummary.tsx`
- Delete: `client/src/components/peopleSync/FilterPreviewSummary.test.tsx`
- Delete: `client/src/components/peopleSync/FilterUpgradePanel.tsx`
- Delete: `client/src/components/peopleSync/FilterUpgradePanel.test.tsx`
- Modify: `server/index.js`
- Modify: `server/routes/integrations.js`
- Modify: `server/routes/integrations/elvanto.js`
- Modify: `server/services/planningCenterSync.js`
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/apply.js`
- Modify: `client/src/services/api.ts`
- Modify: `client/src/components/peopleSync/types.ts`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add a source-only architecture guard test**

Create or extend `server/services/peopleSync/providerRegistry.test.js` and client type tests so no production adapter/API/batch DTO exposes filter methods or filter fields. Then run a repository search:

```bash
rg -n "filterSchemaVersion|filterConfig|draftFilter|filter-draft|filter-preview|filter-upgrade|BatchFilterControls|FilterUpgradePanel|validateFilter|isEligible|filterFactsCache" server client/src --glob '!**/node_modules/**'
```

Expected before cleanup: matches identify exactly the runtime imports/callers to remove. Schema/database definitions and historical documentation are allowed to remain.

- [ ] **Step 2: Delete filter implementation and UI files**

Delete the listed files. Remove the filter builder's narrow JSON parser/mount from `server/index.js` and `server/routes/integrations.js`; the source router remains mounted. Remove all filter API methods and TypeScript types.

- [ ] **Step 3: Remove provider-specific v1 evaluation and old adapter paths**

Remove imports/calls of PCO `eligibility.js` and Elvanto `filter.js`. Remove full-roster filter-only metadata/cache integration from `planningCenterSync.js`, `elvanto.js`, `orchestrator.js`, and `apply.js`. Keep unrelated PCO field-definition/check-in features and Elvanto gathering import features.

- [ ] **Step 4: Update repository guidance**

Replace AGENTS.md's “Provider-neutral Boolean people-sync filters” section with provider-owned source rules: one source per batch, read-only PCO Lists, complete pagination, draft promotion, missing-source fail-closed behavior, and source age as display-only.

- [ ] **Step 5: Prove only inert schema/history references remain**

Run:

```bash
rg -n "filterSchemaVersion|filterConfig|draftFilter|filter-draft|filter-preview|filter-upgrade|BatchFilterControls|FilterUpgradePanel|validateFilter|isEligible|filterFactsCache" server client/src --glob '!**/node_modules/**'
```

Expected: no production runtime or client matches. Only additive legacy column names in `server/config/schema.js`/`server/config/database.js`, migration fixtures that prove columns are retained, and explicitly historical comments/docs may remain.

- [ ] **Step 6: Run focused server and client suites**

Run: `cd server && node --test services/peopleSync/*.test.js services/planningCenter/*.test.js services/elvanto/*.test.js routes/integrations*.test.js routes/integrations/*.test.js`

Run: `cd client && npm test -- --run src/components/peopleSync src/components/planningCenter src/components/elvanto src/components/integrations`

Expected: PASS with no missing imports.

- [ ] **Step 7: Commit Task 9**

```bash
git add -A server/routes/integrations server/services/peopleSync server/services/planningCenter server/services/elvanto client/src/components/peopleSync client/src/services/api.ts client/src/components/peopleSync/types.ts server/index.js server/routes/integrations.js server/services/planningCenterSync.js AGENTS.md
git commit -m "refactor: remove local sync filters"
```

---

### Task 10: Add the Coordinated Cutover Runbook and Release Verification

**Files:**
- Create: `docs/runbooks/provider-owned-sync-source-cutover.md`
- Modify: `docs/superpowers/specs/2026-07-29-provider-owned-people-sync-sources-design.md`
- Modify: `VERSION`
- Modify: `client/package.json`
- Modify: `server/package.json`

- [ ] **Step 1: Write the operator runbook**

Include this exact coordinated sequence:

1. Identify the one production church and its one current v1 PCO batch.
2. With the church admin, create/confirm the equivalent Planning Center List and refresh it inside Planning Center.
3. Record current LMPG batch settings, linked-person count, gathering target, schedule, and a roster snapshot for rollback comparison.
4. Deploy the source-based release with unattended sync disabled for that church during the cutover window.
5. Select the List in the existing batch, save the source draft, run **Review & sync**, inspect adds/links/restores/archives/gathering changes, and apply.
6. Confirm the batch shows the correct active List, source status `available`, provider refresh time, and LMPG read time.
7. Re-enable unattended sync, invoke one controlled scheduled run, and confirm the audit/source provenance.
8. Exercise a non-destructive missing-source test in staging or with an injected provider fixture: scheduled run skips mutation and one admin notification is created.
9. Confirm Elvanto Category and Group creation/review flows in staging.
10. Keep the old filter columns/table data untouched for forensic rollback, but do not restore old runtime code.

Define abort criteria: source cannot be resolved, complete pagination fails, review differs materially from the agreed List, unexpected archives/removals appear, or source promotion does not commit atomically.

- [ ] **Step 2: Update the approved design status and release notes**

After implementation verification, change the design status to implemented and link the runbook. Bump `VERSION` and both package versions together according to the project's release convention.

- [ ] **Step 3: Run the complete server suite**

Run: `cd server && node --test`

Expected: PASS.

- [ ] **Step 4: Run the complete client suite**

Run: `cd client && npm test`

Expected: PASS.

- [ ] **Step 5: Build the production client**

Run: `cd client && npm run build`

Expected: service worker generation and Vite build both succeed with no TypeScript errors.

- [ ] **Step 6: Run final static and security checks**

Run:

```bash
rg -n "planningcenter.*lists.*run|/lists/.*/run|method:\s*['\"](?:POST|PATCH|DELETE)['\"]" server/services/planningCenter server/services/peopleSync/pcoAdapter.js
rg -n "filter-draft|filter-preview|filter-upgrade|BatchFilterControls|FilterUpgradePanel|validateFilter|isEligible" server client/src
rg -n "source_external_id|source_kind|draft_source" server | rg -v "church_id|schema|test|docs"
```

Expected:

- no Planning Center List write/run call;
- no local filter runtime;
- every operational source query shown by the last search is visibly church- and provider-scoped.

- [ ] **Step 7: Review the final diff and preserve unrelated work**

Run: `git status --short` and `git diff --check`.

Expected: only planned implementation/version/runbook changes plus any pre-existing user changes; no whitespace errors, secrets, database files, generated build output, or raw provider fixtures.

- [ ] **Step 8: Commit Task 10**

The docs directory is ignored globally in this repository, so force-add only the exact intended documentation paths:

```bash
git add -f docs/runbooks/provider-owned-sync-source-cutover.md docs/superpowers/specs/2026-07-29-provider-owned-people-sync-sources-design.md
git add VERSION client/package.json server/package.json
git commit -m "docs: add provider source cutover runbook"
```

## Final Acceptance Checklist

- [ ] A PCO batch can select exactly one visible List by stable ID.
- [ ] An Elvanto batch can select exactly one Category or Group by stable ID.
- [ ] No UI or API supports local Boolean rules, multiple sources, or source combinations.
- [ ] PCO source operations are GET-only and never run or refresh a List.
- [ ] Large source reads paginate sequentially and honour bounded rate-limit retries.
- [ ] Context-only household people never become eligible, linked, imported, restored, present, or gathering-assigned solely because they were context.
- [ ] New/source-changed batches cannot run unattended before reviewed promotion.
- [ ] Review/apply is bound to source identity, revision, and stable complete-snapshot digest.
- [ ] Active source promotion and reconciliation mutations commit or roll back together.
- [ ] Missing/incomplete sources never become empty snapshots and never cause roster clearing or archival.
- [ ] Missing-source notifications go once per transition to active admins only, and recovery permits a later new transition.
- [ ] PCO age colours are correct at 7- and 30-day boundaries and never block sync.
- [ ] PCO helper copy and Elvanto “Last checked by LMPG” copy are present.
- [ ] Existing matcher, authority lock, gathering provenance, PCO check-ins, Elvanto gathering import, and reviewed sync tests remain green.
- [ ] The one production v1 church has completed the coordinated List cutover before unattended sync is re-enabled.
