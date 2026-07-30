const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const BetterSqlite3 = require('better-sqlite3');
const Database = require('./database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { upsertConnection } = require('../services/peopleSync/connectionStore');
const { INTEGRATION_CREDENTIALS_KEY_INVALID } = require('../services/peopleSync/credentialCipher');

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

test('getChurchDb migrates an existing PCO database to generic provenance and backfills it once', async () => {
  // Catches an upgrade that creates neutral tables for new churches but leaves
  // existing PCO roster ownership, scheduled authority, or links unavailable
  // after restart, and catches non-idempotent backfills on a second startup.
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    const familyId = Number(db.prepare(
      'INSERT INTO families (family_name, church_id, planning_center_id) VALUES (?, ?, ?)'
    ).run('Migrated Household', churchId, 'legacy-family').lastInsertRowid);
    const individualId = Number(db.prepare(
      'INSERT INTO individuals (first_name, last_name, church_id, family_id, planning_center_id) VALUES (?, ?, ?, ?, ?)'
    ).run('Migrated', 'Person', churchId, familyId, 'legacy-person').lastInsertRowid);
    const gatheringId = Number(db.prepare(
      'INSERT INTO gathering_types (name, church_id) VALUES (?, ?)'
    ).run('Migrated Gathering', churchId).lastInsertRowid);
    const legacyBatchId = Number(db.prepare(
      `INSERT INTO planning_center_sync_batches
        (church_id, name, membership_allowlist, field_filters, schedule_enabled, schedule_frequency, schedule_day)
       VALUES (?, ?, '[]', '[]', 1, 'monthly', 4)`
    ).run(churchId, 'Migrated Batch').lastInsertRowid);

    // This fixture represents a database created before the one-time
    // scheduled-PCO authority migration existed.
    db.exec('DELETE FROM migrations');

    Database.closeAll();
    const dbPath = path.join(process.env.CHURCH_DATA_DIR, 'churches', `${churchId}.sqlite`);
    const legacyDb = new BetterSqlite3(dbPath);
    legacyDb.pragma('foreign_keys = OFF');
    legacyDb.exec(`
      DROP TRIGGER IF EXISTS ensure_people_sync_settings;
      DROP TABLE gathering_lists;
      DROP TABLE people_sync_runs;
      DROP TABLE people_sync_batches;
      DROP TABLE external_person_links;
      DROP TABLE external_family_links;
      DROP TABLE integration_connections;
      DROP TABLE people_sync_settings;
      CREATE TABLE gathering_lists (
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
      CREATE TABLE people_sync_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        filter_schema_version INTEGER NOT NULL DEFAULT 1,
        filter_config TEXT NOT NULL DEFAULT '{}',
        default_people_type TEXT NOT NULL DEFAULT 'regular',
        gathering_type_id INTEGER,
        gathering_auto_remove_enabled INTEGER NOT NULL DEFAULT 0,
        schedule_enabled INTEGER NOT NULL DEFAULT 0,
        schedule_frequency TEXT NOT NULL DEFAULT 'weekly',
        schedule_day INTEGER NOT NULL DEFAULT 1,
        legacy_provider_batch_id INTEGER,
        last_external_watermark TEXT,
        last_sync_at TEXT,
        last_sync_result TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(church_id, provider, legacy_provider_batch_id)
      );
    `);
    legacyDb.prepare(
      'INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id, added_by_pco_batch_id) VALUES (?, ?, ?, ?)'
    ).run(gatheringId, individualId, churchId, legacyBatchId);
    legacyDb.prepare(
      `INSERT INTO people_sync_batches
        (church_id, provider, name, filter_schema_version, filter_config, schedule_enabled, schedule_frequency, schedule_day)
       VALUES (?, 'elvanto', 'Existing v1 Batch', 1, ?, 1, 'monthly', 5)`
    ).run(churchId, JSON.stringify({ groups: ['existing'] }));
    legacyDb.close();

    Database.initialize();
    const firstStartup = Database.getChurchDb(churchId);
    const firstGenericBatch = firstStartup.prepare(
      'SELECT id FROM people_sync_batches WHERE church_id = ? AND provider = ? AND legacy_provider_batch_id = ?'
    ).get(churchId, 'planning_center', legacyBatchId);

    assert.ok(firstGenericBatch, 'legacy PCO batch should be represented by one generic batch');
    firstStartup.prepare(
      `UPDATE people_sync_batches
       SET enabled = 1, schedule_enabled = 1
       WHERE id = ?`
    ).run(firstGenericBatch.id);

    Database.closeAll();
    Database.initialize();
    const migrated = Database.getChurchDb(churchId);
    const genericBatches = migrated.prepare(
      'SELECT id, enabled, schedule_enabled, schedule_frequency, schedule_day FROM people_sync_batches WHERE church_id = ? AND provider = ? AND legacy_provider_batch_id = ?'
    ).all(churchId, 'planning_center', legacyBatchId);
    const existingV1Batch = migrated.prepare(
      `SELECT filter_schema_version, filter_config, filter_revision, schedule_enabled, schedule_frequency, schedule_day,
        draft_filter_schema_version, draft_filter_config, draft_filter_base_revision, draft_filter_updated_at
       FROM people_sync_batches WHERE church_id = ? AND provider = 'elvanto' AND name = 'Existing v1 Batch'`
    ).get(churchId);
    const migratedBatchColumns = new Map(migrated.prepare('PRAGMA table_info(people_sync_batches)').all()
      .map((column) => [column.name, column]));
    const roster = migrated.prepare('SELECT added_by_sync_batch_id FROM gathering_lists WHERE church_id = ?').get(churchId);

    assert.strictEqual(genericBatches.length, 1, 'restart must not duplicate the generic batch');
    assert.strictEqual(genericBatches[0].id, firstGenericBatch.id, 'restart must preserve the generic batch identity');
    assert.deepStrictEqual(genericBatches.map(({ enabled, schedule_enabled }) => ({ enabled, schedule_enabled })), [
      { enabled: 0, schedule_enabled: 0 },
    ]);
    assert.strictEqual(genericBatches[0].schedule_frequency, 'monthly');
    assert.strictEqual(genericBatches[0].schedule_day, 4);
    assert.equal(migratedBatchColumns.get('filter_revision').dflt_value, '1');
    assert.deepStrictEqual(existingV1Batch, {
      filter_schema_version: 1,
      filter_config: JSON.stringify({ groups: ['existing'] }),
      filter_revision: 1,
      schedule_enabled: 1,
      schedule_frequency: 'monthly',
      schedule_day: 5,
      draft_filter_schema_version: null,
      draft_filter_config: null,
      draft_filter_base_revision: null,
      draft_filter_updated_at: null,
    });
    assert.strictEqual(roster.added_by_sync_batch_id, genericBatches[0].id);
    assert.strictEqual(migrated.prepare('SELECT COUNT(*) AS count FROM external_person_links WHERE church_id = ?').get(churchId).count, 1);
    assert.strictEqual(migrated.prepare('SELECT COUNT(*) AS count FROM external_family_links WHERE church_id = ?').get(churchId).count, 1);
    assert.strictEqual(migrated.prepare('SELECT COUNT(*) AS count FROM people_sync_settings WHERE church_id = ?').get(churchId).count, 1);
    assert.deepStrictEqual(
      migrated.prepare('SELECT authority_provider, pending_authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId),
      { authority_provider: 'planning_center', pending_authority_provider: null }
    );
    assert.strictEqual(migrated.prepare('SELECT COUNT(*) AS count FROM planning_center_sync_batches WHERE church_id = ?').get(churchId).count, 1);
    assert.deepStrictEqual(
      migrated.prepare('SELECT planning_center_id FROM individuals WHERE id = ?').get(individualId),
      { planning_center_id: 'legacy-person' },
      'legacy person IDs must remain available for compatibility'
    );
    assert.deepStrictEqual(
      migrated.prepare('SELECT planning_center_id FROM families WHERE id = ?').get(familyId),
      { planning_center_id: 'legacy-family' },
      'legacy family IDs must remain available for compatibility'
    );
    assert.deepStrictEqual(migrated.prepare('PRAGMA foreign_key_check').all(), [], 'generic provenance must have valid foreign keys');
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'planning_center_sync_batches'").get(), 'legacy PCO batch table must remain');
  });
});

