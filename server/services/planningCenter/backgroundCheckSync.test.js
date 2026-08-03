'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchBackgroundCheckSnapshot } = require('./backgroundCheckSync');

const API = 'https://api.planningcenteronline.com/people/v2';
const response = (status, data, headers = {}) => ({ status, data, headers });

test('fetchBackgroundCheckSnapshot reads every People page without includes', async () => {
  const calls = [];
  const pages = new Map([
    [`${API}/people?per_page=100`, response(200, {
      data: [
        { type: 'Person', id: 'p2', attributes: { passed_background_check: false } },
        { type: 'Person', id: 'p1', attributes: { passed_background_check: true } },
      ],
      links: { next: `${API}/people?page=2` },
    })],
    [`${API}/people?page=2`, response(200, {
      data: [
        { type: 'Person', id: 'p3', attributes: {} },
      ],
      links: { next: null },
    })],
  ]);

  const snapshot = await fetchBackgroundCheckSnapshot({
    accessToken: 'secret',
    request: async (request) => {
      calls.push(request);
      return pages.get(request.url);
    },
    now: () => new Date('2026-08-03T05:00:00.000Z'),
  });

  assert.deepEqual(snapshot, {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [
      { id: 'p1', passedBackgroundCheck: true },
      { id: 'p2', passedBackgroundCheck: false },
      { id: 'p3', passedBackgroundCheck: null },
    ],
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    `${API}/people?per_page=100`,
    `${API}/people?page=2`,
  ]);
  assert.ok(calls.every(({ url }) => !url.includes('include=')));
  assert.ok(calls.every(({ method }) => method === 'GET'));
});

test('fetchBackgroundCheckSnapshot rejects malformed Person resources', async () => {
  for (const resource of [
    { type: 'Household', id: 'h1', attributes: {} },
    { type: 'Person', attributes: {} },
    { type: 'Person', id: '   ', attributes: {} },
  ]) {
    await assert.rejects(
      fetchBackgroundCheckSnapshot({
        accessToken: 'secret',
        request: async () => response(200, { data: [resource], links: { next: null } }),
      }),
      (error) => error.code === 'SYNC_SOURCE_INCOMPLETE'
    );
  }
});
