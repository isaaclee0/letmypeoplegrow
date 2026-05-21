# Planning Center People Sync — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend for a Planning Center → LMPG full people sync (PCO as source of truth): a pure reconcile engine (project → match → diff → apply) shared by a one-time link, a nightly cron, and a manual "Sync now" endpoint.

**Architecture:** A memory-efficient paginated fetch projects each PCO person to a minimal shape; a pure matcher links unlinked LMPG individuals to PCO people by name + family + child flag; a pure diff engine emits buckets (link/ambiguous/unmatched/add/update/archive/reactivate); an apply layer writes the changes. Orchestration in `planningCenterSync.js` wires fetch→diff→apply for both cron and HTTP endpoints. Frontend UI is a separate plan.

**Tech Stack:** Node 22 (`better-sqlite3` via the app's `Database` wrapper), Express, `node:test` + `node:assert` for unit tests (run inside the dev Docker container). Per project rule, **all builds/tests run in Docker**, never locally.

**Spec:** `docs/superpowers/specs/2026-05-21-planning-center-people-sync-design.md`

---

## File Structure

- Create `server/services/planningCenter/projection.js` — `projectPerson()` minimal-shape mapper
- Create `server/services/planningCenter/projection.test.js`
- Create `server/services/planningCenter/matcher.js` — `normalizeName`, `nameKey`, `buildNameIndex`, `matchIndividuals`
- Create `server/services/planningCenter/matcher.test.js`
- Create `server/services/planningCenter/diffEngine.js` — `computePlan()`
- Create `server/services/planningCenter/diffEngine.test.js`
- Create `server/services/planningCenter/apply.js` — `applyPlan`, `buildFamilyName`, `groupAdds`
- Create `server/services/planningCenter/apply.test.js` (pure helpers only)
- Modify `server/config/schema.js` — add 3 columns to `church_settings` CREATE TABLE
- Modify `server/config/database.js:126-142` — migration ALTERs for the 3 columns
- Modify `server/services/planningCenterSync.js` — refactor orchestration to use the new modules
- Modify `server/routes/integrations.js` — add 4 endpoints

**Test run command (used throughout):**
```
docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/<file>.test.js
```
If the dev stack is not running, substitute `run --rm` for `exec`:
```
docker compose -f docker-compose.dev.yml run --rm server node --test services/planningCenter/<file>.test.js
```

---

## Task 1: Schema + migration for new church_settings columns

**Files:**
- Modify: `server/config/schema.js` (church_settings CREATE TABLE, near line 106-109)
- Modify: `server/config/database.js` (church_settings migration block, near line 142)

- [ ] **Step 1: Add columns to the CREATE TABLE in schema.js**

In `server/config/schema.js`, find the existing lines (around 106-109):
```sql
  planning_center_sync_indicator INTEGER DEFAULT 0,
  planning_center_auto_archive INTEGER DEFAULT 0,
  planning_center_last_sync TEXT,
  planning_center_last_sync_archived INTEGER DEFAULT 0,
```
Add three new lines immediately after them:
```sql
  planning_center_sync_enabled INTEGER DEFAULT 0,
  planning_center_membership_allowlist TEXT,
  planning_center_last_sync_result TEXT,
```

- [ ] **Step 2: Add migration ALTERs in database.js**

In `server/config/database.js`, find the church_settings migration block ending around line 142 (after the `planning_center_last_sync_archived` migration). Add immediately after that `if` block:
```javascript
      if (!settingsCols.some(c => c.name === 'planning_center_sync_enabled')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_sync_enabled INTEGER DEFAULT 0');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_membership_allowlist')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_membership_allowlist TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_last_sync_result')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_last_sync_result TEXT');
      }
```

- [ ] **Step 3: Verify migration applies to an existing church DB**

Restart the server container so the migration runs on open:
```
docker compose -f docker-compose.dev.yml restart server
```
Then confirm the columns now exist on an existing church DB:
```
docker compose -f docker-compose.dev.yml exec server node -e "const D=require('./config/database'); D.getChurchDb('crc_54cc7bdb2f53'); const db=require('better-sqlite3')('/app/data/churches/crc_54cc7bdb2f53.sqlite'); console.log(db.prepare('PRAGMA table_info(church_settings)').all().map(c=>c.name).filter(n=>n.startsWith('planning_center')));"
```
Expected: array includes `planning_center_sync_enabled`, `planning_center_membership_allowlist`, `planning_center_last_sync_result`.

- [ ] **Step 4: Commit**

```bash
git add server/config/schema.js server/config/database.js
git commit -m "feat(pco): add sync_enabled, membership_allowlist, last_sync_result columns"
```

---

## Task 2: projection.js — minimal PCO person shape

**Files:**
- Create: `server/services/planningCenter/projection.js`
- Test: `server/services/planningCenter/projection.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/planningCenter/projection.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { projectPerson } = require('./projection');

test('projectPerson maps attributes and first household id', () => {
  const raw = {
    id: '123',
    attributes: { first_name: 'Sarah', last_name: 'Wierenga', status: 'active', membership: 'Church Members', child: false },
    relationships: { households: { data: [{ id: 'h1' }, { id: 'h2' }] } },
  };
  assert.deepStrictEqual(projectPerson(raw), {
    id: '123', firstName: 'Sarah', lastName: 'Wierenga',
    status: 'active', membership: 'Church Members', child: false, householdId: 'h1',
  });
});

test('projectPerson handles missing fields and no household', () => {
  const p = projectPerson({ id: '9', attributes: { child: true } });
  assert.strictEqual(p.firstName, '');
  assert.strictEqual(p.lastName, '');
  assert.strictEqual(p.status, null);
  assert.strictEqual(p.membership, null);
  assert.strictEqual(p.child, true);
  assert.strictEqual(p.householdId, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/projection.test.js`
Expected: FAIL — cannot find module `./projection`.

- [ ] **Step 3: Write the implementation**

Create `server/services/planningCenter/projection.js`:
```javascript
// Project a raw PCO Person (people/v2/people with include=households) down to the
// minimal shape the sync engine needs. Keeps memory flat — callers discard the raw.
function projectPerson(p) {
  const a = p.attributes || {};
  const hh = p.relationships && p.relationships.households && p.relationships.households.data;
  return {
    id: p.id,
    firstName: a.first_name || '',
    lastName: a.last_name || '',
    status: a.status || null,
    membership: a.membership || null,
    child: a.child === true,
    householdId: (hh && hh[0] && hh[0].id) || null,
  };
}

module.exports = { projectPerson };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/projection.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/projection.js server/services/planningCenter/projection.test.js
git commit -m "feat(pco): add projectPerson minimal-shape mapper"
```

---

## Task 3: matcher.js — name/family matching

**Files:**
- Create: `server/services/planningCenter/matcher.js`
- Test: `server/services/planningCenter/matcher.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/planningCenter/matcher.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeName, nameKey, matchIndividuals } = require('./matcher');

test('normalizeName lowercases, strips punctuation/accents, collapses spaces', () => {
  assert.strictEqual(normalizeName('  O’Brien-Smith '), 'obriensmith');
  assert.strictEqual(normalizeName('José'), 'jose');
});

function pco(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, status: 'active', membership: 'Church Members', child: false, householdId: null, ...extra };
}
function ind(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, isChild: false, familyId: null, ...extra };
}

test('tier 1: unique name match auto-links', () => {
  const r = matchIndividuals([ind(1, 'Sarah', 'Wierenga')], [pco('p1', 'Sarah', 'Wierenga')], new Map());
  assert.deepStrictEqual(r.links, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(r.ambiguous, []);
  assert.deepStrictEqual(r.unmatched, []);
});

test('no candidate -> unmatched', () => {
  const r = matchIndividuals([ind(1, 'Nobody', 'Here')], [pco('p1', 'Sarah', 'Wierenga')], new Map());
  assert.deepStrictEqual(r.unmatched, [1]);
  assert.deepStrictEqual(r.links, []);
});

test('child flag disambiguates same-name adult/child', () => {
  const people = [pco('pa', 'Sam', 'Lee', { child: false }), pco('pc', 'Sam', 'Lee', { child: true })];
  const r = matchIndividuals([ind(1, 'Sam', 'Lee', { isChild: true })], people, new Map());
  assert.deepStrictEqual(r.links, [{ individualId: 1, pcoId: 'pc' }]);
});

test('family corroboration breaks a name tie', () => {
  // Two "John Smith" in PCO; the one whose household also contains "Jane Smith" wins.
  const people = [
    pco('j1', 'John', 'Smith', { householdId: 'hA' }),
    pco('j2', 'John', 'Smith', { householdId: 'hB' }),
    pco('jane', 'Jane', 'Smith', { householdId: 'hA' }),
  ];
  const familyMembers = new Map([[10, [{ firstName: 'John', lastName: 'Smith' }, { firstName: 'Jane', lastName: 'Smith' }]]]);
  const r = matchIndividuals([ind(1, 'John', 'Smith', { familyId: 10 })], people, familyMembers);
  assert.deepStrictEqual(r.links, [{ individualId: 1, pcoId: 'j1' }]);
});

test('unresolved duplicate -> ambiguous with candidate ids', () => {
  const people = [pco('j1', 'John', 'Smith'), pco('j2', 'John', 'Smith')];
  const r = matchIndividuals([ind(1, 'John', 'Smith')], people, new Map());
  assert.strictEqual(r.links.length, 0);
  assert.strictEqual(r.ambiguous.length, 1);
  assert.deepStrictEqual(r.ambiguous[0].candidates.sort(), ['j1', 'j2']);
});

test('a pco person is not linked to two individuals', () => {
  const r = matchIndividuals([ind(1, 'Sarah', 'Wierenga'), ind(2, 'Sarah', 'Wierenga')], [pco('p1', 'Sarah', 'Wierenga')], new Map());
  assert.strictEqual(r.links.length, 1);
  assert.strictEqual(r.unmatched.length, 1);
});

test('nameKey is stable for first+last', () => {
  assert.strictEqual(nameKey('John', 'Smith'), 'john|smith');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/matcher.test.js`
Expected: FAIL — cannot find module `./matcher`.

- [ ] **Step 3: Write the implementation**

Create `server/services/planningCenter/matcher.js`:
```javascript
// Pure matching of UNLINKED LMPG individuals to PCO people using only
// name + family/household context + child flag (LMPG stores nothing else).

function normalizeName(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, '')        // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKey(first, last) {
  return normalizeName(first) + '|' + normalizeName(last);
}

function buildNameIndex(people) {
  const idx = new Map();
  for (const p of people) {
    const k = nameKey(p.firstName, p.lastName);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(p);
  }
  return idx;
}

// unlinked: [{id, firstName, lastName, isChild, familyId}]
// availablePco: projected people not already linked
// familyMembers: Map<familyId, [{firstName,lastName}]>
// returns { links:[{individualId,pcoId}], ambiguous:[{individualId,candidates:[pcoId]}], unmatched:[individualId] }
function matchIndividuals(unlinked, availablePco, familyMembers) {
  const nameIndex = buildNameIndex(availablePco);
  const householdMembers = new Map();
  for (const p of availablePco) {
    if (!p.householdId) continue;
    if (!householdMembers.has(p.householdId)) householdMembers.set(p.householdId, []);
    householdMembers.get(p.householdId).push(p);
  }

  const used = new Set();
  const links = [];
  const ambiguous = [];
  const unmatched = [];

  const ordered = [...unlinked].sort((a, b) => a.id - b.id);
  for (const ind of ordered) {
    const k = nameKey(ind.firstName, ind.lastName);
    const candidates = (nameIndex.get(k) || []).filter((p) => !used.has(p.id));

    if (candidates.length === 0) { unmatched.push(ind.id); continue; }
    if (candidates.length === 1) { links.push({ individualId: ind.id, pcoId: candidates[0].id }); used.add(candidates[0].id); continue; }

    // child-flag narrowing
    const byChild = candidates.filter((p) => p.child === !!ind.isChild);
    if (byChild.length === 1) { links.push({ individualId: ind.id, pcoId: byChild[0].id }); used.add(byChild[0].id); continue; }
    const pool = byChild.length ? byChild : candidates;

    // family corroboration: score each candidate by household-member name overlap
    const famKeys = new Set(
      (familyMembers.get(ind.familyId) || [])
        .map((m) => nameKey(m.firstName, m.lastName))
        .filter((kk) => kk !== k)
    );
    let best = null, bestScore = 0, tie = false;
    for (const c of pool) {
      const hm = householdMembers.get(c.householdId) || [];
      let score = 0;
      for (const m of hm) { if (famKeys.has(nameKey(m.firstName, m.lastName))) score++; }
      if (score > bestScore) { bestScore = score; best = c; tie = false; }
      else if (score === bestScore && score > 0) { tie = true; }
    }
    if (best && bestScore > 0 && !tie) { links.push({ individualId: ind.id, pcoId: best.id }); used.add(best.id); continue; }

    ambiguous.push({ individualId: ind.id, candidates: pool.map((p) => p.id) });
  }

  return { links, ambiguous, unmatched };
}

module.exports = { normalizeName, nameKey, buildNameIndex, matchIndividuals };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/matcher.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/matcher.js server/services/planningCenter/matcher.test.js
git commit -m "feat(pco): add name/family matcher with confidence tiers"
```

---

## Task 4: diffEngine.js — compute the reconcile plan

**Files:**
- Create: `server/services/planningCenter/diffEngine.js`
- Test: `server/services/planningCenter/diffEngine.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/planningCenter/diffEngine.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { computePlan } = require('./diffEngine');

function pco(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, status: 'active', membership: 'Church Members', child: false, householdId: null, ...extra };
}
function ind(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, isChild: false, familyId: null, isActive: true, planningCenterId: null, ...extra };
}
const ALLOW = ['Church Members', 'Regular Attenders'];

test('archive only on PCO inactive for a linked person', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'inactive' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.archive, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.reactivate, []);
});

test('reactivate requires active AND allow-list membership', () => {
  const inAllow = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Church Members' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(inAllow.reactivate, [{ individualId: 1, pcoId: 'p1' }]);

  const notAllow = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(notAllow.reactivate, []);
});

test('update when name or child flag differs', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Robert', 'Jones', { child: true })],
    individuals: [ind(1, 'Bob', 'Jones', { planningCenterId: 'p1', isChild: false })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.update, [{ individualId: 1, pcoId: 'p1', firstName: 'Robert', lastName: 'Jones', isChild: true }]);
});

test('add only for allow-listed active people with no LMPG match', () => {
  const plan = computePlan({
    pcoPeople: [
      pco('p1', 'New', 'Member', { membership: 'Church Members' }),
      pco('p2', 'Some', 'Contact', { membership: 'Community Contact' }),
      pco('p3', 'Gone', 'Person', { membership: 'Church Members', status: 'inactive' }),
    ],
    individuals: [], families: [], allowlist: ALLOW,
  });
  assert.strictEqual(plan.add.length, 1);
  assert.strictEqual(plan.add[0].pcoId, 'p1');
});

test('name-matched unlinked person becomes a link, never a duplicate add', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Sarah', 'Wierenga', { membership: 'Church Members' })],
    individuals: [ind(1, 'Sarah', 'Wierenga', { planningCenterId: null })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.link, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.add, []);
});

test('membership demotion while active is a no-op (no archive)', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.archive, []);
  assert.deepStrictEqual(plan.reactivate, []);
});

test('ambiguous candidate is not added', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'John', 'Smith'), pco('p2', 'John', 'Smith')],
    individuals: [ind(1, 'John', 'Smith', { planningCenterId: null })],
    families: [], allowlist: ALLOW,
  });
  assert.strictEqual(plan.ambiguous.length, 1);
  assert.deepStrictEqual(plan.add, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/diffEngine.test.js`
Expected: FAIL — cannot find module `./diffEngine`.

- [ ] **Step 3: Write the implementation**

Create `server/services/planningCenter/diffEngine.js`:
```javascript
const { matchIndividuals } = require('./matcher');

// Inputs:
//   pcoPeople:   projected [{id, firstName, lastName, status, membership, child, householdId}]
//   individuals: [{id, firstName, lastName, isChild, familyId, isActive(bool), planningCenterId}]
//   families:    [{id, planningCenterId}]   (not used directly here; reserved for callers)
//   allowlist:   string[] of allowed membership values
// Output buckets: { link, ambiguous, unmatched, add, update, archive, reactivate }
function computePlan({ pcoPeople, individuals, families, allowlist }) {
  const allow = new Set(allowlist || []);
  const linked = individuals.filter((i) => i.planningCenterId);
  const unlinked = individuals.filter((i) => !i.planningCenterId);
  const linkedPcoIds = new Set(linked.map((i) => i.planningCenterId));
  const pcoById = new Map(pcoPeople.map((p) => [p.id, p]));
  const availablePco = pcoPeople.filter((p) => !linkedPcoIds.has(p.id));

  // family membership for corroboration
  const familyMembers = new Map();
  for (const i of individuals) {
    if (i.familyId == null) continue;
    if (!familyMembers.has(i.familyId)) familyMembers.set(i.familyId, []);
    familyMembers.get(i.familyId).push({ firstName: i.firstName, lastName: i.lastName });
  }

  const { links, ambiguous, unmatched } = matchIndividuals(unlinked, availablePco, familyMembers);

  const update = [];
  const archive = [];
  const reactivate = [];
  for (const i of linked) {
    const p = pcoById.get(i.planningCenterId);
    if (!p) continue; // linked person absent from PCO fetch -> leave alone
    if (i.isActive && p.status === 'inactive') {
      archive.push({ individualId: i.id, pcoId: p.id });
    } else if (!i.isActive && p.status === 'active' && allow.has(p.membership)) {
      reactivate.push({ individualId: i.id, pcoId: p.id });
    }
    if (p.firstName !== i.firstName || p.lastName !== i.lastName || p.child !== !!i.isChild) {
      update.push({ individualId: i.id, pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child });
    }
  }

  // add: allow-listed active people not consumed by a link or ambiguous candidate
  const usedPco = new Set(links.map((l) => l.pcoId));
  for (const a of ambiguous) for (const c of a.candidates) usedPco.add(c);
  const add = [];
  for (const p of availablePco) {
    if (usedPco.has(p.id)) continue;
    if (p.status === 'active' && allow.has(p.membership)) {
      add.push({ pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child, householdId: p.householdId, membership: p.membership });
    }
  }

  return { link: links, ambiguous, unmatched, add, update, archive, reactivate };
}

module.exports = { computePlan };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/diffEngine.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/diffEngine.js server/services/planningCenter/diffEngine.test.js
git commit -m "feat(pco): add reconcile diff engine"
```

---

## Task 5: apply.js — pure helpers + DB writer

**Files:**
- Create: `server/services/planningCenter/apply.js`
- Test: `server/services/planningCenter/apply.test.js` (pure helpers only; DB path verified in Task 7 via curl)

- [ ] **Step 1: Write the failing test (pure helpers)**

Create `server/services/planningCenter/apply.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { buildFamilyName, groupAdds } = require('./apply');

test('buildFamilyName uses adults first', () => {
  const name = buildFamilyName([
    { firstName: 'Mark', lastName: 'Arroyo', isChild: false },
    { firstName: 'Christine', lastName: 'Arroyo', isChild: false },
    { firstName: 'Kid', lastName: 'Arroyo', isChild: true },
  ]);
  assert.strictEqual(name, 'Arroyo, Mark and Christine');
});

test('buildFamilyName falls back to all members when no adults', () => {
  const name = buildFamilyName([{ firstName: 'Kid', lastName: 'Arroyo', isChild: true }]);
  assert.strictEqual(name, 'Arroyo, Kid');
});

test('groupAdds groups by household, solo for null household', () => {
  const groups = groupAdds([
    { pcoId: 'a', householdId: 'h1', firstName: 'A', lastName: 'X', isChild: false },
    { pcoId: 'b', householdId: 'h1', firstName: 'B', lastName: 'X', isChild: false },
    { pcoId: 'c', householdId: null, firstName: 'C', lastName: 'Y', isChild: false },
  ]);
  assert.strictEqual(groups.length, 2);
  const h1 = groups.find((g) => g.householdId === 'h1');
  assert.strictEqual(h1.members.length, 2);
  const solo = groups.find((g) => g.householdId === null);
  assert.strictEqual(solo.members.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/apply.test.js`
Expected: FAIL — cannot find module `./apply`.

- [ ] **Step 3: Write the implementation**

Create `server/services/planningCenter/apply.js`:
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
// selections: { ambiguous?: {individualId: pcoId}, skipAddPcoIds?: string[] }
// Returns counts + per-item errors (never throws on item failure).
async function applyPlan(churchId, plan, userId, selections = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, errors: [] };
  const skipAdd = new Set(selections.skipAddPcoIds || []);
  const ambiguousChoices = selections.ambiguous || {};

  // links (high-confidence + any ambiguous resolved by the reviewer)
  const links = [...plan.link];
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
    } catch (e) { result.errors.push({ type: 'link', id: l.individualId, error: e.message }); }
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

  // adds: resolve/create family per household, then insert individuals
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
      let familyId = g.householdId ? familyByHousehold.get(g.householdId) : null;
      if (!familyId) {
        const famRes = await Database.query(
          `INSERT INTO families (church_id, family_name, planning_center_id, created_by, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
          [churchId, buildFamilyName(g.members), g.householdId || null, userId]
        );
        familyId = famRes.insertId;
        if (g.householdId) familyByHousehold.set(g.householdId, familyId);
      }
      for (const m of g.members) {
        await Database.query(
          `INSERT INTO individuals (church_id, family_id, first_name, last_name, people_type, is_child, is_active, created_by, created_at, planning_center_id)
           VALUES (?, ?, ?, ?, 'regular', ?, 1, ?, datetime('now'), ?)`,
          [churchId, familyId, m.firstName, m.lastName, m.isChild ? 1 : 0, userId, m.pcoId]
        );
        result.added++;
      }
    } catch (e) { result.errors.push({ type: 'add', household: g.householdId, error: e.message }); }
  }

  return result;
}

module.exports = { applyPlan, buildFamilyName, groupAdds };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/apply.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/apply.js server/services/planningCenter/apply.test.js
git commit -m "feat(pco): add plan apply layer with family resolution"
```

---

## Task 6: Refactor planningCenterSync.js orchestration

**Files:**
- Modify: `server/services/planningCenterSync.js` (replace the per-person archive logic; keep token/http helpers)

- [ ] **Step 1: Add the projected fetch + state loader + plan/apply orchestration**

In `server/services/planningCenterSync.js`, add these requires at the top (after the existing requires):
```javascript
const { projectPerson } = require('./planningCenter/projection');
const { computePlan } = require('./planningCenter/diffEngine');
const { applyPlan } = require('./planningCenter/apply');
```

Add these functions above the `syncChurch` function:
```javascript
// Token accessor for endpoints/cron (wraps existing helpers).
async function getAccessTokenForChurch(churchId) {
  const tokenData = await getTokensForChurch(churchId);
  if (!tokenData) return null;
  return getValidAccessToken(churchId, tokenData.userId, tokenData.tokens);
}

// Memory-efficient: project each page, discard raw JSON + included resources.
async function fetchAllPcoPeople(accessToken) {
  const people = [];
  let next = 'https://api.planningcenteronline.com/people/v2/people?per_page=100&include=households';
  while (next) {
    const resp = await httpsGet(next, accessToken);
    if (resp.status !== 200) {
      throw new Error(`PCO people fetch failed (status ${resp.status})`);
    }
    const data = resp.data;
    for (const raw of data.data || []) people.push(projectPerson(raw));
    next = (data.links && data.links.next) || null;
  }
  return people;
}

// Load the minimal LMPG state for the current church context.
async function loadChurchState(churchId) {
  const individuals = await Database.query(
    `SELECT id, first_name AS firstName, last_name AS lastName, is_child AS isChild,
            family_id AS familyId, is_active AS isActive, planning_center_id AS planningCenterId
       FROM individuals WHERE church_id = ?`,
    [churchId]
  );
  const families = await Database.query(
    `SELECT id, planning_center_id AS planningCenterId FROM families WHERE church_id = ?`,
    [churchId]
  );
  // normalize sqlite ints to booleans for the engine
  for (const i of individuals) { i.isChild = !!i.isChild; i.isActive = !!i.isActive; }
  return { individuals, families };
}

// Compute a plan for a church (current church context must be set by caller).
async function computePlanForChurch(churchId, accessToken) {
  const pcoPeople = await fetchAllPcoPeople(accessToken);
  const { individuals, families } = await loadChurchState(churchId);
  const settings = await Database.query(
    `SELECT planning_center_membership_allowlist FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  let allowlist = [];
  if (settings.length && settings[0].planning_center_membership_allowlist) {
    try { allowlist = JSON.parse(settings[0].planning_center_membership_allowlist); } catch (_) { allowlist = []; }
  }
  return computePlan({ pcoPeople, individuals, families, allowlist });
}

// Apply a plan for a church (current church context must be set by caller).
async function applyForChurch(churchId, plan, userId, selections) {
  return applyPlan(churchId, plan, userId, selections);
}
```

- [ ] **Step 2: Replace the body of `syncChurch` to use the reconcile pipeline**

Replace the entire `syncChurch` function with:
```javascript
async function syncChurch(church) {
  const churchId = church.church_id;
  await Database.setChurchContext(churchId, async () => {
    try {
      const settings = await Database.query(
        `SELECT planning_center_sync_enabled, planning_center_auto_archive,
                (SELECT user_id FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens' LIMIT 1) AS token_user
           FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId, churchId]
      );
      const enabled = settings.length && (settings[0].planning_center_sync_enabled || settings[0].planning_center_auto_archive);
      if (!enabled) return;

      const accessToken = await getAccessTokenForChurch(churchId);
      if (!accessToken) { logger.warn(`PCO sync: no valid token for church ${churchId}`); return; }

      const userId = settings[0].token_user || null;
      const plan = await computePlanForChurch(churchId, accessToken);
      // Auto mode: apply everything except ambiguous (no selections).
      const result = await applyForChurch(churchId, plan, userId, {});

      const summary = {
        at: new Date().toISOString(),
        added: result.added, updated: result.updated, archived: result.archived,
        reactivated: result.reactivated, ambiguous: plan.ambiguous.length,
        unmatched: plan.unmatched.length, errors: result.errors.length,
      };
      await Database.query(
        `UPDATE church_settings
            SET planning_center_last_sync = datetime('now'),
                planning_center_last_sync_archived = ?,
                planning_center_last_sync_result = ?
          WHERE church_id = ?`,
        [result.archived, JSON.stringify(summary), churchId]
      );
      logger.info(`PCO sync: church ${churchId} done — ${JSON.stringify(summary)}`);
    } catch (err) {
      logger.error(`PCO sync: error for church ${churchId}: ${err.message}`);
    }
  });
}
```

- [ ] **Step 3: Export the new functions**

Replace the `module.exports` line at the bottom with:
```javascript
module.exports = {
  start, stop, runNow, syncChurch,
  getAccessTokenForChurch, computePlanForChurch, applyForChurch,
};
```

- [ ] **Step 4: Verify the module loads and a dry-run plan computes (no token needed to load)**

Confirm the service requires cleanly inside the container:
```
docker compose -f docker-compose.dev.yml exec server node -e "const s=require('./services/planningCenterSync'); console.log(Object.keys(s));"
```
Expected: prints `[ 'start', 'stop', 'runNow', 'syncChurch', 'getAccessTokenForChurch', 'computePlanForChurch', 'applyForChurch' ]` with no load errors.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenterSync.js
git commit -m "refactor(pco): use reconcile pipeline for full people sync"
```

---

## Task 7: API endpoints for plan/apply/membership-filter

**Files:**
- Modify: `server/routes/integrations.js` (add 4 routes in the Planning Center section, after the existing `import-people` route)

- [ ] **Step 1: Add a require for the sync service**

At the top of `server/routes/integrations.js`, add (if not already present):
```javascript
const pcoSync = require('../services/planningCenterSync');
```

- [ ] **Step 2: Add the membership-filter GET/PUT routes**

After the existing `/planning-center/import-people` route, add:
```javascript
// Read sync config (allow-list + enabled flag)
router.get('/planning-center/membership-filter', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const rows = await Database.query(
      `SELECT planning_center_sync_enabled AS enabled, planning_center_membership_allowlist AS allowlist
         FROM church_settings WHERE church_id = ? LIMIT 1`,
      [churchId]
    );
    let allowlist = [];
    if (rows.length && rows[0].allowlist) { try { allowlist = JSON.parse(rows[0].allowlist); } catch (_) {} }
    res.json({ enabled: !!(rows.length && rows[0].enabled), allowlist });
  } catch (error) {
    logger.error('Get PCO membership filter error:', error);
    res.status(500).json({ error: 'Failed to read sync config.' });
  }
});

// Write sync config
router.put('/planning-center/membership-filter', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const { enabled, allowlist } = req.body;
    if (!Array.isArray(allowlist)) return res.status(400).json({ error: 'allowlist must be an array.' });
    await Database.query(
      `UPDATE church_settings
          SET planning_center_sync_enabled = ?, planning_center_membership_allowlist = ?
        WHERE church_id = ?`,
      [enabled ? 1 : 0, JSON.stringify(allowlist), churchId]
    );
    res.json({ success: true, enabled: !!enabled, allowlist });
  } catch (error) {
    logger.error('Set PCO membership filter error:', error);
    res.status(500).json({ error: 'Failed to save sync config.' });
  }
});
```

- [ ] **Step 3: Add the sync plan (dry-run) route**

Add after the membership-filter routes:
```javascript
// Dry-run: compute the reconcile plan without writing anything
router.get('/planning-center/sync/plan', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const plan = await pcoSync.computePlanForChurch(churchId, accessToken);
    res.json({
      success: true,
      summary: {
        link: plan.link.length, ambiguous: plan.ambiguous.length, unmatched: plan.unmatched.length,
        add: plan.add.length, update: plan.update.length, archive: plan.archive.length, reactivate: plan.reactivate.length,
      },
      plan,
    });
  } catch (error) {
    logger.error('PCO sync plan error:', error);
    res.status(500).json({ error: 'Failed to compute sync plan.', details: error.message });
  }
});
```

- [ ] **Step 4: Add the sync apply route**

Add after the plan route:
```javascript
// Apply: recompute the plan and apply it. Body may include { selections } for review choices.
// With no selections, applies everything except ambiguous (auto mode).
router.post('/planning-center/sync/apply', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const userId = req.user.id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const plan = await pcoSync.computePlanForChurch(churchId, accessToken);
    const result = await pcoSync.applyForChurch(churchId, plan, userId, req.body.selections || {});

    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      ambiguous: plan.ambiguous.length, unmatched: plan.unmatched.length, errors: result.errors.length,
    };
    await Database.query(
      `UPDATE church_settings
          SET planning_center_last_sync = datetime('now'),
              planning_center_last_sync_archived = ?,
              planning_center_last_sync_result = ?
        WHERE church_id = ?`,
      [result.archived, JSON.stringify(summary), churchId]
    );
    res.json({ success: true, result, summary });
  } catch (error) {
    logger.error('PCO sync apply error:', error);
    res.status(500).json({ error: 'Failed to apply sync.', details: error.message });
  }
});
```

- [ ] **Step 5: Restart server and verify routes load**

```
docker compose -f docker-compose.dev.yml restart server
docker compose -f docker-compose.dev.yml logs --tail=30 server
```
Expected: server starts with no errors (no "Cannot find module", no syntax error).

- [ ] **Step 6: Manual verification of the membership-filter round-trip**

This requires an authenticated session cookie for a church. Using the admin or a logged-in token, PUT then GET the filter (replace `<COOKIE>` with a valid auth cookie; the dev nginx serves the API on port 80):
```
curl -s -X PUT 'http://localhost/api/integrations/planning-center/membership-filter' \
  -H 'Content-Type: application/json' -H 'Cookie: <COOKIE>' \
  -d '{"enabled":true,"allowlist":["Church Members","Regular Attenders"]}'
