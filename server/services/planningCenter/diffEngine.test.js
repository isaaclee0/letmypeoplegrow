const { test } = require('node:test');
const assert = require('node:assert');
const { computePlan } = require('./diffEngine');

function pco(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, status: 'active', membership: 'Church Members', child: false, householdId: null, fieldValues: {}, ...extra };
}
function ind(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, isChild: false, familyId: null, isActive: true, planningCenterId: null, ...extra };
}
const FILTER = { membershipFilterEnabled: true, membershipAllowlist: ['Church Members', 'Regular Attenders'], fieldFilterEnabled: false, fieldFilters: [] };
const FILTER_EMPTY = { membershipFilterEnabled: true, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [] };

function family(id, familyName, extra = {}) {
  return { id, familyName, planningCenterId: null, ...extra };
}

test('archive only on PCO inactive for a linked person', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'inactive' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.archive, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.reactivate, []);
});

test('reactivate requires active AND allow-list membership', () => {
  const inAllow = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Church Members' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(inAllow.reactivate, [{ individualId: 1, pcoId: 'p1' }]);

  const notAllow = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(notAllow.reactivate, []);
});

test('update when name or child flag differs', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Robert', 'Jones', { child: true })],
    individuals: [ind(1, 'Bob', 'Jones', { planningCenterId: 'p1', isChild: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.update, [{ individualId: 1, pcoId: 'p1', firstName: 'Robert', lastName: 'Jones', isChild: true }]);
});

test('add only for eligible active people with no LMPG match', () => {
  const plan = computePlan({
    pcoPeople: [
      pco('p1', 'New', 'Member', { membership: 'Church Members' }),
      pco('p2', 'Some', 'Contact', { membership: 'Community Contact' }),
      pco('p3', 'Gone', 'Person', { membership: 'Church Members', status: 'inactive' }),
    ],
    individuals: [], families: [], filterConfig: FILTER,
  });
  assert.strictEqual(plan.add.length, 1);
  assert.strictEqual(plan.add[0].pcoId, 'p1');
});

test('name-matched unlinked person becomes a link, never a duplicate add', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Sarah', 'Wierenga', { membership: 'Church Members' })],
    individuals: [ind(1, 'Sarah', 'Wierenga', { planningCenterId: null })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.link, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.add, []);
});

test('name-matched unlinked person whose PCO record is NOT eligible for this filter is left unlinked, not force-linked', () => {
  // Regression: a narrowly-scoped batch (e.g. one custom-tab field) must not link
  // every name-matchable person in all of PCO regardless of the batch's own filter —
  // only those the filter actually admits should ever be linked/restored/matched.
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Sarah', 'Wierenga', { membership: 'Community Contact' })], // not in FILTER's allow-list
    individuals: [ind(1, 'Sarah', 'Wierenga', { planningCenterId: null })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.add, []); // also not added (name already exists in LMPG, just left alone)
});

test('name-matched archived person whose PCO record is NOT eligible for this filter is not restored', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Sarah', 'Wierenga', { membership: 'Community Contact', status: 'active' })],
    individuals: [ind(1, 'Sarah', 'Wierenga', { planningCenterId: null, isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.restore, []);
});

test('field-filter batch only links people whose field values actually match, not every name-matchable person in PCO', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [],
    fieldFilterEnabled: true,
    fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Little Squirts'] }],
  };
  const plan = computePlan({
    pcoPeople: [
      pco('p1', 'Tagged', 'Kid', { fieldValues: { f1: ['Little Squirts'] } }),
      pco('p2', 'Untagged', 'Kid', { fieldValues: {} }),
      pco('p3', 'Other', 'Tag', { fieldValues: { f1: ['Something Else'] } }),
    ],
    individuals: [
      ind(1, 'Tagged', 'Kid', { planningCenterId: null }),
      ind(2, 'Untagged', 'Kid', { planningCenterId: null }),
      ind(3, 'Other', 'Tag', { planningCenterId: null }),
    ],
    families: [], filterConfig: cfg,
  });
  assert.deepStrictEqual(plan.link, [{ individualId: 1, pcoId: 'p1' }]);
});

test('membership demotion while active is a no-op (no archive)', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.archive, []);
  assert.deepStrictEqual(plan.reactivate, []);
});

test('ambiguous candidate is not added', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'John', 'Smith'), pco('p2', 'John', 'Smith')],
    individuals: [ind(1, 'John', 'Smith', { planningCenterId: null })],
    families: [], filterConfig: FILTER,
  });
  assert.strictEqual(plan.ambiguous.length, 1);
  assert.deepStrictEqual(plan.add, []);
});

