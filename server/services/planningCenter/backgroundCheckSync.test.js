'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchBackgroundCheckSnapshot,
  refreshBackgroundCheckStatuses,
  invalidateBackgroundCheckStatusCache,
} = require('./backgroundCheckSync');

const API = 'https://api.planningcenteronline.com/people/v2';
const response = (status, data, headers = {}) => ({ status, data, headers });

test('fetchBackgroundCheckSnapshot reads every People page without includes', async () => {
  const calls = [];
  const pages = new Map([
    [`${API}/people?per_page=100`, response(200, {
      data: [
        { type: 'Person', id: 'p2', attributes: { passed_background_check: false } },
        { type: 'Person', id: 'p1', attributes: { passed_background_check: true } },
      ],
      links: { next: `${API}/people?page=2` },
    })],
    [`${API}/people?page=2`, response(200, {
      data: [
        { type: 'Person', id: 'p3', attributes: {} },
      ],
      links: { next: null },
    })],
  ]);

  const snapshot = await fetchBackgroundCheckSnapshot({
    accessToken: 'secret',
    request: async (request) => {
      calls.push(request);
      return pages.get(request.url);
    },
    now: () => new Date('2026-08-03T05:00:00.000Z'),
  });

  assert.deepEqual(snapshot, {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [
      { id: 'p1', passedBackgroundCheck: true },
      { id: 'p2', passedBackgroundCheck: false },
      { id: 'p3', passedBackgroundCheck: null },
    ],
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    `${API}/people?per_page=100`,
    `${API}/people?page=2`,
  ]);
  assert.ok(calls.every(({ url }) => !url.includes('include=')));
  assert.ok(calls.every(({ method }) => method === 'GET'));
});

test('fetchBackgroundCheckSnapshot rejects malformed Person resources', async () => {
  for (const resource of [
    { type: 'Household', id: 'h1', attributes: {} },
    { type: 'Person', attributes: {} },
    { type: 'Person', id: '   ', attributes: {} },
  ]) {
    await assert.rejects(
      fetchBackgroundCheckSnapshot({
        accessToken: 'secret',
        request: async () => response(200, { data: [resource], links: { next: null } }),
      }),
      (error) => error.code === 'SYNC_SOURCE_INCOMPLETE'
    );
  }
});

test('refresh skips token and provider reads when tracking is disabled', async () => {
  invalidateBackgroundCheckStatusCache();
  let tokenReads = 0;
  let providerReads = 0;

  const result = await refreshBackgroundCheckStatuses('church-a', {
    isTrackingEnabled: async () => false,
    withToken: async () => { tokenReads += 1; },
    fetchSnapshot: async () => { providerReads += 1; },
  });

  assert.deepEqual(result, { skipped: 'tracking_disabled', updated: 0 });
  assert.equal(tokenReads, 0);
  assert.equal(providerReads, 0);
});

test('refresh obtains the church token lazily and passes its access token to the provider read', async () => {
  invalidateBackgroundCheckStatusCache();
  const events = [];
  const remoteSnapshot = {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [],
  };

  await refreshBackgroundCheckStatuses('church-token-owner', {
    isTrackingEnabled: async (churchId) => {
      events.push(['tracking', churchId]);
      return true;
    },
    withToken: async (churchId, operation) => {
      events.push(['token', churchId]);
      return operation('church-owner-token');
    },
    fetchSnapshot: async (options) => {
      events.push(['provider', options.accessToken]);
      return remoteSnapshot;
    },
    applySnapshot: async (churchId, snapshot) => {
      events.push(['apply', churchId, snapshot]);
      return { fetchedAt: snapshot.fetchedAt, updated: 0, cleared: 0, notCleared: 0, unknown: 0 };
    },
  });

  assert.deepEqual(events, [
    ['tracking', 'church-token-owner'],
    ['token', 'church-token-owner'],
    ['provider', 'church-owner-token'],
    ['apply', 'church-token-owner', remoteSnapshot],
  ]);
});

