# Multi-Church Account Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user whose email/mobile (or an admin-assigned link) matches more than one church switch between those churches after logging in, without re-verifying, via a control next to the logout button — plus an internal admin tool to manually link accounts that don't share exact contact details.

**Architecture:** A new nullable `person_id` column on the registry's `user_lookup` table extends the existing automatic email/mobile matching with admin-assigned manual links. Two new `/api/auth` endpoints (`GET /my-churches`, `POST /switch-church`) reuse the trust already established by the current session's OTC-verified JWT to re-mint a token scoped to a different linked church — no new OTC. The admin panel (`localhost:7777`) gets link/unlink actions layered onto its existing cross-church user search.

**Tech Stack:** Node/Express, better-sqlite3, `node:test` (server), React 19/TypeScript, vitest + `@testing-library/react` (client).

**Spec:** `docs/superpowers/specs/2026-07-13-multi-church-account-switching-design.md`

---

## File Structure

**Backend:**
- Modify: `server/config/schema.js` — add `person_id` column to `REGISTRY_SCHEMA`.
- Modify: `server/config/database.js` — add `migrateRegistry()` upgrade path, `lookupLinkedChurches`, `linkUserLookups`, `unlinkUserLookup`, `getChurchName`, `resolveChurchSwitch`.
- Modify: `server/config/database.test.js` — tests for all five new methods.
- Modify: `server/routes/auth.js` — `GET /my-churches`, `POST /switch-church` (thin wrappers around `resolveChurchSwitch`), `churchName` added to `verify-code`/`/me` responses.
- Modify: `server/middleware/auth.js` — allow the two new routes through the unapproved-church gate.
- Modify: `server/admin/index.js` — `person_id` surfaced on `GET /api/users` and `GET /api/users/:userId`; new `POST /api/users/:churchId/:userId/link` and `.../unlink`.
- Modify: `server/admin/public/index.html` — "linked" indicator, link modal, unlink action.

**Frontend:**
- Modify: `client/src/services/api.ts` — `churchName` on `User`, `authAPI.getMyChurches`/`switchChurch`.
- Modify: `client/src/contexts/AuthContext.tsx` — `myChurches` state, `switchChurch` function.
- Create: `client/src/components/ChurchSwitcher.tsx` + `client/src/components/ChurchSwitcher.test.tsx`.
- Modify: `client/src/components/Layout.tsx` — mount `ChurchSwitcher` above logout in both sidebars.

---

## Task 1: Registry schema — add `person_id` column + migration

**Files:**
- Modify: `server/config/schema.js`
- Modify: `server/config/database.js`

- [ ] **Step 1: Add the column and index to `REGISTRY_SCHEMA`**

In `server/config/schema.js`, find the `user_lookup` table definition:

```sql
CREATE TABLE IF NOT EXISTS user_lookup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  email TEXT,
  mobile_number TEXT,
  church_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_lookup_email ON user_lookup(email);
CREATE INDEX IF NOT EXISTS idx_user_lookup_mobile ON user_lookup(mobile_number);
CREATE INDEX IF NOT EXISTS idx_user_lookup_church ON user_lookup(church_id);
```

Replace it with:

```sql
CREATE TABLE IF NOT EXISTS user_lookup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  email TEXT,
  mobile_number TEXT,
  church_id TEXT NOT NULL,
  person_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_lookup_email ON user_lookup(email);
CREATE INDEX IF NOT EXISTS idx_user_lookup_mobile ON user_lookup(mobile_number);
CREATE INDEX IF NOT EXISTS idx_user_lookup_church ON user_lookup(church_id);
CREATE INDEX IF NOT EXISTS idx_user_lookup_person ON user_lookup(person_id);
```

- [ ] **Step 2: Add the upgrade path for existing registries**

In `server/config/database.js`, find `migrateRegistry()`:

```js
static migrateRegistry() {
  if (!registryDb) return;
  const cols = registryDb.prepare('PRAGMA table_info(churches)').all();
  if (!cols.some(c => c.name === 'is_approved')) {
    registryDb.exec('ALTER TABLE churches ADD COLUMN is_approved INTEGER DEFAULT 0');
    // Approve all existing churches so they aren't locked out
    registryDb.exec('UPDATE churches SET is_approved = 1');
    console.log('✅ Registry migration: added is_approved column, approved all existing churches');
  }
}
```

Add a second check inside the same method, right after the `is_approved` block:

```js
static migrateRegistry() {
  if (!registryDb) return;
  const cols = registryDb.prepare('PRAGMA table_info(churches)').all();
  if (!cols.some(c => c.name === 'is_approved')) {
    registryDb.exec('ALTER TABLE churches ADD COLUMN is_approved INTEGER DEFAULT 0');
    // Approve all existing churches so they aren't locked out
    registryDb.exec('UPDATE churches SET is_approved = 1');
    console.log('✅ Registry migration: added is_approved column, approved all existing churches');
  }

  const lookupCols = registryDb.prepare('PRAGMA table_info(user_lookup)').all();
  if (!lookupCols.some(c => c.name === 'person_id')) {
    registryDb.exec('ALTER TABLE user_lookup ADD COLUMN person_id TEXT');
    registryDb.exec('CREATE INDEX IF NOT EXISTS idx_user_lookup_person ON user_lookup(person_id)');
    console.log('✅ Registry migration: added person_id column to user_lookup');
  }
}
```

- [ ] **Step 3: Verify the existing registry test suite still passes**

`withTestChurchDb` creates a brand-new registry from `REGISTRY_SCHEMA` on every call, so this immediately proves the new column doesn't break fresh-database creation.

Run: `docker-compose -f docker-compose.dev.yml exec server node --test config/database.test.js`
Expected: `# pass 2` (the two `resyncUserLookup` tests from the earlier bugfix still pass).

- [ ] **Step 4: Verify the upgrade path against the running dev database**

Run:
```bash
docker-compose -f docker-compose.dev.yml restart server
sleep 3
docker-compose -f docker-compose.dev.yml logs --tail 30 server | grep -i "registry migration"
```
Expected: a line reading `✅ Registry migration: added person_id column to user_lookup` (proves the ALTER TABLE ran against the real dev registry, not just a fresh test one).

- [ ] **Step 5: Commit**

```bash
git add server/config/schema.js server/config/database.js
git commit -m "feat(auth): add person_id column to registry user_lookup for manual church linking"
```

---

## Task 2: `Database.lookupLinkedChurches`

**Files:**
- Modify: `server/config/database.js`
- Modify: `server/config/database.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/config/database.test.js`:

```js
const { randomUUID } = require('crypto');

test('lookupLinkedChurches: finds a church linked by matching email', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = `linktest_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    Database.ensureChurch(churchIdB, 'Church B');

    const insertA = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['dave@example.com', churchIdA]
    );
    const userIdA = insertA.insertId;
    Database.registerUserLookup(userIdA, 'dave@example.com', null, churchIdA);

    const insertB = await Database.queryForChurch(
      churchIdB,
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['dave@example.com', churchIdB]
    );
    const userIdB = insertB.insertId;
    Database.registerUserLookup(userIdB, 'dave@example.com', null, churchIdB);

    const linked = Database.lookupLinkedChurches(userIdA, churchIdA, 'dave@example.com', null);
    assert.strictEqual(linked.length, 1);
    assert.strictEqual(linked[0].church_id, churchIdB);
    assert.strictEqual(linked[0].user_id, userIdB);
    assert.strictEqual(linked[0].church_name, 'Church B');
  });
});

