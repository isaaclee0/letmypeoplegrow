# PCO Background Check Status ("Green Shield") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Planning Center's background-check "green shield" status for adults on gatherings flagged as requiring it, gated by a church-level PCO integration toggle, per `docs/superpowers/specs/2026-07-14-pco-background-check-status-design.md`.

**Architecture:** Add a nullable tri-state column on `individuals` populated unconditionally from PCO's `Person.passed_background_check` attribute on every real sync (no new PCO API call — the attribute already rides along on the existing people fetch). Two new settings gate display: a church-level toggle (PCO integration tab) and a per-gathering-type flag ("requires background check"). A small shared icon component renders a green/amber shield wherever it's shown: the People page (admin/coordinator only) and the two check-in surfaces (`AttendancePage.tsx`, `LeaderCheckInMode.tsx`, visible to whoever is taking attendance, but only for flagged gatherings).

**Tech Stack:** Node.js/Express + `better-sqlite3` (server), React/TypeScript + Tailwind + `@heroicons/react` (client), `node:test` for server unit/integration tests, Docker Compose dev environment.

---

## Before you start

All verification in this plan runs through the dev Docker containers, per this project's convention — **never run `node`, `npm test`, `tsc`, or builds directly on the host.**

```bash
docker-compose -f docker-compose.dev.yml up -d
```

Confirm the server and client containers are healthy before starting Task 1:

```bash
docker-compose -f docker-compose.dev.yml ps
```

---

### Task 1: Schema — three new columns

**Files:**
- Modify: `server/config/schema.js:87-141` (church_settings), `server/config/schema.js:143-166` (gathering_types), `server/config/schema.js:206-227` (individuals)
- Modify: `server/config/database.js:230` (existing-DB migration block)

- [ ] **Step 1: Add the church_settings column to schema.js**

In `server/config/schema.js`, find this line inside the `church_settings` table (currently line 138):

```sql
  planning_center_last_notified_review TEXT,
```

Add a new line immediately after it:

```sql
  planning_center_last_notified_review TEXT,
  planning_center_track_background_checks INTEGER DEFAULT 0,
```

- [ ] **Step 2: Add the gathering_types column to schema.js**

In the same file, find this line inside the `gathering_types` table (currently line 159):

```sql
  individual_mode INTEGER DEFAULT 0,
```

Add a new line immediately after it:

```sql
  individual_mode INTEGER DEFAULT 0,
  requires_background_check INTEGER DEFAULT 0,
```

- [ ] **Step 3: Add the individuals column to schema.js**

In the same file, find this line inside the `individuals` table (currently line 224):

```sql
  pco_link_declined INTEGER DEFAULT 0,
```

Add a new line immediately after it:

```sql
  pco_link_declined INTEGER DEFAULT 0,
  pco_background_check_cleared INTEGER,
```

(No `DEFAULT` clause — this is a tri-state nullable column: `NULL` = never synced, `0`/`1` = synced not-cleared/cleared. This matches the existing convention for nullable INTEGER columns like `default_gathering_id INTEGER,`.)

- [ ] **Step 4: Add the existing-DB migration block to database.js**

In `server/config/database.js`, find the end of the last migration block before the `planning_center_sync_batches` creation comment (currently lines 228-231):

```js
      if (!settingsCols.some(c => c.name === 'planning_center_last_notified_review')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_last_notified_review TEXT');
      }

      // Create planning_center_sync_batches if missing, and seed exactly once from
```

Insert a new migration block between the closing `}` and the comment:

```js
      if (!settingsCols.some(c => c.name === 'planning_center_last_notified_review')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_last_notified_review TEXT');
      }

      // Migrate church_settings, gathering_types, individuals: background-check status feature
      if (!settingsCols.some(c => c.name === 'planning_center_track_background_checks')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_track_background_checks INTEGER DEFAULT 0');
      }
      if (!gatheringCols.some(c => c.name === 'requires_background_check')) {
        db.exec('ALTER TABLE gathering_types ADD COLUMN requires_background_check INTEGER DEFAULT 0');
      }
      if (!individualsCols.some(c => c.name === 'pco_background_check_cleared')) {
        db.exec('ALTER TABLE individuals ADD COLUMN pco_background_check_cleared INTEGER');
      }

      // Create planning_center_sync_batches if missing, and seed exactly once from
```

This reuses the `settingsCols`, `gatheringCols`, and `individualsCols` variables already declared earlier in the same function (lines 56, 62, 198) — no new `PRAGMA table_info` calls needed.

- [ ] **Step 5: Verify migration applies cleanly**

Rebuild and restart the server container, then check logs for errors:

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs --tail=50 server
```

Expected: server starts with no SQL errors. New churches created after this point get the columns from `CHURCH_SCHEMA` directly; existing per-church `.sqlite` files under `server/data/churches/` get them via the `ALTER TABLE` migration the next time that church's DB is opened (i.e. next request for that church).

- [ ] **Step 6: Commit**

```bash
git add server/config/schema.js server/config/database.js
git commit -m "$(cat <<'EOF'
feat(pco): add background-check status schema columns

Adds church_settings.planning_center_track_background_checks,
gathering_types.requires_background_check, and
individuals.pco_background_check_cleared, with matching migration for
existing per-church databases.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `isBackgroundCheckTrackingEnabled` helper

**Files:**
- Modify: `server/services/planningCenter/mode.js`
- Create: `server/services/planningCenter/mode.dbintegration.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/planningCenter/mode.dbintegration.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { isBackgroundCheckTrackingEnabled } = require('./mode');

test('isBackgroundCheckTrackingEnabled: false by default for a new church', async () => {
  await withTestChurchDb(async (churchId) => {
    assert.strictEqual(await isBackgroundCheckTrackingEnabled(churchId), false);
  });
});

test('isBackgroundCheckTrackingEnabled: true once the church_settings flag is set', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `UPDATE church_settings SET planning_center_track_background_checks = 1 WHERE church_id = ?`,
      [churchId]
    );
    assert.strictEqual(await isBackgroundCheckTrackingEnabled(churchId), true);
  });
});

test('isBackgroundCheckTrackingEnabled: is scoped per church (church isolation)', async () => {
  await withTestChurchDb(async (churchIdA) => {
    await withTestChurchDb(async (churchIdB) => {
      await Database.query(
        `UPDATE church_settings SET planning_center_track_background_checks = 1 WHERE church_id = ?`,
        [churchIdB]
      );
      assert.strictEqual(await isBackgroundCheckTrackingEnabled(churchIdA), false);
      assert.strictEqual(await isBackgroundCheckTrackingEnabled(churchIdB), true);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/mode.dbintegration.test.js
```

Expected: FAIL — `isBackgroundCheckTrackingEnabled` is not exported from `./mode`.

- [ ] **Step 3: Implement the helper**

In `server/services/planningCenter/mode.js`, add the function after `isPcoModeActive` (after line 27):

