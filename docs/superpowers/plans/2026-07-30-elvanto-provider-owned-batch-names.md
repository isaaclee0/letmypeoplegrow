# Elvanto Provider-Owned Batch Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove writable Elvanto batch names and keep every existing and future batch named after its trusted Elvanto Group or Category.

**Architecture:** Keep the required `people_sync_batches.name` compatibility column and response field, but derive it only at trusted boundaries: startup alignment, server-resolved create, reviewed source promotion, and successful provider refresh. The API and React editor stop accepting names, while active-source precedence prevents pending replacement drafts from renaming a batch before review.

**Tech Stack:** Node.js 26, Express, SQLite/better-sqlite3, React 19, TypeScript, Vitest, Node test runner.

## Global Constraints

- Both `elvanto_group` and `elvanto_category` names are provider-owned.
- Existing batches adopt their active source name; use the draft name only when no active source exists.
- A pending replacement draft must not rename an active batch before reviewed promotion.
- Client-supplied `name` fields on Elvanto create or update return HTTP 400 through strict body validation.
- Church-scoped source resolution and database predicates remain mandatory.
- No destructive schema change and no dependency additions.
- Gathering names remain independently editable and are outside this change.
- Use `npx vite build`, not `npm run build`, so verification does not regenerate the timestamped service worker.

---

### Task 1: Align Existing Elvanto Names During Database Initialization

**Files:**
- Modify: `server/config/database.js:128-260`
- Test: `server/config/database.test.js`

**Interfaces:**
- Consumes: existing `backfillProviderNeutralSync(db, churchId)` startup hook and `people_sync_batches` source/draft columns.
- Produces: idempotent startup alignment with active-source precedence and no unrelated configuration changes.

- [ ] **Step 1: Write the failing migration tests**

Add a database test that seeds three Elvanto rows before restart:

```js
const active = db.prepare(`INSERT INTO people_sync_batches
  (church_id, provider, name, enabled, source_kind, source_external_id, source_name,
   draft_source_kind, draft_source_external_id, draft_source_name, schedule_enabled)
  VALUES (?, 'elvanto', 'Custom active', 1, 'elvanto_group', 'members', 'Members',
          'elvanto_group', 'youth', 'Youth', 1)`).run(churchId);
const initial = db.prepare(`INSERT INTO people_sync_batches
  (church_id, provider, name, enabled, draft_source_kind, draft_source_external_id, draft_source_name)
  VALUES (?, 'elvanto', 'Custom initial', 0, 'elvanto_category', 'regulars', 'Regulars')`).run(churchId);
const sourceLess = db.prepare(`INSERT INTO people_sync_batches
  (church_id, provider, name, enabled)
  VALUES (?, 'elvanto', 'Unresolved', 0)`).run(churchId);
```

After `Database.closeAll(); Database.initialize();`, assert the names are `Members`, `Regulars`, and `Unresolved`; the active row still has the `Youth` draft; enabled/schedule/source IDs remain unchanged. Restart a second time and assert the same rows and values.

- [ ] **Step 2: Run the migration test to verify RED**

Run: `cd server && node --test --test-name-pattern="Elvanto batch names" config/database.test.js`

Expected: FAIL because the active and initial-review rows retain their custom names.

- [ ] **Step 3: Add the church-scoped idempotent alignment**

Immediately after legacy PCO retirement inside `backfillProviderNeutralSync`, add one guarded update:

```js
db.prepare(`UPDATE people_sync_batches
  SET name = CASE
        WHEN source_external_id IS NOT NULL THEN source_name
        WHEN source_external_id IS NULL AND draft_source_external_id IS NOT NULL THEN draft_source_name
        ELSE name
      END,
      updated_at = CASE
        WHEN name <> CASE
          WHEN source_external_id IS NOT NULL THEN source_name
          WHEN source_external_id IS NULL AND draft_source_external_id IS NOT NULL THEN draft_source_name
          ELSE name
        END THEN datetime('now') ELSE updated_at END
  WHERE church_id = ? AND provider = 'elvanto'
    AND CASE
      WHEN source_external_id IS NOT NULL THEN source_name
      WHEN source_external_id IS NULL AND draft_source_external_id IS NOT NULL THEN draft_source_name
      ELSE name
    END IS NOT NULL`).run(churchId);
```

Keep active-source precedence exactly as shown; never choose a replacement draft while an active source exists.

- [ ] **Step 4: Run migration coverage to verify GREEN**

