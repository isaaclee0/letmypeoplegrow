# Location Search Provider Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Settings location lookup working when Open-Meteo geocoding is unreachable by failing over to the configured Geoapify API.

**Architecture:** Extract provider access from the large Settings router into a focused CommonJS service. The service normalizes both providers to the existing result contract, applies whole-request deadlines, temporarily bypasses an unhealthy primary, and bounds query caching; the existing authenticated route remains the only browser-facing boundary. The client adds optional population and source presentation without changing how a selected location is saved or how its timezone is derived.

**Tech Stack:** Node.js 22 built-in `fetch`/`AbortController`, Express 5, `node:test`, React 19, TypeScript 6, Vitest, Testing Library, Tailwind CSS.

## Global Constraints

- Open-Meteo remains primary; a valid empty Open-Meteo result is authoritative and does not trigger fallback.
- Geoapify is fallback-only and reads `GEOAPIFY_API_KEY` from the server environment.
- Do not use Photon or any other public demo geocoder.
- Provider deadlines are 3 seconds; Open-Meteo cooldown is 5 minutes.
- Successful query cache TTL is 10 minutes with at most 250 entries.
- Never log, return, or persist the Geoapify API key.
- Preserve the existing `502` body: `{ "error": "Location search is temporarily unavailable." }`.
- Preserve admin authorization, church isolation, coordinate validation, and local timezone derivation.
- No new npm dependency is required.

---

### Task 1: Provider adapters and sequential failover

**Files:**
- Create: `server/services/locationSearch.js`
- Create: `server/services/locationSearch.test.js`

**Interfaces:**
- Produces: `createLocationSearchService(options)` returning `{ search(query): Promise<LocationResult[]> }`.
- Produces: singleton facade `locationSearchService.search(query)` for the Settings route.
- `LocationResult` fields: `{ name, admin1, country, countryCode, lat, lng, timezone?, population?, source, displayName }`.

- [ ] **Step 1: Write failing primary/fallback behavior tests**

Create `server/services/locationSearch.test.js` with literal Open-Meteo and Geoapify fixtures. Mock only the external HTTP boundary by injecting `fetchImpl`; assert returned application behavior rather than the mock itself.

```js
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

test('returns normalized Open-Meteo results including population without using fallback', async () => {
  const urls = [];
  const service = createLocationSearchService({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return response(200, { results: [{
        name: 'Hobart', admin1: 'Tasmania', country: 'Australia', country_code: 'AU',
        latitude: -42.87936, longitude: 147.3294, timezone: 'Australia/Hobart', population: 252639,
      }] });
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
  });

  assert.deepEqual(await service.search('Hobart'), [{
    name: 'Hobart', admin1: 'Tasmania', country: 'Australia', countryCode: 'AU',
    lat: -42.87936, lng: 147.3294, timezone: 'Australia/Hobart', population: 252639,
    source: 'open-meteo', displayName: 'Hobart, Tasmania, Australia',
  }]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?/);
});

test('treats a valid empty Open-Meteo response as authoritative', async () => {
  let calls = 0;
  const service = createLocationSearchService({
    fetchImpl: async () => { calls += 1; return response(200, {}); },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
  });

  assert.deepEqual(await service.search('No such city'), []);
  assert.equal(calls, 1);
});

test('falls back to Geoapify and normalizes its city result when Open-Meteo fails', async () => {
  const service = createLocationSearchService({
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) throw new Error('connect ETIMEDOUT');
      return response(200, { results: [{
        name: 'Hobart', state: 'Tasmania', country: 'Australia', country_code: 'au',
        lat: -42.8825088, lon: 147.3281233, result_type: 'city',
      }] });
    },
    getGeoapifyApiKey: () => 'fallback-secret',
    logger: silentLogger(),
  });

  assert.deepEqual(await service.search('Hobart'), [{
    name: 'Hobart', admin1: 'Tasmania', country: 'Australia', countryCode: 'AU',
    lat: -42.8825088, lng: 147.3281233, timezone: null, population: null,
    source: 'geoapify', displayName: 'Hobart, Tasmania, Australia',
  }]);
});
```

Add separate cases for Open-Meteo HTTP `429`, HTTP `500`, malformed top-level JSON, and Geoapify results with missing names or out-of-range coordinates. Each must prove the wrong provider branch or invalid-result leak would fail the test.

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
cd server && node --test services/locationSearch.test.js
```

Expected: FAIL because `./locationSearch` does not exist.

- [ ] **Step 3: Implement minimal provider adapters and fallback**

Create `server/services/locationSearch.js` with these boundaries:

```js
'use strict';

const defaultLogger = require('../config/logger');

const OPEN_METEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const GEOAPIFY_URL = 'https://api.geoapify.com/v1/geocode/autocomplete';

function validCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function displayName(name, admin1, country) {
  return [name, admin1, country].filter(Boolean).join(', ');
}

function normalizeOpenMeteo(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || (body.results !== undefined && !Array.isArray(body.results))) {
    throw new Error('Open-Meteo returned an invalid response');
  }
  return (body.results || []).flatMap((item) => {
    const lat = Number(item.latitude);
    const lng = Number(item.longitude);
    if (typeof item.name !== 'string' || !item.name.trim() || !validCoordinate(lat, lng)) return [];
    const admin1 = item.admin1 || null;
    const country = item.country || null;
    return [{
      name: item.name.trim(), admin1, country, countryCode: item.country_code?.toUpperCase() || null,
      lat, lng, timezone: item.timezone || null,
      population: Number.isFinite(Number(item.population)) ? Number(item.population) : null,
      source: 'open-meteo', displayName: displayName(item.name.trim(), admin1, country),
    }];
  });
}

function normalizeGeoapify(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
    throw new Error('Geoapify returned an invalid response');
  }
  return body.results.flatMap((item) => {
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    const name = item.name || item.city || item.suburb || item.formatted;
    if (typeof name !== 'string' || !name.trim() || !validCoordinate(lat, lng)) return [];
    const admin1 = item.state || item.county || null;
    const country = item.country || null;
    return [{
      name: name.trim(), admin1, country, countryCode: item.country_code?.toUpperCase() || null,
      lat, lng, timezone: null, population: null,
      source: 'geoapify', displayName: displayName(name.trim(), admin1, country),
    }];
  });
}
```

Implement `requestJson(fetchImpl, url, timeoutMs)` with an `AbortController`, `setTimeout`, HTTP status validation, JSON parsing, and `clearTimeout` in `finally`. Build URLs with `URL`/`searchParams`, never string interpolation of the key into a loggable error. Open-Meteo parameters remain `name`, `count=8`, `language=en`, `format=json`; Geoapify uses `text`, `type=city`, `limit=8`, `format=json`, and `apiKey`.

Implement `createLocationSearchService` so `search()` calls Open-Meteo first and calls Geoapify only after a primary exception. Throw a provider-unavailable error when the fallback key is blank. Export the factory and a default facade:

```js
const defaultService = createLocationSearchService();
module.exports = {
  createLocationSearchService,
  search: (query) => defaultService.search(query),
};
```

- [ ] **Step 4: Run the service test and verify GREEN**

Run:

```bash
cd server && node --test services/locationSearch.test.js
```

Expected: all provider normalization, primary success, valid-empty, and fallback tests PASS.

- [ ] **Step 5: Commit provider failover**

```bash
git add server/services/locationSearch.js server/services/locationSearch.test.js
git commit -m "feat: add location search provider failover"
```

---

### Task 2: Deadline, cooldown, bounded cache, and in-flight sharing

**Files:**
- Modify: `server/services/locationSearch.js`
- Modify: `server/services/locationSearch.test.js`

**Interfaces:**
- Extends `createLocationSearchService` options with injectable `now`, `primaryTimeoutMs`, `fallbackTimeoutMs`, `cooldownMs`, `cacheTtlMs`, and `cacheMaxEntries`.
- Keeps the public `search(query)` signature unchanged.

- [ ] **Step 1: Write failing resilience tests**

Add tests using an injected clock and very short timeout. Use unique queries or `cacheTtlMs: 0` when testing provider call counts.

```js
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
  let resolveRequest;
  let calls = 0;
  const service = createLocationSearchService({
    fetchImpl: async () => {
      calls += 1;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
    logger: silentLogger(),
  });

  const first = service.search('  Hobart ');
  const second = service.search('hobart');
  resolveRequest(response(200, { results: [] }));
  assert.deepEqual(await Promise.all([first, second]), [[], []]);
  assert.equal(calls, 1);
});
```

Add behavior tests proving: a hanging fetch is aborted at the injected deadline and falls back; a cached result avoids provider calls until TTL expiry; inserting beyond a small injected `cacheMaxEntries` evicts the oldest query; a rejected in-flight request is removed so a later retry can run.

- [ ] **Step 2: Run the resilience tests and verify RED**

Run:

```bash
cd server && node --test --test-name-pattern='cooldown|in-flight|deadline|cache' services/locationSearch.test.js
```

Expected: FAIL because the service does not yet retain cooldown, cache, or in-flight state.

- [ ] **Step 3: Implement resilience state**

Inside each service instance, add:

```js
const cache = new Map();
const inFlight = new Map();
let primaryUnavailableUntil = 0;
```

Normalize keys with `query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')`. Cache `{ results, expiresAt }`; on access, delete expired entries. Before inserting a new key at capacity, delete `cache.keys().next().value`. Wrap uncached work in one promise stored in `inFlight`, and delete it in `finally` only if the stored promise is the same instance.

