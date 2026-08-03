# PCO Background-Check Account Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh background-check status for every LMPG individual with a Planning Center ID, independent of List membership, canonical link rows, active/archive state, or how the ID was acquired.

**Architecture:** A PCO-specific service reads a complete, lean `/people/v2/people` snapshot and applies it to `individuals` by `(church_id, planning_center_id)`. The provider-neutral orchestrator invokes the service through a dependency-injected, best-effort post-apply hook for real PCO applies only; a one-minute per-church cache/single-flight prevents duplicate reads across back-to-back batches.

**Tech Stack:** Node.js, Express service layer, `better-sqlite3` through the project database wrapper, Planning Center JSON:API, `node:test`, Docker Compose.

## Global Constraints

- Every local query and update must include `church_id`; no cross-church fallback is allowed.
- `individuals.planning_center_id` is the association key; `external_person_links` and List membership must not gate status updates.
- Update active and archived individuals.
- A complete snapshot maps `true` to `1`, `false` to `0`, and missing/non-boolean or absent people to `NULL`.
- A provider/network failure must preserve existing status values and must not turn an already-applied people-sync run into `failed`.
- Do not touch `individuals.updated_at` while projecting supplementary status.
- Do not add dependencies, schema columns, UI changes, richer PCO background-check resources, or per-person API calls.
- Preserve unrelated worktree changes, especially existing edits to People-page files.

---

### Task 1: Add the lean account-wide PCO status reader

**Files:**
- Modify: `server/services/planningCenter/backgroundCheckSync.js`
- Create: `server/services/planningCenter/backgroundCheckSync.test.js`

**Interfaces:**
- Consumes: `createPcoReadClient(options)` from `server/services/planningCenter/readClient.js`.
- Produces: `fetchBackgroundCheckSnapshot(options)` returning `{ fetchedAt: string, complete: true, people: Array<{ id: string, passedBackgroundCheck: boolean | null }> }`.

- [ ] **Step 1: Write failing pagination and projection tests**

Create `server/services/planningCenter/backgroundCheckSync.test.js` with the shared response helper and these tests:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchBackgroundCheckSnapshot } = require('./backgroundCheckSync');

const API = 'https://api.planningcenteronline.com/people/v2';
const response = (status, data, headers = {}) => ({ status, data, headers });

test('fetchBackgroundCheckSnapshot reads every People page without includes', async () => {
  const calls = [];
  const pages = new Map([
    [`${API}/people?per_page=100`, response(200, {
      data: [
        { type: 'Person', id: 'p2', attributes: { passed_background_check: false } },
        { type: 'Person', id: 'p1', attributes: { passed_background_check: true } },
      ],
      links: { next: `${API}/people?page=2` },
    })],
    [`${API}/people?page=2`, response(200, {
      data: [
        { type: 'Person', id: 'p3', attributes: {} },
      ],
      links: { next: null },
    })],
  ]);

  const snapshot = await fetchBackgroundCheckSnapshot({
    accessToken: 'secret',
    request: async (request) => {
      calls.push(request);
      return pages.get(request.url);
    },
    now: () => new Date('2026-08-03T05:00:00.000Z'),
  });

  assert.deepEqual(snapshot, {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [
      { id: 'p1', passedBackgroundCheck: true },
      { id: 'p2', passedBackgroundCheck: false },
      { id: 'p3', passedBackgroundCheck: null },
    ],
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    `${API}/people?per_page=100`,
    `${API}/people?page=2`,
  ]);
  assert.ok(calls.every(({ url }) => !url.includes('include=')));
  assert.ok(calls.every(({ method }) => method === 'GET'));
});

