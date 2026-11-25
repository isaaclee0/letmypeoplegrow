'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchPlanningCenterLinkedSnapshot } = require('./sourceAdapter');

const API = 'https://api.planningcenteronline.com/people/v2';
const person = (id, status = 'active') => ({
  type: 'Person', id,
  attributes: { first_name: 'Test', last_name: id, status, child: false },
  relationships: { households: { data: [{ type: 'Household', id: 'household' }] } },
});

test('reads each linked ID directly, retaining inactive status and separating household context', async () => {
  const requests = [];
  const snapshot = await fetchPlanningCenterLinkedSnapshot({
    accessToken: 'token', externalPersonIds: ['inactive', 'active', 'inactive'],
    request: async ({ url, method }) => {
      requests.push({ url, method });
      const id = new URL(url).pathname.split('/').pop();
      return { status: 200, data: {
        data: person(id, id === 'inactive' ? 'inactive' : 'active'),
        included: [person('relative'), person('inactive', 'inactive'), {
          type: 'Household', id: 'household', attributes: { name: 'Test household' },
          relationships: { people: { data: ['active', 'inactive', 'relative'].map(id => ({ type: 'Person', id })) } },
        }],
      } };
    },
  });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.provider, 'planning_center');
  assert.deepEqual(snapshot.people.map(({ id, state }) => ({ id, state })), [
    { id: 'active', state: 'active' }, { id: 'inactive', state: 'archived' },
  ]);
  assert.deepEqual(snapshot.contextPeople.map(({ id }) => id), ['relative']);
  assert.deepEqual(snapshot.families[0].memberExternalIds, ['active', 'inactive', 'relative']);
  assert.equal(snapshot.memberExternalIds, undefined, 'linked reads must not claim list membership');
  assert.deepEqual(requests, ['active', 'inactive'].map(id => ({
    url: `${API}/people/${id}?include=households.people,field_data`, method: 'GET',
  })));
});

for (const [label, response, code] of [
  ['missing person', { status: 404, data: {} }, 'SYNC_SOURCE_UNAVAILABLE'],
  ['wrong ID', { status: 200, data: { data: person('wrong') } }, 'SYNC_SOURCE_INCOMPLETE'],
  ['collection response', { status: 200, data: { data: [person('wanted')] } }, 'SYNC_SOURCE_INCOMPLETE'],
  ['missing status', { status: 200, data: { data: { ...person('wanted'), attributes: { first_name: 'Test' } } } }, 'SYNC_SOURCE_INCOMPLETE'],
  ['missing age flag', { status: 200, data: { data: { ...person('wanted'), attributes: { first_name: 'Test', last_name: 'Person', status: 'active' } } } }, 'SYNC_SOURCE_INCOMPLETE'],
  ['missing household roster', { status: 200, data: { data: person('wanted') } }, 'SYNC_SOURCE_INCOMPLETE'],
  ['partial household roster', { status: 200, data: { data: person('wanted'), included: [{
    type: 'Household', id: 'household', attributes: { member_count: 2 },
    relationships: { people: { data: [{ type: 'Person', id: 'wanted' }] } },
  }] } }, 'SYNC_SOURCE_INCOMPLETE'],
]) {
  test(`linked snapshot fails closed for ${label}`, async () => {
    await assert.rejects(() => fetchPlanningCenterLinkedSnapshot({
      externalPersonIds: ['wanted'], request: async () => response,
    }), { code });
  });
}

test('linked reads honour quota retry and stop before an aborted request', async () => {
  let attempts = 0;
  const waits = [];
  const snapshot = await fetchPlanningCenterLinkedSnapshot({
    externalPersonIds: ['wanted'], sleep: async duration => waits.push(duration),
    request: async () => ++attempts === 1
      ? { status: 429, headers: { 'Retry-After': '2' } }
      : { status: 200, data: { data: { ...person('wanted'), relationships: { households: { data: [] } } } } },
  });
  assert.equal(snapshot.people.length, 1);
  assert.deepEqual(waits, [2000]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => fetchPlanningCenterLinkedSnapshot({
    externalPersonIds: ['wanted'], signal: controller.signal,
    request: async () => { throw new Error('must not request'); },
  }), { name: 'AbortError' });
});

for (const conflict of ['household name', 'household roster', 'context membership', 'direct membership', 'lifecycle']) {
  test(`rejects conflicting ${conflict} observations across linked reads`, async () => {
    let calls = 0;
    await assert.rejects(() => fetchPlanningCenterLinkedSnapshot({
      externalPersonIds: ['one', 'two'], request: async () => {
        calls++;
        const household = { type: 'Household', id: 'household', attributes: { name: calls === 2 && conflict === 'household name' ? 'Changed' : 'Original' },
          relationships: { people: { data: (calls === 2 && conflict === 'household roster' ? ['one', 'two', 'new'] : ['one', 'two'])
            .map(id => ({ type: 'Person', id })) } } };
        const context = person(conflict === 'direct membership' ? 'one' : 'context');
        if (conflict === 'lifecycle') { context.id = 'one'; context.attributes.status = calls === 2 ? 'inactive' : 'active'; }
        if (calls === 2 && (conflict === 'context membership' || conflict === 'direct membership')) {
          context.relationships.households.data = [{ type: 'Household', id: 'changed' }];
        }
        return { status: 200, data: { data: person(calls === 1 ? 'one' : 'two'), included: [household, context] } };
      },
    }), { code: 'SYNC_SOURCE_INCOMPLETE' });
    assert.equal(calls, 2, 'the disagreement is detected across two provider reads');
  });
}

