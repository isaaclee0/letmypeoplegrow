'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computePeopleSyncPlan } = require('./plan');
const { buildReviewContext } = require('./reviewContext');

function fixture(overrides = {}) {
  return {
    provider: 'planning_center', authoritative: true,
    snapshot: { mode: 'full', complete: true },
    externalPeople: [{ id: 'betty', firstName: 'Betty', lastName: 'Bultman', state: 'active', familyId: null, householdIds: [] }],
    externalFamilies: [],
    localPeople: [{ id: 1, firstName: 'Betty', lastName: 'Bultman', familyId: null }],
    localFamilies: [], personLinks: [{ externalPersonId: 'betty', individualId: 1 }], familyLinks: [],
    matcher: { linked: [{ externalPersonId: 'betty', individualId: 1 }] },
    batches: [{ id: 7, enabled: true }], eligibleByBatch: new Map([[7, new Set(['betty'])]]),
    ...overrides,
  };
}

test('confirmed empty PCO households offer a named one-person LMPG family', () => {
  const plan = computePeopleSyncPlan(fixture());
  assert.deepEqual(plan.familyConflicts[0]?.resolution, {
    kind: 'single_person', destination: { kind: 'create', familyName: 'BULTMAN, Betty' },
    moves: [{ externalPersonId: 'betty', individualId: 1, fromFamilyId: null }],
  });
  assert.equal(plan.familyConflicts[0].externalFamilyId, null);
});

test('an existing unlinked singleton family is kept, including a manually chosen name', () => {
  const input = fixture();
  input.localPeople[0].familyId = 10;
  input.localFamilies = [{ id: 10, familyName: 'Betty at home' }];
  const plan = computePeopleSyncPlan(input);
  assert.deepEqual(plan.familyConflicts, []);
  assert.deepEqual(plan.addFamilies, []);
});

test('a shared or provider-owned family is never reused as a personal family', () => {
  for (const kind of ['shared', 'owned']) {
    const input = fixture();
    input.localPeople[0].familyId = 10;
    input.localFamilies = [{ id: 10, familyName: 'Old family' }];
    if (kind === 'shared') input.localPeople.push({ id: 2, firstName: 'Other', familyId: 10 });
    else input.familyLinks.push({ externalFamilyId: 'old', familyId: 10 });
    const action = computePeopleSyncPlan(input).familyConflicts[0];
    assert.equal(action.resolution.kind, 'single_person');
    assert.equal(action.resolution.destination.kind, 'create');
    assert.equal(action.resolution.moves.length, 1);
  }
});

for (const scenario of ['unknown', 'missing', 'partial', 'delta', 'non-authority', 'ambiguous', 'outside-source', 'local-choice', 'contradictory-family', 'contradictory-membership', 'contradictory-context-membership']) {
  test(`personal families fail closed for ${scenario}`, () => {
    const input = fixture();
    if (scenario === 'unknown') input.externalPeople[0].householdIds = null;
    if (scenario === 'missing') delete input.externalPeople[0].householdIds;
    if (scenario === 'partial') input.snapshot.complete = false;
    if (scenario === 'delta') input.snapshot.mode = 'delta';
    if (scenario === 'non-authority') input.authoritative = false;
    if (scenario === 'ambiguous') input.matcher.ambiguous = [{ externalPersonId: 'betty', candidateIndividualIds: [1, 2] }];
    if (scenario === 'outside-source') input.eligibleByBatch.get(7).clear();
    if (scenario === 'local-choice') input.localHouseholdExternalIds = new Set(['betty']);
    if (scenario === 'contradictory-family') input.externalPeople[0].familyId = 'hh';
    if (scenario === 'contradictory-membership') input.externalFamilies = [{ id: 'hh', memberExternalIds: ['betty'] }];
    if (scenario === 'contradictory-context-membership') input.externalFamilies = [{ id: 'hh', memberExternalIds: [], householdMemberExternalIds: ['betty'] }];
    assert.ok(computePeopleSyncPlan(input).familyConflicts.every(action => action.resolution?.kind !== 'single_person'));
  });
}

test('new people have an explicit personal-family action keyed by identity, never by name', () => {
  const input = fixture({ localPeople: [], personLinks: [], matcher: { unmatchedExternalIds: ['betty', 'namesake'] } });
  input.externalPeople.push({ ...input.externalPeople[0], id: 'namesake' });
  input.eligibleByBatch.get(7).add('namesake');
  const plan = computePeopleSyncPlan(input);
  assert.deepEqual(plan.addFamilies.map(a => [a.singlePersonExternalId, a.externalFamilyId, a.familyName]), [
    ['betty', null, 'BULTMAN, Betty'], ['namesake', null, 'BULTMAN, Betty'],
  ]);
});

test('late create decisions carry signed personal-family data, but incomplete snapshots do not', () => {
  const input = fixture({ personLinks: [], matcher: { ambiguous: [{ externalPersonId: 'betty', candidateIndividualIds: [1] }] } });
  const plan = computePeopleSyncPlan(input);
  for (const completeSnapshot of [true, false]) {
    const context = buildReviewContext({ ...input, plan, completeSnapshot });
    assert.equal(context.identities.betty.createPerson.singlePersonFamilyName, completeSnapshot ? 'BULTMAN, Betty' : undefined);
  }
});

test('a real PCO household after marriage remains a normal reviewed household move', () => {
  const input = fixture();
  input.localPeople[0].familyId = 10;
  input.localPeople.push({ id: 2, firstName: 'Sam', lastName: 'Smith', familyId: 20 });
  input.localFamilies = [{ id: 10, familyName: 'BULTMAN, Betty' }, { id: 20, familyName: 'Smith household' }];
  input.externalPeople[0] = { ...input.externalPeople[0], familyId: 'married', householdIds: ['married'] };
  input.externalPeople.push({ id: 'sam', firstName: 'Sam', lastName: 'Smith', state: 'active', familyId: 'married', householdIds: ['married'] });
  input.externalFamilies = [{ id: 'married', name: 'Smith household', memberExternalIds: ['betty', 'sam'] }];
  input.personLinks.push({ externalPersonId: 'sam', individualId: 2 });
  input.familyLinks.push({ externalFamilyId: 'married', familyId: 20 });
  input.matcher.linked.push({ externalPersonId: 'sam', individualId: 2 });
  input.eligibleByBatch.get(7).add('sam');
  const action = computePeopleSyncPlan(input).familyConflicts[0];
  assert.equal(action.resolution.kind, 'household');
  assert.equal(action.resolution.destination.familyId, 20);
  assert.deepEqual(action.resolution.moves, [{ externalPersonId: 'betty', individualId: 1, fromFamilyId: 10 }]);
});

test('Elvanto retains its existing explicit no-household separation behavior', () => {
  const input = fixture({ provider: 'elvanto' });
  input.localPeople[0].familyId = 10;
  input.localFamilies = [{ id: 10, familyName: 'Old family' }];
  assert.equal(computePeopleSyncPlan(input).familyConflicts[0].resolution.kind, 'detach');
});

for (const [firstName, lastName, expected] of [[' Betty ', ' van Bultman ', 'VAN BULTMAN, Betty'], ['Betty', '', 'Betty'], ['', 'Bultman', 'BULTMAN'], ['', '', null]]) {
  test(`personal-family names handle ${JSON.stringify([firstName, lastName])}`, () => {
    const input = fixture();
    input.externalPeople[0] = { ...input.externalPeople[0], firstName, lastName };
    assert.equal(computePeopleSyncPlan(input).familyConflicts[0]?.resolution.destination.familyName ?? null, expected);
  });
}
