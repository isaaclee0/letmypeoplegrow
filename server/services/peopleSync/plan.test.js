const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computePeopleSyncPlan, summarizePlan, desiredPeopleType } = require('./plan');

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
    personLinks: [], missingCandidates: [], gatheringMemberships: [],
    ...overrides,
  };
}

test('exports the active, contact, and batch-default people type precedence for review context', () => {
  assert.equal(desiredPeopleType({ state: 'active' }, [{ defaultPeopleType: 'local_visitor' }]), 'regular');
  assert.equal(desiredPeopleType({ state: 'contact' }, [{ defaultPeopleType: 'regular' }]), 'local_visitor');
  assert.equal(desiredPeopleType({ state: 'other' }, [
    { defaultPeopleType: 'local_visitor' }, { defaultPeopleType: 'regular' },
  ]), 'regular');
});

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

for (const provider of ['planning_center', 'elvanto']) {
  test(`${provider} creates one family action for an entirely new household`, () => {
    const ada = person({ id: 'ext-1', familyId: 'house-1' });
    const charles = person({
      id: 'ext-2', firstName: 'Charles', lastName: 'Lovelace', familyId: 'house-1',
    });
    const plan = computePeopleSyncPlan(input({
      provider,
      externalPeople: [ada, charles], householdPeople: [ada, charles], localPeople: [],
      externalFamilies: [{
        id: 'house-1', name: 'Provider Household', memberExternalIds: ['ext-2', 'ext-1'],
      }],
      localFamilies: [], familyLinks: [], personLinks: [],
      batches: [batch({ eligibleExternalPersonIds: ['ext-1', 'ext-2'] })],
      matcher: matcher({ unmatchedExternalIds: ['ext-1', 'ext-2'] }),
    }));

    assert.deepEqual(plan.addFamilies, [{
      id: 'addFamilies:house-1', externalFamilyId: 'house-1',
      familyName: 'Lovelace, Ada and Charles', memberExternalIds: ['ext-1', 'ext-2'],
      reason: 'all_household_members_new',
    }]);
    assert.equal(plan.addPeople.every((action) => action.familyId === 'house-1'), true);
    assert.deepEqual(plan.linkFamilies, []);
    assert.deepEqual(plan.familyConflicts, []);
  });
}

test('names a newly created one-person household after the individual', () => {
  const ada = person({ familyId: 'house-1' });
  const plan = computePeopleSyncPlan(input({
    externalPeople: [ada], householdPeople: [ada], localPeople: [],
    externalFamilies: [{ id: 'house-1', name: 'Provider Household', memberExternalIds: ['ext-1'] }],
    localFamilies: [], familyLinks: [], personLinks: [],
    matcher: matcher({ unmatchedExternalIds: ['ext-1'] }),
  }));

  assert.equal(plan.addFamilies[0].familyName, 'Lovelace, Ada');
});

test('reuses an existing external family link without planning a duplicate family mutation', () => {
  const ada = person({ familyId: 'house-1' });
  const plan = computePeopleSyncPlan(input({
    externalPeople: [ada], householdPeople: [ada], localPeople: [],
    externalFamilies: [{ id: 'house-1', memberExternalIds: ['ext-1'] }],
    localFamilies: [{ id: 9, familyName: 'Existing' }],
    familyLinks: [{ externalFamilyId: 'house-1', familyId: 9 }], personLinks: [],
    matcher: matcher({ unmatchedExternalIds: ['ext-1'] }),
  }));

  assert.deepEqual(plan.linkFamilies, []);
  assert.deepEqual(plan.addFamilies, []);
  assert.deepEqual(plan.familyConflicts, []);
});

test('links a new external household to the one local family established by a matched member', () => {
  const existing = person({ id: 'ext-existing', firstName: 'Ada', familyId: 'house-1' });
  const newcomer = person({ id: 'ext-new', firstName: 'Charles', familyId: 'house-1' });
  const plan = computePeopleSyncPlan(input({
    externalPeople: [existing, newcomer], householdPeople: [existing, newcomer],
    localPeople: [local({ id: 1, familyId: 9 })],
    externalFamilies: [{ id: 'house-1', memberExternalIds: ['ext-existing', 'ext-new'] }],
    localFamilies: [{ id: 9, familyName: 'Lovelace, Ada' }], familyLinks: [], personLinks: [],
    batches: [batch({ eligibleExternalPersonIds: ['ext-existing', 'ext-new'] })],
    matcher: matcher({
      linked: [{ externalPersonId: 'ext-existing', individualId: 1, reason: 'existing_link' }],
      unmatchedExternalIds: ['ext-new'],
    }),
  }));

  assert.deepEqual(plan.linkFamilies, [{
    id: 'linkFamilies:house-1:9', externalFamilyId: 'house-1', familyId: 9,
    memberExternalIds: ['ext-existing', 'ext-new'], reason: 'household_member_family',
  }]);
  assert.deepEqual(plan.addFamilies, []);
  assert.deepEqual(plan.familyConflicts, []);
});

