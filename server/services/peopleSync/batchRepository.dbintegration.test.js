const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  listBatches, getBatch, createBatch, updateBatch, deleteBatch, recordBatchResult,
  saveFilterDraft, discardFilterDraft, promoteFilterDraftWithConnection,
} = require('./batchRepository');

async function seedGathering(churchId) {
  return (await Database.query('INSERT INTO gathering_types (church_id, name) VALUES (?, ?)', [churchId, 'Sunday'])) .insertId;
}

test('batch repository maps the complete stable DTO and preserves its schema version', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGathering(churchId);
    const created = await createBatch({
      churchId, provider: 'elvanto', name: 'Members', enabled: false,
      filterSchemaVersion: 3, filterConfig: { groups: ['members'] }, defaultPeopleType: 'local_visitor',
      gatheringTypeId, gatheringAutoRemoveEnabled: true, scheduleEnabled: true,
      scheduleFrequency: 'monthly', scheduleDay: 4, legacyProviderBatchId: 9,
    });
    assert.deepEqual(created, {
      id: created.id, provider: 'elvanto', name: 'Members', enabled: false,
      filterSchemaVersion: 3, filterConfig: { groups: ['members'] }, defaultPeopleType: 'local_visitor',
      gatheringTypeId, gatheringAutoRemoveEnabled: true, scheduleEnabled: true,
      scheduleFrequency: 'monthly', scheduleDay: 4, legacyProviderBatchId: 9,
      filterRevision: 1, draftFilterSchemaVersion: null, draftFilterConfig: null,
      draftFilterBaseRevision: null, draftFilterUpdatedAt: null, needsFilterReview: false,
      lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
    });
    const updated = await updateBatch({ churchId, provider: 'elvanto', batchId: created.id, name: 'Renamed', enabled: true });
    assert.equal(updated.filterSchemaVersion, 3);
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.enabled, true);
    assert.deepEqual(await listBatches(churchId, 'elvanto'), [updated]);
  });
});

test('batch repository persists reviewed filter drafts without changing the active filter', async () => {
  await withTestChurchDb(async (churchId) => {
    const proposed = { branches: [{ conditions: [{ field: 'campus', value: 'Hobart' }] }], exclusions: [] };
    const created = await createBatch({
      churchId, provider: 'elvanto', name: 'Members', initialDraftFilterConfig: proposed,
    });
    assert.equal(created.filterSchemaVersion, 2);
    assert.deepEqual(created.filterConfig, { branches: [], exclusions: [] });
    assert.deepEqual(created.draftFilterConfig, proposed);
    assert.equal(created.draftFilterBaseRevision, 1);
    assert.equal(created.needsFilterReview, true);

    const saved = await saveFilterDraft({
      churchId, provider: 'elvanto', batchId: created.id, schemaVersion: 2,
      filterConfig: { branches: [], exclusions: [{ field: 'status', value: 'inactive' }] },
    });
    assert.deepEqual(saved.filterConfig, { branches: [], exclusions: [] });
    assert.deepEqual(saved.draftFilterConfig, { branches: [], exclusions: [{ field: 'status', value: 'inactive' }] });
    assert.equal(saved.draftFilterBaseRevision, 1);

    const discarded = await discardFilterDraft(churchId, 'elvanto', created.id);
    assert.deepEqual(discarded.filterConfig, { branches: [], exclusions: [] });
    assert.equal(discarded.draftFilterConfig, null);
    assert.equal(discarded.draftFilterBaseRevision, null);
    assert.equal(discarded.needsFilterReview, false);
  });
});

