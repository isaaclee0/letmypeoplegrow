'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { listPlanningCenterSources, fetchPlanningCenterSourceSnapshot } = require('./sourceAdapter');

const API = 'https://api.planningcenteronline.com/people/v2';
const response = (status, data, headers) => ({ status, data, headers });

function person(id, { firstName = 'Ada', lastName = 'Lovelace', householdId = 'h1', fieldDataIds = [] } = {}) {
  return {
    type: 'Person', id,
    attributes: { first_name: firstName, last_name: lastName, status: 'active', membership: 'Member', child: false },
    relationships: {
      households: { data: householdId ? [{ type: 'Household', id: householdId }] : [] },
      field_data: { data: fieldDataIds.map((fieldDataId) => ({ type: 'FieldDatum', id: fieldDataId })) },
    },
  };
}

test('enumerates visible Planning Center Lists by stable ID with defensive sorted DTO mapping', async () => {
  const calls = [];
  const sources = await listPlanningCenterSources({
    accessToken: 'secret',
    request: async (request) => {
      calls.push(request);
      return response(200, { data: [
        { type: 'List', id: '20', attributes: { name: '  Zebra  ', result_count: 8.4, refreshed_at: 'not-a-date' } },
        { type: 'List', id: '10', attributes: { name: ' Alpha ', result_count: 3, refreshed_at: '2026-07-29T00:00:00.000Z' } },
        { type: 'Person', id: '30', attributes: { name: 'Ignored', result_count: 1 } },
      ], links: { next: null } });
    },
  });

  assert.deepEqual(sources, [
    { kind: 'planning_center_list', externalId: '10', name: 'Alpha', memberCount: 3, providerRefreshedAt: '2026-07-29T00:00:00.000Z' },
    { kind: 'planning_center_list', externalId: '20', name: 'Zebra', memberCount: null, providerRefreshedAt: null },
  ]);
  assert.equal(calls[0].url, `${API}/lists?per_page=100`);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('fetches every List member page while keeping household-only context separate', async () => {
  const calls = [];
  const pages = new Map([
    [`${API}/lists/42`, response(200, { data: {
      type: 'List', id: '42', attributes: { name: ' Sunday Team ', result_count: 2, refreshed_at: '2026-07-29T01:02:03.000Z' },
    } })],
    [`${API}/lists/42/people?per_page=100&include=households,field_data`, response(200, {
      data: [person('p1', { fieldDataIds: ['fd1'] })],
      included: [
        { type: 'FieldDatum', id: 'fd1', attributes: { value: 'Soprano' }, relationships: { field_definition: { data: { id: 'choir' } } } },
        { type: 'Household', id: 'h1', attributes: { primary_contact_id: 'p1' } },
        person('p2', { firstName: 'Grace', lastName: 'Hopper', fieldDataIds: ['fd2'] }),
        { type: 'FieldDatum', id: 'fd2', attributes: { value: 'Context value' }, relationships: { field_definition: { data: { id: 'context-field' } } } },
      ],
      links: { next: 'https://next.example/list-42-members' },
    })],
    ['https://next.example/list-42-members', response(200, {
      data: [person('p3', { firstName: 'Lin', lastName: 'Q', householdId: 'h2' })],
      included: [{ type: 'Household', id: 'h2', attributes: { primary_contact_id: 'p3' } }],
      links: { next: null },
    })],
  ]);
  const snapshot = await fetchPlanningCenterSourceSnapshot({
    accessToken: 'secret', sourceKind: 'planning_center_list', sourceExternalId: '42',
    request: async (request) => {
      calls.push(request);
      return pages.get(request.url);
    },
  });

  assert.deepEqual(snapshot.source, {
    kind: 'planning_center_list', externalId: '42', name: 'Sunday Team', memberCount: 2,
    providerRefreshedAt: '2026-07-29T01:02:03.000Z',
  });
  assert.equal(snapshot.complete, true);
  assert.equal(typeof snapshot.fetchedAt, 'string');
  assert.deepEqual(snapshot.memberExternalIds, ['p1', 'p3']);
  assert.deepEqual(snapshot.people.map((member) => member.id), ['p1', 'p3']);
  assert.deepEqual(snapshot.contextPeople.map((member) => member.id), ['p2']);
  assert.equal(snapshot.people[0].attributes.fieldValues.choir[0], 'Soprano');
  assert.equal(snapshot.contextPeople[0].attributes.fieldValues['context-field'][0], 'Context value');
  assert.deepEqual(snapshot.families, [
    { id: 'h1', memberExternalIds: ['p1', 'p2'], primaryContactExternalId: 'p1' },
    { id: 'h2', memberExternalIds: ['p3'], primaryContactExternalId: 'p3' },
  ]);
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.ok(calls.every((call) => !call.url.includes('/run')));
  assert.deepEqual(calls.map((call) => call.url), [
    `${API}/lists/42`,
    `${API}/lists/42/people?per_page=100&include=households,field_data`,
    'https://next.example/list-42-members',
  ]);
});

test('fails closed when List resolution is absent, archived, inaccessible, or not a List', async () => {
  for (const resolution of [
    response(404, { data: null }),
    response(200, { data: { type: 'List', id: '42', attributes: { name: 'Old', archived: true } } }),
    response(200, { data: { type: 'List', id: '42', attributes: { name: 'Archived date', archived_at: '2026-07-01T00:00:00.000Z' } } }),
    response(200, { data: { type: 'Person', id: '42', attributes: { name: 'Wrong' } } }),
  ]) {
    await assert.rejects(
      () => fetchPlanningCenterSourceSnapshot({
        accessToken: 'secret', sourceKind: 'planning_center_list', sourceExternalId: '42',
        request: async () => resolution,
      }),
      (err) => err.code === 'SYNC_SOURCE_UNAVAILABLE'
    );
  }
  await assert.rejects(
    () => fetchPlanningCenterSourceSnapshot({
      accessToken: 'secret', sourceKind: 'planning_center_list', sourceExternalId: '42',
      request: async () => response(403, { data: null }),
    }),
    (err) => err.code === 'SYNC_SOURCE_UNAVAILABLE'
  );
});