test('does not reconcile a household whose matched members belong to multiple local families', () => {
  const first = person({ id: 'ext-1', familyId: 'house-1' });
  const second = person({ id: 'ext-2', firstName: 'Grace', familyId: 'house-1' });
  const plan = computePeopleSyncPlan(input({
    externalPeople: [first, second], householdPeople: [first, second],
    localPeople: [local({ id: 1, familyId: 9 }), local({ id: 2, firstName: 'Grace', familyId: 10 })],
    externalFamilies: [{ id: 'house-1', memberExternalIds: ['ext-1', 'ext-2'] }],
    localFamilies: [{ id: 9, familyName: 'One' }, { id: 10, familyName: 'Two' }],
    familyLinks: [], personLinks: [],
    batches: [batch({ eligibleExternalPersonIds: ['ext-1', 'ext-2'] })],
    matcher: matcher({ linked: [
      { externalPersonId: 'ext-1', individualId: 1, reason: 'existing_link' },
      { externalPersonId: 'ext-2', individualId: 2, reason: 'existing_link' },
    ] }),
  }));

  assert.deepEqual(plan.linkFamilies, []);
  assert.deepEqual(plan.addFamilies, []);
  assert.deepEqual(plan.familyConflicts, [{
    id: 'familyConflicts:house-1:multiple_local_families', externalFamilyId: 'house-1',
    memberExternalIds: ['ext-1', 'ext-2'], candidateFamilyIds: [9, 10],
    unresolvedExternalPersonIds: [], reason: 'multiple_local_families',
  }]);
});

test('does not create a family when household-only context is unresolved', () => {
  const member = person({ id: 'member', familyId: 'house-1' });
  const contextPerson = person({ id: 'context', firstName: 'Context', familyId: 'house-1' });
  const plan = computePeopleSyncPlan(input({
    externalPeople: [member], householdPeople: [member, contextPerson], localPeople: [],
    externalFamilies: [{ id: 'house-1', memberExternalIds: ['member', 'context'] }],
    localFamilies: [], familyLinks: [], personLinks: [],
    batches: [batch({ eligibleExternalPersonIds: ['member'] })],
    matcher: matcher({ unmatchedExternalIds: ['member'] }),
  }));

  assert.deepEqual(plan.addFamilies, []);
  assert.deepEqual(plan.familyConflicts, [{
    id: 'familyConflicts:house-1:unresolved_household_members', externalFamilyId: 'house-1',
    memberExternalIds: ['context', 'member'], candidateFamilyIds: [],
    unresolvedExternalPersonIds: ['context'], reason: 'unresolved_household_members',
  }]);
});

test('source-rule exclusions never archive linked non-terminal people', () => {
  const active = computePeopleSyncPlan(input({
    externalPeople: [person({ state: 'active' })],
    batches: [batch({ eligibleExternalPersonIds: [] })],
  }));
  const plan = computePeopleSyncPlan(input({
    settings: { includeContacts: false, alignPeopleType: true },
    externalPeople: [person({ state: 'contact' })],
  }));

  assert.deepEqual(active.archive, []);
  assert.deepEqual(plan.archive, []);
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
      reason: 'provider_state_archived' },
    { id: 'archive:deceased-1:2', externalPersonId: 'deceased-1', individualId: 2,
      reason: 'provider_state_deceased' },
  ]);
});