test('fetchBackgroundCheckSnapshot rejects malformed Person resources', async () => {
  for (const resource of [
    { type: 'Household', id: 'h1', attributes: {} },
    { type: 'Person', attributes: {} },
    { type: 'Person', id: '   ', attributes: {} },
  ]) {
    await assert.rejects(
      fetchBackgroundCheckSnapshot({
        accessToken: 'secret',
        request: async () => response(200, { data: [resource], links: { next: null } }),
      }),
      (error) => error.code === 'SYNC_SOURCE_INCOMPLETE'
    );
  }
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
docker exec church_attendance_server_dev node --test services/planningCenter/backgroundCheckSync.test.js
```

Expected: FAIL because `fetchBackgroundCheckSnapshot` is not exported.

- [ ] **Step 3: Implement the lean complete reader**

Add the reader above the database writer in `backgroundCheckSync.js`:

```js
const { createPcoReadClient, PcoSourceError } = require('./readClient');

const API = 'https://api.planningcenteronline.com/people/v2';

function projectBackgroundCheckPerson(resource) {
  const id = resource?.id === null || resource?.id === undefined
    ? '' : String(resource.id).trim();
  if (!resource || resource.type !== 'Person' || !id) {
    throw new PcoSourceError(
      'Planning Center People contains a malformed Person resource',
      'SYNC_SOURCE_INCOMPLETE',
      {}
    );
  }
  const raw = resource.attributes?.passed_background_check;
  return {
    id,
    passedBackgroundCheck: typeof raw === 'boolean' ? raw : null,
  };
}

async function fetchBackgroundCheckSnapshot(options = {}) {
  const client = options.client || createPcoReadClient({
    accessToken: options.accessToken,
    request: options.request,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
    requestScope: 'account',
  });
  const people = [];
  await client.getAll(`${API}/people?per_page=100`, async (envelope) => {
    for (const resource of envelope.data) people.push(projectBackgroundCheckPerson(resource));
  });
  people.sort((left, right) => left.id.localeCompare(right.id));
  const now = options.now || (() => new Date());
  return { fetchedAt: now().toISOString(), complete: true, people };
}
```

Export it alongside the existing writer:

```js
module.exports = {
  fetchBackgroundCheckSnapshot,
  syncBackgroundCheckStatuses,
};
```

- [ ] **Step 4: Run reader and read-client tests**

Run:

```bash
docker exec church_attendance_server_dev node --test services/planningCenter/backgroundCheckSync.test.js services/planningCenter/readClient.test.js
```

Expected: PASS. The request list must contain only the fully paginated People collection and no `include` parameter.

- [ ] **Step 5: Commit the reader**

```bash
git add server/services/planningCenter/backgroundCheckSync.js server/services/planningCenter/backgroundCheckSync.test.js
git commit -m "fix(pco): read account-wide background-check statuses"
```

---

### Task 2: Apply complete snapshots by local PCO ID

**Files:**
- Modify: `server/services/planningCenter/backgroundCheckSync.js`
- Modify: `server/services/planningCenter/backgroundCheckSync.dbintegration.test.js`

**Interfaces:**
- Consumes: the snapshot produced by `fetchBackgroundCheckSnapshot(options)`.
- Produces: `applyBackgroundCheckSnapshot(churchId, snapshot)` returning `{ fetchedAt, updated, cleared, notCleared, unknown }`.

- [ ] **Step 1: Replace narrow writer tests with complete-snapshot behavior tests**

Update the test import and seed helper:

```js
const { applyBackgroundCheckSnapshot } = require('./backgroundCheckSync');

async function seedIndividual(churchId, {
  planningCenterId = null, isActive = true, cleared = null,
} = {}) {
  const result = await Database.query(
    `INSERT INTO individuals
       (first_name, last_name, church_id, is_active, planning_center_id, pco_background_check_cleared)
     VALUES ('Test', 'Person', ?, ?, ?, ?)`,
    [churchId, isActive ? 1 : 0, planningCenterId, cleared]
  );
  return result.insertId;
}

const snapshot = (people) => ({
  fetchedAt: '2026-08-03T05:00:00.000Z',
  complete: true,
  people,
});
```

Replace the existing cases with these focused tests:

```js
test('applies true, false, and unknown to active and archived PCO-ID-only people', async () => {
  await withTestChurchDb(async (churchId) => {
    const clearedId = await seedIndividual(churchId, { planningCenterId: 'pco-1' });
    const failedId = await seedIndividual(churchId, { planningCenterId: 'pco-2', isActive: false });
    const unknownId = await seedIndividual(churchId, { planningCenterId: 'pco-3', cleared: 1 });

    const result = await applyBackgroundCheckSnapshot(churchId, snapshot([
      { id: 'pco-1', passedBackgroundCheck: true },
      { id: 'pco-2', passedBackgroundCheck: false },
      { id: 'pco-3', passedBackgroundCheck: null },
    ]));

    assert.deepEqual(result, {
      fetchedAt: '2026-08-03T05:00:00.000Z',
      updated: 3, cleared: 1, notCleared: 1, unknown: 1,
    });
    assert.equal(await getCleared(clearedId), 1);
    assert.equal(await getCleared(failedId), 0);
    assert.equal(await getCleared(unknownId), null);
  });
});

test('clears a stale green status when a local PCO ID is absent from a complete snapshot', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, {
      planningCenterId: 'missing-from-pco', cleared: 1,
    });
    await applyBackgroundCheckSnapshot(churchId, snapshot([]));
    assert.equal(await getCleared(individualId), null);
  });
});