Run: `cd server && node --test --test-name-pattern="Elvanto batch names|migrates an existing PCO database" config/database.test.js`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/config/database.js server/config/database.test.js
git commit -m "feat: align existing Elvanto batch names"
```

---

### Task 2: Derive Names During Source Promotion and Refresh

**Files:**
- Modify: `server/services/peopleSync/batchRepository.js:145-255`
- Test: `server/services/peopleSync/batchRepository.dbintegration.test.js`
- Test: `server/services/peopleSync/sourceHealth.dbintegration.test.js`

**Interfaces:**
- Consumes: `promoteSourceDraftWithConnection(...)` and `recordActiveSourceHealthWithConnection(...)`.
- Produces: atomic Elvanto batch/source renames from reviewed or freshly observed provider names; `updateBatch` no longer accepts `name`.

- [ ] **Step 1: Write failing repository tests**

Change the existing Elvanto promotion test to assert:

```js
const saved = await saveSourceDraft({ churchId, provider: 'elvanto', batchId: batch.id, source: youth });
assert.equal(saved.name, 'Members');
const promoted = await promoteSourceDraftWithConnection(conn, {
  churchId, provider: 'elvanto', batchId: batch.id,
  expectedBaseRevision: saved.draftSourceBaseRevision,
  expectedDraftDigest: digestSourceIdentity(saved.draftSource),
});
assert.equal(promoted.name, 'Youth');
assert.equal(promoted.source.name, 'Youth');
```

Change the source-health test so an observed rename from `Members` to `Members renamed` must update both `batch.name` and `batch.source.name`. Add an assertion that `updateBatch({ ..., name: 'Client rename' })` rejects with `Batch update field is not allowlisted: name`.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `cd server && node --test services/peopleSync/batchRepository.dbintegration.test.js services/peopleSync/sourceHealth.dbintegration.test.js`

Expected: FAIL because Elvanto promotion/refresh preserve the old batch name and repository updates still allow `name`.

- [ ] **Step 3: Implement trusted lifecycle naming**

In promotion SQL, replace the Planning-Center-only expression with:

```sql
name = CASE
  WHEN provider IN ('planning_center', 'elvanto') THEN draft_source_name
  ELSE name
END
```

Remove `name` from `updateBatch`'s `allowed` array and keep the current stored name when normalizing/persisting settings. In source-health SQL, update names for every Elvanto row and only modern Planning Center rows:

```sql
name = CASE
  WHEN provider = 'elvanto'
    OR (provider = 'planning_center' AND legacy_provider_batch_id IS NULL)
  THEN ? ELSE name END
