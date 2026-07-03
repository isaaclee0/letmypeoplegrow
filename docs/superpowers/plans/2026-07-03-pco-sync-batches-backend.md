# PCO Sync Batches — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single global all-or-nothing Planning Center filter with named, saved, independently-runnable/schedulable "sync batches," each optionally carrying a default `people_type` and a gathering to assign people to, plus a separate whole-roster "reconciliation" action for detecting people no longer found in PCO at all.

**Architecture:** A new `planning_center_sync_batches` table (one row per saved batch) replaces the single set of filter columns on `church_settings`. `computePlanForChurch` is refactored to take an explicit `filterConfig` parameter instead of reading it from `church_settings`, so it can be reused for any batch's filter or for reconciliation. `applyPlan` gains a `batchConfig` parameter (`defaultPeopleType`, `gatheringTypeId`) and now returns which individual ids it touched, so the caller can add them to a gathering's roster. The `archiveExtras` auto-archive step is pulled out of `applyPlan` into its own `applyArchiveExtras` function used only by the new reconciliation endpoints. The nightly cron iterates every batch (and the reconciliation config) per church instead of one global config per church.

**Tech Stack:** Node.js/Express, better-sqlite3, `node:test` for unit tests (run inside the dev Docker container per this project's Docker-only-builds rule).

**Spec:** [docs/superpowers/specs/2026-07-03-pco-sync-batches-design.md](../specs/2026-07-03-pco-sync-batches-design.md)

**Conventions for this plan:**
- Server unit tests run inside the dev container: `docker-compose -f docker-compose.dev.yml exec -T server node --test <path-relative-to-/app>` (working dir is `/app` = `server/`). Use `run --rm` instead of `exec -T` if the stack isn't already up.
- Route/DB-writing code that has no existing test harness in this codebase is verified manually via `curl`/`docker exec node -e`, matching how the original PCO sync backend plan verified its routes.
- Commit after every task.

---

## File Structure

- Modify `server/config/schema.js` — add `planning_center_sync_batches` table; add 5 reconciliation-schedule columns to `church_settings`.
- Modify `server/config/database.js` — additive migration for the new table/columns; one-time seed of a "Main Sync" batch from the legacy filter columns.
- Modify `server/services/planningCenter/apply.js` — `applyPlan` gains a `batchConfig` param (`defaultPeopleType`, `gatheringTypeId`); captures newly-created individual ids; assigns touched individuals to a gathering when configured; drops the `archiveExtras` auto-archive step (moved to a new `applyArchiveExtras` export).
- Modify `server/services/planningCenter/apply.test.js` — extend for the new pure behaviour (`groupAdds`/`buildFamilyName` unaffected; add coverage for whatever new pure logic is extracted).
- Modify `server/services/planningCenterSync.js` — `computePlanForChurch` takes an explicit `filterConfig`; add `listBatches`, `getBatch`, `computePlanForBatch`, `computeReconciliationForChurch`, `applyReconciliation`; rewrite `syncChurch`/`runNow` to iterate batches + reconciliation.
- Modify `server/routes/integrations.js` — remove `/planning-center/sync-filter` (GET/PUT), `/planning-center/sync/plan`, `/planning-center/sync/apply`; add `/planning-center/sync-batches` (GET/POST), `/planning-center/sync-batches/:id` (PUT/DELETE), `/planning-center/sync-batches/:id/plan` (GET), `/planning-center/sync-batches/:id/apply` (POST), `/planning-center/reconciliation/plan` (GET), `/planning-center/reconciliation/apply` (POST).
- Modify `server/routes/settings.js` — `GET/PUT /integrations` gain the master `planningCenterSyncEnabled` switch and reconciliation-schedule fields; drop the now-superseded `planningCenterSyncFrequency`/`planningCenterSyncDay` fields.

---

## Task 1: Schema + migration for `planning_center_sync_batches` and reconciliation columns

**Files:**
- Modify: `server/config/schema.js` (church_settings CREATE TABLE at lines 78-124; new table after the `gathering_lists` block at lines 216-229)
- Modify: `server/config/database.js` (church_settings migration block ending ~line 193)

- [ ] **Step 1: Add reconciliation columns to `church_settings` in schema.js**

In `server/config/schema.js`, find this line inside the `church_settings` CREATE TABLE (currently line 121):
```sql
  planning_center_checkin_import_state TEXT,
```
Add immediately after it:
```sql
  planning_center_reconciliation_schedule_enabled INTEGER DEFAULT 0,
  planning_center_reconciliation_frequency TEXT DEFAULT 'weekly',
  planning_center_reconciliation_day INTEGER DEFAULT 1,
  planning_center_reconciliation_last_run_at TEXT,
  planning_center_reconciliation_last_result TEXT,
```

- [ ] **Step 2: Add the `planning_center_sync_batches` table to schema.js**

Find the `gathering_lists` table block (currently lines 216-229), ending with:
```sql
CREATE INDEX IF NOT EXISTS idx_gl_gathering ON gathering_lists(gathering_type_id);
CREATE INDEX IF NOT EXISTS idx_gl_individual ON gathering_lists(individual_id);
```
Add immediately after it:
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

- [ ] **Step 3: Add the migration in database.js**

In `server/config/database.js`, find the individuals migration block ending (currently lines 186-193):
```javascript
      // Migrate individuals: add planning_center_id if missing
      const individualsCols = db.prepare('PRAGMA table_info(individuals)').all();
      if (!individualsCols.some(c => c.name === 'planning_center_id')) {
        db.exec('ALTER TABLE individuals ADD COLUMN planning_center_id TEXT');
      }
      if (!individualsCols.some(c => c.name === 'pco_link_declined')) {
        db.exec('ALTER TABLE individuals ADD COLUMN pco_link_declined INTEGER DEFAULT 0');
      }
```
Add immediately after that block (still inside the `if (!isNew)` branch, before the closing `}` that precedes `churchDbs.set(churchId, db);`):
```javascript

      // Migrate church_settings: reconciliation schedule columns
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_schedule_enabled')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_schedule_enabled INTEGER DEFAULT 0');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_frequency')) {
        db.exec("ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_frequency TEXT DEFAULT 'weekly'");
      }
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_day')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_day INTEGER DEFAULT 1');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_last_run_at')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_last_run_at TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_last_result')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_last_result TEXT');
      }

      // Create planning_center_sync_batches if missing, and seed exactly once from
      // the legacy single-filter columns (additive-only migration — the old columns
      // are left in place, unused, rather than dropped; this codebase's migrations
      // never DROP COLUMN).
      if (!existingTables.includes('planning_center_sync_batches')) {
        db.exec(`CREATE TABLE IF NOT EXISTS planning_center_sync_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          church_id TEXT NOT NULL,
          name TEXT NOT NULL,
          membership_filter_enabled INTEGER DEFAULT 0,
          membership_allowlist TEXT,
          field_filter_enabled INTEGER DEFAULT 0,
          field_filters TEXT,
          default_people_type TEXT DEFAULT 'regular' CHECK(default_people_type IN ('regular', 'local_visitor', 'traveller_visitor')),
          gathering_type_id INTEGER,
          schedule_enabled INTEGER DEFAULT 0,
          schedule_frequency TEXT DEFAULT 'weekly',
          schedule_day INTEGER DEFAULT 1,
          last_sync_at TEXT,
          last_sync_result TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE SET NULL
        )`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_pcsb_church ON planning_center_sync_batches(church_id)`);

        const legacy = db.prepare(
          `SELECT planning_center_membership_filter_enabled AS membershipFilterEnabled,
                  planning_center_membership_allowlist AS membershipAllowlist,
                  planning_center_field_filter_enabled AS fieldFilterEnabled,
                  planning_center_field_filters AS fieldFilters,
                  planning_center_sync_frequency AS syncFrequency,
                  planning_center_sync_day AS syncDay
             FROM church_settings WHERE church_id = ?`
        ).get(churchId);
        if (legacy) {
          let allowlistArr = [];
          try { allowlistArr = JSON.parse(legacy.membershipAllowlist || '[]'); } catch (_) {}
          let fieldFiltersArr = [];
          try { fieldFiltersArr = JSON.parse(legacy.fieldFilters || '[]'); } catch (_) {}
          const hasMembershipFilter = !!legacy.membershipFilterEnabled && allowlistArr.length > 0;
          const hasFieldFilter = !!legacy.fieldFilterEnabled && fieldFiltersArr.length > 0;
          // Only seed a batch when there was an actual configured filter — a church
          // that never touched PCO sync shouldn't get a dead "Main Sync" batch just
          // because membership_filter_enabled defaults to 1 with an empty allowlist.
          if (hasMembershipFilter || hasFieldFilter) {
            db.prepare(
              `INSERT INTO planning_center_sync_batches
                 (church_id, name, membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters,
                  default_people_type, gathering_type_id, schedule_enabled, schedule_frequency, schedule_day)
               VALUES (?, 'Main Sync', ?, ?, ?, ?, 'regular', NULL, 1, ?, ?)`
            ).run(
              churchId,
              legacy.membershipFilterEnabled ? 1 : 0,
              legacy.membershipAllowlist || '[]',
              legacy.fieldFilterEnabled ? 1 : 0,
              legacy.fieldFilters || '[]',
              legacy.syncFrequency || 'weekly',
              typeof legacy.syncDay === 'number' ? legacy.syncDay : 1
            );
          }
        }
      }
