'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { listElvantoSources, fetchElvantoSourceSnapshot, fetchElvantoAllSnapshot } = require('./sourceAdapter');

const CATEGORIES = '/people/categories/getAll.json';
const GROUPS = '/groups/getAll.json';
const PEOPLE = '/people/getAll.json';
const SEARCH = '/people/search.json';

function complete(items) {
  return { items, complete: true, pages: 1, total: items.length };
}

function client({ categories = [], groups = [], people = [], search = [] } = {}) {
  const calls = [];
  return {
    calls,
    async getAll(path, params, collectionKey, itemKey) {
      calls.push({ method: 'GET', path, params, collectionKey, itemKey });
      if (path === CATEGORIES) return complete(categories);
      if (path === GROUPS) return complete(groups);
      if (path === PEOPLE) return complete(people);
      throw new Error(`Unexpected GET collection ${path}`);
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      if (path !== SEARCH) throw new Error(`Unexpected POST ${path}`);
      const page = body.page || 1;
      const pageItems = Array.isArray(search) ? search[page - 1] || [] : [];
      const total = Array.isArray(search) ? search.flat().length : 0;
      return { status: 'ok', people: { total, person: pageItems } };
    },
  };
}

test('enumerates Elvanto Categories and Groups as sorted stable source DTOs', async () => {
  const value = client({
    categories: [{ id: '2', name: 'zebra' }, { id: '1', name: ' Alpha ' }],
    groups: [{ id: '2', name: 'Choir' }, { id: '1', name: 'choir' }],
  });
  const sources = await listElvantoSources({ client: value });

  assert.deepEqual(sources, [
    { kind: 'elvanto_category', externalId: '1', name: 'Alpha', memberCount: null, providerRefreshedAt: null },
    { kind: 'elvanto_category', externalId: '2', name: 'zebra', memberCount: null, providerRefreshedAt: null },
    { kind: 'elvanto_group', externalId: '1', name: 'choir', memberCount: null, providerRefreshedAt: null },
    { kind: 'elvanto_group', externalId: '2', name: 'Choir', memberCount: null, providerRefreshedAt: null },
  ]);
  assert.deepEqual(value.calls.map((call) => call.path), [CATEGORIES, GROUPS]);
});

test('rejects duplicate IDs within an Elvanto source kind without conflating IDs across kinds', async () => {
  await assert.rejects(
    () => listElvantoSources({ client: client({ categories: [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }] }) }),
    (err) => err.code === 'SYNC_SOURCE_INCOMPLETE'
  );
  const sources = await listElvantoSources({ client: client({
    categories: [{ id: 'same', name: 'Category' }], groups: [{ id: 'same', name: 'Group' }],
  }) });
  assert.equal(sources.length, 2);
  assert.notEqual(sources[0].kind, sources[1].kind);
});

test('fetches a complete category source through category_id before normalizing people and families', async () => {
  const value = client({
    categories: [{ id: 'cat-1', name: 'Members' }],
    people: [
      { id: 'p1', firstname: 'Ada', lastname: 'Lovelace', family_id: 'f1', family_relationship: 'Primary Contact' },
      { id: 'p2', firstname: 'Ann', lastname: 'Lovelace', family_id: 'f1', family_relationship: 'Spouse' },
    ],
  });
  const snapshot = await fetchElvantoSourceSnapshot({
    client: value, sourceKind: 'elvanto_category', sourceExternalId: 'cat-1', now: () => new Date('2026-07-29T02:03:04.000Z'),
  });

  assert.deepEqual(snapshot.source, { kind: 'elvanto_category', externalId: 'cat-1', name: 'Members', memberCount: null, providerRefreshedAt: null });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.fetchedAt, '2026-07-29T02:03:04.000Z');
  assert.equal(snapshot.providerRefreshedAt, null);
  assert.deepEqual(snapshot.memberExternalIds, ['p1', 'p2']);
  assert.deepEqual(snapshot.people.map((person) => person.id), ['p1', 'p2']);
  assert.deepEqual(snapshot.families, [{ id: 'f1', name: 'Lovelace, Ada and Ann', memberExternalIds: ['p1', 'p2'], primaryContactExternalId: 'p1' }]);
  assert.deepEqual(value.calls.map((call) => call.path), [CATEGORIES, PEOPLE]);
  assert.deepEqual(value.calls[1].params, { category_id: 'cat-1' });
});