test('batch repository promotes drafts only when the revision and digest guards match', async () => {
  await withTestChurchDb(async (churchId) => {
    const proposed = { branches: [], exclusions: [{ field: 'status', value: 'inactive' }] };
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members' });
    const draft = await saveFilterDraft({
      churchId, provider: 'elvanto', batchId: batch.id, schemaVersion: 2, filterConfig: proposed,
    });
    const conn = Database.getChurchDb(churchId);
    const expectedDraftDigest = crypto.createHash('sha256').update(JSON.stringify(proposed)).digest('hex');

    await assert.rejects(
      promoteFilterDraftWithConnection(conn, {
        churchId, provider: 'elvanto', batchId: batch.id,
        expectedBaseRevision: draft.draftFilterBaseRevision + 1, expectedDraftDigest,
      }),
      (error) => error?.code === 'SYNC_FILTER_DRAFT_STALE'
    );

    const promoted = await promoteFilterDraftWithConnection(conn, {
      churchId, provider: 'elvanto', batchId: batch.id,
      expectedBaseRevision: draft.draftFilterBaseRevision, expectedDraftDigest,
    });
    assert.equal(promoted.filterRevision, 2);
    assert.equal(promoted.filterSchemaVersion, 2);
    assert.deepEqual(promoted.filterConfig, proposed);
    assert.equal(promoted.draftFilterSchemaVersion, null);
    assert.equal(promoted.draftFilterConfig, null);
    assert.equal(promoted.draftFilterBaseRevision, null);
    assert.equal(promoted.draftFilterUpdatedAt, null);
    assert.equal(promoted.needsFilterReview, false);
  });
});

test('batch reads fall back safely from malformed stored filter JSON and remain provider/church scoped', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members' });
    await Database.query(
      'UPDATE people_sync_batches SET filter_config = ? WHERE id = ? AND church_id = ? AND provider = ?',
      ['{bad json', batch.id, churchId, 'elvanto']
    );
    assert.deepEqual((await getBatch(churchId, 'elvanto', batch.id)).filterConfig, {});
    assert.equal(await getBatch(churchId, 'planning_center', batch.id), null);
    assert.equal(await getBatch(otherChurchId, 'elvanto', batch.id), null);
  });
});

test('scheduled successful results advance a batch watermark but failed or partial results do not', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members' });
    await recordBatchResult({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'scheduled', fetchMode: 'incremental', complete: true, status: 'applied', externalWatermark: 'watermark-1' });
    assert.equal((await getBatch(churchId, 'elvanto', batch.id)).lastExternalWatermark, 'watermark-1');
    await recordBatchResult({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'scheduled', fetchMode: 'incremental', complete: false, status: 'applied', externalWatermark: 'watermark-2' });
    await recordBatchResult({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'scheduled', fetchMode: 'incremental', complete: true, status: 'failed', externalWatermark: 'watermark-3' });
    await recordBatchResult({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'scheduled', fetchMode: 'full', complete: true, status: 'review_required' });
    assert.equal((await getBatch(churchId, 'elvanto', batch.id)).lastExternalWatermark, 'watermark-1');
  });
});

test('complete manually applied results advance a batch watermark while manual review results do not', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members' });
    await recordBatchResult({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual', fetchMode: 'full', complete: true, status: 'applied', externalWatermark: 'manual-watermark' });
    assert.equal((await getBatch(churchId, 'elvanto', batch.id)).lastExternalWatermark, 'manual-watermark');
    await recordBatchResult({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual', fetchMode: 'full', complete: true, status: 'review_required', externalWatermark: 'review-watermark' });
    assert.equal((await getBatch(churchId, 'elvanto', batch.id)).lastExternalWatermark, 'manual-watermark');
  });
});

test('delete batch is scoped to its provider and church', async () => {
  await withTestChurchDb(async (churchId) => {
    const elvanto = await createBatch({ churchId, provider: 'elvanto', name: 'Elvanto' });
    const pco = await createBatch({ churchId, provider: 'planning_center', name: 'PCO' });
    assert.equal(await deleteBatch(churchId, 'elvanto', elvanto.id), true);
    assert.equal(await getBatch(churchId, 'elvanto', elvanto.id), null);
    assert.equal((await getBatch(churchId, 'planning_center', pco.id)).name, 'PCO');
  });
});
