const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DEFINITION_ENDPOINTS, fetchElvantoMetadata } = require('./metadata');

const FIXED_NOW = new Date('2026-07-25T00:00:00.000Z').getTime();
const fixedClock = () => FIXED_NOW;

function fakeClient(responsesByKey) {
  const responsesByPath = {};
  const calls = [];
  for (const [key, endpoint] of Object.entries(DEFINITION_ENDPOINTS)) {
    responsesByPath[endpoint.path] = responsesByKey[key] ?? { items: [], complete: true, pages: 1, total: 0 };
  }
  return {
    calls,
    async getAll(path, params, collectionKey, itemKey) {
      calls.push({ path, params, collectionKey, itemKey });
      const response = responsesByPath[path];
      if (response instanceof Error) throw response;
      if (!response) throw new Error(`Unexpected getAll call: ${path}`);
      return response;
    },
  };
}

function items(list) {
  return { items: list, complete: true, pages: 1, total: list.length };
}

function makePerson(id, { groups = [], demographics = [], departments = [] } = {}) {
  return {
    provider: 'elvanto', id, firstName: 'Person', lastName: String(id), state: 'active',
    attributes: { groups, demographics, departments, serviceTypes: [], locations: [], customFields: {} },
  };
}

function exampleSnapshot() {
  const people = [];
  for (let i = 1; i <= 12; i += 1) {
    people.push(makePerson(`p${i}`, {
      groups: ['group-1'],
      demographics: i <= 8 ? [{ field: 'age_bracket', value: 'Young Adults' }] : [],
      departments: i <= 5 ? ['Worship Team'] : [],
    }));
  }
  return {
    people,
    families: [],
    skipped: [],
    definitions: {
      serviceTypes: [{ id: 'service-1', name: 'Sunday AM' }],
      locations: [{ id: 'loc-1', name: 'North Campus' }],
      departments: ['Worship Team'],
    },
  };
}

function exampleResponses() {
  return {
    categories: items([{ id: 'cat-1', name: 'Members' }]),
    groups: items([{ id: 'group-1', name: 'Youth', status: 'Active' }]),
    customFields: items([{
      id: 'field-1',
      name: 'Ministries',
      type: 'select_multi',
      values: { value: [{ id: 'v1', name: 'Golf Guys' }] },
    }]),
  };
}

test('DEFINITION_ENDPOINTS only includes the three verified live endpoints', () => {
  assert.deepEqual(Object.keys(DEFINITION_ENDPOINTS).sort(), ['categories', 'customFields', 'groups']);
  assert.equal(DEFINITION_ENDPOINTS.categories.path, '/people/categories/getAll.json');
  assert.equal(DEFINITION_ENDPOINTS.groups.path, '/groups/getAll.json');
  assert.equal(DEFINITION_ENDPOINTS.customFields.path, '/people/customFields/getAll.json');
  assert.equal(DEFINITION_ENDPOINTS.customFields.collectionKey, 'custom_fields');
  assert.equal(DEFINITION_ENDPOINTS.customFields.itemKey, 'custom_field');
});

test('fetchElvantoMetadata returns the exact normalized metadata shape from the task spec', async () => {
  const client = fakeClient(exampleResponses());
  const metadata = await fetchElvantoMetadata(client, exampleSnapshot(), { now: fixedClock });

  assert.deepEqual(metadata, {
    fetchedAt: '2026-07-25T00:00:00.000Z',
    categories: [{ id: 'cat-1', name: 'Members' }],
    groups: [{ id: 'group-1', name: 'Youth', status: 'Active', memberCount: 12 }],
    demographics: [{ value: 'Young Adults', count: 8 }],
    departments: [{ value: 'Worship Team', count: 5 }],
    serviceTypes: [{ id: 'service-1', name: 'Sunday AM' }],
    locations: [{ id: 'loc-1', name: 'North Campus' }],
    customFields: [{ id: 'field-1', name: 'Ministries', type: 'select_multi', values: [{ id: 'v1', name: 'Golf Guys' }] }],
  });
});

test('fetchElvantoMetadata calls only categories/groups/customFields endpoints', async () => {
  const client = fakeClient(exampleResponses());
  await fetchElvantoMetadata(client, exampleSnapshot(), { now: fixedClock });

  const paths = client.calls.map((c) => c.path).sort();
  assert.deepEqual(paths, [
    '/groups/getAll.json',
    '/people/categories/getAll.json',
    '/people/customFields/getAll.json',
  ].sort());
  for (const path of paths) {
    assert.equal(path.includes('/locations/getAll'), false);
    assert.equal(path.includes('/departments/getAll'), false);
    assert.equal(path.includes('/services/types/getAll'), false);
  }
});

test('fetchElvantoMetadata accepts a bare array of normalized people as the snapshot', async () => {
  const client = fakeClient(exampleResponses());
  const metadata = await fetchElvantoMetadata(client, exampleSnapshot().people, { now: fixedClock });
  assert.equal(metadata.groups[0].memberCount, 12);
  assert.equal(metadata.demographics[0].count, 8);
  assert.deepEqual(metadata.serviceTypes, []);
  assert.deepEqual(metadata.locations, []);
  assert.deepEqual(metadata.departments, []);
});

