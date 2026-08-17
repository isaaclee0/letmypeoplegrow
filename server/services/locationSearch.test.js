'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLocationSearchService } = require('./locationSearch');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

function openMeteoHobart() {
  return {
    results: [{
      name: 'Hobart',
      admin1: 'Tasmania',
      country: 'Australia',
      country_code: 'AU',
      latitude: -42.87936,
      longitude: 147.3294,
      timezone: 'Australia/Hobart',
      population: 252639,
    }],
  };
}

function geoapifyHobart() {
  return {
    results: [{
      name: 'Hobart',
      state: 'Tasmania',
      country: 'Australia',
      country_code: 'au',
      lat: -42.8825088,
      lon: 147.3281233,
      result_type: 'city',
    }],
  };
}

test('returns normalized Open-Meteo results including population without using fallback', async () => {
  const urls = [];
  const service = createLocationSearchService({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return response(200, openMeteoHobart());
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
  });

  assert.deepEqual(await service.search('Hobart'), [{
    name: 'Hobart',
    admin1: 'Tasmania',
    country: 'Australia',
    countryCode: 'AU',
    lat: -42.87936,
    lng: 147.3294,
    timezone: 'Australia/Hobart',
    population: 252639,
    source: 'open-meteo',
    displayName: 'Hobart, Tasmania, Australia',
  }]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?/);
});

test('treats a valid empty Open-Meteo response as authoritative', async () => {
  let calls = 0;
  const service = createLocationSearchService({
    fetchImpl: async () => {
      calls += 1;
      return response(200, {});
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
  });

  assert.deepEqual(await service.search('No such city'), []);
  assert.equal(calls, 1);
});

test('falls back to Geoapify and normalizes its city result when Open-Meteo fails', async () => {
  const service = createLocationSearchService({
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) {
        throw new Error('connect ETIMEDOUT');
      }
      return response(200, geoapifyHobart());
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
  });

  assert.deepEqual(await service.search('Hobart'), [{
    name: 'Hobart',
    admin1: 'Tasmania',
    country: 'Australia',
    countryCode: 'AU',
    lat: -42.8825088,
    lng: 147.3281233,
    timezone: null,
    population: null,
    source: 'geoapify',
    displayName: 'Hobart, Tasmania, Australia',
  }]);
});

for (const [label, primaryResponse] of [
  ['rate limit', response(429, { message: 'rate limited' })],
  ['server error', response(500, { message: 'unavailable' })],
  ['malformed response', response(200, 'not an object')],
]) {
  test(`falls back after an Open-Meteo ${label}`, async () => {
    let calls = 0;
    const service = createLocationSearchService({
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? primaryResponse : response(200, geoapifyHobart());
      },
      getGeoapifyApiKey: () => 'fallback-secret',
      logger: silentLogger(),
    });

    const results = await service.search('Hobart');
    assert.equal(results[0].source, 'geoapify');
    assert.equal(calls, 2);
  });
}

test('filters malformed Geoapify places rather than leaking unusable coordinates', async () => {
  let calls = 0;
  const service = createLocationSearchService({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('primary unavailable');
      return response(200, {
        results: [
          { name: '', state: 'Tasmania', country: 'Australia', country_code: 'au', lat: -42, lon: 147 },
          { name: 'Beyond', state: null, country: 'Australia', country_code: 'au', lat: -142, lon: 247 },
          ...geoapifyHobart().results,
        ],
      });
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
  });

  const results = await service.search('Hobart');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Hobart');
});

test('reports provider unavailability when fallback is not configured', async () => {
  const service = createLocationSearchService({
    fetchImpl: async () => { throw new Error('primary unavailable'); },
    getGeoapifyApiKey: () => '',
    logger: silentLogger(),
  });

  await assert.rejects(service.search('Hobart'), /Geoapify fallback is not configured/);
});

