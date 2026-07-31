const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateLegacySelections, validateSelections } = require('./apply');
const { BUCKETS } = require('./plan');

function emptyPlan(overrides = {}) {
  const plan = { provider: 'elvanto', authoritative: true };
  for (const bucket of BUCKETS) plan[bucket] = [];
  return { ...plan, ...overrides };
}

test('validateSelections on an empty plan with no selections accepts nothing', () => {
  const accepted = validateSelections(emptyPlan(), {});
  assert.equal(accepted.contractVersion, 1);
  assert.deepEqual(accepted.acceptedLinks, []);
  assert.equal(accepted.skipExternalPersonIds.size, 0);
  assert.equal(accepted.acceptedArchiveIndividualIds.size, 0);
  assert.equal(accepted.acceptedFamilyRenameIds.size, 0);
});

test('validateSelections dispatches an explicit version 2 payload to the identity contract', () => {
  const plan = emptyPlan({
    reviewContext: {
      version: 2,
      manualCandidateIndividualIds: [],
      identities: {},
    },
  });
  assert.equal(validateSelections(plan, { decisionContractVersion: 2, identityDecisions: {} }).contractVersion, 2);
  assert.equal(validateLegacySelections(plan, { decisionContractVersion: 2 }).contractVersion, 1);
});

test('validateSelections rejects every explicitly present unsupported decision contract version', () => {
  for (const decisionContractVersion of [1, 3, null, undefined, '2']) {
    assert.throws(
      () => validateSelections(emptyPlan(), { decisionContractVersion }),
      /unsupported identity decision contract version/i
    );
  }
});

test('validateSelections rejects identity decisions that omit decision contract version 2', () => {
  assert.throws(
    () => validateSelections(emptyPlan(), { identityDecisions: {} }),
    /identity decisions require decision contract version 2/i
  );
});

test('an ambiguous selection must reference a person actually offered for review', () => {
  const plan = emptyPlan({
    ambiguousPeople: [{ id: 'ambiguousPeople:ext-1:x', externalPersonId: 'ext-1', candidateIndividualIds: [1, 2] }],
  });
  assert.throws(
    () => validateSelections(plan, { ambiguous: { 'not-offered': 1 } }),
    /not offered for review/i
  );
});

test('an ambiguous selection must choose one of the plan\'s own candidate individuals', () => {
  const plan = emptyPlan({
    ambiguousPeople: [{ id: 'ambiguousPeople:ext-1:x', externalPersonId: 'ext-1', candidateIndividualIds: [1, 2] }],
  });
  // 999 is an arbitrary local ID never offered by this plan — this is exactly
  // the "cannot reach another church via an arbitrary local ID" defense: the
  // plan only ever lists candidates already scoped to this church, so any ID
  // outside that list is rejected without needing a DB lookup at all.
  assert.throws(
    () => validateSelections(plan, { ambiguous: { 'ext-1': 999 } }),
    /must choose one of this plan's own candidate individuals/i
  );
});

test('a valid ambiguous selection is accepted as a manual link', () => {
  const plan = emptyPlan({
    ambiguousPeople: [{ id: 'ambiguousPeople:ext-1:x', externalPersonId: 'ext-1', candidateIndividualIds: [1, 2] }],
  });
  const accepted = validateSelections(plan, { ambiguous: { 'ext-1': 2 } });
  assert.deepEqual(accepted.acceptedLinks, [{ externalPersonId: 'ext-1', individualId: 2, linkSource: 'manual' }]);
});

test('two ambiguous selections cannot both resolve to the same individual', () => {
  const plan = emptyPlan({
    ambiguousPeople: [
      { id: 'ambiguousPeople:ext-1:x', externalPersonId: 'ext-1', candidateIndividualIds: [5] },
      { id: 'ambiguousPeople:ext-2:x', externalPersonId: 'ext-2', candidateIndividualIds: [5] },
    ],
  });
  assert.throws(
    () => validateSelections(plan, { ambiguous: { 'ext-1': 5, 'ext-2': 5 } }),
    /collides with another accepted link/i
  );
});

test('an ambiguous selection cannot collide with an already-established link in the plan', () => {
  const plan = emptyPlan({
    linkPeople: [{ id: 'linkPeople:ext-9:5', externalPersonId: 'ext-9', individualId: 5, reviewRequired: false }],
    ambiguousPeople: [{ id: 'ambiguousPeople:ext-1:x', externalPersonId: 'ext-1', candidateIndividualIds: [5] }],
  });
  assert.throws(
    () => validateSelections(plan, { ambiguous: { 'ext-1': 5 } }),
    /collides with another accepted link/i
  );
});

