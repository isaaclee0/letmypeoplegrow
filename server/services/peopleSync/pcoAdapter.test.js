const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPcoAdapter, validatePcoFilter, metadataPerson } = require('./pcoAdapter');
const { isEligible } = require('../planningCenter/eligibility');
const { validateAdapter } = require('./providerRegistry');

// A PCO person exactly as projection.js's projectPerson() already returns it today
// (raw API projection, before this task's normalization). See projection.test.js for
// the authoritative shape.
function rawProjectedPerson(overrides = {}) {
  return {
    id: 'pco-1', firstName: 'Ada', lastName: 'Lovelace', status: 'active',
    membership: 'Church Members', child: false, passedBackgroundCheck: null,
    householdId: 'house-1', fieldValues: {}, ...overrides,
  };
}

function adapter(deps = {}) {
  return createPcoAdapter({
    validateToken: async () => ({ connected: true, accountName: 'Test Church' }),
    fetchPeople: async () => ({ people: [rawProjectedPerson()], householdPrimaryContacts: new Map(), fetchedAt: 123 }),
    fetchMetadata: async () => ({ memberships: [], fieldDefinitions: [] }),
    ...deps,
  });
}

test('createPcoAdapter satisfies the Task 5 provider contract shape exactly', () => {
  const a = adapter();
  assert.equal(a.provider, 'planning_center');
  assert.doesNotThrow(() => validateAdapter(a));
  assert.deepEqual(Object.getOwnPropertyNames(a).sort(), [
    'buildFilterDimensions', 'fetchMetadata', 'fetchSnapshot', 'isEligible', 'isInFilterPopulation', 'provider', 'toFilterFacts', 'validateConnection', 'validateFilter',
  ]);
});

test('fetchMetadata receives and reuses the refresh snapshot instead of requesting people again', async () => {
  let metadataOptions = null;
  const a = adapter({ fetchMetadata: async (_churchId, _token, options) => { metadataOptions = options; return { memberships: [], fieldDefinitions: [] }; } });
  const snapshot = { mode: 'full', people: [{ id: 'p1', attributes: { membership: 'Member' } }] };
  await a.fetchMetadata({ churchId: 'churcha1', credentials: { accessToken: 'secret' }, force: false, snapshot });
  assert.equal(metadataOptions.snapshot, snapshot);
});

test('warm projected people and refreshed normalized people yield the same PCO metadata values', () => {
  const projected = rawProjectedPerson({ membership: 'Member', fieldValues: { choir: ['Soprano'] } });
  const normalized = {
    id: projected.id, state: 'active', attributes: { membership: 'Member', fieldValues: { choir: ['Soprano'] } },
  };
  assert.deepEqual(metadataPerson(projected), { membership: 'Member', fieldValues: { choir: ['Soprano'] } });
  assert.deepEqual(metadataPerson(normalized), { membership: 'Member', fieldValues: { choir: ['Soprano'] } });
  const a = adapter();
  assert.equal(a.isInFilterPopulation(projected), true);
  assert.equal(a.isInFilterPopulation(normalized), true);
  assert.deepEqual(a.toFilterFacts(projected, new Set(['membership', 'custom_field:choir'])).dimensions,
    a.toFilterFacts(normalized, new Set(['membership', 'custom_field:choir'])).dimensions);
  const facts = [projected, normalized].map((person) => a.toFilterFacts(person, new Set(['membership', 'custom_field:choir'])));
  const dimensions = a.buildFilterDimensions({ facts, providerMetadata: {
    memberships: [{ membership: 'Member' }], fieldDefinitions: [{ id: 'choir', name: 'Choir', dataType: 'checkboxes', options: ['Soprano'] }],
  }, coveredDimensionIds: ['membership', 'custom_field:choir'] });
  assert.deepEqual(dimensions.map((dimension) => [dimension.id, dimension.values[0].id, dimension.values[0].count]), [
    ['custom_field:choir', 'Soprano', 2], ['membership', 'Member', 2],
  ]);
});

