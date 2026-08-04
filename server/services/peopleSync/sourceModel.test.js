const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertSourceForProvider,
  normalizeProviderSource,
  digestSourceIdentity,
  digestSourceSnapshot,
  effectiveAuthorityReviewBatches,
  digestAuthorityReviewSourceSet,
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

function authorityBatch(overrides = {}) {
  return {
    id: 1,
    provider: 'elvanto',
    enabled: true,
    sourceRevision: 4,
    source: { kind: 'elvanto_group', externalId: 'active', name: 'Active' },
    draftSource: null,
    draftSourceBaseRevision: null,
    ...overrides,
  };
}

test('authority review candidates prefer drafts, exclude disabled batches, and sort by numeric batch ID', () => {
  const initialDraft = authorityBatch({
    id: 20,
    source: null,
    draftSource: { kind: 'elvanto_group', externalId: 'initial', name: 'Initial' },
    draftSourceBaseRevision: 4,
  });
  const replacementDraft = authorityBatch({
    id: 3,
    source: { kind: 'elvanto_group', externalId: 'old', name: 'Old' },
    draftSource: { kind: 'elvanto_group', externalId: 'replacement', name: 'Replacement' },
    draftSourceBaseRevision: 4,
  });
  const disabled = authorityBatch({ id: 2, enabled: false });

  const candidates = effectiveAuthorityReviewBatches([initialDraft, disabled, replacementDraft]);

  assert.deepEqual(candidates.map(({ id, effectiveSource, effectiveSourceIsDraft }) => ({
    id, externalId: effectiveSource.externalId, effectiveSourceIsDraft,
  })), [
    { id: 3, externalId: 'replacement', effectiveSourceIsDraft: true },
    { id: 20, externalId: 'initial', effectiveSourceIsDraft: true },
  ]);
});

test('authority review candidates reject missing, malformed, and duplicate effective sources', () => {
  const duplicate = { kind: 'elvanto_group', externalId: ' shared ', name: 'Shared' };
  for (const batches of [
    [authorityBatch({ source: null })],
    [authorityBatch({ source: { kind: 'elvanto_group', externalId: '', name: 'Empty' } })],
    [authorityBatch({ source: { kind: 'planning_center_list', externalId: 'wrong', name: 'Wrong' } })],
    [authorityBatch({ id: 1, source: duplicate }), authorityBatch({
      id: 2, source: { kind: 'elvanto_group', externalId: 'shared', name: 'Duplicate' },
    })],
  ]) {
    assert.throws(() => effectiveAuthorityReviewBatches(batches), { code: 'SYNC_SOURCE_INVALID' });
  }
});

test('authority source-set digest binds participating batch state, source identity, revision, and promotions', () => {
  const draft = { kind: 'elvanto_group', externalId: 'draft', name: 'Draft' };
  const batches = [
    authorityBatch({ id: 20, sourceRevision: 7, draftSource: draft, draftSourceBaseRevision: 7 }),
    authorityBatch({ id: 3, source: { kind: 'elvanto_category', externalId: 'members', name: 'Members' } }),
  ];
  const promotions = [{
    batchId: 20,
    expectedBaseRevision: 7,
    expectedDraftDigest: digestSourceIdentity(draft),
  }];
  const baseline = digestAuthorityReviewSourceSet(
    effectiveAuthorityReviewBatches(batches),
    promotions,
  );

  assert.equal(digestAuthorityReviewSourceSet(
    effectiveAuthorityReviewBatches([...batches].reverse()),
    [...promotions].reverse(),
  ), baseline);

  const changedCases = [
    [[{ ...batches[0], id: 21 }, batches[1]], promotions],
    [[{ ...batches[0], enabled: false }, batches[1]], []],
    [[{ ...batches[0], sourceRevision: 8 }, batches[1]], promotions],
    [[{ ...batches[0], draftSource: { ...draft, externalId: 'changed' } }, batches[1]], promotions],
    [batches, [{ ...promotions[0], expectedBaseRevision: 6 }]],
    [batches, [{ ...promotions[0], expectedDraftDigest: 'f'.repeat(64) }]],
  ];
  for (const [changedBatches, changedPromotions] of changedCases) {
    assert.notEqual(digestAuthorityReviewSourceSet(
      effectiveAuthorityReviewBatches(changedBatches),
      changedPromotions,
    ), baseline);
  }
});
