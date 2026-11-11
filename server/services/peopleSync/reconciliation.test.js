const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computePeopleSyncPlan, projectAdditiveImportPlan } = require('./plan');
const { validateDestructiveSelections } = require('./identityDecisions');

function fixture(overrides = {}) {
  return {
    provider: 'planning_center', authoritative: true,
    snapshot: { mode: 'full', complete: true },
    externalPeople: [
      { id: 'bruce', firstName: 'Bruce', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] },
      { id: 'bronwyn', firstName: 'Bronwyn', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] },
    ],
    externalFamilies: [{ id: 'hh', name: 'Smith household', memberExternalIds: ['bruce', 'bronwyn', 'excluded'] }],
    localPeople: [
      { id: 1, firstName: 'Bruce', lastName: 'Smith', familyId: 10 },
      { id: 2, firstName: 'Bronwyn', lastName: 'Smith', familyId: 20 },
      { id: 3, firstName: 'Unrelated', lastName: 'Local', familyId: 10 },
    ],
    localFamilies: [{ id: 10, familyName: 'First' }, { id: 20, familyName: 'Second' }],
    personLinks: [{ externalPersonId: 'bruce', individualId: 1 }, { externalPersonId: 'bronwyn', individualId: 2 }],
    familyLinks: [],
    matcher: { linked: [{ externalPersonId: 'bruce', individualId: 1 }, { externalPersonId: 'bronwyn', individualId: 2 }] },
    batches: [{ id: 7, enabled: true, gatheringTypeId: 100, source: { kind: 'planning_center_list', externalId: 'members', name: 'Members' } }],
    eligibleByBatch: new Map([[7, new Set(['bruce', 'bronwyn'])]]),
    gatheringMemberships: [], ...overrides,
  };
}

for (const membership of ['multiple', 'none']) {
  test(`locally managed people with ${membership} provider households receive no provider family action`, () => {
    const input = fixture({ localHouseholdExternalIds: new Set(['bruce', 'bronwyn']) });
    input.externalPeople = input.externalPeople.map((person) => ({
      ...person, familyId: membership === 'none' ? null : 'hh', householdIds: membership === 'none' ? [] : ['hh', 'other'],
    }));
    input.externalFamilies = membership === 'none' ? [] : [
      { id: 'hh', memberExternalIds: ['bruce', 'bronwyn'] }, { id: 'other', memberExternalIds: ['bruce', 'bronwyn'] },
    ];
    const plan = computePeopleSyncPlan(input);
    for (const bucket of ['linkFamilies', 'addFamilies', 'familyConflicts', 'moveFamily', 'renameFamily']) assert.deepEqual(plan[bucket], []);
  });
}

function mixedLocalHouseholdFixture({ sharedLocalFamily = false } = {}) {
  const input = fixture({ localHouseholdExternalIds: new Set(['bruce', 'bronwyn']) });
  input.externalPeople = [
    ...input.externalPeople.map((person) => ({ ...person, householdIds: ['hh', 'other'] })),
    { id: 'relative', firstName: 'Rae', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] },
  ];
  input.externalFamilies = [
    { id: 'hh', name: 'Smith household', memberExternalIds: ['bruce', 'bronwyn', 'relative'] },
    { id: 'other', name: 'Other household', memberExternalIds: ['bruce', 'bronwyn'] },
  ];
  input.localPeople = [...input.localPeople.slice(0, 2), { id: 3, firstName: 'Rae', lastName: 'Smith', familyId: sharedLocalFamily ? 10 : 30 }];
  input.localFamilies.push({ id: 30, familyName: 'Rae local family' });
  input.personLinks.push({ externalPersonId: 'relative', individualId: 3 });
  input.matcher.linked.push({ externalPersonId: 'relative', individualId: 3 });
  input.eligibleByBatch.get(7).add('relative');
  return input;
}

