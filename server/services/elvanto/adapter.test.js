const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createElvantoAdapter, buildPeopleFields, dedupeByIdKeepingNewest, computeWatermark, computeIncrementalSearchCutoff,
} = require('./adapter');
const { createElvantoClient, ELVANTO_AUTH, ELVANTO_UNAVAILABLE } = require('./httpClient');
const { DEFINITION_ENDPOINTS } = require('./metadata');
const { validateAdapter, registerBuiltInProviders } = require('../peopleSync/providerRegistry');
const fixtures = require('./fixtures/people');

const PEOPLE_PATH = '/people/getAll.json';

function itemsResult(list) {
  return { items: list, complete: true, pages: 1, total: list.length };
}

// Records every getAll()/get() call for assertions and serves configurable
// per-endpoint responses. Any DEFINITION_ENDPOINTS dimension not given an
// explicit override defaults to an empty (but successful) page, so a test
// only has to describe the endpoints it actually cares about.
function fakeClient(overrides = {}) {
  const { people = [], errors = {} } = overrides;
  const calls = { getAll: [], get: [] };
  const byPath = { [PEOPLE_PATH]: itemsResult(people) };
  for (const [key, endpoint] of Object.entries(DEFINITION_ENDPOINTS)) {
    byPath[endpoint.path] = itemsResult(overrides[key] || []);
  }
  return {
    calls,
    async getAll(path, params, collectionKey, itemKey) {
      calls.getAll.push({ path, params, collectionKey, itemKey });
      if (errors[path]) throw errors[path];
      const response = byPath[path];
      if (!response) throw new Error(`Unexpected getAll call: ${path}`);
      return response;
    },
    async get(path, params) {
      calls.get.push({ path, params });
      return { status: 'ok' };
    },
  };
}

function elvantoHttpResponse({ status = 200, body = { status: 'ok' } } = {}) {
  return { status, data: body };
}

// ─── Contract shape ─────────────────────────────────────────────────────────

test('createElvantoAdapter satisfies the Task 5 provider contract shape exactly', () => {
  const adapter = createElvantoAdapter();
  assert.equal(adapter.provider, 'elvanto');
  assert.doesNotThrow(() => validateAdapter(adapter));
  assert.deepEqual(Object.getOwnPropertyNames(adapter).sort(), [
    'fetchMetadata', 'fetchSnapshot', 'isEligible', 'provider', 'validateConnection', 'validateFilter',
  ]);
});

test('registerBuiltInProviders registers both providers idempotently (a second call does not throw)', () => {
  assert.doesNotThrow(() => registerBuiltInProviders());
  assert.doesNotThrow(() => registerBuiltInProviders());

  const { getProvider } = require('../peopleSync/providerRegistry');
  assert.equal(getProvider('elvanto').provider, 'elvanto');
  assert.equal(getProvider('planning_center').provider, 'planning_center');
});

// ─── Step 1: connection validation ──────────────────────────────────────────

test('validateConnection sends a small people/getAll request with Basic auth built from the API key', async () => {
  let seenPath;
  let seenParams;
  let seenAuth;
  const adapter = createElvantoAdapter({
    clientFactory: ({ apiKey }) => createElvantoClient({
      apiKey,
      request: async ({ path, params, headers }) => {
        seenPath = path;
        seenParams = params;
        seenAuth = headers.Authorization;
        return elvantoHttpResponse();
      },
    }),
  });

  const result = await adapter.validateConnection({ credentials: { apiKey: 'secret-key-123' } });

  assert.equal(seenPath, PEOPLE_PATH);
  assert.deepEqual(seenParams, { page: 1, page_size: 10 });
  assert.equal(seenAuth, `Basic ${Buffer.from('secret-key-123:x').toString('base64')}`);
  assert.deepEqual(result, { ok: true, metadata: { connectionLabel: 'Connected via API key' } });
});