```

- [ ] **Step 4: Verify the migration applies to an existing church DB**

Restart the server container so the migration runs on open, then inspect an existing church DB (substitute a real church id from your dev data — e.g. `devch1`):
```
docker-compose -f docker-compose.dev.yml restart server
docker-compose -f docker-compose.dev.yml exec server node -e "
const D = require('./config/database');
D.getChurchDb('devch1');
const db = require('better-sqlite3')('/app/data/churches/devch1.sqlite');
console.log(db.prepare('PRAGMA table_info(church_settings)').all().map(c => c.name).filter(n => n.includes('reconciliation')));
console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='planning_center_sync_batches'\").all());
console.log(db.prepare('SELECT * FROM planning_center_sync_batches').all());
"
```
Expected: the reconciliation column names print; the table exists; if `devch1` had a membership allowlist or field filters configured, a `Main Sync` row appears with the copied filter values.

- [ ] **Step 5: Commit**

```bash
git add server/config/schema.js server/config/database.js
git commit -m "feat(pco): add sync_batches table and reconciliation schedule columns"
```

---

## Task 2: `apply.js` — batch config, gathering assignment, extract `applyArchiveExtras`

**Files:**
- Modify: `server/services/planningCenter/apply.js`
- Test: `server/services/planningCenter/apply.test.js`

- [ ] **Step 1: Write the failing test for the new pure `groupAdds`-adjacent behaviour**

`groupAdds`/`buildFamilyName` themselves don't change. Add a test that documents the new `applyArchiveExtras` export exists and is a plain function (the DB-writing behaviour itself is verified manually in Task 4, matching how `applyPlan`'s original DB paths were verified via curl rather than unit tests). Append to `server/services/planningCenter/apply.test.js`:

```javascript
const { applyArchiveExtras } = require('./apply');

