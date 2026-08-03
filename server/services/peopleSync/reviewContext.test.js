'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildReviewContext, buildReviewDirectory } = require('./reviewContext');

test('signs source-visible established links while eligibility uses the projected mapping', () => {
  const context = buildReviewContext({
    plan: { linkPeople: [], ambiguousPeople: [], addPeople: [] },
    externalPeople: [{ id: 'ext-a', firstName: 'External', lastName: 'Person', state: 'active' }],
    localPeople: [{ id: 10 }, { id: 20 }],
    basePersonLinks: [{ externalPersonId: 'ext-a', individualId: 10 }],
    projectedPersonLinks: [{ externalPersonId: 'ext-a', individualId: 20 }],
    sourceExternalIds: new Set(['ext-a']),
    linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
  });

  assert.deepEqual(context.establishedLinks, { 'ext-a': { individualId: 10 } });
  assert.deepEqual(context.projectedEstablishedLinks, { 'ext-a': { individualId: 20 } });
  assert.equal(context.manualCandidateIndividualIds.includes(10), true);
  assert.equal(context.manualCandidateIndividualIds.includes(20), false);
  assert.equal(context.correctionContractVersion, 1);
});

test('keeps the signed digest on base state and canonicalizes correction keys', () => {
  const shared = {
    plan: { linkPeople: [], ambiguousPeople: [], addPeople: [] },
    localPeople: [{ id: 10 }, { id: 20 }, { id: 30 }],
    basePersonLinks: [
      { externalPersonId: 'ext-a', individualId: 10 },
      { externalPersonId: 'outside-source', individualId: 30 },
    ],
    baseExclusions: [{ externalPersonId: 'ext-a', individualId: 20 }],
    baseHolds: [{ externalPersonId: 'ext-a', reason: 'deferred' }],
    sourceExternalIds: new Set(['ext-a', 'ext-z']),
  };
  const baseline = buildReviewContext({
    ...shared,
    projectedPersonLinks: shared.basePersonLinks,
    projectedExclusions: shared.baseExclusions,
    projectedHolds: shared.baseHolds,
  });
  const corrected = buildReviewContext({
    ...shared,
    projectedPersonLinks: [
      { externalPersonId: 'ext-a', individualId: 20 },
      shared.basePersonLinks[1],
    ],
    projectedExclusions: [
      ...shared.baseExclusions,
      { externalPersonId: 'ext-a', individualId: 10 },
    ],
    projectedHolds: [],
    linkCorrections: {
      'ext-z': { outcome: 'unlink', fromIndividualId: 30 },
      'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 },
    },
  });

  assert.equal(corrected.localIdentityDigest, baseline.localIdentityDigest);
  assert.deepEqual(corrected.linkCorrections, [
    { externalPersonId: 'ext-a', fromIndividualId: 10, outcome: 'relink', individualId: 20 },
    { externalPersonId: 'ext-z', fromIndividualId: 30, outcome: 'unlink' },
  ]);
  assert.deepEqual(corrected.establishedLinks, { 'ext-a': { individualId: 10 } });
  assert.equal(corrected.manualCandidateIndividualIds.includes(30), false,
    'an out-of-source durable link still reserves its local individual');
});

