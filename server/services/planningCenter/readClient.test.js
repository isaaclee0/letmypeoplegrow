'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPcoReadClient } = require('./readClient');

function response(status, data, headers = {}) {
  return { status, data, headers };
}

test('attaches bearer authorization but redacts it from transport failures', async () => {
  const token = 'super-secret-token';
  let captured;
  const client = createPcoReadClient({
    accessToken: token,
    request: async (request) => {
      captured = request;
      throw new Error(`upstream echoed Bearer ${token}`);
    },
  });

  await assert.rejects(
    () => client.getJson('https://api.planningcenteronline.com/people/v2/lists'),
    (err) => err.code === 'SYNC_SOURCE_UNAVAILABLE' &&
      !err.message.includes(token) &&
      !JSON.stringify(err.details || {}).includes(token)
  );
  assert.equal(captured.method, 'GET');
  assert.equal(captured.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(Object.getOwnPropertyNames(client).sort(), ['getAll', 'getJson']);
  assert.equal(Object.isFrozen(client), true);
});

test('getAll starts at per_page 100 and follows next links strictly sequentially', async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pages = new Map([
    ['https://api.planningcenteronline.com/people/v2/lists?per_page=100', response(200, {
      data: [{ id: '1' }], links: { next: 'https://api.planningcenteronline.com/people/v2/lists?page=2' },
    })],
    ['https://api.planningcenteronline.com/people/v2/lists?page=2', response(200, { data: [{ id: '2' }], links: { next: null } })],
  ]);
  const client = createPcoReadClient({
    accessToken: 'token',
    request: async ({ url, method }) => {
      calls.push({ url, method });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return pages.get(url);
    },
  });

  const result = await client.getAll('https://api.planningcenteronline.com/people/v2/lists');
  assert.deepEqual(result.items, [{ id: '1' }, { id: '2' }]);
  assert.equal(result.pages, 2);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.planningcenteronline.com/people/v2/lists?per_page=100',
    'https://api.planningcenteronline.com/people/v2/lists?page=2',
  ]);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('getAll rejects repeated or excessive next links as an incomplete source', async () => {
  const repeated = createPcoReadClient({
    accessToken: 'token',
    request: async ({ url }) => response(200, { data: [], links: { next: url } }),
  });
  await assert.rejects(
    () => repeated.getAll('https://api.planningcenteronline.com/people/v2/lists'),
    (err) => err.code === 'SYNC_SOURCE_INCOMPLETE'
  );

  let page = 0;
  const tooMany = createPcoReadClient({
    accessToken: 'token',
    request: async () => {
      page += 1;
      return response(200, { data: [], links: { next: `https://api.planningcenteronline.com/people/v2/lists?page=${page}` } });
    },
  });
  await assert.rejects(
    () => tooMany.getAll('https://api.planningcenteronline.com/people/v2/lists'),
    (err) => err.code === 'SYNC_SOURCE_INCOMPLETE'
  );
  assert.equal(page, 1000);
});

test('429 retries honour numeric and HTTP-date Retry-After no more than three times', async () => {
  const numericSleeps = [];
  let numericAttempts = 0;
  const numeric = createPcoReadClient({
    accessToken: 'token',
    sleep: async (milliseconds) => numericSleeps.push(milliseconds),
    request: async () => {
      numericAttempts += 1;
      return numericAttempts < 4
        ? response(429, { data: [] }, { 'retry-after': '2' })
        : response(200, { data: [] });
    },
  });
  await numeric.getJson('https://api.planningcenteronline.com/people/v2/lists');
  assert.equal(numericAttempts, 4);
  assert.deepEqual(numericSleeps, [2000, 2000, 2000]);

  const dateSleeps = [];
  let dateAttempts = 0;
  const retryAt = new Date(Date.now() + 2500).toUTCString();
  const dated = createPcoReadClient({
    accessToken: 'token',
    sleep: async (milliseconds) => dateSleeps.push(milliseconds),
    request: async () => {
      dateAttempts += 1;
      return dateAttempts === 1
        ? response(429, { data: [] }, { 'Retry-After': retryAt })
        : response(200, { data: [] });
    },
  });
  await dated.getJson('https://api.planningcenteronline.com/people/v2/lists');
  assert.equal(dateAttempts, 2);
  assert.equal(dateSleeps.length, 1);
  assert.ok(dateSleeps[0] >= 0 && dateSleeps[0] <= 2500);

  const exhausted = createPcoReadClient({
    accessToken: 'token', sleep: async () => {},
    request: async () => response(429, { data: [] }, { 'Retry-After': '0' }),
  });
  await assert.rejects(
    () => exhausted.getJson('https://api.planningcenteronline.com/people/v2/lists'),
    (err) => err.code === 'SYNC_SOURCE_RATE_LIMIT'
  );
});