test('does not require an external_person_links row', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, {
      planningCenterId: 'checkin-imported', isActive: false,
    });
    const links = await Database.query(
      `SELECT COUNT(*) AS count FROM external_person_links
        WHERE church_id = ? AND provider = 'planning_center'`,
      [churchId]
    );
    assert.equal(links[0].count, 0);
    await applyBackgroundCheckSnapshot(churchId, snapshot([
      { id: 'checkin-imported', passedBackgroundCheck: true },
    ]));
    assert.equal(await getCleared(individualId), 1);
  });
});

test('complete snapshot apply is scoped to one church', async () => {
  await withTestChurchDb(async (churchIdA) => {
    await withTestChurchDb(async (churchIdB) => {
      const idB = await seedIndividual(churchIdB, {
        planningCenterId: 'shared-provider-id', cleared: 0,
      });
      await applyBackgroundCheckSnapshot(churchIdA, snapshot([
        { id: 'shared-provider-id', passedBackgroundCheck: true },
      ]));
      assert.equal(await getCleared(idB), 0);
    });
  });
});

test('rejects a partial snapshot before changing local status', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, {
      planningCenterId: 'pco-1', cleared: 1,
    });
    await assert.rejects(
      applyBackgroundCheckSnapshot(churchId, { complete: false, people: [] }),
      /complete Planning Center background-check snapshot/
    );
    assert.equal(await getCleared(individualId), 1);
  });
});
```

- [ ] **Step 2: Run the database test to verify it fails**

```bash
docker exec church_attendance_server_dev node --test services/planningCenter/backgroundCheckSync.dbintegration.test.js
```

Expected: FAIL because `applyBackgroundCheckSnapshot` is not exported.

- [ ] **Step 3: Implement one church-scoped transactional apply**

Replace the old loop-based writer with:

```js
async function applyBackgroundCheckSnapshot(churchId, snapshot) {
  if (!churchId || snapshot?.complete !== true || !Array.isArray(snapshot.people)) {
    throw new Error('A complete Planning Center background-check snapshot is required');
  }
  const statuses = new Map(snapshot.people.map((person) => [
    String(person.id),
    typeof person.passedBackgroundCheck === 'boolean' ? person.passedBackgroundCheck : null,
  ]));

  return Database.transactionForChurch(churchId, async (conn) => {
    const rows = await conn.query(
      `SELECT id, planning_center_id
         FROM individuals
        WHERE church_id = ?
          AND planning_center_id IS NOT NULL
          AND planning_center_id <> ''
        ORDER BY id`,
      [churchId]
    );
    const counts = {
      fetchedAt: snapshot.fetchedAt,
      updated: 0, cleared: 0, notCleared: 0, unknown: 0,
    };
    for (const row of rows) {
      const status = statuses.has(String(row.planning_center_id))
        ? statuses.get(String(row.planning_center_id)) : null;
      await conn.query(
        `UPDATE individuals
            SET pco_background_check_cleared = ?
          WHERE id = ? AND church_id = ? AND planning_center_id = ?`,
        [status === null ? null : status ? 1 : 0,
          row.id, churchId, row.planning_center_id]
      );
      counts.updated += 1;
      if (status === true) counts.cleared += 1;
      else if (status === false) counts.notCleared += 1;
      else counts.unknown += 1;
    }
    return counts;
  });
}
```

Export `applyBackgroundCheckSnapshot`. Remove the obsolete
`syncBackgroundCheckStatuses` export after every caller/test has moved; `rg`
must show no remaining references outside git history.

- [ ] **Step 4: Run the focused database tests**

```bash
docker exec church_attendance_server_dev node --test services/planningCenter/backgroundCheckSync.dbintegration.test.js services/planningCenter/mode.dbintegration.test.js
```

Expected: PASS, including the PCO-ID-only archived person and church-isolation cases.

- [ ] **Step 5: Commit the snapshot writer**

```bash
git add server/services/planningCenter/backgroundCheckSync.js server/services/planningCenter/backgroundCheckSync.dbintegration.test.js
git commit -m "fix(pco): apply background checks by local PCO ID"
```

---

### Task 3: Add tracking gate, token ownership, and per-church deduplication

**Files:**
- Modify: `server/services/planningCenter/backgroundCheckSync.js`
- Modify: `server/services/planningCenter/backgroundCheckSync.test.js`

**Interfaces:**
- Consumes: `isBackgroundCheckTrackingEnabled(churchId)`, `withPlanningCenterSourceToken(churchId, operation)`, `fetchBackgroundCheckSnapshot(options)`, and `applyBackgroundCheckSnapshot(churchId, snapshot)`.
- Produces: `refreshBackgroundCheckStatuses(churchId, overrides?)` returning either `{ skipped: 'tracking_disabled', updated: 0 }` or the aggregate apply result; `invalidateBackgroundCheckStatusCache(churchId?)` for deterministic tests and reconnect/disconnect invalidation.

- [ ] **Step 1: Write failing gate, cache, and failure-cache tests**

Append tests using dependency injection rather than live credentials:

```js
const {
  refreshBackgroundCheckStatuses,
  invalidateBackgroundCheckStatusCache,
} = require('./backgroundCheckSync');

