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
