const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const pcoSync = require('./planningCenterSync');
const filterFactsCache = require('./peopleSync/filterFactsCache');
const { isDueToday } = pcoSync;

test('peekCachedPcoPeople returns null for a cold church without fetching', () => {
  assert.equal(pcoSync.peekCachedPcoPeople('church-without-a-warm-cache'), null);
});

test('isDueToday: daily is always due', () => {
  const monday = new Date('2026-07-06T02:00:00'); // a Monday
  const wednesday = new Date('2026-07-08T02:00:00');
  assert.strictEqual(isDueToday('daily', 1, monday), true);
  assert.strictEqual(isDueToday('daily', 1, wednesday), true);
});

test('isDueToday: weekly matches only the configured day', () => {
  const monday = new Date('2026-07-06T02:00:00');
  const tuesday = new Date('2026-07-07T02:00:00');
  assert.strictEqual(isDueToday('weekly', 1, monday), true); // 1 = Monday
  assert.strictEqual(isDueToday('weekly', 1, tuesday), false);
  assert.strictEqual(isDueToday('weekly', 2, tuesday), true); // 2 = Tuesday
});

test('isDueToday: weekly defaults to Monday when day is not a number', () => {
  const monday = new Date('2026-07-06T02:00:00');
  const tuesday = new Date('2026-07-07T02:00:00');
  assert.strictEqual(isDueToday('weekly', null, monday), true);
  assert.strictEqual(isDueToday('weekly', undefined, tuesday), false);
});

test('isDueToday: monthly matches only the 1st', () => {
  const first = new Date('2026-07-01T02:00:00');
  const second = new Date('2026-07-02T02:00:00');
  assert.strictEqual(isDueToday('monthly', 1, first), true);
  assert.strictEqual(isDueToday('monthly', 1, second), false);
});

test('isDueToday: unknown frequency falls back to weekly behavior', () => {
  const monday = new Date('2026-07-06T02:00:00');
  const tuesday = new Date('2026-07-07T02:00:00');
  assert.strictEqual(isDueToday('bogus', 1, monday), true);
  assert.strictEqual(isDueToday('bogus', 1, tuesday), false);
});

test('isDueToday: monthly matches an exact mid-month day', () => {
  const the14th = new Date('2026-07-14T02:00:00');
  const the15th = new Date('2026-07-15T02:00:00');
  const the16th = new Date('2026-07-16T02:00:00');
  assert.strictEqual(isDueToday('monthly', 15, the14th), false);
  assert.strictEqual(isDueToday('monthly', 15, the15th), true);
  assert.strictEqual(isDueToday('monthly', 15, the16th), false);
});

test('isDueToday: monthly day 31 clamps to the last day of a 30-day month', () => {
  const april29 = new Date('2026-04-29T02:00:00');
  const april30 = new Date('2026-04-30T02:00:00'); // April has 30 days
  assert.strictEqual(isDueToday('monthly', 31, april29), false);
  assert.strictEqual(isDueToday('monthly', 31, april30), true);
});

test('isDueToday: monthly day 29 clamps to the 28th in a non-leap February', () => {
  const feb27 = new Date('2026-02-27T02:00:00');
  const feb28 = new Date('2026-02-28T02:00:00'); // 2026 is not a leap year
  assert.strictEqual(isDueToday('monthly', 29, feb27), false);
  assert.strictEqual(isDueToday('monthly', 29, feb28), true);
});

test('isDueToday: monthly day 29 matches exactly in a leap February', () => {
  const feb28 = new Date('2028-02-28T02:00:00');
  const feb29 = new Date('2028-02-29T02:00:00'); // 2028 is a leap year
  assert.strictEqual(isDueToday('monthly', 29, feb28), false);
  assert.strictEqual(isDueToday('monthly', 29, feb29), true);
});

test('isDueToday: monthly falls back to day 1 for a legacy day=0 value', () => {
  const the1st = new Date('2026-07-01T02:00:00');
  const the2nd = new Date('2026-07-02T02:00:00');
  assert.strictEqual(isDueToday('monthly', 0, the1st), true);
  assert.strictEqual(isDueToday('monthly', 0, the2nd), false);
});