test('validateConnection rejects a missing API key before making any request', async () => {
  const adapter = createElvantoAdapter({
    clientFactory: ({ apiKey }) => createElvantoClient({
      apiKey,
      request: async () => { throw new Error('a request should never be attempted without an API key'); },
    }),
  });

  await assert.rejects(
    () => adapter.validateConnection({ credentials: {} }),
    (err) => err.code === ELVANTO_AUTH
  );
});

test('validateConnection surfaces ELVANTO_AUTH on a 401/403 response', async () => {
  const adapter = createElvantoAdapter({
    clientFactory: ({ apiKey }) => createElvantoClient({
      apiKey,
      request: async () => elvantoHttpResponse({ status: 401, body: { status: 'error' } }),
    }),
  });

  await assert.rejects(
    () => adapter.validateConnection({ credentials: { apiKey: 'bad-key' } }),
    (err) => err.code === ELVANTO_AUTH
  );
});

test('validateConnection surfaces ELVANTO_UNAVAILABLE on a transport failure (provider outage)', async () => {
  const adapter = createElvantoAdapter({
    clientFactory: ({ apiKey }) => createElvantoClient({
      apiKey,
      request: async () => { throw new Error('ECONNRESET'); },
    }),
  });

  await assert.rejects(
    () => adapter.validateConnection({ credentials: { apiKey: 'a-key' } }),
    (err) => err.code === ELVANTO_UNAVAILABLE
  );
});

test('validateConnection surfaces ELVANTO_UNAVAILABLE on a non-2xx, non-auth status', async () => {
  const adapter = createElvantoAdapter({
    clientFactory: ({ apiKey }) => createElvantoClient({
      apiKey,
      request: async () => elvantoHttpResponse({ status: 500, body: { status: 'error' } }),
    }),
  });

  await assert.rejects(
    () => adapter.validateConnection({ credentials: { apiKey: 'a-key' } }),
    (err) => err.code === ELVANTO_UNAVAILABLE
  );
});

test('validateConnection never lets the submitted API key leak into a thrown error, even when the transport echoes it back', async () => {
  const apiKey = 'super-secret-key-999';
  const adapter = createElvantoAdapter({
    clientFactory: ({ apiKey: key }) => createElvantoClient({
      apiKey: key,
      request: async () => {
        const authValue = Buffer.from(`${key}:x`).toString('base64');
        throw new Error(`upstream proxy rejected Authorization: Basic ${authValue} for key ${key}`);
      },
    }),
  });

  await assert.rejects(
    () => adapter.validateConnection({ credentials: { apiKey } }),
    (err) => {
      assert.equal(err.code, ELVANTO_UNAVAILABLE);
      const serialized = JSON.stringify({ message: err.message, details: err.details });
      assert.equal(serialized.includes(apiKey), false, 'thrown error must never contain the raw API key');
      return true;
    }
  );
});

// ─── Step 2: full snapshot ───────────────────────────────────────────────────

test('fetchSnapshot(full) requests every optional field normalization needs, plus custom_<id> for each configured custom field', async () => {
  const client = fakeClient({ people: [fixtures.activePerson] });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'full', customFieldIds: ['501', 502] });

  const peopleCall = client.calls.getAll.find((c) => c.path === PEOPLE_PATH);
  assert.ok(peopleCall, 'expected a people/getAll.json call');
  const fields = peopleCall.params['fields[]'];
  for (const expected of ['family', 'contact', 'deceased', 'category', 'date_modified', 'demographics']) {
    assert.ok(fields.includes(expected), `expected fields[] to include "${expected}", got ${JSON.stringify(fields)}`);
  }
  assert.ok(fields.includes('custom_501'));
  assert.ok(fields.includes('custom_502'));
});

test('buildPeopleFields deduplicates custom field IDs and coerces numeric IDs to strings', () => {
  const fields = buildPeopleFields(['501', 501, 502]);
  assert.deepEqual(
    fields.filter((f) => f.startsWith('custom_')),
    ['custom_501', 'custom_502']
  );
});