test('fetches every Elvanto person as one normalized all-people snapshot', async () => {
  const value = client({
    people: [
      { id: 'p2', firstname: 'Grace', lastname: 'Hopper', family_id: 'f1', family_relationship: 'Spouse' },
      { id: 'p1', firstname: 'Ada', lastname: 'Lovelace', family_id: 'f1', family_relationship: 'Primary Contact' },
    ],
  });
  const snapshot = await fetchElvantoAllSnapshot({ client: value, now: () => new Date('2026-08-04T00:00:00.000Z') });

  assert.deepEqual(snapshot.source, { kind: 'all', externalId: 'all', name: 'Everyone', memberCount: 2, providerRefreshedAt: null });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.fetchedAt, '2026-08-04T00:00:00.000Z');
  assert.deepEqual(snapshot.memberExternalIds, ['p1', 'p2']);
  assert.deepEqual(snapshot.people.map((person) => person.id), ['p1', 'p2']);
  assert.deepEqual(snapshot.families, [{ id: 'f1', name: 'Lovelace, Ada and Grace', memberExternalIds: ['p1', 'p2'], primaryContactExternalId: 'p1' }]);
  assert.deepEqual(value.calls, [{ method: 'GET', path: PEOPLE, params: {}, collectionKey: 'people', itemKey: 'person' }]);
});

test('fails closed instead of returning a partial all-people snapshot', async () => {
  const value = client();
  value.getAll = async () => ({
    items: [{ id: 'p1', firstname: 'Ada', lastname: 'Lovelace' }], complete: false, pages: 1, total: 2,
  });
  await assert.rejects(
    () => fetchElvantoAllSnapshot({ client: value }),
    (error) => error.code === 'SYNC_SOURCE_INCOMPLETE'
  );
});

test('fetches a selected group with sequential people/search pages and adds only that group as membership context', async () => {
  const value = client({
    groups: [{ id: 'group-1', name: 'Choir' }],
    search: [
      [{ id: 'p1', firstname: 'Ada', lastname: 'Lovelace' }],
      [{ id: 'p2', firstname: 'Grace', lastname: 'Hopper' }],
    ],
  });
  const snapshot = await fetchElvantoSourceSnapshot({ client: value, sourceKind: 'elvanto_group', sourceExternalId: 'group-1' });

  assert.deepEqual(snapshot.memberExternalIds, ['p1', 'p2']);
  assert.deepEqual(snapshot.people.map((person) => person.attributes.groups), [['group-1'], ['group-1']]);
  assert.deepEqual(value.calls.map((call) => call.path), [GROUPS, SEARCH, SEARCH]);
  assert.deepEqual(value.calls.map((call) => call.body && call.body.page), [undefined, 1, 2]);
  assert.ok(value.calls.slice(1).every((call) => call.body['search[groups]'] === 'group-1'));
});

test('fails closed as SYNC_SOURCE_UNAVAILABLE before membership for missing, wrong-kind, or unreadable selected sources', async () => {
  const cases = [
    { sourceKind: 'elvanto_category', sourceExternalId: 'missing', value: client({ categories: [] }) },
    { sourceKind: 'elvanto_group', sourceExternalId: 'cat-1', value: client({ categories: [{ id: 'cat-1', name: 'Members' }], groups: [] }) },
    { sourceKind: 'not-elvanto', sourceExternalId: 'x', value: client() },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => fetchElvantoSourceSnapshot({ client: item.value, sourceKind: item.sourceKind, sourceExternalId: item.sourceExternalId }),
      (err) => err.code === 'SYNC_SOURCE_UNAVAILABLE'
    );
    assert.equal(item.value.calls.some((call) => call.path === PEOPLE || call.path === SEARCH), false);
  }
});

test('maps a selected source permission loss to SYNC_SOURCE_UNAVAILABLE without attempting membership', async () => {
  const calls = [];
  await assert.rejects(
    () => fetchElvantoSourceSnapshot({
      apiKey: 'key', sourceKind: 'elvanto_category', sourceExternalId: 'cat-1', sleep: async () => {},
      request: async ({ path }) => {
        calls.push(path);
        if (path === CATEGORIES) {
          return { status: 200, data: { status: 'ok', categories: { total: 1, category: { id: 'cat-1', name: 'Members' } } } };
        }
        return { status: 403, data: { status: 'error' } };
      },
    }),
    (err) => err.code === 'SYNC_SOURCE_UNAVAILABLE'
  );
  assert.deepEqual(calls, [CATEGORIES, PEOPLE]);
});