test('Elvanto batch names align to their active or initial-review source during restart migration', async () => {
  // Catches a startup alignment that either retains stale custom names or lets
  // a replacement draft override an existing active Elvanto source.
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    const active = db.prepare(`INSERT INTO people_sync_batches
      (church_id, provider, name, enabled, source_kind, source_external_id, source_name,
       draft_source_kind, draft_source_external_id, draft_source_name, schedule_enabled)
      VALUES (?, 'elvanto', 'Custom active', 1, 'elvanto_group', 'members', 'Members',
              'elvanto_group', 'youth', 'Youth', 1)`).run(churchId);
    const initial = db.prepare(`INSERT INTO people_sync_batches
      (church_id, provider, name, enabled, draft_source_kind, draft_source_external_id, draft_source_name)
      VALUES (?, 'elvanto', 'Custom initial', 0, 'elvanto_category', 'regulars', 'Regulars')`).run(churchId);
    const sourceLess = db.prepare(`INSERT INTO people_sync_batches
      (church_id, provider, name, enabled)
      VALUES (?, 'elvanto', 'Unresolved', 0)`).run(churchId);

    const batchIds = [Number(active.lastInsertRowid), Number(initial.lastInsertRowid), Number(sourceLess.lastInsertRowid)];
    const selectBatches = (database) => database.prepare(`SELECT id, name, enabled, schedule_enabled,
      source_kind, source_external_id, source_name,
      draft_source_kind, draft_source_external_id, draft_source_name
      FROM people_sync_batches WHERE id IN (?, ?, ?) ORDER BY id`).all(...batchIds);
    const expectedBatches = [
      {
        id: batchIds[0], name: 'Members', enabled: 1, schedule_enabled: 1,
        source_kind: 'elvanto_group', source_external_id: 'members', source_name: 'Members',
        draft_source_kind: 'elvanto_group', draft_source_external_id: 'youth', draft_source_name: 'Youth',
      },
      {
        id: batchIds[1], name: 'Regulars', enabled: 0, schedule_enabled: 0,
        source_kind: null, source_external_id: null, source_name: null,
        draft_source_kind: 'elvanto_category', draft_source_external_id: 'regulars', draft_source_name: 'Regulars',
      },
      {
        id: batchIds[2], name: 'Unresolved', enabled: 0, schedule_enabled: 0,
        source_kind: null, source_external_id: null, source_name: null,
        draft_source_kind: null, draft_source_external_id: null, draft_source_name: null,
      },
    ];

    Database.closeAll();
    Database.initialize();
    const firstStartup = Database.getChurchDb(churchId);
    assert.deepStrictEqual(selectBatches(firstStartup), expectedBatches);

    Database.closeAll();
    Database.initialize();
    const secondStartup = Database.getChurchDb(churchId);
    assert.deepStrictEqual(selectBatches(secondStartup), expectedBatches);
  });
});