test('fetchSnapshot(full) indexes group/serviceType/location membership by stable container ID, and departments by name (the one exception)', async () => {
  const person = fixtures.activePerson;
  const client = fakeClient({
    people: [person],
    groups: [{ id: 'grp-1', name: 'Choir', people: { person: [{ id: person.id }] } }],
    serviceTypes: [{ id: 'svc-1', name: 'Sunday AM', people: { person: [{ id: person.id }] } }],
    locations: [{ id: 'loc-1', name: 'Main Campus', people: { person: [{ id: person.id }] } }],
    departments: [{ name: 'Worship Team', people: { person: [{ id: person.id }] } }],
  });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  const snapshot = await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'full' });
  const alice = snapshot.people.find((p) => p.id === person.id);

  // *** Explicit self-check: groups/serviceTypes/locations carry the raw
  // container ID ('grp-1'/'svc-1'/'loc-1'), never the display name
  // ('Choir'/'Sunday AM'/'Main Campus'). departments is the one exception
  // and stays name-based ('Worship Team'). ***
  assert.deepEqual(alice.attributes.groups, ['grp-1']);
  assert.deepEqual(alice.attributes.serviceTypes, ['svc-1']);
  assert.deepEqual(alice.attributes.locations, ['loc-1']);
  assert.deepEqual(alice.attributes.departments, ['Worship Team']);
});

test('fetchSnapshot(full) handles a single-member people list arriving as a bare object instead of a one-element array', async () => {
  const person = fixtures.activePerson;
  const client = fakeClient({
    people: [person],
    groups: [{ id: 'grp-solo', name: 'Solo Group', people: { person: { id: person.id } } }],
  });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  const snapshot = await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'full' });
  assert.deepEqual(snapshot.people.find((p) => p.id === person.id).attributes.groups, ['grp-solo']);
});

test('custom field values come back keyed by the custom field ID, not its name', async () => {
  // The value 'v1' is deliberately ID-shaped (matching filter.test.js's/
  // metadata.test.js's own option-ID convention), NOT a display label like
  // 'Blue' — this pins attachCustomFieldMap()'s documented, unconfirmed
  // assumption that Elvanto returns a select-style custom field's value as
  // the selected option's stable ID, not its label (see that function's own
  // header note for why this can't be confirmed from this repo, and why no
  // label-to-ID mapping layer is built on top of an unconfirmed guess).
  const rawPerson = { ...fixtures.person(), id: '3001', firstname: 'Cara', lastname: 'Custom', custom_501: 'v1' };
  const client = fakeClient({ people: [rawPerson] });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  const snapshot = await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'full', customFieldIds: ['501'] });

  const person = snapshot.people.find((p) => p.id === '3001');
  assert.deepEqual(person.attributes.customFields, { 501: 'v1' });
});

test('fetchSnapshot(full) includes Active, Contact, Archived, and Deceased people — none filtered out', async () => {
  const client = fakeClient({
    people: [fixtures.activePerson, fixtures.contactPerson, fixtures.archivedPerson, fixtures.deceasedPerson],
  });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  const snapshot = await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'full' });

  const states = snapshot.people.map((p) => p.state).sort();
  assert.deepEqual(states, ['active', 'archived', 'contact', 'deceased']);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.mode, 'full');
  assert.equal(snapshot.provider, 'elvanto');
});

test('fetchSnapshot(full) throws when a membership dimension page fails, and never resolves with a partial/incomplete result', async () => {
  const client = fakeClient({
    people: [fixtures.activePerson],
    errors: { [DEFINITION_ENDPOINTS.groups.path]: new Error('Elvanto groups outage') },
  });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  await assert.rejects(
    () => adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'full' }),
    /groups outage/
  );
});

test('fetchSnapshot(full) throws when the people page itself fails', async () => {
  const client = fakeClient({
    people: [],
    errors: { [PEOPLE_PATH]: new Error('Elvanto people outage') },
  });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  await assert.rejects(
    () => adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'full' }),
    /people outage/
  );
});

