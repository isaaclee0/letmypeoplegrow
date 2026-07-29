'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createElvantoAdapter } = require('./adapter');

function adapter(deps = {}) {
  return createElvantoAdapter({
    validateConnection: async () => ({ ok: true }),
    listSources: async () => [],
    fetchSourceSnapshot: async () => ({ provider: 'elvanto', complete: true, people: [] }),
    ...deps,
  });
}

test('createElvantoAdapter exposes only the source-era Elvanto contract', () => {
  const value = adapter();
  assert.deepEqual(Object.getOwnPropertyNames(value).sort(), [
    'fetchSourceSnapshot', 'isLifecycleEligible', 'listSources', 'provider', 'validateConnection',
  ]);
  assert.equal(value.provider, 'elvanto');
});

test('listSources delegates just the configured Elvanto credentials', async () => {
  let received;
  const value = adapter({ listSources: async (options) => {
    received = options;
    return [{ kind: 'elvanto_category', externalId: 'cat-1', name: 'Members', memberCount: null, providerRefreshedAt: null }];
  } });
  assert.equal((await value.listSources({ churchId: 'church-a', credentials: { apiKey: 'secret' } }))[0].externalId, 'cat-1');
  assert.deepEqual(received, { apiKey: 'secret' });
});

test('fetchSourceSnapshot delegates the stable Elvanto source identity', async () => {
  let received;
  const snapshot = { provider: 'elvanto', complete: true, people: [{ id: 'p1' }], memberExternalIds: ['p1'] };
  const value = adapter({ fetchSourceSnapshot: async (options) => { received = options; return snapshot; } });
  assert.equal(await value.fetchSourceSnapshot({
    churchId: 'church-a', credentials: { apiKey: 'secret' }, sourceKind: 'elvanto_group', sourceExternalId: 'group-1',
  }), snapshot);
  assert.deepEqual(received, { apiKey: 'secret', sourceKind: 'elvanto_group', sourceExternalId: 'group-1' });
});

test('lifecycle eligibility excludes terminal people and optionally contacts', () => {
  const value = adapter();
  assert.equal(value.isLifecycleEligible({ state: 'archived' }, { includeContacts: true }), false);
  assert.equal(value.isLifecycleEligible({ state: 'deceased' }, { includeContacts: true }), false);
  assert.equal(value.isLifecycleEligible({ state: 'contact' }, { includeContacts: false }), false);
  assert.equal(value.isLifecycleEligible({ state: 'contact' }), true);
  assert.equal(value.isLifecycleEligible({ state: 'active' }, { includeContacts: false }), true);
});

test('validateConnection delegates the raw API key without exposing it through the source methods', async () => {
  let received;
  const value = adapter({ validateConnection: async (apiKey) => { received = apiKey; return { ok: true }; } });
  assert.deepEqual(await value.validateConnection({ credentials: { apiKey: 'secret' } }), { ok: true });
  assert.equal(received, 'secret');
});