test('uses dynamic PCO request-rate headers to wait before quota exhaustion', async () => {
  const sleeps = [];
  const client = createPcoReadClient({
    accessToken: 'token', sleep: async (milliseconds) => sleeps.push(milliseconds),
    request: async () => response(200, { data: [] }, {
      'X-PCO-API-Request-Rate-Limit': '10',
      'X-PCO-API-Request-Rate-Period': '5',
      'X-PCO-API-Request-Rate-Count': '9',
    }),
  });
  await client.getJson('https://api.planningcenteronline.com/people/v2/lists');
  assert.deepEqual(sleeps, [5000]);
});

test('classifies auth, source unavailability, malformed envelopes, and later-page failures safely', async () => {
  for (const status of [401, 403]) {
    const client = createPcoReadClient({ accessToken: 'token', request: async () => response(status, { data: [] }) });
    await assert.rejects(() => client.getJson('https://api.planningcenteronline.com/people/v2/lists'), (err) => err.code === 'SYNC_SOURCE_AUTH');
  }
  const unavailable = createPcoReadClient({
    accessToken: 'token', requestScope: 'source',
    request: async () => response(403, { data: [] }),
  });
  await assert.rejects(() => unavailable.getJson('https://api.planningcenteronline.com/people/v2/lists/42'), (err) => err.code === 'SYNC_SOURCE_UNAVAILABLE');

  const missing = createPcoReadClient({ accessToken: 'token', request: async () => response(404, { data: [] }) });
  await assert.rejects(() => missing.getJson('https://api.planningcenteronline.com/people/v2/lists/42'), (err) => err.code === 'SYNC_SOURCE_UNAVAILABLE');

  const malformed = createPcoReadClient({ accessToken: 'token', request: async () => response(200, 'not json') });
  await assert.rejects(() => malformed.getJson('https://api.planningcenteronline.com/people/v2/lists'), (err) => err.code === 'SYNC_SOURCE_INCOMPLETE');

  let calls = 0;
  const laterFailure = createPcoReadClient({
    accessToken: 'token',
    request: async () => {
      calls += 1;
      return calls === 1
        ? response(200, { data: [{ id: 'first' }], links: { next: 'https://api.planningcenteronline.com/people/v2/lists?page=fails' } })
        : response(500, { data: [] });
    },
  });
  await assert.rejects(
    () => laterFailure.getAll('https://api.planningcenteronline.com/people/v2/lists'),
    (err) => err.code === 'SYNC_SOURCE_UNAVAILABLE'
  );
});

test('rejects hostile absolute URLs and next links before a bearer token can leave the PCO origin', async () => {
  const token = 'secret-token';
  const directCalls = [];
  const direct = createPcoReadClient({
    accessToken: token,
    request: async (request) => { directCalls.push(request); return response(200, { data: [] }); },
  });
  await assert.rejects(
    () => direct.getJson('https://attacker.example/exfiltrate'),
    (err) => err.code === 'SYNC_SOURCE_INCOMPLETE'
  );
  assert.deepEqual(directCalls, []);

  const pagedCalls = [];
  const paged = createPcoReadClient({
    accessToken: token,
    request: async (request) => {
      pagedCalls.push(request);
      return response(200, { data: [{ id: 'safe-first-page' }], links: { next: 'https://attacker.example/exfiltrate' } });
    },
  });
  await assert.rejects(
    () => paged.getAll('https://api.planningcenteronline.com/people/v2/lists'),
    (err) => err.code === 'SYNC_SOURCE_INCOMPLETE'
  );
  assert.deepEqual(pagedCalls.map((call) => call.url), ['https://api.planningcenteronline.com/people/v2/lists?per_page=100']);
  assert.ok(pagedCalls.every((call) => call.headers.Authorization === `Bearer ${token}`));
});