// ─── Task 9: PCO batches routed through the generic people_sync_batches /
// batchRepository, with legacy planning_center_sync_batches dual-written for
// compatibility. These tests pin the exact response shape the PCO batch UI
// (client/src/components/planningCenter/*) and existing routes already
// depend on — Task 9 must change internals only, never this shape. ───────────

test('listBatches/getBatch return the existing legacy PCO batch DTO shape for a batch backfilled from the legacy table', async () => {
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    const gatheringId = Number(db.prepare(
      `INSERT INTO gathering_types (name, church_id) VALUES (?, ?)`
    ).run('Sunday Service', churchId).lastInsertRowid);
    db.prepare(
      `INSERT INTO planning_center_sync_batches
        (church_id, name, membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters,
         default_people_type, gathering_type_id, gathering_auto_remove_enabled, schedule_enabled, schedule_frequency,
         schedule_day, last_sync_at, last_sync_result)
       VALUES (?, ?, 1, ?, 0, '[]', 'regular', ?, 1, 1, 'weekly', 2, '2026-07-01T00:00:00Z', '{"added":3}')`
    ).run(churchId, 'Members', '["Members"]', gatheringId);

    // Simulates the migration path every existing church db already goes
    // through (see ensureChurchSchema/getChurchDb in config/database.js) —
    // by the time any route runs, the backfilled generic row already exists.
    Database.backfillProviderNeutralSync(db, churchId);

    const batches = await pcoSync.listBatches(churchId);
    assert.strictEqual(batches.length, 1);
    const batch = batches[0];
    assert.strictEqual(batch.name, 'Members');
    assert.strictEqual(batch.membershipFilterEnabled, true);
    assert.deepEqual(batch.membershipAllowlist, ['Members']);
    assert.strictEqual(batch.fieldFilterEnabled, false);
    assert.deepEqual(batch.fieldFilters, []);
    assert.strictEqual(batch.defaultPeopleType, 'regular');
    assert.strictEqual(batch.gatheringTypeId, gatheringId);
    assert.strictEqual(batch.gatheringAutoRemoveEnabled, true);
    assert.strictEqual(batch.scheduleEnabled, true);
    assert.strictEqual(batch.scheduleFrequency, 'weekly');
    assert.strictEqual(batch.scheduleDay, 2);
    assert.strictEqual(batch.lastSyncAt, '2026-07-01T00:00:00Z');
    assert.deepEqual(batch.lastSyncResult, { added: 3 });

    const single = await pcoSync.getBatch(churchId, batch.id);
    assert.deepEqual(single, batch);
  });
});

test('createBatch/updateBatch/deleteBatch dual-write the generic and legacy PCO batch tables', async () => {
  await withTestChurchDb(async (churchId) => {
    const created = await pcoSync.createBatch(churchId, {
      name: 'Youth',
      membershipFilterEnabled: false,
      membershipAllowlist: [],
      fieldFilterEnabled: false,
      fieldFilters: [],
      defaultPeopleType: 'regular',
      gatheringTypeId: null,
      gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false,
      scheduleFrequency: 'weekly',
      scheduleDay: 1,
    });
    assert.ok(created.id, 'created batch should have an id');

    const genericRows = await Database.query(
      'SELECT * FROM people_sync_batches WHERE church_id = ? AND provider = ?', [churchId, 'planning_center']
    );
    assert.strictEqual(genericRows.length, 1);
    assert.ok(genericRows[0].legacy_provider_batch_id, 'generic row should carry the legacy batch id');

    const legacyRows = await Database.query(
      'SELECT * FROM planning_center_sync_batches WHERE church_id = ?', [churchId]
    );
    assert.strictEqual(legacyRows.length, 1);
    assert.strictEqual(legacyRows[0].id, genericRows[0].legacy_provider_batch_id);
    assert.strictEqual(legacyRows[0].name, 'Youth');

    const updated = await pcoSync.updateBatch(churchId, created.id, {
      name: 'Youth Group',
      membershipFilterEnabled: true,
      membershipAllowlist: ['Youth'],
      fieldFilterEnabled: false,
      fieldFilters: [],
      defaultPeopleType: 'regular',
      gatheringTypeId: null,
      gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false,
      scheduleFrequency: 'weekly',
      scheduleDay: 1,
    });
    assert.strictEqual(updated.name, 'Youth Group');
    assert.deepEqual(updated.membershipAllowlist, ['Youth']);

    const legacyAfterUpdate = await Database.query(
      'SELECT name, membership_allowlist FROM planning_center_sync_batches WHERE id = ? AND church_id = ?',
      [legacyRows[0].id, churchId]
    );
    assert.strictEqual(legacyAfterUpdate[0].name, 'Youth Group');
    assert.deepEqual(JSON.parse(legacyAfterUpdate[0].membership_allowlist), ['Youth']);

    const deleted = await pcoSync.deleteBatch(churchId, created.id);
    assert.strictEqual(deleted, true);

    const genericAfterDelete = await Database.query(
      'SELECT * FROM people_sync_batches WHERE church_id = ? AND provider = ?', [churchId, 'planning_center']
    );
    assert.strictEqual(genericAfterDelete.length, 0);
    const legacyAfterDelete = await Database.query(
      'SELECT * FROM planning_center_sync_batches WHERE church_id = ?', [churchId]
    );
    assert.strictEqual(legacyAfterDelete.length, 0);
  });
});