test('a terminal linked person keeps its sync-owned gathering assignment for lifecycle review', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [person({ id: 'archived-1', state: 'archived' })],
    localPeople: [local({ id: 7 })],
    batches: [batch({
      id: 10,
      gatheringTypeId: 100,
      gatheringAutoRemoveEnabled: true,
      eligibleExternalPersonIds: ['archived-1'],
    })],
    matcher: matcher({
      linked: [{ externalPersonId: 'archived-1', individualId: 7, reason: 'existing_link' }],
    }),
    gatheringMemberships: [
      { gatheringTypeId: 100, individualId: 7, addedBySyncBatchId: 10 },
    ],
  }));

  assert.deepEqual(plan.archive, [{
    id: 'archive:archived-1:7',
    externalPersonId: 'archived-1',
    individualId: 7,
    reason: 'provider_state_archived',
  }]);
  assert.deepEqual(plan.addToGathering, []);
  assert.deepEqual(plan.removeFromGathering, []);
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

test('a projected link changes only provider fields with known values on its new local target', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [person({ firstName: null, lastName: 'External' })],
    localPeople: [
      local({ id: 10, firstName: 'Old', lastName: 'Target' }),
      local({ id: 20, firstName: 'Known', lastName: 'Local' }),
    ],
    matcher: matcher({
      linked: [{ externalPersonId: 'ext-1', individualId: 20, reason: 'existing_link' }],
    }),
    personLinks: [{ externalPersonId: 'ext-1', individualId: 20, missingFullSyncCount: 0 }],
  }));

  assert.deepEqual(plan.updateManagedFields, [{
    id: 'updateManagedFields:ext-1:20', externalPersonId: 'ext-1', individualId: 20,
    changes: [{ field: 'lastName', localValue: 'Local', externalValue: 'External' }],
    reason: 'provider_managed_fields', reviewRequired: false,
  }]);
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

test('review-only matches cannot emit dependent terminal, reactivate, type, or managed-field actions', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [
      person({ id: 'terminal', state: 'archived' }),
      person({ id: 'reactivate', state: 'active' }),
      person({ id: 'type', state: 'contact' }),
      person({ id: 'fields', state: 'active', firstName: 'External' }),
    ],
    localPeople: [
      local({ id: 1 }),
      local({ id: 2, isActive: false }),
      local({ id: 3, peopleType: 'regular' }),
      local({ id: 4, firstName: 'Local' }),
    ],
    batches: [batch({ eligibleExternalPersonIds: ['terminal', 'reactivate', 'type', 'fields'] })],
    matcher: matcher({
      visitorMatches: [
        { externalPersonId: 'terminal', individualId: 1, peopleType: 'local_visitor' },
        { externalPersonId: 'type', individualId: 3, peopleType: 'local_visitor' },
        { externalPersonId: 'fields', individualId: 4, peopleType: 'local_visitor' },
      ],
      archivedMatches: [{ externalPersonId: 'reactivate', individualId: 2 }],
    }),
  }));

  assert.deepEqual(plan.linkPeople.map((action) => [action.externalPersonId, action.reviewRequired]), [
    ['fields', true], ['reactivate', true], ['terminal', true], ['type', true],
  ]);
  assert.deepEqual(plan.archive, []);
  assert.deepEqual(plan.reactivate, []);
  assert.deepEqual(plan.promoteToRegular, []);
  assert.deepEqual(plan.demoteToLocalVisitor, []);
  assert.deepEqual(plan.updateManagedFields, []);
});

test('conflicting matcher identity buckets become ambiguity without dependent actions', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [person({ firstName: 'External' })],
    localPeople: [local({ id: 1, firstName: 'One' }), local({ id: 2, firstName: 'Two', isActive: false })],
    batches: [batch({ gatheringTypeId: 100 })],
    matcher: matcher({
      linked: [{ externalPersonId: 'ext-1', individualId: 1, reason: 'existing_link' }],
      archivedMatches: [{ externalPersonId: 'ext-1', individualId: 2 }],
    }),
  }));

  assert.deepEqual(plan.ambiguousPeople, [{
    id: 'ambiguousPeople:ext-1:conflicting_matcher_identity', externalPersonId: 'ext-1',
    candidateIndividualIds: [1, 2], matcherBuckets: ['archivedMatches', 'linked'],
    reason: 'conflicting_matcher_identity',
  }]);
  assert.deepEqual(plan.linkPeople, []);
  assert.deepEqual(plan.updateManagedFields, []);
  assert.deepEqual(plan.reactivate, []);
  assert.deepEqual(plan.addToGathering, []);
});