test('refresh skips token and provider reads when tracking is disabled', async () => {
  invalidateBackgroundCheckStatusCache();
  let tokenReads = 0;
  const result = await refreshBackgroundCheckStatuses('church-a', {
    isTrackingEnabled: async () => false,
    withToken: async () => { tokenReads += 1; },
  });
  assert.deepEqual(result, { skipped: 'tracking_disabled', updated: 0 });
  assert.equal(tokenReads, 0);
});

test('refresh coalesces concurrent work and re-applies a recent successful snapshot', async () => {
  invalidateBackgroundCheckStatusCache();
  let providerReads = 0;
  let localApplies = 0;
  const remoteSnapshot = {
    fetchedAt: '2026-08-03T05:00:00.000Z', complete: true,
    people: [{ id: 'p1', passedBackgroundCheck: true }],
  };
  const overrides = {
    isTrackingEnabled: async () => true,
    now: () => 1_000,
    withToken: async (_churchId, operation) => operation('token'),
    fetchSnapshot: async () => { providerReads += 1; return remoteSnapshot; },
    applySnapshot: async () => {
      localApplies += 1;
      return { fetchedAt: remoteSnapshot.fetchedAt, updated: 1, cleared: 1, notCleared: 0, unknown: 0 };
    },
  };

  await Promise.all([
    refreshBackgroundCheckStatuses('church-a', overrides),
    refreshBackgroundCheckStatuses('church-a', overrides),
  ]);
  await refreshBackgroundCheckStatuses('church-a', { ...overrides, now: () => 30_000 });

  assert.equal(providerReads, 1);
  assert.equal(localApplies, 2);
});