test('applyArchiveExtras is exported as a function', () => {
  assert.strictEqual(typeof applyArchiveExtras, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/apply.test.js`
Expected: FAIL — `applyArchiveExtras` is `undefined`.

- [ ] **Step 3: Rewrite `apply.js`**

Replace the full contents of `server/services/planningCenter/apply.js` with:

```javascript
const Database = require('../../config/database');

// "Lastname, Firstname and Firstname" from adults first (matches importer convention).
function buildFamilyName(members) {
  const adults = members.filter((m) => !m.isChild);
  const nameMembers = adults.length ? adults : members;
  const lastName = (nameMembers[0] && nameMembers[0].lastName) || 'Unknown';
  const firstNames = nameMembers.map((m) => m.firstName).filter(Boolean);
  return firstNames.length ? `${lastName}, ${firstNames.join(' and ')}` : lastName;
}

// Group add entries by householdId; null household => its own solo group.
function groupAdds(adds) {
  const map = new Map();
  for (const a of adds) {
    const key = a.householdId || `solo_${a.pcoId}`;
    if (!map.has(key)) map.set(key, { householdId: a.householdId || null, members: [] });
    map.get(key).members.push(a);
  }
  return [...map.values()];
}

// Apply a plan within the CURRENT church DB context (caller sets context).
// selections:
//   { ambiguous?: {individualId: pcoId},
//     skipAddPcoIds?: string[],
//     visitorChoices?: {individualId: 'promote' | 'keep'} }
// batchConfig:
//   { defaultPeopleType?: 'regular'|'local_visitor'|'traveller_visitor', gatheringTypeId?: number|null }
//   — the batch's own settings; applied to every person this run creates or links.
// Returns counts + per-item errors (never throws on item failure). Does NOT touch
// plan.archiveExtras/unmatchedVisitors — those are whole-roster concerns handled by
// applyArchiveExtras() below, called only from the reconciliation endpoints.
async function applyPlan(churchId, plan, userId, selections = {}, batchConfig = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, errors: [] };
  const skipAdd = new Set(selections.skipAddPcoIds || []);
  const ambiguousChoices = selections.ambiguous || {};
  const visitorChoices = selections.visitorChoices || {};
  const defaultPeopleType = batchConfig.defaultPeopleType || 'regular';
  const gatheringTypeId = batchConfig.gatheringTypeId || null;
  // Every individual this run links, restores, promotes, or creates — used to
  // populate the batch's gathering roster (if one is configured) at the end.
  const touchedIndividualIds = new Set();

  // links (high-confidence active matches + any ambiguous resolved by the reviewer)
  const links = [...(plan.link || [])];
  for (const [individualId, pcoId] of Object.entries(ambiguousChoices)) {
    if (pcoId) links.push({ individualId: Number(individualId), pcoId });
  }
  for (const l of links) {
    try {
      await Database.query(
        `UPDATE individuals SET planning_center_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [l.pcoId, l.individualId, churchId]
      );
      result.linked++;
      touchedIndividualIds.add(l.individualId);
    } catch (e) { result.errors.push({ type: 'link', id: l.individualId, error: e.message }); }
  }

  // restore: archived LMPG individual whose name matches a PCO person -> link + reactivate.
  for (const r of (plan.restore || [])) {
    try {
      await Database.query(
        `UPDATE individuals SET planning_center_id = ?, is_active = 1, updated_at = datetime('now')
           WHERE id = ? AND church_id = ?`,
        [r.pcoId, r.individualId, churchId]
      );
      result.linked++;
      result.reactivated++;
      touchedIndividualIds.add(r.individualId);
    } catch (e) { result.errors.push({ type: 'restore', id: r.individualId, error: e.message }); }
  }

  // visitorMatches: reviewer decides per-person. Validate against the plan so a
  // client can only promote/keep visitors actually offered by this plan, and
  // only to the PCO id this plan associates with them.
  const visitorByIndividual = new Map((plan.visitorMatches || []).map((v) => [Number(v.individualId), v]));
  for (const [rawId, choice] of Object.entries(visitorChoices)) {
    const id = Number(rawId);
    const offer = visitorByIndividual.get(id);
    if (!offer) continue;
    try {
      if (choice === 'promote') {
        await Database.query(
          `UPDATE individuals
             SET planning_center_id = ?, people_type = 'regular', updated_at = datetime('now')
             WHERE id = ? AND church_id = ?`,
          [offer.candidate.pcoId, id, churchId]
        );
        result.linked++;
        touchedIndividualIds.add(id);
      } else if (choice === 'keep') {
        await Database.query(
          `UPDATE individuals
             SET pco_link_declined = 1, updated_at = datetime('now')
             WHERE id = ? AND church_id = ?`,
          [id, churchId]
        );
      }
    } catch (e) { result.errors.push({ type: 'visitorChoice', id, error: e.message }); }
  }

  for (const u of plan.update) {
    try {
      await Database.query(
        `UPDATE individuals SET first_name = ?, last_name = ?, is_child = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [u.firstName, u.lastName, u.isChild ? 1 : 0, u.individualId, churchId]
      );
      result.updated++;
    } catch (e) { result.errors.push({ type: 'update', id: u.individualId, error: e.message }); }
  }

  for (const a of plan.archive) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [a.individualId, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archive', id: a.individualId, error: e.message }); }
  }

  for (const r of plan.reactivate) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 1, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [r.individualId, churchId]
      );
      result.reactivated++;
    } catch (e) { result.errors.push({ type: 'reactivate', id: r.individualId, error: e.message }); }
  }

  // adds: resolve/create family per household, then insert individuals using this
  // batch's default_people_type. Capture new individual ids for gathering assignment.
  const adds = plan.add.filter((a) => !skipAdd.has(a.pcoId));
  const householdIds = [...new Set(adds.map((a) => a.householdId).filter(Boolean))];
  const familyByHousehold = new Map();
  if (householdIds.length) {
    const placeholders = householdIds.map(() => '?').join(',');
    const existing = await Database.query(
      `SELECT id, planning_center_id FROM families WHERE church_id = ? AND planning_center_id IN (${placeholders})`,
      [churchId, ...householdIds]
    );
    for (const f of existing) familyByHousehold.set(f.planning_center_id, f.id);
  }

  for (const g of groupAdds(adds)) {
    try {
      const { createdHouseholdFamilyId, newIds } = await Database.transaction(async (conn) => {
        let familyId = g.householdId ? familyByHousehold.get(g.householdId) : null;
        let created = null;
        if (!familyId) {
          const famRes = await conn.query(
            `INSERT INTO families (church_id, family_name, planning_center_id, created_by, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
            [churchId, buildFamilyName(g.members), g.householdId || null, userId]
          );
          familyId = famRes.insertId;
          if (g.householdId) created = familyId;
        }
        const ids = [];
        for (const m of g.members) {
          const insRes = await conn.query(
            `INSERT INTO individuals (church_id, family_id, first_name, last_name, people_type, is_child, is_active, created_by, created_at, planning_center_id)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), ?)`,
            [churchId, familyId, m.firstName, m.lastName, defaultPeopleType, m.isChild ? 1 : 0, userId, m.pcoId]
          );
          ids.push(insRes.insertId);
        }
        return { createdHouseholdFamilyId: created, newIds: ids };
      });
      if (createdHouseholdFamilyId) familyByHousehold.set(g.householdId, createdHouseholdFamilyId);
      for (const id of newIds) touchedIndividualIds.add(id);
      result.added += g.members.length;
    } catch (e) {
      result.errors.push({ type: 'add', household: g.householdId, error: e.message });
    }
  }

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

  return result;
}

// Archives active 'regular' individuals whose name matched no one in PCO's full
// people export (plan.archiveExtras from computePlan). Used only by the
// reconciliation endpoints — never called as part of a batch's own apply.
async function applyArchiveExtras(churchId, archiveExtras, skipArchiveExtraIds = []) {
  const skip = new Set(skipArchiveExtraIds.map(Number));
  const result = { archived: 0, errors: [] };
  for (const x of archiveExtras) {
    if (skip.has(Number(x.individualId))) continue;
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [x.individualId, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archiveExtra', id: x.individualId, error: e.message }); }
  }
  return result;
}

module.exports = { applyPlan, buildFamilyName, groupAdds, applyArchiveExtras };
```

Note: `Database.transaction`'s callback previously returned only the created family id (or `null`); it now returns `{ createdHouseholdFamilyId, newIds }` so newly-inserted individual ids survive the transaction closure for gathering assignment.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/apply.test.js`
Expected: PASS (all `buildFamilyName`/`groupAdds`/`applyArchiveExtras` tests green).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/apply.js server/services/planningCenter/apply.test.js
git commit -m "feat(pco): batch-scoped apply (people_type, gathering assignment); extract applyArchiveExtras"
```

---

## Task 3: `planningCenterSync.js` — batch/reconciliation orchestration

**Files:**
- Modify: `server/services/planningCenterSync.js`
- Test: `server/services/planningCenterSync.test.js` (existing `isDueToday` tests untouched; this task's changes are DB/HTTP-dependent and verified manually in Task 4/5)

- [ ] **Step 1: Refactor `computePlanForChurch` to take an explicit `filterConfig`**

In `server/services/planningCenterSync.js`, replace the existing `computePlanForChurch` function (currently lines 199-229):
```javascript
// Compute a plan for a church (current church context must be set by caller).
async function computePlanForChurch(churchId, accessToken, { force = false } = {}) {
  const { people: pcoPeople, fetchedAt } = await getCachedPcoPeople(churchId, accessToken, { force });
  const { individuals, families } = await loadChurchState(churchId);
  const settings = await Database.query(
    `SELECT planning_center_membership_filter_enabled AS membershipFilterEnabled,
            planning_center_membership_allowlist AS membershipAllowlistRaw,
            planning_center_field_filter_enabled AS fieldFilterEnabled,
            planning_center_field_filters AS fieldFiltersRaw
       FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  let membershipFilterEnabled = true;
  let fieldFilterEnabled = false;
  let membershipAllowlist = [];
  let fieldFilters = [];
  if (settings.length) {
    membershipFilterEnabled = !!settings[0].membershipFilterEnabled;
    fieldFilterEnabled = !!settings[0].fieldFilterEnabled;
    if (settings[0].membershipAllowlistRaw) {
      try { membershipAllowlist = JSON.parse(settings[0].membershipAllowlistRaw); } catch (_) { membershipAllowlist = []; }
    }
    if (settings[0].fieldFiltersRaw) {
      try { fieldFilters = JSON.parse(settings[0].fieldFiltersRaw); } catch (_) { fieldFilters = []; }
    }
  }
  const filterConfig = { membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters };
  const plan = computePlan({ pcoPeople, individuals, families, filterConfig });
  plan.pcoFetchedAt = new Date(fetchedAt).toISOString();
  return plan;
}
```
with:
```javascript
// Compute a plan for a church against an explicit filterConfig (current church
// context must be set by caller). filterConfig shape:
//   { membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters }
async function computePlanForChurch(churchId, accessToken, filterConfig, { force = false } = {}) {
  const { people: pcoPeople, fetchedAt } = await getCachedPcoPeople(churchId, accessToken, { force });
  const { individuals, families } = await loadChurchState(churchId);
  const plan = computePlan({ pcoPeople, individuals, families, filterConfig });
  plan.pcoFetchedAt = new Date(fetchedAt).toISOString();
  return plan;
}

// filterConfig for a saved batch.
function batchFilterConfig(batch) {
  return {
    membershipFilterEnabled: batch.membershipFilterEnabled,
    membershipAllowlist: batch.membershipAllowlist,
    fieldFilterEnabled: batch.fieldFilterEnabled,
    fieldFilters: batch.fieldFilters,
  };
}

async function computePlanForBatch(churchId, accessToken, batch, opts) {
  return computePlanForChurch(churchId, accessToken, batchFilterConfig(batch), opts);
}

// archiveExtras/unmatchedVisitors never consult filterConfig (they're name-matched
// against PCO's full unfiltered people export — see diffEngine.js), so any
// filterConfig works here; a neutral empty one keeps intent clear.
const NEUTRAL_FILTER_CONFIG = { membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [] };

async function computeReconciliationForChurch(churchId, accessToken, opts) {
  const plan = await computePlanForChurch(churchId, accessToken, NEUTRAL_FILTER_CONFIG, opts);
  return { archiveExtras: plan.archiveExtras, unmatchedVisitors: plan.unmatchedVisitors, pcoFetchedAt: plan.pcoFetchedAt };
}

async function applyReconciliation(churchId, plan, selections = {}) {
  return applyArchiveExtras(churchId, plan.archiveExtras, selections.skipArchiveExtraIds || []);
}
```

- [ ] **Step 2: Add the require for `applyArchiveExtras`**

At the top of `server/services/planningCenterSync.js`, change:
```javascript
const { applyPlan } = require('./planningCenter/apply');
```
to:
```javascript
const { applyPlan, applyArchiveExtras } = require('./planningCenter/apply');
```

- [ ] **Step 3: Update `applyForChurch` to forward `batchConfig`**

Replace:
```javascript
// Apply a plan for a church (current church context must be set by caller).
async function applyForChurch(churchId, plan, userId, selections) {
  return applyPlan(churchId, plan, userId, selections);
}
```
with:
```javascript
// Apply a plan for a church (current church context must be set by caller).
async function applyForChurch(churchId, plan, userId, selections, batchConfig = {}) {
  return applyPlan(churchId, plan, userId, selections, batchConfig);
}
```

- [ ] **Step 4: Add batch data-access helpers**

Add these functions above `computePlanForChurch` (after `loadChurchState`):
```javascript
// Row shape from planning_center_sync_batches -> the shape everything else expects.
function rowToBatch(row) {
  let membershipAllowlist = [];
  let fieldFilters = [];
  let lastSyncResult = null;
  if (row.membershipAllowlistRaw) { try { membershipAllowlist = JSON.parse(row.membershipAllowlistRaw); } catch (_) {} }
  if (row.fieldFiltersRaw) { try { fieldFilters = JSON.parse(row.fieldFiltersRaw); } catch (_) {} }
  if (row.lastSyncResultRaw) { try { lastSyncResult = JSON.parse(row.lastSyncResultRaw); } catch (_) {} }
  return {
    id: row.id,
    name: row.name,
    membershipFilterEnabled: !!row.membershipFilterEnabled,
    membershipAllowlist,
    fieldFilterEnabled: !!row.fieldFilterEnabled,
    fieldFilters,
    defaultPeopleType: row.defaultPeopleType || 'regular',
    gatheringTypeId: row.gatheringTypeId || null,
    scheduleEnabled: !!row.scheduleEnabled,
    scheduleFrequency: row.scheduleFrequency || 'weekly',
    scheduleDay: typeof row.scheduleDay === 'number' ? row.scheduleDay : 1,
    lastSyncAt: row.lastSyncAt || null,
    lastSyncResult,
  };
}

const BATCH_SELECT = `SELECT id, name, membership_filter_enabled AS membershipFilterEnabled,
         membership_allowlist AS membershipAllowlistRaw,
         field_filter_enabled AS fieldFilterEnabled,
         field_filters AS fieldFiltersRaw,
         default_people_type AS defaultPeopleType,
         gathering_type_id AS gatheringTypeId,
         schedule_enabled AS scheduleEnabled,
         schedule_frequency AS scheduleFrequency,
         schedule_day AS scheduleDay,
         last_sync_at AS lastSyncAt,
         last_sync_result AS lastSyncResultRaw
    FROM planning_center_sync_batches`;

async function listBatches(churchId) {
  const rows = await Database.query(`${BATCH_SELECT} WHERE church_id = ? ORDER BY id`, [churchId]);
  return rows.map(rowToBatch);
}

async function getBatch(churchId, batchId) {
  const rows = await Database.query(`${BATCH_SELECT} WHERE id = ? AND church_id = ? LIMIT 1`, [batchId, churchId]);
  return rows.length ? rowToBatch(rows[0]) : null;
}
```

- [ ] **Step 5: Rewrite `syncChurch` and add per-batch/reconciliation run helpers**

Replace the entire `syncChurch` function (currently lines 250-301) with:
```javascript
async function runBatchSync(churchId, batch, userId) {
  try {
    const accessToken = await getAccessTokenForChurch(churchId);
    if (!accessToken) { logger.warn(`PCO sync: no valid token for church ${churchId}`); return; }
    const plan = await computePlanForBatch(churchId, accessToken, batch, { force: true });
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
    await Database.query(
      `UPDATE planning_center_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(summary), batch.id]
    );
    logger.info(`PCO batch sync: church ${churchId} batch ${batch.id} (${batch.name}) done — ${JSON.stringify(summary)}`);
  } catch (err) {
    logger.error(`PCO batch sync: error for church ${churchId} batch ${batch.id}: ${err.message}`);
  }
}

async function runReconciliationSync(churchId, userId) {
  try {
    const accessToken = await getAccessTokenForChurch(churchId);
    if (!accessToken) return;
    const plan = await computeReconciliationForChurch(churchId, accessToken, { force: true });
    const result = await applyReconciliation(churchId, plan, {});
    const summary = { at: new Date().toISOString(), archived: result.archived, errors: result.errors.length };
    await Database.query(
      `UPDATE church_settings
          SET planning_center_reconciliation_last_run_at = datetime('now'),
              planning_center_reconciliation_last_result = ?
        WHERE church_id = ?`,
      [JSON.stringify(summary), churchId]
    );
    logger.info(`PCO reconciliation: church ${churchId} done — ${JSON.stringify(summary)}`);
  } catch (err) {
    logger.error(`PCO reconciliation: error for church ${churchId}: ${err.message}`);
  }
}

async function syncChurch(church, { skipScheduleCheck = false } = {}) {
  const churchId = church.church_id;
  await Database.setChurchContext(churchId, async () => {
    try {
      const settings = await Database.query(
        `SELECT planning_center_sync_enabled AS enabled,
                planning_center_reconciliation_schedule_enabled AS reconciliationScheduleEnabled,
                planning_center_reconciliation_frequency AS reconciliationFrequency,
                planning_center_reconciliation_day AS reconciliationDay,
                (SELECT user_id FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens' LIMIT 1) AS token_user
           FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId, churchId]
      );
      if (!settings.length || !settings[0].enabled) return;
      const userId = settings[0].token_user || null;

      const batches = await listBatches(churchId);
      for (const batch of batches) {
        if (!batch.scheduleEnabled) continue;
        if (!skipScheduleCheck && !isDueToday(batch.scheduleFrequency, batch.scheduleDay)) continue;
        await runBatchSync(churchId, batch, userId);
      }

      if (settings[0].reconciliationScheduleEnabled) {
        const due = skipScheduleCheck || isDueToday(settings[0].reconciliationFrequency, settings[0].reconciliationDay);
        if (due) await runReconciliationSync(churchId, userId);
      }
    } catch (err) {
      logger.error(`PCO sync: error for church ${churchId}: ${err.message}`);
    }
  });
}
```

- [ ] **Step 6: Export the new functions**

Replace the `module.exports` block at the bottom with:
```javascript
module.exports = {
  start, stop, runNow, syncChurch, isDueToday,
  getAccessTokenForChurch, computePlanForChurch, applyForChurch, fetchAllPcoPeople,
  getCachedPcoPeople, invalidatePcoPeopleCache, httpsGet,
  listBatches, getBatch, batchFilterConfig, computePlanForBatch,
  computeReconciliationForChurch, applyReconciliation,
};
```

- [ ] **Step 7: Verify the module loads cleanly**

```
docker-compose -f docker-compose.dev.yml exec -T server node -e "const s=require('./services/planningCenterSync'); console.log(Object.keys(s));"
```
Expected: prints the full key list from Step 6 with no load errors.

- [ ] **Step 8: Run the existing test file to confirm no regression**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenterSync.test.js`
Expected: PASS (existing `isDueToday` tests unaffected).

- [ ] **Step 9: Commit**

```bash
git add server/services/planningCenterSync.js
git commit -m "refactor(pco): batch-scoped plan computation and per-batch cron orchestration"
```

---

## Task 4: Batch CRUD + plan/apply routes; remove old single-filter routes

**Files:**
- Modify: `server/routes/integrations.js`

- [ ] **Step 1: Remove the old single-filter and sync/plan/apply routes**

Delete the four route handlers currently at lines 2582-2695 (`GET /planning-center/sync-filter` and `PUT /planning-center/sync-filter`) and lines 2750-2817 (`POST /planning-center/sync/apply`) and the dry-run route at lines 2665-2695 (`GET /planning-center/sync/plan`) — i.e. remove:
```javascript
// Read sync config (both filter sources + enabled flag)
router.get('/planning-center/sync-filter', async (req, res) => { ... });

// Write sync config
router.put('/planning-center/sync-filter', async (req, res) => { ... });

// Dry-run: compute the reconcile plan without writing anything
router.get('/planning-center/sync/plan', async (req, res) => { ... });
```
and:
```javascript
// Apply: recompute the plan and apply it. Body may include { selections } for review choices.
// With no selections, applies everything except ambiguous (auto mode).
router.post('/planning-center/sync/apply', async (req, res) => { ... });
```
Leave `/planning-center/membership-summary`, `/planning-center/field-definitions`, and `/planning-center/field-summary` untouched — batches still use them to build their filter UI.

- [ ] **Step 2: Add batch CRUD + plan/apply routes**

In the gap left by Step 1 (between `field-summary` and the check-in import routes), add:
```javascript
const PCO_PEOPLE_TYPES = ['regular', 'local_visitor', 'traveller_visitor'];
const PCO_BATCH_FREQUENCIES = ['daily', 'weekly', 'monthly'];

function validateBatchBody(body) {
  const { name, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters,
          defaultPeopleType, gatheringTypeId, scheduleEnabled, scheduleFrequency, scheduleDay } = body;
  if (typeof name !== 'string' || !name.trim()) return 'name is required.';
  if (typeof membershipFilterEnabled !== 'boolean') return 'membershipFilterEnabled must be a boolean.';
  if (typeof fieldFilterEnabled !== 'boolean') return 'fieldFilterEnabled must be a boolean.';
  if (!Array.isArray(membershipAllowlist) || !membershipAllowlist.every((v) => typeof v === 'string')) {
    return 'membershipAllowlist must be an array of strings.';
  }
  if (!Array.isArray(fieldFilters)) return 'fieldFilters must be an array.';
  for (const rule of fieldFilters) {
    if (!rule || typeof rule.fieldDefinitionId !== 'string' || !Array.isArray(rule.values) || !rule.values.every((v) => typeof v === 'string')) {
      return 'Each field filter rule needs a fieldDefinitionId and an array of string values.';
    }
  }
  if (!PCO_PEOPLE_TYPES.includes(defaultPeopleType)) {
    return 'defaultPeopleType must be one of regular, local_visitor, traveller_visitor.';
  }
  if (gatheringTypeId !== null && gatheringTypeId !== undefined && !Number.isInteger(gatheringTypeId)) {
    return 'gatheringTypeId must be an integer or null.';
  }
  if (typeof scheduleEnabled !== 'boolean') return 'scheduleEnabled must be a boolean.';
  if (!PCO_BATCH_FREQUENCIES.includes(scheduleFrequency)) return 'scheduleFrequency must be one of daily, weekly, monthly.';
  if (!Number.isInteger(scheduleDay) || scheduleDay < 0 || scheduleDay > 6) return 'scheduleDay must be an integer between 0 and 6.';
  return null;
}

// List all saved sync batches for this church.
router.get('/planning-center/sync-batches', async (req, res) => {
  try {
    const batches = await pcoSync.listBatches(req.user.church_id);
    res.json({ success: true, batches });
  } catch (error) {
    logger.error('List PCO sync batches error:', error);
    res.status(500).json({ error: 'Failed to load sync batches.' });
  }
});

// Create a new saved sync batch.
router.post('/planning-center/sync-batches', async (req, res) => {
  try {
    const err = validateBatchBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const churchId = req.user.church_id;
    const { name, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters,
            defaultPeopleType, gatheringTypeId, scheduleEnabled, scheduleFrequency, scheduleDay } = req.body;
    const insRes = await Database.query(
      `INSERT INTO planning_center_sync_batches
         (church_id, name, membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters,
          default_people_type, gathering_type_id, schedule_enabled, schedule_frequency, schedule_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [churchId, name.trim(), membershipFilterEnabled ? 1 : 0, JSON.stringify(membershipAllowlist),
       fieldFilterEnabled ? 1 : 0, JSON.stringify(fieldFilters), defaultPeopleType, gatheringTypeId || null,
       scheduleEnabled ? 1 : 0, scheduleFrequency, scheduleDay]
    );
    const batch = await pcoSync.getBatch(churchId, insRes.insertId);
    res.json({ success: true, batch });
  } catch (error) {
    logger.error('Create PCO sync batch error:', error);
    res.status(500).json({ error: 'Failed to create sync batch.' });
  }
});

// Update a saved sync batch.
router.put('/planning-center/sync-batches/:id', async (req, res) => {
  try {
    const err = validateBatchBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const churchId = req.user.church_id;
    const batchId = Number(req.params.id);
    const existing = await pcoSync.getBatch(churchId, batchId);
    if (!existing) return res.status(404).json({ error: 'Sync batch not found.' });
    const { name, membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters,
            defaultPeopleType, gatheringTypeId, scheduleEnabled, scheduleFrequency, scheduleDay } = req.body;
    await Database.query(
      `UPDATE planning_center_sync_batches
          SET name = ?, membership_filter_enabled = ?, membership_allowlist = ?,
              field_filter_enabled = ?, field_filters = ?, default_people_type = ?,
              gathering_type_id = ?, schedule_enabled = ?, schedule_frequency = ?, schedule_day = ?,
              updated_at = datetime('now')
        WHERE id = ? AND church_id = ?`,
      [name.trim(), membershipFilterEnabled ? 1 : 0, JSON.stringify(membershipAllowlist),
       fieldFilterEnabled ? 1 : 0, JSON.stringify(fieldFilters), defaultPeopleType, gatheringTypeId || null,
       scheduleEnabled ? 1 : 0, scheduleFrequency, scheduleDay, batchId, churchId]
    );
    const batch = await pcoSync.getBatch(churchId, batchId);
    res.json({ success: true, batch });
  } catch (error) {
    logger.error('Update PCO sync batch error:', error);
    res.status(500).json({ error: 'Failed to update sync batch.' });
  }
});

// Delete a saved sync batch. Does not unlink or archive anyone already imported
// through it — it only stops future runs of that filter.
router.delete('/planning-center/sync-batches/:id', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const batchId = Number(req.params.id);
    const existing = await pcoSync.getBatch(churchId, batchId);
    if (!existing) return res.status(404).json({ error: 'Sync batch not found.' });
    await Database.query(`DELETE FROM planning_center_sync_batches WHERE id = ? AND church_id = ?`, [batchId, churchId]);
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete PCO sync batch error:', error);
    res.status(500).json({ error: 'Failed to delete sync batch.' });
  }
});

// Dry-run: compute one batch's plan without writing anything.
router.get('/planning-center/sync-batches/:id/plan', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const batch = await pcoSync.getBatch(churchId, Number(req.params.id));
    if (!batch) return res.status(404).json({ error: 'Sync batch not found.' });
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const force = req.query.refresh === '1' || req.query.force === '1';
    const fullPlan = await pcoSync.computePlanForBatch(churchId, accessToken, batch, { force });
    // Batch plans omit the whole-roster buckets — those live under /reconciliation.
    const { archiveExtras, unmatchedVisitors, ...plan } = fullPlan;
    res.json({
      success: true,
      summary: {
        link: plan.link.length,
        restore: (plan.restore || []).length,
        ambiguous: plan.ambiguous.length,
        visitorMatches: (plan.visitorMatches || []).length,
        add: plan.add.length,
        update: plan.update.length,
        archive: plan.archive.length,
        reactivate: plan.reactivate.length,
      },
      plan,
    });
  } catch (error) {
    logger.error('PCO batch sync plan error:', error);
    res.status(500).json({ error: 'Failed to compute sync plan.' });
  }
});

// Apply: recompute this batch's plan and apply it. Body may include { selections }.
router.post('/planning-center/sync-batches/:id/apply', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const userId = req.user.id;
    const batch = await pcoSync.getBatch(churchId, Number(req.params.id));
    if (!batch) return res.status(404).json({ error: 'Sync batch not found.' });
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const plan = await pcoSync.computePlanForBatch(churchId, accessToken, batch);

    const rawSel = (req.body && req.body.selections) || {};
    const candidatesByIndividual = new Map(
      plan.ambiguous.map((a) => [a.individualId, new Set(a.candidates)])
    );
    const ambiguous = {};
    for (const [individualId, pcoId] of Object.entries(rawSel.ambiguous || {})) {
      const allowed = candidatesByIndividual.get(Number(individualId));
      if (allowed && pcoId && allowed.has(pcoId)) ambiguous[individualId] = pcoId;
    }
    const addPcoIds = new Set(plan.add.map((a) => a.pcoId));
    const skipAddPcoIds = (Array.isArray(rawSel.skipAddPcoIds) ? rawSel.skipAddPcoIds : [])
      .filter((id) => addPcoIds.has(id));
    const visitorOfferIds = new Set((plan.visitorMatches || []).map((v) => Number(v.individualId)));
    const visitorChoices = {};
    for (const [rawId, choice] of Object.entries(rawSel.visitorChoices || {})) {
      const id = Number(rawId);
      if (visitorOfferIds.has(id) && (choice === 'promote' || choice === 'keep')) {
        visitorChoices[id] = choice;
      }
    }
    const selections = { ambiguous, skipAddPcoIds, visitorChoices };

    const result = await pcoSync.applyForChurch(churchId, plan, userId, selections, {
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
    await Database.query(
      `UPDATE planning_center_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
      [JSON.stringify(summary), batch.id, churchId]
    );
    res.json({ success: true, result, summary });
  } catch (error) {
    logger.error('PCO batch sync apply error:', error);
    res.status(500).json({ error: 'Failed to apply sync.' });
  }
});

// Dry-run: whole-roster reconciliation (people no longer found in PCO at all).
router.get('/planning-center/reconciliation/plan', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });
    const force = req.query.refresh === '1' || req.query.force === '1';
    const plan = await pcoSync.computeReconciliationForChurch(churchId, accessToken, { force });
    res.json({
      success: true,
      summary: { archiveExtras: plan.archiveExtras.length, unmatchedVisitors: plan.unmatchedVisitors.length },
      plan,
    });
  } catch (error) {
    logger.error('PCO reconciliation plan error:', error);
    res.status(500).json({ error: 'Failed to compute reconciliation plan.' });
  }
});

// Apply: archive the selected archiveExtras. unmatchedVisitors is informational only.
router.post('/planning-center/reconciliation/apply', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const plan = await pcoSync.computeReconciliationForChurch(churchId, accessToken);
    const rawSel = (req.body && req.body.selections) || {};
    const extraIds = new Set(plan.archiveExtras.map((x) => Number(x.individualId)));
    const skipArchiveExtraIds = (Array.isArray(rawSel.skipArchiveExtraIds) ? rawSel.skipArchiveExtraIds : [])
      .map(Number)
      .filter((id) => extraIds.has(id));

    const result = await pcoSync.applyReconciliation(churchId, plan, { skipArchiveExtraIds });
    const summary = { at: new Date().toISOString(), archived: result.archived, errors: result.errors.length };
    await Database.query(
      `UPDATE church_settings
          SET planning_center_reconciliation_last_run_at = datetime('now'),
              planning_center_reconciliation_last_result = ?
        WHERE church_id = ?`,
      [JSON.stringify(summary), churchId]
    );
    res.json({ success: true, result, summary });
  } catch (error) {
    logger.error('PCO reconciliation apply error:', error);
    res.status(500).json({ error: 'Failed to apply reconciliation.' });
  }
});
```

- [ ] **Step 3: Verify via curl against a connected dev church**

With the dev stack running and a browser session logged in as an admin whose church already has Planning Center connected, copy the `token` cookie value and run (substitute the real cookie):
```bash
COOKIE='token=...'
BASE='http://localhost:3001/api/integrations'

# Create a batch
curl -s -X POST "$BASE/planning-center/sync-batches" -H 'Content-Type: application/json' -b "$COOKIE" -d '{
  "name": "Test Batch", "membershipFilterEnabled": true, "membershipAllowlist": ["Church Members"],
  "fieldFilterEnabled": false, "fieldFilters": [], "defaultPeopleType": "regular", "gatheringTypeId": null,
  "scheduleEnabled": false, "scheduleFrequency": "weekly", "scheduleDay": 1
}' | tee /tmp/batch.json

