'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateIdentityDecisions,
  validateSignedLinkCorrections,
} = require('./identityDecisions');
const { BUCKETS } = require('./plan');

function emptyPlan(overrides = {}) {
  const plan = { provider: 'elvanto', authoritative: true };
  for (const bucket of BUCKETS) plan[bucket] = [];
  return { ...plan, ...overrides };
}

function identity(overrides = {}) {
  return {
    suggestedIndividualId: null,
    candidateIndividualIds: [],
    excludedIndividualIds: [],
    held: false,
    canCreate: true,
    createPerson: {
      firstName: 'Alex',
      lastName: 'Smith',
      isChild: false,
      externalFamilyId: null,
      peopleType: 'regular',
    },
    ...overrides,
  };
}

function reviewPlan(identities, overrides = {}) {
  return emptyPlan({
    reviewContext: {
      version: 2,
      correctionContractVersion: 1,
      manualCandidateIndividualIds: [10, 11, 12, 13, 14],
      projectedEstablishedLinks: {},
      linkCorrections: [],
      identities,
    },
    ...overrides,
  });
}

test('signed link corrections accept only the same canonical correction mapping', () => {
  const signed = [
    { externalPersonId: 'ext-b', fromIndividualId: 11, outcome: 'unlink' },
    { externalPersonId: 'ext-a', fromIndividualId: 10, outcome: 'relink', individualId: 12 },
  ];
  assert.deepEqual(validateSignedLinkCorrections(1, signed, {
    'ext-a': { outcome: 'relink', individualId: 12, fromIndividualId: 10 },
    'ext-b': { outcome: 'unlink', fromIndividualId: 11 },
  }), [
    { externalPersonId: 'ext-a', fromIndividualId: 10, outcome: 'relink', individualId: 12 },
    { externalPersonId: 'ext-b', fromIndividualId: 11, outcome: 'unlink' },
  ]);

  assert.throws(
    () => validateSignedLinkCorrections(1, signed, {
      'ext-a': { outcome: 'relink', individualId: 13, fromIndividualId: 10 },
      'ext-b': { outcome: 'unlink', fromIndividualId: 11 },
    }),
    /do not match the signed review preview/i
  );
});

test('correction selections are rejected unless the signed context enables contract version 1', () => {
  assert.throws(
    () => validateSignedLinkCorrections(undefined, [], {
      'ext-a': { outcome: 'unlink', fromIndividualId: 10 },
    }),
    /do not match the signed review preview/i
  );
  assert.throws(
    () => validateSignedLinkCorrections(2, [{
      externalPersonId: 'ext-a', outcome: 'unlink', fromIndividualId: 10,
    }], {
      'ext-a': { outcome: 'unlink', fromIndividualId: 10 },
    }),
    /do not match the signed review preview/i
  );
});

test('projected established links reserve their final local identity targets', () => {
  const plan = reviewPlan({
    'ext-new': identity(),
  });
  plan.reviewContext.projectedEstablishedLinks = {
    'ext-established': { individualId: 10 },
  };

  assert.throws(
    () => validateIdentityDecisions(plan, selections({
      'ext-new': { outcome: 'link', individualId: 10 },
    })),
    /individual 10.*claimed/i
  );
});

test('a correction can free a local person for another reviewed identity and derives durable effects', () => {
  const plan = reviewPlan({
    'ext-new': identity(),
  });
  plan.reviewContext.projectedEstablishedLinks = {
    'ext-established': { individualId: 11 },
  };
  plan.reviewContext.linkCorrections = [{
    externalPersonId: 'ext-established',
    fromIndividualId: 10,
    outcome: 'relink',
    individualId: 11,
  }];

  const accepted = validateIdentityDecisions(plan, selections(
    { 'ext-new': { outcome: 'link', individualId: 10 } },
    {
      linkCorrections: {
        'ext-established': {
          fromIndividualId: 10, outcome: 'relink', individualId: 11,
        },
      },
    }
  ));

  assert.deepEqual(accepted.linkActions, [{
    externalPersonId: 'ext-new', individualId: 10, linkSource: 'manual',
  }]);
  assert.deepEqual(accepted.linkCorrections, [{
    externalPersonId: 'ext-established', fromIndividualId: 10,
    outcome: 'relink', individualId: 11,
  }]);
  assert.deepEqual(accepted.correctionExclusionsToAdd, [{
    externalPersonId: 'ext-established', individualId: 10,
  }]);
  assert.deepEqual(accepted.correctionHoldsToUpsert, []);
  assert.deepEqual(accepted.correctionHoldsToDelete, ['ext-established']);
});

function selections(identityDecisions, overrides = {}) {
  return {
    decisionContractVersion: 2,
    identityDecisions,
    ...overrides,
  };
}

