const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { createBatch } = require('./batchRepository');
const { startRun, finishRun, failRun, setReviewNotificationFingerprint, findLatestReviewNotificationFingerprint, listRecentRuns } = require('./runRepository');

test('runs record only camel-cased safe audit fields and provider/church scoped history', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    const batch = await createBatch({ churchId, provider: 'elvanto', name: 'Members' });
    const run = await startRun({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'scheduled', fetchMode: 'incremental' });
    const finished = await finishRun({
      churchId, runId: run.id, status: 'review_required', externalWatermark: 'watermark-1',
      counts: { linkPeople: 2, addPeople: 1, ambiguousPeople: 3, familyConflicts: 0 },
    });
    assert.deepEqual(finished.counts, { linkPeople: 2, addPeople: 1, ambiguousPeople: 3, familyConflicts: 0 });
    assert.equal(finished.externalWatermark, 'watermark-1');
    assert.equal((await listRecentRuns(churchId, 'elvanto'))[0].status, 'review_required');
    assert.deepEqual(await listRecentRuns(otherChurchId, 'elvanto'), []);
    assert.deepEqual(await listRecentRuns(churchId, 'planning_center'), []);
  });
});

test('audit writes reject raw provider payloads and credential-shaped fields recursively', async () => {
  await withTestChurchDb(async (churchId) => {
    await assert.rejects(
      startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full', rawPayload: { people: [] } }),
      /allowlisted|credential|payload/i
    );
    const run = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    await assert.rejects(
      finishRun({ churchId, runId: run.id, status: 'applied', counts: { linkPeople: { authorization: 'Bearer secret' } } }),
      /credential|count/i
    );
    await assert.rejects(
      failRun({ churchId, runId: run.id, errorCode: 'UPSTREAM', errorMessage: 'failed', rawPayload: { nested: { apiKey: 'secret' } } }),
      /allowlisted|credential/i
    );
  });
});

test('review fingerprints accept only lowercase SHA-256 and are read by church/provider', async () => {
  await withTestChurchDb(async (churchId) => {
    const run = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    const fingerprint = 'a'.repeat(64);
    await setReviewNotificationFingerprint(run.id, churchId, fingerprint);
    assert.equal(await findLatestReviewNotificationFingerprint(churchId, 'elvanto'), fingerprint);
    assert.equal(await findLatestReviewNotificationFingerprint(churchId, 'planning_center'), null);
    await assert.rejects(setReviewNotificationFingerprint(run.id, churchId, 'A'.repeat(64)), /lowercase SHA-256/i);
  });
});

test('failed runs retain only safe error fields', async () => {
  await withTestChurchDb(async (churchId) => {
    const run = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    const failed = await failRun({ churchId, runId: run.id, errorCode: 'UPSTREAM_UNAVAILABLE', errorMessage: 'Upstream temporarily unavailable' });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'UPSTREAM_UNAVAILABLE');
    assert.equal(failed.errorMessage, 'Upstream temporarily unavailable');
  });
});