test('default metadata path counts memberships from both warm projected and explicit normalized people', async () => {
  let peopleCalls = 0;
  const projected = rawProjectedPerson({ membership: 'Member', fieldValues: { choir: ['Soprano'] } });
  const terminalProjected = rawProjectedPerson({ id: 'terminal', status: 'inactive', membership: 'Former Member', fieldValues: { choir: ['Bass'] } });
  const a = createPcoAdapter({
    fetchPeople: async () => { peopleCalls++; return { people: [projected, terminalProjected], householdPrimaryContacts: new Map() }; },
    fetchFieldDefinitions: async () => [{ id: 'choir', name: 'Choir', dataType: 'checkboxes', options: ['Soprano'] }],
  });
  const warm = await a.fetchMetadata({ churchId: 'churcha1', credentials: { accessToken: 'token' }, force: false });
  assert.deepEqual(warm.memberships, [{ membership: 'Member', count: 1 }]);
  const normalized = { id: 'p1', state: 'active', attributes: { membership: 'Member', fieldValues: { choir: ['Soprano'] } } };
  const terminalNormalized = { id: 'terminal', state: 'archived', attributes: { membership: 'Former Member', fieldValues: { choir: ['Bass'] } } };
  const refreshed = await a.fetchMetadata({ churchId: 'churcha1', credentials: { accessToken: 'token' }, force: false, snapshot: { people: [normalized, terminalNormalized] } });
  assert.deepEqual(refreshed.memberships, [{ membership: 'Member', count: 1 }]);
  assert.equal(peopleCalls, 1, 'an explicit snapshot must not fetch people again');
});

test('projects PCO people into PII-free facts and canonical dimensions', () => {
  const a = adapter();
  const person = {
    id: 'p1', firstName: 'Ada', lastName: 'Lovelace', familyId: 'house-1', state: 'active',
    attributes: { membership: 'Member', fieldValues: { 12: ['Choir', 'Youth'] } },
  };

  const facts = a.toFilterFacts(person, new Set(['membership', 'custom_field:12']));
  assert.deepEqual(facts, {
    externalPersonId: 'p1',
    dimensions: { membership: ['Member'], 'custom_field:12': ['Choir', 'Youth'] },
  });
  assert.doesNotMatch(JSON.stringify(facts), /Ada|Lovelace|house-1|firstName|lastName|familyId|email|phone|address|raw/i);

  const dimensions = a.buildFilterDimensions({
    facts: [facts],
    providerMetadata: {
      memberships: [{ membership: 'Member', count: 1 }],
      fieldDefinitions: [{ id: '12', name: 'Ministries', dataType: 'checkboxes', options: ['Choir', 'Youth'] }],
    },
  });
  assert.equal(dimensions.find((dimension) => dimension.id === 'membership').cardinality, 'single');
  assert.equal(dimensions.find((dimension) => dimension.id === 'custom_field:12').cardinality, 'multi');
});

test('does not place archived PCO people in the filter population', () => {
  const a = adapter();
  assert.equal(a.isInFilterPopulation({ state: 'archived' }, {}), false);
  assert.equal(a.isInFilterPopulation({ state: 'active' }, {}), true);
});

test('omits covered missing PCO fields and escapes a provider value reserved for not set', () => {
  const a = adapter();
  const facts = a.toFilterFacts({
    id: 'p2', state: 'active', attributes: { membership: '$not_set', fieldValues: { 12: [] } },
  }, new Set(['membership', 'custom_field:12']));
  assert.deepEqual(facts, { externalPersonId: 'p2', dimensions: { membership: ['$$not_set'] } });
  assert.equal(Object.hasOwn(facts.dimensions, 'custom_field:12'), false);
});

test('maps the legacy PCO absence sentinel to an omitted canonical fact', () => {
  const a = adapter();
  const facts = a.toFilterFacts({
    id: 'p3', state: 'active', attributes: { membership: '(none)', fieldValues: { 12: ['(none)'] } },
  }, new Set(['membership', 'custom_field:12']));
  assert.deepEqual(facts, { externalPersonId: 'p3', dimensions: {} });
});