test('refresh coalesces concurrent work and re-applies a recent successful snapshot', async () => {
  invalidateBackgroundCheckStatusCache();
  let providerReads = 0;
  let localApplies = 0;
  const remoteSnapshot = {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [{ id: 'p1', passedBackgroundCheck: true }],
  };
  const overrides = {
    isTrackingEnabled: async () => true,
    now: () => 1_000,
    withToken: async (_churchId, operation) => operation('token'),
    fetchSnapshot: async () => { providerReads += 1; return remoteSnapshot; },
    applySnapshot: async () => {
      localApplies += 1;
      return {
        fetchedAt: remoteSnapshot.fetchedAt,
        updated: 1,
        cleared: 1,
        notCleared: 0,
        unknown: 0,
      };
    },
  };

  await Promise.all([
    refreshBackgroundCheckStatuses('church-a', overrides),
    refreshBackgroundCheckStatuses('church-a', overrides),
  ]);
  await refreshBackgroundCheckStatuses('church-a', { ...overrides, now: () => 30_000 });

  assert.equal(providerReads, 1);
  assert.equal(localApplies, 2);
});

test('refresh joins the first apply after the provider fetch has completed', async () => {
  invalidateBackgroundCheckStatusCache();
  let providerReads = 0;
  let localApplies = 0;
  let markFirstApplyStarted;
  let releaseFirstApply;
  const firstApplyStarted = new Promise((resolve) => { markFirstApplyStarted = resolve; });
  const firstApplyRelease = new Promise((resolve) => { releaseFirstApply = resolve; });
  const remoteSnapshot = {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [],
  };
  const applyResult = {
    fetchedAt: remoteSnapshot.fetchedAt,
    updated: 0,
    cleared: 0,
    notCleared: 0,
    unknown: 0,
  };
  const overrides = {
    isTrackingEnabled: async () => true,
    now: () => 1_000,
    withToken: async (_churchId, operation) => operation('token'),
    fetchSnapshot: async () => { providerReads += 1; return remoteSnapshot; },
    applySnapshot: async () => {
      localApplies += 1;
      if (localApplies === 1) {
        markFirstApplyStarted();
        await firstApplyRelease;
      }
      return applyResult;
    },
  };

  const firstRefresh = refreshBackgroundCheckStatuses('church-a', overrides);
  await firstApplyStarted;
  const arrivingRefresh = refreshBackgroundCheckStatuses('church-a', overrides);
  await new Promise((resolve) => setImmediate(resolve));
  const appliesWhileFirstIsActive = localApplies;
  releaseFirstApply();
  const results = await Promise.all([firstRefresh, arrivingRefresh]);

  assert.equal(providerReads, 1);
  assert.equal(appliesWhileFirstIsActive, 1);
  assert.equal(localApplies, 1);
  assert.deepEqual(results, [applyResult, applyResult]);
});

test('invalidation during an active fetch discards stale account work and retries with fresh credentials', async () => {
  invalidateBackgroundCheckStatusCache();
  let currentToken = 'old-account-token';
  const providerReads = [];
  const localApplies = [];
  let markFirstFetchStarted;
  let releaseFirstFetch;
  const firstFetchStarted = new Promise((resolve) => { markFirstFetchStarted = resolve; });
  const firstFetchRelease = new Promise((resolve) => { releaseFirstFetch = resolve; });
  const staleSnapshot = {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [{ id: 'p1', passedBackgroundCheck: false }],
  };
  const freshSnapshot = {
    fetchedAt: '2026-08-03T05:01:00.000Z',
    complete: true,
    people: [{ id: 'p1', passedBackgroundCheck: true }],
  };
  const overrides = {
    isTrackingEnabled: async () => true,
    now: () => 1_000,
    withToken: async (_churchId, operation) => operation(currentToken),
    fetchSnapshot: async ({ accessToken }) => {
      providerReads.push(accessToken);
      if (accessToken === 'old-account-token') {
        markFirstFetchStarted();
        await firstFetchRelease;
        return staleSnapshot;
      }
      return freshSnapshot;
    },
    applySnapshot: async (_churchId, snapshot) => {
      localApplies.push(snapshot);
      return {
        fetchedAt: snapshot.fetchedAt,
        updated: 1,
        cleared: snapshot === freshSnapshot ? 1 : 0,
        notCleared: snapshot === staleSnapshot ? 1 : 0,
        unknown: 0,
      };
    },
  };

  const activeRefresh = refreshBackgroundCheckStatuses('church-a', overrides);
  await firstFetchStarted;
  currentToken = 'fresh-account-token';
  invalidateBackgroundCheckStatusCache('church-a');
  releaseFirstFetch();

  const result = await activeRefresh;

  assert.deepEqual(providerReads, ['old-account-token', 'fresh-account-token']);
  assert.deepEqual(localApplies, [freshSnapshot]);
  assert.deepEqual(result, {
    fetchedAt: freshSnapshot.fetchedAt,
    updated: 1,
    cleared: 1,
    notCleared: 0,
    unknown: 0,
  });
});