curl -s 'http://localhost/api/integrations/planning-center/membership-filter' -H 'Cookie: <COOKIE>'
```
Expected: the GET returns `{"enabled":true,"allowlist":["Church Members","Regular Attenders"]}`.

Note: end-to-end `/sync/plan` and `/sync/apply` verification needs a PCO-connected church and is covered when the frontend (Plan 2) is wired; the route-load check in Step 5 plus the unit-tested engine cover the logic here.

- [ ] **Step 7: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): add sync plan/apply and membership-filter endpoints"
```

---

## Self-Review Notes

- **Spec coverage:** schema/config (Task 1), minimal projection (Task 2), matcher tiers + guards (Task 3), diff engine rules incl. allow-list gates add only / archive-on-inactive / reactivate-requires-allow-list / demotion no-op / link-over-add (Task 4), apply incl. family resolution + history-preserving archive via `is_active=0` (Task 5), efficient paginated fetch + cron + last_sync_result (Task 6), endpoints + manual trigger (Task 7). Historical-visibility needs no code (existing `reports.js:182`).
- **Out of scope (this plan):** frontend UI (config panel, review screen, "Sync now" button) → Plan 2; nickname matching; family restructuring; LMPG→PCO push.
- **Type consistency:** `computePlan` buckets (`link/ambiguous/unmatched/add/update/archive/reactivate`) are produced in Task 4 and consumed unchanged in Task 5 (`applyPlan`) and Task 6/7. `projectPerson` shape (Task 2) is the input contract for matcher (Task 3) and diff engine (Task 4). `applyPlan(churchId, plan, userId, selections)` signature is identical in Tasks 5, 6, 7.