test('a visitor choice must reference a reviewRequired linkPeople suggestion', () => {
  const plan = emptyPlan({
    linkPeople: [{ id: 'linkPeople:ext-1:1', externalPersonId: 'ext-1', individualId: 1, reviewRequired: false }],
  });
  assert.throws(
    () => validateSelections(plan, { visitorChoices: { 'ext-1': 'promote' } }),
    /not offered for review/i
  );
});

test('a visitor choice must be "promote" or "keep"', () => {
  const plan = emptyPlan({
    linkPeople: [{ id: 'linkPeople:ext-1:1', externalPersonId: 'ext-1', individualId: 1, reviewRequired: true }],
  });
  assert.throws(
    () => validateSelections(plan, { visitorChoices: { 'ext-1': 'nonsense' } }),
    /must be "promote" or "keep"/i
  );
});

test('promoting a reviewed visitor match accepts the link; keeping it accepts nothing', () => {
  const plan = emptyPlan({
    linkPeople: [{ id: 'linkPeople:ext-1:1', externalPersonId: 'ext-1', individualId: 1, reviewRequired: true }],
  });
  const promoted = validateSelections(plan, { visitorChoices: { 'ext-1': 'promote' } });
  assert.deepEqual(promoted.acceptedLinks, [{ externalPersonId: 'ext-1', individualId: 1, linkSource: 'manual' }]);

  const kept = validateSelections(plan, { visitorChoices: { 'ext-1': 'keep' } });
  assert.deepEqual(kept.acceptedLinks, []);
});

test('skipExternalPersonIds must reference an addition actually offered in the plan', () => {
  const plan = emptyPlan({ addPeople: [{ id: 'addPeople:ext-1', externalPersonId: 'ext-1' }] });
  assert.throws(
    () => validateSelections(plan, { skipExternalPersonIds: ['not-offered'] }),
    /not offered in this plan/i
  );
  const accepted = validateSelections(plan, { skipExternalPersonIds: ['ext-1'] });
  assert.equal(accepted.skipExternalPersonIds.has('ext-1'), true);
});

test('acceptArchiveIndividualIds must reference a planned archive, unmatched local regular, or ambiguous candidate', () => {
  const plan = emptyPlan({
    archive: [{ id: 'archive:ext-2:6', externalPersonId: 'ext-2', individualId: 6 }],
    unmatchedLocalRegulars: [{ id: 'unmatchedLocalRegulars:7', individualId: 7 }],
    ambiguousPeople: [{ id: 'ambiguousPeople:ext-1:x', externalPersonId: 'ext-1', candidateIndividualIds: [3, 4] }],
  });
  assert.throws(
    () => validateSelections(plan, { acceptArchiveIndividualIds: [999] }),
    /not surfaced for review in this plan/i
  );
  const accepted = validateSelections(plan, { acceptArchiveIndividualIds: [7, 4, 6] });
  assert.deepEqual([...accepted.acceptedArchiveIndividualIds].sort(), [4, 6, 7]);
});

test('an accepted archive cannot collide with an accepted link for the same individual', () => {
  const plan = emptyPlan({
    ambiguousPeople: [{ id: 'ambiguousPeople:ext-1:x', externalPersonId: 'ext-1', candidateIndividualIds: [5] }],
  });
  assert.throws(
    () => validateSelections(plan, { ambiguous: { 'ext-1': 5 }, acceptArchiveIndividualIds: [5] }),
    /collides with an accepted link/i
  );
});

test('acceptFamilyRenameIds must reference a renameFamily action actually offered in the plan', () => {
  const plan = emptyPlan({
    renameFamily: [{ id: 'renameFamily:9', familyId: 9, familyName: 'New Name' }],
  });
  assert.throws(
    () => validateSelections(plan, { acceptFamilyRenameIds: ['renameFamily:missing'] }),
    /not offered in this plan/i
  );
  const accepted = validateSelections(plan, { acceptFamilyRenameIds: ['renameFamily:9'] });
  assert.equal(accepted.acceptedFamilyRenameIds.has('renameFamily:9'), true);
});

test('validateSelections requires a plan object', () => {
  assert.throws(() => validateSelections(null, {}), /plan is required/i);
});