test('normalizes every v2 outcome into explicit apply data', () => {
  const plan = reviewPlan({
    'ext-accept': identity({ suggestedIndividualId: 10, candidateIndividualIds: [10] }),
    'ext-link': identity({ suggestedIndividualId: 11, candidateIndividualIds: [11, 12] }),
    'ext-create': identity({ suggestedIndividualId: 13, candidateIndividualIds: [13] }),
    'ext-defer': identity(),
  }, {
    addPeople: [
      { id: 'addPeople:ext-create', externalPersonId: 'ext-create' },
      { id: 'addPeople:ext-defer', externalPersonId: 'ext-defer' },
    ],
  });

  const accepted = validateIdentityDecisions(plan, selections({
    'ext-accept': { outcome: 'accept' },
    'ext-link': { outcome: 'link', individualId: 12, excludeIndividualId: 11 },
    'ext-create': { outcome: 'create', excludeIndividualId: 13 },
    'ext-defer': { outcome: 'defer' },
  }));

  assert.equal(accepted.contractVersion, 2);
  assert.deepEqual(accepted.linkActions, [
    { externalPersonId: 'ext-accept', individualId: 10, linkSource: 'matched' },
    { externalPersonId: 'ext-link', individualId: 12, linkSource: 'manual' },
  ]);
  assert.deepEqual([...accepted.createExternalIds], ['ext-create']);
  assert.deepEqual([...accepted.deferredReasons], [['ext-defer', 'deferred']]);
  assert.deepEqual(accepted.exclusionsToAdd, [
    { externalPersonId: 'ext-create', individualId: 13 },
    { externalPersonId: 'ext-link', individualId: 11 },
  ]);
  assert.deepEqual(accepted.exclusionsToRemove, []);
  assert.deepEqual([...accepted.skippedAddExternalIds], ['ext-defer']);
  assert.deepEqual(accepted.suppressedSuggestedPairs, [
    { externalPersonId: 'ext-create', suggestedIndividualId: 13 },
    { externalPersonId: 'ext-link', suggestedIndividualId: 11 },
  ]);
  assert.equal(accepted.acceptedArchiveIndividualIds.size, 0);
  assert.equal(accepted.acceptedFamilyRenameIds.size, 0);
});

test('requires the exact supported decision and review context versions', () => {
  const plan = reviewPlan({ 'ext-1': identity() });
  assert.throws(
    () => validateIdentityDecisions(plan, { decisionContractVersion: 1, identityDecisions: {} }),
    /unsupported identity decision contract version/i
  );
  assert.throws(
    () => validateIdentityDecisions(emptyPlan(), selections({})),
    /plan does not support identity decisions/i
  );
  assert.throws(
    () => validateIdentityDecisions(emptyPlan({ reviewContext: { version: 1 } }), selections({})),
    /plan does not support identity decisions/i
  );
});

test('canonicalizes omitted signed identities to deferred and rejects outside external IDs', () => {
  const plan = reviewPlan({
    'ext-1': identity(),
    'ext-2': identity(),
  });
  const accepted = validateIdentityDecisions(plan, selections({
    'ext-1': { outcome: 'defer' },
  }));
  assert.deepEqual([...accepted.deferredReasons], [
    ['ext-1', 'deferred'],
    ['ext-2', 'deferred'],
  ]);
  assert.throws(
    () => validateIdentityDecisions(plan, selections({
      'ext-1': { outcome: 'defer' },
      'ext-2': { outcome: 'defer' },
      'ext-outside': { outcome: 'defer' },
    })),
    /not present in this plan.*ext-outside/i
  );
});

test('rejects malformed decision containers, outcomes, and extra fields', () => {
  const plan = reviewPlan({ 'ext-1': identity({ suggestedIndividualId: 10, candidateIndividualIds: [10] }) });
  assert.throws(
    () => validateIdentityDecisions(plan, selections(null)),
    /identity decisions must be an object/i
  );
  assert.throws(
    () => validateIdentityDecisions(plan, selections({ 'ext-1': null })),
    /decision for ext-1 must be an object/i
  );
  assert.throws(
    () => validateIdentityDecisions(plan, selections({ 'ext-1': { outcome: 'guess' } })),
    /unsupported identity outcome/i
  );
  assert.throws(
    () => validateIdentityDecisions(plan, selections({ 'ext-1': { outcome: 'accept', individualId: 10 } })),
    /invalid fields/i
  );
  assert.throws(
    () => validateIdentityDecisions(plan, selections({ 'ext-1': { outcome: 'create', individualId: 10 } })),
    /invalid fields/i
  );
  assert.throws(
    () => validateIdentityDecisions(plan, selections({ 'ext-1': { outcome: 'defer', surprise: true } })),
    /invalid fields/i
  );
});

test('accept requires the signed deterministic suggestion', () => {
  const plan = reviewPlan({ 'ext-1': identity() });
  assert.throws(
    () => validateIdentityDecisions(plan, selections({ 'ext-1': { outcome: 'accept' } })),
    /has no suggested individual/i
  );
});

test('link requires a positive integer exposed as a manual candidate', () => {
  const plan = reviewPlan({ 'ext-1': identity() });
  for (const individualId of [undefined, 0, -1, 10.5, '10', 999]) {
    const decision = individualId === undefined
      ? { outcome: 'link' }
      : { outcome: 'link', individualId };
    assert.throws(
      () => validateIdentityDecisions(plan, selections({ 'ext-1': decision })),
      /link individual id|manual candidate/i
    );
  }
});

