const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('./database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

test('new church creates the provider-neutral sync schema, defaults, foreign keys, and indexes', async () => {
  // Catches a schema change that omits a sync table, provider-safe constraint,
  // default setting, generic roster provenance, or an operational lookup index.
  await withTestChurchDb(async (churchId) => {
    const tables = await Database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%sync%' OR name LIKE 'external_%' OR name = 'integration_connections')"
    );
    const names = new Set(tables.map((row) => row.name));
    for (const name of [
      'integration_connections',
      'external_person_links',
      'external_family_links',
      'people_sync_settings',
      'people_sync_batches',
      'people_sync_runs'
    ]) {
      assert.ok(names.has(name), `missing ${name}`);
    }

    const settings = await Database.query(
      'SELECT * FROM people_sync_settings WHERE church_id = ?',
      [churchId]
    );
    assert.deepEqual(
      {
        authority_provider: settings[0]?.authority_provider,
        elvanto_include_contacts: settings[0]?.elvanto_include_contacts,
        elvanto_align_people_type: settings[0]?.elvanto_align_people_type
      },
      {
        authority_provider: 'none',
        elvanto_include_contacts: 1,
        elvanto_align_people_type: 1
      }
    );

    const gatheringLists = await Database.query('PRAGMA table_info(gathering_lists)');
    assert.ok(
      gatheringLists.some((column) => column.name === 'added_by_sync_batch_id'),
      'gathering lists should retain provider-neutral batch provenance'
    );

    const batchColumns = await Database.query('PRAGMA table_info(people_sync_batches)');
    const batchColumnsByName = new Map(batchColumns.map((column) => [column.name, column]));
    assert.equal(batchColumnsByName.get('filter_revision').dflt_value, '1');
    assert.ok(batchColumnsByName.has('draft_filter_schema_version'));
    assert.ok(batchColumnsByName.has('draft_filter_config'));
    assert.ok(batchColumnsByName.has('draft_filter_base_revision'));
    assert.ok(batchColumnsByName.has('draft_filter_updated_at'));

    const personForeignKeys = await Database.query('PRAGMA foreign_key_list(external_person_links)');
    const familyForeignKeys = await Database.query('PRAGMA foreign_key_list(external_family_links)');
    const connectionForeignKeys = await Database.query('PRAGMA foreign_key_list(integration_connections)');
    const batchForeignKeys = await Database.query('PRAGMA foreign_key_list(people_sync_batches)');
    const runForeignKeys = await Database.query('PRAGMA foreign_key_list(people_sync_runs)');
    const rosterForeignKeys = await Database.query('PRAGMA foreign_key_list(gathering_lists)');
    assert.ok(connectionForeignKeys.some((foreignKey) => foreignKey.table === 'users' && foreignKey.on_delete === 'SET NULL'));
    assert.ok(personForeignKeys.some((foreignKey) => foreignKey.table === 'individuals' && foreignKey.on_delete === 'CASCADE'));
    assert.ok(familyForeignKeys.some((foreignKey) => foreignKey.table === 'families' && foreignKey.on_delete === 'CASCADE'));
    assert.ok(batchForeignKeys.some((foreignKey) => foreignKey.table === 'gathering_types' && foreignKey.on_delete === 'SET NULL'));
    assert.ok(runForeignKeys.some((foreignKey) => foreignKey.table === 'people_sync_batches' && foreignKey.on_delete === 'SET NULL'));
    assert.ok(rosterForeignKeys.some((foreignKey) => foreignKey.table === 'people_sync_batches' && foreignKey.on_delete === 'SET NULL'));

    const expectedDefaults = {
      integration_connections: {
        credential_key_version: '1',
        connection_status: "'connected'",
        connected_at: "datetime('now')",
        created_at: "datetime('now')",
        updated_at: "datetime('now')"
      },
      external_person_links: {
        linked_at: "datetime('now')",
        missing_full_sync_count: '0',
        review_declined: '0',
        created_at: "datetime('now')",
        updated_at: "datetime('now')"
      },
      external_family_links: {
        linked_at: "datetime('now')",
        created_at: "datetime('now')",
        updated_at: "datetime('now')"
      },
      people_sync_settings: {
        authority_provider: "'none'",
        elvanto_include_contacts: '1',
        elvanto_align_people_type: '1',
        full_reconciliation_frequency: "'weekly'",
        full_reconciliation_day: '1',
        created_at: "datetime('now')",
        updated_at: "datetime('now')"
      },
      people_sync_batches: {
        enabled: '1',
        filter_schema_version: '1',
        filter_config: "'{}'",
        filter_revision: '1',
        default_people_type: "'regular'",
        gathering_auto_remove_enabled: '0',
        schedule_enabled: '0',
        schedule_frequency: "'weekly'",
        schedule_day: '1',
        created_at: "datetime('now')",
        updated_at: "datetime('now')"
      },
      people_sync_runs: {
        counts: "'{}'",
        started_at: "datetime('now')"
      }
    };
    for (const [table, expected] of Object.entries(expectedDefaults)) {
      const columns = await Database.query(`PRAGMA table_info(${table})`);
      const actual = Object.fromEntries(
        columns.filter((column) => column.dflt_value !== null).map((column) => [column.name, column.dflt_value])
      );
      assert.deepEqual(actual, expected, `${table} defaults should preserve the sync contract`);
    }

    async function assertUniqueIndex(table, expectedColumns) {
      const indexList = await Database.query(`PRAGMA index_list(${table})`);
      let matchingIndex = null;
      for (const index of indexList) {
        if (!index.unique) continue;
        const columns = await Database.query(`PRAGMA index_info(${index.name})`);
        if (columns.map((column) => column.name).join(',') === expectedColumns.join(',')) {
          matchingIndex = index;
          break;
        }
      }
      assert.ok(matchingIndex, `${table} must uniquely constrain ${expectedColumns.join(', ')}`);
    }
    await assertUniqueIndex('integration_connections', ['church_id', 'provider']);
    await assertUniqueIndex('external_person_links', ['church_id', 'provider', 'external_person_id']);
    await assertUniqueIndex('external_person_links', ['church_id', 'provider', 'individual_id']);
    await assertUniqueIndex('external_family_links', ['church_id', 'provider', 'external_family_id']);
    await assertUniqueIndex('external_family_links', ['church_id', 'provider', 'family_id']);
    await assertUniqueIndex('people_sync_settings', ['church_id']);
    await assertUniqueIndex('people_sync_batches', ['church_id', 'provider', 'legacy_provider_batch_id']);

    const indexes = await Database.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_integration_connections_church', 'idx_external_person_links_church', 'idx_external_person_links_lookup', 'idx_external_family_links_church', 'idx_external_family_links_lookup', 'idx_people_sync_batches_church', 'idx_people_sync_batches_provider', 'idx_people_sync_runs_church', 'idx_people_sync_runs_lookup')"
    );
    assert.equal(indexes.length, 9, 'provider-neutral church, link, batch, and run lookups must be indexed');
  });
});

