# PCO Manual Linkage, Manual Archive, and Family Name Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer manually search and link (or archive) any PCO person for an LMPG individual the automatic matcher couldn't confidently resolve — both the "ambiguous" bucket (Sync Review) and the "unmatched extras" bucket (Reconciliation Review) — and keep LMPG family names in sync with PCO's designated head-of-household as a reviewable step in Sync Review.

**Architecture:** A new pure search helper (`peopleSearch.js`) backs a `GET /people-search` endpoint that lets the client look up any PCO person by name, excluding anyone already linked. A shared pure validator (`selectionValidation.js`) resolves manual picks against a "claimed pcoIds" set so the same PCO person can't be double-linked within one apply request, used by both the sync-batch apply route (ambiguous picks + a new archive option) and the reconciliation apply route (manual links for archiveExtras). Separately, `fetchAllPcoPeople` starts capturing PCO's `Household.primary_contact_id`, and `computePlan()` gains a `familyNameUpdates` bucket proposing a family rename whenever the linked head-of-household's name differs from the family's current name — reviewed and applied the same way as every other bucket.

**Tech Stack:** Node.js/Express, better-sqlite3, `node:test` (backend), React 19/TypeScript, vitest (frontend). All builds/tests run in Docker (project rule) — see Test Commands below.

**Reference spec:** `docs/superpowers/specs/2026-07-06-pco-manual-linkage-and-family-name-sync-design.md`

**Test commands (Docker — never run build/type-check/test commands on the host):**
- Backend: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/<file>.test.js`
- Backend full suite: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
- Backend syntax check: `docker compose -f docker-compose.dev.yml exec server node --check <file>.js`
- Frontend unit: `docker compose -f docker-compose.dev.yml exec client npx vitest run src/components/planningCenter/<file>.test.ts`
- Frontend typecheck: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`

Before starting, confirm the dev stack is up: `docker compose -f docker-compose.dev.yml up -d server client`.

---

## File Structure

- Create `server/services/planningCenter/peopleSearch.js` — pure `searchPcoPeople(pcoPeople, query, alreadyLinkedPcoIds, limit)`
- Create `server/services/planningCenter/peopleSearch.test.js`
- Create `server/services/planningCenter/selectionValidation.js` — pure `resolveManualLinks(candidates, opts)`
- Create `server/services/planningCenter/selectionValidation.test.js`
- Create `server/services/planningCenter/familyName.js` — `buildFamilyName` (moved out of `apply.js`)
- Create `server/services/planningCenter/familyName.test.js` (moved out of `apply.test.js`)
- Modify `server/config/schema.js` — unique index on `individuals(church_id, planning_center_id)`
- Modify `server/services/planningCenter/apply.js` — archive-ambiguous, manual-link-instead-of-archive, family-name-update apply logic
- Modify `server/services/planningCenter/apply.test.js` — remove the tests moved to `familyName.test.js`
- Modify `server/services/planningCenter/diffEngine.js` — `familyNameUpdates` bucket
- Modify `server/services/planningCenter/diffEngine.test.js`
- Modify `server/services/planningCenterSync.js` — `householdPrimaryContacts` plumbing, `applyArchiveExtras`/`applyReconciliation` signature change
- Modify `server/routes/integrations.js` — new `people-search` route; broaden validation in the two apply routes
- Create `client/src/components/planningCenter/PcoPersonSearchPicker.tsx` — shared debounced search-and-pick widget
- Modify `client/src/components/planningCenter/syncSelections.ts` / `.test.ts`
- Modify `client/src/services/api.ts`
- Modify `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`
- Modify `client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx`

---

## Part A: Manual linkage + archive

### Task 1: `peopleSearch.js` — pure search helper

**Files:**
- Create: `server/services/planningCenter/peopleSearch.js`
- Test: `server/services/planningCenter/peopleSearch.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/services/planningCenter/peopleSearch.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { searchPcoPeople } = require('./peopleSearch');

function pco(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, status: 'active', householdId: null, ...extra };
}

test('matches on substring of the normalized full name', () => {
  const people = [pco('p1', 'Sarah', 'Wierenga'), pco('p2', 'John', 'Smith')];
  const results = searchPcoPeople(people, 'wiere', new Set());
  assert.deepStrictEqual(results, [{ pcoId: 'p1', firstName: 'Sarah', lastName: 'Wierenga', householdId: null, status: 'active' }]);
});

test('excludes PCO people already linked to an individual', () => {
  const people = [pco('p1', 'Sarah', 'Wierenga'), pco('p2', 'Sarah', 'Wierenga-Jones')];
  const results = searchPcoPeople(people, 'wierenga', new Set(['p1']));
  assert.deepStrictEqual(results.map((r) => r.pcoId), ['p2']);
});

test('empty query returns no results', () => {
  const people = [pco('p1', 'Sarah', 'Wierenga')];
  assert.deepStrictEqual(searchPcoPeople(people, '', new Set()), []);
  assert.deepStrictEqual(searchPcoPeople(people, '   ', new Set()), []);
});

test('respects the limit', () => {
  const people = [pco('p1', 'Sam', 'A'), pco('p2', 'Sam', 'B'), pco('p3', 'Sam', 'C')];
  const results = searchPcoPeople(people, 'sam', new Set(), 2);
  assert.strictEqual(results.length, 2);
});

test('matches across first/last name boundary (accent/punctuation insensitive, via normalizeName)', () => {
  const people = [pco('p1', 'José', "O'Brien")];
  const results = searchPcoPeople(people, 'jose obrien', new Set());
  assert.strictEqual(results.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/peopleSearch.test.js`
Expected: FAIL — `Cannot find module './peopleSearch'`.

- [ ] **Step 3: Implement `peopleSearch.js`**

Create `server/services/planningCenter/peopleSearch.js`:

```js
const { normalizeName } = require('./matcher');

// pcoPeople: full cached projected list (from getCachedPcoPeople).
// query: raw search text typed by the reviewer.
// alreadyLinkedPcoIds: Set<string> of PCO ids already linked to some individual in
// this church — these are excluded so a reviewer can't pick someone already claimed.
// Returns up to `limit` matches, in the order encountered in pcoPeople.
function searchPcoPeople(pcoPeople, query, alreadyLinkedPcoIds, limit = 20) {
  const q = normalizeName(query);
  if (!q) return [];
  const results = [];
  for (const p of pcoPeople) {
    if (alreadyLinkedPcoIds.has(p.id)) continue;
    const full = normalizeName(`${p.firstName} ${p.lastName}`);
    if (!full.includes(q)) continue;
    results.push({ pcoId: p.id, firstName: p.firstName, lastName: p.lastName, householdId: p.householdId, status: p.status });
    if (results.length >= limit) break;
  }
  return results;
}

module.exports = { searchPcoPeople };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/peopleSearch.test.js`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/peopleSearch.js server/services/planningCenter/peopleSearch.test.js
git commit -m "feat(pco): add pure PCO people search helper"
```

---

### Task 2: `selectionValidation.js` — pure claim/dedup resolver

**Files:**
- Create: `server/services/planningCenter/selectionValidation.js`
- Test: `server/services/planningCenter/selectionValidation.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/services/planningCenter/selectionValidation.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveManualLinks } = require('./selectionValidation');

test('accepts a valid, unclaimed pick', () => {
  const claimed = new Set();
  const accepted = resolveManualLinks(
    [{ individualId: 1, pcoId: 'p1' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: claimed }
  );
  assert.deepStrictEqual(accepted, [{ individualId: 1, pcoId: 'p1' }]);
  assert.ok(claimed.has('p1'));
});

test('rejects a pcoId not present in validPcoIds', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 1, pcoId: 'ghost' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set() }
  );
  assert.deepStrictEqual(accepted, []);
});

test('rejects the second of two candidates claiming the same pcoId', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 1, pcoId: 'p1' }, { individualId: 2, pcoId: 'p1' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set() }
  );
  assert.deepStrictEqual(accepted, [{ individualId: 1, pcoId: 'p1' }]);
});

test('rejects a pick outside allowedIndividualIds when provided', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 99, pcoId: 'p1' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set(), allowedIndividualIds: new Set([1, 2]) }
  );
  assert.deepStrictEqual(accepted, []);
});

test('allows any individualId when allowedIndividualIds is not provided', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 99, pcoId: 'p1' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set() }
  );
  assert.deepStrictEqual(accepted, [{ individualId: 99, pcoId: 'p1' }]);
});