test('fetchSnapshot(full) returns the greatest valid date_modified as the watermark, ignoring the injected wall-clock now()', async () => {
  const older = { ...fixtures.person(), id: '9001', firstname: 'Old', lastname: 'One', date_modified: '2020-01-01 00:00:00' };
  const newer = { ...fixtures.person(), id: '9002', firstname: 'New', lastname: 'One', date_modified: '2025-12-31 23:59:59' };
  const client = fakeClient({ people: [older, newer] });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date('2099-01-01T00:00:00.000Z') });

  const snapshot = await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'full' });

  assert.equal(snapshot.watermark, '2025-12-31 23:59:59');
  assert.notEqual(snapshot.watermark, snapshot.fetchedAt);
  assert.equal(snapshot.fetchedAt, '2099-01-01T00:00:00.000Z');
});

// ─── Step 2: incremental snapshot ───────────────────────────────────────────

test('fetchSnapshot(incremental) sends search[date_modified] five minutes before the stored UTC watermark', async () => {
  const client = fakeClient({ people: [] });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'incremental', watermark: '2024-06-01 12:00:00' });

  const peopleCall = client.calls.getAll.find((c) => c.path === PEOPLE_PATH);
  assert.equal(peopleCall.params['search[date_modified]'], '2024-06-01 11:55:00');
});

test('fetchSnapshot(incremental) throws when called without a valid stored watermark', async () => {
  const client = fakeClient({ people: [] });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  await assert.rejects(
    () => adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'incremental', watermark: null }),
    /requires a valid watermark/
  );
});

test('fetchSnapshot(incremental) de-duplicates people that appear twice across the overlap window, keeping the newest date_modified', async () => {
  const stale = { ...fixtures.activePerson, firstname: 'StaleName', date_modified: '2024-06-01 11:56:00' };
  const fresh = { ...fixtures.activePerson, firstname: 'FreshName', date_modified: '2024-06-01 12:10:00' };
  const client = fakeClient({ people: [stale, fresh] });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  const snapshot = await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'incremental', watermark: '2024-06-01 12:00:00' });

  const matches = snapshot.people.filter((p) => p.id === fixtures.activePerson.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].firstName, 'FreshName');
  assert.equal(snapshot.watermark, '2024-06-01 12:10:00');
});

test('fetchSnapshot(incremental) falls back to the incoming watermark when nothing new is fetched (never regresses to null)', async () => {
  const client = fakeClient({ people: [] });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  const snapshot = await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'incremental', watermark: '2024-06-01 12:00:00' });

  assert.equal(snapshot.watermark, '2024-06-01 12:00:00');
});

test('fetchSnapshot(incremental) always refreshes group membership from scratch, even when the person\'s own date_modified did not change between calls', async () => {
  const person = { ...fixtures.activePerson, date_modified: '2024-06-01 12:10:00' };
  const client = fakeClient({
    people: [person],
    groups: [{ id: 'g-new', name: 'New Group', people: { person: [{ id: person.id }] } }],
  });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'incremental', watermark: '2024-06-01 12:00:00' });
  const firstGroupsCalls = client.calls.getAll.filter((c) => c.path === DEFINITION_ENDPOINTS.groups.path);
  assert.equal(firstGroupsCalls.length, 1);

  // Second incremental call for the SAME unchanged person: group membership
  // must be fetched fresh again, never skipped or reused from the first
  // call — this is what actually catches a group-only change (a person
  // added/removed from a group without their own date_modified moving) for
  // whichever incremental runs DO happen to return that person.
  const snapshot = await adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'incremental', watermark: '2024-06-01 12:00:00' });
  const secondGroupsCalls = client.calls.getAll.filter((c) => c.path === DEFINITION_ENDPOINTS.groups.path);
  assert.equal(secondGroupsCalls.length, 2);
  assert.deepEqual(snapshot.people.find((p) => p.id === person.id).attributes.groups, ['g-new']);
});