test('getChurchDb migrates an existing generic scheduled PCO batch once without undoing a later explicit disable', async () => {
  // Catches migration inference that either ignores already-generic scheduled
  // batches or runs on every restart and silently defeats reviewed authority
  // disablement.
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    db.prepare(
      `INSERT INTO people_sync_batches
        (church_id, provider, name, enabled, schedule_enabled)
       VALUES (?, 'planning_center', 'Existing Generic PCO Schedule', 1, 1)`
    ).run(churchId);
    db.exec('DELETE FROM migrations');

    Database.closeAll();
    Database.initialize();
    const firstStartup = Database.getChurchDb(churchId);
    assert.strictEqual(
      firstStartup.prepare('SELECT authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId).authority_provider,
      'planning_center'
    );

    // Simulate a later reviewed/explicit disable. The one-time migration must
    // not reinterpret the still-scheduled batch on the next restart.
    firstStartup.prepare(
      "UPDATE people_sync_settings SET authority_provider = 'none', pending_authority_provider = NULL WHERE church_id = ?"
    ).run(churchId);
    Database.closeAll();
    Database.initialize();
    const secondStartup = Database.getChurchDb(churchId);

    assert.strictEqual(
      secondStartup.prepare('SELECT authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId).authority_provider,
      'none'
    );
    assert.strictEqual(secondStartup.prepare('SELECT COUNT(*) AS count FROM people_sync_settings WHERE church_id = ?').get(churchId).count, 1);
    assert.strictEqual(secondStartup.prepare('SELECT COUNT(*) AS count FROM people_sync_batches WHERE church_id = ?').get(churchId).count, 1);
  });
});

