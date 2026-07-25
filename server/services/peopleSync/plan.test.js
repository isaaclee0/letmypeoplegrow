const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computePeopleSyncPlan, summarizePlan } = require('./plan');

function person(overrides = {}) {
  return { id: 'ext-1', firstName: 'Ada', lastName: 'Lovelace', child: false,
    state: 'active', familyId: null, attributes: {}, ...overrides };
}

function local(overrides = {}) {
  return { id: 1, firstName: 'Ada', lastName: 'Lovelace', isChild: false,
    peopleType: 'regular', isActive: true, familyId: null, ...overrides };
}

function matcher(overrides = {}) {
  return { linked: [], matches: [], ambiguous: [], unmatchedExternalIds: [], unmatchedLocalIds: [],
    visitorMatches: [], archivedMatches: [], ...overrides };
}

function batch(overrides = {}) {
  return { id: 1, enabled: true, defaultPeopleType: 'regular', gatheringTypeId: null,
    gatheringAutoRemoveEnabled: false, eligibleExternalPersonIds: ['ext-1'], ...overrides };
}

function input(overrides = {}) {
  return {
    provider: 'elvanto', authoritative: true, activeAuthority: 'elvanto', trigger: 'manual',
    snapshot: { fetchedAt: '2026-07-25T01:02:03.000Z', watermark: 'wm-1', mode: 'full', complete: true },
    settings: { includeContacts: true, alignPeopleType: true },
    externalPeople: [person()], localPeople: [local()], batches: [batch()],
    matcher: matcher({ linked: [{ externalPersonId: 'ext-1', individualId: 1, reason: 'existing_link' }] }),
    missingCandidates: [], gatheringMemberships: [],
    ...overrides,
  };
}

const bucketNames = [
  'linkPeople', 'linkFamilies', 'addPeople', 'addFamilies', 'updateManagedFields',
  'promoteToRegular', 'demoteToLocalVisitor', 'archive', 'reactivate', 'moveFamily',
  'renameFamily', 'addToGathering', 'removeFromGathering', 'ambiguousPeople',
  'familyConflicts', 'unmatchedLocalRegulars', 'skipped',
];

test('returns the complete stable plan shape and literal summary counts', () => {
  const plan = computePeopleSyncPlan(input());

  assert.equal(plan.provider, 'elvanto');
  assert.equal(plan.authoritative, true);
  assert.deepEqual(plan.snapshot, {
    fetchedAt: '2026-07-25T01:02:03.000Z', watermark: 'wm-1', mode: 'full',
  });
  assert.deepEqual(Object.keys(plan).filter((key) => bucketNames.includes(key)), bucketNames);
  assert.deepEqual(summarizePlan(plan), {
    linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0,
    updateManagedFields: 0, promoteToRegular: 0, demoteToLocalVisitor: 0,
    archive: 0, reactivate: 0, moveFamily: 0, renameFamily: 0,
    addToGathering: 0, removeFromGathering: 0, ambiguousPeople: 0,
    familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  });
});

test('uses the union for lifecycle while retaining separate batch gathering eligibility', () => {
  const plan = computePeopleSyncPlan(input({
    batches: [
      batch({ id: 20, gatheringTypeId: 200, eligibleExternalPersonIds: [] }),
      batch({ id: 10, gatheringTypeId: 100, eligibleExternalPersonIds: ['ext-1'] }),
    ],
  }));

  assert.deepEqual(plan.archive, []);
  assert.deepEqual(plan.addToGathering, [{
    id: 'addToGathering:10:100:ext-1:1', batchId: 10, gatheringTypeId: 100,
    externalPersonId: 'ext-1', individualId: 1, eligibleBatchIds: [10],
    reason: 'batch_eligible',
  }]);
  assert.deepEqual(plan.removeFromGathering, []);
});