test('rejects conflicting linked lifecycle states within a single response', async () => {
  await assert.rejects(() => fetchPlanningCenterLinkedSnapshot({
    externalPersonIds: ['wanted'], request: async () => ({ status: 200, data: {
      data: { ...person('wanted', 'inactive'), relationships: { households: { data: [] } } },
      included: [{ ...person('wanted', 'active'), relationships: { households: { data: [] } } }],
    } }),
  }), { code: 'SYNC_SOURCE_INCOMPLETE' });
});

test('does not wait or retry when cancellation arrives with a rate-limited response', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(() => fetchPlanningCenterLinkedSnapshot({
    signal: controller.signal, externalPersonIds: ['wanted'],
    sleep: async () => { throw new Error('must not wait'); },
    request: async () => { calls++; controller.abort(); return { status: 429, headers: { 'Retry-After': '120' } }; },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('cancels a quota wait promptly without continuing to another linked person', async () => {
  const controller = new AbortController();
  let calls = 0;
  const read = fetchPlanningCenterLinkedSnapshot({
    signal: controller.signal, externalPersonIds: ['one', 'two'],
    request: async () => {
      calls++;
      setImmediate(() => controller.abort());
      return { status: 200, headers: { 'X-PCO-API-Request-Rate-Limit': '100', 'X-PCO-API-Request-Rate-Count': '99', 'X-PCO-API-Request-Rate-Period': '120' }, data: { data: person('one') } };
    },
  });
  await assert.rejects(read, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('an empty set of linked IDs performs no provider requests', async () => {
  const snapshot = await fetchPlanningCenterLinkedSnapshot({
    externalPersonIds: [], request: async () => { throw new Error('must not request'); },
  });
  assert.deepEqual(snapshot.people, []);
  assert.equal(snapshot.complete, true);
});

const withoutHousehold = id => ({ ...person(id), relationships: { households: { data: [] } } });
const manyLinkedIds = Array.from({ length: 101 }, (_, index) => `linked-${index}`);

test('large linked reads use complete directory pagination and directly resolve IDs missing from it', async () => {
  const requests = [];
  const snapshot = await fetchPlanningCenterLinkedSnapshot({
    externalPersonIds: manyLinkedIds,
    request: async ({ url }) => {
      requests.push(url);
      if (url.includes('/people/linked-100?')) return { status: 200, data: {
        data: { ...withoutHousehold('linked-100'), attributes: { ...person('linked-100').attributes, status: 'inactive' } },
      } };
      assert.equal(new URL(url).pathname, '/people/v2/people');
      if (new URL(url).searchParams.has('offset')) return { status: 200, data: {
        data: manyLinkedIds.slice(50, 100).map(withoutHousehold),
      } };
      return { status: 200, data: {
        data: [...manyLinkedIds.slice(0, 50).map(withoutHousehold), withoutHousehold('unrelated')],
        included: [person('unrelated-relative'), { type: 'Household', id: 'household', attributes: { name: 'Unrelated' } }],
        links: { next: `${API}/people?offset=50&include=households.people,field_data` },
      } };
    },
  });
  assert.equal(requests.length, 3, 'read pages instead of making one request per linked person');
  assert.deepEqual(snapshot.people.map(p => p.id), [...manyLinkedIds].sort());
  assert.equal(snapshot.people.find(p => p.id === 'linked-100').state, 'archived');
  assert.deepEqual(snapshot.contextPeople, []);
  assert.deepEqual(snapshot.families, []);
  assert.equal(snapshot.memberExternalIds, undefined);
});

for (const failure of ['incomplete record', 'missing record', 'failed later page', 'conflicting record']) {
  test(`large linked reads fail closed for ${failure}`, async () => {
    await assert.rejects(() => fetchPlanningCenterLinkedSnapshot({
      externalPersonIds: manyLinkedIds,
      request: async ({ url }) => {
        if (new URL(url).pathname !== '/people/v2/people') return { status: 404, data: {} };
        if (new URL(url).searchParams.has('offset')) {
          if (failure === 'failed later page') return { status: 503, data: {} };
          return { status: 200, data: { data: [{ ...withoutHousehold('linked-0'), attributes: { ...person('linked-0').attributes, status: 'inactive' } }] } };
        }
        const data = manyLinkedIds.map(withoutHousehold);
        if (failure === 'incomplete record') delete data[0].attributes.child;
        if (failure === 'missing record') data.pop();
        return { status: 200, data: { data, ...(['failed later page', 'conflicting record'].includes(failure)
          ? { links: { next: `${API}/people?offset=100` } } : {}) } };
      },
    }), { code: failure === 'missing record' ? 'SYNC_SOURCE_UNAVAILABLE'
      : failure === 'failed later page' ? 'SYNC_SOURCE_CHECK_FAILED' : 'SYNC_SOURCE_INCOMPLETE' });
  });
}

test('large reads retain household display relatives without inventing unknown memberships', async () => {
  const relative = person('relative');
  delete relative.relationships;
  const snapshot = await fetchPlanningCenterLinkedSnapshot({
    externalPersonIds: manyLinkedIds,
    request: async () => ({ status: 200, data: {
      data: manyLinkedIds.map(id => id === 'linked-0' ? person(id) : withoutHousehold(id)),
      included: [relative, {
        type: 'Household', id: 'household', attributes: { name: 'Linked household' },
        relationships: { people: { data: ['linked-0', 'relative'].map(id => ({ type: 'Person', id })) } },
      }],
    } }),
  });
  assert.deepEqual(snapshot.contextPeople.map(p => ({ id: p.id, householdIds: p.householdIds })), [
    { id: 'relative', householdIds: null },
  ]);
  assert.deepEqual(snapshot.families[0].memberExternalIds, ['linked-0']);
  assert.deepEqual(snapshot.families[0].householdMemberExternalIds, ['linked-0', 'relative']);
});
