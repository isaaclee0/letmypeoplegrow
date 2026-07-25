const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { listBatches, getBatch, createBatch, updateBatch, deleteBatch, recordBatchResult } = require('./batchRepository');

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
      lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
    });
    const updated = await updateBatch({ churchId, provider: 'elvanto', batchId: created.id, name: 'Renamed', enabled: true });
    assert.equal(updated.filterSchemaVersion, 3);
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.enabled, true);
    assert.deepEqual(await listBatches(churchId, 'elvanto'), [updated]);
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

test('delete batch is scoped to its provider and church', async () => {
  await withTestChurchDb(async (churchId) => {
    const elvanto = await createBatch({ churchId, provider: 'elvanto', name: 'Elvanto' });
    const pco = await createBatch({ churchId, provider: 'planning_center', name: 'PCO' });
    assert.equal(await deleteBatch(churchId, 'elvanto', elvanto.id), true);
    assert.equal(await getBatch(churchId, 'elvanto', elvanto.id), null);
    assert.equal((await getBatch(churchId, 'planning_center', pco.id)).name, 'PCO');
  });
});