test('lookupLinkedChurches: finds a church linked by matching mobile_number', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = `linktest_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    Database.ensureChurch(churchIdB, 'Church B');

    const insertA = await Database.query(
      `INSERT INTO users (mobile_number, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['+61411202186', churchIdA]
    );
    const userIdA = insertA.insertId;
    Database.registerUserLookup(userIdA, null, '+61411202186', churchIdA);

    const insertB = await Database.queryForChurch(
      churchIdB,
      `INSERT INTO users (mobile_number, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['+61411202186', churchIdB]
    );
    const userIdB = insertB.insertId;
    Database.registerUserLookup(userIdB, null, '+61411202186', churchIdB);

    const linked = Database.lookupLinkedChurches(userIdA, churchIdA, null, '+61411202186');
    assert.strictEqual(linked.length, 1);
    assert.strictEqual(linked[0].church_id, churchIdB);
  });
});

test('lookupLinkedChurches: finds a church linked by matching person_id even with different contact details', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = `linktest_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    Database.ensureChurch(churchIdB, 'Church B');

    const insertA = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['dave.personal@example.com', churchIdA]
    );
    const userIdA = insertA.insertId;
    Database.registerUserLookup(userIdA, 'dave.personal@example.com', null, churchIdA);

    const insertB = await Database.queryForChurch(
      churchIdB,
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['dave.work@example.com', churchIdB]
    );
    const userIdB = insertB.insertId;
    Database.registerUserLookup(userIdB, 'dave.work@example.com', null, churchIdB);

    const sharedPersonId = randomUUID();
    Database.getRegistryDb().prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?')
      .run(sharedPersonId, userIdA, churchIdA);
    Database.getRegistryDb().prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?')
      .run(sharedPersonId, userIdB, churchIdB);

    const linked = Database.lookupLinkedChurches(userIdA, churchIdA, 'dave.personal@example.com', null);
    assert.strictEqual(linked.length, 1);
    assert.strictEqual(linked[0].church_id, churchIdB);
  });
});

test('lookupLinkedChurches: returns empty array when nothing matches', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const insertA = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Solo', 'User', 1, ?)`,
      ['solo@example.com', churchIdA]
    );
    const userIdA = insertA.insertId;
    Database.registerUserLookup(userIdA, 'solo@example.com', null, churchIdA);

    const linked = Database.lookupLinkedChurches(userIdA, churchIdA, 'solo@example.com', null);
    assert.deepStrictEqual(linked, []);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test config/database.test.js`
Expected: `error: 'Database.lookupLinkedChurches is not a function'` on all four new tests.

- [ ] **Step 3: Implement**

In `server/config/database.js`, add this method right after `registerUserLookup` (before `resyncUserLookup`):

```js
static lookupLinkedChurches(userId, churchId, email, mobileNumber) {
  if (!registryDb) return [];
  const selfRow = registryDb.prepare(
    'SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?'
  ).get(userId, churchId);
  const personId = selfRow ? selfRow.person_id : null;
  const emailParam = email || null;
  const mobileParam = mobileNumber || null;

  return registryDb.prepare(
    `SELECT DISTINCT ul.church_id, ul.user_id, c.church_name
     FROM user_lookup ul
     JOIN churches c ON c.church_id = ul.church_id
     WHERE ul.church_id != ?
       AND (
         (? IS NOT NULL AND ul.email = ?) OR
         (? IS NOT NULL AND ul.mobile_number = ?) OR
         (? IS NOT NULL AND ul.person_id = ?)
       )`
  ).all(churchId, emailParam, emailParam, mobileParam, mobileParam, personId, personId);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test config/database.test.js`
Expected: `# pass 6` (2 existing `resyncUserLookup` tests + 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add server/config/database.js server/config/database.test.js
git commit -m "feat(auth): add Database.lookupLinkedChurches for cross-church account matching"
```

---

## Task 3: `Database.linkUserLookups` + `Database.unlinkUserLookup`

**Files:**
- Modify: `server/config/database.js`
- Modify: `server/config/database.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/config/database.test.js`:

```js
function makeChurchId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

test('linkUserLookups: generates a shared person_id for two unlinked rows', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = makeChurchId('linktest');
    Database.ensureChurch(churchIdB, 'Church B');
    Database.registerUserLookup(1, 'a@example.com', null, churchIdA);
    Database.registerUserLookup(2, 'b@example.com', null, churchIdB);

    const personId = Database.linkUserLookups(churchIdA, 1, churchIdB, 2);

    const rowA = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(1, churchIdA);
    const rowB = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(2, churchIdB);
    assert.ok(personId);
    assert.strictEqual(rowA.person_id, personId);
    assert.strictEqual(rowB.person_id, personId);
  });
});

test('linkUserLookups: reuses an existing person_id rather than generating a new one', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = makeChurchId('linktest');
    Database.ensureChurch(churchIdB, 'Church B');
    Database.registerUserLookup(1, 'a@example.com', null, churchIdA);
    Database.registerUserLookup(2, 'b@example.com', null, churchIdB);
    Database.getRegistryDb().prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?')
      .run('existing-group-id', 1, churchIdA);

    const personId = Database.linkUserLookups(churchIdA, 1, churchIdB, 2);

    assert.strictEqual(personId, 'existing-group-id');
    const rowB = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(2, churchIdB);
    assert.strictEqual(rowB.person_id, 'existing-group-id');
  });
});

test('linkUserLookups: merges two existing groups when both rows already have different person_ids', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = makeChurchId('linktest');
    const churchIdC = makeChurchId('linktest');
    Database.ensureChurch(churchIdB, 'Church B');
    Database.ensureChurch(churchIdC, 'Church C');
    Database.registerUserLookup(1, 'a@example.com', null, churchIdA);
    Database.registerUserLookup(2, 'b@example.com', null, churchIdB);
    Database.registerUserLookup(3, 'c@example.com', null, churchIdC);
    Database.getRegistryDb().prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?').run('group-a', 1, churchIdA);
    Database.getRegistryDb().prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?').run('group-b', 2, churchIdB);
    // churchIdC is a second member of group-b, to prove the whole group merges, not just the one row.
    Database.getRegistryDb().prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?').run('group-b', 3, churchIdC);

    const personId = Database.linkUserLookups(churchIdA, 1, churchIdB, 2);

    assert.strictEqual(personId, 'group-a');
    const rowC = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(3, churchIdC);
    assert.strictEqual(rowC.person_id, 'group-a');
  });
});

test('linkUserLookups: throws when a row does not exist', async () => {
  await withTestChurchDb(async (churchIdA) => {
    Database.registerUserLookup(1, 'a@example.com', null, churchIdA);
    assert.throws(() => Database.linkUserLookups(churchIdA, 1, 'nonexistent_church', 999));
  });
});