test('managed multi-household relatives do not block a valid provider family link for an unmanaged person', () => {
  const input = mixedLocalHouseholdFixture();
  const original = structuredClone(input);
  const plan = computePeopleSyncPlan(input);
  assert.deepEqual(plan.familyConflicts, []);
  assert.deepEqual(plan.addFamilies, []);
  assert.deepEqual(plan.linkFamilies, [{
    id: 'linkFamilies:hh:30', externalFamilyId: 'hh', familyId: 30,
    memberExternalIds: ['relative'], reason: 'household_member_family',
  }]);
  assert.deepEqual(input, original);
});

test('excluding managed residents never claims their shared local family for the remaining provider member', () => {
  const plan = computePeopleSyncPlan(mixedLocalHouseholdFixture({ sharedLocalFamily: true }));
  assert.deepEqual(plan.linkFamilies, []);
  assert.deepEqual(plan.addFamilies, []);
  assert.equal(plan.familyConflicts.length, 1);
  assert.deepEqual(plan.familyConflicts[0].memberExternalIds, ['relative']);
  assert.deepEqual(plan.familyConflicts[0].resolution, {
    kind: 'household', destination: { kind: 'create', familyName: 'Smith household' },
    moves: [{ externalPersonId: 'relative', individualId: 3, fromFamilyId: 10 }],
  });
});

test('provider ownership guards still apply after locally managed household members are excluded', () => {
  const input = mixedLocalHouseholdFixture();
  input.familyLinks.push({ externalFamilyId: 'hh', familyId: 20 });
  input.localFamilies.find(({ id }) => id === 20).planningCenterId = 'other';
  const originalLinks = structuredClone(input.familyLinks);
  const plan = computePeopleSyncPlan(input);
  assert.deepEqual(plan.linkFamilies, []);
  assert.equal(plan.familyConflicts.length, 1);
  assert.deepEqual(plan.familyConflicts[0].memberExternalIds, ['relative']);
  assert.equal(plan.familyConflicts[0].reason, 'conflicting_family_ownership');
  assert.equal(plan.familyConflicts[0].resolution, undefined);
  assert.deepEqual(input.familyLinks, originalLinks);
});

test('complete authoritative household reconciliation creates a reviewed destination for split local families, moving only linked source members', () => {
  const plan = computePeopleSyncPlan(fixture());
  assert.deepEqual(plan.familyConflicts[0].resolution, {
    kind: 'household', destination: { kind: 'create', familyName: 'Smith household' },
    moves: [
      { externalPersonId: 'bronwyn', individualId: 2, fromFamilyId: 20 },
      { externalPersonId: 'bruce', individualId: 1, fromFamilyId: 10 },
    ],
  });
  assert.deepEqual(plan.moveFamily, []);
  assert.deepEqual(plan.addFamilies, []);
  assert.deepEqual(plan.addPeople, []);
});

test('a linked destination still exposes household members currently in another local family', () => {
  const plan = computePeopleSyncPlan(fixture({ familyLinks: [{ externalFamilyId: 'hh', familyId: 20 }] }));
  assert.equal(plan.familyConflicts.length, 1);
  assert.deepEqual(plan.familyConflicts[0].resolution.destination, { kind: 'existing', familyId: 20, familyName: 'Second' });
  assert.deepEqual(plan.familyConflicts[0].resolution.moves, [{ externalPersonId: 'bruce', individualId: 1, fromFamilyId: 10 }]);
});

test('explicit no-household gives a linked source member a personal family without deleting their former family', () => {
  const input = fixture();
  input.externalPeople = [{ ...input.externalPeople[0], familyId: null, householdIds: [] }];
  input.externalFamilies = [];
  const conflict = computePeopleSyncPlan(input).familyConflicts[0];
  assert.equal(conflict.externalFamilyId, null);
  assert.deepEqual(conflict.resolution, { kind: 'single_person', destination: { kind: 'create', familyName: 'SMITH, Bruce' }, moves: [
    { externalPersonId: 'bruce', individualId: 1, fromFamilyId: 10 },
  ] });
});

