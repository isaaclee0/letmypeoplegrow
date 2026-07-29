const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const pcoSync = require('./planningCenterSync');
const { PcoSourceError } = require('./planningCenter/readClient');

test('isDueToday retains daily, weekly, and monthly scheduling semantics', () => {
  assert.equal(pcoSync.isDueToday('daily', 1, new Date('2026-07-06T02:00:00')), true);
  assert.equal(pcoSync.isDueToday('weekly', 1, new Date('2026-07-06T02:00:00')), true);
  assert.equal(pcoSync.isDueToday('weekly', 1, new Date('2026-07-07T02:00:00')), false);
  assert.equal(pcoSync.isDueToday('monthly', 31, new Date('2026-04-30T02:00:00')), true);
});

test('Planning Center batches persist only a provider-owned source draft', async () => {
  await withTestChurchDb(async (churchId) => {
    const created = await pcoSync.createBatch(churchId, {
      name: 'Youth',
      initialDraftSource: { kind: 'planning_center_list', externalId: 'list-1', name: 'Youth list' },
      defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
    });
    assert.deepEqual(created.draftSource, { kind: 'planning_center_list', externalId: 'list-1', name: 'Youth list' });
    assert.equal(created.needsSourceReview, true);
    const row = (await Database.query(
      'SELECT source_kind, draft_source_kind FROM people_sync_batches WHERE id = ? AND church_id = ?', [created.id, churchId]
    ))[0];
    assert.equal(row.source_kind, null);
    assert.equal(row.draft_source_kind, 'planning_center_list');
  });
});

test('withPlanningCenterSourceToken force-refreshes once after a source 401', async () => {
  const originalGetAccessTokenForChurch = pcoSync.getAccessTokenForChurch;
  const tokenCalls = [];
  let sourceReadAttempts = 0;
  pcoSync.getAccessTokenForChurch = async (_churchId, options) => {
    tokenCalls.push(options || {});
    return tokenCalls.length === 1 ? 'old-access' : 'new-access';
  };

  try {
    const result = await pcoSync.withPlanningCenterSourceToken('church-a', async (accessToken) => {
      sourceReadAttempts++;
      if (sourceReadAttempts === 1) {
        assert.equal(accessToken, 'old-access');
        throw new PcoSourceError('rejected', 'SYNC_SOURCE_AUTH', { status: 401 });
      }
      assert.equal(accessToken, 'new-access');
      return 'snapshot';
    });

    assert.equal(result, 'snapshot');
    assert.equal(sourceReadAttempts, 2);
    assert.deepEqual(tokenCalls, [{}, { forceRefresh: true }]);
  } finally {
    pcoSync.getAccessTokenForChurch = originalGetAccessTokenForChurch;
  }
});

test('withPlanningCenterSourceToken converts a thrown forced refresh to a safe source authentication error', async () => {
  const originalGetAccessTokenForChurch = pcoSync.getAccessTokenForChurch;
  const tokenCalls = [];
  let sourceReadAttempts = 0;
  pcoSync.getAccessTokenForChurch = async (_churchId, options) => {
    tokenCalls.push(options || {});
    if (options && options.forceRefresh) throw new Error('refresh transport failed');
    return 'old-access';
  };

  try {
    await assert.rejects(
      () => pcoSync.withPlanningCenterSourceToken('church-a', async () => {
        sourceReadAttempts++;
        throw new PcoSourceError('rejected', 'SYNC_SOURCE_AUTH', { status: 401 });
      }),
      (error) => error instanceof PcoSourceError && error.code === 'SYNC_SOURCE_AUTH'
    );
    assert.equal(sourceReadAttempts, 1);
    assert.deepEqual(tokenCalls, [{}, { forceRefresh: true }]);
  } finally {
    pcoSync.getAccessTokenForChurch = originalGetAccessTokenForChurch;
  }
});

test('withPlanningCenterSourceToken does not rotate credentials for a lookalike 401 error', async () => {
  const originalGetAccessTokenForChurch = pcoSync.getAccessTokenForChurch;
  const tokenCalls = [];
  const lookalike = Object.assign(new Error('not a PCO source error'), { details: { status: 401 } });
  pcoSync.getAccessTokenForChurch = async (_churchId, options) => {
    tokenCalls.push(options || {});
    return 'old-access';
  };

  try {
    await assert.rejects(
      () => pcoSync.withPlanningCenterSourceToken('church-a', async () => { throw lookalike; }),
      (error) => error === lookalike
    );
    assert.deepEqual(tokenCalls, [{}]);
  } finally {
    pcoSync.getAccessTokenForChurch = originalGetAccessTokenForChurch;
  }
});