test('refresh does not cache a failed provider read', async () => {
  invalidateBackgroundCheckStatusCache();
  let providerReads = 0;
  const overrides = {
    isTrackingEnabled: async () => true,
    withToken: async (_churchId, operation) => operation('token'),
    fetchSnapshot: async () => {
      providerReads += 1;
      if (providerReads === 1) throw new Error('temporary PCO failure');
      return { fetchedAt: '2026-08-03T05:00:00.000Z', complete: true, people: [] };
    },
    applySnapshot: async () => ({ fetchedAt: '2026-08-03T05:00:00.000Z', updated: 0, cleared: 0, notCleared: 0, unknown: 0 }),
  };
  await assert.rejects(refreshBackgroundCheckStatuses('church-a', overrides), /temporary PCO failure/);
  await refreshBackgroundCheckStatuses('church-a', overrides);
  assert.equal(providerReads, 2);
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

```bash
docker exec church_attendance_server_dev node --test services/planningCenter/backgroundCheckSync.test.js
```

Expected: FAIL because the refresh coordinator exports do not exist.

- [ ] **Step 3: Implement the refresh coordinator**

Add module-level state and defaults:

```js
const { isBackgroundCheckTrackingEnabled } = require('./mode');

const SUCCESS_CACHE_TTL_MS = 60 * 1000;
const successfulSnapshots = new Map();
const refreshInFlight = new Map();

function invalidateBackgroundCheckStatusCache(churchId) {
  if (churchId) successfulSnapshots.delete(churchId);
  else successfulSnapshots.clear();
}

async function defaultWithToken(churchId, operation) {
  return require('../planningCenterSync').withPlanningCenterSourceToken(churchId, operation);
}

async function refreshBackgroundCheckStatuses(churchId, overrides = {}) {
  const isTrackingEnabled = overrides.isTrackingEnabled || isBackgroundCheckTrackingEnabled;
  if (!(await isTrackingEnabled(churchId))) {
    return { skipped: 'tracking_disabled', updated: 0 };
  }

  const now = overrides.now || Date.now;
  const applySnapshot = overrides.applySnapshot || applyBackgroundCheckSnapshot;
  const cached = successfulSnapshots.get(churchId);
  if (cached && now() - cached.cachedAt < SUCCESS_CACHE_TTL_MS) {
    return applySnapshot(churchId, cached.snapshot);
  }
  if (refreshInFlight.has(churchId)) {
    return refreshInFlight.get(churchId);
  }

  const withToken = overrides.withToken || defaultWithToken;
  const fetchSnapshot = overrides.fetchSnapshot || fetchBackgroundCheckSnapshot;
  const refreshPromise = (async () => {
    const snapshot = await withToken(
      churchId,
      (accessToken) => fetchSnapshot({ accessToken })
    );
    successfulSnapshots.set(churchId, { snapshot, cachedAt: now() });
    return applySnapshot(churchId, snapshot);
  })();
  refreshInFlight.set(churchId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    refreshInFlight.delete(churchId);
  }
}
```

Export both new functions. Do not catch provider errors here; the orchestration boundary owns non-fatal classification and logging.

- [ ] **Step 4: Run all background-check service tests**

```bash
docker exec church_attendance_server_dev node --test services/planningCenter/backgroundCheckSync.test.js services/planningCenter/backgroundCheckSync.dbintegration.test.js
```

Expected: PASS. Confirm the disabled case performs zero token/provider calls and the failed fetch is retried.

- [ ] **Step 5: Commit the refresh coordinator**

```bash
git add server/services/planningCenter/backgroundCheckSync.js server/services/planningCenter/backgroundCheckSync.test.js
git commit -m "fix(pco): coordinate background-check refreshes"
```

---

### Task 4: Wire best-effort refresh into both real apply paths

**Files:**
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`

**Interfaces:**
- Consumes: `refreshBackgroundCheckStatuses(churchId)` from Task 3.
- Produces: applied/run counts `backgroundCheckSynced` and `backgroundCheckSyncFailed`; no provider call for previews or non-PCO providers.

- [ ] **Step 1: Make the unit-test dependency map safe by default**

In `makeDeps`, add a no-network default:

```js
refreshBackgroundCheckStatuses: async () => ({
  fetchedAt: '2026-08-03T05:00:00.000Z',
  updated: 0, cleared: 0, notCleared: 0, unknown: 0,
}),
```

This prevents existing provider-neutral tests from reaching a real church database or PCO connection after production wiring is added.

- [ ] **Step 2: Add a PCO fixture helper and failing behavior tests**

Add a focused helper near `makeDeps`:

```js
function pcoApplyDeps(extra = {}) {
  const pcoSource = { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' };
  return makeDeps({
    batches: [batch({ id: 1, provider: 'planning_center', source: pcoSource })],
    authorityState: { active: 'planning_center', pending: null },
    extra: {
      getProvider: () => ({
        provider: 'planning_center',
        validateConnection: async () => ({ ok: true }),
        listSources: async () => [],
        fetchSourceSnapshot: async () => ({
          provider: 'planning_center', source: pcoSource, complete: true,
          fetchedAt: '2026-08-03T04:00:00.000Z', providerRefreshedAt: null,
          memberExternalIds: ['pco-1'],
          people: [person('pco-1')], contextPeople: [], families: [],
        }),
        isLifecycleEligible: () => true,
      }),
      ...extra,
    },
  });
}
```

Add these tests:

```js
test('reviewed PCO apply refreshes supplementary background checks after roster apply', async () => {
  const order = [];
  const { deps, finished } = pcoApplyDeps({
    applyPeopleSyncPlan: async () => { order.push('apply'); return emptyApplyResult(); },
    refreshBackgroundCheckStatuses: async () => {
      order.push('background');
      return { fetchedAt: '2026-08-03T05:00:00.000Z', updated: 7, cleared: 3, notCleared: 2, unknown: 2 };
    },
  });
  const result = await applyReviewed({
    churchId: 'church-a', provider: 'planning_center', batchId: 1,
    reviewToken: 'valid-review', selections: {}, userId: 1,
  }, deps);

  assert.deepEqual(order, ['apply', 'background']);
  assert.equal(result.applied.backgroundCheckSynced, 7);
  assert.equal(result.applied.backgroundCheckSyncFailed, 0);
  assert.equal(finished[0].counts.backgroundCheckSynced, 7);
});

test('unattended PCO apply refreshes background checks once', async () => {
  let refreshes = 0;
  const { deps } = pcoApplyDeps({
    refreshBackgroundCheckStatuses: async () => {
      refreshes += 1;
      return { fetchedAt: '2026-08-03T05:00:00.000Z', updated: 5, cleared: 5, notCleared: 0, unknown: 0 };
    },
  });
  const result = await runUnattended({
    churchId: 'church-a', provider: 'planning_center', batchId: 1,
  }, deps);
  assert.equal(refreshes, 1);
  assert.equal(result.counts.backgroundCheckSynced, 5);
});

test('background-check failure cannot fail an already-applied PCO run', async () => {
  const { deps, finished, failed } = pcoApplyDeps({
    refreshBackgroundCheckStatuses: async () => { throw new Error('supplementary read failed'); },
  });
  const result = await runUnattended({
    churchId: 'church-a', provider: 'planning_center', batchId: 1,
  }, deps);
  assert.equal(result.status, 'applied');
  assert.equal(result.counts.backgroundCheckSynced, 0);
  assert.equal(result.counts.backgroundCheckSyncFailed, 1);
  assert.equal(finished[0].status, 'applied');
  assert.equal(failed.length, 0);
});

test('Elvanto apply and PCO preview do not refresh background checks', async () => {
  let refreshes = 0;
  const elvanto = makeDeps({ extra: {
    refreshBackgroundCheckStatuses: async () => { refreshes += 1; },
  } });
  await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, elvanto.deps);

  const pco = pcoApplyDeps({
    refreshBackgroundCheckStatuses: async () => { refreshes += 1; },
  });
  await buildReview({
    churchId: 'church-a', provider: 'planning_center', batchId: 1, trigger: 'manual',
  }, pco.deps);
  assert.equal(refreshes, 0);
});
```

- [ ] **Step 3: Run the orchestrator test to verify the new cases fail**

```bash
docker exec church_attendance_server_dev node --test services/peopleSync/orchestrator.test.js
```

Expected: the new PCO apply tests fail because no supplementary post-apply hook exists.

- [ ] **Step 4: Add a dependency-injected, non-throwing PCO helper**

Import the production service near the other orchestrator dependencies:

```js
const backgroundCheckSync = require('../planningCenter/backgroundCheckSync');
```

Add this property to `defaultDeps`:

```js
refreshBackgroundCheckStatuses: backgroundCheckSync.refreshBackgroundCheckStatuses,
```

Add a helper beside `safeSummarizePlan`:

```js
async function safeSyncProviderExtras(deps, { churchId, provider, runId }) {
  if (provider !== 'planning_center') {
    return { backgroundCheckSynced: 0, backgroundCheckSyncFailed: 0 };
  }
  try {
    const result = await deps.refreshBackgroundCheckStatuses(churchId);
    return {
      backgroundCheckSynced: Number(result?.updated) || 0,
      backgroundCheckSyncFailed: 0,
    };
  } catch (error) {
    logger.warn(
      `peopleSync orchestrator: background-check refresh failed for church ${churchId} run ${runId}: ${safeErrorMessage(error)}`
    );
    return { backgroundCheckSynced: 0, backgroundCheckSyncFailed: 1 };
  }
}
```

In both `applyReviewed` and `runUnattended`, immediately after leaving the
try/catch that contains `applyPeopleSyncPlan`, merge the result before calling
`finishAppliedRun`:

```js
applyResult = {
  ...applyResult,
  ...(await safeSyncProviderExtras(deps, {
    churchId, provider, runId: run.id,
  })),
};
```

Do not put this call inside the pre-commit failure catch. The roster apply has
already committed, so supplementary failure must remain in the best-effort
tail.

- [ ] **Step 5: Run orchestrator tests**

```bash
docker exec church_attendance_server_dev node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js
```

Expected: PASS. Verify that the failure case finishes the run as `applied`, has no `failRun` record, and reports `backgroundCheckSyncFailed: 1`.

- [ ] **Step 6: Commit orchestration wiring**

```bash
git add server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js
git commit -m "fix(pco): refresh background checks after real syncs"
```

---

### Task 5: Focused regression suite and Kingston verification

**Files:**
- Verify only; no production file should change unless a test exposes a defect in Tasks 1-4.

**Interfaces:**
- Consumes: the complete implementation from Tasks 1-4.
- Produces: evidence that the fix works for the real Kingston data shape without exposing personal data.

- [ ] **Step 1: Prove the old orphan and narrow-source assumptions are gone**

Run:

```bash
rg -n "syncBackgroundCheckStatuses|backgroundCheckSync" server/services server/routes
rg -n "passed_background_check" server/services/planningCenter
```

Expected:

- no obsolete `syncBackgroundCheckStatuses` references;
- production references to `backgroundCheckSync` from the orchestrator;
- account-wide projection plus existing List projection both retain the PCO boolean.

- [ ] **Step 2: Run the complete focused server suite**

```bash
docker exec church_attendance_server_dev node --test \
  services/planningCenter/backgroundCheckSync.test.js \
  services/planningCenter/backgroundCheckSync.dbintegration.test.js \
  services/planningCenter/readClient.test.js \
  services/planningCenter/projection.test.js \
  services/peopleSync/orchestrator.test.js \
  services/peopleSync/orchestrator.dbintegration.test.js
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Capture Kingston’s aggregate pre-sync baseline**

Run this read-only query in the server container:

```bash
docker exec church_attendance_server_dev node -e "const D=require('better-sqlite3');const db=new D('/app/data/churches/kin_29b2699f71b1.sqlite',{readonly:true});const row=db.prepare(\"SELECT COUNT(*) total,SUM(CASE WHEN planning_center_id IS NOT NULL AND planning_center_id<>'' THEN 1 ELSE 0 END) pco_ids,SUM(CASE WHEN pco_background_check_cleared=1 THEN 1 ELSE 0 END) cleared,SUM(CASE WHEN pco_background_check_cleared=0 THEN 1 ELSE 0 END) not_cleared,SUM(CASE WHEN pco_background_check_cleared IS NULL THEN 1 ELSE 0 END) unknown FROM individuals WHERE church_id=?\").get('kin_29b2699f71b1');console.log(JSON.stringify(row,null,2));db.close();"
```

Expected before the fix is exercised: all Kingston statuses remain unknown. Record aggregate counts only; do not print names or PCO IDs.

- [ ] **Step 4: Run one reviewed Kingston PCO reconciliation**

In Settings → Integrations → Planning Center, open either enabled batch, review the generated plan, and apply it. Do not use a blind/unreviewed path. The roster plan must complete as `applied` or `review_required` according to its normal held-item rules; background-check refresh must not bypass any review decision.

- [ ] **Step 5: Verify Kingston aggregate post-sync status**

Repeat the Step 3 query.

Expected:

- `pco_ids` is unchanged except for legitimate reviewed roster links/additions;
- `cleared + not_cleared + unknown = pco_ids` for PCO-linked rows when the query is restricted to those rows;
- at least one of `cleared` or `not_cleared` is non-zero if PCO returned boolean statuses;
- active and archived PCO-ID-only individuals were eligible for updates;
- no names, raw PCO IDs, credentials, or detailed check records were logged.

- [ ] **Step 6: Confirm unrelated worktree changes remain untouched**

```bash
git status --short
git diff -- client/src/pages/PeoplePage.tsx client/src/pages/PeoplePage.externalSource.test.tsx
```

Expected: any pre-existing user changes to those files are byte-for-byte unchanged by this implementation.

- [ ] **Step 7: Record final verification in the handoff**

Report:

- focused test command and pass count;
- aggregate Kingston before/after counts;
- whether the real PCO refresh succeeded;
- any `backgroundCheckSyncFailed` audit value;
- confirmation that no frontend, schema, dependency, or unrelated People-page files changed.

Do not create an extra verification commit when no files changed.
