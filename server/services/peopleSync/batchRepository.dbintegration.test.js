const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { digestSourceIdentity } = require('./sourceModel');
const {
  listBatches, listEnabledBatches, getBatch, createBatch, updateBatch, deleteBatch, recordBatchResult,
  saveSourceDraft, discardSourceDraft, promoteSourceDraftWithConnection,
} = require('./batchRepository');

const PCO_SOURCE = { kind: 'planning_center_list', externalId: '42', name: 'Sunday Attendance' };
const ELVANTO_SOURCE = { kind: 'elvanto_group', externalId: 'members', name: 'Members' };

async function seedGathering(churchId) {
  return (await Database.query('INSERT INTO gathering_types (church_id, name) VALUES (?, ?)', [churchId, 'Sunday'])).insertId;
}

test('a batch begins with a resolved source draft and no active source', async () => {
  await withTestChurchDb(async (churchId) => {
    const created = await createBatch({
      churchId, provider: 'planning_center', name: 'Members', initialDraftSource: PCO_SOURCE,
    });
    assert.equal(created.source, null);
    assert.equal(created.sourceRevision, 1);
    assert.deepEqual(created.draftSource, PCO_SOURCE);
    assert.equal(created.draftSourceBaseRevision, 1);
    assert.equal(created.needsSourceReview, true);
    assert.equal(created.initialSourceReviewPending, true);
    assert.equal(created.sourceStatus, 'unknown');
  });
});

test('batch repository maps source state and keeps filter values inert during normal CRUD', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGathering(churchId);
    const created = await createBatch({
      churchId, provider: 'elvanto', name: 'Members', enabled: false, initialDraftSource: ELVANTO_SOURCE,
      defaultPeopleType: 'local_visitor', gatheringTypeId, gatheringAutoRemoveEnabled: true,
      scheduleEnabled: true, scheduleFrequency: 'monthly', scheduleDay: 4, legacyProviderBatchId: 9,
    });
    assert.deepEqual(created.source, null);
    assert.deepEqual(created.draftSource, ELVANTO_SOURCE);
    assert.equal(Object.hasOwn(created, 'filterConfig'), false);
    const updated = await updateBatch({ churchId, provider: 'elvanto', batchId: created.id, name: 'Renamed', enabled: true });
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.enabled, true);
    assert.deepEqual(await listBatches(churchId, 'elvanto'), [updated]);
  });
});

test('saving a source draft captures the active revision and a normal draft can be discarded', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members', initialDraftSource: ELVANTO_SOURCE });
    const conn = Database.getChurchDb(churchId);
    await promoteSourceDraftWithConnection(conn, {
      churchId, provider: 'elvanto', batchId: batch.id, expectedBaseRevision: 1,
      expectedDraftDigest: digestSourceIdentity(ELVANTO_SOURCE),
    });
    const replacement = { kind: 'elvanto_category', externalId: 'regulars', name: 'Regulars' };
    const saved = await saveSourceDraft({ churchId, provider: 'elvanto', batchId: batch.id, source: replacement });
    assert.deepEqual(saved.draftSource, replacement);
    assert.equal(saved.draftSourceBaseRevision, saved.sourceRevision);
    const discarded = await discardSourceDraft(churchId, 'elvanto', batch.id);
    assert.equal(discarded.draftSource, null);
    assert.equal(discarded.needsSourceReview, false);
  });
});

test('an initial source draft cannot be discarded into a runnable batch', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members', initialDraftSource: ELVANTO_SOURCE });
    await assert.rejects(
      discardSourceDraft(churchId, 'elvanto', batch.id),
      (error) => error?.code === 'SYNC_SOURCE_INITIAL_REVIEW_REQUIRED',
    );
    assert.deepEqual((await getBatch(churchId, 'elvanto', batch.id)).draftSource, ELVANTO_SOURCE);
  });
});

test('source draft promotion is compare-and-swap guarded and clears the reviewed draft', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members' });
    const draft = await saveSourceDraft({ churchId, provider: 'elvanto', batchId: batch.id, source: ELVANTO_SOURCE });
    const conn = Database.getChurchDb(churchId);
    const args = {
      churchId, provider: 'elvanto', batchId: batch.id,
      expectedBaseRevision: draft.draftSourceBaseRevision,
      expectedDraftDigest: digestSourceIdentity(ELVANTO_SOURCE),
    };

    for (const invalid of [
      { ...args, churchId: otherChurchId },
      { ...args, provider: 'planning_center' },
      { ...args, expectedBaseRevision: args.expectedBaseRevision + 1 },
      { ...args, expectedDraftDigest: digestSourceIdentity({ ...ELVANTO_SOURCE, externalId: 'other' }) },
    ]) {
      await assert.rejects(
        promoteSourceDraftWithConnection(conn, invalid),
        (error) => error?.code === 'SYNC_SOURCE_DRAFT_STALE',
      );
      const unchanged = await getBatch(churchId, 'elvanto', batch.id);
      assert.equal(unchanged.source, null);
      assert.deepEqual(unchanged.draftSource, ELVANTO_SOURCE);
    }

    const promoted = await promoteSourceDraftWithConnection(conn, args);
    assert.equal(promoted.sourceRevision, 2);
    assert.deepEqual(promoted.source, ELVANTO_SOURCE);
    assert.equal(promoted.draftSource, null);
    assert.equal(promoted.draftSourceBaseRevision, null);
    assert.equal(promoted.draftSourceUpdatedAt, null);
    assert.equal(promoted.needsSourceReview, false);
    assert.equal(promoted.initialSourceReviewPending, false);
    assert.equal(promoted.sourceStatus, 'unknown');
  });
});

test('listEnabledBatches and delete remain scoped to church and provider', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    const enabled = await createBatch({ churchId, provider: 'elvanto', name: 'Enabled', enabled: true });
    await createBatch({ churchId, provider: 'elvanto', name: 'Disabled', enabled: false });
    await createBatch({ churchId, provider: 'planning_center', name: 'Other provider', enabled: true });
    await createBatch({ churchId: otherChurchId, provider: 'elvanto', name: 'Other church', enabled: true });
    assert.deepEqual(await listEnabledBatches(churchId, 'elvanto'), [enabled]);
    assert.equal(await deleteBatch(churchId, 'elvanto', enabled.id), true);
    assert.equal(await getBatch(churchId, 'elvanto', enabled.id), null);
  });
});

test('batch result recording remains scoped to source-owning provider batches', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members' });
    await recordBatchResult({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'scheduled', fetchMode: 'incremental', complete: true, status: 'applied', externalWatermark: 'watermark-1' });
    assert.equal((await getBatch(churchId, 'elvanto', batch.id)).lastExternalWatermark, 'watermark-1');
  });
});
