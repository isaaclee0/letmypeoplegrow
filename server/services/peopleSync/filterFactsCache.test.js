'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFilterFactsCache } = require('./filterFactsCache');

function completeEntry({ churchId = 'churcha1', provider = 'planning_center', facts = [{ externalPersonId: 'p1', dimensions: { membership: ['member'] } }], coveredDimensionIds = ['membership'] } = {}) {
  return {
    complete: true,
    churchId,
    provider,
    coveredDimensionIds,
    dimensions: [{ id: 'membership', values: [{ id: 'member', count: 1 }] }],
    facts,
    populationGateDigest: 'gate-digest',
  };
}

test('rejects incomplete and incremental snapshots before replacing a complete cache entry', () => {
  const cache = createFilterFactsCache({ now: () => 0 });

  assert.throws(() => cache.putComplete({ ...completeEntry(), complete: false }), /complete snapshot/i);
  assert.throws(() => cache.putComplete({ ...completeEntry(), complete: true, facts: undefined }), /facts/i);
  assert.equal(cache.get('churcha1', 'planning_center'), null);
});

test('replaces a church/provider entry with the latest complete snapshot only', () => {
  let now = 0;
  const cache = createFilterFactsCache({ now: () => now });
  const first = cache.putComplete(completeEntry({ facts: [{ externalPersonId: 'p1', dimensions: { membership: ['member'] } }] }));
  now = 1;
  const second = cache.putComplete(completeEntry({ facts: [{ externalPersonId: 'p2', dimensions: { membership: ['attender'] } }] }));

  const cached = cache.get('churcha1', 'planning_center');
  assert.equal(cached.snapshotId, second.snapshotId);
  assert.notEqual(cached.snapshotId, first.snapshotId);
  assert.deepEqual(cached.facts, [{ externalPersonId: 'p2', dimensions: { membership: ['attender'] } }]);
});

test('isolates entries by both church and provider', () => {
  const cache = createFilterFactsCache({ now: () => 0 });
  cache.putComplete(completeEntry({ churchId: 'churcha1', provider: 'planning_center' }));
  cache.putComplete(completeEntry({ churchId: 'churchb2', provider: 'planning_center', facts: [{ externalPersonId: 'p2', dimensions: {} }] }));
  cache.putComplete(completeEntry({ churchId: 'churcha1', provider: 'elvanto', facts: [{ externalPersonId: 'p3', dimensions: {} }] }));

  assert.equal(cache.get('churcha1', 'planning_center').facts[0].externalPersonId, 'p1');
  assert.equal(cache.get('churchb2', 'planning_center').facts[0].externalPersonId, 'p2');
  assert.equal(cache.get('churcha1', 'elvanto').facts[0].externalPersonId, 'p3');
});

test('changes from fresh to stale exactly ten minutes after capture and expires exactly at twenty-four hours', () => {
  let now = 0;
  const cache = createFilterFactsCache({ now: () => now });
  const stored = cache.putComplete(completeEntry());

  assert.equal(stored.freshUntil, new Date(10 * 60 * 1000).toISOString());
  assert.equal(stored.expiresAt, new Date(24 * 60 * 60 * 1000).toISOString());
  assert.equal(cache.get('churcha1', 'planning_center').fresh, true);

  now = (10 * 60 * 1000) - 1;
  assert.equal(cache.get('churcha1', 'planning_center').fresh, true);
  now = 10 * 60 * 1000;
  assert.equal(cache.get('churcha1', 'planning_center').fresh, false);
  now = (24 * 60 * 60 * 1000) - 1;
  assert.equal(cache.get('churcha1', 'planning_center').fresh, false);
  now = 24 * 60 * 60 * 1000;
  assert.equal(cache.get('churcha1', 'planning_center'), null);
});

test('uses a timestamp-independent canonical identity and immutable defensive copies', () => {
  let now = 0;
  const cache = createFilterFactsCache({ now: () => now });
  const first = cache.putComplete(completeEntry({
    coveredDimensionIds: ['groups', 'membership'],
    facts: [
      { externalPersonId: 'p2', dimensions: { groups: ['music', 'youth'], membership: ['member'] } },
      { externalPersonId: 'p1', dimensions: { membership: ['member'] } },
    ],
  }));
  now = 1234;
  const second = cache.putComplete(completeEntry({
    coveredDimensionIds: ['membership', 'groups'],
    facts: [
      { dimensions: { membership: ['member'] }, externalPersonId: 'p1' },
      { dimensions: { membership: ['member'], groups: ['youth', 'music'] }, externalPersonId: 'p2' },
    ],
  }));

  assert.equal(first.snapshotId, second.snapshotId);
  assert.notEqual(first.capturedAt, second.capturedAt);
  const firstWithGroups = first.facts.find((fact) => fact.externalPersonId === 'p2');
  assert.throws(() => { firstWithGroups.dimensions.groups.push('blocked'); }, TypeError);
  const received = cache.get('churcha1', 'planning_center');
  const receivedWithGroups = received.facts.find((fact) => fact.externalPersonId === 'p2');
  assert.throws(() => { receivedWithGroups.dimensions.groups.push('blocked'); }, TypeError);
  assert.equal(cache.get('churcha1', 'planning_center').facts.find((fact) => fact.externalPersonId === 'p2').dimensions.groups.includes('blocked'), false);
});

test('keeps at most 200 most-recently-used church/provider entries', () => {
  const cache = createFilterFactsCache({ now: () => 0 });
  for (let index = 0; index < 200; index += 1) {
    cache.putComplete(completeEntry({ churchId: `church${index}`, facts: [{ externalPersonId: `p${index}`, dimensions: {} }] }));
  }
  cache.get('church0', 'planning_center');
  cache.putComplete(completeEntry({ churchId: 'church200', facts: [{ externalPersonId: 'p200', dimensions: {} }] }));

  assert.equal(cache.get('church1', 'planning_center'), null);
  assert.equal(cache.get('church0', 'planning_center').facts[0].externalPersonId, 'p0');
  assert.equal(cache.get('church200', 'planning_center').facts[0].externalPersonId, 'p200');
  assert.equal(cache.size(), 200);
});

test('clear removes only the requested church/provider entry', () => {
  const cache = createFilterFactsCache({ now: () => 0 });
  cache.putComplete(completeEntry({ churchId: 'churcha1', provider: 'planning_center' }));
  cache.putComplete(completeEntry({ churchId: 'churcha1', provider: 'elvanto' }));
  cache.putComplete(completeEntry({ churchId: 'churchb2', provider: 'planning_center' }));

  cache.clear('churcha1', 'planning_center');

  assert.equal(cache.get('churcha1', 'planning_center'), null);
  assert.ok(cache.get('churcha1', 'elvanto'));
  assert.ok(cache.get('churchb2', 'planning_center'));
});
