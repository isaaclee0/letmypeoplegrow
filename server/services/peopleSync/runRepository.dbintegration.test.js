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
      churchId, provider: 'elvanto', runId: run.id, status: 'review_required', externalWatermark: 'watermark-1',
      counts: { linkPeople: 2, addPeople: 1, ambiguousPeople: 3, familyConflicts: 0 },
    });
    assert.deepEqual(finished.counts, { linkPeople: 2, addPeople: 1, ambiguousPeople: 3, familyConflicts: 0 });
    assert.equal(finished.externalWatermark, 'watermark-1');
    assert.equal((await listRecentRuns(churchId, 'elvanto'))[0].status, 'review_required');
    assert.deepEqual(await listRecentRuns(otherChurchId, 'elvanto'), []);
    assert.deepEqual(await listRecentRuns(churchId, 'planning_center'), []);
  });
});

test('Planning Center runs persist supplementary provider-refresh outcome counts', async () => {
  await withTestChurchDb(async (churchId) => {
    const run = await startRun({
      churchId, provider: 'planning_center', batchId: null, trigger: 'manual', fetchMode: 'full',
    });
    const counts = {
      backgroundCheckSynced: 7,
      backgroundCheckSyncFailed: 0,
      medicalNotesSynced: 5,
      medicalNotesSyncFailed: 0,
    };

    const finished = await finishRun({
      churchId, provider: 'planning_center', runId: run.id, status: 'applied', counts,
    });

    assert.deepEqual(finished.counts, counts);
    assert.deepEqual((await listRecentRuns(churchId, 'planning_center'))[0].counts, counts);
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
      finishRun({ churchId, provider: 'elvanto', runId: run.id, status: 'applied', counts: { linkPeople: { authorization: 'Bearer secret' } } }),
      /credential|count/i
    );
    await assert.rejects(
      failRun({ churchId, provider: 'elvanto', runId: run.id, errorCode: 'UPSTREAM', errorMessage: 'failed', rawPayload: { nested: { apiKey: 'secret' } } }),
      /allowlisted|credential/i
    );
  });
});

test('review fingerprints accept only lowercase SHA-256 and are read by church/provider', async () => {
  await withTestChurchDb(async (churchId) => {
    const run = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    const fingerprint = 'a'.repeat(64);
    await setReviewNotificationFingerprint(run.id, churchId, 'elvanto', fingerprint);
    assert.equal(await findLatestReviewNotificationFingerprint(churchId, 'elvanto'), fingerprint);
    assert.equal(await findLatestReviewNotificationFingerprint(churchId, 'planning_center'), null);
    await assert.rejects(setReviewNotificationFingerprint(run.id, churchId, 'elvanto', 'A'.repeat(64)), /lowercase SHA-256/i);
  });
});

test('failed runs retain only safe error fields', async () => {
  await withTestChurchDb(async (churchId) => {
    const run = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    const failed = await failRun({ churchId, provider: 'elvanto', runId: run.id, errorCode: 'UPSTREAM_UNAVAILABLE', errorMessage: 'Upstream\n temporarily unavailable' });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'UPSTREAM_UNAVAILABLE');
    assert.equal(failed.errorMessage, 'Upstream temporarily unavailable');
  });
});

test('run mutations require the matching provider and preserve the foreign-provider run', async () => {
  await withTestChurchDb(async (churchId) => {
    const run = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    await assert.rejects(
      finishRun({ churchId, provider: 'planning_center', runId: run.id, status: 'applied', counts: {} }),
      /not available for this church and provider/i
    );
    await assert.rejects(
      failRun({ churchId, provider: 'planning_center', runId: run.id, errorCode: 'UPSTREAM_UNAVAILABLE', errorMessage: 'Upstream unavailable' }),
      /not available for this church and provider/i
    );
    await assert.rejects(
      setReviewNotificationFingerprint(run.id, churchId, 'planning_center', 'a'.repeat(64)),
      /not available for this church and provider/i
    );
    assert.equal((await listRecentRuns(churchId, 'elvanto'))[0].status, 'running');
  });
});

