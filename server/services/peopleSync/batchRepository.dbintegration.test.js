const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { digestSourceIdentity } = require('./sourceModel');
const {
  listBatches, listEnabledBatches, getBatch, createBatch, updateBatch, deleteBatch, recordBatchResult,
  saveSourceDraft, discardSourceDraft, promoteSourceDraftWithConnection, recordActiveSourceHealthWithConnection,
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
    assert.equal(Object.hasOwn(created, 'source'), true);
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

test('legacy Planning Center batches reject every source-draft mutation', async () => {
  await withTestChurchDb(async (churchId) => {
    const legacy = await createBatch({
      churchId, provider: 'planning_center', name: 'Retired PCO members',
      legacyProviderBatchId: 91, initialDraftSource: PCO_SOURCE,
    });
    const errorMatches = (error) => error?.code === 'PCO_LEGACY_BATCH_RETIRED' && error?.status === 409;

    await assert.rejects(
      saveSourceDraft({ churchId, provider: 'planning_center', batchId: legacy.id, source: PCO_SOURCE }),
      errorMatches,
    );
    await assert.rejects(discardSourceDraft(churchId, 'planning_center', legacy.id), errorMatches);
    await assert.rejects(
      promoteSourceDraftWithConnection(Database.getChurchDb(churchId), {
        churchId, provider: 'planning_center', batchId: legacy.id,
        expectedBaseRevision: legacy.draftSourceBaseRevision,
        expectedDraftDigest: digestSourceIdentity(legacy.draftSource),
      }),
      errorMatches,
    );

    const unchanged = await getBatch(churchId, 'planning_center', legacy.id);
    assert.deepEqual(unchanged.draftSource, PCO_SOURCE);
    assert.equal(unchanged.legacyProviderBatchId, 91);
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

test('promoting a modern Planning Center source draft derives the batch name from the reviewed List', async () => {
  await withTestChurchDb(async (churchId) => {
    const members = { kind: 'planning_center_list', externalId: 'members', name: 'Members' };
    const youth = { kind: 'planning_center_list', externalId: 'youth', name: 'Youth' };
    const batch = await createBatch({ churchId, provider: 'planning_center', name: 'Members', initialDraftSource: members });
    const conn = Database.getChurchDb(churchId);
    await promoteSourceDraftWithConnection(conn, {
      churchId, provider: 'planning_center', batchId: batch.id, expectedBaseRevision: 1,
      expectedDraftDigest: digestSourceIdentity(members),
    });
    const draft = await saveSourceDraft({ churchId, provider: 'planning_center', batchId: batch.id, source: youth });

    const promoted = await promoteSourceDraftWithConnection(conn, {
      churchId, provider: 'planning_center', batchId: batch.id,
      expectedBaseRevision: draft.draftSourceBaseRevision,
      expectedDraftDigest: digestSourceIdentity(youth),
    });

    assert.equal(promoted.name, 'Youth');
    assert.equal(promoted.source.name, 'Youth');
  });
});

test('active source health updates derive modern Planning Center names but retain Elvanto names', async () => {
  await withTestChurchDb(async (churchId) => {
    const pcoSource = { kind: 'planning_center_list', externalId: 'members', name: 'Members' };
    const pcoBatch = await createBatch({ churchId, provider: 'planning_center', name: 'Members', initialDraftSource: pcoSource });
    const legacyRow = await Database.query(
      `INSERT INTO planning_center_sync_batches (church_id, name, membership_allowlist, field_filters)
       VALUES (?, 'Retired custom name', '[]', '[]')`,
      [churchId],
    );
    const retiredPco = await createBatch({ churchId, provider: 'planning_center', name: 'Retired custom name', initialDraftSource: { ...pcoSource, externalId: 'retired' } });
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Independent Elvanto name', initialDraftSource: ELVANTO_SOURCE });
    const conn = Database.getChurchDb(churchId);
    await promoteSourceDraftWithConnection(conn, {
      churchId, provider: 'planning_center', batchId: pcoBatch.id, expectedBaseRevision: 1,
      expectedDraftDigest: digestSourceIdentity(pcoSource),
    });
    await promoteSourceDraftWithConnection(conn, {
      churchId, provider: 'planning_center', batchId: retiredPco.id, expectedBaseRevision: 1,
      expectedDraftDigest: digestSourceIdentity({ ...pcoSource, externalId: 'retired' }),
    });
    await updateBatch({
      churchId, provider: 'planning_center', batchId: retiredPco.id,
      name: 'Retired custom name', legacyProviderBatchId: legacyRow.insertId,
    });
    assert.equal((await getBatch(churchId, 'planning_center', retiredPco.id)).legacyProviderBatchId, legacyRow.insertId);
    await promoteSourceDraftWithConnection(conn, {
      churchId, provider: 'elvanto', batchId: batch.id, expectedBaseRevision: 1,
      expectedDraftDigest: digestSourceIdentity(ELVANTO_SOURCE),
    });

    const pco = await recordActiveSourceHealthWithConnection(conn, {
      churchId, provider: 'planning_center', batchId: pcoBatch.id, expectedSource: pcoSource,
      sourceName: 'Members renamed', sourceStatus: 'available', checkedAt: '2026-07-29T01:00:00.000Z', errorCode: null,
    });
    assert.equal(pco.updated, true);
    const updatedPco = await getBatch(churchId, 'planning_center', pcoBatch.id);
    assert.equal(updatedPco.name, 'Members renamed');
    assert.equal(updatedPco.source.name, 'Members renamed');

    const retired = await recordActiveSourceHealthWithConnection(conn, {
      churchId, provider: 'planning_center', batchId: retiredPco.id,
      expectedSource: { ...pcoSource, externalId: 'retired' },
      sourceName: 'Retired List renamed', sourceStatus: 'available', checkedAt: '2026-07-29T01:00:00.000Z', errorCode: null,
    });
    assert.equal(retired.updated, true);
    const updatedRetired = await getBatch(churchId, 'planning_center', retiredPco.id);
    assert.equal(updatedRetired.name, 'Retired custom name');
    assert.equal(updatedRetired.source.name, 'Retired List renamed');

    const first = await recordActiveSourceHealthWithConnection(conn, {
      churchId, provider: 'elvanto', batchId: batch.id, expectedSource: ELVANTO_SOURCE,
      sourceName: 'Renamed members', sourceStatus: 'available', checkedAt: '2026-07-29T01:00:00.000Z', errorCode: null,
    });
    assert.equal(first.updated, true);
    const updatedElvanto = await getBatch(churchId, 'elvanto', batch.id);
    assert.equal(updatedElvanto.name, 'Independent Elvanto name');
    assert.deepEqual(updatedElvanto.source, { ...ELVANTO_SOURCE, name: 'Renamed members' });

    const rejected = await recordActiveSourceHealthWithConnection(conn, {
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ELVANTO_SOURCE,
      sourceName: 'Wrong provider', sourceStatus: 'missing', checkedAt: '2026-07-29T02:00:00.000Z',
      errorCode: 'SYNC_SOURCE_UNAVAILABLE',
    });
    assert.equal(rejected.updated, false);
    assert.equal((await getBatch(churchId, 'elvanto', batch.id)).sourceStatus, 'available');
  });
});

test('source promotion rejects a draft replaced after its read and before its compare-and-swap update', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members', initialDraftSource: ELVANTO_SOURCE });
    const db = Database.getChurchDb(churchId);
    await promoteSourceDraftWithConnection(db, {
      churchId, provider: 'elvanto', batchId: batch.id, expectedBaseRevision: 1,
      expectedDraftDigest: digestSourceIdentity(ELVANTO_SOURCE),
    });
    const reviewedDraft = { kind: 'elvanto_category', externalId: 'members', name: 'Reviewed members' };
    const replacementDraft = { kind: 'elvanto_group', externalId: 'youth', name: 'Youth' };
    const draft = await saveSourceDraft({ churchId, provider: 'elvanto', batchId: batch.id, source: reviewedDraft });
    let replaced = false;
    const raceConnection = {
      query(sql, params) {
        if (/^UPDATE people_sync_batches/.test(sql) && !replaced) {
          replaced = true;
          db.prepare(`UPDATE people_sync_batches
            SET draft_source_kind = ?, draft_source_external_id = ?, draft_source_name = ?
            WHERE id = ? AND church_id = ? AND provider = ?`).run(
            replacementDraft.kind, replacementDraft.externalId, replacementDraft.name,
            batch.id, churchId, 'elvanto',
          );
        }
        if (/^SELECT/.test(sql)) return [db.prepare(sql).get(...params)];
        return db.prepare(sql).run(...params);
      },
    };

    await assert.rejects(
      promoteSourceDraftWithConnection(raceConnection, {
        churchId, provider: 'elvanto', batchId: batch.id,
        expectedBaseRevision: draft.draftSourceBaseRevision,
        expectedDraftDigest: digestSourceIdentity(reviewedDraft),
      }),
      (error) => error?.code === 'SYNC_SOURCE_DRAFT_STALE',
    );
    const unchanged = await getBatch(churchId, 'elvanto', batch.id);
    assert.deepEqual(unchanged.source, ELVANTO_SOURCE);
    assert.deepEqual(unchanged.draftSource, replacementDraft);
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