test('ignores entries with no pcoId', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 1, pcoId: null }, { individualId: 2, pcoId: undefined }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set() }
  );
  assert.deepStrictEqual(accepted, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/selectionValidation.test.js`
Expected: FAIL — `Cannot find module './selectionValidation'`.

- [ ] **Step 3: Implement `selectionValidation.js`**

Create `server/services/planningCenter/selectionValidation.js`:

```js
// candidates: array of { individualId, pcoId } proposed picks, considered in order
// (e.g. Object.entries() order from a request body — first-claimed wins).
// opts.validPcoIds: Set<string> — pcoIds that exist in the current PCO snapshot.
// opts.claimedPcoIds: Set<string> — pcoIds already spoken for (by the plan itself,
// or already linked in the DB); mutated in place as entries are accepted, so a later
// candidate in the same call can't reuse a pcoId an earlier one just claimed.
// opts.allowedIndividualIds: Set<number>|undefined — if given, only individualIds in
// this set may be resolved; omit to allow any individualId.
// Returns the accepted { individualId, pcoId } entries, in input order.
function resolveManualLinks(candidates, { validPcoIds, claimedPcoIds, allowedIndividualIds }) {
  const accepted = [];
  for (const { individualId, pcoId } of candidates) {
    if (!pcoId) continue;
    if (allowedIndividualIds && !allowedIndividualIds.has(individualId)) continue;
    if (!validPcoIds.has(pcoId)) continue;
    if (claimedPcoIds.has(pcoId)) continue;
    claimedPcoIds.add(pcoId);
    accepted.push({ individualId, pcoId });
  }
  return accepted;
}

module.exports = { resolveManualLinks };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/selectionValidation.test.js`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/selectionValidation.js server/services/planningCenter/selectionValidation.test.js
git commit -m "feat(pco): add pure selection-claim resolver for manual link picks"
```

---

### Task 3: Unique index on `individuals(church_id, planning_center_id)`

**Files:**
- Modify: `server/config/schema.js`

Broadening manual search to "any PCO person" makes it easier for a reviewer (or two
concurrent requests) to accidentally link the same PCO person to two different
individuals. There is currently no DB constraint preventing that
(`server/config/schema.js` has only `idx_individuals_name`, `idx_individuals_family`,
`idx_individuals_active`, `idx_individuals_church` on `individuals`). Before adding
one, confirm no existing church data would violate it.

- [ ] **Step 1: Check for existing duplicate `planning_center_id` values across all churches**

Run:
```bash
docker compose -f docker-compose.dev.yml exec server node -e "
const Database = require('./config/database');
Database.initialize();
(async () => {
  const churches = Database.listChurches();
  let anyDupes = false;
  for (const c of churches) {
    await Database.setChurchContext(c.church_id, async () => {
      const dupes = await Database.query(
        \`SELECT planning_center_id, COUNT(*) AS n FROM individuals
           WHERE church_id = ? AND planning_center_id IS NOT NULL
           GROUP BY planning_center_id HAVING COUNT(*) > 1\`,
        [c.church_id]
      );
      if (dupes.length) { anyDupes = true; console.log(c.church_id, dupes); }
    });
  }
  console.log(anyDupes ? 'DUPLICATES FOUND' : 'no duplicates');
})();
"
```
Expected: `no duplicates`. If duplicates ARE found, stop here and report them to the
user before proceeding — adding the unique index in Step 2 would then fail to apply
for that church (caught and logged as a warning by `startup.js`'s per-church
try/catch, not a hard crash, but that church silently keeps running without the new
constraint and without its other pending migrations that startup — worth fixing the
duplicate data first).

- [ ] **Step 2: Add the unique index**

In `server/config/schema.js`, find:

```
CREATE INDEX IF NOT EXISTS idx_individuals_name ON individuals(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_individuals_family ON individuals(family_id);
CREATE INDEX IF NOT EXISTS idx_individuals_active ON individuals(is_active);
CREATE INDEX IF NOT EXISTS idx_individuals_church ON individuals(church_id);
```

Replace with:

```
CREATE INDEX IF NOT EXISTS idx_individuals_name ON individuals(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_individuals_family ON individuals(family_id);
CREATE INDEX IF NOT EXISTS idx_individuals_active ON individuals(is_active);
CREATE INDEX IF NOT EXISTS idx_individuals_church ON individuals(church_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_individuals_pco_id_unique
  ON individuals(church_id, planning_center_id) WHERE planning_center_id IS NOT NULL;
```

- [ ] **Step 3: Verify no syntax errors**

Run: `docker compose -f docker-compose.dev.yml exec server node --check config/schema.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Restart the server and confirm the index applies cleanly**

Run:
```bash
docker compose -f docker-compose.dev.yml restart server
docker compose -f docker-compose.dev.yml logs server --since 30s
```
Expected: no `⚠️  Error checking church ...` lines in the logs; startup completes
with `🎉 Database initialization completed!`.

- [ ] **Step 5: Commit**

```bash
git add server/config/schema.js
git commit -m "feat(pco): add unique index on individuals(church_id, planning_center_id)"
```

---

### Task 4: `applyPlan` — archive-ambiguous selection

**Files:**
- Modify: `server/services/planningCenter/apply.js`

No new automated test in this task — `applyPlan` touches the database directly and
this codebase's established convention (confirmed in `apply.test.js` today) is to
only unit-test the pure helpers, not DB-touching functions. Verified via the full
regression suite plus the throwaway-DB end-to-end check in the final task.

- [ ] **Step 1: Add `archiveAmbiguousIds` handling**

In `server/services/planningCenter/apply.js`, find:

```js
  for (const r of plan.reactivate) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 1, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [r.individualId, churchId]
      );
      result.reactivated++;
    } catch (e) { result.errors.push({ type: 'reactivate', id: r.individualId, error: e.message }); }
  }
```

Replace with:

```js
  for (const r of plan.reactivate) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 1, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [r.individualId, churchId]
      );
      result.reactivated++;
    } catch (e) { result.errors.push({ type: 'reactivate', id: r.individualId, error: e.message }); }
  }

  // Ambiguous individuals the reviewer chose to archive outright instead of picking
  // a candidate (or a manual search result). Independent of plan.archive (which is
  // driven by PCO status, not reviewer choice).
  for (const individualId of (selections.archiveAmbiguousIds || [])) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [individualId, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archiveAmbiguous', id: individualId, error: e.message }); }
  }
```

- [ ] **Step 2: Verify no syntax errors**

Run: `docker compose -f docker-compose.dev.yml exec server node --check services/planningCenter/apply.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Run the full server test suite to check for regressions**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all pre-existing tests still pass (no new tests added this task).

- [ ] **Step 4: Commit**

```bash
git add server/services/planningCenter/apply.js
git commit -m "feat(pco): archive ambiguous individuals the reviewer explicitly chose to archive"
```

---

### Task 5: `applyArchiveExtras` — manual link instead of archive

**Files:**
- Modify: `server/services/planningCenter/apply.js`
- Modify: `server/services/planningCenterSync.js`

- [ ] **Step 1: Change `applyArchiveExtras`'s signature to accept `manualLinks`**

In `server/services/planningCenter/apply.js`, find:

```js
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
```

Replace with:

```js
// Archives active 'regular' individuals whose name matched no one in PCO's full
// people export (plan.archiveExtras from computePlan) — OR, if the reviewer found
// the right PCO person via manual search, links them instead of archiving (link
// always wins over archive/skip for that individual). Used only by the
// reconciliation endpoints — never called as part of a batch's own apply.
async function applyArchiveExtras(churchId, archiveExtras, { skipArchiveExtraIds = [], manualLinks = {} } = {}) {
  const skip = new Set(skipArchiveExtraIds.map(Number));
  const result = { archived: 0, linked: 0, errors: [] };
  for (const x of archiveExtras) {
    const id = Number(x.individualId);
    const linkPcoId = manualLinks[id];
    if (linkPcoId) {
      try {
        await Database.query(
          `UPDATE individuals SET planning_center_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
          [linkPcoId, id, churchId]
        );
        result.linked++;
      } catch (e) { result.errors.push({ type: 'manualLink', id, error: e.message }); }
      continue;
    }
    if (skip.has(id)) continue;
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [id, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archiveExtra', id, error: e.message }); }
  }
  return result;
}
```

- [ ] **Step 2: Update the one caller, `applyReconciliation`**

In `server/services/planningCenterSync.js`, find:

```js
async function applyReconciliation(churchId, plan, selections = {}) {
  return applyArchiveExtras(churchId, plan.archiveExtras, selections.skipArchiveExtraIds || []);
}
```

Replace with:

```js
async function applyReconciliation(churchId, plan, selections = {}) {
  return applyArchiveExtras(churchId, plan.archiveExtras, {
    skipArchiveExtraIds: selections.skipArchiveExtraIds || [],
    manualLinks: selections.manualLinks || {},
  });
}
```

- [ ] **Step 3: Verify no syntax errors**

Run:
```bash
docker compose -f docker-compose.dev.yml exec server node --check services/planningCenter/apply.js
docker compose -f docker-compose.dev.yml exec server node --check services/planningCenterSync.js
```
Expected: no output, exit code 0 for both.

- [ ] **Step 4: Run the full server test suite to check for regressions**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all pre-existing tests pass — including
`apply.test.js`'s `'applyArchiveExtras is exported as a function'` check, which still
holds true after the signature change.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/apply.js server/services/planningCenterSync.js
git commit -m "feat(pco): link archiveExtras to a manually-picked PCO person instead of archiving"
```

---

### Task 6: `GET /planning-center/people-search` route

**Files:**
- Modify: `server/routes/integrations.js`

- [ ] **Step 1: Add the imports**

In `server/routes/integrations.js`, find:

```js
const { tallyField } = require('../services/planningCenter/summary');
const { fetchFieldDefinitions } = require('../services/planningCenter/fieldDefinitions');
```

Replace with:

```js
const { tallyField } = require('../services/planningCenter/summary');
const { fetchFieldDefinitions } = require('../services/planningCenter/fieldDefinitions');
const { searchPcoPeople } = require('../services/planningCenter/peopleSearch');
const { resolveManualLinks } = require('../services/planningCenter/selectionValidation');
```

- [ ] **Step 2: Add the route**

In `server/routes/integrations.js`, find:

```js
// List all saved sync batches for this church.
router.get('/planning-center/sync-batches', async (req, res) => {
```

Replace with:

```js
// Search PCO people by name for manual linking (ambiguous / unmatched-extra review).
// Excludes anyone already linked to an existing individual in this church.
router.get('/planning-center/people-search', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const { people } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
    const linkedRows = await Database.query(
      `SELECT planning_center_id FROM individuals WHERE church_id = ? AND planning_center_id IS NOT NULL`,
      [churchId]
    );
    const alreadyLinked = new Set(linkedRows.map((r) => r.planning_center_id));
    const results = searchPcoPeople(people, q, alreadyLinked);
    res.json({ success: true, results });
  } catch (error) {
    logger.error('PCO people search error:', error);
    res.status(500).json({ error: 'Failed to search Planning Center people.' });
  }
});

// List all saved sync batches for this church.
router.get('/planning-center/sync-batches', async (req, res) => {
```

- [ ] **Step 3: Verify no syntax errors**

Run: `docker compose -f docker-compose.dev.yml exec server node --check routes/integrations.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): add people-search endpoint for manual linking"
```

---

### Task 7: Broaden ambiguous validation + archive option in the batch apply route

**Files:**
- Modify: `server/routes/integrations.js`

- [ ] **Step 1: Replace the ambiguous-selection validation**

In `server/routes/integrations.js`, find (inside `router.post('/planning-center/sync-batches/:id/apply', ...)`):

```js
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
```

Replace with:

```js
    const plan = await pcoSync.computePlanForBatch(churchId, accessToken, batch);

    const rawSel = (req.body && req.body.selections) || {};
    const { people: cachedPcoPeople } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
    const validPcoIds = new Set(cachedPcoPeople.map((p) => p.id));

    const addPcoIds = new Set(plan.add.map((a) => a.pcoId));
    const skipAddPcoIds = (Array.isArray(rawSel.skipAddPcoIds) ? rawSel.skipAddPcoIds : [])
      .filter((id) => addPcoIds.has(id));

    // Seed claimed pcoIds with everything the plan itself already assigns, so a
    // reviewer's manual ambiguous pick can't collide with an auto-link/restore/
    // visitor-match/non-skipped-add from the same run.
    const claimedPcoIds = new Set([
      ...plan.link.map((l) => l.pcoId),
      ...(plan.restore || []).map((r) => r.pcoId),
      ...(plan.visitorMatches || []).map((v) => v.candidate.pcoId),
      ...plan.add.filter((a) => !skipAddPcoIds.includes(a.pcoId)).map((a) => a.pcoId),
    ]);

    const ambiguousIndividualIds = new Set(plan.ambiguous.map((a) => a.individualId));
    const ambiguousCandidates = Object.entries(rawSel.ambiguous || {}).map(([individualId, pcoId]) => ({
      individualId: Number(individualId), pcoId,
    }));
    const acceptedAmbiguous = resolveManualLinks(ambiguousCandidates, {
      validPcoIds, claimedPcoIds, allowedIndividualIds: ambiguousIndividualIds,
    });
    const ambiguous = {};
    for (const a of acceptedAmbiguous) ambiguous[a.individualId] = a.pcoId;

    const linkedAmbiguousIds = new Set(Object.keys(ambiguous).map(Number));
    const archiveAmbiguousIds = (Array.isArray(rawSel.archiveAmbiguousIds) ? rawSel.archiveAmbiguousIds : [])
      .map(Number)
      .filter((id) => ambiguousIndividualIds.has(id) && !linkedAmbiguousIds.has(id));

    const visitorOfferIds = new Set((plan.visitorMatches || []).map((v) => Number(v.individualId)));
    const visitorChoices = {};
    for (const [rawId, choice] of Object.entries(rawSel.visitorChoices || {})) {
      const id = Number(rawId);
      if (visitorOfferIds.has(id) && (choice === 'promote' || choice === 'keep')) {
        visitorChoices[id] = choice;
      }
    }
    const selections = { ambiguous, skipAddPcoIds, visitorChoices, archiveAmbiguousIds };
```

(This also loosens the old restriction that an ambiguous pick had to be one of
`plan.ambiguous[].candidates` — any pcoId in the current PCO snapshot, not already
claimed elsewhere in this request, is now accepted.)

- [ ] **Step 2: Verify no syntax errors**

Run: `docker compose -f docker-compose.dev.yml exec server node --check routes/integrations.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Run the full server test suite to check for regressions**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all pre-existing tests pass (no test file directly exercises this route —
confirmed no `integrations.js`-level test file exists in this codebase; covered by
the end-to-end task instead).

- [ ] **Step 4: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): allow manual PCO search picks and explicit archive for ambiguous matches"
```

---

### Task 8: Manual links + archive precedence in the reconciliation apply route

**Files:**
- Modify: `server/routes/integrations.js`

- [ ] **Step 1: Replace the reconciliation-apply selection handling**

In `server/routes/integrations.js`, find:

```js
    const plan = await pcoSync.computeReconciliationForChurch(churchId, accessToken);
    const rawSel = (req.body && req.body.selections) || {};
    const extraIds = new Set(plan.archiveExtras.map((x) => Number(x.individualId)));
    const skipArchiveExtraIds = (Array.isArray(rawSel.skipArchiveExtraIds) ? rawSel.skipArchiveExtraIds : [])
      .map(Number)
      .filter((id) => extraIds.has(id));

    const result = await pcoSync.applyReconciliation(churchId, plan, { skipArchiveExtraIds });
```

Replace with:

```js
    const plan = await pcoSync.computeReconciliationForChurch(churchId, accessToken);
    const rawSel = (req.body && req.body.selections) || {};
    const extraIds = new Set(plan.archiveExtras.map((x) => Number(x.individualId)));

    const { people: cachedPcoPeople } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
    const validPcoIds = new Set(cachedPcoPeople.map((p) => p.id));
    const linkedRows = await Database.query(
      `SELECT planning_center_id FROM individuals WHERE church_id = ? AND planning_center_id IS NOT NULL`,
      [churchId]
    );
    const claimedPcoIds = new Set(linkedRows.map((r) => r.planning_center_id));

    const manualLinkCandidates = Object.entries(rawSel.manualLinks || {}).map(([individualId, pcoId]) => ({
      individualId: Number(individualId), pcoId,
    }));
    const acceptedManualLinks = resolveManualLinks(manualLinkCandidates, {
      validPcoIds, claimedPcoIds, allowedIndividualIds: extraIds,
    });
    const manualLinks = {};
    for (const m of acceptedManualLinks) manualLinks[m.individualId] = m.pcoId;

    const linkedIndividualIds = new Set(Object.keys(manualLinks).map(Number));
    const skipArchiveExtraIds = (Array.isArray(rawSel.skipArchiveExtraIds) ? rawSel.skipArchiveExtraIds : [])
      .map(Number)
      .filter((id) => extraIds.has(id) && !linkedIndividualIds.has(id));

    const result = await pcoSync.applyReconciliation(churchId, plan, { skipArchiveExtraIds, manualLinks });
```

(A manually-linked individual is excluded from `skipArchiveExtraIds` filtering
entirely — `applyArchiveExtras`, from Task 5, already treats a `manualLinks` entry
as taking precedence over archiving regardless, but excluding it here too keeps the
two collections mutually exclusive by construction.)

- [ ] **Step 2: Verify no syntax errors**

Run: `docker compose -f docker-compose.dev.yml exec server node --check routes/integrations.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Run the full server test suite to check for regressions**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all pre-existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): allow manual PCO linking for reconciliation's unmatched extras"
```

---

### Task 9: Client — `PcoPersonSearchPicker` shared component

**Files:**
- Create: `client/src/components/planningCenter/PcoPersonSearchPicker.tsx`
- Modify: `client/src/services/api.ts`

- [ ] **Step 1: Add the API method**

In `client/src/services/api.ts`, find:

```ts
  getPlanningCenterSyncBatches: () =>
    api.get('/integrations/planning-center/sync-batches'),
```

Replace with:

```ts
  searchPlanningCenterPeople: (q: string) =>
    api.get('/integrations/planning-center/people-search', { params: { q }, timeout: 30000 }),
  getPlanningCenterSyncBatches: () =>
    api.get('/integrations/planning-center/sync-batches'),
```

- [ ] **Step 2: Create the shared picker component**

Create `client/src/components/planningCenter/PcoPersonSearchPicker.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';

export interface PcoPersonResult {
  pcoId: string;
  firstName: string;
  lastName: string;
  householdId: string | null;
  status: string | null;
}

// Debounced "search Planning Center by name, click to pick" widget shared by the
// ambiguous-match and unmatched-extra review flows.
export default function PcoPersonSearchPicker({ onPick }: { onPick: (person: PcoPersonResult) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PcoPersonResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await integrationsAPI.searchPlanningCenterPeople(query);
        setResults(res.data.results);
      } catch (e) {
        logger.error('PCO people search failed', e);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div className="mt-1">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search Planning Center by name…"
        className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 w-full dark:bg-gray-800"
      />
      {searching && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Searching…</p>}
      {results.length > 0 && (
        <ul className="mt-1 border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-100 dark:divide-gray-700">
          {results.map((r) => (
            <li key={r.pcoId}>
              <button
                type="button"
                onClick={() => onPick(r)}
                className="w-full text-left text-sm px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {r.firstName} {r.lastName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify no new TypeScript errors**

Run: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
Expected: only the one pre-existing, unrelated `TS5107` warning
(`tsconfig.json(17,25): error TS5107: Option 'moduleResolution=node10' is deprecated...`)
— no new errors. (This component isn't imported anywhere yet, so this only checks it
compiles standalone.)

- [ ] **Step 4: Commit**

```bash
git add client/src/services/api.ts client/src/components/planningCenter/PcoPersonSearchPicker.tsx
git commit -m "feat(pco): add shared PCO person search-and-pick component"
```

---

### Task 10: `syncSelections.ts` — `archiveAmbiguousIds` and `manualLinks`

**Files:**
- Modify: `client/src/components/planningCenter/syncSelections.ts`
- Modify: `client/src/components/planningCenter/syncSelections.test.ts`

- [ ] **Step 1: Update the failing tests**

In `client/src/components/planningCenter/syncSelections.test.ts`, replace the entire
file with:

```ts
import { describe, it, expect } from 'vitest';
import { buildSelections, buildReconciliationSelections, VisitorChoice } from './syncSelections';

describe('buildSelections', () => {
  it('maps ambiguous choices and skip set into the apply payload', () => {
    const ambiguousChoices = { 12: 'pco_a', 34: 'pco_b' };
    const skipAddPcoIds = new Set(['pco_x', 'pco_y']);
    expect(buildSelections(ambiguousChoices, skipAddPcoIds)).toEqual({
      ambiguous: { 12: 'pco_a', 34: 'pco_b' },
      skipAddPcoIds: ['pco_x', 'pco_y'],
      visitorChoices: {},
      archiveAmbiguousIds: [],
    });
  });

  it('omits ambiguous entries with no chosen pcoId (skipped)', () => {
    const ambiguousChoices = { 12: 'pco_a', 34: null };
    const result = buildSelections(ambiguousChoices, new Set());
    expect(result.ambiguous).toEqual({ 12: 'pco_a' });
    expect(result.skipAddPcoIds).toEqual([]);
  });

  it('returns empty selections when nothing chosen', () => {
    expect(buildSelections({}, new Set())).toEqual({
      ambiguous: {},
      skipAddPcoIds: [],
      visitorChoices: {},
      archiveAmbiguousIds: [],
    });
  });

  it('maps visitorChoices into the apply payload, omitting undecided entries', () => {
    const visitorChoices: Record<number, VisitorChoice | null> = { 90: 'promote', 91: 'keep', 92: null };
    const result = buildSelections({}, new Set(), visitorChoices);
    expect(result).toEqual({
      ambiguous: {},
      skipAddPcoIds: [],
      visitorChoices: { 90: 'promote', 91: 'keep' },
      archiveAmbiguousIds: [],
    });
  });

  it('includes archiveAmbiguousIds when provided', () => {
    const result = buildSelections({}, new Set(), {}, new Set([5, 6]));
    expect(result.archiveAmbiguousIds).toEqual([5, 6]);
  });
});