test('unlinkUserLookup: clears only the specified row, leaving other group members intact', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = makeChurchId('linktest');
    Database.ensureChurch(churchIdB, 'Church B');
    Database.registerUserLookup(1, 'a@example.com', null, churchIdA);
    Database.registerUserLookup(2, 'b@example.com', null, churchIdB);
    Database.linkUserLookups(churchIdA, 1, churchIdB, 2);

    Database.unlinkUserLookup(churchIdA, 1);

    const rowA = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(1, churchIdA);
    const rowB = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(2, churchIdB);
    assert.strictEqual(rowA.person_id, null);
    assert.ok(rowB.person_id, 'the other group member should keep its person_id');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test config/database.test.js`
Expected: `error: 'Database.linkUserLookups is not a function'` (and similarly for `unlinkUserLookup`).

- [ ] **Step 3: Implement**

Add `const { randomUUID } = require('crypto');` to the top of `server/config/database.js`, alongside the existing `require`s:

```js
const BetterSqlite3 = require('better-sqlite3');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { REGISTRY_SCHEMA, CHURCH_SCHEMA, UPDATED_AT_TRIGGERS } = require('./schema');
```

Then add these two methods, right after `lookupLinkedChurches`:

```js
static linkUserLookups(churchIdA, userIdA, churchIdB, userIdB) {
  if (!registryDb) throw new Error('Registry not initialized');
  const rowA = registryDb.prepare(
    'SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?'
  ).get(userIdA, churchIdA);
  const rowB = registryDb.prepare(
    'SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?'
  ).get(userIdB, churchIdB);
  if (!rowA || !rowB) throw new Error('No registry entry found for one or both users');

  if (rowA.person_id && rowB.person_id && rowA.person_id !== rowB.person_id) {
    // Both already belong to different groups: merge B's whole group into A's.
    registryDb.prepare('UPDATE user_lookup SET person_id = ? WHERE person_id = ?')
      .run(rowA.person_id, rowB.person_id);
    return rowA.person_id;
  }

  const personId = rowA.person_id || rowB.person_id || randomUUID();
  registryDb.prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?')
    .run(personId, userIdA, churchIdA);
  registryDb.prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?')
    .run(personId, userIdB, churchIdB);
  return personId;
}

static unlinkUserLookup(churchId, userId) {
  if (!registryDb) throw new Error('Registry not initialized');
  registryDb.prepare('UPDATE user_lookup SET person_id = NULL WHERE user_id = ? AND church_id = ?')
    .run(userId, churchId);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test config/database.test.js`
Expected: `# pass 11`.

- [ ] **Step 5: Commit**

```bash
git add server/config/database.js server/config/database.test.js
git commit -m "feat(auth): add Database.linkUserLookups/unlinkUserLookup for manual account linking"
```

---

## Task 4: `Database.resolveChurchSwitch`

The spec calls for unit tests covering `switch-church`'s rejection paths (church not
approved, target user inactive, target church not linked). There's no HTTP-route test
harness in this codebase (confirmed absent for both `auth.js` and `admin/index.js`), so
— following the same pattern used for `resyncUserLookup` in the registry bugfix — the
validation logic is extracted into a plain, `withTestChurchDb`-testable `Database`
method. The route handler in Task 6 becomes a thin wrapper around it.

**Files:**
- Modify: `server/config/database.js` (add `getChurchName`, `resolveChurchSwitch`)
- Modify: `server/config/database.test.js`

- [ ] **Step 1: Add `Database.getChurchName`**

In `server/config/database.js`, add this method right after `isChurchApproved`:

```js
static getChurchName(churchId) {
  if (!registryDb) return null;
  const row = registryDb.prepare('SELECT church_name FROM churches WHERE church_id = ?').get(churchId);
  return row ? row.church_name : null;
}
```

- [ ] **Step 2: Write the failing tests for `resolveChurchSwitch`**

Append to `server/config/database.test.js`:

```js
test('resolveChurchSwitch: rejects when the target church is not linked to the user', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const insertA = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Solo', 'User', 1, ?)`,
      ['solo@example.com', churchIdA]
    );
    Database.registerUserLookup(insertA.insertId, 'solo@example.com', null, churchIdA);

    const result = await Database.resolveChurchSwitch(insertA.insertId, churchIdA, 'solo@example.com', null, 'nonexistent_church');

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 403);
  });
});

test('resolveChurchSwitch: rejects when the target church is not approved', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = `switchtest_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    Database.ensureChurch(churchIdB, 'Unapproved Church'); // REGISTRY_SCHEMA defaults is_approved to 0

    const insertA = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['dave@example.com', churchIdA]
    );
    Database.registerUserLookup(insertA.insertId, 'dave@example.com', null, churchIdA);
    const insertB = await Database.queryForChurch(
      churchIdB,
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['dave@example.com', churchIdB]
    );
    Database.registerUserLookup(insertB.insertId, 'dave@example.com', null, churchIdB);

    const result = await Database.resolveChurchSwitch(insertA.insertId, churchIdA, 'dave@example.com', null, churchIdB);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 403);
  });
});

test('resolveChurchSwitch: rejects when the target user account is inactive', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = `switchtest_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    Database.ensureChurch(churchIdB, 'Church B');
    Database.getRegistryDb().prepare('UPDATE churches SET is_approved = 1 WHERE church_id = ?').run(churchIdB);

    const insertA = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['dave@example.com', churchIdA]
    );
    Database.registerUserLookup(insertA.insertId, 'dave@example.com', null, churchIdA);
    const insertB = await Database.queryForChurch(
      churchIdB,
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 0, ?)`,
      ['dave@example.com', churchIdB]
    );
    Database.registerUserLookup(insertB.insertId, 'dave@example.com', null, churchIdB);

    const result = await Database.resolveChurchSwitch(insertA.insertId, churchIdA, 'dave@example.com', null, churchIdB);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
  });
});

test('resolveChurchSwitch: succeeds and returns the target user row', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = `switchtest_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    Database.ensureChurch(churchIdB, 'Church B');
    Database.getRegistryDb().prepare('UPDATE churches SET is_approved = 1 WHERE church_id = ?').run(churchIdB);

    const insertA = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['dave@example.com', churchIdA]
    );
    Database.registerUserLookup(insertA.insertId, 'dave@example.com', null, churchIdA);
    const insertB = await Database.queryForChurch(
      churchIdB,
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'coordinator', 'Dave', 'Matthews', 1, ?)`,
      ['dave@example.com', churchIdB]
    );
    Database.registerUserLookup(insertB.insertId, 'dave@example.com', null, churchIdB);

    const result = await Database.resolveChurchSwitch(insertA.insertId, churchIdA, 'dave@example.com', null, churchIdB);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.targetUser.id, insertB.insertId);
    assert.strictEqual(result.targetUser.church_id, churchIdB);
    assert.strictEqual(result.targetUser.role, 'coordinator');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test config/database.test.js`
Expected: `error: 'Database.resolveChurchSwitch is not a function'` on all four new tests.

- [ ] **Step 4: Implement `resolveChurchSwitch`**

Add this method to `server/config/database.js`, right after `lookupLinkedChurches`:

```js
static async resolveChurchSwitch(userId, churchId, email, mobileNumber, targetChurchId) {
  const linked = Database.lookupLinkedChurches(userId, churchId, email, mobileNumber);
  const target = linked.find(l => l.church_id === targetChurchId);
  if (!target) {
    return { ok: false, status: 403, error: 'That church is not linked to your account.' };
  }
  if (!Database.isChurchApproved(targetChurchId)) {
    return { ok: false, status: 403, error: 'That church is pending approval.' };
  }

  const targetUsers = await Database.queryForChurch(
    targetChurchId,
    'SELECT id, email, mobile_number, primary_contact_method, role, first_name, last_name, is_active, first_login_completed, default_gathering_id, church_id FROM users WHERE id = ?',
    [target.user_id]
  );
  if (targetUsers.length === 0 || !targetUsers[0].is_active) {
    return { ok: false, status: 401, error: 'That account is no longer active.' };
  }

  return { ok: true, targetUser: targetUsers[0] };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test config/database.test.js`
Expected: `# pass 15`.

- [ ] **Step 6: Commit**

```bash
git add server/config/database.js server/config/database.test.js
git commit -m "feat(auth): add Database.resolveChurchSwitch with rejection-path tests"
```

---

## Task 5: Backend switch endpoints

**Files:**
- Modify: `server/routes/auth.js`
- Modify: `server/middleware/auth.js`

- [ ] **Step 1: Add `churchName` to the existing `verify-code` and `/me` responses**

In `server/routes/auth.js`, find the `verify-code` response (around line 470-486):

```js
      res.json({
        message: 'Login successful',
        user: {
          id: fullUser.id,
          email: fullUser.email,
          mobileNumber: fullUser.mobile_number,
          primaryContactMethod: fullUser.primary_contact_method,
          role: fullUser.role,
          firstName: fullUser.first_name,
          lastName: fullUser.last_name,
          church_id: fullUser.church_id,
          isChurchApproved: Database.isChurchApproved(fullUser.church_id),
          isFirstLogin,
          defaultGatheringId: fullUser.default_gathering_id,
          gatheringAssignments: assignmentsWithNumbers
        }
      });
```

Add `churchName` right after `church_id`:

```js
      res.json({
        message: 'Login successful',
        user: {
          id: fullUser.id,
          email: fullUser.email,
          mobileNumber: fullUser.mobile_number,
          primaryContactMethod: fullUser.primary_contact_method,
          role: fullUser.role,
          firstName: fullUser.first_name,
          lastName: fullUser.last_name,
          church_id: fullUser.church_id,
          churchName: Database.getChurchName(fullUser.church_id),
          isChurchApproved: Database.isChurchApproved(fullUser.church_id),
          isFirstLogin,
          defaultGatheringId: fullUser.default_gathering_id,
          gatheringAssignments: assignmentsWithNumbers
        }
      });
```

Find the `GET /me` response (around line 519-536) and make the same addition:

```js
    res.json({
      user: {
        id: user.id,
        email: user.email,
        mobileNumber: user.mobile_number,
        primaryContactMethod: user.primary_contact_method || 'email',
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        church_id: user.church_id,
        churchName: Database.getChurchName(user.church_id),
        isChurchApproved: Database.isChurchApproved(user.church_id),
        isFirstLogin: !user.first_login_completed,
        defaultGatheringId: user.default_gathering_id,
        gatheringAssignments: assignmentsWithNumbers,
        unreadNotifications: Number(notificationCount[0].count),
        hasSampleData: !!(churchSettings.length && churchSettings[0].has_sample_data)
      }
    });
```

- [ ] **Step 2: Add the winston logger import**

At the top of `server/routes/auth.js`, add to the existing requires:

```js
const logger = require('../config/logger');
```

- [ ] **Step 3: Add the two new routes**

In `server/routes/auth.js`, add these two routes right after the `GET /me` route (before `const refreshLimiter = ...`). Both are thin wrappers around the already-tested `Database.resolveChurchSwitch` from Task 4:

```js
router.get('/my-churches', verifyToken, async (req, res) => {
  try {
    const user = req.user;
    const linked = Database.lookupLinkedChurches(user.id, user.church_id, user.email, user.mobile_number);

    const churches = [];
    for (const row of linked) {
      const result = await Database.resolveChurchSwitch(user.id, user.church_id, user.email, user.mobile_number, row.church_id);
      if (result.ok) {
        churches.push({ churchId: row.church_id, churchName: row.church_name });
      }
    }

    res.json({ churches });
  } catch (error) {
    console.error('Get my-churches error:', error);
    res.status(500).json({ error: 'Failed to load linked churches.' });
  }
});

router.post('/switch-church',
  verifyToken,
  [body('targetChurchId').trim().notEmpty().withMessage('targetChurchId is required')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const user = req.user;
      const { targetChurchId } = req.body;

      const result = await Database.resolveChurchSwitch(user.id, user.church_id, user.email, user.mobile_number, targetChurchId);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      const targetUser = result.targetUser;

      const token = jwt.sign(
        { userId: targetUser.id, email: targetUser.email, mobile: targetUser.mobile_number, role: targetUser.role, churchId: targetUser.church_id },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '30d' }
      );

      const cookieOptions = {
        httpOnly: true,
        secure: req.secure || process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/'
      };
      if (process.env.COOKIE_DOMAIN) cookieOptions.domain = process.env.COOKIE_DOMAIN;
      res.cookie('authToken', token, cookieOptions);

      await Database.queryForChurch(targetChurchId, "UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [targetUser.id]);

      logger.info('Church switch', {
        fromChurchId: user.church_id,
        fromUserId: user.id,
        toChurchId: targetChurchId,
        toUserId: targetUser.id
      });

      const assignments = await Database.queryForChurch(
        targetChurchId,
        `SELECT gt.id, gt.name, gt.description
         FROM user_gathering_assignments uga
         JOIN gathering_types gt ON uga.gathering_type_id = gt.id
         WHERE uga.user_id = ? AND gt.is_active = 1
         ORDER BY gt.name`,
        [targetUser.id]
      );
      const assignmentsWithNumbers = assignments.map(a => ({ ...a, id: Number(a.id) }));

      res.json({
        message: 'Switched church successfully',
        user: {
          id: targetUser.id,
          email: targetUser.email,
          mobileNumber: targetUser.mobile_number,
          primaryContactMethod: targetUser.primary_contact_method,
          role: targetUser.role,
          firstName: targetUser.first_name,
          lastName: targetUser.last_name,
          church_id: targetUser.church_id,
          churchName: Database.getChurchName(targetUser.church_id),
          isChurchApproved: true,
          isFirstLogin: false,
          defaultGatheringId: targetUser.default_gathering_id,
          gatheringAssignments: assignmentsWithNumbers
        }
      });
    } catch (error) {
      console.error('Switch church error:', error);
      res.status(500).json({ error: 'Failed to switch church.' });
    }
  }
);
```

- [ ] **Step 4: Allow the new routes through the unapproved-church gate**

In `server/middleware/auth.js`, find:

```js
        const allowedPaths = ['/api/auth/me', '/api/auth/refresh', '/api/auth/logout'];
```

Replace with:

```js
        const allowedPaths = ['/api/auth/me', '/api/auth/refresh', '/api/auth/logout', '/api/auth/my-churches', '/api/auth/switch-church'];
```

- [ ] **Step 5: Restart and smoke-test routing**

```bash
docker-compose -f docker-compose.dev.yml restart server
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/api/auth/my-churches
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost/api/auth/switch-church
```
Expected: both print `401` (no auth token) — proves the routes are mounted and gated by `verifyToken`, without needing a full login flow yet. Also check for startup errors:

```bash
docker-compose -f docker-compose.dev.yml logs --tail 30 server | grep -iE "error|cannot find"
```
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add server/routes/auth.js server/middleware/auth.js
git commit -m "feat(auth): add GET /my-churches and POST /switch-church endpoints"
```

---

## Task 6: Frontend — `User` type and `authAPI` methods

**Files:**
- Modify: `client/src/services/api.ts`

- [ ] **Step 1: Add `churchName` to the `User` interface**

Find:

```ts
export interface User {
  id: number;
  email?: string;
  mobileNumber?: string;
  primaryContactMethod: 'email' | 'sms';
  role: 'admin' | 'coordinator' | 'attendance_taker';
  firstName: string;
  lastName: string;
  isChurchApproved?: boolean;
  isFirstLogin?: boolean;
  defaultGatheringId?: number;
  church_id?: string;
  gatheringAssignments: GatheringType[];
  unreadNotifications?: number;
  hasSampleData?: boolean;
}
```

Replace with:

```ts
export interface User {
  id: number;
  email?: string;
  mobileNumber?: string;
  primaryContactMethod: 'email' | 'sms';
  role: 'admin' | 'coordinator' | 'attendance_taker';
  firstName: string;
  lastName: string;
  isChurchApproved?: boolean;
  isFirstLogin?: boolean;
  defaultGatheringId?: number;
  church_id?: string;
  churchName?: string;
  gatheringAssignments: GatheringType[];
  unreadNotifications?: number;
  hasSampleData?: boolean;
}
```

- [ ] **Step 2: Add the two new `authAPI` methods**

Find the `logout`/`clearExpiredToken` methods in `authAPI`:

```ts
  logout: () => 
    api.post('/auth/logout'),
    
  clearExpiredToken: () => 
    api.post('/auth/clear-expired-token'),
```

Add right after:

```ts
  logout: () => 
    api.post('/auth/logout'),
    
  clearExpiredToken: () => 
    api.post('/auth/clear-expired-token'),

  getMyChurches: () =>
    api.get('/auth/my-churches'),

  switchChurch: (targetChurchId: string) =>
    api.post('/auth/switch-church', { targetChurchId }),
```

- [ ] **Step 3: Verify it compiles**

The Vite dev server hot-reloads and surfaces TypeScript errors in its console output.

```bash
docker-compose -f docker-compose.dev.yml logs --tail 20 client
```
Expected: no new TypeScript errors (look for `error TS` or a red overlay message).

- [ ] **Step 4: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat(auth): add churchName to User and my-churches/switch-church to authAPI"
```

---

## Task 7: Frontend — `AuthContext` `myChurches` + `switchChurch`

**Files:**
- Modify: `client/src/contexts/AuthContext.tsx`

- [ ] **Step 1: Add the `MyChurch` type and extend `AuthContextType`**

Find:

```tsx
import React, { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';
import { authAPI, onboardingAPI, User } from '../services/api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  needsOnboarding: boolean;
  login: (token: string, userData: User) => Promise<void>;
  logout: () => void;
  updateUser: (userData: Partial<User>) => void;
  refreshOnboardingStatus: () => Promise<void>;
  refreshUserData: () => Promise<void>;
  refreshTokenAndUserData: () => Promise<boolean>;
}
```

Replace with:

```tsx
import React, { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';
import { authAPI, onboardingAPI, User } from '../services/api';

export interface MyChurch {
  churchId: string;
  churchName: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  needsOnboarding: boolean;
  myChurches: MyChurch[];
  login: (token: string, userData: User) => Promise<void>;
  logout: () => void;
  updateUser: (userData: Partial<User>) => void;
  refreshOnboardingStatus: () => Promise<void>;
  refreshUserData: () => Promise<void>;
  refreshTokenAndUserData: () => Promise<boolean>;
  switchChurch: (targetChurchId: string) => Promise<void>;
}
```

- [ ] **Step 2: Add the `myChurches` state**

Find:

```tsx
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const isInitializing = useRef(false);
```

Replace with:

```tsx
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [myChurches, setMyChurches] = useState<MyChurch[]>([]);
  const isInitializing = useRef(false);
```

- [ ] **Step 3: Fetch `myChurches` on login**

Find the `login` function:

```tsx
  const login = async (token: string, userData: User) => {
    console.log('🔐 AuthContext: login() called for user:', userData.email);
    
    // Token is now handled by cookies, only store user data locally
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(prev => JSON.stringify(prev) !== JSON.stringify(userData) ? userData : prev);
    
    // Check onboarding status for admin users
    if (userData.role === 'admin') {
      try {
        const onboardingResponse = await onboardingAPI.getStatus();
        setNeedsOnboarding(!onboardingResponse.data.completed);
      } catch (onboardingError) {
        console.error('Failed to check onboarding status:', onboardingError);
      }
    }
    
    console.log('✅ AuthContext: login() complete');
  };
```

Replace with:

```tsx
  const login = async (token: string, userData: User) => {
    console.log('🔐 AuthContext: login() called for user:', userData.email);
    
    // Token is now handled by cookies, only store user data locally
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(prev => JSON.stringify(prev) !== JSON.stringify(userData) ? userData : prev);
    
    // Check onboarding status for admin users
    if (userData.role === 'admin') {
      try {
        const onboardingResponse = await onboardingAPI.getStatus();
        setNeedsOnboarding(!onboardingResponse.data.completed);
      } catch (onboardingError) {
        console.error('Failed to check onboarding status:', onboardingError);
      }
    }

    try {
      const myChurchesResponse = await authAPI.getMyChurches();
      setMyChurches(myChurchesResponse.data.churches || []);
    } catch (myChurchesError) {
      console.error('Failed to load linked churches:', myChurchesError);
    }
    
    console.log('✅ AuthContext: login() complete');
  };
```

- [ ] **Step 4: Add the `switchChurch` function**

Find `refreshTokenAndUserData` and add `switchChurch` right after it:

```tsx
  const refreshTokenAndUserData = async () => {
    try {
      console.log('🔄 Refreshing token and user data to sync church ID...');
      // First refresh the token to get updated church ID in JWT
      await authAPI.refreshToken();
      console.log('✅ Token refreshed');
      
      // Then refresh the user data to get latest church_id
      await refreshUserData();
      console.log('✅ Token and user data refreshed successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to refresh token and user data:', error);
      return false;
    }
  };

  const switchChurch = async (targetChurchId: string) => {
    const response = await authAPI.switchChurch(targetChurchId);
    localStorage.setItem('user', JSON.stringify(response.data.user));
    // Hard navigation (not a router push) so every church-scoped query in the
    // app re-fetches cleanly against the new church context.
    window.location.href = '/dashboard';
  };
```

- [ ] **Step 5: Add both to the provider's `value`**

Find:

```tsx
  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    needsOnboarding,
    login,
    logout,
    updateUser,
    refreshOnboardingStatus,
    refreshUserData,
    refreshTokenAndUserData,
  };
```

Replace with:

```tsx
  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    needsOnboarding,
    myChurches,
    login,
    logout,
    updateUser,
    refreshOnboardingStatus,
    refreshUserData,
    refreshTokenAndUserData,
    switchChurch,
  };
```