test('pending matcher identity conflicts protect every candidate roster row from removal', () => {
  const plan = computePeopleSyncPlan(input({
    batches: [batch({ gatheringTypeId: 100, gatheringAutoRemoveEnabled: true,
      eligibleExternalPersonIds: [] })],
    matcher: matcher({
      linked: [{ externalPersonId: 'ext-1', individualId: 1, reason: 'existing_link' }],
      matches: [{ externalPersonId: 'ext-1', individualId: 2, reason: 'unique_name' }],
    }),
    localPeople: [local({ id: 1 }), local({ id: 2 })],
    gatheringMemberships: [
      { gatheringTypeId: 100, individualId: 1, addedBySyncBatchId: 1 },
      { gatheringTypeId: 100, individualId: 2, addedBySyncBatchId: 1 },
    ],
  }));

  assert.deepEqual(plan.removeFromGathering, []);
});

test('does not propose an archive when a durable link is absent from a complete source read', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [], batches: [batch({ eligibleExternalPersonIds: [] })],
    matcher: matcher(),
    personLinks: [{ externalPersonId: 'missing', individualId: 1, missingFullSyncCount: 1 }],
  }));

  assert.deepEqual(plan.archive, []);
  assert.equal(plan.skipped.some((action) => action.reason === 'awaiting_missing_confirmation'), false);
  assert.equal(plan.skipped.some((action) => action.reason === 'confirmed_missing_full_sync'), false);
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

test('unmatched unlinked locals never become archive actions', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [], batches: [batch({ eligibleExternalPersonIds: [] })],
    matcher: matcher({ unmatchedLocalIds: [3, 2, 1] }),
    localPeople: [
      local({ id: 1 }),
      local({ id: 2, peopleType: 'local_visitor' }),
      local({ id: 3, isActive: false }),
    ],
  }));

  assert.deepEqual(plan.unmatchedLocalRegulars, []);
  assert.deepEqual(plan.archive, []);
});

test('plans retain an empty compatibility presence projection for every snapshot shape', () => {
  const common = {
    externalPeople: [], batches: [batch({ eligibleExternalPersonIds: [] })], matcher: matcher(),
    personLinks: [{ externalPersonId: 'missing', individualId: 1, missingFullSyncCount: 9 }],
  };
  const complete = computePeopleSyncPlan(input({ ...common }));
  const partial = computePeopleSyncPlan(input({
    ...common, snapshot: { fetchedAt: 'now', watermark: 'wm', mode: 'full', complete: false },
  }));

  assert.deepEqual(complete.presenceProjection, { completeFullSnapshot: false, updates: [] });
  assert.deepEqual(partial.presenceProjection, { completeFullSnapshot: false, updates: [] });
  assert.deepEqual(complete.archive, []);
  assert.deepEqual(partial.archive, []);
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

test('rejects unsafe numeric local and action identifiers', () => {
  assert.throws(() => computePeopleSyncPlan(input({
    localPeople: [local({ id: Number.MAX_SAFE_INTEGER + 1 })],
    matcher: matcher({ linked: [{ externalPersonId: 'ext-1', individualId: Number.MAX_SAFE_INTEGER + 1 }] }),
  })), /safe positive integer/i);
  assert.throws(() => computePeopleSyncPlan(input({
    batches: [batch({ id: NaN })],
  })), /safe positive integer/i);
  assert.throws(() => computePeopleSyncPlan(input({
    batches: [batch({ gatheringTypeId: Infinity })],
  })), /safe positive integer/i);
  assert.throws(() => computePeopleSyncPlan(input({
    externalPeople: [person({ id: Number.MAX_SAFE_INTEGER + 1 })],
  })), /safe positive integer/i);
});

test('action IDs remain distinct when external IDs and reasons contain separators', () => {
  const plan = computePeopleSyncPlan(input({
    externalPeople: [person({ id: 'a' }), person({ id: 'a:b' })], localPeople: [],
    batches: [batch({ eligibleExternalPersonIds: ['a', 'a:b'] })],
    matcher: matcher({ ambiguous: [
      { externalPersonId: 'a', candidateIndividualIds: [], reason: 'b:c' },
      { externalPersonId: 'a:b', candidateIndividualIds: [], reason: 'c' },
    ] }),
  }));

  assert.equal(plan.ambiguousPeople.length, 2);
  assert.equal(new Set(plan.ambiguousPeople.map((action) => action.id)).size, 2);
});