test('backfillProviderNeutralSync preserves legacy PCO links and roster provenance without duplicate provider links', async () => {
  // Catches a migration that loses legacy PCO ownership, duplicates rerun rows,
  // or makes the per-provider individual uniqueness constraint too broad or lax.
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    db.prepare('UPDATE church_settings SET planning_center_sync_indicator = 1 WHERE church_id = ?').run(churchId);
    db.prepare('DELETE FROM people_sync_settings WHERE church_id = ?').run(churchId);

    const familyId = Number(db.prepare(
      'INSERT INTO families (family_name, church_id, planning_center_id) VALUES (?, ?, ?)'
    ).run('Legacy Household', churchId, 'pco-household-1').lastInsertRowid);
    const individualId = Number(db.prepare(
      'INSERT INTO individuals (first_name, last_name, family_id, church_id, planning_center_id) VALUES (?, ?, ?, ?, ?)'
    ).run('Legacy', 'Person', familyId, churchId, 'pco-person-1').lastInsertRowid);
    const gatheringId = Number(db.prepare(
      'INSERT INTO gathering_types (name, church_id) VALUES (?, ?)'
    ).run('Legacy Gathering', churchId).lastInsertRowid);
    const legacyBatchId = Number(db.prepare(
      `INSERT INTO planning_center_sync_batches
        (church_id, name, membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters,
         default_people_type, gathering_type_id, gathering_auto_remove_enabled, schedule_enabled, schedule_frequency,
         schedule_day, last_sync_at, last_sync_result)
       VALUES (?, ?, 1, ?, 1, ?, 'local_visitor', ?, 1, 1, 'monthly', 4, '2026-07-20T00:00:00Z', 'applied')`
    ).run(churchId, 'Legacy PCO Batch', '["Members"]', '[{"field":"Campus","value":"Hobart"}]', gatheringId).lastInsertRowid);
    db.prepare(
      'INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id, added_by_pco_batch_id) VALUES (?, ?, ?, ?)'
    ).run(gatheringId, individualId, churchId, legacyBatchId);

    Database.backfillProviderNeutralSync(db, churchId);
    Database.backfillProviderNeutralSync(db, churchId);

    const settings = db.prepare('SELECT authority_provider FROM people_sync_settings WHERE church_id = ?').get(churchId);
    assert.equal(settings.authority_provider, 'planning_center');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM external_person_links WHERE church_id = ?').get(churchId).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM external_family_links WHERE church_id = ?').get(churchId).count, 1);

    const batches = db.prepare(
      'SELECT * FROM people_sync_batches WHERE church_id = ? AND provider = ? AND legacy_provider_batch_id = ?'
    ).all(churchId, 'planning_center', legacyBatchId);
    assert.equal(batches.length, 1);
    assert.deepEqual(JSON.parse(batches[0].filter_config), {
      membershipFilterEnabled: true,
      membershipAllowlist: ['Members'],
      fieldFilterEnabled: true,
      fieldFilters: [{ field: 'Campus', value: 'Hobart' }]
    });
    assert.equal(batches[0].default_people_type, 'local_visitor');
    assert.equal(batches[0].gathering_type_id, gatheringId);
    assert.equal(batches[0].gathering_auto_remove_enabled, 1);
    assert.equal(batches[0].schedule_enabled, 1);
    assert.equal(batches[0].schedule_frequency, 'monthly');
    assert.equal(batches[0].schedule_day, 4);
    assert.equal(batches[0].last_sync_at, '2026-07-20T00:00:00Z');
    assert.equal(batches[0].last_sync_result, 'applied');

    const roster = db.prepare('SELECT added_by_sync_batch_id FROM gathering_lists WHERE church_id = ?').get(churchId);
    assert.equal(roster.added_by_sync_batch_id, batches[0].id);

    db.prepare(
      `INSERT INTO external_person_links
        (church_id, provider, external_person_id, individual_id, link_source)
       VALUES (?, 'elvanto', 'elvanto-person-1', ?, 'created')`
    ).run(churchId, individualId);
    assert.throws(
      () => db.prepare(
        `INSERT INTO external_person_links
          (church_id, provider, external_person_id, individual_id, link_source)
         VALUES (?, 'elvanto', 'elvanto-person-2', ?, 'created')`
      ).run(churchId, individualId),
      /UNIQUE constraint failed/
    );
  });
});

test('backfillProviderNeutralSync keeps a legacy church available when batch filters contain malformed JSON', async () => {
  // Catches an upgrade outage where one malformed historical PCO filter makes
  // getChurchDb throw instead of preserving the batch with empty filters.
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    const legacyBatchId = Number(db.prepare(
      `INSERT INTO planning_center_sync_batches
        (church_id, name, membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters)
       VALUES (?, ?, 1, '{not-json', 1, '[also-not-json')`
    ).run(churchId, 'Malformed Legacy Batch').lastInsertRowid);

    assert.doesNotThrow(() => Database.backfillProviderNeutralSync(db, churchId));

    const batch = db.prepare(
      'SELECT filter_config FROM people_sync_batches WHERE church_id = ? AND provider = ? AND legacy_provider_batch_id = ?'
    ).get(churchId, 'planning_center', legacyBatchId);
    assert.deepEqual(JSON.parse(batch.filter_config), {
      membershipFilterEnabled: true,
      membershipAllowlist: [],
      fieldFilterEnabled: true,
      fieldFilters: []
    });
  });
});