test('linked person absent from PCO fetch is left alone', () => {
  const plan = computePlan({
    pcoPeople: [],  // PCO returned nothing for this linked person
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'gone', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.archive, []);
  assert.deepStrictEqual(plan.update, []);
  assert.deepStrictEqual(plan.reactivate, []);
});

test('empty allowlist: no adds, no reactivates, but archive still applies', () => {
  const plan = computePlan({
    pcoPeople: [
      pco('p1', 'New', 'Person', { membership: 'Church Members', status: 'active' }),
      pco('p2', 'Old', 'Member', { membership: 'Church Members', status: 'inactive' }),
    ],
    individuals: [ind(2, 'Old', 'Member', { planningCenterId: 'p2', isActive: true })],
    families: [], filterConfig: FILTER_EMPTY,
  });
  assert.deepStrictEqual(plan.add, []);
  assert.deepStrictEqual(plan.reactivate, []);
  assert.deepStrictEqual(plan.archive, [{ individualId: 2, pcoId: 'p2' }]);
});

test('archived individual matching PCO goes to restore (not link)', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Lazarus', 'Risen', { membership: 'Church Members' })],
    individuals: [ind(1, 'Lazarus', 'Risen', { planningCenterId: null, isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.restore, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.link, []);
});

test('archived individual name-matching an INACTIVE PCO person is not restored (stays archived)', () => {
  // Regression: someone archived in LMPG whose name matches a person who is
  // themselves archived/inactive in PCO must not be unarchived just because the
  // names match — PCO's inactive status should be respected, not overridden.
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Lazarus', 'Risen', { membership: 'Church Members', status: 'inactive' })],
    individuals: [ind(1, 'Lazarus', 'Risen', { planningCenterId: null, isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.restore, []);
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.add, []);
});

test('active individual name-matching an INACTIVE PCO person is not linked', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Sarah', 'Wierenga', { membership: 'Church Members', status: 'inactive' })],
    individuals: [ind(1, 'Sarah', 'Wierenga', { planningCenterId: null, isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.restore, []);
});

test('active regular not in PCO goes to archiveExtras', () => {
  const plan = computePlan({
    pcoPeople: [],
    individuals: [ind(1, 'Manual', 'Member', { peopleType: 'regular', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.strictEqual(plan.archiveExtras.length, 1);
  assert.strictEqual(plan.archiveExtras[0].individualId, 1);
  assert.deepStrictEqual(plan.unmatchedVisitors, []);
});

test('unmatched visitor goes to unmatchedVisitors, not archiveExtras', () => {
  const plan = computePlan({
    pcoPeople: [],
    individuals: [ind(1, 'Casual', 'Drop-in', { peopleType: 'local_visitor', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.strictEqual(plan.unmatchedVisitors.length, 1);
  assert.strictEqual(plan.unmatchedVisitors[0].individualId, 1);
  assert.deepStrictEqual(plan.archiveExtras, []);
});

test('archived regular not in PCO is silent (no archiveExtras)', () => {
  const plan = computePlan({
    pcoPeople: [],
    individuals: [ind(1, 'Gone', 'Already', { peopleType: 'regular', isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.archiveExtras, []);
});

test('visitor whose name matches PCO goes to visitorMatches, not link', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Maybe', 'Member', { membership: 'Church Members' })],
    individuals: [ind(1, 'Maybe', 'Member', { peopleType: 'local_visitor', planningCenterId: null })],
    families: [], filterConfig: FILTER,
  });
  assert.strictEqual(plan.visitorMatches.length, 1);
  assert.strictEqual(plan.visitorMatches[0].individualId, 1);
  assert.strictEqual(plan.visitorMatches[0].candidate.pcoId, 'p1');
  assert.deepStrictEqual(plan.link, []);
  assert.deepStrictEqual(plan.add, []); // pco person reserved for the visitor decision, not added
});

test('visitor with pco_link_declined is skipped from visitorMatches, still in unmatchedVisitors', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Said', 'No', { membership: 'Church Members' })],
    individuals: [ind(1, 'Said', 'No', { peopleType: 'local_visitor', pcoLinkDeclined: 1 })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.visitorMatches, []);
  assert.strictEqual(plan.unmatchedVisitors.length, 1);
  // PCO person is free to be added (no visitor decision holding it back)
  assert.strictEqual(plan.add.length, 1);
  assert.strictEqual(plan.add[0].pcoId, 'p1');
});

test('ambiguous entries are enriched with individual + candidate names', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'John', 'Smith', { membership: 'Church Members' }), pco('p2', 'John', 'Smith', { membership: 'Regular Attenders' })],
    individuals: [ind(7, 'John', 'Smith', { planningCenterId: null })],
    families: [], filterConfig: FILTER,
  });
  assert.strictEqual(plan.ambiguous.length, 1);
  const a = plan.ambiguous[0];
  assert.strictEqual(a.individualId, 7);
  assert.strictEqual(a.firstName, 'John');
  assert.strictEqual(a.lastName, 'Smith');
  assert.deepStrictEqual(a.candidates.sort(), ['p1', 'p2']); // bare ids preserved
  const byId = Object.fromEntries(a.candidateDetails.map((c) => [c.pcoId, c]));
  assert.strictEqual(byId.p1.firstName, 'John');
  assert.strictEqual(byId.p1.membership, 'Church Members');
  assert.strictEqual(byId.p2.membership, 'Regular Attenders');
});

test('ambiguous candidates outside the filter are dropped; entry disappears if none remain eligible', () => {
  const narrowed = computePlan({
    pcoPeople: [pco('p1', 'John', 'Smith', { membership: 'Church Members' }), pco('p2', 'John', 'Smith', { membership: 'New People' })],
    individuals: [ind(7, 'John', 'Smith', { planningCenterId: null })],
    families: [], filterConfig: FILTER, // allow-list only includes 'Church Members'/'Regular Attenders'
  });
  assert.strictEqual(narrowed.ambiguous.length, 1);
  assert.deepStrictEqual(narrowed.ambiguous[0].candidates, ['p1']); // p2 (New People) filtered out

  const noneEligible = computePlan({
    pcoPeople: [pco('p1', 'John', 'Smith', { membership: 'New People' }), pco('p2', 'John', 'Smith', { membership: 'Visitors' })],
    individuals: [ind(7, 'John', 'Smith', { planningCenterId: null })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(noneEligible.ambiguous, []); // entry dropped entirely, not just emptied
});

test('field-filter source alone can make a person eligible for add, independent of membership', () => {
  const cfg = {
    membershipFilterEnabled: true, membershipAllowlist: ['Church Members'],
    fieldFilterEnabled: true, fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Attends Youth Gathering'] }],
  };
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Field', 'Only', { membership: 'Community Contact', fieldValues: { f1: ['Attends Youth Gathering'] } })],
    individuals: [], families: [], filterConfig: cfg,
  });
  assert.strictEqual(plan.add.length, 1);
  assert.strictEqual(plan.add[0].pcoId, 'p1');
});

test('gatheringEligible: already-linked, active, eligible person is included', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Church Members' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.gatheringEligible, [{ individualId: 1, pcoId: 'p1' }]);
});

test('gatheringEligible: already-linked, active, NOT eligible person is excluded', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.gatheringEligible, []);
});

test('gatheringEligible: excludes someone being archived this run even if eligible before', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'inactive', membership: 'Church Members' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.archive, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.gatheringEligible, []);
});

test('gatheringEligible: reactivate-and-eligible person appears in both reactivate and gatheringEligible', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Church Members' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.reactivate, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.gatheringEligible, [{ individualId: 1, pcoId: 'p1' }]);
});

test('gatheringEligible: reactivate candidate that is not eligible is excluded from both', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.reactivate, []);
  assert.deepStrictEqual(plan.gatheringEligible, []);
});

test('familyNameUpdates: proposes a rename when the linked head-of-household differs from the current family name', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 })],
    families: [family(10, 'Smith, John', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, [{ familyId: 10, oldName: 'Smith, John', newName: 'Smith, Jane' }]);
});