test('deduplicates overlapping batch additions to the same gathering deterministically', () => {
  const plan = computePeopleSyncPlan(input({
    batches: [
      batch({ id: 8, gatheringTypeId: 100 }),
      batch({ id: 3, gatheringTypeId: 100 }),
    ],
  }));

  assert.deepEqual(plan.addToGathering, [{
    id: 'addToGathering:3:100:ext-1:1', batchId: 3, gatheringTypeId: 100,
    externalPersonId: 'ext-1', individualId: 1, eligibleBatchIds: [3, 8],
    reason: 'batch_eligible',
  }]);
});

test('maps new Active people to regulars and included Contacts to local visitors', () => {
  const active = person({ id: 'active-1' });
  const contact = person({ id: 'contact-1', firstName: 'Grace', state: 'contact' });
  const plan = computePeopleSyncPlan(input({
    externalPeople: [contact, active], localPeople: [],
    batches: [batch({ eligibleExternalPersonIds: ['contact-1', 'active-1'] })],
    matcher: matcher({ unmatchedExternalIds: ['contact-1', 'active-1'] }),
  }));

  assert.deepEqual(plan.addPeople, [
    {
      id: 'addPeople:active-1', externalPersonId: 'active-1', firstName: 'Ada',
      lastName: 'Lovelace', isChild: false, familyId: null, peopleType: 'regular',
      reason: 'eligible_unmatched_external', reviewRequired: true,
    },
    {
      id: 'addPeople:contact-1', externalPersonId: 'contact-1', firstName: 'Grace',
      lastName: 'Lovelace', isChild: false, familyId: null, peopleType: 'local_visitor',
      reason: 'eligible_unmatched_external', reviewRequired: true,
    },
  ]);
});

test('excluded Contacts leave the authoritative population and propose archive when linked', () => {
  const plan = computePeopleSyncPlan(input({
    settings: { includeContacts: false, alignPeopleType: true },
    externalPeople: [person({ state: 'contact' })],
  }));

  assert.deepEqual(plan.archive, [{
    id: 'archive:ext-1:1', externalPersonId: 'ext-1', individualId: 1,
    reason: 'contact_excluded', missingFullSyncCount: null,
  }]);
});

test('people type alignment off preserves an existing linked type', () => {
  const plan = computePeopleSyncPlan(input({
    settings: { includeContacts: true, alignPeopleType: false },
    externalPeople: [person({ state: 'active' })],
    localPeople: [local({ peopleType: 'local_visitor' })],
  }));

  assert.deepEqual(plan.promoteToRegular, []);
  assert.deepEqual(plan.demoteToLocalVisitor, []);
});

test('Archived and Deceased linked people propose archive with explicit reasons', () => {
  const archived = person({ id: 'archived-1', state: 'archived' });
  const deceased = person({ id: 'deceased-1', state: 'deceased' });
  const plan = computePeopleSyncPlan(input({
    externalPeople: [deceased, archived],
    localPeople: [local({ id: 2 }), local({ id: 1 })],
    batches: [batch({ eligibleExternalPersonIds: ['archived-1', 'deceased-1'] })],
    matcher: matcher({ linked: [
      { externalPersonId: 'deceased-1', individualId: 2, reason: 'existing_link' },
      { externalPersonId: 'archived-1', individualId: 1, reason: 'existing_link' },
    ] }),
  }));

  assert.deepEqual(plan.archive, [
    { id: 'archive:archived-1:1', externalPersonId: 'archived-1', individualId: 1,
      reason: 'provider_state_archived', missingFullSyncCount: null },
    { id: 'archive:deceased-1:2', externalPersonId: 'deceased-1', individualId: 2,
      reason: 'provider_state_deceased', missingFullSyncCount: null },
  ]);
});

test('a linked eligible person reappearing active proposes reactivation', () => {
  const plan = computePeopleSyncPlan(input({ localPeople: [local({ isActive: false })] }));

  assert.deepEqual(plan.reactivate, [{
    id: 'reactivate:ext-1:1', externalPersonId: 'ext-1', individualId: 1,
    reason: 'provider_reappearance',
  }]);
});

test('unknown child state never proposes a managed-field update', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [person({ child: null })], localPeople: [local({ isChild: true })],
  }));

  assert.deepEqual(plan.updateManagedFields, []);
});