test('refresh singleflight is isolated per church', async () => {
  invalidateBackgroundCheckStatusCache();
  const providerReads = [];
  const localApplies = [];
  const remoteSnapshot = {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [],
  };
  const overrides = {
    isTrackingEnabled: async () => true,
    withToken: async (churchId, operation) => operation(`${churchId}-token`),
    fetchSnapshot: async ({ accessToken }) => {
      providerReads.push(accessToken);
      return remoteSnapshot;
    },
    applySnapshot: async (churchId) => {
      localApplies.push(churchId);
      return { fetchedAt: remoteSnapshot.fetchedAt, updated: 0, cleared: 0, notCleared: 0, unknown: 0 };
    },
  };

  await Promise.all([
    refreshBackgroundCheckStatuses('church-a', overrides),
    refreshBackgroundCheckStatuses('church-a', overrides),
    refreshBackgroundCheckStatuses('church-b', overrides),
    refreshBackgroundCheckStatuses('church-b', overrides),
  ]);

  assert.deepEqual(providerReads.sort(), ['church-a-token', 'church-b-token']);
  assert.deepEqual(localApplies.sort(), ['church-a', 'church-b']);
});

test('refresh reuses a snapshot for less than 60 seconds and fetches again at expiry', async () => {
  invalidateBackgroundCheckStatusCache();
  let currentTime = 1_000;
  let providerReads = 0;
  let localApplies = 0;
  const remoteSnapshot = {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [],
  };
  const overrides = {
    isTrackingEnabled: async () => true,
    now: () => currentTime,
    withToken: async (_churchId, operation) => operation('token'),
    fetchSnapshot: async () => { providerReads += 1; return remoteSnapshot; },
    applySnapshot: async () => {
      localApplies += 1;
      return { fetchedAt: remoteSnapshot.fetchedAt, updated: 0, cleared: 0, notCleared: 0, unknown: 0 };
    },
  };

  await refreshBackgroundCheckStatuses('church-a', overrides);
  currentTime = 60_999;
  await refreshBackgroundCheckStatuses('church-a', overrides);
  currentTime = 61_000;
  await refreshBackgroundCheckStatuses('church-a', overrides);

  assert.equal(providerReads, 2);
  assert.equal(localApplies, 3);
});

test('refresh does not cache a failed provider read', async () => {
  invalidateBackgroundCheckStatusCache();
  let providerReads = 0;
  const overrides = {
    isTrackingEnabled: async () => true,
    withToken: async (_churchId, operation) => operation('token'),
    fetchSnapshot: async () => {
      providerReads += 1;
      if (providerReads === 1) throw new Error('temporary PCO failure');
      return {
        fetchedAt: '2026-08-03T05:00:00.000Z',
        complete: true,
        people: [],
      };
    },
    applySnapshot: async () => ({
      fetchedAt: '2026-08-03T05:00:00.000Z',
      updated: 0,
      cleared: 0,
      notCleared: 0,
      unknown: 0,
    }),
  };

  await assert.rejects(
    refreshBackgroundCheckStatuses('church-a', overrides),
    /temporary PCO failure/
  );
  await refreshBackgroundCheckStatuses('church-a', overrides);

  assert.equal(providerReads, 2);
});