test('does not expose uncovered PCO custom fields or a zero-count Not set option', () => {
  const a = adapter();
  const dimensions = a.buildFilterDimensions({
    facts: [{ externalPersonId: 'p1', dimensions: { membership: ['Member'] } }],
    providerMetadata: {
      memberships: [{ membership: 'Member', count: 1 }],
      fieldDefinitions: [{ id: '12', name: 'Ministries', dataType: 'checkboxes', options: ['Choir'] }],
    },
    coveredDimensionIds: ['membership'],
  });
  assert.deepEqual(dimensions.map((dimension) => dimension.id), ['membership']);
  assert.deepEqual(dimensions[0].values, [{ id: 'Member', label: 'Member', count: 1 }]);
});

test('fetchSnapshot normalizes an active PCO person: state, provider tag, familyId from householdId', async () => {
  const a = adapter();
  const snapshot = await a.fetchSnapshot({ churchId: 'c1', credentials: { accessToken: 'token' }, mode: 'full' });

  assert.equal(snapshot.provider, 'planning_center');
  assert.equal(snapshot.mode, 'full');
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.watermark, null);
  assert.equal(snapshot.fetchedAt, new Date(123).toISOString());
  assert.equal(snapshot.people.length, 1);

  const person = snapshot.people[0];
  assert.equal(person.provider, 'planning_center');
  assert.equal(person.id, 'pco-1');
  assert.equal(person.firstName, 'Ada');
  assert.equal(person.lastName, 'Lovelace');
  assert.equal(person.child, false);
  assert.equal(person.state, 'active');
  assert.equal(person.familyId, 'house-1');
  assert.deepEqual(person.attributes, {
    membership: 'Church Members', passedBackgroundCheck: null, fieldValues: {},
  });
});

test('fetchSnapshot normalizes an inactive PCO person to the terminal "archived" state', async () => {
  const a = adapter({
    fetchPeople: async () => ({
      people: [rawProjectedPerson({ id: 'pco-2', status: 'inactive' })],
      householdPrimaryContacts: new Map(),
      fetchedAt: 456,
    }),
  });
  const snapshot = await a.fetchSnapshot({ churchId: 'c1', credentials: { accessToken: 'token' }, mode: 'full' });
  assert.equal(snapshot.people[0].state, 'archived');
});

test('fetchSnapshot treats a null/missing PCO status as archived, not active (fail closed)', async () => {
  const a = adapter({
    fetchPeople: async () => ({
      people: [rawProjectedPerson({ id: 'pco-3', status: null })],
      householdPrimaryContacts: new Map(),
      fetchedAt: 789,
    }),
  });
  const snapshot = await a.fetchSnapshot({ churchId: 'c1', credentials: { accessToken: 'token' }, mode: 'full' });
  assert.equal(snapshot.people[0].state, 'archived');
});

test('fetchSnapshot without a householdId normalizes familyId to null', async () => {
  const a = adapter({
    fetchPeople: async () => ({
      people: [rawProjectedPerson({ id: 'pco-4', householdId: null })],
      householdPrimaryContacts: new Map(),
      fetchedAt: 1,
    }),
  });
  const snapshot = await a.fetchSnapshot({ churchId: 'c1', credentials: { accessToken: 'token' }, mode: 'full' });
  assert.equal(snapshot.people[0].familyId, null);
});

test('fetchSnapshot projects households into normalized families with sorted member ids and primary contact', async () => {
  const a = adapter({
    fetchPeople: async () => ({
      people: [
        rawProjectedPerson({ id: 'pco-2', householdId: 'house-1' }),
        rawProjectedPerson({ id: 'pco-1', householdId: 'house-1' }),
        rawProjectedPerson({ id: 'pco-3', householdId: 'house-2' }),
      ],
      householdPrimaryContacts: new Map([['house-1', 'pco-2'], ['house-2', 'nobody-linked']]),
      fetchedAt: 1,
    }),
  });
  const snapshot = await a.fetchSnapshot({ churchId: 'c1', credentials: { accessToken: 'token' }, mode: 'full' });

  assert.deepEqual(snapshot.families, [
    { id: 'house-1', memberExternalIds: ['pco-1', 'pco-2'], primaryContactExternalId: 'pco-2' },
    { id: 'house-2', memberExternalIds: ['pco-3'], primaryContactExternalId: 'nobody-linked' },
  ]);
});