```js
// Per-church flag for the background-check status feature. Independent of
// isPcoModeActive — a church can track background checks without PCO being
// source-of-truth for member identity, and vice versa.
async function isBackgroundCheckTrackingEnabled(churchId) {
  const rows = await Database.query(
    `SELECT planning_center_track_background_checks AS enabled
       FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  return rows.length > 0 && !!rows[0].enabled;
}
```

Update the `module.exports` block at the bottom of the file to include it:

```js
module.exports = {
  PCO_MODE_LOCKED,
  isPcoModeActive,
  isBackgroundCheckTrackingEnabled,
  isIndividualLocked,
  getLockInfo,
  lockedResponse,
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/mode.dbintegration.test.js
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/mode.js server/services/planningCenter/mode.dbintegration.test.js
git commit -m "$(cat <<'EOF'
feat(pco): add isBackgroundCheckTrackingEnabled helper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Project `passed_background_check` from PCO's Person payload

**Files:**
- Modify: `server/services/planningCenter/projection.js`
- Modify: `server/services/planningCenter/projection.test.js`

- [ ] **Step 1: Read the existing test file to match its style**

```bash
docker-compose -f docker-compose.dev.yml exec server cat services/planningCenter/projection.test.js
```

- [ ] **Step 2: Write the failing test**

Add this test to `server/services/planningCenter/projection.test.js` (mirror the existing `test(...)` calls already in that file for `projectPerson`, using the same `require` and assertion style already present):

```js
test('projectPerson: maps passed_background_check attribute to passedBackgroundCheck', () => {
  const raw = {
    id: '1',
    attributes: { first_name: 'A', last_name: 'B', passed_background_check: true },
    relationships: {},
  };
  const projected = projectPerson(raw, new Map());
  assert.strictEqual(projected.passedBackgroundCheck, true);
});

test('projectPerson: passedBackgroundCheck is false when PCO returns false', () => {
  const raw = {
    id: '2',
    attributes: { first_name: 'A', last_name: 'B', passed_background_check: false },
    relationships: {},
  };
  const projected = projectPerson(raw, new Map());
  assert.strictEqual(projected.passedBackgroundCheck, false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/projection.test.js
```

Expected: FAIL — `projected.passedBackgroundCheck` is `undefined`, not `true`/`false`.

- [ ] **Step 4: Implement the mapping**

In `server/services/planningCenter/projection.js`, modify the returned object (currently lines 37-46):

```js
  return {
    id: p.id,
    firstName: a.first_name || '',
    lastName: a.last_name || '',
    status: a.status || null,
    membership: a.membership || null,
    child: a.child === true,
    passedBackgroundCheck: a.passed_background_check === true,
    householdId: (hh && hh[0] && hh[0].id) || null,
    fieldValues,
  };
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/projection.test.js
```

Expected: PASS (including the two new tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenter/projection.js server/services/planningCenter/projection.test.js
git commit -m "$(cat <<'EOF'
feat(pco): project passed_background_check from PCO Person payload

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `syncBackgroundCheckStatuses` — write the boolean to `individuals`

**Files:**
- Create: `server/services/planningCenter/backgroundCheckSync.js`
- Create: `server/services/planningCenter/backgroundCheckSync.dbintegration.test.js`

This runs **unconditionally on every real sync** (not gated by the church toggle — see design doc's "Sync behavior" section) and is **independent of the diff/review pipeline** — it's supplementary data, not an identity change that needs review.

- [ ] **Step 1: Write the failing test**

Create `server/services/planningCenter/backgroundCheckSync.dbintegration.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { syncBackgroundCheckStatuses } = require('./backgroundCheckSync');

async function seedIndividual(churchId, { planningCenterId = null } = {}) {
  const res = await Database.query(
    `INSERT INTO individuals (first_name, last_name, church_id, is_active, planning_center_id)
     VALUES ('Test', 'Person', ?, 1, ?)`,
    [churchId, planningCenterId]
  );
  return res.insertId;
}

async function getCleared(individualId) {
  const rows = await Database.query(
    `SELECT pco_background_check_cleared AS cleared FROM individuals WHERE id = ?`,
    [individualId]
  );
  return rows[0].cleared;
}

test('syncBackgroundCheckStatuses: writes 1 for a linked person with passedBackgroundCheck true', async () => {
  await withTestChurchDb(async (churchId) => {
    const id = await seedIndividual(churchId, { planningCenterId: 'pco_1' });
    const synced = await syncBackgroundCheckStatuses(churchId, [
      { id: 'pco_1', passedBackgroundCheck: true },
    ]);
    assert.strictEqual(synced, 1);
    assert.strictEqual(await getCleared(id), 1);
  });
});

test('syncBackgroundCheckStatuses: writes 0 for a linked person with passedBackgroundCheck false', async () => {
  await withTestChurchDb(async (churchId) => {
    const id = await seedIndividual(churchId, { planningCenterId: 'pco_2' });
    await syncBackgroundCheckStatuses(churchId, [
      { id: 'pco_2', passedBackgroundCheck: false },
    ]);
    assert.strictEqual(await getCleared(id), 0);
  });
});

test('syncBackgroundCheckStatuses: no-ops for PCO people not linked to any individual', async () => {
  await withTestChurchDb(async (churchId) => {
    const synced = await syncBackgroundCheckStatuses(churchId, [
      { id: 'pco_unlinked', passedBackgroundCheck: true },
    ]);
    assert.strictEqual(synced, 0);
  });
});

test('syncBackgroundCheckStatuses: is scoped per church (church isolation)', async () => {
  await withTestChurchDb(async (churchIdA) => {
    await withTestChurchDb(async (churchIdB) => {
      const idB = await seedIndividual(churchIdB, { planningCenterId: 'pco_shared_id' });
      await syncBackgroundCheckStatuses(churchIdA, [
        { id: 'pco_shared_id', passedBackgroundCheck: true },
      ]);
      // churchB's individual, which happens to share the same PCO id string,
      // must not be touched by a sync run scoped to churchA.
      assert.strictEqual(await getCleared(idB), null);
    });
  });
});

test('syncBackgroundCheckStatuses: skips entries with no passedBackgroundCheck field', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedIndividual(churchId, { planningCenterId: 'pco_3' });
    const synced = await syncBackgroundCheckStatuses(churchId, [{ id: 'pco_3' }]);
    assert.strictEqual(synced, 0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/backgroundCheckSync.dbintegration.test.js
```

Expected: FAIL — cannot find module `./backgroundCheckSync`.

- [ ] **Step 3: Implement `backgroundCheckSync.js`**

Create `server/services/planningCenter/backgroundCheckSync.js`:

```js
// Writes PCO's Person.passed_background_check attribute down to
// individuals.pco_background_check_cleared for every already-linked person.
//
// Deliberately separate from diffEngine/apply.js: this is supplementary
// status data, not an identity change, so it doesn't go through the
// review pipeline (ambiguous-match resolution, family-name confirmation,
// etc.) — it's just written on every real sync run, unconditionally, for
// whichever people are already linked. PCO people with no matching
// individual (planning_center_id) in this church are silently skipped —
// there's no row to write it to yet.

const Database = require('../../config/database');

// pcoPeople: the array returned by planningCenterSync.js's fetchAllPcoPeople
// / projectPerson — each entry has { id, passedBackgroundCheck, ... }.
// Returns the number of individuals actually updated.
async function syncBackgroundCheckStatuses(churchId, pcoPeople) {
  let synced = 0;
  for (const p of pcoPeople) {
    if (typeof p.passedBackgroundCheck !== 'boolean') continue;
    const result = await Database.query(
      `UPDATE individuals
          SET pco_background_check_cleared = ?
        WHERE church_id = ? AND planning_center_id = ?`,
      [p.passedBackgroundCheck ? 1 : 0, churchId, p.id]
    );
    if (result.affectedRows > 0) synced++;
  }
  return synced;
}

module.exports = { syncBackgroundCheckStatuses };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/backgroundCheckSync.dbintegration.test.js
```

Expected: PASS (5 tests). If `result.affectedRows` isn't populated by this codebase's `Database.query` wrapper for UPDATE statements, check `server/config/database.js`'s query method for the actual returned shape (search for `affectedRows` usage elsewhere, e.g. `server/routes/gatherings.js:345`) and adjust the check accordingly — but do not change the test expectations, only the implementation's success-detection.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/backgroundCheckSync.js server/services/planningCenter/backgroundCheckSync.dbintegration.test.js
git commit -m "$(cat <<'EOF'
feat(pco): add syncBackgroundCheckStatuses

Unconditional, review-free write of PCO's passed_background_check
boolean to already-linked individuals.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire the sync into the real sync pipeline

**Files:**
- Modify: `server/services/planningCenterSync.js:328-334` (`computePlanForChurch`)
- Modify: `server/services/planningCenter/apply.js:37-38` (`applyPlan`)

- [ ] **Step 1: Attach the full PCO people list onto the plan**

In `server/services/planningCenterSync.js`, modify `computePlanForChurch` (currently lines 328-334):

```js
async function computePlanForChurch(churchId, accessToken, filterConfig, { force = false } = {}) {
  const { people: pcoPeople, householdPrimaryContacts, fetchedAt } = await getCachedPcoPeople(churchId, accessToken, { force });
  const { individuals, families } = await loadChurchState(churchId);
  const plan = computePlan({ pcoPeople, individuals, families, filterConfig, householdPrimaryContacts });
  plan.pcoFetchedAt = new Date(fetchedAt).toISOString();
  plan.pcoPeople = pcoPeople;
  return plan;
}
```

(Only the new `plan.pcoPeople = pcoPeople;` line is added. `computePlan`'s own returned object has no `pcoPeople` key today — confirmed by reading `diffEngine.js`'s return statement — so this can't collide.)

- [ ] **Step 2: Call the sync from `applyPlan`**

In `server/services/planningCenter/apply.js`, add the import at the top of the file (after the existing `buildFamilyName` import, currently line 2):

```js
const Database = require('../../config/database');
const { buildFamilyName } = require('./familyName');
const { syncBackgroundCheckStatuses } = require('./backgroundCheckSync');
```

In the same file, modify the start of `applyPlan` (currently lines 37-38) to call it right after `result` is initialized:

```js
async function applyPlan(churchId, plan, userId, selections = {}, batchConfig = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, gatheringAssigned: 0, gatheringRemoved: 0, familyNamesUpdated: 0, backgroundCheckSynced: 0, errors: [] };

  // Unconditional, review-free: sync background-check status for every
  // already-linked person this run saw, regardless of what else changed.
  result.backgroundCheckSynced = await syncBackgroundCheckStatuses(churchId, plan.pcoPeople || []);

  const skipAdd = new Set(selections.skipAddPcoIds || []);
```

- [ ] **Step 3: Manually verify via a real (or sandbox) PCO-connected church**

This step has no automated test — it exercises the real PCO HTTPS calls, which the `dbintegration` tests deliberately don't touch (per the existing test file naming convention: `.dbintegration.test.js` files use `withTestChurchDb`, not a live PCO account). If a PCO-connected dev/sandbox church is available:

1. In the PCO integration tab, click "Refresh from Planning Center" (or trigger a batch sync) for a church that has at least one linked individual.
2. Check server logs for no errors: `docker-compose -f docker-compose.dev.yml logs --tail=100 server`
3. Query the church's SQLite file directly to confirm the column populated:
   ```bash
   docker-compose -f docker-compose.dev.yml exec server sqlite3 data/churches/<church_id>.sqlite \
     "SELECT first_name, last_name, planning_center_id, pco_background_check_cleared FROM individuals WHERE planning_center_id IS NOT NULL LIMIT 10;"
   ```
   Expected: linked individuals now show `0` or `1` in the last column (not blank/NULL), assuming their PCO record has `passed_background_check` set either way.

If no PCO-connected sandbox is available at this point in the build, skip this manual check and rely on Task 4's `dbintegration` tests plus Task 18's end-to-end pass later — note in the final summary that this specific live-PCO path is unverified.

- [ ] **Step 4: Commit**

```bash
git add server/services/planningCenterSync.js server/services/planningCenter/apply.js
git commit -m "$(cat <<'EOF'
feat(pco): sync background-check status on every real sync run

Wires syncBackgroundCheckStatuses into applyPlan via plan.pcoPeople,
so it runs on scheduled syncs, manual "Run now", and reviewed-plan
apply alike — independent of what else the run changes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Church-level toggle — settings API

**Files:**
- Modify: `server/routes/settings.js:503-518` (GET `/integrations`), `server/routes/settings.js:520-544` (PUT `/integrations`)

- [ ] **Step 1: Extend the GET route**

In `server/routes/settings.js`, modify the `GET /integrations` handler (currently lines 503-518):

```js
router.get('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const rows = await Database.query(
      `SELECT planning_center_sync_indicator, planning_center_sync_enabled, planning_center_track_background_checks
       FROM church_settings WHERE church_id = ? LIMIT 1`,
      [req.user.church_id]
    );
    const row = rows[0] || {};
    res.json({
      planningCenterSyncIndicator: !!(row.planning_center_sync_indicator),
      planningCenterSyncEnabled: !!(row.planning_center_sync_enabled),
      planningCenterTrackBackgroundChecks: !!(row.planning_center_track_background_checks),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve integration settings.' });
  }
});
```

- [ ] **Step 2: Extend the PUT route**

Modify the `PUT /integrations` handler (currently lines 520-544):

```js
router.put('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const { planningCenterSyncIndicator, planningCenterSyncEnabled, planningCenterTrackBackgroundChecks } = req.body;
    const updates = [];
    const params = [];
    if (typeof planningCenterSyncIndicator === 'boolean') {
      updates.push('planning_center_sync_indicator = ?');
      params.push(planningCenterSyncIndicator ? 1 : 0);
    }
    if (typeof planningCenterSyncEnabled === 'boolean') {
      updates.push('planning_center_sync_enabled = ?');
      params.push(planningCenterSyncEnabled ? 1 : 0);
    }
    if (typeof planningCenterTrackBackgroundChecks === 'boolean') {
      updates.push('planning_center_track_background_checks = ?');
      params.push(planningCenterTrackBackgroundChecks ? 1 : 0);
    }
    if (updates.length) {
      params.push(req.user.church_id);
      await Database.query(
        `UPDATE church_settings SET ${updates.join(', ')} WHERE church_id = ?`,
        params
      );
    }
    res.json({ message: 'Integration settings updated.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update integration settings.' });
  }
});
```

- [ ] **Step 3: Manual verification**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
```

Log in as an admin in the browser, open dev tools network tab, and from a terminal:

```bash
docker-compose -f docker-compose.dev.yml logs --tail=20 server
```

Then in the app, use the browser to hit `PUT /api/settings/integrations` with `{"planningCenterTrackBackgroundChecks": true}` (this will be exercised properly once Task 13's UI toggle exists — for now, confirm the route doesn't 500 by checking it returns 200 via the People/Settings page network tab after Task 13 is done). Defer full manual verification to Task 18.

- [ ] **Step 4: Commit**

```bash
git add server/routes/settings.js
git commit -m "$(cat <<'EOF'
feat(pco): add planningCenterTrackBackgroundChecks to integrations settings API

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Expose the toggle to the People page

**Files:**
- Modify: `server/routes/families.js:36-73` (GET `/`)

- [ ] **Step 1: Extend the query and response**

In `server/routes/families.js`, modify the `GET /` handler (currently lines 37-73):

```js
router.get('/', async (req, res) => {
  try {
    const [families, settingsRows] = await Promise.all([
      Database.query(`
        SELECT
          f.id,
          f.family_name AS familyName,
          f.family_notes AS familyNotes,
          f.family_type AS familyType,
          f.last_attended AS lastAttended,
          f.planning_center_id AS planningCenterId,
          COUNT(i.id) AS memberCount
        FROM families f
        JOIN individuals i ON f.id = i.family_id AND i.is_active = 1
        WHERE f.church_id = ?
        GROUP BY f.id
        ORDER BY f.family_name
      `, [req.user.church_id]),
      Database.query(
        `SELECT planning_center_sync_indicator, planning_center_track_background_checks FROM church_settings WHERE church_id = ? LIMIT 1`,
        [req.user.church_id]
      )
    ]);

    const processedFamilies = families.map((family) => ({
      ...family,
      id: Number(family.id),
      memberCount: Number(family.memberCount)
    }));

    const planningCenterSyncIndicator = !!(settingsRows[0]?.planning_center_sync_indicator);
    const planningCenterTrackBackgroundChecks = !!(settingsRows[0]?.planning_center_track_background_checks);

    res.json({ families: processedFamilies, planningCenterSyncIndicator, planningCenterTrackBackgroundChecks });
  } catch (error) {
    console.error('Get families error:', error);
    res.status(500).json({ error: 'Failed to retrieve families.' });
```

(Leave the rest of the `catch` block as-is.)

- [ ] **Step 2: Commit**

```bash
git add server/routes/families.js
git commit -m "$(cat <<'EOF'
feat(pco): expose planningCenterTrackBackgroundChecks on GET /families

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `requires_background_check` on gathering types

**Files:**
- Modify: `server/routes/gatherings.js` (list query, create route, update route, duplicate route)

- [ ] **Step 1: Add the column to the shared select**

In `server/routes/gatherings.js`, modify the `selectCols` definition (currently line 36):

```js
    const selectCols = `gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.end_time, gt.frequency, gt.attendance_type, gt.custom_schedule, gt.kiosk_enabled, gt.leader_checkin_enabled, gt.kiosk_message, gt.individual_mode, gt.requires_background_check, gt.is_active, gt.created_at`;
```

- [ ] **Step 2: Add it to the create route**

Modify the destructure (currently line 135):

```js
      const { name, description, dayOfWeek, startTime, endTime, frequency, attendanceType, customSchedule, setAsDefault, kioskEnabled, leaderCheckinEnabled, kioskEndTime, kioskMessage, individualMode, requiresBackgroundCheck } = req.body;
```

Modify the INSERT (currently lines 155-173):

```js
    const result = await Database.query(`
      INSERT INTO gathering_types (name, description, day_of_week, start_time, end_time, frequency, attendance_type, custom_schedule, kiosk_enabled, leader_checkin_enabled, kiosk_message, individual_mode, requires_background_check, created_by, church_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      description,
      isCustomScheduleGathering ? null : dayOfWeek,
      isCustomScheduleGathering ? null : startTime,
      isCustomScheduleGathering ? null : (endTime || null),
      isCustomScheduleGathering ? null : (frequency || 'weekly'),
      attendanceType,
      customSchedule ? JSON.stringify(customSchedule) : null,
      attendanceType === 'standard' && kioskEnabled ? true : false,
      attendanceType === 'standard' && leaderCheckinEnabled ? true : false,
      kioskMessage || null,
      attendanceType === 'standard' && individualMode ? true : false,
      attendanceType === 'standard' && requiresBackgroundCheck ? true : false,
      req.user.id,
      req.user.church_id
    ]);
```

- [ ] **Step 3: Add it to the update route**

Modify the destructure (currently line 262):

```js
    const { name, description, dayOfWeek, startTime, endTime, frequency, attendanceType, customSchedule, kioskEnabled, leaderCheckinEnabled, kioskEndTime, kioskMessage, individualMode, requiresBackgroundCheck } = req.body;
```

Modify the value computation and UPDATE (currently lines 314-343):

```js
    const kioskValue = effectiveAttendanceType === 'standard' && kioskEnabled ? true : false;
    const leaderCheckinValue = effectiveAttendanceType === 'standard' && leaderCheckinEnabled ? true : false;
    const individualModeValue = effectiveAttendanceType === 'standard' && individualMode ? true : false;
    const requiresBackgroundCheckValue = effectiveAttendanceType === 'standard' && requiresBackgroundCheck ? true : false;

    const result = await Database.query(`
      UPDATE gathering_types
      SET name = ?, description = ?, day_of_week = ?, start_time = ?, end_time = ?, frequency = ?,
          attendance_type = COALESCE(?, attendance_type),
          custom_schedule = ?,
          kiosk_enabled = ?,
          leader_checkin_enabled = ?,
          kiosk_message = ?,
          individual_mode = ?,
          requires_background_check = ?
      WHERE id = ? AND church_id = ?
    `, [
      name,
      description,
      isCustomScheduleGathering ? null : dayOfWeek,
      isCustomScheduleGathering ? null : startTime,
      isCustomScheduleGathering ? null : (endTime || null),
      isCustomScheduleGathering ? null : (frequency || 'weekly'),
      attendanceType,
      customSchedule ? JSON.stringify(customSchedule) : null,
      kioskValue,
      leaderCheckinValue,
      kioskMessage || null,
      individualModeValue,
      requiresBackgroundCheckValue,
      gatheringId,
      req.user.church_id
    ]);
```

- [ ] **Step 4: Add it to the duplicate route**

Modify the source select (currently lines 393-401):

```js
    const gathering = await Database.query(`
      SELECT gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.frequency,
             gt.attendance_type, gt.custom_schedule, gt.group_by_family, gt.kiosk_enabled, gt.leader_checkin_enabled, gt.individual_mode, gt.requires_background_check, gt.is_active, gt.created_at
      FROM gathering_types gt
      LEFT JOIN user_gathering_assignments uga ON gt.id = uga.gathering_type_id
      WHERE gt.id = ? AND gt.church_id = ? AND (
        ? = 'admin' OR uga.user_id = ?
      )
    `, [id, req.user.church_id, req.user.role, req.user.id]);
```

Modify the insert into the new gathering (currently lines 426-446):

```js
      const insertResult = await conn.query(`
        INSERT INTO gathering_types (
          name, description, day_of_week, start_time, end_time, frequency,
          attendance_type, custom_schedule, group_by_family, kiosk_enabled, leader_checkin_enabled, individual_mode, requires_background_check, church_id, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        name.trim(),
        originalGathering.description,
        isCustomScheduleGathering ? null : originalGathering.day_of_week,
        isCustomScheduleGathering ? null : originalGathering.start_time,
        isCustomScheduleGathering ? null : originalGathering.end_time,
        isCustomScheduleGathering ? null : originalGathering.frequency,
        originalGathering.attendance_type,
        originalGathering.custom_schedule ? JSON.stringify(originalGathering.custom_schedule) : null,
        originalGathering.group_by_family !== undefined ? originalGathering.group_by_family : true,
        originalGathering.kiosk_enabled || false,
        originalGathering.leader_checkin_enabled || false,
        originalGathering.individual_mode || false,
        originalGathering.requires_background_check || false,
        req.user.church_id,
        req.user.id
      ]);
```

- [ ] **Step 5: Commit**

```bash
git add server/routes/gatherings.js
git commit -m "$(cat <<'EOF'
feat(pco): add requires_background_check to gathering type CRUD routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Role-gated status on the People page endpoint

**Files:**
- Modify: `server/routes/individuals.js:152-200` (GET `/`)

Only `admin`/`coordinator` should see `pcoBackgroundCheckCleared` in this response (per the design's visibility split — this is the browsable People page, not the in-the-moment check-in warning from Task 10).

- [ ] **Step 1: Modify the route**

In `server/routes/individuals.js`, modify the `GET /` handler (currently lines 152-200):

```js
// Get all individuals with their family and gathering assignments
router.get('/', async (req, res) => {
  try {
    const canSeeBackgroundCheckStatus = ['admin', 'coordinator'].includes(req.user.role);
    const backgroundCheckSelect = canSeeBackgroundCheckStatus ? 'i.pco_background_check_cleared,' : '';

    const individuals = await Database.query(`
      SELECT
        i.id,
        i.first_name,
        i.last_name,
        i.people_type,
        i.is_child,
        i.badge_text,
        i.badge_color,
        i.badge_icon,
        i.family_id,
        f.family_name,
        i.is_active,
        i.created_at,
        i.planning_center_id,
        ${backgroundCheckSelect}
        GROUP_CONCAT(DISTINCT gt.id) as gathering_ids,
        GROUP_CONCAT(DISTINCT gt.name) as gathering_names
      FROM individuals i
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
      LEFT JOIN gathering_types gt ON gl.gathering_type_id = gt.id
      WHERE i.is_active = 1 AND i.church_id = ?
      GROUP BY i.id
      ORDER BY i.last_name, i.first_name
    `, [req.user.church_id]);

    // Process gathering assignments and use systematic conversion utility
    const processedIndividuals = individuals.map(individual => ({
      ...individual,
      isActive: Boolean(individual.is_active),
      isChild: Boolean(individual.is_child),
      peopleType: individual.people_type,
      ...(canSeeBackgroundCheckStatus ? {
        pcoBackgroundCheckCleared: individual.pco_background_check_cleared === null
          ? null
          : Boolean(individual.pco_background_check_cleared)
      } : {}),
      gatheringAssignments: individual.gathering_ids ? 
        individual.gathering_ids.split(',').map((id, index) => ({
          id: Number(id),
          name: individual.gathering_names.split(',')[index]
        })) : []
    }));
    
    const responseData = processApiResponse({ people: processedIndividuals });
    res.json(responseData);
  } catch (error) {
    console.error('Get individuals error:', error);
    res.status(500).json({ error: 'Failed to retrieve individuals.' });
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add server/routes/individuals.js
git commit -m "$(cat <<'EOF'
feat(pco): expose pcoBackgroundCheckCleared to admin/coordinator on GET /individuals

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Check-in surface — attendance `/full` route

**Files:**
- Modify: `server/routes/attendance.js` (`/:gatheringTypeId/:date/full` route, lines 1031-1385)

This is the shared endpoint both `AttendancePage.tsx` and `LeaderCheckInMode.tsx` call. Per the design, the indicator only shows when the church toggle **and** the gathering's `requires_background_check` flag are both on — visible to whoever is taking attendance (no role restriction, unlike Task 9).

- [ ] **Step 1: Add the imports**

At the top of `server/routes/attendance.js`, find the existing requires and add:

```bash
docker-compose -f docker-compose.dev.yml exec server grep -n "^const.*require" routes/attendance.js | head -20
```

Add this line alongside the other `require`s near the top of the file:

```js
const { isBackgroundCheckTrackingEnabled } = require('../services/planningCenter/mode');
```

- [ ] **Step 2: Fetch the gathering's flag and the church toggle**

In the `/:gatheringTypeId/:date/full` handler, find the existing gathering frequency lookup (currently lines 1096-1103):

```js
    const thresholdDays = 7; // default weekly
    try {
      const gt = await Database.query('SELECT frequency FROM gathering_types WHERE id = ?', [gatheringTypeId]);
      if (gt && gt.length > 0) {
        const freq = (gt[0].frequency || '').toLowerCase();
        if (freq === 'biweekly') thresholdDays = 14;
        else if (freq === 'monthly') thresholdDays = 31;
      }
    } catch {}
```

Replace it with a version that also captures `requires_background_check`, and compute `showBackgroundCheckStatus`:

```js
    const thresholdDays = 7; // default weekly
    let gatheringRequiresBackgroundCheck = false;
    try {
      const gt = await Database.query('SELECT frequency, requires_background_check FROM gathering_types WHERE id = ?', [gatheringTypeId]);
      if (gt && gt.length > 0) {
        const freq = (gt[0].frequency || '').toLowerCase();
        if (freq === 'biweekly') thresholdDays = 14;
        else if (freq === 'monthly') thresholdDays = 31;
        gatheringRequiresBackgroundCheck = !!gt[0].requires_background_check;
      }
    } catch {}
    const showBackgroundCheckStatus = gatheringRequiresBackgroundCheck
      && await isBackgroundCheckTrackingEnabled(req.user.church_id);
```

Leave `const thresholdDays = 7;` exactly as-is — it's declared `const` and then reassigned at `thresholdDays = 14`/`= 31` a few lines down, which is a pre-existing bug (throws, silently swallowed by the empty `catch {}`, so those two lines never actually take effect). That's unrelated to this feature; don't fix it here. It's flagged separately for its own fix.

- [ ] **Step 3: Include the column in the roster queries**

Modify `attendanceListQuery` (currently lines 1233-1241):

```js
    let attendanceListQuery = `
      SELECT i.id, i.first_name, i.last_name, i.is_child,
             i.badge_text, i.badge_color, i.badge_icon,
             i.pco_background_check_cleared,
             f.family_name, f.id as family_id,
             f.family_notes,
             COALESCE(ar.present, 0) as present,
             ${peopleTypeExpression},
             f.family_type AS familyType,
             f.last_attended AS lastAttended
      FROM gathering_lists gl
      JOIN individuals i ON gl.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
      WHERE gl.gathering_type_id = ?
        AND i.is_active = 1
        AND i.church_id = ?
        ${glChurchFilterFull}
    `;
```

Modify the orphaned-records query (currently lines 1292-1300):

```js
      const orphanedRecords = await Database.query(`
        SELECT i.id, i.first_name, i.last_name, i.is_child,
               i.badge_text, i.badge_color, i.badge_icon,
               i.pco_background_check_cleared,
               f.family_name, f.id as family_id,
               f.family_notes,
               ar.present,
               COALESCE(ar.people_type_at_time, i.people_type) as people_type,
               f.family_type AS familyType,
               f.last_attended AS lastAttended
        FROM attendance_records ar
        JOIN individuals i ON ar.individual_id = i.id
        LEFT JOIN families f ON i.family_id = f.id
        WHERE ar.session_id = ?
          AND ar.church_id = ?
          AND COALESCE(ar.people_type_at_time, i.people_type, 'regular') = 'regular'
          AND (f.family_type = 'regular' OR f.family_type IS NULL)
        ORDER BY LOWER(COALESCE(f.family_name, '')), LOWER(i.first_name)
      `, [sessionId, req.user.church_id]);
```

- [ ] **Step 4: Map the field and add the top-level flag to the response**

Modify the final response construction (currently lines 1356-1378):

```js
    // Format and return combined response
    const responseData = processApiResponse({
      sessionId: sessionId,
      excludedFromStats: sessions.length > 0 ? (sessions[0].excluded_from_stats === 1) : false,
      showBackgroundCheckStatus,
      attendanceList: attendanceList.map(attendee => ({
        ...attendee,
        present: attendee.present === 1 || attendee.present === true,
        isChild: Boolean(attendee.is_child),
        badgeText: attendee.badge_text || null,
        badgeColor: attendee.badge_color || null,
        badgeIcon: attendee.badge_icon || null,
        backgroundCheckCleared: attendee.pco_background_check_cleared === null || attendee.pco_background_check_cleared === undefined
          ? null
          : Boolean(attendee.pco_background_check_cleared),
        familyNotes: attendee.family_notes || null,
        peopleType: attendee.people_type,
        lastAttended: attendee.last_attended
      })),
      visitors,
      potentialVisitors: filteredPotentialVisitors.map(visitor => ({
        ...visitor,
        withinAbsenceLimit: visitor.within_absence_limit === 1 || visitor.within_absence_limit === true
      })),
      recentVisitors: results.recentVisitors || [],
      allChurchPeople: results.allChurchPeople || []
    });

    res.json(responseData);
```

- [ ] **Step 5: Manual verification**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs --tail=50 server
```

Expected: no errors on startup, and a `GET /api/attendance/:id/:date/full` call (via the app once loaded, or via the browser network tab) returns a `showBackgroundCheckStatus` boolean and a `backgroundCheckCleared` field per attendee. Full visual confirmation happens in Task 18 once the UI renders it.

- [ ] **Step 6: Commit**

```bash
git add server/routes/attendance.js
git commit -m "$(cat <<'EOF'
feat(pco): surface background-check status on flagged gatherings' /full attendance route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Client API types

**Files:**
- Modify: `client/src/services/api.ts`

- [ ] **Step 1: Extend `Individual`**

Modify the `Individual` interface (currently lines 193-207):

```ts
export interface Individual {
  id: number;
  firstName: string;
  lastName: string;
  peopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  isChild?: boolean;
  badgeText?: string | null;
  badgeColor?: string | null;
  badgeIcon?: string | null;
  familyId?: number;
  familyName?: string;
  familyNotes?: string | null;
  present?: boolean;
  isSaving?: boolean;
  planningCenterId?: string | null;
  pcoBackgroundCheckCleared?: boolean | null;
  backgroundCheckCleared?: boolean | null;
}
```

(`pcoBackgroundCheckCleared` comes from the People-page endpoint (Task 9); `backgroundCheckCleared` comes from the attendance `/full` endpoint (Task 10). They're the same underlying value from two different routes with two different response shapes — kept as separate optional fields rather than unifying the two backend response shapes, which is out of scope here.)

- [ ] **Step 2: Extend `GatheringType`**

Modify the `GatheringType` interface (currently lines 163-191):

```ts
export interface GatheringType {
  id: number;
  name: string;
  description?: string;
  dayOfWeek?: string;
  startTime?: string;
  frequency?: string;
  attendanceType: 'standard' | 'headcount';
  customSchedule?: {
    type: 'one_off' | 'recurring';
    startDate: string;
    endDate?: string;
    pattern?: {
      frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly';
      interval: number;
      daysOfWeek?: string[];
      dayOfMonth?: number;
      customDates?: string[];
    };
  };
  endTime?: string;
  kioskEnabled?: boolean;
  leaderCheckinEnabled?: boolean;
  individualMode?: boolean;
  requiresBackgroundCheck?: boolean;
  kioskMessage?: string;
  isActive: boolean;
  memberCount?: number;
  createdAt?: string;
}
```

- [ ] **Step 3: Extend `gatheringsAPI.create` and `.update` payload types**

Modify both (currently lines 303-327 and 329-352) to add `requiresBackgroundCheck?: boolean;` alongside the existing `individualMode?: boolean;` line in each.

- [ ] **Step 4: Extend `settingsAPI.updateIntegrationSettings`**

Modify (currently lines 803-807):

```ts
  getIntegrationSettings: () => api.get('/settings/integrations'),
  updateIntegrationSettings: (data: {
    planningCenterSyncIndicator?: boolean;
    planningCenterSyncEnabled?: boolean;
    planningCenterTrackBackgroundChecks?: boolean;
  }) => api.put('/settings/integrations', data),
```

- [ ] **Step 5: Verify the client still compiles**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
docker-compose -f docker-compose.dev.yml logs --tail=60 client
```

Expected: no TypeScript errors in the build output.

- [ ] **Step 6: Commit**

```bash
git add client/src/services/api.ts
git commit -m "$(cat <<'EOF'
feat(pco): add background-check status types to api.ts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Shared shield icon component

**Files:**
- Create: `client/src/components/icons/BackgroundCheckShield.tsx`

- [ ] **Step 1: Create the component**

```tsx
import React from 'react';
import { ShieldCheckIcon } from '@heroicons/react/24/solid';
import { ShieldExclamationIcon } from '@heroicons/react/24/outline';

interface BackgroundCheckShieldProps {
  cleared: boolean | null | undefined;
  className?: string;
}

// Green solid shield when PCO reports a cleared, current background check;
// amber outline shield otherwise (not cleared, expired, or never synced —
// deliberately not red, since `false`/`null` can mean several different
// underlying PCO states we can't distinguish, and we don't want to assert a
// hard failure we can't back up).
const BackgroundCheckShield: React.FC<BackgroundCheckShieldProps> = ({ cleared, className = 'w-5 h-5' }) => {
  if (cleared) {
    return (
      <ShieldCheckIcon
        className={`${className} text-green-600 dark:text-green-400 shrink-0`}
        aria-label="Background check cleared"
      />
    );
  }
  return (
    <ShieldExclamationIcon
      className={`${className} text-amber-600 dark:text-amber-400 shrink-0`}
      aria-label="No cleared background check on file"
    />
  );
};

export default BackgroundCheckShield;
```

- [ ] **Step 2: Verify the client builds**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml logs --tail=40 client
```

Expected: no build errors (unused-file warnings are fine — it isn't imported anywhere yet).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/icons/BackgroundCheckShield.tsx
git commit -m "$(cat <<'EOF'
feat(pco): add shared BackgroundCheckShield icon component

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: PCO integration tab — new toggle

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`

- [ ] **Step 1: Add state**

Modify the state declarations (currently lines 36-37):

```tsx
  const [pcSyncIndicator, setPcSyncIndicator] = useState(false);
  const [pcSyncEnabled, setPcSyncEnabled] = useState(false);
  const [pcTrackBackgroundChecks, setPcTrackBackgroundChecks] = useState(false);
```

- [ ] **Step 2: Add the toggle handler**

Add this after `toggleMasterSync` (currently ending at line 92):

```tsx
  const toggleTrackBackgroundChecks = async (value: boolean) => {
    setPcTrackBackgroundChecks(value);
    try {
      await settingsAPI.updateIntegrationSettings({ planningCenterTrackBackgroundChecks: value });
    } catch (error) {
      logger.error('Failed to update background-check tracking setting:', error);
      setPcTrackBackgroundChecks(!value);
    }
  };
```

- [ ] **Step 3: Load the setting**

Modify the `useEffect` that loads integration settings (currently lines 131-137):

```tsx
      settingsAPI.getIntegrationSettings().then(r => {
        setPcSyncIndicator(!!r.data.planningCenterSyncIndicator);
        setPcSyncEnabled(!!r.data.planningCenterSyncEnabled);
        setPcTrackBackgroundChecks(!!r.data.planningCenterTrackBackgroundChecks);
      }).catch(() => {});
```

- [ ] **Step 4: Add the switch UI**

Add this block right after the "PCO is source of truth for members" toggle block (currently ending at line 300, i.e. right after its closing `</div>` and before the `{/* Sync batches */}` comment on line 302):

```tsx
              <div className="flex items-center justify-between">
                <div>
                  <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">Track background check status</h5>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Syncs Planning Center's background-check status for linked people. To use it,
                    also flag specific gathering types as "Requires background check" in Manage
                    Gatherings — the status only shows there and on the People page. Status is only
                    as current as the last sync (see each batch's "Last run" time below) — not real-time.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggleTrackBackgroundChecks(!pcTrackBackgroundChecks)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${pcTrackBackgroundChecks ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                  role="switch"
                  aria-checked={pcTrackBackgroundChecks}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${pcTrackBackgroundChecks ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

```

- [ ] **Step 5: Verify the client builds**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml logs --tail=40 client
```

- [ ] **Step 6: Commit**

```bash
git add client/src/components/integrations/PlanningCenterIntegrationPanel.tsx
git commit -m "$(cat <<'EOF'
feat(pco): add "Track background check status" toggle to integration tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: "Requires background check" checkbox on gathering types

**Files:**
- Modify: `client/src/pages/ManageGatheringsPage.tsx`

`editFormData`'s update flow spreads the whole object into the PUT payload (`handleUpdateGathering`'s `updateData = { ...editFormData }`, line 385), so adding the field to `editFormData`'s state is sufficient for the edit path — no separate submit-payload edit needed there. `createGatheringData`'s create flow does **not** spread — `handleCreateGathering` explicitly lists fields twice (once into the POST payload, once into the local-state `newGathering` object), so both explicit lists need the new field.

- [ ] **Step 1: Import `settingsAPI` and load whether the church has tracking enabled**

Modify the import on line 5:

```tsx
import { gatheringsAPI, onboardingAPI, kioskAPI, settingsAPI } from '../services/api';
```

Add state near the other feature-flag state (currently line 148, right after `kioskModeEnabled`):

```tsx
  // Self check-in / kiosk mode is off unless KIOSK_MODE_ENABLED=true on the server
  const [kioskModeEnabled, setKioskModeEnabled] = useState(false);
  const [backgroundCheckTrackingEnabled, setBackgroundCheckTrackingEnabled] = useState(false);
```

Add a `useEffect` alongside the existing `useEffect(() => { loadGatherings(); }, []);` (currently lines 150-152):

```tsx
  useEffect(() => {
    settingsAPI.getIntegrationSettings()
      .then(r => setBackgroundCheckTrackingEnabled(!!r.data.planningCenterTrackBackgroundChecks))
      .catch(() => {});
  }, []);
```

- [ ] **Step 2: Add the field to both interfaces**

Modify the `Gathering` interface (currently lines 19-46) to add `requiresBackgroundCheck?: boolean;` immediately after the existing `individualMode?: boolean;` line (42):

```tsx
  kioskEnabled?: boolean;
  leaderCheckinEnabled?: boolean;
  individualMode?: boolean;
  requiresBackgroundCheck?: boolean;
  isActive: boolean;
```

Modify the `CreateGatheringData` interface (currently lines 48-73) the same way, after its `individualMode?: boolean;` line (71):

```tsx
  kioskEnabled?: boolean;
  leaderCheckinEnabled?: boolean;
  individualMode?: boolean;
  requiresBackgroundCheck?: boolean;
  customDatesText?: string;
```

- [ ] **Step 3: Add the field to both initial-state objects and the wizard reset**

Modify `editFormData`'s initializer (currently lines 93-105):

```tsx
  const [editFormData, setEditFormData] = useState({
    name: '',
    description: '',
    dayOfWeek: 'Sunday',
    startTime: '10:00',
    endTime: '11:00',
    frequency: 'weekly',
    attendanceType: 'standard' as 'standard' | 'headcount',
    customSchedule: undefined as any,
    kioskEnabled: false,
    leaderCheckinEnabled: false,
    requiresBackgroundCheck: false,
    customDatesText: '' as string,
  });
```

Modify `createGatheringData`'s initializer (currently lines 107-118):

```tsx
  const [createGatheringData, setCreateGatheringData] = useState<CreateGatheringData>({
    name: 'Sunday Morning Service',
    description: 'Weekly Sunday morning gathering',
    dayOfWeek: 'Sunday',
    startTime: '10:00',
    endTime: '11:00',
    frequency: 'weekly',
    attendanceType: 'standard',
    kioskEnabled: false,
    leaderCheckinEnabled: false,
    individualMode: false,
    requiresBackgroundCheck: false,
  });
```

Modify `resetWizardState`'s reset object (currently lines 205-217, inside the `setCreateGatheringData({...})` call) the same way, adding `requiresBackgroundCheck: false,` after `individualMode: false,`.

- [ ] **Step 4: Include it in the create payload and the resulting local state**

Modify `handleCreateGathering`'s `gatheringData` object (currently lines 259-270):

```tsx
      let gatheringData: any = {
        name: createGatheringData.name,
        description: createGatheringData.description,
        dayOfWeek: createGatheringData.dayOfWeek,
        startTime: formattedStartTime,
        frequency: createGatheringData.frequency,
        attendanceType: createGatheringData.attendanceType,
        customSchedule: createGatheringData.customSchedule,
        kioskEnabled: createGatheringData.kioskEnabled,
        leaderCheckinEnabled: createGatheringData.leaderCheckinEnabled,
        individualMode: createGatheringData.individualMode,
        requiresBackgroundCheck: createGatheringData.requiresBackgroundCheck,
      };
```

Modify the `newGathering` object used to update local state after creation (currently lines 304-319):

```tsx
      const newGathering: Gathering = {
        id: newGatheringId,
        name: gatheringData.name,
        description: gatheringData.description,
        dayOfWeek: gatheringData.dayOfWeek,
        startTime: gatheringData.startTime,
        frequency: gatheringData.frequency,
        attendanceType: gatheringData.attendanceType,
        customSchedule: gatheringData.customSchedule,
        kioskEnabled: gatheringData.kioskEnabled,
        leaderCheckinEnabled: gatheringData.leaderCheckinEnabled,
        individualMode: gatheringData.individualMode,
        requiresBackgroundCheck: gatheringData.requiresBackgroundCheck,
        isActive: true,
        memberCount: 0,
        recentVisitorCount: 0
      };
```

- [ ] **Step 5: Populate it when opening the edit form**

Modify `handleEditGathering`'s `setEditFormData` call (currently lines 358-377), adding the new field after the existing `leaderCheckinEnabled` line (373):

```tsx
      kioskEnabled: gathering.kioskEnabled || false,
      leaderCheckinEnabled: gathering.leaderCheckinEnabled || false,
      requiresBackgroundCheck: gathering.requiresBackgroundCheck || false,
```

(No change needed to `handleUpdateGathering` itself — it spreads `...editFormData` directly into the PUT payload, so this field rides along automatically.)

- [ ] **Step 6: Add the checkbox to the edit form**

In the "Check-in Modes" block of the edit form (currently lines 1162-1177, the "Leader Check-in" checkbox), add a new checkbox immediately after it, gated on `backgroundCheckTrackingEnabled`:

```tsx
                    {backgroundCheckTrackingEnabled && (
                      <div>
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editFormData.requiresBackgroundCheck || false}
                            onChange={(e) => setEditFormData({ ...editFormData, requiresBackgroundCheck: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                          />
                          <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                            Requires background check
                          </span>
                        </label>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                          Shows each adult's Planning Center background-check status to whoever is taking attendance here.
                        </p>
                      </div>
                    )}
```

- [ ] **Step 7: Add the matching checkbox to the create form**

Find the equivalent "Leader Check-in" checkbox in the create form (currently around lines 1392-1407) and add the same block immediately after it, using `createGatheringData`/`setCreateGatheringData` instead of `editFormData`/`setEditFormData`:

```tsx
                    {backgroundCheckTrackingEnabled && (
                      <div>
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={createGatheringData.requiresBackgroundCheck || false}
                            onChange={(e) => setCreateGatheringData({ ...createGatheringData, requiresBackgroundCheck: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                          />
                          <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                            Requires background check
                          </span>
                        </label>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                          Shows each adult's Planning Center background-check status to whoever is taking attendance here.
                        </p>
                      </div>
                    )}
```

- [ ] **Step 8: Verify the client builds**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml logs --tail=60 client
```

Expected: no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/ManageGatheringsPage.tsx
git commit -m "$(cat <<'EOF'
feat(pco): add "Requires background check" checkbox to gathering type forms

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: People page — render the shield

**Files:**
- Modify: `client/src/components/people/PersonCard.tsx`
- Modify: `client/src/pages/PeoplePage.tsx`

- [ ] **Step 1: Add the prop to `PersonCard`**

In `client/src/components/people/PersonCard.tsx`, add the import:

```tsx
import BackgroundCheckShield from '../icons/BackgroundCheckShield';
```

Extend the `Person` interface (currently lines 4-21) to add `pcoBackgroundCheckCleared?: boolean | null;` alongside the existing `planningCenterId` field.

Extend `PersonCardProps` (currently lines 32-43) to add:

```tsx
  showBackgroundCheckStatus?: boolean;
```

Add it to the destructure (currently lines 45-56):

```tsx
  showBackgroundCheckStatus = false
```

- [ ] **Step 2: Render it next to the name**

Modify the name row (currently lines 82-100) to add the shield after the existing "PCO" pill:

```tsx
          <div className="flex items-center space-x-2 min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {displayName}
            </span>
            {planningCenterSyncIndicator && person.planningCenterId && (
              <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                PCO
              </span>
            )}
            {showBackgroundCheckStatus && !person.isChild && (
              <BackgroundCheckShield cleared={person.pcoBackgroundCheckCleared} className="w-4 h-4" />
            )}
            <div className="flex items-center space-x-1 shrink-0">
```

- [ ] **Step 3: Load and thread the flag through `PeoplePage.tsx`**

In `client/src/pages/PeoplePage.tsx`, add state near the existing `planningCenterSyncIndicator` state (currently line 113):

```tsx
  const [planningCenterTrackBackgroundChecks, setPlanningCenterTrackBackgroundChecks] = useState(false);
```

Modify `loadFamilies` (currently lines 359-367) to also capture it:

```tsx
  const loadFamilies = async () => {
    try {
      const response = await familiesAPI.getAll();
      setFamilies(response.data.families || []);
      setPlanningCenterSyncIndicator(!!response.data.planningCenterSyncIndicator);
      setPlanningCenterTrackBackgroundChecks(!!response.data.planningCenterTrackBackgroundChecks);
    } catch (err: any) {
      setError('Failed to load families');
    }
  };
```

Add a derived flag near `isAdmin` (currently line 109):

```tsx
  const isAdmin = user?.role === 'admin';
  const canSeeBackgroundCheckStatus = isAdmin || user?.role === 'coordinator';
  const showBackgroundCheckStatus = canSeeBackgroundCheckStatus && planningCenterTrackBackgroundChecks;
```

- [ ] **Step 4: Pass the prop to every `PersonCard` call site**

Find every `planningCenterSyncIndicator={planningCenterSyncIndicator}` prop passed to `<PersonCard`:

```bash
docker-compose -f docker-compose.dev.yml exec client grep -n "planningCenterSyncIndicator={planningCenterSyncIndicator}" src/pages/PeoplePage.tsx
```

Add `showBackgroundCheckStatus={showBackgroundCheckStatus}` immediately after each occurrence (there are 4, at approximately lines 1764, 1808, 1949, 2128 — confirm exact locations with the grep output above, since line numbers may have shifted after earlier tasks).

- [ ] **Step 5: Manual verification**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
```

In the browser, as an admin: enable "Track background check status" in the PCO integration tab (Task 13), then visit the People page. Expected: no visible shield yet unless `pcoBackgroundCheckCleared` is non-null for at least one adult (it will be, once Task 5's sync has run against a real PCO-linked person; otherwise it correctly shows nothing, since `NULL` and `false` render the same amber icon per the spec's "no data = treat as not cleared" decision — verify by manually setting a value directly in the DB for a quick visual check if no live PCO data is available):

```bash
docker-compose -f docker-compose.dev.yml exec server sqlite3 data/churches/<church_id>.sqlite \
  "UPDATE individuals SET pco_background_check_cleared = 1 WHERE id = <some_adult_id>;"
```

Refresh the People page and confirm a green shield appears next to that person's name, and does not appear for children.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/people/PersonCard.tsx client/src/pages/PeoplePage.tsx
git commit -m "$(cat <<'EOF'
feat(pco): render background-check shield on People page for admin/coordinator

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Attendance page — render the shield on flagged gatherings

**Files:**
- Modify: `client/src/pages/AttendancePage.tsx`

- [ ] **Step 1: Add the import**

```tsx
import BackgroundCheckShield from '../components/icons/BackgroundCheckShield';
```

- [ ] **Step 2: Capture `showBackgroundCheckStatus` from the `/full` response**

Find where `attendanceAPI.getFull` is consumed:

```bash
docker-compose -f docker-compose.dev.yml exec client grep -n "attendanceAPI.getFull\|apiResponse.data" src/pages/AttendancePage.tsx | head -10
```

Near the existing state declarations, add:

```tsx
const [showBackgroundCheckStatus, setShowBackgroundCheckStatus] = useState(false);
```

Where the `getFull` response is destructured/consumed (around line 995), add:

```tsx
setShowBackgroundCheckStatus(!!apiResponse.data.showBackgroundCheckStatus);
```

- [ ] **Step 3: Render the shield at each badge site**

There are three badge-rendering sites in this file, at approximately lines 3137-3178, 3282-3354, and 3432-3461 (confirm exact current line numbers, since earlier tasks may have shifted them):

```bash
docker-compose -f docker-compose.dev.yml exec client grep -n "getBadgeInfo(person)" src/pages/AttendancePage.tsx
```

At each site, immediately after the existing `<BadgeIcon .../>` rendering block for that row's `person`, add:

```tsx
{showBackgroundCheckStatus && !person.isChild && (
  <BackgroundCheckShield cleared={person.backgroundCheckCleared} className="w-4 h-4" />
)}
```

Place it inside the same row container the badge lives in, so it sits alongside the existing badge rather than replacing it.

- [ ] **Step 4: Manual verification**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
```

In the browser: flag a gathering with "Requires background check" (Task 14), turn on tracking (Task 13), set an adult's `pco_background_check_cleared` (via SQL as in Task 15 if no live PCO data yet), assign them to that gathering, and open standard attendance-taking for that gathering/date. Expected: shield renders next to their name. Switch to a gathering without the flag and confirm nothing renders.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AttendancePage.tsx
git commit -m "$(cat <<'EOF'
feat(pco): render background-check shield during standard attendance-taking on flagged gatherings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Leader check-in mode — render the shield

**Files:**
- Modify: `client/src/components/checkins/LeaderCheckInMode.tsx`

- [ ] **Step 1: Add the import**

```tsx
import BackgroundCheckShield from '../icons/BackgroundCheckShield';
```

- [ ] **Step 2: Capture the flag and thread it into `Individual` objects**

Add state near the other data state (currently lines 44-45):

```tsx
const [showBackgroundCheckStatus, setShowBackgroundCheckStatus] = useState(false);
```

In `loadAttendance` (currently lines 80-150), after the `attendanceAPI.getFull` call (line 83), add:

```tsx
setShowBackgroundCheckStatus(!!response.data.showBackgroundCheckStatus);
```

The `regulars` mapping (line 84-87) already spreads `...a`, which includes `backgroundCheckCleared` from the API response — no change needed there. In the visitor-mapping loop (lines 93-113), add `backgroundCheckCleared: v.backgroundCheckCleared,` alongside the existing `isChild: v.isChild,` line, for consistency (visitors are rare on flagged/kids gatherings but the field should still flow through if present).

- [ ] **Step 3: Render the shield at both badge sites**

```bash
docker-compose -f docker-compose.dev.yml exec client grep -n "getBadgeInfo(member)" src/components/checkins/LeaderCheckInMode.tsx
```

At each of the two sites (currently around lines 848 and 936), immediately after the existing `<BadgeIcon .../>` block for that `member`, add:

```tsx
{showBackgroundCheckStatus && !member.isChild && (
  <BackgroundCheckShield cleared={member.backgroundCheckCleared} className="w-4 h-4" />
)}
```

- [ ] **Step 4: Manual verification**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
```

Using the same flagged gathering set up in Task 16, switch to Leader Check-in mode for that gathering/date and confirm the shield renders identically there.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/checkins/LeaderCheckInMode.tsx
git commit -m "$(cat <<'EOF'
feat(pco): render background-check shield in leader check-in mode on flagged gatherings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Full end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Rebuild everything clean**

```bash
docker-compose -f docker-compose.dev.yml down
docker-compose -f docker-compose.dev.yml build
docker-compose -f docker-compose.dev.yml up -d
docker-compose -f docker-compose.dev.yml logs --tail=100
```

Expected: all services start with no errors.

- [ ] **Step 2: Run the full server test suite for touched modules**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/mode.dbintegration.test.js services/planningCenter/projection.test.js services/planningCenter/backgroundCheckSync.dbintegration.test.js
```

Expected: all PASS.

- [ ] **Step 3: Walk the golden path in the browser**

As an admin:
1. PCO integration tab → toggle "Track background check status" on. Confirm it persists after a page refresh.
2. Manage Gatherings → edit (or create) a standard gathering, e.g. "Kids Church" → check "Requires background check" (confirm the checkbox is visible now that tracking is on — hide it again by toggling tracking off and confirm it disappears from the form).
3. Trigger a PCO sync (or seed a test value via SQL per Task 15/16's fallback) so at least one linked adult has `pco_background_check_cleared = 1` and another has `= 0`.
4. People page: confirm the shield renders next to both adults (green vs amber) and does not render for any child.
5. Log in as (or switch to) an `attendance_taker`-role user. Confirm the shield does **not** appear on the People page for this role (per the admin/coordinator-only visibility rule).
6. As that `attendance_taker`, open standard attendance-taking for the flagged gathering + a date. Confirm the shield **does** appear there (per the split-visibility design).
7. Open Leader Check-in mode for the same gathering/date. Confirm the shield appears there too.
8. Open attendance for a gathering that is **not** flagged. Confirm no shield appears anywhere on that screen, even for the admin.

- [ ] **Step 4: Check for regressions in existing badge/PCO features**

Confirm the pre-existing custom badge system (allergy tags, etc. via `BadgeEditor.tsx`) still renders correctly alongside the new shield on all three surfaces (People page, attendance, leader check-in) — the two are independent visual elements sitting next to each other, not replacing one another.

- [ ] **Step 5: Report results**

Summarize what passed and what (if anything) couldn't be verified end-to-end (e.g. the live-PCO sync path from Task 5, Step 3, if no sandbox PCO account was available) so the user knows what still needs a real PCO-connected check before this ships.