BATCH_ID=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/batch.json')).batch.id")

# List, plan, and delete
curl -s "$BASE/planning-center/sync-batches" -b "$COOKIE"
curl -s "$BASE/planning-center/sync-batches/$BATCH_ID/plan" -b "$COOKIE"
curl -s -X DELETE "$BASE/planning-center/sync-batches/$BATCH_ID" -b "$COOKIE"

# Reconciliation
curl -s "$BASE/planning-center/reconciliation/plan" -b "$COOKIE"
```
Expected: batch create/list/plan/delete all return `success: true` with sensible shapes; the plan response's `plan` object has no `archiveExtras`/`unmatchedVisitors` keys; reconciliation's plan response has `summary.archiveExtras`/`summary.unmatchedVisitors` counts.

- [ ] **Step 4: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): batch CRUD/plan/apply routes and reconciliation routes; remove single-filter routes"
```

---

## Task 5: `settings.js` — master switch + reconciliation schedule; drop superseded fields

**Files:**
- Modify: `server/routes/settings.js` (lines 503-566)

- [ ] **Step 1: Replace `GET /integrations`**

Replace the existing handler (currently lines 503-524):
```javascript
router.get('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const rows = await Database.query(
      `SELECT planning_center_sync_indicator, planning_center_auto_archive,
              planning_center_last_sync, planning_center_last_sync_archived,
              planning_center_sync_frequency, planning_center_sync_day
       FROM church_settings WHERE church_id = ? LIMIT 1`,
      [req.user.church_id]
    );
    const row = rows[0] || {};
    res.json({
      planningCenterSyncIndicator: !!(row.planning_center_sync_indicator),
      planningCenterAutoArchive: !!(row.planning_center_auto_archive),
      planningCenterLastSync: row.planning_center_last_sync || null,
      planningCenterLastSyncArchived: row.planning_center_last_sync_archived || 0,
      planningCenterSyncFrequency: row.planning_center_sync_frequency || 'weekly',
      planningCenterSyncDay: typeof row.planning_center_sync_day === 'number' ? row.planning_center_sync_day : 1,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve integration settings.' });
  }
});
```
with:
```javascript
router.get('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const rows = await Database.query(
      `SELECT planning_center_sync_indicator, planning_center_auto_archive, planning_center_sync_enabled,
              planning_center_reconciliation_schedule_enabled, planning_center_reconciliation_frequency,
              planning_center_reconciliation_day, planning_center_reconciliation_last_run_at,
              planning_center_reconciliation_last_result
       FROM church_settings WHERE church_id = ? LIMIT 1`,
      [req.user.church_id]
    );
    const row = rows[0] || {};
    let reconciliationLastResult = null;
    if (row.planning_center_reconciliation_last_result) {
      try { reconciliationLastResult = JSON.parse(row.planning_center_reconciliation_last_result); } catch (_) {}
    }
    res.json({
      planningCenterSyncIndicator: !!(row.planning_center_sync_indicator),
      planningCenterAutoArchive: !!(row.planning_center_auto_archive),
      planningCenterSyncEnabled: !!(row.planning_center_sync_enabled),
      planningCenterReconciliationScheduleEnabled: !!(row.planning_center_reconciliation_schedule_enabled),
      planningCenterReconciliationFrequency: row.planning_center_reconciliation_frequency || 'weekly',
      planningCenterReconciliationDay: typeof row.planning_center_reconciliation_day === 'number' ? row.planning_center_reconciliation_day : 1,
      planningCenterReconciliationLastRunAt: row.planning_center_reconciliation_last_run_at || null,
      planningCenterReconciliationLastResult: reconciliationLastResult,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve integration settings.' });
  }
});
```