test('familyNameUpdates: skips when the head-of-household is not yet linked in LMPG', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p2', familyId: 10 })],
    families: [family(10, 'Smith, John', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, []);
});

test('familyNameUpdates: does not propose when the name already matches', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 })],
    families: [family(10, 'Smith, Jane', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, []);
});

test('familyNameUpdates: skips families with no planning_center_id', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 })],
    families: [family(10, 'Smith, John')],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, []);
});

test('familyNameUpdates: empty when householdPrimaryContacts is not provided', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [ind(1, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 })],
    families: [family(10, 'Smith, John', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
  });
  assert.deepStrictEqual(plan.familyNameUpdates, []);
});

test('familyNameUpdates: puts the head-of-household first among adults, keeps other adults', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Jane', 'Smith', { householdId: 'h1' })],
    individuals: [
      ind(1, 'John', 'Smith', { planningCenterId: 'p0', familyId: 10 }),
      ind(2, 'Jane', 'Smith', { planningCenterId: 'p1', familyId: 10 }),
    ],
    families: [family(10, 'Smith, John and Jane', { planningCenterId: 'h1' })],
    filterConfig: FILTER,
    householdPrimaryContacts: new Map([['h1', 'p1']]),
  });
  assert.deepStrictEqual(plan.familyNameUpdates, [{ familyId: 10, oldName: 'Smith, John and Jane', newName: 'Smith, Jane and John' }]);
});
