# PCO Gathering Assignment for Already-Linked People Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a PCO sync batch has a gathering assigned, every currently-eligible, currently-active person should end up in that gathering's roster on every run — not just people freshly linked/added that run — so someone already linked via a different batch who later becomes eligible for a gathering-targeting batch actually gets added to that gathering.

**Architecture:** `computePlan()` gains a new `gatheringEligible` bucket covering every already-linked individual who's active (or becoming active via reactivation) and eligible for the batch's filter. `applyPlan()` folds those individuals into the same set already used for gathering-roster assignment, and counts genuinely-new roster insertions (via SQLite's `changes`/`affectedRows`) into a new `gatheringAssigned` result field, which then flows through both the on-demand apply route and the scheduled-sync path into the existing "Last run: N added, N updated..." summary line.

**Tech Stack:** Node.js/Express, better-sqlite3, `node:test`, React/TypeScript.

**Reference spec:** `docs/superpowers/specs/2026-07-06-pco-gathering-sync-for-linked-people-design.md`

---

### Task 1: `gatheringEligible` bucket in `computePlan`

**Files:**
- Modify: `server/services/planningCenter/diffEngine.js`
- Test: `server/services/planningCenter/diffEngine.test.js`

- [ ] **Step 1: Write the failing tests**

Add to the end of `server/services/planningCenter/diffEngine.test.js`:

```js
test('gatheringEligible: already-linked, active, eligible person is included', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Church Members' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.gatheringEligible, [{ individualId: 1, pcoId: 'p1' }]);
});

test('gatheringEligible: already-linked, active, NOT eligible person is excluded', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.gatheringEligible, []);
});

test('gatheringEligible: excludes someone being archived this run even if eligible before', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'inactive', membership: 'Church Members' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.archive, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.gatheringEligible, []);
});

test('gatheringEligible: reactivate-and-eligible person appears in both reactivate and gatheringEligible', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Church Members' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.reactivate, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.gatheringEligible, [{ individualId: 1, pcoId: 'p1' }]);
});

test('gatheringEligible: reactivate candidate that is not eligible is excluded from both', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.reactivate, []);
  assert.deepStrictEqual(plan.gatheringEligible, []);
});
```

(`pco()`, `ind()`, and `FILTER` are already defined at the top of this test file —
`FILTER` is `{ membershipFilterEnabled: true, membershipAllowlist: ['Church Members', 'Regular Attenders'], fieldFilterEnabled: false, fieldFilters: [] }`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test services/planningCenter/diffEngine.test.js`
Expected: the 5 new tests FAIL with `plan.gatheringEligible` being `undefined` (`TypeError` or assertion failure comparing `undefined` to an array) — `computePlan` doesn't return this field yet.

- [ ] **Step 3: Implement `gatheringEligible` in `computePlan`**

In `server/services/planningCenter/diffEngine.js`, find:

```js
  // Update / archive / reactivate for already-linked rows (unchanged from before).
  const update = [];
  const archive = [];
  const reactivate = [];
  for (const i of linked) {
    const p = pcoById.get(i.planningCenterId);
    if (!p) continue; // linked person absent from PCO fetch -> leave alone
    if (i.isActive && p.status === 'inactive') {
      archive.push({ individualId: i.id, pcoId: p.id });
    } else if (!i.isActive && p.status === 'active' && isEligible(p, filterConfig)) {
      reactivate.push({ individualId: i.id, pcoId: p.id });
    }
    if (p.firstName !== i.firstName || p.lastName !== i.lastName || p.child !== !!i.isChild) {
      update.push({ individualId: i.id, pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child });
    }
  }
```

Replace with:

```js
  // Update / archive / reactivate for already-linked rows (unchanged from before).
  // gatheringEligible additionally tracks every linked individual who ends this run
  // active and eligible for filterConfig — whether they were already active, or are
  // being reactivated this run — so any batch with a gathering assigned can add them
  // to its roster even though they don't need linking/restoring/adding. It has no
  // effect on any other bucket; it's purely an extra input for gathering-roster
  // assignment in apply.js.
  const update = [];
  const archive = [];
  const reactivate = [];
  const gatheringEligible = [];
  for (const i of linked) {
    const p = pcoById.get(i.planningCenterId);
    if (!p) continue; // linked person absent from PCO fetch -> leave alone
    if (i.isActive && p.status === 'inactive') {
      archive.push({ individualId: i.id, pcoId: p.id });
    } else if (!i.isActive && p.status === 'active' && isEligible(p, filterConfig)) {
      reactivate.push({ individualId: i.id, pcoId: p.id });
      gatheringEligible.push({ individualId: i.id, pcoId: p.id });
    } else if (i.isActive && isEligible(p, filterConfig)) {
      gatheringEligible.push({ individualId: i.id, pcoId: p.id });
    }
    if (p.firstName !== i.firstName || p.lastName !== i.lastName || p.child !== !!i.isChild) {
      update.push({ individualId: i.id, pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child });
    }
  }
```

Then find the `return` statement at the end of `computePlan`:

```js
  return {
    link,
    restore,
    ambiguous: ambiguousEnriched,
    visitorMatches,
    archiveExtras,
    unmatchedVisitors,
    add,
    update,
    archive,
    reactivate,
  };
```

Replace with:

```js
  return {
    link,
    restore,
    ambiguous: ambiguousEnriched,
    visitorMatches,
    archiveExtras,
    unmatchedVisitors,
    add,
    update,
    archive,
    reactivate,
    gatheringEligible,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test services/planningCenter/diffEngine.test.js`
Expected: all tests pass (18 pre-existing + 5 new = 23, 0 failures).

- [ ] **Step 5: Run the full server test suite to check for regressions**

Run: `cd server && node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all tests pass, no failures (109 pre-existing + 5 new = 114).

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenter/diffEngine.js server/services/planningCenter/diffEngine.test.js
git commit -m "feat(pco): add gatheringEligible bucket for already-linked, currently-eligible people"
```

---

### Task 2: Broaden gathering assignment in `applyPlan` and count new rows

**Files:**
- Modify: `server/services/planningCenter/apply.js`

No new automated test in this task — `applyPlan` touches the database directly
(`Database.query`), and this codebase has no tests anywhere that exercise
DB-touching functions (confirmed: `server/services/planningCenter/apply.test.js`
only tests the pure helpers `buildFamilyName`/`groupAdds`, never `applyPlan` itself).
This matches the established convention already followed for `metadataCache.js` and
`getCachedPcoPeople` elsewhere in this codebase. Verified instead in Task 6 (full
regression suite + a safe manual check against a throwaway database, not real church
data).

- [ ] **Step 1: Initialize the new result counter**

In `server/services/planningCenter/apply.js`, find:

```js
async function applyPlan(churchId, plan, userId, selections = {}, batchConfig = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, errors: [] };
```

Replace with:

```js
async function applyPlan(churchId, plan, userId, selections = {}, batchConfig = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, gatheringAssigned: 0, errors: [] };
```

- [ ] **Step 2: Fold `gatheringEligible` into `touchedIndividualIds`**

Find:

```js
  const gatheringTypeId = batchConfig.gatheringTypeId || null;
  // Every individual this run links, restores, promotes, or creates — used to
  // populate the batch's gathering roster (if one is configured) at the end.
  const touchedIndividualIds = new Set();
```

Replace with:

```js
  const gatheringTypeId = batchConfig.gatheringTypeId || null;
  // Every individual this run links, restores, promotes, or creates, PLUS every
  // already-linked individual who's currently active and eligible for this batch's
  // filter (plan.gatheringEligible, from diffEngine.js) — used to populate the
  // batch's gathering roster (if one is configured) at the end. Being in this set
  // doesn't imply any change to the individuals row itself; already-linked/eligible
  // people are added here purely so they end up on the gathering roster even though
  // nothing else about their link/active state needs to change this run.
  const touchedIndividualIds = new Set();
  for (const g of (plan.gatheringEligible || [])) touchedIndividualIds.add(g.individualId);
```

- [ ] **Step 3: Count genuinely-new gathering-roster rows**

Find:

```js
  // Gathering assignment: add everyone this run touched to the batch's gathering roster.
  if (gatheringTypeId) {
    for (const individualId of touchedIndividualIds) {
      try {
        await Database.query(
          `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
           VALUES (?, ?, ?, ?) ON CONFLICT(gathering_type_id, individual_id) DO NOTHING`,
          [gatheringTypeId, individualId, userId, churchId]
        );
      } catch (e) { result.errors.push({ type: 'gatheringAssign', id: individualId, error: e.message }); }
    }
  }
```

Replace with:

```js
  // Gathering assignment: add everyone this run touched (freshly linked/restored/
  // promoted/added, or already-linked-and-currently-eligible via gatheringEligible)
  // to the batch's gathering roster. result.gatheringAssigned only counts rows that
  // were genuinely new this run — affectedRows === 0 means they were already on the
  // roster (ON CONFLICT DO NOTHING is a safe no-op, not an error, not a new count).
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

- [ ] **Step 4: Verify no syntax errors**

Run: `cd server && node --check services/planningCenter/apply.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Run the full server test suite to check for regressions**

Run: `cd server && node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all 114 tests still pass (this task adds no new tests, so the count from
Task 1 doesn't change — this run just confirms nothing broke).

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenter/apply.js
git commit -m "feat(pco): assign already-linked eligible people to the batch's gathering, count new rows"
```

---

### Task 3: Surface `gatheringAssigned` from the on-demand apply route

**Files:**
- Modify: `server/routes/integrations.js`

- [ ] **Step 1: Add the field to the apply route's summary object**

In `server/routes/integrations.js`, find (inside the `router.post('/planning-center/sync-batches/:id/apply', ...)` handler):

```js
    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      errors: result.errors.length,
    };
    await Database.query(
      `UPDATE planning_center_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
      [JSON.stringify(summary), batch.id, churchId]
    );
```

Replace with:

```js
    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      gatheringAssigned: result.gatheringAssigned,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      errors: result.errors.length,
    };
    await Database.query(
      `UPDATE planning_center_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
      [JSON.stringify(summary), batch.id, churchId]
    );
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd server && node --check routes/integrations.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): include gatheringAssigned in the batch apply summary"
```

---

### Task 4: Surface `gatheringAssigned` from the scheduled sync path

**Files:**
- Modify: `server/services/planningCenterSync.js`

- [ ] **Step 1: Add the field to `runBatchSync`'s summary object**

In `server/services/planningCenterSync.js`, find:

```js
async function runBatchSync(churchId, accessToken, batch, userId) {
  try {
    const plan = await computePlanForBatch(churchId, accessToken, batch, { force: false });
    const result = await applyForChurch(churchId, plan, userId, {}, {
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
    });
    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      errors: result.errors.length,
    };
```

Replace with:

```js
async function runBatchSync(churchId, accessToken, batch, userId) {
  try {
    const plan = await computePlanForBatch(churchId, accessToken, batch, { force: false });
    const result = await applyForChurch(churchId, plan, userId, {}, {
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
    });
    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      gatheringAssigned: result.gatheringAssigned,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      errors: result.errors.length,
    };
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd server && node --check services/planningCenterSync.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Run the full server test suite to check for regressions**

Run: `cd server && node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all 114 tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/services/planningCenterSync.js
git commit -m "feat(pco): include gatheringAssigned in the scheduled sync summary"
```

---

### Task 5: Show the gathering-assignment count in the integration panel

**Files:**
- Modify: `client/src/services/api.ts`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`

- [ ] **Step 1: Add the field to the `SyncBatchLastResult` type**

In `client/src/services/api.ts`, find:

```ts
export interface SyncBatchLastResult {
  at: string;
  added: number;
  updated: number;
  archived: number;
  reactivated: number;
  linked: number;
  ambiguous: number;
  visitorMatches: number;
  errors: number;
}
```

Replace with:

```ts
export interface SyncBatchLastResult {
  at: string;
  added: number;
  updated: number;
  archived: number;
  reactivated: number;
  linked: number;
  gatheringAssigned: number;
  ambiguous: number;
  visitorMatches: number;
  errors: number;
}
```

- [ ] **Step 2: Render the count in the "Last run" line**

In `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`, find:

```tsx
                          {batch.lastSyncResult && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              Last run {new Date(batch.lastSyncResult.at).toLocaleString()}: {batch.lastSyncResult.added} added, {batch.lastSyncResult.updated} updated, {batch.lastSyncResult.linked} linked
                              {batch.lastSyncResult.ambiguous ? `, ${batch.lastSyncResult.ambiguous} need review` : ''}.
                            </p>
                          )}
```

Replace with:

```tsx
                          {batch.lastSyncResult && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              Last run {new Date(batch.lastSyncResult.at).toLocaleString()}: {batch.lastSyncResult.added} added, {batch.lastSyncResult.updated} updated, {batch.lastSyncResult.linked} linked
                              {batch.lastSyncResult.ambiguous ? `, ${batch.lastSyncResult.ambiguous} need review` : ''}
                              {batch.gatheringTypeId && batch.lastSyncResult.gatheringAssigned ? `, ${batch.lastSyncResult.gatheringAssigned} added to gathering` : ''}.
                            </p>
                          )}
```

(Gated on `batch.gatheringTypeId` so a batch with no gathering assigned — where
`gatheringAssigned` is always `0` — never shows this clause at all, not even ", 0
added to gathering".)

- [ ] **Step 3: Verify no new TypeScript errors**

Run: `cd client && npx tsc --noEmit`
Expected: only the one pre-existing, unrelated `TS5107` warning
(`tsconfig.json(17,25): error TS5107: Option 'moduleResolution=node10' is deprecated...`)
— no new errors. (No component tests exist in this codebase for this file or any
other component, confirmed before this plan was written — nothing else to run here.)

- [ ] **Step 4: Commit**

```bash
git add client/src/services/api.ts client/src/components/integrations/PlanningCenterIntegrationPanel.tsx
git commit -m "feat(pco): show gathering-assignment count in the integration panel"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

`applyPlan` writes to real database tables (`individuals`, `families`,
`gathering_lists`) and — in production use — would call the real Planning Center
API. The church already connected in this dev environment (Kingston CRC,
`kin_29b2699f71b1`) has real production-like data; do **not** create a new batch or
click "Run now"/"Apply" against it for this verification, since that would add real
individuals to a real gathering roster. Verify safely instead:

- [ ] **Step 1: Run the full server test suite**

Run: `cd server && node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: 114 tests pass, 0 failures.

- [ ] **Step 2: Run the client type-check**

Run: `cd client && npx tsc --noEmit`
Expected: only the known pre-existing `TS5107` warning, no new errors.

- [ ] **Step 3: Exercise `applyPlan`'s gathering-assignment logic against a throwaway database**

This proves the `affectedRows`/`gatheringAssigned` counting logic and the broadened
`touchedIndividualIds` actually work against a real SQLite file, without touching any
real church data. `server/config/database.js`'s `Database.initialize()` reads
`process.env.DATA_DIR` (falling back to `server/data` if unset) to decide where
church SQLite files live, and enforces `foreign_keys = ON` — so any inserted row with
a non-null foreign key (e.g. `added_by`/`created_by` referencing `users`) must
reference a real row or be left `NULL`. This script avoids that entirely by passing
`userId: null` into `applyPlan` (safe — `added_by INTEGER` is nullable) and not
touching `created_by` at all. It also avoids `INSERT ... RETURNING`, since
`Database.query`'s non-`SELECT` path always calls `.run()` (`server/config/database.js:404-436`),
and better-sqlite3's `.run()` throws on statements that return rows — use the
already-established `result.insertId` pattern instead (as `apply.js` itself does).

Write this to `/private/tmp/claude-501/-Users-isaaclee-Projects-Let-My-People-Grow-letmypeoplegrow/f21999a8-8629-45b3-b79d-22f4901733cc/scratchpad/verify-gathering-assign.js`
(the project's scratchpad directory — do not commit it, delete it in Step 3 below
once done):

```js
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pco-gathering-verify-'));
process.env.DATA_DIR = tmpDir;

const Database = require('/Users/isaaclee/Projects/Let My People Grow/letmypeoplegrow/server/config/database');
const { applyPlan } = require('/Users/isaaclee/Projects/Let My People Grow/letmypeoplegrow/server/services/planningCenter/apply');

async function main() {
  Database.initialize();
  const churchId = 'verify_church';
  Database.ensureChurchSchema(churchId);

  await Database.setChurchContext(churchId, async () => {
    // One already-linked, active individual not yet on any gathering roster.
    await Database.query(
      `INSERT INTO individuals (church_id, first_name, last_name, people_type, is_active, planning_center_id, created_at)
       VALUES (?, 'Already', 'Linked', 'regular', 1, 'pco123', datetime('now'))`,
      [churchId]
    );
    const indRows = await Database.query(
      `SELECT id FROM individuals WHERE church_id = ? AND planning_center_id = 'pco123'`,
      [churchId]
    );
    const individualId = indRows[0].id;

    const gtResult = await Database.query(
      `INSERT INTO gathering_types (name, day_of_week, attendance_type, church_id) VALUES ('Youth', 'Sunday', 'standard', ?)`,
      [churchId]
    );
    const gatheringTypeId = gtResult.insertId;

    const plan = {
      link: [], restore: [], add: [], update: [], archive: [], reactivate: [],
      gatheringEligible: [{ individualId, pcoId: 'pco123' }],
    };
    const result1 = await applyPlan(churchId, plan, null, {}, { gatheringTypeId });
    console.log('First apply — expect gatheringAssigned: 1 ->', result1.gatheringAssigned);

    const result2 = await applyPlan(churchId, plan, null, {}, { gatheringTypeId });
    console.log('Second apply (already on roster) — expect gatheringAssigned: 0 ->', result2.gatheringAssigned);

    const rows = await Database.query(
      `SELECT COUNT(*) AS n FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?`,
      [gatheringTypeId, individualId]
    );
    console.log('Roster row count (expect exactly 1, not 2) ->', rows[0].n);
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

Run: `node /path/to/verify-gathering-assign.js`
Expected output (three lines):
```
First apply — expect gatheringAssigned: 1 -> 1
Second apply (already on roster) — expect gatheringAssigned: 0 -> 0
Roster row count (expect exactly 1, not 2) -> 1
```

This confirms: a first apply against a fresh `gatheringEligible` entry inserts a new
roster row and counts it; a second apply against the same entry is a no-op (already
on the roster) and does NOT increment the count; and the roster ends up with exactly
one row, not a duplicate. Delete the script file after running it — it's throwaway,
not part of the codebase (the temp SQLite directory it created under `os.tmpdir()`
can be left for the OS to clean up, or removed manually).

- [ ] **Step 4: Report results**

Summarize what was verified (test suite, type-check, throwaway-DB gathering-assignment
check) back to the user. Do not claim this is complete without having actually run
Step 3 and observed the three expected outputs — reasoning about the code without
running it is not sufficient here, since this task exists specifically to catch
mistakes that pure code review of DB-touching logic can miss.