test('one local family shared by two provider households receives independent reviewed split proposals', () => {
  const input = fixture();
  input.localPeople[1].familyId = 10;
  input.externalPeople[1].familyId = 'hh2';
  input.externalPeople[1].householdIds = ['hh2'];
  input.externalFamilies = [
    { id: 'hh', name: 'Bruce household', memberExternalIds: ['bruce'] },
    { id: 'hh2', name: 'Bronwyn household', memberExternalIds: ['bronwyn'] },
  ];
  const plan = computePeopleSyncPlan(input);
  assert.equal(plan.familyConflicts.filter((action) => action.resolution).length, 2);
  assert.deepEqual(plan.linkFamilies, []);
  assert.ok(plan.familyConflicts.every((action) => action.resolution.destination.kind === 'create'));
});

for (const scenario of ['partial', 'delta', 'non-authority', 'ambiguous', 'unknown-household', 'multiple-households', 'conflicting-family-owner']) {
  test(`household corrections fail closed for ${scenario}`, () => {
    const input = fixture();
    if (scenario === 'partial') input.snapshot.complete = false;
    if (scenario === 'delta') input.snapshot.mode = 'delta';
    if (scenario === 'non-authority') input.authoritative = false;
    if (scenario === 'ambiguous') input.matcher.ambiguous = [{ externalPersonId: 'bruce', candidateIndividualIds: [1] }];
    if (scenario === 'unknown-household') input.externalPeople[0].householdIds = null;
    if (scenario === 'multiple-households') input.externalPeople[0].householdIds = ['hh', 'hh2'];
    if (scenario === 'conflicting-family-owner') input.familyLinks = [{ externalFamilyId: 'other', familyId: 20 }, { externalFamilyId: 'hh', familyId: 20 }];
    assert.ok(computePeopleSyncPlan(input).familyConflicts.every((action) => !action.resolution));
  });
}

function rosterFixture() {
  const input = fixture();
  input.externalPeople = [];
  input.externalFamilies = [];
  input.matcher = {};
  input.eligibleByBatch = new Map([[7, new Set()]]);
  input.memberIdsByBatch = new Map([[7, new Set()]]);
  input.gatheringMemberships = [{ gatheringTypeId: 100, individualId: 1, addedBySyncBatchId: null, gatheringName: 'Sunday' }];
  return input;
}

test('legacy membership removal is review-required and relies on durable identity even when person is absent from every source', () => {
  const action = computePeopleSyncPlan(rosterFixture()).removeFromGathering[0];
  assert.equal(action.reason, 'legacy_roster_not_in_source');
  assert.equal(action.reviewRequired, true);
  assert.equal(action.batchId, null);
  assert.equal(action.externalPersonId, 'bruce');
  assert.deepEqual(action.sourceBatchIds, [7]);
  assert.deepEqual(action.sourceIdentities, [{ batchId: 7, kind: 'planning_center_list', externalId: 'members' }]);
  assert.equal(action.gatheringName, 'Sunday');
});

for (const scenario of ['partial', 'non-authority', 'unlinked', 'ambiguous', 'other-eligible', 'other-unread', 'other-disabled', 'other-provider', 'legacy-pco-owner', 'missing-membership', 'missing-source-identity']) {
  test(`legacy membership is protected for ${scenario}`, () => {
    const input = rosterFixture();
    if (scenario === 'partial') input.snapshot.complete = false;
    if (scenario === 'non-authority') input.authoritative = false;
    if (scenario === 'unlinked') input.personLinks = [];
    if (scenario === 'ambiguous') input.matcher.ambiguous = [{ externalPersonId: 'unknown', candidateIndividualIds: [1] }];
    if (scenario === 'other-provider') input.gatheringMemberships[0].hasOtherProviderSources = true;
    if (scenario === 'legacy-pco-owner') input.gatheringMemberships[0].addedByPcoBatchId = 9;
    if (scenario === 'missing-membership') delete input.memberIdsByBatch;
    if (scenario === 'missing-source-identity') delete input.batches[0].source.externalId;
    if (scenario.startsWith('other-') && scenario !== 'other-provider') {
      input.batches.push({ id: 8, enabled: scenario !== 'other-disabled', gatheringTypeId: 100, source: { kind: 'planning_center_list', externalId: 'youth', name: 'Youth' } });
      input.eligibleByBatch.set(8, new Set(scenario === 'other-eligible' ? ['bruce'] : []));
      if (scenario !== 'other-unread') input.memberIdsByBatch.set(8, input.eligibleByBatch.get(8));
    }
    assert.deepEqual(computePeopleSyncPlan(input).removeFromGathering, []);
  });
}