for (const recoverableStatus of ['pending', 'failed']) {
  test(`getChurchDb recovers a ${recoverableStatus} scheduled PCO authority marker without re-promoting after an explicit disable`, async () => {
    // Catches INSERT OR IGNORE leaving an interrupted/failed marker unchanged.
    // Such a marker made every restart look like a first migration and silently
    // undid a later reviewed authority disable.
    await withTestChurchDb(async (churchId) => {
      const db = Database.getChurchDb(churchId);
      db.prepare(
        `INSERT INTO people_sync_batches
          (church_id, provider, name, enabled, schedule_enabled)
         VALUES (?, 'planning_center', 'Recoverable PCO Schedule', 1, 1)`
      ).run(churchId);
      db.prepare(
        `UPDATE migrations
         SET status = ?, error_message = 'previous migration interruption'
         WHERE version = 'v2.2.0_scheduled_pco_authority'`
      ).run(recoverableStatus);

      Database.closeAll();
      Database.initialize();
      const recovered = Database.getChurchDb(churchId);

      assert.strictEqual(
        recovered.prepare('SELECT authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId).authority_provider,
        'planning_center'
      );
      assert.deepStrictEqual(
        recovered.prepare(
          "SELECT status, error_message FROM migrations WHERE version = 'v2.2.0_scheduled_pco_authority'"
        ).get(),
        { status: 'success', error_message: null },
        `${recoverableStatus} marker should be completed rather than ignored`
      );

      recovered.prepare(
        "UPDATE people_sync_settings SET authority_provider = 'none', pending_authority_provider = NULL WHERE church_id = ?"
      ).run(churchId);
      Database.closeAll();
      Database.initialize();
      const restarted = Database.getChurchDb(churchId);

      assert.strictEqual(
        restarted.prepare('SELECT authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId).authority_provider,
        'none',
        'a completed recovery must not reinterpret the scheduled batch on restart'
      );
    });
  });
}

test('scheduled PCO authority migration rolls back its promotion when marker completion fails and can be retried', async () => {
  // Catches a crash/error between authority promotion and marker completion.
  // Retrying must see either both changes or neither change.
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    db.prepare(
      `INSERT INTO people_sync_batches
        (church_id, provider, name, enabled, schedule_enabled)
       VALUES (?, 'planning_center', 'Atomic PCO Schedule', 1, 1)`
    ).run(churchId);
    db.prepare(
      `UPDATE migrations
       SET status = 'failed', error_message = 'ready for retry'
       WHERE version = 'v2.2.0_scheduled_pco_authority'`
    ).run();
    db.exec(`CREATE TRIGGER fail_scheduled_pco_marker_completion
      BEFORE UPDATE OF status ON migrations
      WHEN OLD.version = 'v2.2.0_scheduled_pco_authority' AND NEW.status = 'success'
      BEGIN
        SELECT RAISE(ABORT, 'simulated marker completion failure');
      END`);

    assert.throws(
      () => Database.backfillProviderNeutralSync(db, churchId),
      /simulated marker completion failure/
    );
    assert.strictEqual(
      db.prepare('SELECT authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId).authority_provider,
      'none',
      'promotion must roll back with the failed marker completion'
    );
    assert.strictEqual(
      db.prepare("SELECT status FROM migrations WHERE version = 'v2.2.0_scheduled_pco_authority'").get().status,
      'failed'
    );

    db.exec('DROP TRIGGER fail_scheduled_pco_marker_completion');
    Database.backfillProviderNeutralSync(db, churchId);
    assert.deepStrictEqual(
      db.prepare(
        "SELECT status, error_message FROM migrations WHERE version = 'v2.2.0_scheduled_pco_authority'"
      ).get(),
      { status: 'success', error_message: null }
    );
    assert.strictEqual(
      db.prepare('SELECT authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId).authority_provider,
      'planning_center'
    );

    db.prepare(
      "UPDATE people_sync_settings SET authority_provider = 'none', pending_authority_provider = NULL WHERE church_id = ?"
    ).run(churchId);
    Database.backfillProviderNeutralSync(db, churchId);
    assert.strictEqual(
      db.prepare('SELECT authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId).authority_provider,
      'none',
      'a successful retry marker must preserve a later explicit disable'
    );
  });
});

test('a fresh church scheduled for PCO later remains unowned after restart until authority is explicitly reviewed', async () => {
  // Fresh databases are pre-marked because they never ran the legacy PCO
  // authority flow. A later schedule must not be mistaken for upgrade state.
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    assert.deepStrictEqual(
      db.prepare(
        "SELECT status FROM migrations WHERE version = 'v2.2.0_scheduled_pco_authority'"
      ).get(),
      { status: 'success' }
    );
    db.prepare(
      `INSERT INTO people_sync_batches
        (church_id, provider, name, enabled, schedule_enabled)
       VALUES (?, 'planning_center', 'Later Fresh-Church Schedule', 1, 1)`
    ).run(churchId);

    Database.closeAll();
    Database.initialize();
    const restarted = Database.getChurchDb(churchId);

    assert.strictEqual(
      restarted.prepare('SELECT authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId).authority_provider,
      'none'
    );
    assert.deepStrictEqual(
      restarted.prepare(
        "SELECT status FROM migrations WHERE version = 'v2.2.0_scheduled_pco_authority'"
      ).get(),
      { status: 'success' }
    );
  });
});

test('getChurchDb preserves explicit Elvanto authority when an existing PCO schedule is migrated', async () => {
  // Catches treating a scheduled PCO batch as stronger evidence than the
  // church's explicit non-none authority and creating an unintended second
  // active source of truth.
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    db.prepare(
      `INSERT INTO people_sync_batches
        (church_id, provider, name, enabled, schedule_enabled)
       VALUES (?, 'planning_center', 'Existing Generic PCO Schedule', 1, 1)`
    ).run(churchId);
    db.prepare(
      "UPDATE people_sync_settings SET authority_provider = 'elvanto', pending_authority_provider = NULL WHERE church_id = ?"
    ).run(churchId);
    db.exec('DELETE FROM migrations');

    Database.closeAll();
    Database.initialize();
    const migrated = Database.getChurchDb(churchId);

    assert.deepStrictEqual(
      migrated.prepare('SELECT authority_provider, pending_authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId),
      { authority_provider: 'elvanto', pending_authority_provider: null }
    );
    assert.strictEqual(migrated.prepare('SELECT COUNT(*) AS count FROM people_sync_settings WHERE church_id = ?').get(churchId).count, 1);
  });
});

test('connection saves fail closed without an encryption key while non-integration database startup remains available', async () => {
  // Catches either provider falling back to plaintext/empty-key storage, or a
  // missing optional integration key taking down ordinary church data access.
  const previousKey = process.env.INTEGRATION_CREDENTIALS_KEY;
  delete process.env.INTEGRATION_CREDENTIALS_KEY;

  try {
    await withTestChurchDb(async (churchId) => {
      for (const connection of [
        { provider: 'elvanto', authType: 'api_key', credentials: { apiKey: 'must-not-save' } },
        { provider: 'planning_center', authType: 'oauth', credentials: { accessToken: 'must-not-save' } },
      ]) {
        await assert.rejects(
          upsertConnection({ churchId, ...connection }),
          (error) => {
            assert.strictEqual(error.code, INTEGRATION_CREDENTIALS_KEY_INVALID);
            return true;
          }
        );
      }

      const db = Database.getChurchDb(churchId);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM integration_connections').get().count, 0);
      const familyId = Number(db.prepare(
        'INSERT INTO families (family_name, church_id) VALUES (?, ?)'
      ).run('Ordinary Family', churchId).lastInsertRowid);
      assert.deepStrictEqual(
        db.prepare('SELECT family_name FROM families WHERE id = ?').get(familyId),
        { family_name: 'Ordinary Family' },
        'non-integration reads and writes must remain available without the optional key'
      );
    });
  } finally {
    if (previousKey === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
    else process.env.INTEGRATION_CREDENTIALS_KEY = previousKey;
  }
});

test('getChurchDb quarantines duplicate legacy PCO IDs and backfills only unique IDs', () => {
  // Catches an upgrade that runs the entire current schema and retroactively
  // applies idx_individuals_pco_id_unique to legacy duplicate PCO data.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmpg-legacy-sync-test-'));
  const churchDir = path.join(tempDir, 'churches');
  const churchId = `legacy_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const previousChurchDataDir = process.env.CHURCH_DATA_DIR;
  fs.mkdirSync(churchDir, { recursive: true });

  try {
    const legacyDb = new BetterSqlite3(path.join(churchDir, `${churchId}.sqlite`));
    legacyDb.pragma('foreign_keys = ON');
    legacyDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        email TEXT,
        mobile_number TEXT,
        role TEXT,
        is_active INTEGER
      );
      CREATE TABLE church_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, church_id TEXT, church_name TEXT NOT NULL);
      CREATE TABLE gathering_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        day_of_week TEXT,
        attendance_type TEXT,
        is_active INTEGER,
        church_id TEXT
      );
      CREATE TABLE families (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        family_name TEXT NOT NULL,
        church_id TEXT,
        planning_center_id TEXT
      );
      CREATE TABLE individuals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        family_id INTEGER,
        is_active INTEGER,
        church_id TEXT,
        planning_center_id TEXT
      );
      CREATE TABLE planning_center_sync_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        name TEXT NOT NULL,
        membership_filter_enabled INTEGER DEFAULT 0,
        membership_allowlist TEXT,
        field_filter_enabled INTEGER DEFAULT 0,
        field_filters TEXT,
        default_people_type TEXT DEFAULT 'regular',
        gathering_type_id INTEGER,
        gathering_auto_remove_enabled INTEGER DEFAULT 0,
        schedule_enabled INTEGER DEFAULT 0,
        schedule_frequency TEXT DEFAULT 'weekly',
        schedule_day INTEGER DEFAULT 1,
        last_sync_at TEXT,
        last_sync_result TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE gathering_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gathering_type_id INTEGER NOT NULL,
        individual_id INTEGER NOT NULL,
        added_by INTEGER,
        church_id TEXT,
        added_at TEXT DEFAULT (datetime('now')),
        added_by_pco_batch_id INTEGER,
        UNIQUE(gathering_type_id, individual_id)
      );
    `);
    legacyDb.prepare('INSERT INTO church_settings (church_id, church_name) VALUES (?, ?)').run(churchId, 'Legacy Church');
    legacyDb.prepare('INSERT INTO individuals (first_name, last_name, church_id, planning_center_id) VALUES (?, ?, ?, ?)')
      .run('First', 'Duplicate', churchId, 'legacy-duplicate-id');
    legacyDb.prepare('INSERT INTO individuals (first_name, last_name, church_id, planning_center_id) VALUES (?, ?, ?, ?)')
      .run('Second', 'Duplicate', churchId, 'legacy-duplicate-id');
    legacyDb.prepare('INSERT INTO individuals (first_name, last_name, church_id, planning_center_id) VALUES (?, ?, ?, ?)')
      .run('Only', 'Unique', churchId, 'legacy-unique-id');
    legacyDb.prepare('INSERT INTO families (family_name, church_id, planning_center_id) VALUES (?, ?, ?)')
      .run('First Duplicate Family', churchId, 'legacy-duplicate-family');
    legacyDb.prepare('INSERT INTO families (family_name, church_id, planning_center_id) VALUES (?, ?, ?)')
      .run('Second Duplicate Family', churchId, 'legacy-duplicate-family');
    legacyDb.prepare('INSERT INTO families (family_name, church_id, planning_center_id) VALUES (?, ?, ?)')
      .run('Unique Family', churchId, 'legacy-unique-family');
    legacyDb.prepare("INSERT INTO planning_center_sync_batches (church_id, name, membership_allowlist, field_filters) VALUES (?, ?, '[]', '[]')")
      .run(churchId, 'Legacy Batch');
    legacyDb.close();

    Database.closeAll();
    process.env.CHURCH_DATA_DIR = tempDir;
    Database.initialize();
    const migrated = Database.getChurchDb(churchId);

    assert.strictEqual(
      migrated.prepare('SELECT COUNT(*) AS count FROM individuals WHERE church_id = ? AND planning_center_id = ?')
        .get(churchId, 'legacy-duplicate-id').count,
      2,
      'legacy duplicate PCO values must remain untouched'
    );
    assert.strictEqual(
      migrated.prepare('SELECT COUNT(*) AS count FROM external_person_links WHERE church_id = ?').get(churchId).count,
      1,
      'only the unique legacy person ID should be linked'
    );
    assert.deepStrictEqual(
      migrated.prepare('SELECT external_person_id FROM external_person_links WHERE church_id = ?').all(churchId),
      [{ external_person_id: 'legacy-unique-id' }]
    );
    assert.deepStrictEqual(
      migrated.prepare('SELECT external_family_id FROM external_family_links WHERE church_id = ?').all(churchId),
      [{ external_family_id: 'legacy-unique-family' }]
    );
    assert.deepStrictEqual(
      migrated.prepare(`SELECT entity_type, external_id, local_entity_ids, reason_code
        FROM people_sync_migration_issues WHERE church_id = ? ORDER BY entity_type`).all(churchId),
      [
        {
          entity_type: 'family', external_id: 'legacy-duplicate-family',
          local_entity_ids: '1,2', reason_code: 'duplicate_legacy_external_id',
        },
        {
          entity_type: 'person', external_id: 'legacy-duplicate-id',
          local_entity_ids: '1,2', reason_code: 'duplicate_legacy_external_id',
        },
      ],
      'every ambiguous legacy ID must be persisted for administrator/support review'
    );

    // Repair databases that were already through the earlier arbitrary
    // INSERT OR IGNORE migration, and keep the report idempotent.
    migrated.prepare(`INSERT INTO external_person_links
      (church_id, provider, external_person_id, individual_id, link_source)
      VALUES (?, 'planning_center', 'legacy-duplicate-id', 1, 'legacy_backfill')`).run(churchId);
    Database.backfillProviderNeutralSync(migrated, churchId);
    assert.strictEqual(
      migrated.prepare("SELECT COUNT(*) AS count FROM external_person_links WHERE church_id = ? AND external_person_id = 'legacy-duplicate-id'").get(churchId).count,
      0,
      'a previously arbitrary legacy link must be removed when its duplicate is detected'
    );
    assert.strictEqual(
      migrated.prepare('SELECT COUNT(*) AS count FROM people_sync_migration_issues WHERE church_id = ?').get(churchId).count,
      2,
      're-running the backfill must not duplicate quarantine reports'
    );
    assert.ok(
      migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'people_sync_batches'").get(),
      'neutral schema should be created during the old-database upgrade'
    );
  } finally {
    Database.closeAll();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousChurchDataDir === undefined) {
      delete process.env.CHURCH_DATA_DIR;
    } else {
      process.env.CHURCH_DATA_DIR = previousChurchDataDir;
    }
  }
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