test('keeps a real-client account-wide 403 during selected-source resolution as SYNC_SOURCE_AUTH', async () => {
  const calls = [];
  await assert.rejects(
    () => fetchElvantoSourceSnapshot({
      apiKey: 'key', sourceKind: 'elvanto_category', sourceExternalId: 'cat-1', sleep: async () => {},
      request: async ({ path }) => {
        calls.push(path);
        return { status: 403, data: { status: 'error' } };
      },
    }),
    (err) => err.code === 'SYNC_SOURCE_AUTH'
  );
  assert.deepEqual(calls, [CATEGORIES]);
});

test('accepts an empty complete Elvanto source and never returns a partial snapshot after a membership failure', async () => {
  const empty = await fetchElvantoSourceSnapshot({
    client: client({ categories: [{ id: 'empty', name: 'Empty' }], people: [] }),
    sourceKind: 'elvanto_category', sourceExternalId: 'empty', now: () => new Date('2026-07-29T00:00:00.000Z'),
  });
  assert.deepEqual(empty.people, []);
  assert.deepEqual(empty.families, []);
  assert.deepEqual(empty.memberExternalIds, []);

  const failed = client({ categories: [{ id: 'cat-1', name: 'Members' }] });
  failed.getAll = async (path, params, collectionKey, itemKey) => {
    failed.calls.push({ method: 'GET', path, params, collectionKey, itemKey });
    if (path === CATEGORIES) return complete([{ id: 'cat-1', name: 'Members' }]);
    throw Object.assign(new Error('later page failed'), { code: 'ELVANTO_UNAVAILABLE' });
  };
  await assert.rejects(
    () => fetchElvantoSourceSnapshot({ client: failed, sourceKind: 'elvanto_category', sourceExternalId: 'cat-1' }),
    (err) => err.code === 'SYNC_SOURCE_CHECK_FAILED'
  );
});

test('fails closed when any source member is skipped or has a duplicate stable ID during normalization', async () => {
  for (const people of [
    [{ id: 'p1', firstname: '', lastname: '' }],
    [{ firstname: 'No', lastname: 'Identifier' }],
    [
      { id: 'p1', firstname: 'Ada', lastname: 'Lovelace' },
      { id: 'p1', firstname: 'Duplicate', lastname: 'Record' },
    ],
  ]) {
    await assert.rejects(
      () => fetchElvantoSourceSnapshot({
        client: client({ categories: [{ id: 'cat-1', name: 'Members' }], people }),
        sourceKind: 'elvanto_category', sourceExternalId: 'cat-1',
      }),
      (error) => error.code === 'SYNC_SOURCE_INCOMPLETE'
    );
  }

  const malformedCollection = client({ categories: [{ id: 'cat-1', name: 'Members' }] });
  const originalGetAll = malformedCollection.getAll;
  malformedCollection.getAll = async (...args) => args[0] === PEOPLE
    ? { items: null, complete: true, pages: 1, total: 1 }
    : originalGetAll(...args);
  await assert.rejects(
    () => fetchElvantoSourceSnapshot({
      client: malformedCollection, sourceKind: 'elvanto_category', sourceExternalId: 'cat-1',
    }),
    (error) => error.code === 'SYNC_SOURCE_INCOMPLETE'
  );
});

test('classifies exhausted transport, rate-limit, and server failures as health errors rather than missing sources', async () => {
  const cases = [
    {
      name: 'transport', expected: 'SYNC_SOURCE_CHECK_FAILED',
      membershipResponse: async () => { throw new Error('socket reset'); },
    },
    {
      name: 'rate limit', expected: 'SYNC_SOURCE_RATE_LIMIT',
      membershipResponse: async () => ({ status: 429, headers: { 'retry-after': '0' }, data: { status: 'error' } }),
    },
    {
      name: 'server failure', expected: 'SYNC_SOURCE_CHECK_FAILED',
      membershipResponse: async () => ({ status: 503, data: { status: 'error' } }),
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      () => fetchElvantoSourceSnapshot({
        apiKey: 'key', maxRetries: 0, sleep: async () => {},
        sourceKind: 'elvanto_category', sourceExternalId: 'cat-1',
        request: async ({ path }) => path === CATEGORIES
          ? { status: 200, data: { status: 'ok', categories: { total: 1, category: { id: 'cat-1', name: 'Members' } } } }
          : item.membershipResponse(),
      }),
      (error) => error.code === item.expected,
      item.name
    );
  }
});