- [ ] **Step 2: Replace `PUT /integrations`**

Replace the existing handler and its `PCO_SYNC_FREQUENCIES` constant (currently lines 526-566):
```javascript
const PCO_SYNC_FREQUENCIES = ['daily', 'weekly', 'monthly'];

router.put('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const { planningCenterSyncIndicator, planningCenterAutoArchive, planningCenterSyncFrequency, planningCenterSyncDay } = req.body;
    const updates = [];
    const params = [];
    if (typeof planningCenterSyncIndicator === 'boolean') {
      updates.push('planning_center_sync_indicator = ?');
      params.push(planningCenterSyncIndicator ? 1 : 0);
    }
    if (typeof planningCenterAutoArchive === 'boolean') {
      updates.push('planning_center_auto_archive = ?');
      params.push(planningCenterAutoArchive ? 1 : 0);
    }
    if (planningCenterSyncFrequency !== undefined) {
      if (!PCO_SYNC_FREQUENCIES.includes(planningCenterSyncFrequency)) {
        return res.status(400).json({ error: 'planningCenterSyncFrequency must be one of daily, weekly, monthly.' });
      }
      updates.push('planning_center_sync_frequency = ?');
      params.push(planningCenterSyncFrequency);
    }
    if (planningCenterSyncDay !== undefined) {
      if (!Number.isInteger(planningCenterSyncDay) || planningCenterSyncDay < 0 || planningCenterSyncDay > 6) {
        return res.status(400).json({ error: 'planningCenterSyncDay must be an integer between 0 and 6.' });
      }
      updates.push('planning_center_sync_day = ?');
      params.push(planningCenterSyncDay);
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
with:
```javascript
const PCO_RECONCILIATION_FREQUENCIES = ['daily', 'weekly', 'monthly'];