test('terminal runs cannot be rewritten and terminal fields remain mutually consistent', async () => {
  await withTestChurchDb(async (churchId) => {
    const applied = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    const appliedResult = await finishRun({ churchId, provider: 'elvanto', runId: applied.id, status: 'applied', counts: { addPeople: 1 }, externalWatermark: 'watermark-1' });
    assert.equal(appliedResult.errorCode, null);
    assert.equal(appliedResult.errorMessage, null);
    await assert.rejects(
      failRun({ churchId, provider: 'elvanto', runId: applied.id, errorCode: 'UPSTREAM_UNAVAILABLE', errorMessage: 'Upstream unavailable' }),
      /only running/i
    );
    await assert.rejects(
      finishRun({ churchId, provider: 'elvanto', runId: applied.id, status: 'review_required', counts: {} }),
      /only running/i
    );

    const failed = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    const failedResult = await failRun({ churchId, provider: 'elvanto', runId: failed.id, errorCode: 'UPSTREAM_UNAVAILABLE', errorMessage: 'Upstream unavailable' });
    assert.deepEqual(failedResult.counts, {});
    assert.equal(failedResult.externalWatermark, null);
    await assert.rejects(
      finishRun({ churchId, provider: 'elvanto', runId: failed.id, status: 'applied', counts: {} }),
      /only running/i
    );
  });
});

test('audit errors and watermarks reject secret-shaped or raw serialized strings before persistence', async () => {
  await withTestChurchDb(async (churchId) => {
    const errorRun = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    await assert.rejects(
      failRun({ churchId, provider: 'elvanto', runId: errorRun.id, errorCode: 'UPSTREAM', errorMessage: JSON.stringify({ people: [{ id: 'person-1' }] }) }),
      /serialized payload/i
    );
    const bearerRun = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    await assert.rejects(
      failRun({ churchId, provider: 'elvanto', runId: bearerRun.id, errorCode: 'UPSTREAM', errorMessage: 'Authorization: Bearer super-secret' }),
      /credential-shaped/i
    );
    const watermarkRun = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    await assert.rejects(
      finishRun({ churchId, provider: 'elvanto', runId: watermarkRun.id, status: 'applied', counts: {}, externalWatermark: 'Basic dXNlcjpzZWNyZXQ=' }),
      /credential-shaped/i
    );
    const invalidCodeRun = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    await assert.rejects(
      failRun({ churchId, provider: 'elvanto', runId: invalidCodeRun.id, errorCode: 'upstream failure', errorMessage: 'Upstream unavailable' }),
      /UPPER_SNAKE_CASE/i
    );
    assert.equal((await listRecentRuns(churchId, 'elvanto')).every((run) => run.status === 'running'), true);
  });
});

test('malformed stored run counts are returned as an empty safe projection', async () => {
  await withTestChurchDb(async (churchId) => {
    const run = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    await Database.query('UPDATE people_sync_runs SET counts = ? WHERE id = ? AND church_id = ? AND provider = ?', ['{malformed', run.id, churchId, 'elvanto']);
    assert.deepEqual((await listRecentRuns(churchId, 'elvanto'))[0].counts, {});
  });
});

function provenance(overrides = {}) {
  return {
    batchId: 1,
    sourceKind: 'elvanto_group',
    sourceExternalId: 'group-1',
    sourceName: 'Members',
    memberCount: 2,
    providerRefreshedAt: null,
    fetchedAt: '2026-07-29T01:00:00.000Z',
    snapshotDigest: 'a'.repeat(64),
    ...overrides,
  };
}

test('finished runs persist and return only validated source provenance fields', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await createBatch({
      churchId, provider: 'elvanto', name: 'Members',
      initialDraftSource: { kind: 'elvanto_group', externalId: 'group-1', name: 'Members' },
    });
    const entry = provenance({ batchId: batch.id });
    const run = await startRun({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual', fetchMode: 'full' });
    const finished = await finishRun({
      churchId, provider: 'elvanto', runId: run.id, status: 'applied', counts: {}, sourceProvenance: [entry],
    });
    assert.deepEqual(finished.sourceProvenance, [entry]);
    assert.deepEqual((await listRecentRuns(churchId, 'elvanto'))[0].sourceProvenance, [entry]);
    const columns = await Database.query('PRAGMA table_info(people_sync_runs)');
    assert.equal(columns.some((column) => column.name === 'source_provenance'), true);
  });
});