Skip Open-Meteo when `now() < primaryUnavailableUntil`. On any primary exception set `primaryUnavailableUntil = now() + cooldownMs`, log sanitized metadata, then fall back. After the cooldown, a primary success sets `primaryUnavailableUntil = 0`.

Use exact defaults from the global constraints. Keep all state inside the factory closure so tests and processes are isolated.

- [ ] **Step 4: Run all service tests and verify GREEN**

Run:

```bash
cd server && node --test services/locationSearch.test.js
```

Expected: all provider and resilience tests PASS with no unhandled rejections or timer warnings.

- [ ] **Step 5: Commit resilience behavior**

```bash
git add server/services/locationSearch.js server/services/locationSearch.test.js
git commit -m "feat: bound and cache location provider requests"
```

---

### Task 3: Settings route integration and safe configuration

**Files:**
- Modify: `server/routes/settings.js:1-10,230-289`
- Modify: `server/routes/settings.location.test.js`
- Modify: `server/.env.example`

**Interfaces:**
- Consumes: `locationSearchService.search(query)` from Task 1.
- Preserves: authenticated admin route `GET /api/settings/location-search?q=...` and its `{ results }`/`502` payloads.

- [ ] **Step 1: Rewrite route tests to fail against the old direct HTTPS implementation**

Replace `https` request stubs in `server/routes/settings.location.test.js` with a mock of the real service facade:

```js
const locationSearchService = require('../services/locationSearch');

test('location search returns normalized service results', async (t) => {
  await withTestChurchDb(async (churchId) => {
    t.mock.method(locationSearchService, 'search', async () => [{
      name: 'Hobart', admin1: 'Tasmania', country: 'Australia', countryCode: 'AU',
      lat: -42.87936, lng: 147.3294, timezone: 'Australia/Hobart', population: 252639,
      source: 'open-meteo', displayName: 'Hobart, Tasmania, Australia',
    }]);
    const app = await startApp(churchId);
    try {
      const result = await app.search('Hobart');
      assert.equal(result.status, 200);
      assert.equal(result.body.results[0].population, 252639);
      assert.equal(result.body.results[0].source, 'open-meteo');
    } finally {
      await app.close();
    }
  });
});

test('location search preserves the unavailable response when all providers fail', async (t) => {
  await withTestChurchDb(async (churchId) => {
    t.mock.method(locationSearchService, 'search', async () => { throw new Error('providers unavailable'); });
    const app = await startApp(churchId);
    try {
      const result = await app.search('Hobart');
      assert.equal(result.status, 502);
      assert.deepEqual(result.body, { error: 'Location search is temporarily unavailable.' });
    } finally {
      await app.close();
    }
  });
});
```

Retain the existing role/authentication and location-update timezone tests. Delete low-level provider tests now owned by `locationSearch.test.js`.

- [ ] **Step 2: Run the route test and verify RED**

Run:

```bash
cd server && node --test routes/settings.location.test.js
```

Expected: FAIL because the route still calls its private `httpsGet` and ignores the mocked service.

- [ ] **Step 3: Delegate the route to the service and document configuration**

In `server/routes/settings.js`, remove `const https = require('https')` and the private `httpsGet` helper. Add:

```js
const locationSearchService = require('../services/locationSearch');
```

Keep the three-character validation, then implement the route body as:

```js
const results = await locationSearchService.search(q.trim());
res.json({ results });
```

Keep the existing catch response and replace `console.error` with sanitized structured logging inside the service; the route does not print the error object because upstream URLs may contain credentials.

Add to `server/.env.example`:

```dotenv
# Managed fallback for Settings location autocomplete (optional)
# Create a server-side key at https://myprojects.geoapify.com/
GEOAPIFY_API_KEY=
```

- [ ] **Step 4: Run route and service tests and verify GREEN**

Run:

```bash
cd server && node --test services/locationSearch.test.js routes/settings.location.test.js
```

Expected: service and authenticated route tests PASS, including the unchanged timezone update test.

- [ ] **Step 5: Commit route integration**

```bash
git add server/routes/settings.js server/routes/settings.location.test.js server/.env.example
git commit -m "feat: use resilient location search in settings"
```

---

### Task 4: Population context and provider attribution

**Files:**
- Modify: `client/src/services/api.ts:235-244`
- Modify: `client/src/pages/SettingsPage.tsx:588-611`
- Modify: `client/src/pages/SettingsPage.location.test.tsx`

**Interfaces:**
- Consumes optional result fields `population: number | null` and `source: 'open-meteo' | 'geoapify'`.
- Selection continues to call `settingsAPI.updateLocation({ name: displayName, lat, lng })` only.

- [ ] **Step 1: Write failing presentation tests**

Add tests with complete result fixtures:

