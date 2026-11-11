'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalHouseholdChoices, canonicalPreferences, projectHouseholdChoices, decorateHouseholdChoicePlan } = require('./householdChoices');

function fixture({ names = ['Reed', 'Reed extended'], solo = false } = {}) {
  const people = [
    { id: 'ada', firstName: 'Ada', lastName: 'Reed', familyId: 'small', householdIds: ['small', 'large'] },
    ...(!solo ? [{ id: 'ben', firstName: 'Ben', lastName: 'Reed', familyId: 'large', householdIds: ['large', 'small'] }] : []),
    { id: 'child', firstName: 'Chris', lastName: 'Reed', familyId: 'small', householdIds: ['small'] },
  ];
  const contextPeople = [{ id: 'relative', firstName: 'Rae', lastName: 'Hill', familyId: 'large', householdIds: ['large'] }];
  return {
    provider: 'planning_center',
    snapshot: { people, families: [
      { id: 'small', name: names[0], memberExternalIds: people.map(({ id }) => id), householdMemberExternalIds: people.map(({ id }) => id) },
      { id: 'large', name: names[1], memberExternalIds: [...people.filter(({ id }) => id !== 'child').map(({ id }) => id), 'relative'], householdMemberExternalIds: [...people.filter(({ id }) => id !== 'child').map(({ id }) => id), 'relative'] },
    ] },
    contextPeople, matchingPeople: [...people, ...contextPeople], ineligibleMemberPeople: [],
    individuals: people.map((person, index) => ({ id: index + 1, firstName: person.firstName, lastName: person.lastName, familyId: 10 + index })),
    families: [{ id: 10, familyName: 'Current Ada' }, { id: 11, familyName: 'Current Ben' }, { id: 12, familyName: 'Current Chris' }, { id: 40, familyName: 'Local extended', planningCenterId: 'unrelated-household' }],
    personLinks: people.map((person, index) => ({ externalPersonId: person.id, individualId: index + 1 })),
    familyLinks: [{ externalFamilyId: 'unrelated-household', familyId: 40 }],
    eligibleByBatch: new Map([[7, new Set(people.map(({ id }) => id))]]), householdPreferences: [],
  };
}
const groupFor = (input) => projectHouseholdChoices(input).householdChoiceContext.groups[0];
function baselineFingerprint(externalPersonId) {
  const input = fixture();
  const group = groupFor(input);
  const projected = projectHouseholdChoices(input, { [group.id]: { destination: { kind: 'keep' } } });
  return projected.householdChoiceContext.decisions[0].people.find((person) => person.externalPersonId === externalPersonId).sourceFingerprint;
}
const preference = (externalPersonId, individualId, familyId, groupId = 'remembered-card', sourceFingerprint = baselineFingerprint(externalPersonId)) => ({ externalPersonId, individualId, familyId, groupId, sourceFingerprint });
const edit = (kind, extra = {}) => ({ destination: { kind, ...extra } });

for (const shape of [
  { label: 'larger and smaller households' },
  { label: 'differently named households', names: ['Reed', 'Hill'] },
  { label: 'identically named households', names: ['Reed', 'Reed'] },
  { label: 'one source member and extended relatives', solo: true },
]) test(`LMPG choices group linked source people for ${shape.label}`, () => {
  const input = fixture(shape);
  const original = structuredClone(input);
  const projected = projectHouseholdChoices(input);
  const group = projected.householdChoiceContext.groups[0];
  assert.equal(projected.householdChoiceContext.version, 2);
  assert.equal(group.people.length, shape.solo ? 1 : 2);
  assert.deepEqual(group.selectedDestination, { kind: 'keep' });
  assert.equal(group.people[0].currentFamilyId, 10);
  assert.equal(group.people[0].currentFamilyName, 'Current Ada');
  assert.equal(group.sourceHouseholds.length, 2);
  assert.equal(group.sourceHouseholds[0].members.find(({ externalPersonId }) => externalPersonId === 'relative').inSource, false);
  assert.deepEqual(projected.householdChoiceContext.decisions, []);
  assert.deepEqual([...projected.localHouseholdExternalIds].sort(), shape.solo ? ['ada'] : ['ada', 'ben']);
  assert.equal(projected.snapshot, input.snapshot);
  assert.equal(projected.matchingPeople, input.matchingPeople);
  assert.deepEqual(input, original);
});