test('createBatch defaults gatheringAutoRemoveEnabled to false when the caller omits it (old client compatibility)', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await pcoSync.createBatch(churchId, {
      name: 'Legacy client batch',
      membershipFilterEnabled: false,
      membershipAllowlist: [],
      fieldFilterEnabled: false,
      fieldFilters: [],
      defaultPeopleType: 'regular',
      gatheringTypeId: null,
      scheduleEnabled: false,
      scheduleFrequency: 'weekly',
      scheduleDay: 1,
      // gatheringAutoRemoveEnabled intentionally omitted — an old/stale
      // client (dismissible PWA update banner) may never send it.
    });
    assert.strictEqual(batch.gatheringAutoRemoveEnabled, false);
  });
});

test('createBatch preserves stale v1 fields while atomically creating a v2 active-empty filter and draft', async () => {
  await withTestChurchDb(async (churchId) => {
    const draft = { branches: [{ groups: [{ dimensionId: 'membership', mode: 'any', values: ['Member'] }] }], exclusions: [] };
    filterFactsCache.putComplete({
      churchId, provider: 'planning_center', mode: 'full', complete: true,
      coveredDimensionIds: ['membership'], populationGateDigest: 'gate', facts: [],
      dimensions: [{ id: 'membership', cardinality: 'single', values: [{ id: 'Member' }] }],
    });
    const created = await pcoSync.createBatch(churchId, {
      name: 'Reviewed members', filterSchemaVersion: 2, draftFilterConfig: draft,
      broadMatchAcknowledged: false,
      defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
    });
    assert.equal(created.filterSchemaVersion, 2);
    assert.deepEqual(created.filterConfig, { branches: [], exclusions: [] });
    assert.deepEqual(created.draftFilterConfig, draft);
    assert.equal(created.needsFilterReview, true);
    // Existing PCO clients still receive their original flattened values.
    assert.equal(created.membershipFilterEnabled, false);
    assert.deepEqual(created.membershipAllowlist, []);
  });
});

