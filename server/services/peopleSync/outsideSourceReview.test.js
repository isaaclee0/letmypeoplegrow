'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addOutsideSourceArchiveProposals } = require('./outsideSourceReview');

function fixture({ linked = false } = {}) {
  return {
    plan: { provider: 'planning_center', authoritative: true, archive: [], linkPeople: [], addPeople: [], ambiguousPeople: [], familyConflicts: [] },
    input: {
      directorySnapshot: { complete: true, people: [{ id: 'pco-ada', firstName: 'Ada', lastName: 'Reed', householdIds: ['house-1', 'house-2'], familyId: 'house-1', state: 'active' }],
        families: [{ id: 'house-1', name: 'Reed', memberExternalIds: ['pco-ada'] }, { id: 'house-2', name: 'Extended Reed', householdMemberExternalIds: ['pco-ada'] }] },
      individuals: [{ id: 11, firstName: 'Ada', lastName: 'Reed', peopleType: 'regular', isActive: true, familyId: 20, planningCenterId: null }],
      personLinks: linked ? [{ externalPersonId: 'pco-ada', individualId: 11 }] : [],
      matchReviewState: { holds: [], exclusions: [] }, memberExternalIds: new Set(['someone-else']), sourceNames: ['Sunday PM', 'Sunday AM', 'Sunday AM'],
    },
  };
}
const proposals = ({ plan, input }) => addOutsideSourceArchiveProposals(plan, input).archive;

test('unique exact name match offers a reviewed compound link and archive with source evidence', () => {
  const state = fixture();
  const original = structuredClone(state);
  const result = addOutsideSourceArchiveProposals(state.plan, state.input);
  assert.deepEqual(result.archive, [{
    id: 'archive:outside_all_sync_sources:pco-ada:11', externalPersonId: 'pco-ada', individualId: 11,
    reason: 'outside_all_sync_sources', linkRequired: true, externalFirstName: 'Ada', externalLastName: 'Reed',
    sourceNames: ['Sunday AM', 'Sunday PM'], pcoHouseholdNames: ['Extended Reed', 'Reed'],
  }]);
  assert.deepEqual(result.linkPeople, []);
  assert.equal(result.reviewContext, undefined);
  assert.deepEqual(state, original);
  assert.notEqual(result, state.plan);
});

test('durable linked regular offers archive without rematching even when the provider name changed', () => {
  const state = fixture({ linked: true });
  state.input.directorySnapshot.people[0].lastName = 'Married';
  state.input.individuals[0].planningCenterId = 'pco-ada';
  const result = proposals(state);
  assert.equal(result.length, 1);
  assert.equal(result[0].linkRequired, false);
  assert.equal(result[0].externalLastName, 'Married');
});

test('exact matching uses the existing matcher normalization for accents, punctuation and whitespace', () => {
  const state = fixture();
  state.input.individuals[0].firstName = '  ÁDA  ';
  state.input.individuals[0].lastName = "R'eed";
  assert.equal(proposals(state).length, 1);
  state.input.individuals[0].lastName = 'Reeds';
  assert.deepEqual(proposals(state), []);
});

for (const guard of ['incomplete', 'no-directory', 'not-pco', 'not-authoritative', 'import', 'no-sources', 'unknown-membership-union']) {
  test(`${guard} evidence cannot offer outside-source archives`, () => {
    const state = fixture();
    if (guard === 'incomplete') state.input.directorySnapshot.complete = false;
    if (guard === 'no-directory') delete state.input.directorySnapshot;
    if (guard === 'not-pco') state.plan.provider = 'elvanto';
    if (guard === 'not-authoritative') state.plan.authoritative = false;
    if (guard === 'import') state.plan.operationKind = 'people_import';
    if (guard === 'no-sources') state.input.sourceNames = [];
    if (guard === 'unknown-membership-union') delete state.input.memberExternalIds;
    assert.deepEqual(proposals(state), []);
  });
}

for (const linked of [false, true]) {
  for (const guard of ['in-any-source', 'absent-directory', 'visitor', 'inactive', 'unknown-active', 'held', 'excluded', 'inactive-provider', 'archived-provider', 'deceased-provider', 'unknown-provider-state']) {
    test(`${linked ? 'linked' : 'unlinked'} ${guard} person is not proposed`, () => {
      const state = fixture({ linked });
      if (guard === 'in-any-source') state.input.memberExternalIds.add('pco-ada');
      if (guard === 'absent-directory') state.input.directorySnapshot.people = [];
      if (guard === 'visitor') state.input.individuals[0].peopleType = 'local_visitor';
      if (guard === 'inactive') state.input.individuals[0].isActive = false;
      if (guard === 'unknown-active') delete state.input.individuals[0].isActive;
      if (guard === 'held') state.input.matchReviewState.holds.push({ externalPersonId: 'pco-ada', reason: 'deferred' });
      if (guard === 'excluded') state.input.matchReviewState.exclusions.push({ externalPersonId: 'pco-ada', individualId: 11 });
      if (['inactive-provider', 'archived-provider', 'deceased-provider'].includes(guard)) state.input.directorySnapshot.people[0].state = guard.replace('-provider', '');
      if (guard === 'unknown-provider-state') delete state.input.directorySnapshot.people[0].state;
      assert.deepEqual(proposals(state), []);
    });
  }
}

test('an explicit active status is accepted when the directory supplies no state field', () => {
  const state = fixture();
  delete state.input.directorySnapshot.people[0].state;
  state.input.directorySnapshot.people[0].status = 'active';
  assert.equal(proposals(state).length, 1);
  state.input.directorySnapshot.people[0].state = 'inactive';
  assert.deepEqual(proposals(state), [], 'an inactive state cannot be overridden by a separate status field');
});