- [ ] **Step 6: Verify it compiles**

```bash
docker-compose -f docker-compose.dev.yml logs --tail 20 client
```
Expected: no new TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/contexts/AuthContext.tsx
git commit -m "feat(auth): add myChurches and switchChurch to AuthContext"
```

---

## Task 8: `ChurchSwitcher` component

**Files:**
- Create: `client/src/components/ChurchSwitcher.tsx`
- Create: `client/src/components/ChurchSwitcher.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `client/src/components/ChurchSwitcher.test.tsx`:

```tsx
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ChurchSwitcher from './ChurchSwitcher';
import { useAuth } from '../contexts/AuthContext';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

describe('ChurchSwitcher', () => {
  it('renders static text with no button when there are no other linked churches', () => {
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { churchName: 'Kingston CRC' },
      myChurches: [],
      switchChurch: vi.fn(),
    });

    render(<ChurchSwitcher />);

    expect(screen.getByText('Kingston CRC')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a dropdown listing other linked churches when clicked', () => {
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { churchName: 'Kingston CRC' },
      myChurches: [{ churchId: 'crc_54cc7bdb2f53', churchName: 'CRC South Tas' }],
      switchChurch: vi.fn(),
    });

    render(<ChurchSwitcher />);

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('CRC South Tas')).toBeInTheDocument();
  });

  it('calls switchChurch with the selected church id', () => {
    const switchChurchMock = vi.fn();
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { churchName: 'Kingston CRC' },
      myChurches: [{ churchId: 'crc_54cc7bdb2f53', churchName: 'CRC South Tas' }],
      switchChurch: switchChurchMock,
    });

    render(<ChurchSwitcher />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('CRC South Tas'));

    expect(switchChurchMock).toHaveBeenCalledWith('crc_54cc7bdb2f53');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec client npx vitest run src/components/ChurchSwitcher.test.tsx`
Expected: fails with a module-not-found error for `./ChurchSwitcher`.

- [ ] **Step 3: Implement the component**

Create `client/src/components/ChurchSwitcher.tsx`:

```tsx
import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface ChurchSwitcherProps {
  className?: string;
  textClassName?: string;
}

const ChurchSwitcher: React.FC<ChurchSwitcherProps> = ({ className, textClassName }) => {
  const { user, myChurches, switchChurch } = useAuth();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSwitch = async (churchId: string) => {
    setSwitching(true);
    try {
      await switchChurch(churchId);
    } catch (error) {
      console.error('Failed to switch church:', error);
      setSwitching(false);
    }
  };

  if (myChurches.length === 0) {
    return <p className={textClassName}>{user?.churchName}</p>;
  }

  return (
    <div className={`relative ${className || ''}`} ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={switching}
        className={`${textClassName || ''} flex items-center gap-1`}
      >
        <span>{user?.churchName}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-48 rounded-md bg-white dark:bg-gray-700 shadow-lg border border-gray-200 dark:border-gray-600">
          <div className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600">
            Switch church
          </div>
          {myChurches.map((church) => (
            <button
              key={church.churchId}
              type="button"
              onClick={() => handleSwitch(church.churchId)}
              className="block w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-600"
            >
              {church.churchName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChurchSwitcher;
```

- [ ] **Step 4: Run to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec client npx vitest run src/components/ChurchSwitcher.test.tsx`
Expected: `Tests  3 passed (3)`.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ChurchSwitcher.tsx client/src/components/ChurchSwitcher.test.tsx
git commit -m "feat(auth): add ChurchSwitcher component"
```

---

## Task 9: Wire `ChurchSwitcher` into `Layout.tsx`

**Files:**
- Modify: `client/src/components/Layout.tsx`

- [ ] **Step 1: Import the component**

Find:

```tsx
import { aiAPI, gatheringsAPI, notificationsAPI } from '../services/api';
```

Add right after:

```tsx
import { aiAPI, gatheringsAPI, notificationsAPI } from '../services/api';
import ChurchSwitcher from './ChurchSwitcher';
```

- [ ] **Step 2: Add it to the mobile sidebar's profile block**

Find:

```tsx
            {/* User Profile Section */}
            <div className="px-4 py-3 border-b border-primary-400 dark:border-gray-700">
              <div className="flex items-center">
                <UserCircleIcon className="h-10 w-10 text-white" />
                <div className="ml-3">
                  <p className="text-sm font-medium text-white">{user?.firstName} {user?.lastName}</p>
                  <p className="text-xs text-primary-200 capitalize">{user?.role?.replace('_', ' ')}</p>
                </div>
              </div>
            </div>
```

Replace with:

```tsx
            {/* User Profile Section */}
            <div className="px-4 py-3 border-b border-primary-400 dark:border-gray-700">
              <div className="flex items-center">
                <UserCircleIcon className="h-10 w-10 text-white" />
                <div className="ml-3">
                  <p className="text-sm font-medium text-white">{user?.firstName} {user?.lastName}</p>
                  <p className="text-xs text-primary-200 capitalize">{user?.role?.replace('_', ' ')}</p>
                  <ChurchSwitcher textClassName="text-xs text-primary-200 mt-0.5" />
                </div>
              </div>
            </div>
```

- [ ] **Step 3: Add it above the desktop sidebar's logout button**

Find:

```tsx
              {/* Actions - Desktop */}
              <div className="px-2 space-y-1 mt-2 hidden lg:block">
                <button
                  onClick={handleLogout}
                  className="w-full text-white hover:bg-primary-600 dark:hover:bg-gray-700 hover:text-white group flex items-center px-2 py-2 text-sm font-medium rounded-md transition-colors duration-200"
                >
                  <ArrowRightOnRectangleIcon className="mr-3 h-6 w-6" />
                  Logout
                </button>
              </div>
```

Replace with:

```tsx
              {/* Actions - Desktop */}
              <div className="px-2 space-y-1 mt-2 hidden lg:block">
                <div className="px-2 pb-2">
                  <ChurchSwitcher textClassName="text-xs text-primary-100" />
                </div>
                <button
                  onClick={handleLogout}
                  className="w-full text-white hover:bg-primary-600 dark:hover:bg-gray-700 hover:text-white group flex items-center px-2 py-2 text-sm font-medium rounded-md transition-colors duration-200"
                >
                  <ArrowRightOnRectangleIcon className="mr-3 h-6 w-6" />
                  Logout
                </button>
              </div>
```

- [ ] **Step 4: Verify it compiles**

```bash
docker-compose -f docker-compose.dev.yml logs --tail 20 client
```
Expected: no new TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Layout.tsx
git commit -m "feat(auth): show ChurchSwitcher above logout in both sidebars"
```

---

## Task 10: Admin panel — surface `person_id`

**Files:**
- Modify: `server/admin/index.js`

- [ ] **Step 1: Add `person_id` to `GET /api/users`**

Find (inside the `for (const church of churches)` loop):

```js
      const users = await Database.queryForChurch(cid, `
        SELECT
          u.id,
          u.church_id,
          u.email,
          u.mobile_number,
          u.role,
          u.first_name,
          u.last_name,
          u.is_active,
          u.last_login_at,
          u.created_at
        FROM users u
        ${whereClause}
        ORDER BY u.created_at DESC
      `, params);
      allUsers.push(...users);
