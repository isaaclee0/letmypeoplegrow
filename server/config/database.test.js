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
