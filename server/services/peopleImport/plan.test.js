const { test } = require('node:test');
const assert = require('node:assert/strict');

const { BUCKETS } = require('../peopleSync/plan');
const { computePeopleImportPlan, assertAdditiveImportPlan } = require('./plan');

const FORBIDDEN = [
  'updateManagedFields', 'promoteToRegular', 'demoteToLocalVisitor', 'archive',
  'reactivate', 'moveFamily', 'renameFamily', 'addToGathering', 'removeFromGathering',
  'unmatchedLocalRegulars',
];

function person(overrides = {}) {
  return {
    id: 'ext-1', firstName: 'Ada', lastName: 'Lovelace', child: false,
    state: 'active', familyId: null, attributes: {}, ...overrides,
  };
}

function local(overrides = {}) {
  return {
    id: 1, firstName: 'Ada', lastName: 'Lovelace', isChild: false,
    peopleType: 'regular', isActive: true, familyId: null, ...overrides,
  };
}

function matcher(overrides = {}) {
  return {
    linked: [], matches: [], ambiguous: [], unmatchedExternalIds: [], unmatchedLocalIds: [],
    visitorMatches: [], archivedMatches: [], ...overrides,
  };
}

function fixture(overrides = {}) {
  return {
    provider: 'elvanto', authorityProvider: 'none', memberExternalIds: ['ext-1'],
    snapshot: { fetchedAt: '2026-08-04T01:02:03.000Z', watermark: 'wm-1', mode: 'full', complete: true },
    settings: { includeContacts: true, alignPeopleType: true },
    externalPeople: [person()], localPeople: [], externalFamilies: [], localFamilies: [],
    familyLinks: [], personLinks: [], missingCandidates: [], gatheringMemberships: [],
    matcher: matcher({ unmatchedExternalIds: ['ext-1'] }),
    ...overrides,
  };
}

function assertForbiddenBucketsEmpty(plan) {
  for (const bucket of FORBIDDEN) assert.deepEqual(plan[bucket], []);
}

function emptyImportPlan(overrides = {}) {
  return {
    provider: 'elvanto', authoritative: false, operationKind: 'people_import',
    ...Object.fromEntries(BUCKETS.map((bucket) => [bucket, []])),
    ...overrides,
  };
}

test('creates an unmatched active import member as a regular without an active authority', () => {
  const plan = computePeopleImportPlan(fixture());

  assert.equal(plan.operationKind, 'people_import');
  assert.equal(plan.authoritative, false);
  assert.deepEqual(plan.addPeople.map((action) => action.peopleType), ['regular']);
  assertForbiddenBucketsEmpty(plan);
});

test('authority forces every unmatched import addition to local visitor', () => {
  const plan = computePeopleImportPlan(fixture({ authorityProvider: 'planning_center' }));

  assert.deepEqual(plan.addPeople.map((action) => action.peopleType), ['local_visitor']);
  assert.deepEqual(plan.addPeople.map((action) => action.reason), ['authority_requires_visitor']);
  assertForbiddenBucketsEmpty(plan);
});

test('normalizes Contacts as visitor additions even without an active authority', () => {
  const plan = computePeopleImportPlan(fixture({
    externalPeople: [person({ state: 'Contact' })],
  }));

  assert.deepEqual(plan.addPeople.map((action) => action.peopleType), ['local_visitor']);
  assertForbiddenBucketsEmpty(plan);
});

test('preserves an existing automatic person match as a link for review', () => {
  const plan = computePeopleImportPlan(fixture({
    localPeople: [local()],
    matcher: matcher({ matches: [{ externalPersonId: 'ext-1', individualId: 1, reason: 'exact_name' }] }),
  }));

  assert.deepEqual(plan.linkPeople, [{
    id: 'linkPeople:ext-1:1', externalPersonId: 'ext-1', individualId: 1,
    reason: 'exact_name', reviewRequired: false,
  }]);
  assert.deepEqual(plan.addPeople, []);
  assertForbiddenBucketsEmpty(plan);
});

test('preserves ambiguous identity matches for import review without adding people', () => {
  const plan = computePeopleImportPlan(fixture({
    matcher: matcher({ ambiguous: [{ externalPersonId: 'ext-1', candidateIndividualIds: [2, 1], reason: 'same_name' }] }),
  }));

  assert.deepEqual(plan.ambiguousPeople, [{
    id: 'ambiguousPeople:ext-1:same_name', externalPersonId: 'ext-1',
    candidateIndividualIds: [1, 2], reason: 'same_name',
  }]);
  assert.deepEqual(plan.addPeople, []);
  assertForbiddenBucketsEmpty(plan);
});

test('preserves additive family creation and linking actions for review', () => {
  const ada = person({ id: 'ada', familyId: 'house-1' });
  const charles = person({ id: 'charles', firstName: 'Charles', familyId: 'house-1' });
  const created = computePeopleImportPlan(fixture({
    memberExternalIds: ['ada', 'charles'], externalPeople: [ada, charles], householdPeople: [ada, charles],
    externalFamilies: [{ id: 'house-1', memberExternalIds: ['ada', 'charles'] }],
    matcher: matcher({ unmatchedExternalIds: ['ada', 'charles'] }),
  }));
  const linked = computePeopleImportPlan(fixture({
    memberExternalIds: ['ada', 'charles'], externalPeople: [ada, charles], householdPeople: [ada, charles],
    externalFamilies: [{ id: 'house-1', memberExternalIds: ['ada', 'charles'] }],
    localPeople: [local({ id: 9, familyId: 3 })], localFamilies: [{ id: 3, familyName: 'Existing' }],
    matcher: matcher({
      linked: [{ externalPersonId: 'ada', individualId: 9, reason: 'existing_link' }],
      unmatchedExternalIds: ['charles'],
    }),
  }));

  assert.deepEqual(created.addFamilies.map((action) => action.externalFamilyId), ['house-1']);
  assert.deepEqual(linked.linkFamilies.map((action) => action.familyId), [3]);
  assertForbiddenBucketsEmpty(created);
  assertForbiddenBucketsEmpty(linked);
});

test('rejects mutation, source promotion, and authoritative import plans', () => {
  assert.doesNotThrow(() => assertAdditiveImportPlan(emptyImportPlan()));
  assert.throws(() => assertAdditiveImportPlan(emptyImportPlan({ archive: [{ id: 'archive:1' }] })), /archive/i);
  assert.throws(() => assertAdditiveImportPlan(emptyImportPlan({ updateManagedFields: [{ id: 'update:1' }] })), /updateManagedFields/i);
  assert.throws(() => assertAdditiveImportPlan(emptyImportPlan({ addToGathering: [{ id: 'gathering:1' }] })), /addToGathering/i);
  assert.throws(() => assertAdditiveImportPlan(emptyImportPlan({ sourcePromotion: { batchId: 1 } })), /sourcePromotion/i);
  assert.throws(() => assertAdditiveImportPlan(emptyImportPlan({ authoritative: true })), /authoritative/i);
});