```

Replace with:

```js
      const users = await Database.queryForChurch(cid, `
        SELECT
          u.id,
          u.church_id,
          u.email,
          u.mobile_number,
          u.role,
          u.first_name,
          u.last_name,
          u.is_active,
          u.last_login_at,
          u.created_at
        FROM users u
        ${whereClause}
        ORDER BY u.created_at DESC
      `, params);

      const registryDb = Database.getRegistryDb();
      const personIdRows = registryDb.prepare(
        'SELECT user_id, person_id FROM user_lookup WHERE church_id = ?'
      ).all(cid);
      const personIdByUserId = new Map(personIdRows.map(r => [r.user_id, r.person_id]));
      for (const u of users) {
        u.person_id = personIdByUserId.get(u.id) || null;
      }

      allUsers.push(...users);
```

- [ ] **Step 2: Add `person_id` to `GET /api/users/:userId`**

Find:

```js
    for (const church of churches) {
      const cid = church.church_id;
      const user = await Database.queryForChurch(cid, 'SELECT * FROM users WHERE id = ?', [userId]);
      if (user.length) {
        foundUser = user[0];
        recentActivity = await Database.queryForChurch(cid, `
          SELECT action, entity_type, created_at
          FROM audit_log
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 20
        `, [userId]);
        break;
      }
    }
```

Replace with:

```js
    for (const church of churches) {
      const cid = church.church_id;
      const user = await Database.queryForChurch(cid, 'SELECT * FROM users WHERE id = ?', [userId]);
      if (user.length) {
        foundUser = user[0];
        const lookupRow = Database.getRegistryDb().prepare(
          'SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?'
        ).get(userId, cid);
        foundUser.person_id = lookupRow ? lookupRow.person_id : null;
        recentActivity = await Database.queryForChurch(cid, `
          SELECT action, entity_type, created_at
          FROM audit_log
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 20
        `, [userId]);
        break;
      }
    }