test('new reconciliation selections default off and reject IDs outside the offered signed proposals', () => {
  const plan = computePeopleSyncPlan(fixture());
  plan.removeFromGathering = computePeopleSyncPlan(rosterFixture()).removeFromGathering;
  const empty = validateDestructiveSelections(plan, {});
  assert.equal(empty.acceptedFamilyResolutionIds.size, 0);
  assert.equal(empty.acceptedGatheringRemovalIds.size, 0);
  const selections = { acceptFamilyResolutionIds: [plan.familyConflicts[0].id], acceptGatheringRemovalIds: [plan.removeFromGathering[0].id] };
  const accepted = validateDestructiveSelections(plan, selections);
  assert.deepEqual([...accepted.acceptedFamilyResolutionIds], selections.acceptFamilyResolutionIds);
  assert.deepEqual([...accepted.acceptedGatheringRemovalIds], selections.acceptGatheringRemovalIds);
  for (const key of ['acceptFamilyResolutionIds', 'acceptGatheringRemovalIds']) {
    assert.throws(() => validateDestructiveSelections(plan, { [key]: ['forged'] }), /not offered/i);
    assert.throws(() => validateDestructiveSelections(plan, { [key]: 'invalid' }), /array/i);
  }
});

test('additive imports never expose actionable household corrections', () => {
  const plan = projectAdditiveImportPlan(computePeopleSyncPlan(fixture()), 'planning_center');
  assert.ok(plan.familyConflicts.every((action) => !action.resolution));
});

function exactLocalHouseholdFixture() {
  const input = fixture();
  input.externalPeople = [input.externalPeople[0]];
  input.externalFamilies = [{ id: 'hh', name: 'Smith household', memberExternalIds: ['bruce', 'excluded'] }];
  input.localPeople = [input.localPeople[0]];
  input.personLinks = [input.personLinks[0]];
  input.matcher.linked = [input.matcher.linked[0]];
  input.eligibleByBatch = new Map([[7, new Set(['bruce'])]]);
  return input;
}

test('an exact local household can establish its missing provider link despite excluded household-only people', () => {
  const plan = computePeopleSyncPlan(exactLocalHouseholdFixture());
  assert.deepEqual(plan.familyConflicts, []);
  assert.deepEqual(plan.linkFamilies, [{
    id: 'linkFamilies:hh:10', externalFamilyId: 'hh', familyId: 10,
    memberExternalIds: ['bruce'], reason: 'household_member_family',
  }]);
  assert.deepEqual(plan.addPeople, []);
  assert.deepEqual(plan.addFamilies, []);
  assert.deepEqual(plan.moveFamily, []);
});

function householdWithContextChild() {
  const input = exactLocalHouseholdFixture();
  input.householdPeople = [...input.externalPeople, {
    id: 'excluded', firstName: 'Child', lastName: 'Smith', familyId: 'hh', householdIds: ['hh'],
  }];
  input.localPeople.push({ id: 3, firstName: 'Child', lastName: 'Smith', familyId: 10 });
  input.personLinks.push({ externalPersonId: 'excluded', individualId: 3 });
  return input;
}

test('a durably linked household-only child corroborates the local family without becoming a sync target', () => {
  const plan = computePeopleSyncPlan(householdWithContextChild());
  assert.deepEqual(plan.familyConflicts, []);
  assert.deepEqual(plan.linkFamilies.map(({ familyId, memberExternalIds }) => [familyId, memberExternalIds]), [[10, ['bruce']]]);
  assert.deepEqual(plan.moveFamily, []);
  assert.deepEqual(plan.addPeople, []);
  assert.deepEqual(plan.linkPeople, []);
  assert.ok(plan.addToGathering.every((entry) => entry.externalPersonId === 'bruce'));
});

