const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('./database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

test('resyncUserLookup: refreshes a stale registry row after mobile_number is updated directly', async () => {
  await withTestChurchDb(async (churchId) => {
    const insert = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id) VALUES (?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['dave@example.com', churchId]
    );
    const userId = insert.insertId;

    // Simulate account creation: registry gets registered with no mobile yet.
    Database.registerUserLookup(userId, 'dave@example.com', null, churchId);

    // Simulate PUT /me or PUT /:id updating the user's mobile directly,
    // the way the buggy route handlers did before this fix.
    await Database.query('UPDATE users SET mobile_number = ? WHERE id = ?', ['+61411202186', userId]);

    // Reproduces the reported bug: registry is now stale, so mobile-based
    // lookup can't find this church even though the user row has the number.
    assert.strictEqual(Database.lookupChurchByMobile('+61411202186'), null);

    Database.resyncUserLookup(userId);

    const found = Database.lookupChurchByMobile('+61411202186');
    assert.ok(found, 'lookup should find the church after resync');
    assert.strictEqual(found.church_id, churchId);
    assert.strictEqual(found.user_id, userId);
  });
});

test('resyncUserLookup: refreshes a stale registry row after email is updated directly', async () => {
  await withTestChurchDb(async (churchId) => {
    const insert = await Database.query(
      `INSERT INTO users (email, mobile_number, role, first_name, last_name, is_active, church_id) VALUES (?, ?, 'admin', 'Dave', 'Matthews', 1, ?)`,
      ['old@example.com', '+61411202186', churchId]
    );
    const userId = insert.insertId;
    Database.registerUserLookup(userId, 'old@example.com', '+61411202186', churchId);

    await Database.query('UPDATE users SET email = ? WHERE id = ?', ['new@example.com', userId]);

    assert.strictEqual(Database.lookupChurchByEmail('new@example.com'), null);

    Database.resyncUserLookup(userId);

    const found = Database.lookupChurchByEmail('new@example.com');
    assert.ok(found, 'lookup should find the church after resync');
    assert.strictEqual(found.church_id, churchId);
  });
});

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

    const result = Database.unlinkUserLookup(churchIdA, 1);

    assert.strictEqual(result, true, 'should return true when a row is actually unlinked');
    const rowA = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(1, churchIdA);
    const rowB = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(2, churchIdB);
    assert.strictEqual(rowA.person_id, null);
    assert.ok(rowB.person_id, 'the other group member should keep its person_id');
  });
});

test('unlinkUserLookup: returns false when no matching row exists', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const result = Database.unlinkUserLookup(churchIdA, 9999);

    assert.strictEqual(result, false, 'should return false when no user_lookup row matches');
  });
});

test('linkUserLookups: is a safe no-op when both rows already share the same person_id', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = makeChurchId('linktest');
    Database.ensureChurch(churchIdB, 'Church B');
    Database.registerUserLookup(1, 'a@example.com', null, churchIdA);
    Database.registerUserLookup(2, 'b@example.com', null, churchIdB);
    Database.getRegistryDb().prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?').run('already-shared', 1, churchIdA);
    Database.getRegistryDb().prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?').run('already-shared', 2, churchIdB);

    const personId = Database.linkUserLookups(churchIdA, 1, churchIdB, 2);

    assert.strictEqual(personId, 'already-shared');
    const rowA = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(1, churchIdA);
    const rowB = Database.getRegistryDb().prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?').get(2, churchIdB);
    assert.strictEqual(rowA.person_id, 'already-shared');
    assert.strictEqual(rowB.person_id, 'already-shared');
  });
});

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

test('registerUserLookup: preserves an existing person_id when re-registering the same row (e.g. on next login)', async () => {
  await withTestChurchDb(async (churchIdA) => {
    const churchIdB = `preservetest_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    Database.ensureChurch(churchIdB, 'Church B');
    Database.registerUserLookup(1, 'a@example.com', null, churchIdA);
    Database.registerUserLookup(2, 'b@example.com', null, churchIdB);
    Database.linkUserLookups(churchIdA, 1, churchIdB, 2);

    const linkedPersonId = Database.getRegistryDb()
      .prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?')
      .get(1, churchIdA).person_id;
    assert.ok(linkedPersonId, 'sanity check: link should have been created');

    // Simulate the linked user logging in again (auth.js calls registerUserLookup
    // on every successful login) or updating their profile (resyncUserLookup).
    Database.registerUserLookup(1, 'a@example.com', null, churchIdA);

    const rowAfterReLogin = Database.getRegistryDb()
      .prepare('SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?')
      .get(1, churchIdA);
    assert.strictEqual(rowAfterReLogin.person_id, linkedPersonId, 'person_id must survive re-registration, not silently reset to null');
  });
});
