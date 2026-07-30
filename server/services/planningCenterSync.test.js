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

test('withPlanningCenterSourceToken keeps an unexpected forced-refresh failure transient', async () => {
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
      (error) => error instanceof PcoSourceError && error.code === 'SYNC_SOURCE_CHECK_FAILED'
    );
    assert.equal(sourceReadAttempts, 1);
    assert.deepEqual(tokenCalls, [{}, { forceRefresh: true }]);
  } finally {
    pcoSync.getAccessTokenForChurch = originalGetAccessTokenForChurch;
  }
});

test('withPlanningCenterSourceToken preserves a rate-limited token refresh outcome', async () => {
  const originalGetAccessTokenForChurch = pcoSync.getAccessTokenForChurch;
  pcoSync.getAccessTokenForChurch = async (_churchId, options) => {
    if (options?.forceRefresh) {
      throw new PcoSourceError('token endpoint rate limited', 'SYNC_SOURCE_RATE_LIMIT', { status: 429 });
    }
    return 'old-access';
  };

  try {
    await assert.rejects(
      () => pcoSync.withPlanningCenterSourceToken('church-a', async () => {
        throw new PcoSourceError('rejected', 'SYNC_SOURCE_AUTH', { status: 401 });
      }),
      (error) => error instanceof PcoSourceError &&
        error.code === 'SYNC_SOURCE_RATE_LIMIT' && error.details.status === 429
    );
  } finally {
    pcoSync.getAccessTokenForChurch = originalGetAccessTokenForChurch;
  }
});

test('token refresh classifies endpoint rate limits, outages, and transport failures as transient', async () => {
  const cases = [
    { label: 'rate limit', request: async () => ({ status: 429, data: {} }), code: 'SYNC_SOURCE_RATE_LIMIT', status: 429 },
    { label: 'server outage', request: async () => ({ status: 503, data: {} }), code: 'SYNC_SOURCE_CHECK_FAILED', status: 503 },
    { label: 'transport failure', request: async () => { throw new Error('socket reset'); }, code: 'SYNC_SOURCE_CHECK_FAILED', status: undefined },
  ];

  for (const scenario of cases) {
    await assert.rejects(
      () => pcoSync.requestPcoTokenRefresh('expired-refresh', scenario.request),
      (error) => {
        assert.equal(error instanceof PcoSourceError, true, scenario.label);
        assert.equal(error.code, scenario.code, scenario.label);
        assert.equal(error.details.status, scenario.status, scenario.label);
        return true;
      }
    );
  }
});

test('token refresh classifies an invalid grant as rejected credentials', async () => {
  await assert.rejects(
    () => pcoSync.requestPcoTokenRefresh('revoked-refresh', async () => ({
      status: 400,
      data: { error: 'invalid_grant', error_description: 'The refresh token was revoked' },
    })),
    (error) => error instanceof PcoSourceError &&
      error.code === 'SYNC_SOURCE_AUTH' && error.details.status === 400
  );
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