test('signs every reviewable identity with deterministic selections and fresh create data', () => {
  const context = buildReviewContext({
    plan: {
      linkPeople: [{ externalPersonId: 'ext-1', individualId: 7 }],
      ambiguousPeople: [{ externalPersonId: 'ext-1', candidateIndividualIds: [8, 7] }],
      addPeople: [{ externalPersonId: 'ext-2' }],
    },
    externalPeople: [
      { id: 'ext-2', firstName: 'Blair', lastName: 'Jones', child: true, familyId: null, state: 'contact' },
      { id: 'ext-1', firstName: 'Alex', lastName: 'Smith', child: false, familyId: 'house-1', state: 'active' },
    ],
    localPeople: [{ id: 9 }, { id: 7 }, { id: 8 }, { id: 10 }],
    personLinks: [{ externalPersonId: 'already-linked', individualId: 10 }],
    exclusions: [{ externalPersonId: 'ext-1', individualId: 9 }],
    holds: [{ externalPersonId: 'ext-1', reason: 'deferred' }],
    batches: [
      { id: 1, defaultPeopleType: 'local_visitor' },
      { id: 2, defaultPeopleType: 'regular' },
    ],
    eligibleByBatch: new Map([[1, new Set(['ext-1', 'ext-2'])], [2, new Set(['ext-1'])]]),
  });

  const { localIdentityDigest, ...reviewContract } = context;
  assert.match(localIdentityDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(reviewContract, {
    version: 2,
    correctionContractVersion: 1,
    manualCandidateIndividualIds: [7, 8, 9],
    establishedLinks: {},
    projectedEstablishedLinks: {},
    linkCorrections: [],
    identities: {
      'ext-1': {
        suggestedIndividualId: 7,
        candidateIndividualIds: [7, 8],
        excludedIndividualIds: [9],
        held: true,
        canCreate: true,
        createPerson: {
          firstName: 'Alex', lastName: 'Smith', isChild: false,
          externalFamilyId: 'house-1', peopleType: 'regular',
        },
      },
      'ext-2': {
        suggestedIndividualId: null,
        candidateIndividualIds: [],
        excludedIndividualIds: [],
        held: false,
        canCreate: true,
        createPerson: {
          firstName: 'Blair', lastName: 'Jones', isChild: true,
          externalFamilyId: null, peopleType: 'local_visitor',
        },
      },
    },
  });
});

test('builds a lean family directory with explicit household availability and match eligibility', () => {
  const directory = buildReviewDirectory({
    externalPeople: [
      { id: 'ext-1', firstName: 'Alex', lastName: 'Smith', familyId: 'house-1', email: 'hidden@example.test' },
      { id: 'ext-2', firstName: 'Jamie', lastName: 'Smith', familyId: 'house-1', phone: '+6100' },
      { id: 'ext-3', firstName: 'Casey', lastName: 'Smith', familyId: 'house-1' },
      { id: 'ext-4', firstName: 'Drew', lastName: 'Smith', familyId: 'house-1' },
      { id: 'ext-5', firstName: 'No', lastName: 'Household', familyId: null },
      { id: 'ext-6', firstName: 'Unknown', lastName: 'Household' },
      { id: 'ext-7', firstName: 'Missing', lastName: 'Household', familyId: 'missing-household' },
      { id: 'ext-8', firstName: 'Also Missing', lastName: 'Household', familyId: 'missing-household' },
    ],
    externalFamilies: [{ id: 'house-1', name: 'Smith Household', memberExternalIds: ['ext-4', 'ext-3', 'ext-2', 'ext-1'] }],
    localPeople: [
      { id: 7, firstName: 'Alex', lastName: 'Smith', familyId: 11, email: 'hidden@example.test' },
      { id: 8, firstName: 'Jamie', lastName: 'Smith', familyId: 11 },
      { id: 9, firstName: 'No', lastName: 'Family', familyId: null },
      { id: 10, firstName: 'Unknown', lastName: 'Family' },
      { id: 11, firstName: 'Missing', lastName: 'Family', familyId: 99 },
      { id: 12, firstName: 'Also Missing', lastName: 'Family', familyId: 99 },
    ],
    localFamilies: [{ id: 11, familyName: 'Local Smiths' }],
    reviewContext: { manualCandidateIndividualIds: [7, 9] },
  });

  assert.deepEqual(directory.external['ext-1'], {
    firstName: 'Alex', lastName: 'Smith',
    family: {
      state: 'known', name: 'Smith Household',
      members: [
        { firstName: 'Casey', lastName: 'Smith' },
        { firstName: 'Drew', lastName: 'Smith' },
        { firstName: 'Jamie', lastName: 'Smith' },
      ],
      totalOtherMembers: 3,
    },
  });
  assert.deepEqual(directory.external['ext-5'].family, { state: 'none' });
  assert.deepEqual(directory.external['ext-6'].family, { state: 'unavailable' });
  assert.deepEqual(directory.external['ext-7'].family, { state: 'unavailable' });
  assert.deepEqual(directory.external['ext-8'].family, { state: 'unavailable' });
  assert.deepEqual(directory.local['7'], {
    firstName: 'Alex', lastName: 'Smith', matchEligible: true,
    family: {
      state: 'known', name: 'Local Smiths',
      members: [{ firstName: 'Jamie', lastName: 'Smith' }], totalOtherMembers: 1,
    },
  });
  assert.equal(directory.local['8'].matchEligible, false);
  assert.deepEqual(directory.local['9'].family, { state: 'none' });
  assert.deepEqual(directory.local['10'].family, { state: 'unavailable' });
  assert.deepEqual(directory.local['11'].family, { state: 'unavailable' });
  assert.deepEqual(directory.local['12'].family, { state: 'unavailable' });
  assert.equal(JSON.stringify(directory).includes('hidden@example.test'), false);
  assert.equal(JSON.stringify(directory).includes('+6100'), false);
});

test('binds local names, family context, and provider-link eligibility without exposing the local records', () => {
  const base = {
    plan: {
      linkPeople: [{ externalPersonId: 'ext-1', individualId: 7 }],
      ambiguousPeople: [],
      addPeople: [],
    },
    externalPeople: [{ id: 'ext-1', firstName: 'Alex', lastName: 'Smith', child: false, familyId: null }],
    localPeople: [
      { id: 7, firstName: 'Private Alex', lastName: 'Smith', familyId: 11, peopleType: 'regular', isChild: false, isActive: true },
      { id: 8, firstName: 'Private Jamie', lastName: 'Smith', familyId: 11, peopleType: 'regular', isChild: false, isActive: true },
    ],
    localFamilies: [
      { id: 11, familyName: 'Smith Household' },
      { id: 12, familyName: 'Empty Household' },
    ],
    personLinks: [],
  };

  const original = buildReviewContext(base);
  const renamed = buildReviewContext({
    ...base,
    localPeople: base.localPeople.map((person) => person.id === 7 ? { ...person, firstName: 'Private Alec' } : person),
  });
  const movedFamily = buildReviewContext({
    ...base,
    localPeople: base.localPeople.map((person) => person.id === 7 ? { ...person, familyId: null } : person),
  });
  const equivalentFamilyInput = {
    ...base,
    localPeople: [base.localPeople[0]],
    localFamilies: [
      { id: 11, familyName: 'Smith Household' },
      { id: 12, familyName: 'Smith Household' },
    ],
  };
  const equivalentFamilyBaseline = buildReviewContext(equivalentFamilyInput);
  const movedBetweenEquivalentFamilies = buildReviewContext({
    ...equivalentFamilyInput,
    localPeople: [{ ...equivalentFamilyInput.localPeople[0], familyId: 12 }],
  });
  const newlyLinked = buildReviewContext({
    ...base,
    personLinks: [{ externalPersonId: 'other-ext', individualId: 8 }],
  });
  const linkedMissingCountChanged = buildReviewContext({
    ...base,
    personLinks: [{ externalPersonId: 'other-ext', individualId: 8, missingFullSyncCount: 1 }],
  });
  const renamedEmptyFamily = buildReviewContext({
    ...base,
    localFamilies: base.localFamilies.map((family) => family.id === 12
      ? { ...family, familyName: 'Renamed Empty Household' }
      : family),
  });
  const contactOnlyChange = buildReviewContext({
    ...base,
    localPeople: base.localPeople.map((person) => ({ ...person, email: 'private@example.test' })),
  });
  const exclusionAdded = buildReviewContext({
    ...base,
    exclusions: [{ externalPersonId: 'ext-1', individualId: 7 }],
  });
  const holdAdded = buildReviewContext({
    ...base,
    holds: [{ externalPersonId: 'ext-1', reason: 'deferred' }],
  });

  assert.match(original.localIdentityDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(renamed.localIdentityDigest, original.localIdentityDigest);
  assert.notEqual(movedFamily.localIdentityDigest, original.localIdentityDigest);
  assert.notEqual(
    movedBetweenEquivalentFamilies.localIdentityDigest,
    equivalentFamilyBaseline.localIdentityDigest,
    'the exact local family ID must be signed even when both rendered family summaries are identical'
  );
  assert.notEqual(newlyLinked.localIdentityDigest, original.localIdentityDigest);
  assert.equal(linkedMissingCountChanged.localIdentityDigest, newlyLinked.localIdentityDigest,
    'legacy absence counters must not participate in the signed local identity');
  assert.notEqual(renamedEmptyFamily.localIdentityDigest, original.localIdentityDigest);
  assert.equal(contactOnlyChange.localIdentityDigest, original.localIdentityDigest);
  assert.notEqual(exclusionAdded.localIdentityDigest, original.localIdentityDigest);
  assert.notEqual(holdAdded.localIdentityDigest, original.localIdentityDigest);
  assert.equal(JSON.stringify(original).includes('Smith Household'), false);
  assert.equal(JSON.stringify(original).includes('Private Alex'), false);
});