test('group IDs follow participant identities rather than provider household identities', () => {
  const input = fixture();
  const first = groupFor(input).id;
  for (const person of input.snapshot.people.filter(({ id }) => id !== 'child')) person.householdIds = ['new-a', 'new-b'];
  assert.equal(groupFor(input).id, first);
  input.snapshot.people.reverse();
  assert.equal(groupFor(input).id, first);
});

test('keep records each source participant current local family without moving or renaming', () => {
  const input = fixture();
  const group = groupFor(input);
  const projected = projectHouseholdChoices(input, { [group.id]: edit('keep') });
  assert.deepEqual(projected.householdChoiceContext.decisions, [{
    groupId: group.id, destination: { kind: 'keep' }, resolvedName: null, fromName: null,
    people: [{ externalPersonId: 'ada', individualId: 1, fromFamilyId: 10, sourceFingerprint: baselineFingerprint('ada') }, { externalPersonId: 'ben', individualId: 2, fromFamilyId: 11, sourceFingerprint: baselineFingerprint('ben') }],
  }]);
  assert.deepEqual(projected.snapshot, input.snapshot);
});

test('existing destinations use any church family without claiming its provider ownership', () => {
  const input = fixture();
  const id = groupFor(input).id;
  const projected = projectHouseholdChoices(input, { [id]: edit('existing', { familyId: 40 }) });
  const decision = projected.householdChoiceContext.decisions[0];
  assert.deepEqual(decision.destination, { kind: 'existing', familyId: 40 });
  assert.equal(decision.resolvedName, null);
  assert.equal(decision.fromName, 'Local extended');
  const renamed = projectHouseholdChoices(input, { [id]: { ...edit('existing', { familyId: 40 }), displayName: ' New name ' } });
  assert.equal(renamed.householdChoiceContext.decisions[0].resolvedName, 'New name');
  assert.equal(input.families.find(({ id }) => id === 40).familyName, 'Local extended');
  assert.deepEqual(projected.householdChoiceContext.localFamilies.find(({ id }) => id === 10), { id: 10, familyName: 'Current Ada', memberNames: ['Ada Reed'] });
});