router.put('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const {
      planningCenterSyncIndicator, planningCenterAutoArchive, planningCenterSyncEnabled,
      planningCenterReconciliationScheduleEnabled, planningCenterReconciliationFrequency,
      planningCenterReconciliationDay,
    } = req.body;
    const updates = [];
    const params = [];
    if (typeof planningCenterSyncIndicator === 'boolean') {
      updates.push('planning_center_sync_indicator = ?');
      params.push(planningCenterSyncIndicator ? 1 : 0);
    }
    if (typeof planningCenterAutoArchive === 'boolean') {
      updates.push('planning_center_auto_archive = ?');
      params.push(planningCenterAutoArchive ? 1 : 0);
    }
    if (typeof planningCenterSyncEnabled === 'boolean') {
      updates.push('planning_center_sync_enabled = ?');
      params.push(planningCenterSyncEnabled ? 1 : 0);
    }
    if (typeof planningCenterReconciliationScheduleEnabled === 'boolean') {
      updates.push('planning_center_reconciliation_schedule_enabled = ?');
      params.push(planningCenterReconciliationScheduleEnabled ? 1 : 0);
    }
    if (planningCenterReconciliationFrequency !== undefined) {
      if (!PCO_RECONCILIATION_FREQUENCIES.includes(planningCenterReconciliationFrequency)) {
        return res.status(400).json({ error: 'planningCenterReconciliationFrequency must be one of daily, weekly, monthly.' });
      }
      updates.push('planning_center_reconciliation_frequency = ?');
      params.push(planningCenterReconciliationFrequency);
    }
    if (planningCenterReconciliationDay !== undefined) {
      if (!Number.isInteger(planningCenterReconciliationDay) || planningCenterReconciliationDay < 0 || planningCenterReconciliationDay > 6) {
        return res.status(400).json({ error: 'planningCenterReconciliationDay must be an integer between 0 and 6.' });
      }
      updates.push('planning_center_reconciliation_day = ?');
      params.push(planningCenterReconciliationDay);
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

- [ ] **Step 3: Verify via curl**

```bash
COOKIE='token=...'
curl -s http://localhost:3001/api/settings/integrations -b "$COOKIE"
curl -s -X PUT http://localhost:3001/api/settings/integrations -H 'Content-Type: application/json' -b "$COOKIE" -d '{
  "planningCenterSyncEnabled": true,
  "planningCenterReconciliationScheduleEnabled": true,
  "planningCenterReconciliationFrequency": "monthly",
  "planningCenterReconciliationDay": 1
}'
curl -s http://localhost:3001/api/settings/integrations -b "$COOKIE"
```
Expected: the second GET reflects the PUT — `planningCenterSyncEnabled: true`, `planningCenterReconciliationScheduleEnabled: true`, `planningCenterReconciliationFrequency: "monthly"`; no `planningCenterSyncFrequency`/`planningCenterSyncDay` keys in the response.

- [ ] **Step 4: Commit**

```bash
git add server/routes/settings.js
git commit -m "feat(pco): master sync switch + reconciliation schedule in integration settings"
```

---

## Manual verification checklist (no DB integration test harness exists in this codebase)

After all tasks are complete, with the dev stack running and a church connected to Planning Center:

1. Create two batches with different filters (e.g. one membership category each). Run each via `POST .../sync-batches/:id/apply`. Confirm people matching only Batch B never appear in Batch A's `add` bucket, and vice versa.
2. Set a `gatheringTypeId` on a batch, run it, and confirm newly-added/linked individuals appear in that gathering's roster (`gathering_lists`).
3. Set a `defaultPeopleType` of `local_visitor` on a batch, run it against PCO people not yet in LMPG, and confirm the created individuals have `people_type = 'local_visitor'`.
4. Run `GET .../reconciliation/plan` and confirm it only lists people whose name matches no one in PCO at all — not people who simply don't match a particular batch's filter.
5. Restart the server against a pre-existing church DB that had the old single filter configured, and confirm a "Main Sync" batch was auto-created with the same allowlist/schedule.
