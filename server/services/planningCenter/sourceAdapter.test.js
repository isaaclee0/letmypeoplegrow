'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { listPlanningCenterSources, fetchPlanningCenterSourceSnapshot, fetchPlanningCenterAllSnapshot } = require('./sourceAdapter');
const { buildReviewDirectory } = require('../peopleSync/reviewContext');

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
        { type: 'List', id: '20', attributes: { name: '  Zebra  ', total_people: 8.4, refreshed_at: 'not-a-date', invalid: false } },
        { type: 'List', id: '10', attributes: { name: ' Alpha ', total_people: 3, refreshed_at: '2026-07-29T00:00:00.000Z', invalid: false } },
        { type: 'List', id: '11', attributes: { name: 'Broken rules', total_people: 99, invalid: true } },
        { type: 'Person', id: '30', attributes: { name: 'Ignored', total_people: 1 } },
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
      type: 'List', id: '42', attributes: { name: ' Sunday Team ', total_people: 2, refreshed_at: '2026-07-29T01:02:03.000Z', invalid: false },
    } })],
    [`${API}/lists/42/people?per_page=100&include=households.people,field_data`, response(200, {
      data: [person('p1', { fieldDataIds: ['fd1'] })],
      included: [
        { type: 'FieldDatum', id: 'fd1', attributes: { value: 'Soprano' }, relationships: { field_definition: { data: { id: 'choir' } } } },
        { type: 'Household', id: 'h1', attributes: {
          name: 'Lovelace Household', primary_contact_id: 'p1', contact_email: 'hidden@example.test',
        } },
        person('p2', { firstName: 'Grace', lastName: 'Hopper', fieldDataIds: ['fd2'] }),
        { type: 'FieldDatum', id: 'fd2', attributes: { value: 'Context value' }, relationships: { field_definition: { data: { id: 'context-field' } } } },
      ],
      links: { next: 'https://api.planningcenteronline.com/people/v2/lists/42/people?page=2' },
    })],
    ['https://api.planningcenteronline.com/people/v2/lists/42/people?page=2', response(200, {
      data: [person('p3', { firstName: 'Lin', lastName: 'Q', householdId: 'h2' })],
      included: [{ type: 'Household', id: 'h2', attributes: { name: 'Q Household', primary_contact_id: 'p3' } }],
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
    { id: 'h1', name: 'Lovelace Household', memberExternalIds: ['p1', 'p2'], primaryContactExternalId: 'p1' },
    { id: 'h2', name: 'Q Household', memberExternalIds: ['p3'], primaryContactExternalId: 'p3' },
  ]);
  const directory = buildReviewDirectory({
    externalPeople: [...snapshot.people, ...snapshot.contextPeople],
    externalFamilies: snapshot.families,
  });
  assert.deepEqual(directory.external.p1.family, {
    state: 'known', name: 'Lovelace Household',
    members: [{ firstName: 'Grace', lastName: 'Hopper' }], totalOtherMembers: 1,
  });
  assert.equal(JSON.stringify(directory).includes('hidden@example.test'), false);
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.ok(calls.every((call) => !call.url.includes('/run')));
  assert.deepEqual(calls.map((call) => call.url), [
    `${API}/lists/42`,
    `${API}/lists/42/people?per_page=100&include=households.people,field_data`,
    'https://api.planningcenteronline.com/people/v2/lists/42/people?page=2',
  ]);
});

