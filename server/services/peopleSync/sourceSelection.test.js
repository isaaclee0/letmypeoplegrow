'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSourceResolver } = require('./sourceSelection');

const source = {
  kind: 'planning_center_list', externalId: 'list-42', name: 'Provider supplied name',
  memberCount: 23, providerRefreshedAt: '2026-07-29T01:02:03.000Z',
};

test('resolveVisibleSource loads church credentials and returns the exact matching provider source DTO', async () => {
  const calls = [];
  const resolveVisibleSource = createSourceResolver({
    getCredentials: async (churchId, provider) => {
      calls.push({ churchId, provider });
      return { accessToken: 'secret' };
    },
    getProvider: () => ({
      listSources: async (input) => {
        calls.push(input);
        return [source, { ...source, externalId: 'other' }];
      },
    }),
  });

  const result = await resolveVisibleSource({
    churchId: 'church-a', provider: 'planning_center', sourceKind: 'planning_center_list', sourceExternalId: 'list-42',
  });

  assert.equal(result, source);
  assert.deepEqual(calls, [
    { churchId: 'church-a', provider: 'planning_center' },
    { churchId: 'church-a', credentials: { accessToken: 'secret' } },
  ]);
});

test('resolveVisibleSource rejects an absent, mismatched, or unconnected source with a credential-safe error', async () => {
  const unavailable = createSourceResolver({
    getCredentials: async () => null,
    getProvider: () => ({ listSources: async () => { throw new Error('must not be called'); } }),
  });
  const mismatched = createSourceResolver({
    getCredentials: async () => ({ apiKey: 'secret' }),
    getProvider: () => ({ listSources: async () => [{ kind: 'elvanto_group', externalId: 'group-7', name: 'Internal', memberCount: null, providerRefreshedAt: null }] }),
  });

  for (const resolveVisibleSource of [unavailable, mismatched]) {
    await assert.rejects(
      resolveVisibleSource({ churchId: 'church-a', provider: 'elvanto', sourceKind: 'elvanto_category', sourceExternalId: 'category-1', name: 'Client supplied lie' }),
      (error) => error.code === 'SYNC_SOURCE_UNAVAILABLE' && !/secret|Client supplied lie|Internal/.test(error.message)
    );
  }
});

test('resolveVisibleSource never turns provider failures into a response containing provider detail', async () => {
  const resolveVisibleSource = createSourceResolver({
    getCredentials: async () => ({ accessToken: 'secret' }),
    getProvider: () => ({ listSources: async () => { throw new Error('token secret rejected by provider.example'); } }),
  });
  await assert.rejects(
    resolveVisibleSource({ churchId: 'church-a', provider: 'planning_center', sourceKind: 'planning_center_list', sourceExternalId: '42' }),
    (error) => error.code === 'SYNC_SOURCE_UNAVAILABLE' && !/secret|provider\.example/.test(error.message)
  );
});