```tsx
it('shows formatted population and Open-Meteo attribution when supplied', async () => {
  vi.mocked(settingsAPI.searchLocation).mockResolvedValue({ data: { results: [{
    name: 'Hobart', admin1: 'Tasmania', country: 'Australia', countryCode: 'AU',
    lat: -42.87936, lng: 147.3294, timezone: 'Australia/Hobart', population: 252639,
    source: 'open-meteo', displayName: 'Hobart, Tasmania, Australia',
  }] } } as never);
  render(<SettingsPage />);

  fireEvent.change(screen.getByLabelText('Search for your city'), { target: { value: 'Hobart' } });
  await act(async () => { vi.advanceTimersByTime(301); });

  expect(screen.getByText('Population 252,639')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open-Meteo' })).toHaveAttribute('href', 'https://open-meteo.com/');
});

it('shows Geoapify and OpenStreetMap attribution without an empty population label', async () => {
  vi.mocked(settingsAPI.searchLocation).mockResolvedValue({ data: { results: [{
    name: 'Hobart', admin1: 'Tasmania', country: 'Australia', countryCode: 'AU',
    lat: -42.8825088, lng: 147.3281233, timezone: null, population: null,
    source: 'geoapify', displayName: 'Hobart, Tasmania, Australia',
  }] } } as never);
  render(<SettingsPage />);

  fireEvent.change(screen.getByLabelText('Search for your city'), { target: { value: 'Hobart' } });
  await act(async () => { vi.advanceTimersByTime(301); });

  expect(screen.queryByText(/Population/)).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Powered by Geoapify' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '© OpenStreetMap contributors' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused client test and verify RED**

Run:

```bash
cd client && npm test -- src/pages/SettingsPage.location.test.tsx
```

Expected: FAIL because the type and dropdown do not render population or attribution.

- [ ] **Step 3: Add optional API fields and accessible presentation**

Extend `ChurchLocationResult`:

```ts
population: number | null;
source: 'open-meteo' | 'geoapify';
```

Below each result's region/country line, render population only when `Number.isFinite(result.population)`:

```tsx
{Number.isFinite(result.population) && (
  <div className="text-xs text-gray-500 dark:text-gray-400">
    Population {result.population!.toLocaleString()}
  </div>
)}
```

Below the mapped results, render one small attribution footer based on `locationResults[0]?.source`. Links open in a new tab and include `rel="noreferrer"`. Use:

- Open-Meteo: `https://open-meteo.com/`
- Geoapify: `https://www.geoapify.com/`
- OpenStreetMap contributors: `https://www.openstreetmap.org/copyright`

Do not include attribution inside result buttons, avoiding nested interactive elements. Stop propagation is therefore unnecessary.

- [ ] **Step 4: Run the focused client test and verify GREEN**

Run:

```bash
cd client && npm test -- src/pages/SettingsPage.location.test.tsx
```

Expected: all location UI tests PASS, including stale response protection and selected-location persistence.

- [ ] **Step 5: Commit client metadata presentation**

```bash
git add client/src/services/api.ts client/src/pages/SettingsPage.tsx client/src/pages/SettingsPage.location.test.tsx
git commit -m "feat: show location population and attribution"
```

---

### Task 5: Focused verification

**Files:**
- Verify only; modify production or test files only if a preceding requirement is demonstrably failing.

**Interfaces:**
- Confirms the complete Settings browser-to-provider behavior and unchanged location persistence contract.

- [ ] **Step 1: Run all affected automated tests**

```bash
cd server && node --test services/locationSearch.test.js routes/settings.location.test.js
cd client && npm test -- src/pages/SettingsPage.location.test.tsx
```

Expected: all tests PASS with no warnings, leaked secrets, open handles, or unhandled rejections.

- [ ] **Step 2: Run client production build**

```bash
cd client && npm run build
```

Expected: service worker generation and Vite production build complete successfully with no TypeScript errors.

- [ ] **Step 3: Verify a configured Geoapify request from the server container**

Run inside the deployed server container without printing the key:

```bash
node -e 'const u=new URL("https://api.geoapify.com/v1/geocode/autocomplete");u.searchParams.set("text","Hobart");u.searchParams.set("type","city");u.searchParams.set("limit","1");u.searchParams.set("format","json");u.searchParams.set("apiKey",process.env.GEOAPIFY_API_KEY||"");fetch(u,{signal:AbortSignal.timeout(10000)}).then(async r=>{console.log("HTTP",r.status);const b=await r.json();console.log("results",Array.isArray(b.results)?b.results.length:"invalid")}).catch(e=>{console.error(e.cause||e);process.exit(1)})'
```

Expected: `HTTP 200` and `results 1` (or another positive count) without displaying the API key.

- [ ] **Step 4: Review final diff and repository state**

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected: no whitespace errors; only intentional task changes are present; commits correspond to the plan tasks.