test('a duplicate provider name is never disambiguated by family, child flag, or source membership', () => {
  const state = fixture();
  state.input.directorySnapshot.people.push({ id: 'other-ada', firstName: 'Ada', lastName: 'Reed', child: true, familyId: 'other' });
  state.input.memberExternalIds.add('other-ada');
  assert.deepEqual(proposals(state), []);
});

for (const duplicateState of ['regular', 'visitor', 'inactive', 'already-touched']) test(`duplicate local names remain ambiguous with a ${duplicateState} duplicate`, () => {
  const state = fixture();
  state.input.individuals.push({ ...state.input.individuals[0], id: 12,
    peopleType: duplicateState === 'visitor' ? 'local_visitor' : 'regular', isActive: duplicateState !== 'inactive' });
  if (duplicateState === 'already-touched') state.plan.archive.push({ id: 'other', individualId: 12, externalPersonId: 'other-ada' });
  assert.equal(proposals(state).some(({ reason }) => reason === 'outside_all_sync_sources'), false);
});

for (const guard of ['candidate-linked-elsewhere', 'local-linked-differently', 'compatibility-only', 'compatibility-owned-elsewhere', 'conflicting-compatibility', 'duplicate-durable-link']) {
  test(`${guard} identity cannot be inferred into an archive`, () => {
    const state = fixture();
    if (guard === 'candidate-linked-elsewhere') state.input.personLinks.push({ externalPersonId: 'pco-ada', individualId: 90 });
    if (guard === 'local-linked-differently') state.input.personLinks.push({ externalPersonId: 'other-person', individualId: 11 });
    if (guard === 'compatibility-only') state.input.individuals[0].planningCenterId = 'pco-ada';
    if (guard === 'compatibility-owned-elsewhere') state.input.individuals.push({ id: 90, firstName: 'Other', lastName: 'Person', planningCenterId: 'pco-ada' });
    if (guard === 'conflicting-compatibility') {
      state.input.personLinks.push({ externalPersonId: 'pco-ada', individualId: 11 });
      state.input.individuals[0].planningCenterId = 'other-person';
    }
    if (guard === 'duplicate-durable-link') state.input.personLinks.push({ externalPersonId: 'pco-ada', individualId: 11 }, { externalPersonId: 'pco-ada', individualId: 90 });
    assert.deepEqual(proposals(state), []);
  });
}

for (const collision of ['identity', 'link', 'add', 'move', 'family-resolution', 'family-member-at-destination', 'archive', 'ambiguous-local', 'ambiguous-external', 'local-household-decision', 'managed-update']) {
  test(`a person touched by ${collision} is not independently proposed for archive`, () => {
    const state = fixture();
    if (collision === 'identity') state.plan.reviewContext = { identities: { 'other-pco': { candidateIndividualIds: [11], suggestedIndividualId: 11 } } };
    if (collision === 'link') state.plan.linkPeople.push({ externalPersonId: 'other-pco', individualId: 11 });
    if (collision === 'add') state.plan.addPeople.push({ externalPersonId: 'pco-ada' });
    if (collision === 'move') state.plan.moveFamily = [{ individualId: 11, externalPersonId: 'pco-ada' }];
    if (collision === 'family-resolution') state.plan.familyConflicts.push({ resolution: { kind: 'household', moves: [{ individualId: 11 }] } });
    if (collision === 'family-member-at-destination') state.plan.familyConflicts.push({ memberExternalIds: ['pco-ada'], resolution: { kind: 'household', moves: [{ individualId: 90 }] } });
    if (collision === 'archive') state.plan.archive.push({ id: 'existing', externalPersonId: 'pco-ada', individualId: 11 });
    if (collision === 'ambiguous-local') state.plan.ambiguousPeople.push({ externalPersonId: 'another', candidateIndividualIds: [11] });
    if (collision === 'ambiguous-external') state.plan.ambiguousPeople.push({ externalPersonId: 'pco-ada', candidateIndividualIds: [90] });
    if (collision === 'local-household-decision') state.plan.householdChoices = { decisions: [{ people: [{ externalPersonId: 'pco-ada', individualId: 11 }] }] };
    if (collision === 'managed-update') state.plan.updateManagedFields = [{ individualId: 11, changes: [] }];
    assert.equal(proposals(state).filter(({ reason }) => reason === 'outside_all_sync_sources').length, 0);
  });
}

test('linked person may be archived alongside an existing gathering removal', () => {
  const state = fixture({ linked: true });
  state.plan.removeFromGathering = [{ individualId: 11, gatheringTypeId: 9 }];
  assert.equal(proposals(state).length, 1);
});

test('existing archive actions and repeated helper runs remain unchanged and duplicate-free', () => {
  const state = fixture();
  state.plan.archive = [{ id: 'already', externalPersonId: 'another', individualId: 91 }];
  const first = addOutsideSourceArchiveProposals(state.plan, state.input);
  const second = addOutsideSourceArchiveProposals(first, state.input);
  assert.deepEqual(second.archive, first.archive);
  assert.deepEqual(second.archive[0], state.plan.archive[0]);
  assert.equal(first.archive.length, 2);
});

test('empty name components and inconsistent duplicate directory identities fail closed', () => {
  for (const guard of ['empty-first', 'empty-last', 'duplicate-external-id']) {
    const state = fixture();
    if (guard === 'empty-first') state.input.individuals[0].firstName = state.input.directorySnapshot.people[0].firstName = '';
    if (guard === 'empty-last') state.input.individuals[0].lastName = state.input.directorySnapshot.people[0].lastName = '';
    if (guard === 'duplicate-external-id') state.input.directorySnapshot.people.push({ ...state.input.directorySnapshot.people[0], firstName: 'Different' });
    assert.deepEqual(proposals(state), []);
  }
});