for (const guard of ['unknown', 'missing', 'contradictory', 'multiple-households', 'ambiguous-link']) {
  test(`household-only child with ${guard} evidence does not authorize linking or splitting the local family`, () => {
    const input = householdWithContextChild();
    if (guard === 'unknown') input.householdPeople[1].householdIds = null;
    if (guard === 'missing') {
      input.householdPeople.pop();
      input.externalFamilies[0].memberExternalIds.pop();
    }
    if (guard === 'contradictory') input.householdPeople[1].householdIds = ['other'];
    if (guard === 'multiple-households') input.householdPeople[1].householdIds = ['hh', 'other'];
    if (guard === 'ambiguous-link') input.personLinks.push({ externalPersonId: 'also-excluded', individualId: 3 });
    const plan = computePeopleSyncPlan(input);
    assert.deepEqual(plan.linkFamilies, []);
    assert.ok(plan.familyConflicts.length > 0);
    assert.ok(plan.familyConflicts.every((action) => !action.resolution));
  });
}

test('a linked household-only child can corroborate a destination for an in-scope move', () => {
  const input = householdWithContextChild();
  input.externalPeople.push({ id: 'sibling', firstName: 'Sibling', familyId: 'hh', householdIds: ['hh'] });
  input.externalFamilies[0].memberExternalIds.push('sibling');
  input.localPeople.push({ id: 4, firstName: 'Sibling', familyId: null });
  const link = { externalPersonId: 'sibling', individualId: 4 };
  input.personLinks.push(link);
  input.matcher.linked.push(link);
  input.eligibleByBatch.get(7).add('sibling');
  assert.deepEqual(computePeopleSyncPlan(input).familyConflicts[0].resolution, {
    kind: 'household', destination: { kind: 'existing', familyId: 10, familyName: 'First' },
    moves: [{ externalPersonId: 'sibling', individualId: 4, fromFamilyId: null }],
  });
});

test('a known provider family link identifies its destination even when a former housemate is outside the snapshot', () => {
  const input = fixture({ familyLinks: [{ externalFamilyId: 'hh', familyId: 20 }] });
  input.personLinks.push({ externalPersonId: 'other', individualId: 3 });
  assert.deepEqual(computePeopleSyncPlan(input).familyConflicts[0].resolution.moves, [
    { externalPersonId: 'bruce', individualId: 1, fromFamilyId: 10 },
  ]);
});

for (const destination of ['new', 'linked']) {
  test(`a move to a ${destination} family cannot separate a parent from their co-housed, excluded child`, () => {
    const input = householdWithContextChild();
    input.localPeople.push({ id: 4, firstName: 'Other', familyId: 10 });
    if (destination === 'linked') input.familyLinks.push({ externalFamilyId: 'hh', familyId: 20 });
    const plan = computePeopleSyncPlan(input);
    assert.deepEqual(plan.linkFamilies, []);
    assert.deepEqual(plan.addFamilies, []);
    assert.equal(plan.familyConflicts[0].reason, 'household_member_outside_source');
    assert.equal(plan.familyConflicts[0].resolution, undefined);
  });
}

for (const guard of ['partial', 'unrelated-local-member', 'unknown-household', 'multiple-households', 'ambiguous-identity', 'conflicting-ownership']) {
  test(`missing household links remain blocked for ${guard}`, () => {
    const input = exactLocalHouseholdFixture();
    if (guard === 'partial') input.snapshot.complete = false;
    if (guard === 'unrelated-local-member') input.localPeople.push({ id: 3, firstName: 'Unrelated', lastName: 'Local', familyId: 10 });
    if (guard === 'unknown-household') input.externalPeople[0].householdIds = null;
    if (guard === 'multiple-households') input.externalPeople[0].householdIds = ['hh', 'other'];
    if (guard === 'ambiguous-identity') input.matcher.ambiguous = [{ externalPersonId: 'bruce', candidateIndividualIds: [1] }];
    if (guard === 'conflicting-ownership') input.familyLinks = [{ externalFamilyId: 'other', familyId: 10 }];
    assert.deepEqual(computePeopleSyncPlan(input).linkFamilies, []);
  });
}
