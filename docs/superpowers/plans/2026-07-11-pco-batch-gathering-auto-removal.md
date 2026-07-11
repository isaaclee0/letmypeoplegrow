# PCO Batch Gathering Auto-Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each PCO sync batch an opt-in toggle that removes people from its assigned gathering the moment they stop matching the batch's filter — but only people that batch itself put there.

**Architecture:** A new nullable `added_by_pco_batch_id` column on `gathering_lists` records which batch (if any) added a roster row; every batch insert stamps it unconditionally, and a new opt-in removal step in `apply.js` deletes only the rows it owns that no longer belong. A one-time backfill runs when a batch's toggle flips from off to on, claiming ownership of already-matching rows so existing drift gets caught too, not just future drift.

**Tech Stack:** Node.js/Express, better-sqlite3 (SQLite), `node:test` for server unit tests, React/TypeScript client.

**Spec:** `docs/superpowers/specs/2026-07-11-pco-batch-gathering-auto-removal-design.md`

---

## Task 1: Schema — new columns for fresh and existing church databases

**Files:**
- Modify: `server/config/schema.js:226-259` (the `gathering_lists` and `planning_center_sync_batches` `CREATE TABLE` statements)
- Modify: `server/config/database.js:283-284` (the per-church migration block in `getChurchDb`)

- [ ] **Step 1: Add the columns to the fresh-install schema**

In `server/config/schema.js`, update the `gathering_lists` table (currently lines 226-237) to add `added_by_pco_batch_id`:

```sql
CREATE TABLE IF NOT EXISTS gathering_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gathering_type_id INTEGER NOT NULL,
  individual_id INTEGER NOT NULL,
  added_by INTEGER,
  church_id TEXT,
  added_at TEXT DEFAULT (datetime('now')),
  added_by_pco_batch_id INTEGER,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (added_by_pco_batch_id) REFERENCES planning_center_sync_batches(id) ON DELETE SET NULL,
  UNIQUE(gathering_type_id, individual_id)
);
CREATE INDEX IF NOT EXISTS idx_gl_gathering ON gathering_lists(gathering_type_id);
CREATE INDEX IF NOT EXISTS idx_gl_individual ON gathering_lists(individual_id);
```

And the `planning_center_sync_batches` table (currently lines 241-259) to add `gathering_auto_remove_enabled`:

```sql
CREATE TABLE IF NOT EXISTS planning_center_sync_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  name TEXT NOT NULL,
  membership_filter_enabled INTEGER DEFAULT 0,
  membership_allowlist TEXT,
  field_filter_enabled INTEGER DEFAULT 0,
  field_filters TEXT,
  default_people_type TEXT DEFAULT 'regular' CHECK(default_people_type IN ('regular', 'local_visitor', 'traveller_visitor')),
  gathering_type_id INTEGER,
  gathering_auto_remove_enabled INTEGER DEFAULT 0,
  schedule_enabled INTEGER DEFAULT 0,
  schedule_frequency TEXT DEFAULT 'weekly',
  schedule_day INTEGER DEFAULT 1,
  last_sync_at TEXT,
  last_sync_result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pcsb_church ON planning_center_sync_batches(church_id);
```

- [ ] **Step 2: Add the migration for existing church databases**

