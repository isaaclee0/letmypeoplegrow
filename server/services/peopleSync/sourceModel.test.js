const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertSourceForProvider,
  normalizeProviderSource,
  digestSourceIdentity,
  digestSourceSnapshot,
} = require('./sourceModel');

const VALID_SOURCES = {
  planning_center: { kind: 'planning_center_list', externalId: '42', name: 'Sunday Attendance' },
  elvanto: { kind: 'elvanto_category', externalId: 'members', name: 'Members' },
};

function snapshot(overrides = {}) {
  return {
    provider: 'planning_center',
    source: VALID_SOURCES.planning_center,
    memberExternalIds: ['1', '2'],
    providerRefreshedAt: '2026-07-29T00:00:00.000Z',
    fetchedAt: '2026-07-29T00:01:00.000Z',
    people: [
      { id: '1', name: 'Ada Lovelace', state: 'active', child: false, familyId: 'household-1', ignored: 'raw' },
      { id: '2', name: 'Grace Hopper', state: 'active', child: false, familyId: 'household-2' },
    ],
    context: [{ id: '3', name: 'Visitor', state: 'inactive', child: true, familyId: null }],
    families: [
      { id: 'household-1', name: 'Lovelace', primaryContactId: '1', ignored: 'raw' },
      { id: 'household-2', name: 'Hopper', primaryContactId: '2' },
    ],
    ...overrides,
  };
}

test('source kinds are provider-exact', () => {
  assert.doesNotThrow(() => assertSourceForProvider('planning_center', VALID_SOURCES.planning_center));
  assert.doesNotThrow(() => assertSourceForProvider('elvanto', VALID_SOURCES.elvanto));
  assert.doesNotThrow(() => assertSourceForProvider('elvanto', {
    kind: 'elvanto_group', externalId: 'youth', name: 'Youth',
  }));

  for (const [provider, source] of [
    ['planning_center', { kind: 'elvanto_group', externalId: '42', name: 'Youth' }],
    ['elvanto', VALID_SOURCES.planning_center],
    ['other', VALID_SOURCES.planning_center],
    ['planning_center', { kind: 'planning_center_list', externalId: ' ', name: 'Sunday' }],
    ['planning_center', { kind: 'planning_center_list', externalId: '', name: 'Sunday' }],
    ['planning_center', { kind: 'planning_center_list', externalId: 42, name: 'Sunday' }],
    ['planning_center', { kind: 'planning_center_list', externalId: '42', name: ' ' }],
    ['planning_center', { kind: 'planning_center_list', externalId: '42', name: 7 }],
    ['planning_center', { kind: 'planning_center_list', externalId: '42', name: 'Sunday', extra: true }],
  ]) {
    assert.throws(() => assertSourceForProvider(provider, source), { code: 'SYNC_SOURCE_INVALID' });
  }
});

test('normalization trims the exact provider source shape', () => {
  assert.deepEqual(
    normalizeProviderSource('elvanto', { kind: 'elvanto_group', externalId: ' youth ', name: ' Youth Group ' }),
    { kind: 'elvanto_group', externalId: 'youth', name: 'Youth Group' },
  );
});

test('identity digest is deterministic and excludes source display metadata', () => {
  assert.equal(
    digestSourceIdentity({ kind: 'elvanto_group', externalId: 'youth', name: 'Youth' }),
    digestSourceIdentity({ externalId: 'youth', name: 'Youth Group', kind: 'elvanto_group' }),
  );
  assert.notEqual(
    digestSourceIdentity({ kind: 'elvanto_group', externalId: 'youth', name: 'Youth' }),
    digestSourceIdentity({ kind: 'elvanto_group', externalId: 'members', name: 'Youth' }),
  );
});

test('snapshot digest is stable across provider page order and excludes fetch time', () => {
  const first = snapshot();
  const second = snapshot({
    memberExternalIds: ['2', '1'],
    fetchedAt: '2099-01-01T00:00:00.000Z',
    people: [...first.people].reverse(),
    context: [...first.context].reverse(),
    families: [...first.families].reverse(),
  });
  assert.equal(digestSourceSnapshot(first), digestSourceSnapshot(second));
});

test('snapshot digest changes when its matching inputs change', () => {
  const base = snapshot();
  for (const changed of [
    snapshot({ memberExternalIds: ['1'] }),
    snapshot({ source: { ...VALID_SOURCES.planning_center, name: 'Evening Attendance' } }),
    snapshot({ people: [{ ...base.people[0], state: 'inactive' }, base.people[1]] }),
    snapshot({ families: [{ ...base.families[0], primaryContactId: '2' }, base.families[1]] }),
  ]) {
    assert.notEqual(digestSourceSnapshot(base), digestSourceSnapshot(changed));
  }
});