describe('buildReconciliationSelections', () => {
  it('converts skipArchiveExtraIds set into the apply payload', () => {
    const skipArchiveExtraIds = new Set([56, 78]);
    expect(buildReconciliationSelections(skipArchiveExtraIds)).toEqual({
      skipArchiveExtraIds: [56, 78],
      manualLinks: {},
    });
  });

  it('converts manualLinks picks into a pcoId-only map', () => {
    const result = buildReconciliationSelections(new Set(), {
      10: { pcoId: 'p1', firstName: 'A', lastName: 'B' },
      11: null,
    });
    expect(result.manualLinks).toEqual({ 10: 'p1' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose -f docker-compose.dev.yml exec client npx vitest run src/components/planningCenter/syncSelections.test.ts`
Expected: FAIL — `buildSelections` doesn't accept a 4th argument yet /
`buildReconciliationSelections` doesn't return `manualLinks` yet.

- [ ] **Step 3: Update `syncSelections.ts`**

Replace the entire contents of `client/src/components/planningCenter/syncSelections.ts` with:

```ts
// Shapes shared by the sync review UI.
export type VisitorChoice = 'promote' | 'keep';

export interface SyncSelections {
  ambiguous: Record<string, string>;
  skipAddPcoIds: string[];
  visitorChoices: Record<string, VisitorChoice>;
  archiveAmbiguousIds: number[];
}

// ambiguousChoices: individualId -> chosen pcoId (or null when the reviewer skipped).
//   The pcoId can come from an auto-detected candidate OR a manual search pick —
//   both are stored the same way.
// skipAddPcoIds: set of add-bucket pcoIds the reviewer deselected.
// visitorChoices: individualId -> 'promote' (link + convert to regular) or 'keep'
//   (mark as link-declined so future syncs don't re-prompt). null/undefined means
//   the reviewer made no decision — no change is applied this run.
// archiveAmbiguousIds: ambiguous individualIds the reviewer chose to archive outright
//   instead of picking a candidate.
export function buildSelections(
  ambiguousChoices: Record<string, string | null>,
  skipAddPcoIds: Set<string>,
  visitorChoices: Record<string, VisitorChoice | null> = {},
  archiveAmbiguousIds: Set<number> = new Set(),
): SyncSelections {
  const ambiguous: Record<string, string> = {};
  for (const [individualId, pcoId] of Object.entries(ambiguousChoices)) {
    if (pcoId) ambiguous[individualId] = pcoId;
  }
  const vChoices: Record<string, VisitorChoice> = {};
  for (const [individualId, choice] of Object.entries(visitorChoices)) {
    if (choice === 'promote' || choice === 'keep') vChoices[individualId] = choice;
  }
  return {
    ambiguous,
    skipAddPcoIds: [...skipAddPcoIds],
    visitorChoices: vChoices,
    archiveAmbiguousIds: [...archiveAmbiguousIds],
  };
}

export interface ManualLinkPick { pcoId: string; firstName: string; lastName: string; }

export interface ReconciliationSelections {
  skipArchiveExtraIds: number[];
  manualLinks: Record<string, string>;
}

// skipArchiveExtraIds: archiveExtras individualIds the reviewer deselected
//   (i.e. these LMPG individuals will NOT be archived this run).
// manualLinks: archiveExtras individualId -> a manually-picked PCO person (or null
//   if not linked) — converted here to a pcoId-only map for the apply payload.
export function buildReconciliationSelections(
  skipArchiveExtraIds: Set<number>,
  manualLinks: Record<number, ManualLinkPick | null> = {},
): ReconciliationSelections {
  const links: Record<string, string> = {};
  for (const [individualId, pick] of Object.entries(manualLinks)) {
    if (pick) links[individualId] = pick.pcoId;
  }
  return { skipArchiveExtraIds: [...skipArchiveExtraIds], manualLinks: links };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose -f docker-compose.dev.yml exec client npx vitest run src/components/planningCenter/syncSelections.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/planningCenter/syncSelections.ts client/src/components/planningCenter/syncSelections.test.ts
git commit -m "feat(pco): add archiveAmbiguousIds and manualLinks to sync selections"
```

---

### Task 11: `PlanningCenterSyncReview.tsx` — manual search + archive for ambiguous matches

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`

- [ ] **Step 1: Import the picker and extend state**

In `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`, find:

```tsx
import { buildSelections, VisitorChoice } from './syncSelections';
```

Replace with:

```tsx
import { buildSelections, VisitorChoice } from './syncSelections';
import PcoPersonSearchPicker, { PcoPersonResult } from './PcoPersonSearchPicker';
```

Find:

```tsx
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, string | null>>({});
  const [skipAdd, setSkipAdd] = useState<Set<string>>(new Set());
  const [visitorChoices, setVisitorChoices] = useState<Record<string, VisitorChoice | null>>({});
```

Replace with:

```tsx
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, string | null>>({});
  const [skipAdd, setSkipAdd] = useState<Set<string>>(new Set());
  const [visitorChoices, setVisitorChoices] = useState<Record<string, VisitorChoice | null>>({});
  const [archiveAmbiguousIds, setArchiveAmbiguousIds] = useState<Set<number>>(new Set());
  const [manualPicks, setManualPicks] = useState<Record<number, PcoPersonResult | null>>({});
```

- [ ] **Step 2: Reset the new state when the plan reloads**

Find:

```tsx
      setPlan(res.data.plan);
      setAmbiguousChoices({});
      setSkipAdd(new Set());
      setVisitorChoices({});
```

Replace with:

```tsx
      setPlan(res.data.plan);
      setAmbiguousChoices({});
      setSkipAdd(new Set());
      setVisitorChoices({});
      setArchiveAmbiguousIds(new Set());
      setManualPicks({});
```

- [ ] **Step 3: Pass the new state into `buildSelections`**

Find:

```tsx
      const selections = buildSelections(ambiguousChoices, skipAdd, visitorChoices);
```

Replace with:

```tsx
      const selections = buildSelections(ambiguousChoices, skipAdd, visitorChoices, archiveAmbiguousIds);
```

- [ ] **Step 4: Add the manual-pick / archive UI to each ambiguous row**

Find:

```tsx
                <div className="space-y-1">
                  {a.candidateDetails.map((c) => (
                    <label key={c.pcoId} className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`amb-${a.individualId}`} checked={ambiguousChoices[a.individualId] === c.pcoId}
                        onChange={() => setAmbiguousChoices((p) => ({ ...p, [a.individualId]: c.pcoId }))} />
                      <span>{c.firstName} {c.lastName}{c.membership ? ` — ${c.membership}` : ''}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`amb-${a.individualId}`} checked={!ambiguousChoices[a.individualId]}
                      onChange={() => setAmbiguousChoices((p) => ({ ...p, [a.individualId]: null }))} />
                    <span>Skip (leave unlinked)</span>
                  </label>
                </div>
```

Replace with:

```tsx
                <div className="space-y-1">
                  {a.candidateDetails.map((c) => (
                    <label key={c.pcoId} className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`amb-${a.individualId}`} checked={ambiguousChoices[a.individualId] === c.pcoId}
                        onChange={() => {
                          setAmbiguousChoices((p) => ({ ...p, [a.individualId]: c.pcoId }));
                          setManualPicks((p) => ({ ...p, [a.individualId]: null }));
                          setArchiveAmbiguousIds((p) => { const n = new Set(p); n.delete(a.individualId); return n; });
                        }} />
                      <span>{c.firstName} {c.lastName}{c.membership ? ` — ${c.membership}` : ''}</span>
                    </label>
                  ))}
                  {manualPicks[a.individualId] && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`amb-${a.individualId}`}
                        checked={ambiguousChoices[a.individualId] === manualPicks[a.individualId]!.pcoId} readOnly />
                      <span>{manualPicks[a.individualId]!.firstName} {manualPicks[a.individualId]!.lastName} (found by search)</span>
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`amb-${a.individualId}`} checked={archiveAmbiguousIds.has(a.individualId)}
                      onChange={() => {
                        setArchiveAmbiguousIds((p) => new Set(p).add(a.individualId));
                        setAmbiguousChoices((p) => ({ ...p, [a.individualId]: null }));
                        setManualPicks((p) => ({ ...p, [a.individualId]: null }));
                      }} />
                    <span>Archive this person</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`amb-${a.individualId}`}
                      checked={!ambiguousChoices[a.individualId] && !archiveAmbiguousIds.has(a.individualId)}
                      onChange={() => {
                        setAmbiguousChoices((p) => ({ ...p, [a.individualId]: null }));
                        setArchiveAmbiguousIds((p) => { const n = new Set(p); n.delete(a.individualId); return n; });
                      }} />
                    <span>Skip (leave unlinked)</span>
                  </label>
                  <PcoPersonSearchPicker onPick={(person) => {
                    setManualPicks((p) => ({ ...p, [a.individualId]: person }));
                    setAmbiguousChoices((p) => ({ ...p, [a.individualId]: person.pcoId }));
                    setArchiveAmbiguousIds((p) => { const n = new Set(p); n.delete(a.individualId); return n; });
                  }} />
                </div>
```

- [ ] **Step 5: Verify no new TypeScript errors**

Run: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
Expected: only the known pre-existing `TS5107` warning, no new errors.

- [ ] **Step 6: Manual check in the browser**

Run `docker compose -f docker-compose.dev.yml up -d client server` if not already up,
open the app, navigate to Settings → Integrations → a Planning Center sync batch with
at least one ambiguous entry (or note if none exist in this dev environment's data —
in that case skip to the next task; this will be exercised in the final end-to-end
task instead). Confirm: typing 2+ characters into "Search Planning Center by name…"
shows results after a short delay, clicking a result selects it (radio switches to
"found by search"), and choosing "Archive this person" deselects any pcoId pick.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterSyncReview.tsx
git commit -m "feat(pco): manual search and archive option for ambiguous matches"
```

---

### Task 12: `PlanningCenterReconciliationReview.tsx` — manual link for unmatched extras

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx`

- [ ] **Step 1: Import the picker and extend state**

In `client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx`, find:

```tsx
import { buildReconciliationSelections } from './syncSelections';
```

Replace with:

```tsx
import { buildReconciliationSelections } from './syncSelections';
import PcoPersonSearchPicker, { PcoPersonResult } from './PcoPersonSearchPicker';
```

Find:

```tsx
  const [skipArchiveExtras, setSkipArchiveExtras] = useState<Set<number>>(new Set());
```

Replace with:

```tsx
  const [skipArchiveExtras, setSkipArchiveExtras] = useState<Set<number>>(new Set());
  const [manualLinks, setManualLinks] = useState<Record<number, PcoPersonResult | null>>({});
  const [searchOpenFor, setSearchOpenFor] = useState<Set<number>>(new Set());
```

- [ ] **Step 2: Reset the new state when the plan reloads**

Find:

```tsx
      setPlan(res.data.plan);
      setSkipArchiveExtras(new Set());
```

Replace with:

```tsx
      setPlan(res.data.plan);
      setSkipArchiveExtras(new Set());
      setManualLinks({});
      setSearchOpenFor(new Set());
```

- [ ] **Step 3: Pass `manualLinks` into `buildReconciliationSelections`**

Find:

```tsx
      const selections = buildReconciliationSelections(skipArchiveExtras);
```

Replace with:

```tsx
      const selections = buildReconciliationSelections(skipArchiveExtras, manualLinks);
```

- [ ] **Step 4: Add the "Link instead" UI to each archiveExtras row**

Find:

```tsx
          <ul className="max-h-64 overflow-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {plan.archiveExtras.map((x) => (
              <li key={x.individualId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <input type="checkbox" checked={!skipArchiveExtras.has(x.individualId)} onChange={() => toggleSkipExtra(x.individualId)} />
                <span>{x.firstName} {x.lastName}</span>
              </li>
            ))}
          </ul>
```

Replace with:

```tsx
          <ul className="max-h-64 overflow-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {plan.archiveExtras.map((x) => (
              <li key={x.individualId} className="flex flex-col gap-1 px-3 py-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={!skipArchiveExtras.has(x.individualId) && !manualLinks[x.individualId]}
                    disabled={!!manualLinks[x.individualId]}
                    onChange={() => toggleSkipExtra(x.individualId)} />
                  <span>{x.firstName} {x.lastName}</span>
                  {manualLinks[x.individualId] ? (
                    <span className="text-xs text-green-700 dark:text-green-400">
                      → linking to {manualLinks[x.individualId]!.firstName} {manualLinks[x.individualId]!.lastName}
                      <button type="button" className="underline ml-1" onClick={() => setManualLinks((p) => ({ ...p, [x.individualId]: null }))}>undo</button>
                    </span>
                  ) : (
                    <button type="button" className="text-xs underline text-gray-600 dark:text-gray-300"
                      onClick={() => setSearchOpenFor((p) => {
                        const n = new Set(p);
                        if (n.has(x.individualId)) n.delete(x.individualId); else n.add(x.individualId);
                        return n;
                      })}>
                      Link instead
                    </button>
                  )}
                </div>
                {searchOpenFor.has(x.individualId) && !manualLinks[x.individualId] && (
                  <PcoPersonSearchPicker onPick={(person) => {
                    setManualLinks((p) => ({ ...p, [x.individualId]: person }));
                    setSearchOpenFor((p) => { const n = new Set(p); n.delete(x.individualId); return n; });
                  }} />
                )}
              </li>
            ))}
          </ul>
```

- [ ] **Step 5: Show `linked` in the result line**

Find:

```tsx
      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Archived: {result.archived}
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
```

Replace with:

```tsx
      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Archived: {result.archived}{result.linked ? `, linked: ${result.linked}` : ''}
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
```

- [ ] **Step 6: Verify no new TypeScript errors**

Run: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
Expected: only the known pre-existing `TS5107` warning, no new errors.

- [ ] **Step 7: Manual check in the browser**

Navigate to Settings → Integrations → Planning Center → Reconciliation. If there's
at least one "not found in Planning Center" entry, click "Link instead", search for
a name, click a result, and confirm the checkbox becomes disabled/unchecked and the
row shows "→ linking to …". If there are no archiveExtras entries in this dev
environment right now, note that and rely on the final end-to-end task instead.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx
git commit -m "feat(pco): manual link option for reconciliation's unmatched extras"
```

---

## Part B: Family name sync from PCO's head-of-household

### Task 13: Extract `buildFamilyName` into `familyName.js`

**Files:**
- Create: `server/services/planningCenter/familyName.js`
- Create: `server/services/planningCenter/familyName.test.js`
- Modify: `server/services/planningCenter/apply.js`
- Modify: `server/services/planningCenter/apply.test.js`

`diffEngine.js` (pure computation, no DB/HTTP) needs `buildFamilyName` for the new
`familyNameUpdates` bucket in the next task. It currently lives in `apply.js` (a
DB-writing module) — move it to its own pure module so `diffEngine.js` doesn't have
to import from a module that touches the database.

- [ ] **Step 1: Create `familyName.js` with the moved function**

Create `server/services/planningCenter/familyName.js`:

```js
// "Lastname, Firstname and Firstname" from adults first (matches importer convention).
function buildFamilyName(members) {
  const adults = members.filter((m) => !m.isChild);
  const nameMembers = adults.length ? adults : members;
  const lastName = (nameMembers[0] && nameMembers[0].lastName) || 'Unknown';
  const firstNames = nameMembers.map((m) => m.firstName).filter(Boolean);
  return firstNames.length ? `${lastName}, ${firstNames.join(' and ')}` : lastName;
}

module.exports = { buildFamilyName };
```

- [ ] **Step 2: Move its tests to `familyName.test.js`**

Create `server/services/planningCenter/familyName.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildFamilyName } = require('./familyName');

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
```

- [ ] **Step 3: Update `apply.js` to import instead of defining it**

In `server/services/planningCenter/apply.js`, find:

```js
const Database = require('../../config/database');

// "Lastname, Firstname and Firstname" from adults first (matches importer convention).
function buildFamilyName(members) {
  const adults = members.filter((m) => !m.isChild);
  const nameMembers = adults.length ? adults : members;
  const lastName = (nameMembers[0] && nameMembers[0].lastName) || 'Unknown';
  const firstNames = nameMembers.map((m) => m.firstName).filter(Boolean);
  return firstNames.length ? `${lastName}, ${firstNames.join(' and ')}` : lastName;
}
```

Replace with:

```js
const Database = require('../../config/database');
const { buildFamilyName } = require('./familyName');
```

Find:

```js
module.exports = { applyPlan, buildFamilyName, groupAdds, applyArchiveExtras };
```

Replace with:

```js
module.exports = { applyPlan, groupAdds, applyArchiveExtras };
```

- [ ] **Step 4: Remove the moved tests from `apply.test.js`**

In `server/services/planningCenter/apply.test.js`, find:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildFamilyName, groupAdds, applyArchiveExtras } = require('./apply');

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
```

Replace with:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { groupAdds, applyArchiveExtras } = require('./apply');

test('groupAdds groups by household, solo for null household', () => {
```

- [ ] **Step 5: Run the full server test suite**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all tests pass (same total count as before — 2 tests moved, not added or
removed).

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenter/familyName.js server/services/planningCenter/familyName.test.js server/services/planningCenter/apply.js server/services/planningCenter/apply.test.js
git commit -m "refactor(pco): extract buildFamilyName into its own pure module"
```

---

### Task 14: Capture PCO's head-of-household + family name in plan inputs

**Files:**
- Modify: `server/services/planningCenterSync.js`

No new test in this task — `fetchAllPcoPeople`/`getCachedPcoPeople`/`loadChurchState`
call PCO's HTTP API and the database directly, and (as established in
`planningCenterSync.test.js`, which only tests the pure `isDueToday`) this codebase
doesn't unit-test network/DB-dependent functions in this file. Covered by the full
regression suite (nothing here changes existing behavior for callers that only use
`people`) and the final end-to-end task.

- [ ] **Step 1: Capture `Household` resources while paging PCO people**

In `server/services/planningCenterSync.js`, find:

```js
// Memory-efficient: project each page, discard raw JSON + included resources.
async function fetchAllPcoPeople(accessToken) {
  const people = [];
  let next = 'https://api.planningcenteronline.com/people/v2/people?per_page=100&include=households,field_data';
  let pages = 0;
  while (next) {
    if (++pages > 1000) {
      throw new Error('PCO people fetch exceeded 1000 pages — aborting to avoid an unbounded loop');
    }
    const resp = await httpsGet(next, accessToken);
    if (resp.status !== 200) {
      throw new Error(`PCO people fetch failed (status ${resp.status})`);
    }
    const data = resp.data;
    const fieldDataById = new Map();
    for (const inc of data.included || []) {
      if (inc.type === 'FieldDatum') fieldDataById.set(inc.id, inc);
    }
    for (const raw of data.data || []) people.push(projectPerson(raw, fieldDataById));
    next = (data.links && data.links.next) || null;
  }
  return people;
}
```

Replace with:

```js
// Memory-efficient: project each page, discard raw JSON + included resources.
// Also collects each PCO Household's designated head-of-household
// (Household.attributes.primary_contact_id) into a Map<householdId, pcoPersonId>,
// used to propose LMPG family-name updates.
async function fetchAllPcoPeople(accessToken) {
  const people = [];
  const householdPrimaryContacts = new Map();
  let next = 'https://api.planningcenteronline.com/people/v2/people?per_page=100&include=households,field_data';
  let pages = 0;
  while (next) {
    if (++pages > 1000) {
      throw new Error('PCO people fetch exceeded 1000 pages — aborting to avoid an unbounded loop');
    }
    const resp = await httpsGet(next, accessToken);
    if (resp.status !== 200) {
      throw new Error(`PCO people fetch failed (status ${resp.status})`);
    }
    const data = resp.data;
    const fieldDataById = new Map();
    for (const inc of data.included || []) {
      if (inc.type === 'FieldDatum') fieldDataById.set(inc.id, inc);
      else if (inc.type === 'Household' && inc.attributes && inc.attributes.primary_contact_id) {
        householdPrimaryContacts.set(inc.id, inc.attributes.primary_contact_id);
      }
    }
    for (const raw of data.data || []) people.push(projectPerson(raw, fieldDataById));
    next = (data.links && data.links.next) || null;
  }
  return { people, householdPrimaryContacts };
}
```

- [ ] **Step 2: Cache `householdPrimaryContacts` alongside `people`**

Find:

```js
async function getCachedPcoPeople(churchId, accessToken, { force = false } = {}) {
  const cached = pcoPeopleCache.get(churchId);
  if (!force && cached && (Date.now() - cached.fetchedAt) < PCO_PEOPLE_TTL_MS) {
    return cached;
  }
  const people = await fetchAllPcoPeople(accessToken);
  const entry = { people, fetchedAt: Date.now() };
  pcoPeopleCache.set(churchId, entry);
  return entry;
}
```

Replace with:

```js
async function getCachedPcoPeople(churchId, accessToken, { force = false } = {}) {
  const cached = pcoPeopleCache.get(churchId);
  if (!force && cached && (Date.now() - cached.fetchedAt) < PCO_PEOPLE_TTL_MS) {
    return cached;
  }
  const { people, householdPrimaryContacts } = await fetchAllPcoPeople(accessToken);
  const entry = { people, householdPrimaryContacts, fetchedAt: Date.now() };
  pcoPeopleCache.set(churchId, entry);
  return entry;
}
```

- [ ] **Step 3: Add `family_name` to `loadChurchState`'s families query**

Find:

```js
  const families = await Database.query(
    `SELECT id, planning_center_id AS planningCenterId FROM families WHERE church_id = ?`,
    [churchId]
  );
```

Replace with:

```js
  const families = await Database.query(
    `SELECT id, family_name AS familyName, planning_center_id AS planningCenterId FROM families WHERE church_id = ?`,
    [churchId]
  );
```

- [ ] **Step 4: Pass `householdPrimaryContacts` through `computePlanForChurch`**

Find:

```js
async function computePlanForChurch(churchId, accessToken, filterConfig, { force = false } = {}) {
  const { people: pcoPeople, fetchedAt } = await getCachedPcoPeople(churchId, accessToken, { force });
  const { individuals, families } = await loadChurchState(churchId);
  const plan = computePlan({ pcoPeople, individuals, families, filterConfig });
  plan.pcoFetchedAt = new Date(fetchedAt).toISOString();
  return plan;
}
```

Replace with:

```js
async function computePlanForChurch(churchId, accessToken, filterConfig, { force = false } = {}) {
  const { people: pcoPeople, householdPrimaryContacts, fetchedAt } = await getCachedPcoPeople(churchId, accessToken, { force });
  const { individuals, families } = await loadChurchState(churchId);
  const plan = computePlan({ pcoPeople, individuals, families, filterConfig, householdPrimaryContacts });
  plan.pcoFetchedAt = new Date(fetchedAt).toISOString();
  return plan;
}
```

- [ ] **Step 5: Verify no syntax errors**

Run: `docker compose -f docker-compose.dev.yml exec server node --check services/planningCenterSync.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Run the full server test suite to check for regressions**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all pre-existing tests pass. (`diffEngine.js` doesn't yet read
`householdPrimaryContacts` — that's the next task — so this is a safe intermediate
state; `computePlan` simply receives and ignores the extra property today.)

- [ ] **Step 7: Commit**

```bash
git add server/services/planningCenterSync.js
git commit -m "feat(pco): capture PCO household primary-contact and family_name for plan computation"
```

---

### Task 15: `familyNameUpdates` bucket in `computePlan`

**Files:**
- Modify: `server/services/planningCenter/diffEngine.js`
- Test: `server/services/planningCenter/diffEngine.test.js`

- [ ] **Step 1: Write the failing tests**

In `server/services/planningCenter/diffEngine.test.js`, find:

```js
const FILTER = { membershipFilterEnabled: true, membershipAllowlist: ['Church Members', 'Regular Attenders'], fieldFilterEnabled: false, fieldFilters: [] };
const FILTER_EMPTY = { membershipFilterEnabled: true, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [] };
```

Replace with:

```js
const FILTER = { membershipFilterEnabled: true, membershipAllowlist: ['Church Members', 'Regular Attenders'], fieldFilterEnabled: false, fieldFilters: [] };
const FILTER_EMPTY = { membershipFilterEnabled: true, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [] };

function family(id, familyName, extra = {}) {
  return { id, familyName, planningCenterId: null, ...extra };
}
```

Add to the end of the file:

```js
test('familyNameUpdates: proposes a rename when the linked head-of-household differs from the current family name', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 })],
    families: [family(10, 'Smith, John', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, [{ familyId: 10, oldName: 'Smith, John', newName: 'Smith, Jane' }]);
});

test('familyNameUpdates: skips when the head-of-household is not yet linked in LMPG', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p2', familyId: 10 })],
    families: [family(10, 'Smith, John', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, []);
});

test('familyNameUpdates: does not propose when the name already matches', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 })],
    families: [family(10, 'Smith, Jane', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, []);
});

test('familyNameUpdates: skips families with no planning_center_id', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 })],
    families: [family(10, 'Smith, John')],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, []);
});