In `server/config/database.js`, the `if (!isNew)` block in `getChurchDb` already guarantees `planning_center_sync_batches` exists by the time it reaches the end (it's created a few lines earlier if missing — see the `if (!existingTables.includes('planning_center_sync_batches'))` block ending at line 283). Insert this right after that block closes, before `churchDbs.set(churchId, db);` (currently line 286):

```js
      // Migrate planning_center_sync_batches: gathering auto-remove toggle
      const pcsbCols = db.prepare('PRAGMA table_info(planning_center_sync_batches)').all();
      if (!pcsbCols.some(c => c.name === 'gathering_auto_remove_enabled')) {
        db.exec('ALTER TABLE planning_center_sync_batches ADD COLUMN gathering_auto_remove_enabled INTEGER DEFAULT 0');
      }

      // Migrate gathering_lists: batch-ownership tracking for auto-remove
      const glCols = db.prepare('PRAGMA table_info(gathering_lists)').all();
      if (!glCols.some(c => c.name === 'added_by_pco_batch_id')) {
        db.exec('ALTER TABLE gathering_lists ADD COLUMN added_by_pco_batch_id INTEGER REFERENCES planning_center_sync_batches(id) ON DELETE SET NULL');
      }
```

- [ ] **Step 3: Verify against the running dev database**

The dev server (`docker-compose.dev.yml`) mounts `./server:/app` and runs `npm run dev` (nodemon), so saving these files triggers an automatic restart — no rebuild needed since no dependency changed. Bring the stack up if it isn't already running, then confirm the restart happened cleanly:

```bash
docker-compose -f docker-compose.dev.yml up -d
docker-compose -f docker-compose.dev.yml logs -f server
```

Expected: no errors on restart (watch for `SQLITE_ERROR` or a nodemon crash loop). Leave it running, then in a second terminal inspect an existing church's database file to confirm both columns landed (replace `devch1` with whatever dev church id exists under `server/data/churches/`):

```bash
docker-compose -f docker-compose.dev.yml exec server sh -c "sqlite3 /app/data/churches/devch1.sqlite \"PRAGMA table_info(planning_center_sync_batches);\" | grep gathering_auto_remove_enabled"
docker-compose -f docker-compose.dev.yml exec server sh -c "sqlite3 /app/data/churches/devch1.sqlite \"PRAGMA table_info(gathering_lists);\" | grep added_by_pco_batch_id"
```

Expected: both `grep` commands print a matching row (proving the column exists).

- [ ] **Step 4: Commit**

```bash
git add server/config/schema.js server/config/database.js
git commit -m "feat(pco): add schema columns for batch gathering auto-removal"
```

---

## Task 2: Pure removal-diff helper in `apply.js` (TDD)

**Files:**
- Modify: `server/services/planningCenter/apply.js` (add a new exported function; no other logic changes in this task)
- Test: `server/services/planningCenter/apply.test.js`

This isolates the one piece of new logic that's pure computation (no DB access) so it can be unit-tested the same way `groupAdds` already is in this file — the surrounding DB read/delete glue is wired in Task 3 and isn't unit-tested, matching how the rest of `applyPlan` already isn't (only `groupAdds` and an existence check for `applyArchiveExtras` are tested today).

- [ ] **Step 1: Write the failing tests**

Add to `server/services/planningCenter/apply.test.js` (after the existing `groupAdds` tests, before the `applyArchiveExtras` existence check):

```js
const { groupAdds, applyArchiveExtras, computeGatheringRemovals } = require('./apply');
```

(This replaces the existing `const { groupAdds, applyArchiveExtras } = require('./apply');` on line 3.)

```js
test('computeGatheringRemovals keeps only ids not in the touched set', () => {
  const owned = [1, 2, 3];
  const touched = new Set([2]);
  assert.deepStrictEqual(computeGatheringRemovals(owned, touched), [1, 3]);
});

test('computeGatheringRemovals returns empty when everyone owned is still touched', () => {
  assert.deepStrictEqual(computeGatheringRemovals([1, 2], new Set([1, 2])), []);
});

test('computeGatheringRemovals returns everyone owned when the touched set is empty', () => {
  assert.deepStrictEqual(computeGatheringRemovals([5, 6], new Set()), [5, 6]);
});

test('computeGatheringRemovals returns empty for an empty owned list', () => {
  assert.deepStrictEqual(computeGatheringRemovals([], new Set([1])), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/apply.test.js
```

Expected: FAIL — `computeGatheringRemovals is not a function` (it isn't exported yet).

- [ ] **Step 3: Implement the function**

In `server/services/planningCenter/apply.js`, add this function above `applyPlan` (after the existing `groupAdds` function, before the `applyPlan` declaration):

```js
// Pure diff for batch-gathering auto-removal: given the individualIds a batch
// currently owns on its assigned gathering (added_by_pco_batch_id = this batch),
// and the individualIds that should be there after this run (touchedIndividualIds,
// which already includes gatheringEligible + freshly linked/restored/added people —
// see applyPlan), return the owned ids that are no longer in that set. Pure so it
// can be unit-tested without a database; the DB read/delete wiring lives in
// applyPlan itself (see Task 3 of the gathering-auto-removal plan).
function computeGatheringRemovals(ownedIndividualIds, touchedIndividualIds) {
  return ownedIndividualIds.filter((id) => !touchedIndividualIds.has(id));
}
```

Update the module exports at the bottom of the file:

```js
module.exports = { applyPlan, groupAdds, applyArchiveExtras, computeGatheringRemovals };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/apply.test.js
```

Expected: PASS — all `computeGatheringRemovals` tests plus the pre-existing `groupAdds`/`applyArchiveExtras` tests green.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/apply.js server/services/planningCenter/apply.test.js
git commit -m "feat(pco): add pure gathering-removal diff helper"
```

---

## Task 3: Wire ownership tagging and removal into `applyPlan`

**Files:**
- Modify: `server/services/planningCenter/apply.js:26-43` (function signature / setup), `:210-221` (gathering-assignment block)

- [ ] **Step 1: Destructure the new batchConfig fields and initialize the new result counter**

In `applyPlan`, change:

```js
async function applyPlan(churchId, plan, userId, selections = {}, batchConfig = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, gatheringAssigned: 0, familyNamesUpdated: 0, errors: [] };
```

to:

```js
async function applyPlan(churchId, plan, userId, selections = {}, batchConfig = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, gatheringAssigned: 0, gatheringRemoved: 0, familyNamesUpdated: 0, errors: [] };
```

And after the existing `const gatheringTypeId = batchConfig.gatheringTypeId || null;` line, add:

```js
  const batchId = batchConfig.batchId || null;
  const gatheringAutoRemoveEnabled = !!batchConfig.gatheringAutoRemoveEnabled;
```

- [ ] **Step 2: Tag ownership on every insert, and add the removal step**

Replace the existing gathering-assignment block:

```js
  if (gatheringTypeId) {
    for (const individualId of touchedIndividualIds) {
      try {
        const insertResult = await Database.query(
          `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
           VALUES (?, ?, ?, ?) ON CONFLICT(gathering_type_id, individual_id) DO NOTHING`,
          [gatheringTypeId, individualId, userId, churchId]
        );
        if (insertResult.affectedRows > 0) result.gatheringAssigned++;
      } catch (e) { result.errors.push({ type: 'gatheringAssign', id: individualId, error: e.message }); }
    }
  }
```

with:

```js
  if (gatheringTypeId) {
    // Tag ownership unconditionally (even if this batch's auto-remove toggle is
    // off) — cheap, and it means a batch that gets the toggle turned on later
    // already has partial ownership data from everything synced since this
    // feature shipped, without needing a fresh backfill for those rows.
    for (const individualId of touchedIndividualIds) {
      try {
        const insertResult = await Database.query(
          `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id, added_by_pco_batch_id)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(gathering_type_id, individual_id) DO NOTHING`,
          [gatheringTypeId, individualId, userId, churchId, batchId]
        );
        if (insertResult.affectedRows > 0) result.gatheringAssigned++;
      } catch (e) { result.errors.push({ type: 'gatheringAssign', id: individualId, error: e.message }); }
    }

    // Remove people this batch itself added to this gathering who no longer
    // belong — only when the batch has opted in. ON CONFLICT DO NOTHING above
    // means ownership is first-writer-wins, so this only ever touches rows this
    // exact batch is responsible for; manual additions and other batches' rows
    // are untouched (added_by_pco_batch_id won't match this batch's id).
    if (gatheringAutoRemoveEnabled && batchId) {
      const ownedRows = await Database.query(
        `SELECT individual_id FROM gathering_lists
          WHERE gathering_type_id = ? AND added_by_pco_batch_id = ? AND church_id = ?`,
        [gatheringTypeId, batchId, churchId]
      );
      const toRemove = computeGatheringRemovals(ownedRows.map((r) => r.individual_id), touchedIndividualIds);
      for (const individualId of toRemove) {
        try {
          const delResult = await Database.query(
            `DELETE FROM gathering_lists
              WHERE gathering_type_id = ? AND individual_id = ? AND added_by_pco_batch_id = ? AND church_id = ?`,
            [gatheringTypeId, individualId, batchId, churchId]
          );
          if (delResult.affectedRows > 0) result.gatheringRemoved++;
        } catch (e) { result.errors.push({ type: 'gatheringRemove', id: individualId, error: e.message }); }
      }
    }
  }
```

- [ ] **Step 3: Confirm the module still starts cleanly**

`applyPlan` itself has no existing DB-backed unit tests to run (consistent with the rest of this file — only pure helpers are unit-tested), so verification here is a syntax/require smoke check rather than a test run:

```bash
docker-compose -f docker-compose.dev.yml exec server node -e "require('./services/planningCenter/apply.js'); console.log('apply.js loads OK');"
```

Expected: prints `apply.js loads OK` with no stack trace.

- [ ] **Step 4: Commit**

```bash
git add server/services/planningCenter/apply.js
git commit -m "feat(pco): tag gathering rows with owning batch, add opt-in removal"
```

---

## Task 4: Thread the new fields through `planningCenterSync.js`

**Files:**
- Modify: `server/services/planningCenterSync.js` (`rowToBatch`, `BATCH_SELECT`, `runBatchSync`)

- [ ] **Step 1: Add the column to `rowToBatch` and `BATCH_SELECT`**

In `rowToBatch` (`server/services/planningCenterSync.js:276-298`), add the new field right after `gatheringTypeId`:

```js
    gatheringTypeId: row.gatheringTypeId || null,
    gatheringAutoRemoveEnabled: !!row.gatheringAutoRemoveEnabled,
```

In `BATCH_SELECT` (`server/services/planningCenterSync.js:300-311`), add the column alias right after `gathering_type_id AS gatheringTypeId,`:

```js
         gathering_type_id AS gatheringTypeId,
         gathering_auto_remove_enabled AS gatheringAutoRemoveEnabled,
```

- [ ] **Step 2: Pass the new fields through `runBatchSync` and record the new counter**

In `runBatchSync` (`server/services/planningCenterSync.js:395-431`), change the `applyForChurch` call:

```js
    const result = await applyForChurch(churchId, plan, userId, { skipFamilyNameUpdateIds }, {
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
    });
```

to:

```js
    const result = await applyForChurch(churchId, plan, userId, { skipFamilyNameUpdateIds }, {
      batchId: batch.id,
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
      gatheringAutoRemoveEnabled: batch.gatheringAutoRemoveEnabled,
    });
```

And add `gatheringRemoved` to the `summary` object right after `gatheringAssigned`:

```js
      gatheringAssigned: result.gatheringAssigned,
      gatheringRemoved: result.gatheringRemoved,
```

- [ ] **Step 3: Verify the module loads and the dev server is healthy**

```bash
docker-compose -f docker-compose.dev.yml exec server node -e "require('./services/planningCenterSync.js'); console.log('planningCenterSync.js loads OK');"
docker-compose -f docker-compose.dev.yml logs --tail=50 server
```

Expected: `planningCenterSync.js loads OK`, and the log tail shows the nodemon restart succeeded with no stack trace.

- [ ] **Step 4: Commit**

```bash
git add server/services/planningCenterSync.js
git commit -m "feat(pco): thread gatheringAutoRemoveEnabled through batch sync"
```

---

## Task 5: Server API surface — validation, create/update/apply routes

**Files:**
- Modify: `server/routes/integrations.js` (`validateBatchBody`, `POST /planning-center/sync-batches`, `PUT /planning-center/sync-batches/:id`, `POST /planning-center/sync-batches/:id/apply`)

- [ ] **Step 1: Validate the new field**

In `validateBatchBody` (`server/routes/integrations.js:2159-2189`), add `gatheringAutoRemoveEnabled` to the destructure:

```js
function validateBatchBody(body) {
  const { name, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters,
          defaultPeopleType, gatheringTypeId, gatheringAutoRemoveEnabled, scheduleEnabled, scheduleFrequency, scheduleDay } = body;
```

And add a check right after the existing `gatheringTypeId` check:

```js
  if (gatheringTypeId !== null && gatheringTypeId !== undefined && !Number.isInteger(gatheringTypeId)) {
    return 'gatheringTypeId must be an integer or null.';
  }
  if (typeof gatheringAutoRemoveEnabled !== 'boolean') return 'gatheringAutoRemoveEnabled must be a boolean.';
```

- [ ] **Step 2: Persist it on create**

In `POST /planning-center/sync-batches` (`server/routes/integrations.js:2227-2249`), update the destructure, INSERT column list, and values array:

```js
    const { name, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters,
            defaultPeopleType, gatheringTypeId, gatheringAutoRemoveEnabled, scheduleEnabled, scheduleFrequency, scheduleDay } = req.body;
    const insRes = await Database.query(
      `INSERT INTO planning_center_sync_batches
         (church_id, name, membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters,
          default_people_type, gathering_type_id, gathering_auto_remove_enabled, schedule_enabled, schedule_frequency, schedule_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [churchId, name.trim(), membershipFilterEnabled ? 1 : 0, JSON.stringify(membershipAllowlist),
       fieldFilterEnabled ? 1 : 0, JSON.stringify(fieldFilters), defaultPeopleType, gatheringTypeId || null,
       gatheringAutoRemoveEnabled ? 1 : 0, scheduleEnabled ? 1 : 0, scheduleFrequency, scheduleDay]
    );
```

- [ ] **Step 3: Persist it on update**

In `PUT /planning-center/sync-batches/:id` (`server/routes/integrations.js:2252-2279`), update the destructure and UPDATE statement:

```js
    const { name, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters,
            defaultPeopleType, gatheringTypeId, gatheringAutoRemoveEnabled, scheduleEnabled, scheduleFrequency, scheduleDay } = req.body;
    await Database.query(
      `UPDATE planning_center_sync_batches
          SET name = ?, membership_filter_enabled = ?, membership_allowlist = ?,
              field_filter_enabled = ?, field_filters = ?, default_people_type = ?,
              gathering_type_id = ?, gathering_auto_remove_enabled = ?, schedule_enabled = ?, schedule_frequency = ?, schedule_day = ?,
              updated_at = datetime('now')
        WHERE id = ? AND church_id = ?`,
      [name.trim(), membershipFilterEnabled ? 1 : 0, JSON.stringify(membershipAllowlist),
       fieldFilterEnabled ? 1 : 0, JSON.stringify(fieldFilters), defaultPeopleType, gatheringTypeId || null,
       gatheringAutoRemoveEnabled ? 1 : 0, scheduleEnabled ? 1 : 0, scheduleFrequency, scheduleDay, batchId, churchId]
    );
```

(Leave the rest of the route — the `existing`/`batch` lookups — as-is for now; Task 6 adds the backfill logic in between the UPDATE and the response.)

- [ ] **Step 4: Thread it through the manual apply route**

In `POST /planning-center/sync-batches/:id/apply` (`server/routes/integrations.js:2391-2405`), update the `applyForChurch` call and summary:

```js
    const result = await pcoSync.applyForChurch(churchId, plan, userId, selections, {
      batchId: batch.id,
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
      gatheringAutoRemoveEnabled: batch.gatheringAutoRemoveEnabled,
    });

    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      gatheringAssigned: result.gatheringAssigned,
      gatheringRemoved: result.gatheringRemoved,
      familyNamesUpdated: result.familyNamesUpdated,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      errors: result.errors.length,
    };
```

- [ ] **Step 5: Verify via the running dev API**

```bash
docker-compose -f docker-compose.dev.yml logs --tail=50 server
```

Expected: nodemon restarted cleanly, no stack trace. Full end-to-end exercise of these routes (create/update a batch with the new field, confirm it persists) happens in Task 10 once the client can drive it — a bare `curl` here would need a real auth cookie and church context, which isn't worth wiring up standalone.

- [ ] **Step 6: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): add gatheringAutoRemoveEnabled to batch API surface"
```

---

## Task 6: Backfill on toggle-enable

**Files:**
- Modify: `server/routes/integrations.js` (imports, `PUT /planning-center/sync-batches/:id`)

- [ ] **Step 1: Import `isEligible`**

At the top of `server/routes/integrations.js`, add to the existing require block (after the `metadataCache` require):

```js
const { isEligible } = require('../services/planningCenter/eligibility');
```

- [ ] **Step 2: Add the backfill pass to the PUT route**

In `PUT /planning-center/sync-batches/:id`, after the UPDATE and the `const batch = await pcoSync.getBatch(churchId, batchId);` line that follows it, and before `res.json({ success: true, batch });`, add:

```js
    // Backfill: the moment this toggle flips off -> on for a batch with a
    // gathering assigned, claim ownership of existing gathering_lists rows this
    // batch would itself currently add — so stale members already on the roster
    // before this feature (or before this toggle) existed get caught on the very
    // next sync, not just future drift. Rows that don't qualify (unlinked,
    // inactive, or linked-but-non-matching) are left permanently unowned — never
    // a candidate for auto-removal, same protection manual additions get.
    if (!existing.gatheringAutoRemoveEnabled && batch.gatheringAutoRemoveEnabled && batch.gatheringTypeId) {
      const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
      if (accessToken) {
        const { people: pcoPeople } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
        const pcoById = new Map(pcoPeople.map((p) => [p.id, p]));
        const filterConfig = pcoSync.batchFilterConfig(batch);
        const candidates = await Database.query(
          `SELECT gl.id, i.planning_center_id AS pcoId
             FROM gathering_lists gl
             JOIN individuals i ON i.id = gl.individual_id AND i.church_id = gl.church_id
            WHERE gl.gathering_type_id = ? AND gl.added_by_pco_batch_id IS NULL
              AND gl.church_id = ? AND i.planning_center_id IS NOT NULL AND i.is_active = 1`,
          [batch.gatheringTypeId, churchId]
        );
        for (const row of candidates) {
          const person = pcoById.get(row.pcoId);
          if (person && person.status === 'active' && isEligible(person, filterConfig)) {
            await Database.query(
              `UPDATE gathering_lists SET added_by_pco_batch_id = ? WHERE id = ? AND church_id = ?`,
              [batch.id, row.id, churchId]
            );
          }
        }
      }
    }

```

- [ ] **Step 3: Verify the module loads**

```bash
docker-compose -f docker-compose.dev.yml logs --tail=50 server
```

Expected: clean nodemon restart, no `Cannot find module` or syntax error. (Backfill behavior itself is exercised end-to-end in Task 10, since it needs a real PCO connection and existing gathering roster data to observe.)

- [ ] **Step 4: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): backfill gathering ownership when auto-remove is enabled"
```

---

## Task 7: Client types

**Files:**
- Modify: `client/src/services/api.ts:804-834` (`SyncBatchInput`, `SyncBatchLastResult`)

- [ ] **Step 1: Add the new fields to both interfaces**

```ts
export interface SyncBatchInput {
  name: string;
  membershipFilterEnabled: boolean;
  membershipAllowlist: string[];
  fieldFilterEnabled: boolean;
  fieldFilters: { fieldDefinitionId: string; tabName: string | null; fieldName: string; values: string[] }[];
  defaultPeopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  gatheringTypeId: number | null;
  gatheringAutoRemoveEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleFrequency: 'daily' | 'weekly' | 'monthly';
  scheduleDay: number;
}

export interface SyncBatchLastResult {
  at: string;
  added: number;
  updated: number;
  archived: number;
  reactivated: number;
  linked: number;
  gatheringAssigned: number;
  gatheringRemoved: number;
  ambiguous: number;
  visitorMatches: number;
  errors: number;
}
```

(`SyncBatch extends SyncBatchInput` right below picks up `gatheringAutoRemoveEnabled` automatically — no change needed there.)

- [ ] **Step 2: Verify the client still type-checks**

The dev client (`docker-compose.dev.yml`) runs Vite's dev server with hot reload, which surfaces TypeScript errors immediately. Check its logs after saving:

```bash
docker-compose -f docker-compose.dev.yml logs --tail=50 client
```

Expected: no new TypeScript errors (this step only touches type declarations, so nothing should reference the new fields yet — Tasks 8-9 do).

- [ ] **Step 3: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat(pco): add gatheringAutoRemoveEnabled/gatheringRemoved to client types"
```

---

## Task 8: Batch editor UI — checkbox and confirmation

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`

- [ ] **Step 1: Import `Modal` and the confirmation icons**

At the top of the file, add to the imports:

```tsx
import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import Modal from '../Modal';
```

- [ ] **Step 2: Add state for the toggle and the confirmation dialog**

After the existing `gatheringTypeId` state line (`PlanningCenterBatchEditor.tsx:25`), add:

```tsx
  const [gatheringAutoRemoveEnabled, setGatheringAutoRemoveEnabled] = useState(batch?.gatheringAutoRemoveEnabled ?? false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
```

- [ ] **Step 3: Add the toggle request/confirm handlers**

After the `save` function closes (`PlanningCenterBatchEditor.tsx:123`), add:

```tsx
  // Turning this on can immediately remove existing roster members who don't
  // match this batch (via the toggle-enable backfill), so confirm before enabling.
  // Turning it off needs no confirmation — it only stops future removals.
  const requestGatheringAutoRemoveToggle = (value: boolean) => {
    if (value) {
      setShowRemoveConfirm(true);
    } else {
      setGatheringAutoRemoveEnabled(false);
    }
  };

  const confirmEnableGatheringAutoRemove = () => {
    setShowRemoveConfirm(false);
    setGatheringAutoRemoveEnabled(true);
  };
```

- [ ] **Step 4: Include the field in the save payload**

In `save()`, update the `payload` object (`PlanningCenterBatchEditor.tsx:101-112`):

```tsx
      const payload: SyncBatchInput = {
        name: name.trim(),
        membershipFilterEnabled,
        membershipAllowlist,
        fieldFilterEnabled,
        fieldFilters,
        defaultPeopleType,
        gatheringTypeId: finalGatheringTypeId,
        gatheringAutoRemoveEnabled,
        scheduleEnabled,
        scheduleFrequency,
        scheduleDay,
      };
```

- [ ] **Step 5: Add the checkbox under the gathering-assignment section**

After the closing `</div>` of the gathering-assignment block (`PlanningCenterBatchEditor.tsx:192-224`, the block containing the "Add everyone from this batch to a gathering" label) and before the `<div>` that starts the Schedule section (`:226`), add:

```tsx
      {gatheringMode !== 'none' && (
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => requestGatheringAutoRemoveToggle(!gatheringAutoRemoveEnabled)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${gatheringAutoRemoveEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
            role="switch" aria-checked={gatheringAutoRemoveEnabled}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${gatheringAutoRemoveEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
          <span className="text-sm text-gray-700 dark:text-gray-300">
            Automatically remove people from this gathering when they no longer match this batch
          </span>
        </div>
      )}
```

- [ ] **Step 6: Add the confirmation modal**

Right before the closing `</div>` of the component's root `return` (after the `anyRefreshing` block, `PlanningCenterBatchEditor.tsx:306-311`), add:

```tsx
      <Modal isOpen={showRemoveConfirm} onClose={() => setShowRemoveConfirm(false)}>
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Enable automatic removal for this batch?
              </h3>
              <button
                onClick={() => setShowRemoveConfirm(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-yellow-100 dark:bg-yellow-900/30 rounded-full">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600" />
            </div>

            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 text-center">
              This will also remove anyone already on the roster who doesn't currently
              match this batch, next time it syncs.
            </p>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowRemoveConfirm(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmEnableGatheringAutoRemove}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors"
              >
                Enable
              </button>
            </div>
          </div>
        </div>
      </Modal>
```

- [ ] **Step 7: Verify in the browser**

```bash
docker-compose -f docker-compose.dev.yml logs --tail=50 client
```

Expected: no TypeScript/build errors. Then, using the Browser tool, navigate to the dev client, open Settings → Integrations → Planning Center, open (or create) a sync batch, assign it to an existing gathering, and confirm:
- The new checkbox appears only when a gathering is assigned (mode ≠ "none").
- Clicking it on shows the confirmation modal; "Cancel" leaves it off; "Enable" turns it on.
- Clicking it off (once on) needs no confirmation.
- Saving persists the choice (reopen the batch editor and confirm the checkbox reflects the saved state).

- [ ] **Step 8: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterBatchEditor.tsx
git commit -m "feat(pco): add gathering auto-remove toggle to batch editor"
```

---

## Task 9: Surface the removal count in the batch list

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx:384-390`

- [ ] **Step 1: Add the removal clause to the last-run summary line**

Change:

```tsx
                          {batch.lastSyncResult && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              Last run {new Date(batch.lastSyncResult.at).toLocaleString()}: {batch.lastSyncResult.added} added, {batch.lastSyncResult.updated} updated, {batch.lastSyncResult.linked} linked
                              {batch.lastSyncResult.ambiguous ? `, ${batch.lastSyncResult.ambiguous} need review` : ''}
                              {batch.gatheringTypeId && batch.lastSyncResult.gatheringAssigned ? `, ${batch.lastSyncResult.gatheringAssigned} added to gathering` : ''}.
                            </p>
                          )}
```

to:

```tsx
                          {batch.lastSyncResult && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              Last run {new Date(batch.lastSyncResult.at).toLocaleString()}: {batch.lastSyncResult.added} added, {batch.lastSyncResult.updated} updated, {batch.lastSyncResult.linked} linked
                              {batch.lastSyncResult.ambiguous ? `, ${batch.lastSyncResult.ambiguous} need review` : ''}
                              {batch.gatheringTypeId && batch.lastSyncResult.gatheringAssigned ? `, ${batch.lastSyncResult.gatheringAssigned} added to gathering` : ''}
                              {batch.gatheringAutoRemoveEnabled && batch.lastSyncResult.gatheringRemoved ? `, ${batch.lastSyncResult.gatheringRemoved} removed from gathering` : ''}.
                            </p>
                          )}
```

- [ ] **Step 2: Verify in the browser**

```bash
docker-compose -f docker-compose.dev.yml logs --tail=50 client
```

Expected: no build errors. Full behavioral verification (an actual removal producing a nonzero count) happens in Task 10, since it needs a real sync run.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/integrations/PlanningCenterIntegrationPanel.tsx
git commit -m "feat(pco): show gathering-removal count in batch sync summary"
```

---

## Task 10: End-to-end verification

This feature has no automated coverage for the DB-touching paths (schema migration, route handlers, backfill, React components) — consistent with how this codebase already tests this area: only pure functions (`groupAdds`, `computeGatheringRemovals`, `isEligible`, etc.) get `node:test` coverage; everything wired to `Database`/HTTP/React is verified by running the app. This task is that manual pass.

**Prerequisite:** a dev church with Planning Center connected (OAuth), at least one sync batch with a gathering assigned and a filter that currently matches at least one linked person.

- [ ] **Step 1: Confirm the toggle is off by default**

In the browser, open an existing batch that has a gathering assigned. Confirm the new checkbox is present and unchecked (existing batches predate this column, so `gathering_auto_remove_enabled` defaults to `0`).

- [ ] **Step 2: Enable it and confirm the backfill runs**

Before enabling, note (via the People page or a direct sqlite query) someone currently on that batch's gathering who is linked to PCO but does **not** currently match the batch's filter (if none exist yet, temporarily narrow the batch's filter so at least one current roster member falls outside it — e.g. remove a membership category from the allowlist that a rostered person has).

```bash
docker-compose -f docker-compose.dev.yml exec server sh -c "sqlite3 /app/data/churches/<church_id>.sqlite \"SELECT individual_id, added_by_pco_batch_id FROM gathering_lists WHERE gathering_type_id = <gathering_id>;\""
```

Check the checkbox and click "Enable" in the confirmation modal, then save the batch. Re-run the same sqlite query: rows for people who **do** currently match the filter should now show the batch's id in `added_by_pco_batch_id`; the non-matching person's row should remain `NULL` (correctly excluded from backfill, since backfill only claims currently-eligible rows).

- [ ] **Step 3: Trigger a sync run and confirm removal**

Use "Review & sync" (or wait for/trigger the scheduled run) for that batch. After it completes, confirm:
- The non-matching person's `gathering_lists` row is gone (query again).
- The batch's "Last run" summary line in the UI shows a nonzero "N removed from gathering".
- The person is still active and still linked in the People page — only their gathering membership changed, nothing else.

- [ ] **Step 4: Confirm a manually-added person is untouched**

Manually add someone to the same gathering via the People/Gathering roster UI (not through PCO) who would also fail the batch's filter if they were linked to PCO. Run the batch again. Confirm that person is **not** removed (their `gathering_lists` row has `added_by_pco_batch_id IS NULL`, so the removal query never selects it).

- [ ] **Step 5: Confirm turning the toggle off stops removal**

Uncheck the box and save. Make another previously-matching person on the gathering stop matching the filter (or reuse the earlier scenario). Run the batch again. Confirm no one is removed this time, and `result`/summary shows `gatheringRemoved: 0`.

- [ ] **Step 6: No commit for this task** — it's verification only. If any step surfaces a bug, fix it in the relevant task's files and amend that task's commit history with a new commit (don't reopen closed tasks silently).