test('two explicit links cannot claim the same local individual', () => {
  const plan = reviewPlan({
    'ext-1': identity({ suggestedIndividualId: 10, candidateIndividualIds: [10] }),
    'ext-2': identity(),
  });
  assert.throws(
    () => validateIdentityDecisions(plan, selections({
      'ext-1': { outcome: 'accept' },
      'ext-2': { outcome: 'link', individualId: 10 },
    })),
    /individual 10.*claimed/i
  );
});

test('create requires permission and signed create data', () => {
  assert.throws(
    () => validateIdentityDecisions(
      reviewPlan({ 'ext-1': identity({ canCreate: false }) }),
      selections({ 'ext-1': { outcome: 'create' } })
    ),
    /cannot be created/i
  );
  assert.throws(
    () => validateIdentityDecisions(
      reviewPlan({ 'ext-1': identity({ createPerson: null }) }),
      selections({ 'ext-1': { outcome: 'create' } })
    ),
    /create data/i
  );
});

test('an exclusion must be an exposed candidate and cannot be the accepted target', () => {
  const plan = reviewPlan({
    'ext-1': identity({ suggestedIndividualId: 10, candidateIndividualIds: [10, 11] }),
  });
  assert.throws(
    () => validateIdentityDecisions(plan, selections({
      'ext-1': { outcome: 'link', individualId: 12, excludeIndividualId: 999 },
    })),
    /exclusion.*candidate/i
  );
  assert.throws(
    () => validateIdentityDecisions(plan, selections({
      'ext-1': { outcome: 'link', individualId: 11, excludeIndividualId: 11 },
    })),
    /cannot exclude.*accepted target/i
  );
  assert.throws(
    () => validateIdentityDecisions(plan, selections({
      'ext-1': { outcome: 'create', excludeIndividualId: '10' },
    })),
    /exclusion individual id/i
  );
});

test('defer with an exclusion records a rejected pair and suppresses its suggestion', () => {
  const plan = reviewPlan({
    'ext-1': identity({ suggestedIndividualId: 10, candidateIndividualIds: [10] }),
  });
  const accepted = validateIdentityDecisions(plan, selections({
    'ext-1': { outcome: 'defer', excludeIndividualId: 10 },
  }));
  assert.deepEqual([...accepted.deferredReasons], [['ext-1', 'pair_rejected']]);
  assert.deepEqual(accepted.exclusionsToAdd, [{ externalPersonId: 'ext-1', individualId: 10 }]);
  assert.deepEqual(accepted.suppressedSuggestedPairs, [{ externalPersonId: 'ext-1', suggestedIndividualId: 10 }]);
});

test('manually linking an excluded pair removes that exact exclusion', () => {
  const plan = reviewPlan({
    'ext-1': identity({ excludedIndividualIds: [12] }),
  });
  const accepted = validateIdentityDecisions(plan, selections({
    'ext-1': { outcome: 'link', individualId: 12 },
  }));
  assert.deepEqual(accepted.linkActions, [{
    externalPersonId: 'ext-1', individualId: 12, linkSource: 'manual',
  }]);
  assert.deepEqual(accepted.exclusionsToRemove, [{ externalPersonId: 'ext-1', individualId: 12 }]);
});

test('v2 destructive selections use the same plan-scoped validation and link collision checks', () => {
  const plan = reviewPlan({
    'ext-1': identity({ suggestedIndividualId: 10, candidateIndividualIds: [10] }),
  }, {
    ambiguousPeople: [{
      id: 'ambiguousPeople:ext-1:10',
      externalPersonId: 'ext-1',
      candidateIndividualIds: [10],
    }],
    unmatchedLocalRegulars: [{ id: 'unmatchedLocalRegulars:14', individualId: 14 }],
    renameFamily: [{ id: 'renameFamily:9', familyId: 9, familyName: 'New Name' }],
  });
  const accepted = validateIdentityDecisions(plan, selections(
    { 'ext-1': { outcome: 'accept' } },
    {
      acceptArchiveIndividualIds: [14],
      acceptFamilyRenameIds: ['renameFamily:9'],
    }
  ));
  assert.deepEqual([...accepted.acceptedArchiveIndividualIds], [14]);
  assert.deepEqual([...accepted.acceptedFamilyRenameIds], ['renameFamily:9']);

  assert.throws(
    () => validateIdentityDecisions(plan, selections(
      { 'ext-1': { outcome: 'accept' } },
      { acceptArchiveIndividualIds: [10] }
    )),
    /collides with an accepted link/i
  );
  assert.throws(
    () => validateIdentityDecisions(plan, selections(
      { 'ext-1': { outcome: 'accept' } },
      { acceptArchiveIndividualIds: [999] }
    )),
    /not surfaced for review/i
  );
  assert.throws(
    () => validateIdentityDecisions(plan, selections(
      { 'ext-1': { outcome: 'accept' } },
      { acceptFamilyRenameIds: ['renameFamily:missing'] }
    )),
    /not offered in this plan/i
  );
});