test('an inactive provider cannot update authority-owned fields or create regulars', () => {
  const linked = person({ firstName: 'New' });
  const unlinked = person({ id: 'ext-2', firstName: 'Another' });
  const plan = computePeopleSyncPlan(input({
    authoritative: false, activeAuthority: 'planning_center', externalPeople: [unlinked, linked],
    localPeople: [local({ firstName: 'Old' })],
    batches: [batch({ eligibleExternalPersonIds: ['ext-1', 'ext-2'] })],
    matcher: matcher({
      linked: [{ externalPersonId: 'ext-1', individualId: 1, reason: 'existing_link' }],
      unmatchedExternalIds: ['ext-2'],
    }),
  }));

  assert.deepEqual(plan.updateManagedFields, []);
  assert.deepEqual(plan.addPeople, []);
  assert.deepEqual(plan.skipped, [
    { id: 'skipped:ext-1:1:active_authority_owned', externalPersonId: 'ext-1', individualId: 1,
      reason: 'active_authority_owned', activeAuthority: 'planning_center' },
    { id: 'skipped:ext-2:create_regular_non_authoritative', externalPersonId: 'ext-2',
      reason: 'create_regular_non_authoritative', activeAuthority: 'planning_center' },
  ]);
});

test('manual re-import with no active authority proposes reviewed linked updates', () => {
  const plan = computePeopleSyncPlan(input({
    authoritative: false, activeAuthority: 'none', trigger: 'manual',
    externalPeople: [person({ firstName: 'Augusta', child: true })],
    localPeople: [local({ firstName: 'Ada', isChild: false })],
  }));

  assert.deepEqual(plan.updateManagedFields, [{
    id: 'updateManagedFields:ext-1:1', externalPersonId: 'ext-1', individualId: 1,
    changes: [
      { field: 'firstName', localValue: 'Ada', externalValue: 'Augusta' },
      { field: 'isChild', localValue: false, externalValue: true },
    ],
    reason: 'reviewed_reimport', reviewRequired: true,
  }]);
});

test('authority-none reviewed updates remain limited to already-linked people', () => {
  const plan = computePeopleSyncPlan(input({
    authoritative: false, activeAuthority: 'none', trigger: 'manual',
    externalPeople: [person({ firstName: 'Augusta' })],
    localPeople: [local({ firstName: 'Ada' })],
    matcher: matcher({ matches: [{ externalPersonId: 'ext-1', individualId: 1, reason: 'unique_name' }] }),
  }));

  assert.deepEqual(plan.linkPeople, [{
    id: 'linkPeople:ext-1:1', externalPersonId: 'ext-1', individualId: 1,
    reason: 'unique_name', reviewRequired: false,
  }]);
  assert.deepEqual(plan.updateManagedFields, []);
});

test('provider-neutral people without a status use the qualifying batch default type', () => {
  const external = person({ state: undefined });
  const plan = computePeopleSyncPlan(input({
    provider: 'planning_center', activeAuthority: 'planning_center', externalPeople: [external], localPeople: [],
    batches: [batch({ defaultPeopleType: 'local_visitor' })],
    matcher: matcher({ unmatchedExternalIds: ['ext-1'] }),
  }));

  assert.equal(plan.addPeople[0].peopleType, 'local_visitor');
});

test('repeated matcher IDs cannot duplicate plan actions', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [person()], localPeople: [],
    matcher: matcher({ unmatchedExternalIds: ['ext-1', 'ext-1'] }),
  }));

  assert.equal(plan.addPeople.length, 1);
  assert.equal(plan.addPeople[0].id, 'addPeople:ext-1');
});

test('unmatched local regulars remain review-only baseline items', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [], batches: [batch({ eligibleExternalPersonIds: [] })],
    matcher: matcher({ unmatchedLocalIds: [2, 1] }),
    localPeople: [local({ id: 2, peopleType: 'local_visitor' }), local({ id: 1 })],
  }));

  assert.deepEqual(plan.unmatchedLocalRegulars, [{
    id: 'unmatchedLocalRegulars:1', individualId: 1,
    reason: 'unmatched_local_regular', reviewRequired: true,
  }]);
  assert.deepEqual(plan.archive, []);
});