test('fetchSnapshot(incremental) throws when a membership dimension page fails, same as full mode', async () => {
  const client = fakeClient({
    people: [],
    errors: { [DEFINITION_ENDPOINTS.locations.path]: new Error('Elvanto locations outage') },
  });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  await assert.rejects(
    () => adapter.fetchSnapshot({ credentials: { apiKey: 'k' }, mode: 'incremental', watermark: '2024-06-01 12:00:00' }),
    /locations outage/
  );
});

// ─── fetchMetadata delegation ────────────────────────────────────────────────

function fakeStore(overrides = {}) {
  const calls = { getConnection: [], updateMetadataCache: [] };
  return {
    calls,
    async getConnection(churchId, provider) {
      calls.getConnection.push({ churchId, provider });
      return overrides.getConnection ? overrides.getConnection(churchId, provider) : null;
    },
    async updateMetadataCache(churchId, provider, metadata) {
      calls.updateMetadataCache.push({ churchId, provider, metadata });
      if (overrides.updateMetadataCache) return overrides.updateMetadataCache(churchId, provider, metadata);
    },
  };
}

test('fetchMetadata delegates to fetchElvantoMetadata using the injected client and the given snapshot', async () => {
  const client = fakeClient({ groups: [{ id: 'g-1', name: 'Youth' }] });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  const snapshot = { people: [], families: [], skipped: [] };
  const metadata = await adapter.fetchMetadata({ credentials: { apiKey: 'k' }, snapshot });

  assert.equal(typeof metadata.fetchedAt, 'string');
  assert.deepEqual(metadata.groups, [{ id: 'g-1', name: 'Youth', status: null, memberCount: 0 }]);
});

test('fetchMetadata without a churchId performs a pure fetch and never touches the store (matches metadata.js\'s "no churchId, no caching" contract)', async () => {
  const client = fakeClient({ groups: [{ id: 'g-1', name: 'Youth' }] });
  const store = fakeStore();
  const adapter = createElvantoAdapter({ clientFactory: () => client, store, now: () => new Date() });

  await adapter.fetchMetadata({ credentials: { apiKey: 'k' }, snapshot: { people: [], families: [], skipped: [] } });

  assert.equal(store.calls.getConnection.length, 0);
  assert.equal(store.calls.updateMetadataCache.length, 0);
});

test('fetchMetadata threads churchId through to the cache write-through on a successful fetch', async () => {
  const client = fakeClient({ groups: [{ id: 'g-1', name: 'Youth' }] });
  const store = fakeStore();
  const adapter = createElvantoAdapter({ clientFactory: () => client, store, now: () => new Date() });

  await adapter.fetchMetadata({
    churchId: 'church-1', credentials: { apiKey: 'k' }, snapshot: { people: [], families: [], skipped: [] },
  });

  assert.equal(store.calls.updateMetadataCache.length, 1);
  assert.equal(store.calls.updateMetadataCache[0].churchId, 'church-1');
  assert.equal(store.calls.updateMetadataCache[0].provider, 'elvanto');
});

// This is the review gap this file was fixed for: without churchId reaching
// fetchElvantoMetadata, a live outage during metadata discovery always threw
// instead of ever reaching Task 13's stale-cache fallback. This test proves
// the fallback is reachable THROUGH THE ADAPTER, not just directly against
// metadata.js (already covered by metadata.test.js).
test('fetchMetadata threads churchId through so Task 13\'s stale-cache-on-outage fallback actually engages', async () => {
  const cachedMetadata = {
    fetchedAt: '2020-01-01T00:00:00.000Z',
    categories: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [],
    groups: [{ id: 'g-1', name: 'Old Group', status: null, memberCount: 0 }],
  };
  const store = fakeStore({
    getConnection: async () => ({ metadata: { syncMetadata: cachedMetadata }, metadataCachedAt: '2020-01-02T00:00:00.000Z' }),
  });
  const client = fakeClient({ errors: { [DEFINITION_ENDPOINTS.groups.path]: new Error('Elvanto outage') } });
  const adapter = createElvantoAdapter({ clientFactory: () => client, store, now: () => new Date() });

  const result = await adapter.fetchMetadata({
    churchId: 'church-1', credentials: { apiKey: 'k' }, snapshot: { people: [], families: [], skipped: [] },
  });

  assert.deepEqual(result, {
    metadata: cachedMetadata,
    stale: true,
    refreshing: false,
    metadataCachedAt: '2020-01-02T00:00:00.000Z',
  });
  assert.equal(store.calls.getConnection[0].churchId, 'church-1');
  assert.equal(store.calls.getConnection[0].provider, 'elvanto');
  // Never writes through a cache update on a failed fetch.
  assert.equal(store.calls.updateMetadataCache.length, 0);
});