test('fetchSnapshot forces a fresh fetch only when mode is "full", passing force through to fetchPeople', async () => {
  const calls = [];
  const a = adapter({
    fetchPeople: async (churchId, accessToken, options) => {
      calls.push({ churchId, accessToken, options });
      return { people: [], householdPrimaryContacts: new Map(), fetchedAt: 1 };
    },
  });

  await a.fetchSnapshot({ churchId: 'c1', credentials: { accessToken: 'tok-1' }, mode: 'full' });
  await a.fetchSnapshot({ churchId: 'c1', credentials: { accessToken: 'tok-1' }, mode: 'incremental' });

  assert.equal(calls[0].churchId, 'c1');
  assert.equal(calls[0].accessToken, 'tok-1');
  assert.deepEqual(calls[0].options, { force: true });
  assert.deepEqual(calls[1].options, { force: false });
});

test('validateConnection delegates to the injected token validator with the given access token', async () => {
  const calls = [];
  const a = adapter({
    validateToken: async (accessToken) => { calls.push(accessToken); return { connected: true, accountName: 'X' }; },
  });
  const result = await a.validateConnection({ churchId: 'c1', credentials: { accessToken: 'secret-token' } });
  assert.deepEqual(calls, ['secret-token']);
  assert.deepEqual(result, { connected: true, accountName: 'X' });
});

test('fetchMetadata delegates to the injected metadata fetcher with churchId/accessToken/force', async () => {
  const calls = [];
  const a = adapter({
    fetchMetadata: async (churchId, accessToken, options) => {
      calls.push({ churchId, accessToken, options });
      return { memberships: [{ membership: 'Church Members', count: 1 }], fieldDefinitions: [] };
    },
  });
  const result = await a.fetchMetadata({ churchId: 'c1', credentials: { accessToken: 'tok' }, force: true });
  assert.deepEqual(calls, [{ churchId: 'c1', accessToken: 'tok', options: { force: true } }]);
  assert.deepEqual(result, { memberships: [{ membership: 'Church Members', count: 1 }], fieldDefinitions: [] });
});

// ─── isEligible: equivalence with the existing PCO eligibility.test.js suite ───
//
// adapter.isEligible(normalizedPerson, filterConfig) must agree with the raw
// isEligible(rawPerson, filterConfig) for the same underlying person, across the same
// scenarios eligibility.test.js already covers — proving fromNormalized() round-trips
// without changing PCO's real filter semantics.

function rawPerson(overrides = {}) {
  return { id: 'p1', membership: null, fieldValues: {}, ...overrides };
}

function normalizedFrom(raw) {
  return {
    provider: 'planning_center', id: raw.id, firstName: '', lastName: '', child: null,
    state: 'active', familyId: null,
    attributes: { membership: raw.membership, passedBackgroundCheck: null, fieldValues: raw.fieldValues },
  };
}

function assertEquivalentEligibility(rawOverrides, cfg) {
  const raw = rawPerson(rawOverrides);
  const normalized = normalizedFrom(raw);
  const a = adapter();
  const expected = isEligible(raw, cfg);
  assert.equal(a.isEligible(normalized, cfg), expected);
  return expected;
}

test('isEligible equivalence: membership-only allow-list match/mismatch', () => {
  const cfg = { membershipFilterEnabled: true, membershipAllowlist: ['Church Members'], fieldFilterEnabled: false, fieldFilters: [] };
  assert.equal(assertEquivalentEligibility({ membership: 'Church Members' }, cfg), true);
  assert.equal(assertEquivalentEligibility({ membership: 'Community Contact' }, cfg), false);
});