```

Return the derived next batch name from `recordActiveSourceHealthWithConnection` so callers do not receive the stale pre-update value.

- [ ] **Step 4: Run repository tests to verify GREEN**

Run: `cd server && node --test services/peopleSync/batchRepository.dbintegration.test.js services/peopleSync/sourceHealth.dbintegration.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/peopleSync/batchRepository.js server/services/peopleSync/batchRepository.dbintegration.test.js server/services/peopleSync/sourceHealth.dbintegration.test.js
git commit -m "feat: derive Elvanto names from sources"
```

---

### Task 3: Remove Name From Elvanto API Requests

**Files:**
- Modify: `server/routes/integrations/elvanto.js:40-150,360-405`
- Test: `server/routes/integrations/elvanto.test.js`
- Test: `server/routes/integrations.elvanto.dbintegration.test.js`

**Interfaces:**
- Consumes: `resolveVisibleSource({ churchId, provider, sourceKind, sourceExternalId })` returning the trusted `{ kind, externalId, name }`.
- Produces: POST/PUT contracts that reject `name`; POST passes `name: source.name` only to the internal repository call.

- [ ] **Step 1: Write failing route tests**

Update the valid create request to omit `name`, capture the `createBatch` input, and assert:

```js
assert.equal(response.status, 200);
assert.equal(createInput.name, 'Members');
assert.deepEqual(createInput.initialDraftSource, {
  kind: 'elvanto_category', externalId: 'cat-1', name: 'Members',
});
```

Add separate POST and PUT cases with `{ name: 'Client name' }` and assert HTTP 400 with `Unknown batch field: name`. Add a create case resolving an `elvanto_group` named `Youth` and assert the stored/internal name is `Youth`.

- [ ] **Step 2: Run route tests to verify RED**

Run: `cd server && node --test routes/integrations/elvanto.test.js routes/integrations.elvanto.dbintegration.test.js`

Expected: FAIL because create still requires `name` and the allowlist accepts it.

- [ ] **Step 3: Implement the name-less request contract**

Remove `'name'` from `BATCH_BODY_ALLOWED`, remove name validation and the `requireName` option, and give validation an explicit create flag:

```js
function validateBatchBody(body, { create = false, current = CREATE_SCHEDULE_DEFAULTS } = {}) {
  // strict allowlist and existing setting validation
  if (create && (!SOURCE_KINDS_BY_PROVIDER.elvanto.has(body.sourceKind) ||
      typeof body.sourceExternalId !== 'string' || !body.sourceExternalId.trim())) {
    return 'An Elvanto source is required.';
  }
  if (!create && (Object.hasOwn(body, 'sourceKind') || Object.hasOwn(body, 'sourceExternalId'))) {
    return 'Sync sources must be changed through the source draft endpoint.';
  }
  // existing resulting schedule validation
  return null;
}
```

After resolving the source in POST, call:

```js
await deps.createBatch({
  churchId,
  provider: PROVIDER,
  ...fields,
  name: source.name,
  initialDraftSource: { kind: source.kind, externalId: source.externalId, name: source.name },
});
```

PUT continues passing only allowlisted settings.

- [ ] **Step 4: Run route coverage to verify GREEN**

Run: `cd server && node --test routes/integrations/elvanto.test.js routes/integrations.elvanto.dbintegration.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/integrations/elvanto.js server/routes/integrations/elvanto.test.js server/routes/integrations.elvanto.dbintegration.test.js
git commit -m "feat: remove Elvanto batch names from API"
```

---

### Task 4: Remove the Elvanto Name Field From the Client

**Files:**
- Modify: `client/src/components/elvanto/ElvantoBatchEditor.tsx:1-60`
- Modify: `client/src/components/peopleSync/types.ts:140-160`
- Test: `client/src/components/elvanto/ElvantoBatchEditor.test.tsx`

**Interfaces:**
- Consumes: name-less `ElvantoSyncBatchInput` and `ElvantoSyncBatchPatch` request types.
- Produces: editor create/update payloads containing source identity and settings only; gathering-name controls remain unchanged.

- [ ] **Step 1: Write failing editor tests**

Add assertions to the create and update tests:

```ts
expect(screen.queryByLabelText('Batch name')).not.toBeInTheDocument();
expect(elvantoSyncAPI.createBatch).toHaveBeenCalledWith(
  expect.not.objectContaining({ name: expect.anything() }),
);
expect(elvantoSyncAPI.updateBatch).toHaveBeenCalledWith(
  11,
  expect.not.objectContaining({ name: expect.anything() }),
);
```

Retain the existing assertion that changing the people source creates a draft only after settings save.

- [ ] **Step 2: Run the editor test to verify RED**

Run: `cd client && npm test -- --run src/components/elvanto/ElvantoBatchEditor.test.tsx`

Expected: FAIL because the Batch name input is rendered and payloads include `name`.

- [ ] **Step 3: Remove the writable name**

Delete the `name` state, the `Enter a batch name.` validation branch, and the Batch name label/input. Change the common payload to:

```ts
const common = {
  enabled,
  defaultPeopleType,
  gatheringTypeId: finalGatheringTypeId,
  gatheringAutoRemoveEnabled: finalGatheringTypeId === null ? false : gatheringAutoRemoveEnabled,
  scheduleEnabled,
  scheduleFrequency,
  scheduleDay,
};
```

Remove `name` from `ElvantoSyncBatchInput`; define the patch without source identity so update calls cannot accidentally send it:

```ts
export type ElvantoSyncBatchPatch = Partial<Omit<ElvantoSyncBatchInput, 'sourceKind' | 'sourceExternalId'>>;
```

- [ ] **Step 4: Run client coverage to verify GREEN**

Run: `cd client && npm test -- --run src/components/elvanto/ElvantoBatchEditor.test.tsx src/components/elvanto/ElvantoOnboarding.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/elvanto/ElvantoBatchEditor.tsx client/src/components/elvanto/ElvantoBatchEditor.test.tsx client/src/components/peopleSync/types.ts
git commit -m "feat: remove Elvanto batch name field"
```

---

### Task 5: End-to-End Verification and Contract Audit

**Files:**
- Verify: `docs/superpowers/specs/2026-07-30-elvanto-provider-owned-batch-names-design.md`
- Verify: all files changed by Tasks 1-4

**Interfaces:**
- Consumes: completed startup, repository, API, and client contracts.
- Produces: evidence that the full people-sync and client suites pass without regenerating `sw.js`.

- [ ] **Step 1: Run the complete serial server suite**

Run: `cd server && node --test --test-concurrency=1 config/*.test.js services/peopleSync/*.test.js routes/integrations*.test.js routes/integrations/*.test.js`

Expected: 0 failures. Use approved OS access if the restricted sandbox reports the known `uv_uptime`/loopback error.

- [ ] **Step 2: Run the complete client suite**

Run: `cd client && npm test -- --run`

Expected: 0 failures.

- [ ] **Step 3: Run the production client build without service-worker generation**

Run: `cd client && npx vite build`

Expected: exit 0; the existing large-chunk warning is non-blocking.

- [ ] **Step 4: Audit the final contract and worktree**

Run:

```bash
rg -n "Batch name|name:" client/src/components/elvanto/ElvantoBatchEditor.tsx
rg -n "'name'|requireName" server/routes/integrations/elvanto.js
git diff --check
git status --short
```

Expected: no Elvanto batch-name control or request field, no whitespace errors, no generated `sw.js` change, and only intentional files changed before the final commit.

- [ ] **Step 5: Correct documentation only if implementation changed the approved contract**

If the implemented contract differs from the design, update the design with the exact implemented behavior and commit only that correction:

```bash
git add -f docs/superpowers/specs/2026-07-30-elvanto-provider-owned-batch-names-design.md
git commit -m "docs: align Elvanto naming design"
```

If there is no deviation, do not create a documentation-only commit.