test('fetchElvantoMetadata returns empty lists when every definition endpoint is empty and there are no people', async () => {
  const client = fakeClient({});
  const metadata = await fetchElvantoMetadata(client, { people: [], families: [], skipped: [] }, { now: fixedClock });
  assert.deepEqual(metadata, {
    fetchedAt: '2026-07-25T00:00:00.000Z',
    categories: [], groups: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [],
  });
});

test('a custom field with a single value arriving as a bare object is normalized the same as a one-element array', async () => {
  const responses = exampleResponses();
  responses.customFields = items([
    { id: 'field-2', name: 'Shirt Size', type: 'select_single', values: { value: { id: 'v9', name: 'Large' } } },
  ]);
  const client = fakeClient(responses);
  const metadata = await fetchElvantoMetadata(client, exampleSnapshot(), { now: fixedClock });
  assert.deepEqual(metadata.customFields.find((f) => f.id === 'field-2').values, [{ id: 'v9', name: 'Large' }]);
});

test('every option list is sorted by case-insensitive label then ID', async () => {
  const responses = exampleResponses();
  responses.categories = items([
    { id: 'cat-2', name: 'zebras' },
    { id: 'cat-3', name: 'Apples' },
    { id: 'cat-1', name: 'apples' },
  ]);
  const client = fakeClient(responses);
  const metadata = await fetchElvantoMetadata(client, exampleSnapshot(), { now: fixedClock });
  assert.deepEqual(metadata.categories.map((c) => c.id), ['cat-1', 'cat-3', 'cat-2']);
});

test('demographics/departments (no ID) sort by their own value', async () => {
  const snapshot = {
    people: [
      makePerson('p1', { demographics: [{ field: 'f', value: 'Zebras' }] }),
      makePerson('p2', { demographics: [{ field: 'f', value: 'apples' }] }),
    ],
    families: [],
    skipped: [],
    definitions: { serviceTypes: [], locations: [], departments: [] },
  };
  const client = fakeClient(exampleResponses());
  const metadata = await fetchElvantoMetadata(client, snapshot, { now: fixedClock });
  assert.deepEqual(metadata.demographics.map((d) => d.value), ['apples', 'Zebras']);
});

function fakeStore(overrides = {}) {
  const calls = { getConnection: [], updateMetadataCache: [] };
  return {
    calls,
    async getConnection(churchId, provider) {
      calls.getConnection.push([churchId, provider]);
      return overrides.connection ?? null;
    },
    async updateMetadataCache(churchId, provider, metadata) {
      calls.updateMetadataCache.push([churchId, provider, metadata]);
      return { metadataCachedAt: '2026-07-25T00:00:00.000Z' };
    },
  };
}

test('fetchElvantoMetadata persists a successful fetch through connectionStore.updateMetadataCache when churchId is given', async () => {
  const client = fakeClient(exampleResponses());
  const store = fakeStore();
  const metadata = await fetchElvantoMetadata(client, exampleSnapshot(), { now: fixedClock, churchId: 'church-1', store });

  assert.equal(store.calls.updateMetadataCache.length, 1);
  const [churchId, provider, cached] = store.calls.updateMetadataCache[0];
  assert.equal(churchId, 'church-1');
  assert.equal(provider, 'elvanto');
  assert.deepEqual(cached, metadata);
  assert.equal(JSON.stringify(cached).includes('firstName'), false);
  assert.equal(JSON.stringify(cached).includes('apiKey'), false);
});

test('fetchElvantoMetadata with no churchId never touches the connection store', async () => {
  const client = fakeClient(exampleResponses());
  const store = fakeStore();
  await fetchElvantoMetadata(client, exampleSnapshot(), { now: fixedClock, store });
  assert.equal(store.calls.getConnection.length, 0);
  assert.equal(store.calls.updateMetadataCache.length, 0);
});

test('fetchElvantoMetadata falls back to a cached snapshot, marked stale, when a refresh fails', async () => {
  const failingClient = {
    async getAll() { throw new Error('Elvanto is down'); },
  };
  const cachedMetadata = { fetchedAt: '2026-07-01T00:00:00.000Z', categories: [{ id: 'cat-1', name: 'Members' }], groups: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [] };
  const store = fakeStore({ connection: { metadata: { syncMetadata: cachedMetadata }, metadataCachedAt: '2026-07-01T00:00:00.000Z' } });

  const result = await fetchElvantoMetadata(failingClient, exampleSnapshot(), { now: fixedClock, churchId: 'church-1', store });

  assert.deepEqual(result, {
    metadata: cachedMetadata, stale: true, refreshing: false, metadataCachedAt: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(store.calls.updateMetadataCache.length, 0);
});

test('fetchElvantoMetadata propagates the failure when a refresh fails and no cache exists', async () => {
  const failingClient = {
    async getAll() { throw new Error('Elvanto is down'); },
  };
  const store = fakeStore({ connection: null });

  await assert.rejects(
    () => fetchElvantoMetadata(failingClient, exampleSnapshot(), { now: fixedClock, churchId: 'church-1', store }),
    /Elvanto is down/
  );
});

test('fetchElvantoMetadata propagates the failure with no churchId at all (pure fetch)', async () => {
  const failingClient = {
    async getAll() { throw new Error('Elvanto is down'); },
  };
  await assert.rejects(() => fetchElvantoMetadata(failingClient, exampleSnapshot(), { now: fixedClock }), /Elvanto is down/);
});
