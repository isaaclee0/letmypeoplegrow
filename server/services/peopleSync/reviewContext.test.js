'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildReviewContext, buildReviewDirectory } = require('./reviewContext');

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

  assert.deepEqual(context, {
    version: 2,
    manualCandidateIndividualIds: [7, 8, 9],
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
    ],
    externalFamilies: [{ id: 'house-1', name: 'Smith Household', memberExternalIds: ['ext-4', 'ext-3', 'ext-2', 'ext-1'] }],
    localPeople: [
      { id: 7, firstName: 'Alex', lastName: 'Smith', familyId: 11, email: 'hidden@example.test' },
      { id: 8, firstName: 'Jamie', lastName: 'Smith', familyId: 11 },
      { id: 9, firstName: 'No', lastName: 'Family', familyId: null },
      { id: 10, firstName: 'Unknown', lastName: 'Family' },
      { id: 11, firstName: 'Missing', lastName: 'Family', familyId: 99 },
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
  assert.equal(JSON.stringify(directory).includes('hidden@example.test'), false);
  assert.equal(JSON.stringify(directory).includes('+6100'), false);
});