test('create requires and previews a local name without a provider household target', () => {
  const input = fixture();
  const id = groupFor(input).id;
  const projected = projectHouseholdChoices(input, { [id]: { ...edit('create'), displayName: ' Shared family ' } });
  assert.deepEqual(projected.householdChoiceContext.decisions[0].destination, { kind: 'create' });
  assert.equal(projected.householdChoiceContext.decisions[0].resolvedName, 'Shared family');
  assert.equal(projected.householdChoiceContext.decisions[0].fromName, null);
  assert.ok(groupFor(input).suggestedName);
  for (const displayName of [undefined, '', '   ']) assert.throws(() => projectHouseholdChoices(input, { [id]: { ...edit('create'), ...(displayName === undefined ? {} : { displayName }) } }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
});

test('new local household names prefer an agreed PCO name and never inherit an Unknown placeholder', () => {
  const input = fixture({ names: ['Reed Household', 'Reed Household'], solo: true });
  input.families[0].familyName = 'Unknown Household';
  assert.equal(groupFor(input).suggestedName, 'Reed Household');
  // A suggestion does not rename the existing household or pick a provider household.
  assert.equal(groupFor(input).displayName, 'Unknown Household');
  assert.deepEqual(projectHouseholdChoices(input).householdChoiceContext.decisions, []);
  input.snapshot.families[1].name = 'Hill Household';
  assert.doesNotMatch(groupFor(input).suggestedName, /unknown|hill/i);
  assert.match(groupFor(input).suggestedName, /Reed/);
  input.families[0].familyName = 'Our local name';
  assert.equal(groupFor(input).suggestedName, 'Our local name');
});

test('keep can rename only one shared nonnull family and retains its original name', () => {
  const input = fixture();
  let id = groupFor(input).id;
  assert.throws(() => projectHouseholdChoices(input, { [id]: { ...edit('keep'), displayName: 'Rename' } }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
  input.individuals[1].familyId = 10;
  id = groupFor(input).id;
  const projected = projectHouseholdChoices(input, { [id]: { ...edit('keep'), displayName: 'Renamed current' } });
  assert.equal(projected.householdChoiceContext.decisions[0].resolvedName, 'Renamed current');
  assert.equal(projected.householdChoiceContext.decisions[0].fromName, 'Current Ada');
  assert.equal(projectHouseholdChoices(input, { [id]: edit('keep') }).householdChoiceContext.decisions[0].fromName, 'Current Ada');
  input.individuals[0].familyId = input.individuals[1].familyId = null;
  assert.throws(() => projectHouseholdChoices(input, { [id]: { ...edit('keep'), displayName: 'Rename' } }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
});

test('changed PCO memberships reopen saved arrangements and release provider household proposals', () => {
  for (const change of ['removed-membership', 'new-member']) {
    const input = fixture();
    input.householdPreferences = [preference('ada', 1, 10), preference('ben', 2, 11)];
    if (change === 'removed-membership') {
      input.snapshot.people[0].householdIds = ['small'];
      input.snapshot.people[0].familyId = 'small';
    } else input.snapshot.families[0].householdMemberExternalIds.push('new-spouse');
    const projected = projectHouseholdChoices(input);
    const group = projected.householdChoiceContext.groups[0];
    assert.equal(group.id, 'remembered-card');
    assert.equal(group.saved, true);
    assert.equal(group.sourceChanged, true);
    assert.match(group.invalidReason, /Planning Center household membership changed/);
    assert.equal(projected.localHouseholdExternalIds.has('ada'), false);
    const acknowledged = projectHouseholdChoices(input, { [group.id]: edit('keep') });
    assert.notEqual(acknowledged.householdChoiceContext.decisions[0].people[0].sourceFingerprint, input.householdPreferences[0].sourceFingerprint);
    assert.equal(group.people[0].sourceFingerprint, acknowledged.householdChoiceContext.decisions[0].people[0].sourceFingerprint);
    assert.match(group.people[0].sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(acknowledged.localHouseholdExternalIds.has('ada'), 'explicit acknowledgement suppresses the alternative provider move in the same preview');
  }
});

test('unknown or incomplete household evidence keeps saved arrangements protected and blocks new moves', () => {
  for (const change of ['unknown', 'missing-household', 'contradictory-household', 'incomplete-snapshot']) {
    const input = fixture();
    input.householdPreferences = [preference('ada', 1, 10), preference('ben', 2, 11)];
    if (change === 'unknown') input.snapshot.people[0].householdIds = null;
    if (change === 'missing-household') input.snapshot.families = [];
    if (change === 'contradictory-household') input.snapshot.families[0].householdMemberExternalIds = [];
    if (change === 'incomplete-snapshot') input.snapshot.complete = false;
    const projected = projectHouseholdChoices(input);
    const group = projected.householdChoiceContext.groups[0];
    assert.equal(group.sourceChanged, false);
    assert.ok(group.invalidReason);
    assert.ok(projected.localHouseholdExternalIds.has('ada'));
    assert.throws(() => projectHouseholdChoices(input, { [group.id]: edit('existing', { familyId: 40 }) }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
    assert.equal(projectHouseholdChoices(input, { [group.id]: edit('forget') }).householdChoiceContext.decisions[0].destination.kind, 'forget');
  }
});

test('household names and member ordering do not invalidate remembered arrangements', () => {
  const input = fixture();
  input.householdPreferences = [preference('ada', 1, 10), preference('ben', 2, 11)];
  input.snapshot.people[0].householdIds.reverse();
  for (const family of input.snapshot.families) {
    family.name = 'Renamed source';
    family.householdMemberExternalIds.reverse();
  }
  const projected = projectHouseholdChoices(input);
  assert.equal(projected.householdChoiceContext.groups[0].invalidReason, null);
  assert.equal(projected.householdChoiceContext.groups[0].sourceChanged, false);
  assert.ok(projected.localHouseholdExternalIds.has('ada'));
});

test('a source change cannot bypass a hard identity or local-family conflict', () => {
  const input = fixture();
  input.householdPreferences = [preference('ada', 1, 10), preference('ben', 2, 11)];
  input.snapshot.families[0].householdMemberExternalIds.push('new-spouse');
  input.individuals[0].familyId = 40;
  const projected = projectHouseholdChoices(input);
  const group = projected.householdChoiceContext.groups[0];
  assert.equal(group.sourceChanged, false);
  assert.match(group.invalidReason, /remembered LMPG family/);
  assert.ok(projected.localHouseholdExternalIds.has('ada'));
  assert.throws(() => projectHouseholdChoices(input, { [group.id]: edit('keep') }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
});

test('preferences without an old source fingerprint require review of available current evidence', () => {
  const input = fixture();
  input.householdPreferences = [preference('ada', 1, 10, 'old-arrangement', null)];
  const projected = projectHouseholdChoices(input);
  const group = projected.householdChoiceContext.groups.find(({ id }) => id === 'old-arrangement');
  assert.equal(group.sourceChanged, true);
  assert.equal(projected.localHouseholdExternalIds.has('ada'), false);
  assert.ok(projectHouseholdChoices(input, { [group.id]: edit('keep') }).householdChoiceContext.decisions[0].people[0].sourceFingerprint);
});

test('saved common arrangement defaults to its actual local family, while null family is valid', () => {
  const input = fixture();
  input.individuals[1].familyId = 10;
  input.householdPreferences = [preference('ada', 1, 10), preference('ben', 2, 10)];
  assert.deepEqual(groupFor(input).selectedDestination, { kind: 'existing', familyId: 10 });
  assert.equal(groupFor(input).displayName, 'Current Ada');
  input.individuals[0].familyId = input.individuals[1].familyId = null;
  input.householdPreferences = [preference('ada', 1, null), preference('ben', 2, null)];
  assert.equal(groupFor(input).invalidReason, null);
  assert.deepEqual(groupFor(input).selectedDestination, { kind: 'keep' });
});

for (const problem of ['changed_link', 'missing_link', 'moved_local', 'deleted_family', 'deleted_person']) test(`invalid ${problem} arrangement is protected and only forgettable`, () => {
  const input = fixture();
  input.householdPreferences = [preference('ada', 1, 10), preference('ben', 2, 11)];
  if (problem === 'changed_link') input.personLinks[0].individualId = 2;
  if (problem === 'missing_link') input.personLinks = input.personLinks.slice(1);
  if (problem === 'moved_local') input.individuals[0].familyId = 40;
  if (problem === 'deleted_family') input.families = input.families.filter(({ id }) => id !== 10);
  if (problem === 'deleted_person') input.individuals = input.individuals.slice(1);
  const projected = projectHouseholdChoices(input);
  const group = projected.householdChoiceContext.groups[0];
  assert.ok(group.invalidReason);
  assert.ok(projected.localHouseholdExternalIds.has('ada'));
  assert.throws(() => projectHouseholdChoices(input, { [group.id]: edit('keep') }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
  assert.throws(() => projectHouseholdChoices(input, { [group.id]: edit('existing', { familyId: 40 }) }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
  const forgotten = projectHouseholdChoices(input, { [group.id]: edit('forget') });
  assert.equal(forgotten.householdChoiceContext.decisions[0].destination.kind, 'forget');
  assert.equal(forgotten.householdChoiceContext.decisions[0].people[0].individualId, 1);
});

test('saved people outside the source stay protected without entering an editable card or a decision', () => {
  const input = fixture();
  input.householdPreferences = [preference('ada', 1, 10), preference('ben', 2, 11)];
  input.eligibleByBatch = new Map([[7, new Set(['ada', 'child'])]]);
  const projected = projectHouseholdChoices(input);
  const group = projected.householdChoiceContext.groups[0];
  assert.deepEqual(group.people.map(({ externalPersonId }) => externalPersonId), ['ada']);
  assert.ok(projected.localHouseholdExternalIds.has('ben'));
  assert.equal(projected.householdChoiceContext.basePreferences.length, 2);
  assert.equal(projectHouseholdChoices(input, { [group.id]: edit('existing', { familyId: 40 }) }).householdChoiceContext.decisions[0].people.length, 1);
  input.eligibleByBatch = new Map([[7, new Set(['child'])]]);
  assert.deepEqual(projectHouseholdChoices(input).householdChoiceContext.groups, []);
});

test('linked multi-household context people remain protected but never become imported participants', () => {
  const input = fixture();
  input.contextPeople[0].householdIds = ['small', 'large'];
  input.individuals.push({ id: 90, firstName: 'Rae', lastName: 'Hill', familyId: 40 });
  input.personLinks.push({ externalPersonId: 'relative', individualId: 90 });
  input.personLinks = input.personLinks.filter(({ externalPersonId }) => externalPersonId !== 'ben');
  const projected = projectHouseholdChoices(input);
  assert.deepEqual(projected.householdChoiceContext.groups[0].people.map(({ externalPersonId }) => externalPersonId), ['ada']);
  assert.ok(projected.localHouseholdExternalIds.has('relative'));
  assert.ok(!projected.localHouseholdExternalIds.has('ben'));
  assert.equal(projected.snapshot.people.some(({ id }) => id === 'relative'), false);
});

test('canonical edits reject legacy IDs, unknown groups, invalid local families, unsafe names and malformed destinations', () => {
  const input = fixture();
  const id = groupFor(input).id;
  for (const choice of [
    { householdId: 'small' }, { destination: { kind: 'existing', familyId: '40' } },
    { destination: { kind: 'existing', familyId: -1 } }, { destination: { kind: 'keep', familyId: 10 } },
    { destination: { kind: 'provider', householdId: 'small' } }, { ...edit('keep'), surprise: true },
    { ...edit('keep'), displayName: 'a'.repeat(201) }, { ...edit('keep'), displayName: 'bad\u0000name' },
    { ...edit('forget'), displayName: 'Rename' },
  ]) assert.throws(() => projectHouseholdChoices(input, { [id]: choice }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
  assert.throws(() => projectHouseholdChoices(input, { unknown: edit('keep') }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
  assert.throws(() => projectHouseholdChoices(input, { [id]: edit('existing', { familyId: 999 }) }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
  assert.throws(() => canonicalHouseholdChoices([]), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
  assert.deepEqual(canonicalHouseholdChoices({ z: edit('forget'), a: { ...edit('existing', { familyId: 40 }), displayName: ' Name ' } }), { a: { destination: { kind: 'existing', familyId: 40 }, displayName: 'Name' }, z: { destination: { kind: 'forget' } } });
});

test('different cards cannot explicitly rename the same existing family inconsistently, including keep', () => {
  const input = fixture();
  input.householdPreferences = [preference('ada', 1, 10, 'card-a'), preference('ben', 2, 11, 'card-b')];
  for (const first of [edit('existing', { familyId: 10 }), edit('keep')]) {
    assert.throws(() => projectHouseholdChoices(input, {
      'card-a': { ...first, displayName: 'One name' }, 'card-b': { ...edit('existing', { familyId: 10 }), displayName: 'Other name' },
    }), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID' });
  }
  const same = projectHouseholdChoices(input, { 'card-a': { ...edit('keep'), displayName: 'Same name' }, 'card-b': { ...edit('existing', { familyId: 10 }), displayName: 'Same name' } });
  assert.equal(same.householdChoiceContext.decisions.length, 2);
});

test('decoration attaches v2 review context without changing provider actions or evidence', () => {
  const input = fixture();
  const projected = projectHouseholdChoices(input, { [groupFor(input).id]: { ...edit('create'), displayName: 'LMPG only' } });
  const plan = { addFamilies: [{ externalFamilyId: 'small', familyName: 'PCO name' }], familyConflicts: [{ externalFamilyId: 'large', reason: 'unknown_household_membership' }] };
  const original = structuredClone(plan);
  const decorated = decorateHouseholdChoicePlan(plan, projected);
  assert.equal(decorated.householdChoices.version, 2);
  assert.deepEqual(decorated.addFamilies, original.addFamilies);
  assert.deepEqual(decorated.familyConflicts, original.familyConflicts);
  assert.deepEqual(plan, original);
  assert.deepEqual(canonicalPreferences([preference('ben', 2, 11), preference('ada', 1, 10)]), [preference('ada', 1, 10), preference('ben', 2, 11)]);
});