test('fetches every Planning Center person page as one normalized all-people snapshot', async () => {
  const calls = [];
  const allPeopleUrl = `${API}/people?per_page=100&include=households.people,field_data`;
  const snapshot = await fetchPlanningCenterAllSnapshot({
    accessToken: 'secret',
    request: async ({ url, method }) => {
      calls.push({ url, method });
      if (url === allPeopleUrl) return response(200, {
        data: [person('p1', { fieldDataIds: ['fd1'] })],
        included: [
          { type: 'FieldDatum', id: 'fd1', attributes: { value: 'Soprano' }, relationships: { field_definition: { data: { id: 'choir' } } } },
          { type: 'Household', id: 'h1', attributes: { name: 'Lovelace Household', primary_contact_id: 'p1' } },
        ],
        links: { next: `${API}/people?page=2&per_page=100&include=households.people,field_data` },
      });
      if (url === `${API}/people?page=2&per_page=100&include=households.people,field_data`) return response(200, {
        data: [person('p2', { firstName: 'Grace', lastName: 'Hopper' })],
        included: [{ type: 'Household', id: 'h1', attributes: { name: 'Lovelace Household', primary_contact_id: 'p1' } }],
        links: { next: null },
      });
      return undefined;
    },
  });

  assert.deepEqual(snapshot.source, {
    kind: 'all', externalId: 'all', name: 'Everyone', memberCount: 2, providerRefreshedAt: null,
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.memberExternalIds, ['p1', 'p2']);
  assert.deepEqual(snapshot.people.map((member) => member.id), ['p1', 'p2']);
  assert.equal(snapshot.people[0].attributes.fieldValues.choir[0], 'Soprano');
  assert.deepEqual(snapshot.families, [
    { id: 'h1', name: 'Lovelace Household', memberExternalIds: ['p1', 'p2'], primaryContactExternalId: 'p1' },
  ]);
  assert.deepEqual(calls.map((call) => call.url), [
    allPeopleUrl,
    `${API}/people?page=2&per_page=100&include=households.people,field_data`,
  ]);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('fails closed instead of returning accumulated people when an all-people page is malformed', async () => {
  await assert.rejects(
    () => fetchPlanningCenterAllSnapshot({
      accessToken: 'secret',
      request: async () => response(200, {
        data: [{ type: 'Person', id: 'p1', attributes: {} }, { type: 'Household', id: 'h1', attributes: {} }],
        links: { next: null },
      }),
    }),
    (error) => error.code === 'SYNC_SOURCE_INCOMPLETE'
  );
});

test('fails closed when List resolution is absent, invalid, archived, or not a List', async () => {
  for (const resolution of [
    response(404, { data: null }),
    response(200, { data: { type: 'List', id: '42', attributes: { name: 'Invalid rules', invalid: true } } }),
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
});

test('distinguishes account-wide List-enumeration 403s from source-specific membership 403s', async () => {
  await assert.rejects(
    () => listPlanningCenterSources({
      accessToken: 'secret', request: async () => response(403, { data: null }),
    }),
    (err) => err.code === 'SYNC_SOURCE_AUTH'
  );

  const sourceUrl = `${API}/lists/42`;
  const membersUrl = `${API}/lists/42/people?per_page=100&include=households.people,field_data`;
  await assert.rejects(
    () => fetchPlanningCenterSourceSnapshot({
      accessToken: 'secret', sourceKind: 'planning_center_list', sourceExternalId: '42',
      request: async ({ url }) => url === sourceUrl
        ? response(200, { data: { type: 'List', id: '42', attributes: { name: 'Sunday' } } })
        : url === membersUrl ? response(403, { data: null }) : undefined,
    }),
    (err) => err.code === 'SYNC_SOURCE_UNAVAILABLE'
  );
});

test('fails closed when a List-membership page contains a non-Person or ID-less resource', async () => {
  const sourceUrl = `${API}/lists/42`;
  const membersUrl = `${API}/lists/42/people?per_page=100&include=households.people,field_data`;
  for (const member of [
    { type: 'Household', id: 'h1', attributes: {} },
    { type: 'Person', attributes: {} },
    { type: 'Person', id: '   ', attributes: {} },
  ]) {
    await assert.rejects(
      () => fetchPlanningCenterSourceSnapshot({
        accessToken: 'secret', sourceKind: 'planning_center_list', sourceExternalId: '42',
        request: async ({ url }) => url === sourceUrl
          ? response(200, { data: { type: 'List', id: '42', attributes: { name: 'Sunday' } } })
          : url === membersUrl ? response(200, { data: [member], links: { next: null } }) : undefined,
      }),
      (err) => err.code === 'SYNC_SOURCE_INCOMPLETE'
    );
  }
});
