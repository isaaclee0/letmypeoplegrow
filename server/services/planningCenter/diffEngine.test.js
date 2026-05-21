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