test('missing counters below two do not archive and confirmed count two does', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [], batches: [batch({ eligibleExternalPersonIds: [] })],
    matcher: matcher(), localPeople: [local({ id: 1 }), local({ id: 2 })],
    missingCandidates: [
      { externalPersonId: 'missing-2', individualId: 2, missingFullSyncCount: 2 },
      { externalPersonId: 'missing-1', individualId: 1, missingFullSyncCount: 1 },
    ],
  }));

  assert.deepEqual(plan.archive, [{
    id: 'archive:missing-2:2', externalPersonId: 'missing-2', individualId: 2,
    reason: 'confirmed_missing_full_sync', missingFullSyncCount: 2,
  }]);
  assert.deepEqual(plan.skipped, [{
    id: 'skipped:missing-1:1:awaiting_missing_confirmation', externalPersonId: 'missing-1',
    individualId: 1, reason: 'awaiting_missing_confirmation', missingFullSyncCount: 1,
  }]);
});

test('stale and contended matcher conflicts are retained and never become additions', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [person({ id: 'stale' }), person({ id: 'contended' })], localPeople: [],
    batches: [batch({ eligibleExternalPersonIds: ['stale', 'contended'] })],
    matcher: matcher({
      ambiguous: [
        { externalPersonId: 'stale', candidateIndividualIds: [], staleLinkedIndividualIds: [90], reason: 'stale_link' },
        { externalPersonId: 'contended', candidateIndividualIds: [7], reason: 'contended_unique_name' },
      ],
      unmatchedExternalIds: ['stale', 'contended'],
    }),
  }));

  assert.deepEqual(plan.ambiguousPeople, [
    { id: 'ambiguousPeople:contended:contended_unique_name', externalPersonId: 'contended',
      candidateIndividualIds: [7], reason: 'contended_unique_name' },
    { id: 'ambiguousPeople:stale:stale_link', externalPersonId: 'stale',
      candidateIndividualIds: [], staleLinkedIndividualIds: [90], reason: 'stale_link' },
  ]);
  assert.deepEqual(plan.addPeople, []);
});

test('auto-remove only removes roster provenance owned by that batch', () => {
  const plan = computePeopleSyncPlan(input({
    batches: [batch({ id: 10, gatheringTypeId: 100, gatheringAutoRemoveEnabled: true,
      eligibleExternalPersonIds: [] })],
    gatheringMemberships: [
      { individualId: 1, gatheringTypeId: 100, addedBySyncBatchId: null },
      { individualId: 2, gatheringTypeId: 100, addedBySyncBatchId: 20 },
      { individualId: 3, gatheringTypeId: 100, addedBySyncBatchId: 10 },
    ],
  }));

  assert.deepEqual(plan.removeFromGathering, [{
    id: 'removeFromGathering:10:100:3', batchId: 10, gatheringTypeId: 100,
    individualId: 3, reason: 'batch_no_longer_eligible',
  }]);
});

test('is pure and produces the same plan regardless of input array order', () => {
  const original = input({
    externalPeople: [person({ id: 'z' }), person({ id: 'a' })],
    localPeople: [local({ id: 2 }), local({ id: 1 })],
    batches: [batch({ id: 2, eligibleExternalPersonIds: ['z'] }), batch({ id: 1, eligibleExternalPersonIds: ['a'] })],
    matcher: matcher({
      linked: [
        { externalPersonId: 'z', individualId: 2, reason: 'existing_link' },
        { externalPersonId: 'a', individualId: 1, reason: 'existing_link' },
      ],
    }),
  });
  const before = structuredClone(original);
  const reversed = structuredClone(original);
  reversed.externalPeople.reverse();
  reversed.localPeople.reverse();
  reversed.batches.reverse();
  reversed.batches.forEach((item) => item.eligibleExternalPersonIds.reverse());
  reversed.matcher.linked.reverse();

  const first = computePeopleSyncPlan(original);
  const second = computePeopleSyncPlan(reversed);

  assert.deepEqual(original, before);
  assert.deepEqual(second, first);
});