test('one-time imports persist batchless all-people and provider-owned source provenance', async () => {
  await withTestChurchDb(async (churchId) => {
    const cases = [
      {
        provider: 'elvanto', sourceKind: 'all', sourceExternalId: 'all', sourceName: 'All people',
      },
      {
        provider: 'planning_center', sourceKind: 'planning_center_list',
        sourceExternalId: 'list-7', sourceName: 'Members',
      },
      {
        provider: 'elvanto', sourceKind: 'elvanto_category',
        sourceExternalId: 'category-8', sourceName: 'Adults',
      },
      {
        provider: 'elvanto', sourceKind: 'elvanto_group',
        sourceExternalId: 'group-9', sourceName: 'Youth',
      },
    ];
    for (const value of cases) {
      const { provider, ...source } = value;
      const entry = provenance({ batchId: null, ...source });
      const run = await startRun({
        churchId, provider, batchId: null, trigger: 'people_import', fetchMode: 'full',
      });
      const finished = await finishRun({
        churchId, provider, runId: run.id, status: 'applied', counts: {}, sourceProvenance: [entry],
      });

      assert.equal(finished.trigger, 'people_import');
      assert.equal(finished.batchId, null);
      assert.deepEqual(finished.sourceProvenance, [entry]);
    }
  });
});

test('one-time import provenance rejects source kinds owned by another provider', async () => {
  await withTestChurchDb(async (churchId) => {
    for (const invalid of [
      { provider: 'planning_center', sourceKind: 'elvanto_group' },
      { provider: 'elvanto', sourceKind: 'planning_center_list' },
      { provider: 'elvanto', sourceKind: 'unknown_source' },
    ]) {
      const run = await startRun({
        churchId, provider: invalid.provider, batchId: null, trigger: 'people_import', fetchMode: 'full',
      });
      await assert.rejects(
        finishRun({
          churchId,
          provider: invalid.provider,
          runId: run.id,
          status: 'applied',
          counts: {},
          sourceProvenance: [provenance({
            batchId: null, sourceKind: invalid.sourceKind, sourceExternalId: 'wrong-kind',
          })],
        }),
        /source provenance.*invalid/i
      );
    }
  });
});

test('ordinary sync provenance still rejects every batchless source kind', async () => {
  await withTestChurchDb(async (churchId) => {
    for (const sourceKind of ['all', 'elvanto_group', 'elvanto_category']) {
      const run = await startRun({
        churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full',
      });
      await assert.rejects(
        finishRun({
          churchId,
          provider: 'elvanto',
          runId: run.id,
          status: 'applied',
          counts: {},
          sourceProvenance: [provenance({ batchId: null, sourceKind })],
        }),
        /source provenance.*invalid|positive batch|people import/i
      );
    }
  });
});

test('source provenance rejects extra keys, raw people, credentials, and oversized values', async () => {
  await withTestChurchDb(async (churchId) => {
    const invalidPayloads = [
      [provenance({ unexpected: true })],
      [provenance({ people: [{ id: 'person-1' }] })],
      [provenance({ credentials: { apiKey: 'secret' } })],
      [provenance({ sourceName: 'x'.repeat(40_000) })],
      Array.from({ length: 101 }, (_, index) => provenance({ batchId: index + 1 })),
      Array.from({ length: 100 }, (_, index) => provenance({ batchId: index + 1, sourceName: 'x'.repeat(400) })),
    ];
    for (const sourceProvenance of invalidPayloads) {
      const run = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
      await assert.rejects(
        finishRun({ churchId, provider: 'elvanto', runId: run.id, status: 'applied', counts: {}, sourceProvenance }),
        /provenance|allowlisted|credential|size-bounded|too (?:long|large)/i
      );
    }
  });
});

test('malformed stored source provenance is returned as an empty safe projection', async () => {
  await withTestChurchDb(async (churchId) => {
    const run = await startRun({ churchId, provider: 'elvanto', batchId: null, trigger: 'manual', fetchMode: 'full' });
    await Database.query('UPDATE people_sync_runs SET source_provenance = ? WHERE id = ? AND church_id = ?', ['{malformed', run.id, churchId]);
    assert.deepEqual((await listRecentRuns(churchId, 'elvanto'))[0].sourceProvenance, []);
  });
});