test('aborts a hanging Open-Meteo request at its deadline and falls back', async () => {
  const service = createLocationSearchService({
    fetchImpl: async (url, options = {}) => {
      if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) {
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')));
        });
      }
      return response(200, geoapifyHobart());
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
    primaryTimeoutMs: 5,
    fallbackTimeoutMs: 50,
  });

  const results = await Promise.race([
    service.search('Hobart'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('test watchdog elapsed')), 100)),
  ]);
  assert.equal(results[0].source, 'geoapify');
});

test('skips Open-Meteo during cooldown and retries it after cooldown expires', async () => {
  let now = 1_000;
  let primaryCalls = 0;
  let primaryHealthy = false;
  const service = createLocationSearchService({
    now: () => now,
    cacheTtlMs: 0,
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) {
        primaryCalls += 1;
        if (!primaryHealthy) throw new Error('connect ETIMEDOUT');
        return response(200, { results: [] });
      }
      return response(200, { results: [] });
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
    cooldownMs: 300_000,
  });

  await service.search('Hobart');
  await service.search('Launceston');
  assert.equal(primaryCalls, 1);

  now += 300_001;
  primaryHealthy = true;
  await service.search('Devonport');
  assert.equal(primaryCalls, 2);
});

test('shares one in-flight provider operation for identical normalized queries', async () => {
  const resolveRequests = [];
  let calls = 0;
  const service = createLocationSearchService({
    fetchImpl: async () => {
      calls += 1;
      return new Promise((resolve) => { resolveRequests.push(resolve); });
    },
    logger: silentLogger(),
  });

  const first = service.search('  Hobart ');
  const second = service.search('hobart');
  resolveRequests.forEach((resolve) => resolve(response(200, { results: [] })));

  assert.deepEqual(await Promise.all([first, second]), [[], []]);
  assert.equal(calls, 1);
});

test('serves cached results until TTL expiry', async () => {
  let now = 1_000;
  let calls = 0;
  const service = createLocationSearchService({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return response(200, openMeteoHobart());
    },
    logger: silentLogger(),
    cacheTtlMs: 600_000,
  });

  await service.search('Hobart');
  await service.search(' hobart ');
  assert.equal(calls, 1);

  now += 600_001;
  await service.search('HOBART');
  assert.equal(calls, 2);
});

test('evicts the oldest cached query when the cache reaches its bound', async () => {
  let calls = 0;
  const service = createLocationSearchService({
    fetchImpl: async () => {
      calls += 1;
      return response(200, { results: [] });
    },
    logger: silentLogger(),
    cacheMaxEntries: 2,
  });

  await service.search('Hobart');
  await service.search('Launceston');
  await service.search('Hobart');
  await service.search('Devonport');
  await service.search('Hobart');

  assert.equal(calls, 4);
});

test('removes a rejected in-flight request so a later search can retry', async () => {
  let calls = 0;
  const service = createLocationSearchService({
    fetchImpl: async () => {
      calls += 1;
      if (calls <= 2) throw new Error('provider unavailable');
      return response(200, { results: [] });
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
    cooldownMs: 0,
  });

  await assert.rejects(service.search('Hobart'), /providers are unavailable/);
  assert.deepEqual(await service.search('Hobart'), []);
  assert.equal(calls, 3);
});

test('never includes the Geoapify key in provider failure logs or errors', async () => {
  const logged = [];
  const service = createLocationSearchService({
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) throw new Error('primary unavailable');
      return response(500, { message: 'fallback unavailable' });
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: { info() {}, warn(message, metadata) { logged.push({ message, metadata }); }, error() {} },
  });

  await assert.rejects(service.search('Hobart'), (error) => {
    assert.doesNotMatch(error.message, /fallback-secret/);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(logged), /fallback-secret/);
});

test('classifies malformed provider data separately from network failures', async () => {
  const logged = [];
  let calls = 0;
  const service = createLocationSearchService({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response(200, 'invalid') : response(200, geoapifyHobart());
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: { info() {}, warn(message, metadata) { logged.push({ message, metadata }); }, error() {} },
  });

  await service.search('Hobart');
  assert.equal(logged[0].metadata.category, 'invalid-response');
});