test('isEligible equivalence: membership disabled does not count even on a matching value', () => {
  const cfg = { membershipFilterEnabled: false, membershipAllowlist: ['Church Members'], fieldFilterEnabled: false, fieldFilters: [] };
  assert.equal(assertEquivalentEligibility({ membership: 'Church Members' }, cfg), false);
});

test('isEligible equivalence: field rules AND within source, missing value normalizes to (none)', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: true,
    fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Connected'] }, { fieldDefinitionId: 'f2', values: ['Yes'] }],
  };
  assert.equal(assertEquivalentEligibility({ fieldValues: { f1: ['Connected'], f2: ['Yes'] } }, cfg), true);
  assert.equal(assertEquivalentEligibility({ fieldValues: { f1: ['Connected'], f2: ['No'] } }, cfg), false);
  assert.equal(assertEquivalentEligibility({ fieldValues: { f1: ['Connected'] } }, cfg), false);
});

test('isEligible equivalence: (none) sentinel matches missing/empty field values', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: true,
    fieldFilters: [{ fieldDefinitionId: 'f1', values: ['(none)'] }],
  };
  assert.equal(assertEquivalentEligibility({ fieldValues: {} }, cfg), true);
  assert.equal(assertEquivalentEligibility({ fieldValues: { f1: ['Connected'] } }, cfg), false);
  assert.equal(assertEquivalentEligibility({ fieldValues: { f1: [] } }, cfg), true);
});

test('isEligible equivalence: multi-select checkboxes match if any selected value intersects', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: true,
    fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Blue'] }],
  };
  assert.equal(assertEquivalentEligibility({ fieldValues: { f1: ['Red', 'Blue'] } }, cfg), true);
  assert.equal(assertEquivalentEligibility({ fieldValues: { f1: ['Red', 'Green'] } }, cfg), false);
});

test('isEligible equivalence: OR across sources, both disabled means nobody', () => {
  const orCfg = {
    membershipFilterEnabled: true, membershipAllowlist: ['Church Members'],
    fieldFilterEnabled: true, fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Connected'] }],
  };
  assert.equal(assertEquivalentEligibility({ membership: 'Church Members', fieldValues: {} }, orCfg), true);
  assert.equal(assertEquivalentEligibility({ membership: 'Community Contact', fieldValues: { f1: ['Connected'] } }, orCfg), true);
  assert.equal(assertEquivalentEligibility({ membership: 'Community Contact', fieldValues: { f1: ['Not Connected'] } }, orCfg), false);

  const bothDisabled = { membershipFilterEnabled: false, membershipAllowlist: ['Church Members'], fieldFilterEnabled: false, fieldFilters: [] };
  assert.equal(assertEquivalentEligibility({ membership: 'Church Members' }, bothDisabled), false);
});

// ─── validatePcoFilter ──────────────────────────────────────────────────────

test('validatePcoFilter accepts a well-formed filter config at schema version 1', () => {
  const result = validatePcoFilter({
    membershipFilterEnabled: true, membershipAllowlist: ['Church Members'],
    fieldFilterEnabled: true, fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Yes'] }],
  }, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value, {
    membershipFilterEnabled: true, membershipAllowlist: ['Church Members'],
    fieldFilterEnabled: true, fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Yes'] }],
  });
});

test('validatePcoFilter rejects an unsupported schema version', () => {
  const result = validatePcoFilter({
    membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [],
  }, 2);
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.errors.length > 0);
});

test('validatePcoFilter rejects malformed shapes with descriptive errors', () => {
  assert.equal(validatePcoFilter({ membershipFilterEnabled: 'yes', membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [] }, 1).ok, false);
  assert.equal(validatePcoFilter({ membershipFilterEnabled: true, membershipAllowlist: 'nope', fieldFilterEnabled: false, fieldFilters: [] }, 1).ok, false);
  assert.equal(validatePcoFilter({ membershipFilterEnabled: true, membershipAllowlist: [], fieldFilterEnabled: true, fieldFilters: [{ values: ['x'] }] }, 1).ok, false);
  assert.equal(validatePcoFilter(null, 1).ok, false);
});