test('updating v2 Planning Center batch settings preserves canonical and compatibility filter criteria', async () => {
  await withTestChurchDb(async (churchId) => {
    const draft = { branches: [{ groups: [{ dimensionId: 'membership', mode: 'any', values: ['Member'] }] }], exclusions: [] };
    const active = { branches: [{ groups: [{ dimensionId: 'membership', mode: 'any', values: ['Regular'] }] }], exclusions: [] };
    const retainedLegacyFilters = {
      membershipAllowlist: ['Legacy members'],
      fieldFilters: [{ fieldDefinitionId: 'membership_status', tabName: 'Profile', fieldName: 'Membership status', values: ['Member'] }],
    };
    filterFactsCache.putComplete({
      churchId, provider: 'planning_center', mode: 'full', complete: true,
      coveredDimensionIds: ['membership'], populationGateDigest: 'gate', facts: [],
      dimensions: [{ id: 'membership', cardinality: 'single', values: [{ id: 'Member' }] }],
    });
    const created = await pcoSync.createBatch(churchId, {
      name: 'Reviewed members', filterSchemaVersion: 2, draftFilterConfig: draft,
      broadMatchAcknowledged: false, defaultPeopleType: 'regular', gatheringTypeId: null,
      gatheringAutoRemoveEnabled: false, scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
    });

    // A reviewed batch may retain its previous legacy criteria for provenance
    // while its canonical v2 active criteria and draft are independently set.
    await Database.query(
      `UPDATE people_sync_batches
          SET filter_config = ?, filter_revision = 7, draft_filter_schema_version = 2,
              draft_filter_config = ?, draft_filter_base_revision = 7
        WHERE id = ? AND church_id = ?`,
      [JSON.stringify(active), JSON.stringify(draft), created.id, churchId]
    );
    await Database.query(
      `UPDATE planning_center_sync_batches
          SET membership_filter_enabled = 1, membership_allowlist = ?, field_filter_enabled = 1, field_filters = ?
        WHERE id = ? AND church_id = ?`,
      [JSON.stringify(retainedLegacyFilters.membershipAllowlist), JSON.stringify(retainedLegacyFilters.fieldFilters), created.legacyProviderBatchId, churchId]
    );
    const beforeCanonical = await Database.query(
      `SELECT filter_config, filter_schema_version, filter_revision, draft_filter_schema_version,
              draft_filter_config, draft_filter_base_revision
         FROM people_sync_batches WHERE id = ? AND church_id = ?`,
      [created.id, churchId]
    );
    const beforeLegacy = await Database.query(
      `SELECT membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters
         FROM planning_center_sync_batches WHERE id = ? AND church_id = ?`,
      [created.legacyProviderBatchId, churchId]
    );
    const updated = await pcoSync.updateBatch(churchId, created.id, {
      name: 'Renamed members', defaultPeopleType: 'local_visitor',
      gatheringTypeId: null, gatheringAutoRemoveEnabled: false, scheduleEnabled: true,
      scheduleFrequency: 'monthly', scheduleDay: 15,
    });
    const afterCanonical = await Database.query(
      `SELECT filter_config, filter_schema_version, filter_revision, draft_filter_schema_version,
              draft_filter_config, draft_filter_base_revision, default_people_type, schedule_enabled, schedule_frequency, schedule_day
         FROM people_sync_batches WHERE id = ? AND church_id = ?`,
      [created.id, churchId]
    );
    const afterLegacy = await Database.query(
      `SELECT membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters,
              default_people_type, schedule_enabled, schedule_frequency, schedule_day
         FROM planning_center_sync_batches WHERE id = ? AND church_id = ?`,
      [created.legacyProviderBatchId, churchId]
    );

    assert.equal(updated.name, 'Renamed members');
    assert.equal(updated.defaultPeopleType, 'local_visitor');
    assert.deepEqual(afterCanonical[0].filter_config, beforeCanonical[0].filter_config);
    assert.equal(afterCanonical[0].filter_schema_version, beforeCanonical[0].filter_schema_version);
    assert.equal(afterCanonical[0].filter_revision, beforeCanonical[0].filter_revision);
    assert.equal(afterCanonical[0].draft_filter_schema_version, beforeCanonical[0].draft_filter_schema_version);
    assert.deepEqual(afterCanonical[0].draft_filter_config, beforeCanonical[0].draft_filter_config);
    assert.equal(afterCanonical[0].draft_filter_base_revision, beforeCanonical[0].draft_filter_base_revision);
    assert.equal(afterCanonical[0].default_people_type, 'local_visitor');
    assert.equal(afterCanonical[0].schedule_enabled, 1);
    assert.equal(afterCanonical[0].schedule_frequency, 'monthly');
    assert.equal(afterCanonical[0].schedule_day, 15);
    assert.deepEqual(afterLegacy[0].membership_filter_enabled, beforeLegacy[0].membership_filter_enabled);
    assert.deepEqual(afterLegacy[0].membership_allowlist, beforeLegacy[0].membership_allowlist);
    assert.deepEqual(afterLegacy[0].field_filter_enabled, beforeLegacy[0].field_filter_enabled);
    assert.deepEqual(afterLegacy[0].field_filters, beforeLegacy[0].field_filters);
    assert.equal(afterLegacy[0].default_people_type, 'local_visitor');
    assert.equal(afterLegacy[0].schedule_enabled, 1);
    assert.equal(afterLegacy[0].schedule_frequency, 'monthly');
    assert.equal(afterLegacy[0].schedule_day, 15);
  });
});
