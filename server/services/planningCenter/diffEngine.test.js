const { test } = require('node:test');
const assert = require('node:assert');
const { computePlan } = require('./diffEngine');

function pco(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, status: 'active', membership: 'Church Members', child: false, householdId: null, ...extra };
}
function ind(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, isChild: false, familyId: null, isActive: true, planningCenterId: null, ...extra };
}
const ALLOW = ['Church Members', 'Regular Attenders'];

test('archive only on PCO inactive for a linked person', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'inactive' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.archive, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.reactivate, []);
});

test('reactivate requires active AND allow-list membership', () => {
  const inAllow = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Church Members' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(inAllow.reactivate, [{ individualId: 1, pcoId: 'p1' }]);

  const notAllow = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: false })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(notAllow.reactivate, []);
});

test('update when name or child flag differs', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Robert', 'Jones', { child: true })],
    individuals: [ind(1, 'Bob', 'Jones', { planningCenterId: 'p1', isChild: false })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.update, [{ individualId: 1, pcoId: 'p1', firstName: 'Robert', lastName: 'Jones', isChild: true }]);
});

test('add only for allow-listed active people with no LMPG match', () => {
  const plan = computePlan({
    pcoPeople: [
      pco('p1', 'New', 'Member', { membership: 'Church Members' }),
      pco('p2', 'Some', 'Contact', { membership: 'Community Contact' }),
      pco('p3', 'Gone', 'Person', { membership: 'Church Members', status: 'inactive' }),
    ],
    individuals: [], families: [], allowlist: ALLOW,
  });
  assert.strictEqual(plan.add.length, 1);
  assert.strictEqual(plan.add[0].pcoId, 'p1');
});

test('name-matched unlinked person becomes a link, never a duplicate add', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Sarah', 'Wierenga', { membership: 'Church Members' })],
    individuals: [ind(1, 'Sarah', 'Wierenga', { planningCenterId: null })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.link, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.add, []);
});

test('membership demotion while active is a no-op (no archive)', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'A', 'B', { status: 'active', membership: 'Community Contact' })],
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'p1', isActive: true })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.archive, []);
  assert.deepStrictEqual(plan.reactivate, []);
});

test('ambiguous candidate is not added', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'John', 'Smith'), pco('p2', 'John', 'Smith')],
    individuals: [ind(1, 'John', 'Smith', { planningCenterId: null })],
    families: [], allowlist: ALLOW,
  });
  assert.strictEqual(plan.ambiguous.length, 1);
  assert.deepStrictEqual(plan.add, []);
});

test('linked person absent from PCO fetch is left alone', () => {
  const plan = computePlan({
    pcoPeople: [],  // PCO returned nothing for this linked person
    individuals: [ind(1, 'A', 'B', { planningCenterId: 'gone', isActive: true })],
    families: [], allowlist: ALLOW,
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
    families: [], allowlist: [],
  });
  assert.deepStrictEqual(plan.add, []);
  assert.deepStrictEqual(plan.reactivate, []);
  assert.deepStrictEqual(plan.archive, [{ individualId: 2, pcoId: 'p2' }]);
});

test('archived individual matching PCO goes to restore (not link)', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Lazarus', 'Risen', { membership: 'Church Members' })],
    individuals: [ind(1, 'Lazarus', 'Risen', { planningCenterId: null, isActive: false })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.restore, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(plan.link, []);
});

test('active regular not in PCO goes to archiveExtras', () => {
  const plan = computePlan({
    pcoPeople: [],
    individuals: [ind(1, 'Manual', 'Member', { peopleType: 'regular', isActive: true })],
    families: [], allowlist: ALLOW,
  });
  assert.strictEqual(plan.archiveExtras.length, 1);
  assert.strictEqual(plan.archiveExtras[0].individualId, 1);
  assert.deepStrictEqual(plan.unmatchedVisitors, []);
});

test('unmatched visitor goes to unmatchedVisitors, not archiveExtras', () => {
  const plan = computePlan({
    pcoPeople: [],
    individuals: [ind(1, 'Casual', 'Drop-in', { peopleType: 'local_visitor', isActive: true })],
    families: [], allowlist: ALLOW,
  });
  assert.strictEqual(plan.unmatchedVisitors.length, 1);
  assert.strictEqual(plan.unmatchedVisitors[0].individualId, 1);
  assert.deepStrictEqual(plan.archiveExtras, []);
});

test('archived regular not in PCO is silent (no archiveExtras)', () => {
  const plan = computePlan({
    pcoPeople: [],
    individuals: [ind(1, 'Gone', 'Already', { peopleType: 'regular', isActive: false })],
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.archiveExtras, []);
});

test('visitor whose name matches PCO goes to visitorMatches, not link', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'Maybe', 'Member', { membership: 'Church Members' })],
    individuals: [ind(1, 'Maybe', 'Member', { peopleType: 'local_visitor', planningCenterId: null })],
    families: [], allowlist: ALLOW,
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
    families: [], allowlist: ALLOW,
  });
  assert.deepStrictEqual(plan.visitorMatches, []);
  assert.strictEqual(plan.unmatchedVisitors.length, 1);
  // PCO person is free to be added (no visitor decision holding it back)
  assert.strictEqual(plan.add.length, 1);
  assert.strictEqual(plan.add[0].pcoId, 'p1');
});

test('ambiguous entries are enriched with individual + candidate names', () => {
  const plan = computePlan({
    pcoPeople: [pco('p1', 'John', 'Smith', { membership: 'Church Members' }), pco('p2', 'John', 'Smith', { membership: 'New People' })],
    individuals: [ind(7, 'John', 'Smith', { planningCenterId: null })],
    families: [], allowlist: ALLOW,
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
  assert.strictEqual(byId.p2.membership, 'New People');
});