```

- [ ] **Step 3: Verify no regressions**

```bash
docker-compose -f docker-compose.dev.yml restart admin
sleep 3
curl -s "http://localhost:7777/api/users?limit=5" | python3 -m json.tool | grep -A1 person_id
```
Expected: `"person_id": null` present on each returned user (proves the join works without crashing).

- [ ] **Step 4: Commit**

```bash
git add server/admin/index.js
git commit -m "feat(admin): surface person_id on user list/detail endpoints"
```

---

## Task 11: Admin panel — link/unlink endpoints

**Files:**
- Modify: `server/admin/index.js`

- [ ] **Step 1: Add the link and unlink routes**

In `server/admin/index.js`, add these two routes right after the `GET /api/users/:userId` route:

```js
app.post('/api/users/:churchId/:userId/link', async (req, res) => {
  try {
    const { churchId, userId } = req.params;
    const { targetChurchId, targetUserId } = req.body;
    if (!targetChurchId || !targetUserId) {
      return res.status(400).json({ error: 'targetChurchId and targetUserId are required' });
    }
    if (churchId === targetChurchId && Number(userId) === Number(targetUserId)) {
      return res.status(400).json({ error: 'Cannot link a user to themselves' });
    }

    const sourceExists = await Database.queryForChurch(churchId, 'SELECT id FROM users WHERE id = ?', [userId]);
    const targetExists = await Database.queryForChurch(targetChurchId, 'SELECT id FROM users WHERE id = ?', [targetUserId]);
    if (sourceExists.length === 0 || targetExists.length === 0) {
      return res.status(404).json({ error: 'One or both users not found' });
    }

    const personId = Database.linkUserLookups(churchId, Number(userId), targetChurchId, Number(targetUserId));
    res.json({ message: 'Users linked successfully', personId });
  } catch (error) {
    console.error('Link users error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users/:churchId/:userId/unlink', async (req, res) => {
  try {
    const { churchId, userId } = req.params;
    Database.unlinkUserLookup(churchId, Number(userId));
    res.json({ message: 'User unlinked successfully' });
  } catch (error) {
    console.error('Unlink user error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 2: Verify with curl against two real users in the dev environment**

```bash
docker-compose -f docker-compose.dev.yml restart admin
sleep 3
curl -s "http://localhost:7777/api/users?search=matthews" | python3 -m json.tool
```
Note the `id` and `church_id` of the two Dave Matthews rows returned (from `kin_...` and `crc_...`), then:

```bash
curl -s -X POST "http://localhost:7777/api/users/<crc_church_id>/<crc_user_id>/link" \
  -H "Content-Type: application/json" \
  -d '{"targetChurchId": "<kin_church_id>", "targetUserId": <kin_user_id>}' | python3 -m json.tool
```
Expected: `{"message": "Users linked successfully", "personId": "<some-uuid>"}`. Since these two rows already match by email, this link is redundant with the automatic match but is a safe, realistic way to prove the endpoint works end-to-end. Confirm the personId appears in the list:

```bash
curl -s "http://localhost:7777/api/users?search=matthews" | python3 -m json.tool | grep person_id
```
Expected: the same `personId` value on both rows. Then unlink one of them to restore original state:

```bash
curl -s -X POST "http://localhost:7777/api/users/<crc_church_id>/<crc_user_id>/unlink" | python3 -m json.tool
```
Expected: `{"message": "User unlinked successfully"}`.

- [ ] **Step 3: Commit**

```bash
git add server/admin/index.js
git commit -m "feat(admin): add link/unlink endpoints for manual account linking"
```

---

## Task 12: Admin panel UI — linked badge and link/unlink actions

**Files:**
- Modify: `server/admin/public/index.html`

- [ ] **Step 1: Add a "Linked" column to the all-users table**

Find the table header in `loadAllUsers`:

```html
              <tr>
                <th>ID</th>
                <th>User</th>
                <th>Church</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last Login</th>
                <th>Actions</th>
              </tr>
```

Replace with:

```html
              <tr>
                <th>ID</th>
                <th>User</th>
                <th>Church</th>
                <th>Role</th>
                <th>Status</th>
                <th>Linked</th>
                <th>Created</th>
                <th>Last Login</th>
                <th>Actions</th>
              </tr>
```

- [ ] **Step 2: Add the linked-status cell and update the actions cell**

Find:

```html
                  <td class="${u.is_active ? 'status-active' : 'status-inactive'}">${u.is_active ? 'Active' : 'Inactive'}</td>
                  <td class="timestamp">${formatDate(u.created_at)}</td>
                  <td class="timestamp">${formatRelative(u.last_login_at)}</td>
                  <td class="actions">
                    ${u.is_active 
                      ? `<button class="action-btn danger" onclick="deleteUser(${u.id}, '${(u.email || '').replace(/'/g, "\\'")}', false)" title="Deactivate">🚫</button>`
                      : `<button class="action-btn success" onclick="reactivateUser(${u.id}, '${(u.email || '').replace(/'/g, "\\'")}')" title="Reactivate">✓</button>`
                    }
                    <button class="action-btn danger" onclick="deleteUser(${u.id}, '${(u.email || '').replace(/'/g, "\\'")}', true)" title="Delete Permanently">🗑</button>
                  </td>
```

Replace with:

```html
                  <td class="${u.is_active ? 'status-active' : 'status-inactive'}">${u.is_active ? 'Active' : 'Inactive'}</td>
                  <td>
                    ${u.person_id
                      ? `<button class="action-btn" onclick="unlinkUser('${u.church_id}', ${u.id})" title="Unlink">🔗 Unlink</button>`
                      : `<button class="action-btn" onclick="openLinkModal('${u.church_id}', ${u.id}, '${(u.first_name || '').replace(/'/g, "\\'")} ${(u.last_name || '').replace(/'/g, "\\'")}')" title="Link to another account">Link</button>`
                    }
                  </td>
                  <td class="timestamp">${formatDate(u.created_at)}</td>
                  <td class="timestamp">${formatRelative(u.last_login_at)}</td>
                  <td class="actions">
                    ${u.is_active 
                      ? `<button class="action-btn danger" onclick="deleteUser(${u.id}, '${(u.email || '').replace(/'/g, "\\'")}', false)" title="Deactivate">🚫</button>`
                      : `<button class="action-btn success" onclick="reactivateUser(${u.id}, '${(u.email || '').replace(/'/g, "\\'")}')" title="Reactivate">✓</button>`
                    }
                    <button class="action-btn danger" onclick="deleteUser(${u.id}, '${(u.email || '').replace(/'/g, "\\'")}', true)" title="Delete Permanently">🗑</button>
                  </td>
```

- [ ] **Step 3: Add the link/unlink JavaScript functions**

Find the `reactivateUser` function:

```js
    // Reactivate user
    async function reactivateUser(userId, email) {
      if (!confirm(`Reactivate user ${email}?`)) return;

      try {
        const res = await fetch(`/api/users/${userId}/reactivate`, {
          method: 'POST'
        });

        const data = await res.json();
        if (res.ok) {
          alert(data.message);
          loadAllUsers(usersPage);
          loadActiveUsers();
          loadStats();
        } else {
          alert('Error: ' + data.error);
        }
      } catch (err) {
        alert('Failed to reactivate user: ' + err.message);
      }
    }
```

Add right after it:

```js
    // Unlink a user from their linked-person group
    async function unlinkUser(churchId, userId) {
      if (!confirm('Unlink this account from its linked person group?')) return;

      try {
        const res = await fetch(`/api/users/${churchId}/${userId}/unlink`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          alert(data.message);
          loadAllUsers(usersPage, document.getElementById('user-search').value);
        } else {
          alert('Error: ' + data.error);
        }
      } catch (err) {
        alert('Failed to unlink user: ' + err.message);
      }
    }

    let linkModalSource = null;

    // Open the "link to another account" modal
    function openLinkModal(churchId, userId, name) {
      linkModalSource = { churchId, userId };
      const modalHtml = `
        <div class="modal-overlay" onclick="if(event.target === this) closeModal()">
          <div class="modal">
            <div class="modal-header">
              <h3>Link ${name} to another account</h3>
              <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <div class="modal-body">
              <input type="text" class="search-box" id="link-search" style="width: 100%; margin-bottom: 1rem;" placeholder="Search by name or email..." oninput="searchLinkCandidates()">
              <div id="link-search-results"></div>
            </div>
          </div>
        </div>
      `;
      document.body.insertAdjacentHTML('beforeend', modalHtml);
    }

    let linkSearchTimeout;
    function searchLinkCandidates() {
      clearTimeout(linkSearchTimeout);
      linkSearchTimeout = setTimeout(async () => {
        const query = document.getElementById('link-search').value;
        if (!query) {
          document.getElementById('link-search-results').innerHTML = '';
          return;
        }
        try {
          const data = await fetchJSON(`/api/users?search=${encodeURIComponent(query)}&limit=10`);
          const candidates = data.users.filter(u => !(u.church_id === linkModalSource.churchId && u.id === linkModalSource.userId));
          const html = candidates.length ? candidates.map(u => `
            <div class="user-item">
              <div class="user-item-info">
                <div>
                  <div>${u.first_name || ''} ${u.last_name || ''}</div>
                  <div class="timestamp">${u.email || u.mobile_number || '-'} &middot; <code>${u.church_id}</code></div>
                </div>
              </div>
              <div class="user-item-actions">
                <button class="transfer-btn" onclick="confirmLink('${u.church_id}', ${u.id}, '${(u.first_name || '').replace(/'/g, "\\'")} ${(u.last_name || '').replace(/'/g, "\\'")}')">Link</button>
              </div>
            </div>
          `).join('') : '<div class="empty-state">No matches</div>';
          document.getElementById('link-search-results').innerHTML = html;
        } catch (err) {
          document.getElementById('link-search-results').innerHTML = `<div class="empty-state">Search failed: ${err.message}</div>`;
        }
      }, 300);
    }

    async function confirmLink(targetChurchId, targetUserId, targetName) {
      if (!confirm(`Link this account to ${targetName}?`)) return;
      try {
        const res = await fetch(`/api/users/${linkModalSource.churchId}/${linkModalSource.userId}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetChurchId, targetUserId })
        });
        const data = await res.json();
        if (res.ok) {
          alert(data.message);
          closeModal();
          loadAllUsers(usersPage, document.getElementById('user-search').value);
        } else {
          alert('Error: ' + data.error);
        }
      } catch (err) {
        alert('Failed to link users: ' + err.message);
      }
    }
```

- [ ] **Step 4: Verify in the browser**

Navigate to `http://localhost:7777`, go to the Users view, search for a known user, and confirm:
- The "Linked" column shows a "Link" button for unlinked users.
- Clicking "Link" opens the modal, typing in the search box shows other users, clicking "Link" next to one links them and the row now shows "🔗 Unlink".
- Clicking "🔗 Unlink" removes the link.

- [ ] **Step 5: Commit**

```bash
git add server/admin/public/index.html
git commit -m "feat(admin): add linked badge and link/unlink UI to user list"
```

---

## Task 13: End-to-end verification and full test suite

**Files:** none (verification only)

- [ ] **Step 1: Run the full server test suite**

```bash
docker-compose -f docker-compose.dev.yml exec server node --test
```
Expected: all tests pass except the pre-existing, unrelated `test-edit-functionality.js` failure (predates this feature).

- [ ] **Step 2: Run the full client test suite**

```bash
docker-compose -f docker-compose.dev.yml exec client npx vitest run
```
Expected: all tests pass, including the 3 new `ChurchSwitcher` tests.

- [ ] **Step 3: Manually verify the switcher in the browser using a real multi-church account**

Using the browser tooling against `http://localhost` (nginx), log in as a user known to have two linked churches (e.g. one of the two Dave Matthews accounts used in Task 11's verification, whose email is shared across `kin_...` and `crc_...`), and confirm:
- The sidebar shows the current church's name above the logout button (mobile: open the hamburger menu; desktop: visible directly).
- Clicking the church name opens a dropdown listing the other linked church.
- Clicking that other church switches: the page navigates to `/dashboard`, and the sidebar now shows the new church's name.
- Log in as a single-church user and confirm the church name renders as plain text with no dropdown affordance.

- [ ] **Step 4: Final commit (if any cleanup was needed)**

```bash
git status
```
If anything is uncommitted, stage and commit it; otherwise this task is verification-only and needs no commit.