test('familyNameUpdates: empty when householdPrimaryContacts is not provided', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 })],
    families: [family(10, 'Smith, John', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.familyNameUpdates, []);
});

test('familyNameUpdates: puts the head-of-household first among adults, keeps other adults', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [
      ind(1, 'John', 'Smith', { planningCenterId: 'p0', familyId: 10 }),
      ind(2, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 }),
    ],
    families: [family(10, 'Smith, John and Jane', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, [{ familyId: 10, oldName: 'Smith, John and Jane', newName: 'Smith, Jane and John' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/diffEngine.test.js`
Expected: the 6 new tests FAIL with `plan.familyNameUpdates` being `undefined`.

- [ ] **Step 3: Implement `familyNameUpdates` in `computePlan`**

In `server/services/planningCenter/diffEngine.js`, find:

```js
const { matchIndividuals } = require('./matcher');
const { isEligible } = require('./eligibility');
```

Replace with:

```js
const { matchIndividuals } = require('./matcher');
const { isEligible } = require('./eligibility');
const { buildFamilyName } = require('./familyName');
```

Find the `computePlan` function signature:

```js
function computePlan({ pcoPeople, individuals, families, filterConfig }) {
```

Replace with:

```js
function computePlan({ pcoPeople, individuals, families, filterConfig, householdPrimaryContacts }) {
```

Find:

```js
    if (p.firstName !== i.firstName || p.lastName !== i.lastName || p.child !== !!i.isChild) {
      update.push({ individualId: i.id, pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child });
    }
  }

  // Re-bucket the matcher's "unmatched" by peopleType + isActive:
```

Replace with:

```js
    if (p.firstName !== i.firstName || p.lastName !== i.lastName || p.child !== !!i.isChild) {
      update.push({ individualId: i.id, pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child });
    }
  }

  // Family name sync: for every LMPG family linked to a PCO household whose
  // PCO-designated head-of-household is one of that family's own linked members,
  // propose a rename built the same way buildFamilyName always has, but with the
  // head-of-household first. Skipped entirely if the head-of-household isn't yet
  // linked to an LMPG individual — no guess is made in that case.
  const familyNameUpdates = [];
  if (householdPrimaryContacts) {
    const membersByFamily = new Map();
    for (const i of individuals) {
      if (i.familyId == null) continue;
      if (!membersByFamily.has(i.familyId)) membersByFamily.set(i.familyId, []);
      membersByFamily.get(i.familyId).push(i);
    }
    for (const f of families) {
      if (!f.planningCenterId) continue;
      const primaryContactPcoId = householdPrimaryContacts.get(f.planningCenterId);
      if (!primaryContactPcoId) continue;
      const members = membersByFamily.get(f.id) || [];
      const head = members.find((m) => m.planningCenterId === primaryContactPcoId);
      if (!head) continue; // head-of-household not yet linked in LMPG -> no guess
      const newName = buildFamilyName([head, ...members.filter((m) => m !== head)]);
      if (newName !== f.familyName) {
        familyNameUpdates.push({ familyId: f.id, oldName: f.familyName, newName });
      }
    }
  }

  // Re-bucket the matcher's "unmatched" by peopleType + isActive:
```

Then find the `return` statement:

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
    familyNameUpdates,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/diffEngine.test.js`
Expected: all tests pass (pre-existing count + 6 new).

- [ ] **Step 5: Run the full server test suite to check for regressions**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenter/diffEngine.js server/services/planningCenter/diffEngine.test.js
git commit -m "feat(pco): add familyNameUpdates bucket from PCO's head-of-household"
```

---

### Task 16: Apply `familyNameUpdates`

**Files:**
- Modify: `server/services/planningCenter/apply.js`

No new automated test — DB-touching, same established convention as Task 4/5.

- [ ] **Step 1: Add the counter**

In `server/services/planningCenter/apply.js`, find:

```js
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, gatheringAssigned: 0, errors: [] };
```

Replace with:

```js
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, gatheringAssigned: 0, familyNamesUpdated: 0, errors: [] };
```

- [ ] **Step 2: Read the skip set**

Find:

```js
  const skipAdd = new Set(selections.skipAddPcoIds || []);
  const ambiguousChoices = selections.ambiguous || {};
  const visitorChoices = selections.visitorChoices || {};
```

Replace with:

```js
  const skipAdd = new Set(selections.skipAddPcoIds || []);
  const ambiguousChoices = selections.ambiguous || {};
  const visitorChoices = selections.visitorChoices || {};
  const skipFamilyName = new Set((selections.skipFamilyNameUpdateIds || []).map(Number));
```

- [ ] **Step 3: Apply the updates**

Find (the block added in Task 4):

```js
  // Ambiguous individuals the reviewer chose to archive outright instead of picking
  // a candidate (or a manual search result). Independent of plan.archive (which is
  // driven by PCO status, not reviewer choice).
  for (const individualId of (selections.archiveAmbiguousIds || [])) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [individualId, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archiveAmbiguous', id: individualId, error: e.message }); }
  }
```

Replace with:

```js
  // Ambiguous individuals the reviewer chose to archive outright instead of picking
  // a candidate (or a manual search result). Independent of plan.archive (which is
  // driven by PCO status, not reviewer choice).
  for (const individualId of (selections.archiveAmbiguousIds || [])) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [individualId, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archiveAmbiguous', id: individualId, error: e.message }); }
  }

  // Family names PCO's head-of-household suggests differ from the current name,
  // reviewed and opted into per-family (checked by default client-side).
  for (const u of (plan.familyNameUpdates || [])) {
    if (skipFamilyName.has(u.familyId)) continue;
    try {
      await Database.query(
        `UPDATE families SET family_name = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [u.newName, u.familyId, churchId]
      );
      result.familyNamesUpdated++;
    } catch (e) { result.errors.push({ type: 'familyName', id: u.familyId, error: e.message }); }
  }
```

- [ ] **Step 4: Verify no syntax errors**

Run: `docker compose -f docker-compose.dev.yml exec server node --check services/planningCenter/apply.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Run the full server test suite to check for regressions**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenter/apply.js
git commit -m "feat(pco): apply reviewed family name updates"
```

---

### Task 17: Surface `familyNameUpdates`/`familyNamesUpdated` from the batch routes

**Files:**
- Modify: `server/routes/integrations.js`

- [ ] **Step 1: Add the count to the dry-run plan summary**

In `server/routes/integrations.js`, find (inside `router.get('/planning-center/sync-batches/:id/plan', ...)`):

```js
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
```

Replace with:

```js
      summary: {
        link: plan.link.length,
        restore: (plan.restore || []).length,
        ambiguous: plan.ambiguous.length,
        visitorMatches: (plan.visitorMatches || []).length,
        add: plan.add.length,
        update: plan.update.length,
        archive: plan.archive.length,
        reactivate: plan.reactivate.length,
        familyNameUpdates: (plan.familyNameUpdates || []).length,
      },
```

- [ ] **Step 2: Validate `skipFamilyNameUpdateIds` and pass it through in the apply route**

Find (inside `router.post('/planning-center/sync-batches/:id/apply', ...)`, the end of
the selections block from Task 7):

```js
    const selections = { ambiguous, skipAddPcoIds, visitorChoices, archiveAmbiguousIds };
```

Replace with:

```js
    const familyNameUpdateIds = new Set((plan.familyNameUpdates || []).map((f) => f.familyId));
    const skipFamilyNameUpdateIds = (Array.isArray(rawSel.skipFamilyNameUpdateIds) ? rawSel.skipFamilyNameUpdateIds : [])
      .map(Number)
      .filter((id) => familyNameUpdateIds.has(id));

    const selections = { ambiguous, skipAddPcoIds, visitorChoices, archiveAmbiguousIds, skipFamilyNameUpdateIds };
```

- [ ] **Step 3: Add `familyNamesUpdated` to the apply summary**

Find:

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
```

Replace with:

```js
    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      gatheringAssigned: result.gatheringAssigned,
      familyNamesUpdated: result.familyNamesUpdated,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      errors: result.errors.length,
    };
```

- [ ] **Step 4: Verify no syntax errors**

Run: `docker compose -f docker-compose.dev.yml exec server node --check routes/integrations.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Run the full server test suite to check for regressions**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): surface family name update counts from the batch sync routes"
```

---

### Task 18: `syncSelections.ts` — `skipFamilyNameUpdateIds`

**Files:**
- Modify: `client/src/components/planningCenter/syncSelections.ts`
- Modify: `client/src/components/planningCenter/syncSelections.test.ts`

- [ ] **Step 1: Add the failing test**

In `client/src/components/planningCenter/syncSelections.test.ts`, find:

```ts
  it('includes archiveAmbiguousIds when provided', () => {
    const result = buildSelections({}, new Set(), {}, new Set([5, 6]));
    expect(result.archiveAmbiguousIds).toEqual([5, 6]);
  });
});
```

Replace with:

```ts
  it('includes archiveAmbiguousIds when provided', () => {
    const result = buildSelections({}, new Set(), {}, new Set([5, 6]));
    expect(result.archiveAmbiguousIds).toEqual([5, 6]);
  });

  it('includes skipFamilyNameUpdateIds when provided', () => {
    const result = buildSelections({}, new Set(), {}, new Set(), new Set([100, 200]));
    expect(result.skipFamilyNameUpdateIds).toEqual([100, 200]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose -f docker-compose.dev.yml exec client npx vitest run src/components/planningCenter/syncSelections.test.ts`
Expected: FAIL — `buildSelections` doesn't accept a 5th argument yet /
`result.skipFamilyNameUpdateIds` is `undefined`.

- [ ] **Step 3: Update `syncSelections.ts`**

In `client/src/components/planningCenter/syncSelections.ts`, find:

```ts
export interface SyncSelections {
  ambiguous: Record<string, string>;
  skipAddPcoIds: string[];
  visitorChoices: Record<string, VisitorChoice>;
  archiveAmbiguousIds: number[];
}
```

Replace with:

```ts
export interface SyncSelections {
  ambiguous: Record<string, string>;
  skipAddPcoIds: string[];
  visitorChoices: Record<string, VisitorChoice>;
  archiveAmbiguousIds: number[];
  skipFamilyNameUpdateIds: number[];
}
```

Find:

```ts
export function buildSelections(
  ambiguousChoices: Record<string, string | null>,
  skipAddPcoIds: Set<string>,
  visitorChoices: Record<string, VisitorChoice | null> = {},
  archiveAmbiguousIds: Set<number> = new Set(),
): SyncSelections {
  const ambiguous: Record<string, string> = {};
  for (const [individualId, pcoId] of Object.entries(ambiguousChoices)) {
    if (pcoId) ambiguous[individualId] = pcoId;
  }
  const vChoices: Record<string, VisitorChoice> = {};
  for (const [individualId, choice] of Object.entries(visitorChoices)) {
    if (choice === 'promote' || choice === 'keep') vChoices[individualId] = choice;
  }
  return {
    ambiguous,
    skipAddPcoIds: [...skipAddPcoIds],
    visitorChoices: vChoices,
    archiveAmbiguousIds: [...archiveAmbiguousIds],
  };
}
```

Replace with:

```ts
export function buildSelections(
  ambiguousChoices: Record<string, string | null>,
  skipAddPcoIds: Set<string>,
  visitorChoices: Record<string, VisitorChoice | null> = {},
  archiveAmbiguousIds: Set<number> = new Set(),
  skipFamilyNameUpdateIds: Set<number> = new Set(),
): SyncSelections {
  const ambiguous: Record<string, string> = {};
  for (const [individualId, pcoId] of Object.entries(ambiguousChoices)) {
    if (pcoId) ambiguous[individualId] = pcoId;
  }
  const vChoices: Record<string, VisitorChoice> = {};
  for (const [individualId, choice] of Object.entries(visitorChoices)) {
    if (choice === 'promote' || choice === 'keep') vChoices[individualId] = choice;
  }
  return {
    ambiguous,
    skipAddPcoIds: [...skipAddPcoIds],
    visitorChoices: vChoices,
    archiveAmbiguousIds: [...archiveAmbiguousIds],
    skipFamilyNameUpdateIds: [...skipFamilyNameUpdateIds],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose -f docker-compose.dev.yml exec client npx vitest run src/components/planningCenter/syncSelections.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/planningCenter/syncSelections.ts client/src/components/planningCenter/syncSelections.test.ts
git commit -m "feat(pco): add skipFamilyNameUpdateIds to sync selections"
```

---

### Task 19: `PlanningCenterSyncReview.tsx` — family name updates section

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`

- [ ] **Step 1: Add the field to the `Plan` interface**

In `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`, find:

```tsx
interface Plan {
  link: { individualId: number; pcoId: string }[];
  restore: { individualId: number; pcoId: string }[];
  ambiguous: AmbiguousEntry[];
  visitorMatches: VisitorMatchEntry[];
  add: { pcoId: string; firstName: string; lastName: string; isChild: boolean; householdId: string | null; membership: string | null }[];
  update: { individualId: number; firstName: string; lastName: string }[];
  archive: { individualId: number; pcoId: string }[];
  reactivate: { individualId: number; pcoId: string }[];
  pcoFetchedAt?: string;
}
```

Replace with:

```tsx
interface FamilyNameUpdateEntry { familyId: number; oldName: string; newName: string; }
interface Plan {
  link: { individualId: number; pcoId: string }[];
  restore: { individualId: number; pcoId: string }[];
  ambiguous: AmbiguousEntry[];
  visitorMatches: VisitorMatchEntry[];
  add: { pcoId: string; firstName: string; lastName: string; isChild: boolean; householdId: string | null; membership: string | null }[];
  update: { individualId: number; firstName: string; lastName: string }[];
  archive: { individualId: number; pcoId: string }[];
  reactivate: { individualId: number; pcoId: string }[];
  familyNameUpdates: FamilyNameUpdateEntry[];
  pcoFetchedAt?: string;
}
```

- [ ] **Step 2: Add state and reset it on reload**

Find:

```tsx
  const [archiveAmbiguousIds, setArchiveAmbiguousIds] = useState<Set<number>>(new Set());
  const [manualPicks, setManualPicks] = useState<Record<number, PcoPersonResult | null>>({});
```

Replace with:

```tsx
  const [archiveAmbiguousIds, setArchiveAmbiguousIds] = useState<Set<number>>(new Set());
  const [manualPicks, setManualPicks] = useState<Record<number, PcoPersonResult | null>>({});
  const [skipFamilyNameUpdateIds, setSkipFamilyNameUpdateIds] = useState<Set<number>>(new Set());
```

Find:

```tsx
      setArchiveAmbiguousIds(new Set());
      setManualPicks({});
```

Replace with:

```tsx
      setArchiveAmbiguousIds(new Set());
      setManualPicks({});
      setSkipFamilyNameUpdateIds(new Set());
```

- [ ] **Step 3: Pass the new state into `buildSelections`**

Find:

```tsx
      const selections = buildSelections(ambiguousChoices, skipAdd, visitorChoices, archiveAmbiguousIds);
```

Replace with:

```tsx
      const selections = buildSelections(ambiguousChoices, skipAdd, visitorChoices, archiveAmbiguousIds, skipFamilyNameUpdateIds);
```

- [ ] **Step 4: Add the toggle helper and render the section**

Find:

```tsx
  const toggleSkip = (pcoId: string) => {
    setSkipAdd((prev) => { const n = new Set(prev); if (n.has(pcoId)) n.delete(pcoId); else n.add(pcoId); return n; });
  };
```

Replace with:

```tsx
  const toggleSkip = (pcoId: string) => {
    setSkipAdd((prev) => { const n = new Set(prev); if (n.has(pcoId)) n.delete(pcoId); else n.add(pcoId); return n; });
  };

  const toggleSkipFamilyName = (familyId: number) => {
    setSkipFamilyNameUpdateIds((prev) => { const n = new Set(prev); if (n.has(familyId)) n.delete(familyId); else n.add(familyId); return n; });
  };
```

Find:

```tsx
      <details className="text-sm text-gray-600 dark:text-gray-300">
        <summary className="cursor-pointer">Auto-applied: {plan.link.length} link, {plan.restore.length} restore, {plan.update.length} update, {plan.archive.length} archive, {plan.reactivate.length} reactivate</summary>
      </details>
```

Replace with:

```tsx
      {plan.familyNameUpdates.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Family name updates ({plan.familyNameUpdates.length - skipFamilyNameUpdateIds.size} selected)
          </h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
            Planning Center's head-of-household differs from the current family name. Uncheck any you want to leave as-is.
          </p>
          <ul className="max-h-64 overflow-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {plan.familyNameUpdates.map((f) => (
              <li key={f.familyId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <input type="checkbox" checked={!skipFamilyNameUpdateIds.has(f.familyId)} onChange={() => toggleSkipFamilyName(f.familyId)} />
                <span>{f.oldName} → {f.newName}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="text-sm text-gray-600 dark:text-gray-300">
        <summary className="cursor-pointer">Auto-applied: {plan.link.length} link, {plan.restore.length} restore, {plan.update.length} update, {plan.archive.length} archive, {plan.reactivate.length} reactivate</summary>
      </details>
```

- [ ] **Step 5: Show the count in the result line**

Find:

```tsx
      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Applied: {result.added} added, {result.updated} updated, {result.archived} archived, {result.reactivated} reactivated, {result.linked} linked
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
```

Replace with:

```tsx
      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Applied: {result.added} added, {result.updated} updated, {result.archived} archived, {result.reactivated} reactivated, {result.linked} linked
          {result.familyNamesUpdated ? `, ${result.familyNamesUpdated} family names updated` : ''}
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
```

- [ ] **Step 6: Verify no new TypeScript errors**

Run: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
Expected: only the known pre-existing `TS5107` warning, no new errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterSyncReview.tsx
git commit -m "feat(pco): show reviewable family name updates in the sync review UI"
```

---

### Task 20: End-to-end verification

**Files:** none (verification only)

`applyPlan`/`applyArchiveExtras` write to real database tables and (in production)
call the real Planning Center API. Verify safely against a throwaway database, not
any real church's data.

- [ ] **Step 1: Run the full server test suite**

Run: `docker compose -f docker-compose.dev.yml exec server node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all tests pass, 0 failures.

- [ ] **Step 2: Run the client type-check**

Run: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
Expected: only the known pre-existing `TS5107` warning, no new errors.

- [ ] **Step 3: Run the client unit tests**

Run: `docker compose -f docker-compose.dev.yml exec client npx vitest run src/components/planningCenter/syncSelections.test.ts`
Expected: all tests pass.

- [ ] **Step 4: Exercise manual-link, archive-ambiguous, and family-rename logic against a throwaway database**

Write this to
`/private/tmp/claude-501/-Users-isaaclee-Projects-Let-My-People-Grow-letmypeoplegrow/173cfd5e-767b-4ae7-b8cb-5549e58ea84e/scratchpad/verify-manual-linkage.js`
(the project's scratchpad directory — do not commit it; delete it after running).
This runs INSIDE the server container (so it can `require` the app's modules and use
`better-sqlite3` the same way the app does), using a temp `DATA_DIR` under `/tmp`
inside the container so it never touches the real `server_data_dev` volume:

```js
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pco-manual-linkage-verify-'));
process.env.DATA_DIR = tmpDir;

const Database = require('/app/config/database');
const { applyPlan, applyArchiveExtras } = require('/app/services/planningCenter/apply');

async function main() {
  Database.initialize();
  const churchId = 'verify_church';
  Database.ensureChurchSchema(churchId);

  await Database.setChurchContext(churchId, async () => {
    // --- archiveAmbiguousIds ---
    await Database.query(
      `INSERT INTO individuals (church_id, first_name, last_name, people_type, is_active, created_at) VALUES (?, 'Amb', 'Iguous', 'regular', 1, datetime('now'))`,
      [churchId]
    );
    const ambRows = await Database.query(`SELECT id FROM individuals WHERE church_id = ? AND first_name = 'Amb'`, [churchId]);
    const ambId = ambRows[0].id;
    const plan1 = { link: [], restore: [], add: [], update: [], archive: [], reactivate: [], familyNameUpdates: [] };
    const result1 = await applyPlan(churchId, plan1, null, { archiveAmbiguousIds: [ambId] }, {});
    const ambCheck = await Database.query(`SELECT is_active FROM individuals WHERE id = ?`, [ambId]);
    console.log('archiveAmbiguousIds archives (expect is_active=0, archived=1) ->', ambCheck[0].is_active, result1.archived);

    // --- applyArchiveExtras manualLinks ---
    await Database.query(
      `INSERT INTO individuals (church_id, first_name, last_name, people_type, is_active, created_at) VALUES (?, 'Extra', 'Person', 'regular', 1, datetime('now'))`,
      [churchId]
    );
    const extraRows = await Database.query(`SELECT id FROM individuals WHERE church_id = ? AND first_name = 'Extra'`, [churchId]);
    const extraId = extraRows[0].id;
    const result2 = await applyArchiveExtras(churchId, [{ individualId: extraId }], { manualLinks: { [extraId]: 'pco999' } });
    const extraCheck = await Database.query(`SELECT is_active, planning_center_id FROM individuals WHERE id = ?`, [extraId]);
    console.log('manualLinks links instead of archiving (expect is_active=1, planning_center_id=pco999, linked=1, archived=0) ->',
      extraCheck[0].is_active, extraCheck[0].planning_center_id, result2.linked, result2.archived);

    // --- familyNameUpdates ---
    const famRes = await Database.query(
      `INSERT INTO families (church_id, family_name, planning_center_id, created_at) VALUES (?, 'Smith, John', 'h1', datetime('now'))`,
      [churchId]
    );
    const familyId = famRes.insertId;
    const plan2 = { link: [], restore: [], add: [], update: [], archive: [], reactivate: [], familyNameUpdates: [{ familyId, oldName: 'Smith, John', newName: 'Smith, Jane' }] };
    const result3 = await applyPlan(churchId, plan2, null, {}, {});
    const famCheck = await Database.query(`SELECT family_name FROM families WHERE id = ?`, [familyId]);
    console.log('familyNameUpdates renames (expect Smith, Jane, familyNamesUpdated=1) ->', famCheck[0].family_name, result3.familyNamesUpdated);

    const plan3 = { link: [], restore: [], add: [], update: [], archive: [], reactivate: [], familyNameUpdates: [{ familyId, oldName: 'Smith, Jane', newName: 'Smith, Someone Else' }] };
    const result4 = await applyPlan(churchId, plan3, null, { skipFamilyNameUpdateIds: [familyId] }, {});
    const famCheck2 = await Database.query(`SELECT family_name FROM families WHERE id = ?`, [familyId]);
    console.log('skipFamilyNameUpdateIds prevents rename (expect still Smith, Jane, familyNamesUpdated=0) ->', famCheck2[0].family_name, result4.familyNamesUpdated);

    // --- unique index on planning_center_id ---
    let uniqueIndexEnforced = false;
    try {
      await Database.query(
        `INSERT INTO individuals (church_id, first_name, last_name, people_type, is_active, planning_center_id, created_at) VALUES (?, 'Dup1', 'X', 'regular', 1, 'pco_dup', datetime('now'))`,
        [churchId]
      );
      await Database.query(
        `INSERT INTO individuals (church_id, first_name, last_name, people_type, is_active, planning_center_id, created_at) VALUES (?, 'Dup2', 'Y', 'regular', 1, 'pco_dup', datetime('now'))`,
        [churchId]
      );
    } catch (e) {
      uniqueIndexEnforced = true;
    }
    console.log('unique index rejects duplicate planning_center_id (expect true) ->', uniqueIndexEnforced);
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

The container only mounts `./server:/app` — the script lives outside that, on the
host scratchpad path — so copy it into the container first, then run it:

```bash
docker compose -f docker-compose.dev.yml cp \
  "/private/tmp/claude-501/-Users-isaaclee-Projects-Let-My-People-Grow-letmypeoplegrow/173cfd5e-767b-4ae7-b8cb-5549e58ea84e/scratchpad/verify-manual-linkage.js" \
  server:/tmp/verify-manual-linkage.js
docker compose -f docker-compose.dev.yml exec server node /tmp/verify-manual-linkage.js
```

Expected output (five lines):
```
archiveAmbiguousIds archives (expect is_active=0, archived=1) -> 0 1
manualLinks links instead of archiving (expect is_active=1, planning_center_id=pco999, linked=1, archived=0) -> 1 pco999 1 0
familyNameUpdates renames (expect Smith, Jane, familyNamesUpdated=1) -> Smith, Jane 1
skipFamilyNameUpdateIds prevents rename (expect still Smith, Jane, familyNamesUpdated=0) -> Smith, Jane 0
unique index rejects duplicate planning_center_id (expect true) -> true
```

Delete both the host-side scratchpad file and the in-container `/tmp/verify-manual-linkage.js` after running — they're throwaway, not part of the codebase.

- [ ] **Step 5: Manual browser check (if this dev environment has PCO-connected data)**

Open the app, go to Settings → Integrations → Planning Center. If a sync batch has
any ambiguous or add entries, or reconciliation has any archiveExtras, exercise the
manual search/archive/link UI end-to-end for at least one row and confirm "Apply"
succeeds and the result line reflects it. If this dev environment's connected church
has no such entries right now, rely on Steps 1–4 instead and note that in your report.

- [ ] **Step 6: Report results**

Summarize what was verified (full test suite, type-check, unit tests, throwaway-DB
script output, and any manual browser check performed) back to the user. Do not
claim this is complete without having actually run Step 4 and observed the expected
output — reasoning about DB-touching code without running it is not sufficient here.
