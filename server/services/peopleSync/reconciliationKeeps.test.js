'use strict';

// "Keep LMPG as it is" for household and attendance-list differences.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computePeopleSyncPlan } = require('./plan');
const { reconciliationKeepFor } = require('./reconciliation');
const { validateDestructiveSelections } = require('./identityDecisions');

function householdFixture(overrides = {}) {
  return {
    provider: 'planning_center', authoritative: true,
    snapshot: { mode: 'full', complete: true },
    externalPeople: [
      { id: 'bruce', firstName: 'Bruce', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] },
      { id: 'bronwyn', firstName: 'Bronwyn', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] },
    ],
    externalFamilies: [{ id: 'hh', name: 'Smith household', memberExternalIds: ['bruce', 'bronwyn'] }],
    localPeople: [
      { id: 1, firstName: 'Bruce', lastName: 'Smith', familyId: 10 },
      { id: 2, firstName: 'Bronwyn', lastName: 'Smith', familyId: 20 },
    ],
    localFamilies: [{ id: 10, familyName: 'First' }, { id: 20, familyName: 'Second' }],
    personLinks: [{ externalPersonId: 'bruce', individualId: 1 }, { externalPersonId: 'bronwyn', individualId: 2 }],
    familyLinks: [],
    matcher: { linked: [{ externalPersonId: 'bruce', individualId: 1 }, { externalPersonId: 'bronwyn', individualId: 2 }] },
    batches: [{ id: 7, enabled: true, gatheringTypeId: 100, source: { kind: 'planning_center_list', externalId: 'list-a', name: 'Members' } }],
    eligibleByBatch: new Map([[7, new Set(['bruce', 'bronwyn'])]]),
    gatheringMemberships: [], ...overrides,
  };
}

function detachFixture() {
  const input = householdFixture();
  input.externalPeople = [{ ...input.externalPeople[0], familyId: null, householdIds: [] }];
  input.externalFamilies = [];
  input.localPeople.push({ id: 3, firstName: 'Other', lastName: 'Local', familyId: 10 });
  return input;
}

function rosterFixture() {
  const input = householdFixture();
  input.externalPeople = [];
  input.externalFamilies = [];
  input.matcher = {};
  input.eligibleByBatch = new Map([[7, new Set()]]);
  input.memberIdsByBatch = new Map([[7, new Set()]]);
  input.gatheringMemberships = [{ gatheringTypeId: 100, individualId: 1, addedBySyncBatchId: null, gatheringName: 'Sunday' }];
  return input;
}

const keepFrom = (id, bucket, action) => ({ id, ...reconciliationKeepFor(bucket, action), keptAt: '2026-11-04 01:00:00' });

test('a kept household difference is left out of review and listed as kept', () => {
  const offered = computePeopleSyncPlan(householdFixture()).familyConflicts[0];
  const keep = keepFrom(5, 'familyConflicts', offered);
  assert.equal(keep.kind, 'household');
  assert.equal(keep.subjectKey, 'household:hh');

  const plan = computePeopleSyncPlan(householdFixture({ reconciliationKeeps: [keep] }));
  assert.deepEqual(plan.familyConflicts, []);
  assert.equal(plan.keptReconciliations.length, 1);
  assert.equal(plan.keptReconciliations[0].keepId, 5);
  assert.equal(plan.keptReconciliations[0].bucket, 'familyConflicts');
  assert.deepEqual(plan.keptReconciliations[0].action, offered);
});

test('a kept household comes back when either side changes', () => {
  const keep = keepFrom(5, 'familyConflicts', computePeopleSyncPlan(householdFixture()).familyConflicts[0]);

  // Planning Center adds someone to the household.
  const grown = householdFixture({ reconciliationKeeps: [keep] });
  grown.externalPeople.push({ id: 'ben', firstName: 'Ben', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] });
  grown.externalFamilies[0].memberExternalIds.push('ben');
  grown.localPeople.push({ id: 3, firstName: 'Ben', lastName: 'Smith', familyId: 30 });
  grown.localFamilies.push({ id: 30, familyName: 'Third' });
  grown.personLinks.push({ externalPersonId: 'ben', individualId: 3 });
  grown.matcher.linked.push({ externalPersonId: 'ben', individualId: 3 });
  grown.eligibleByBatch = new Map([[7, new Set(['bruce', 'bronwyn', 'ben'])]]);
  const afterSource = computePeopleSyncPlan(grown);
  assert.equal(afterSource.familyConflicts.length, 1);
  assert.equal(afterSource.keptReconciliations, undefined);

  // Someone moves Bronwyn into a different LMPG family.
  const moved = householdFixture({ reconciliationKeeps: [keep] });
  moved.localPeople[1] = { ...moved.localPeople[1], familyId: 30 };
  moved.localFamilies.push({ id: 30, familyName: 'Third' });
  assert.equal(computePeopleSyncPlan(moved).familyConflicts.length, 1);
});

test('the household name is not part of a keep', () => {
  const keep = keepFrom(5, 'familyConflicts', computePeopleSyncPlan(householdFixture()).familyConflicts[0]);
  const renamed = householdFixture({ reconciliationKeeps: [keep] });
  renamed.externalFamilies[0].name = 'The Smiths';
  assert.deepEqual(computePeopleSyncPlan(renamed).familyConflicts, []);
});