test('fetchMetadata propagates the original error when churchId is given, the fetch fails, and no cache exists', async () => {
  const store = fakeStore({ getConnection: async () => null });
  const client = fakeClient({ errors: { [DEFINITION_ENDPOINTS.groups.path]: new Error('Elvanto outage, no cache') } });
  const adapter = createElvantoAdapter({ clientFactory: () => client, store, now: () => new Date() });

  await assert.rejects(
    () => adapter.fetchMetadata({ churchId: 'church-1', credentials: { apiKey: 'k' }, snapshot: { people: [], families: [], skipped: [] } }),
    /Elvanto outage, no cache/
  );
});

test('fetchMetadata accepts a force flag without erroring, matching Task 5\'s { churchId, credentials, force } contract shape (a deliberate no-op here — see the adapter\'s own inline note)', async () => {
  const client = fakeClient({ groups: [{ id: 'g-1', name: 'Youth' }] });
  const adapter = createElvantoAdapter({ clientFactory: () => client, now: () => new Date() });

  const metadata = await adapter.fetchMetadata({
    credentials: { apiKey: 'k' }, force: true, snapshot: { people: [], families: [], skipped: [] },
  });

  assert.deepEqual(metadata.groups, [{ id: 'g-1', name: 'Youth', status: null, memberCount: 0 }]);
});

// ─── validateFilter / isEligible pass-through ───────────────────────────────

test('validateFilter and isEligible are the exact functions from filter.js (not reimplemented)', () => {
  const { validateElvantoFilter, isElvantoEligible } = require('./filter');
  const adapter = createElvantoAdapter();
  assert.equal(adapter.validateFilter, validateElvantoFilter);
  assert.equal(adapter.isEligible, isElvantoEligible);
});

// ─── Internal helper unit tests ──────────────────────────────────────────────

test('dedupeByIdKeepingNewest keeps the record with the greatest date_modified for a repeated ID', () => {
  const older = { id: '1', date_modified: '2024-01-01 00:00:00', tag: 'old' };
  const newer = { id: '1', date_modified: '2024-06-01 00:00:00', tag: 'new' };
  const result = dedupeByIdKeepingNewest([older, newer]);
  assert.equal(result.length, 1);
  assert.equal(result[0].tag, 'new');
});

test('dedupeByIdKeepingNewest passes through records with no ID untouched (nothing to de-duplicate against)', () => {
  const noId = { id: '', tag: 'ghost' };
  const result = dedupeByIdKeepingNewest([noId]);
  assert.deepEqual(result, [noId]);
});

test('computeWatermark returns null when no record has a usable date_modified', () => {
  assert.equal(computeWatermark([{ id: '1', date_modified: '' }, { id: '2' }]), null);
});

test('computeIncrementalSearchCutoff throws when no watermark is available', () => {
  assert.throws(() => computeIncrementalSearchCutoff(null), /requires a valid watermark/);
  assert.throws(() => computeIncrementalSearchCutoff(''), /requires a valid watermark/);
});

test('computeIncrementalSearchCutoff subtracts exactly five minutes in UTC', () => {
  assert.equal(computeIncrementalSearchCutoff('2024-06-01 00:03:00'), '2024-05-31 23:58:00');
});
