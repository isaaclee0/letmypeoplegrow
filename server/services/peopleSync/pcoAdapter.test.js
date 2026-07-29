'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPcoAdapter } = require('./pcoAdapter');

function adapter(deps = {}) {
  return createPcoAdapter({
    getAccessTokenForChurch: async () => 'fresh-token',
    validateToken: async () => ({ connected: true, accountName: 'Test Church' }),
    listSources: async () => [],
    fetchSourceSnapshot: async () => ({ complete: true, people: [] }),
    ...deps,
  });
}

test('createPcoAdapter exposes only the source-era Planning Center contract', () => {
  const value = adapter();
  assert.deepEqual(Object.getOwnPropertyNames(value).sort(), [
    'fetchSourceSnapshot', 'isLifecycleEligible', 'listSources', 'provider', 'validateConnection',
  ]);
  assert.equal(value.provider, 'planning_center');
});

test('listSources obtains a fresh church token through the shared refresh manager', async () => {
  let received;
  const tokenChurches = [];
  const value = adapter({
    getAccessTokenForChurch: async (churchId) => { tokenChurches.push(churchId); return 'rotated-token'; },
    listSources: async (options) => {
    received = options;
    return [{ kind: 'planning_center_list', externalId: '42', name: 'Sunday', memberCount: 1, providerRefreshedAt: null }];
  } });
  const result = await value.listSources({ churchId: 'church-a', credentials: { accessToken: 'stale-token' } });
  assert.deepEqual(tokenChurches, ['church-a']);
  assert.deepEqual(received, { accessToken: 'rotated-token' });
  assert.equal(result[0].externalId, '42');
});

test('fetchSourceSnapshot obtains a fresh church token and delegates stable source identity', async () => {
  let received;
  const snapshot = { provider: 'planning_center', complete: true, people: [{ id: 'p1' }], memberExternalIds: ['p1'] };
  const value = adapter({
    getAccessTokenForChurch: async () => 'rotated-token',
    fetchSourceSnapshot: async (options) => { received = options; return snapshot; },
  });
  const result = await value.fetchSourceSnapshot({
    churchId: 'church-a', credentials: { accessToken: 'stale-token' },
    sourceKind: 'planning_center_list', sourceExternalId: '42',
  });
  assert.deepEqual(received, { accessToken: 'rotated-token', sourceKind: 'planning_center_list', sourceExternalId: '42' });
  assert.equal(result, snapshot);
});

test('source reads fail as authentication errors when the shared refresh manager has no usable token', async () => {
  const value = adapter({ getAccessTokenForChurch: async () => null });
  await assert.rejects(
    () => value.listSources({ churchId: 'church-a', credentials: { accessToken: 'stale-token' } }),
    (error) => error.code === 'SYNC_SOURCE_AUTH' && !error.message.includes('stale-token')
  );
});

test('isLifecycleEligible excludes non-active Planning Center people without a configurable local filter', () => {
  const value = adapter();
  assert.equal(value.isLifecycleEligible({ state: 'active' }), true);
  assert.equal(value.isLifecycleEligible({ status: 'active' }), true);
  assert.equal(value.isLifecycleEligible({ state: 'archived' }), false);
  assert.equal(value.isLifecycleEligible({ status: 'inactive' }), false);
});

test('validateConnection delegates to the injected validator with the access token', async () => {
  const seen = [];
  const value = adapter({ validateToken: async (accessToken) => { seen.push(accessToken); return { connected: true }; } });
  assert.deepEqual(await value.validateConnection({ credentials: { accessToken: 'secret' } }), { connected: true });
  assert.deepEqual(seen, ['secret']);
});