test('keeping a household move does not suppress a move to a different destination', () => {
  const input = householdFixture();
  input.localFamilies.push({ id: 30, familyName: 'First target' }, { id: 40, familyName: 'New target' });
  input.familyLinks = [{ externalFamilyId: 'hh', familyId: 30 }];
  const original = computePeopleSyncPlan(input).familyConflicts[0];
  input.reconciliationKeeps = [keepFrom(1, 'familyConflicts', original)];
  input.familyLinks[0].familyId = 40;
  const updated = computePeopleSyncPlan(input);
  assert.equal(updated.familyConflicts[0]?.resolution.destination.familyId, 40);
  assert.deepEqual(updated.familyConflicts[0].resolution.moves, original.resolution.moves);
});

test('a kept personal-family proposal stays hidden until the LMPG family changes', () => {
  const offered = computePeopleSyncPlan(detachFixture()).familyConflicts[0];
  const keep = keepFrom(6, 'familyConflicts', offered);
  assert.equal(keep.subjectKey, 'person:bruce');
  assert.deepEqual(computePeopleSyncPlan({ ...detachFixture(), reconciliationKeeps: [keep] }).familyConflicts, []);

  const moved = { ...detachFixture(), reconciliationKeeps: [keep] };
  moved.localPeople = moved.localPeople.map((person) => (person.id === 1 ? { ...person, familyId: 20 } : person));
  assert.equal(computePeopleSyncPlan(moved).familyConflicts.length, 1);
});

test('a kept attendance-list entry is not offered for removal again', () => {
  const offered = computePeopleSyncPlan(rosterFixture()).removeFromGathering[0];
  const keep = keepFrom(7, 'removeFromGathering', offered);
  assert.equal(keep.kind, 'gathering_removal');
  assert.equal(keep.subjectKey, '100:1');
  const plan = computePeopleSyncPlan({ ...rosterFixture(), reconciliationKeeps: [keep] });
  assert.deepEqual(plan.removeFromGathering, []);
  assert.equal(plan.keptReconciliations[0].bucket, 'removeFromGathering');

  // A new source batch feeding the gathering is a change on the source side.
  const widened = { ...rosterFixture(), reconciliationKeeps: [keep] };
  widened.batches = [...widened.batches, { id: 8, enabled: true, gatheringTypeId: 100, source: { kind: 'planning_center_list', externalId: 'youth', name: 'Youth' } }];
  widened.eligibleByBatch = new Map([[7, new Set()], [8, new Set()]]);
  widened.memberIdsByBatch = new Map([[7, new Set()], [8, new Set()]]);
  assert.equal(computePeopleSyncPlan(widened).removeFromGathering.length, 1);
});

test('replacing the source in the same batch reopens a kept removal, renaming it does not', () => {
  const input = rosterFixture();
  const original = computePeopleSyncPlan(input).removeFromGathering[0];
  input.reconciliationKeeps = [keepFrom(1, 'removeFromGathering', original)];
  input.batches[0].source.name = 'Renamed list';
  assert.deepEqual(computePeopleSyncPlan(input).removeFromGathering, []);
  input.batches[0].source.externalId = 'replacement-list';
  assert.equal(computePeopleSyncPlan(input).removeFromGathering[0]?.id, original.id);
});

test('keeps for other subjects or kinds change nothing', () => {
  const plan = computePeopleSyncPlan(householdFixture({ reconciliationKeeps: [
    { id: 1, kind: 'household', subjectKey: 'household:other', fingerprint: 'a'.repeat(64) },
    { id: 2, kind: 'gathering_removal', subjectKey: 'household:hh', fingerprint: 'b'.repeat(64) },
  ] }));
  assert.equal(plan.familyConflicts.length, 1);
  assert.equal(plan.keptReconciliations, undefined);
});

test('keepReconciliationIds accept only offered proposals and never alongside accepting the same one', () => {
  const plan = computePeopleSyncPlan(householdFixture());
  plan.removeFromGathering = computePeopleSyncPlan(rosterFixture()).removeFromGathering;
  const householdId = plan.familyConflicts[0].id;
  const removalId = plan.removeFromGathering[0].id;

  assert.equal(validateDestructiveSelections(plan, {}).keptReconciliationIds.size, 0);
  const kept = validateDestructiveSelections(plan, { keepReconciliationIds: [householdId, removalId] });
  assert.deepEqual([...kept.keptReconciliationIds], [householdId, removalId]);

  assert.throws(() => validateDestructiveSelections(plan, { keepReconciliationIds: ['forged'] }), /Cannot keep a reconciliation not offered/);
  assert.throws(() => validateDestructiveSelections(plan, { keepReconciliationIds: 'invalid' }), /array/i);
  assert.throws(() => validateDestructiveSelections(plan, {
    acceptFamilyResolutionIds: [householdId], keepReconciliationIds: [householdId],
  }), /both accepted and kept/);
});

test('nothing is keepable outside an authoritative review', () => {
  const plan = computePeopleSyncPlan(householdFixture());
  const householdId = plan.familyConflicts[0].id;
  assert.throws(() => validateDestructiveSelections({ ...plan, authoritative: false }, { keepReconciliationIds: [householdId] }), /not offered/);
  assert.throws(() => validateDestructiveSelections({ ...plan, operationKind: 'people_import' }, { keepReconciliationIds: [householdId] }), /not offered/);
});
