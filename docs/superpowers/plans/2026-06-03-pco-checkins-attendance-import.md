# PCO Check-Ins Historical Attendance Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a church migrating off Planning Center Check-Ins import its historical attendance into LMPG as present-only records, mapping PCO events to LMPG gatherings.

**Architecture:** A pure logic module (`server/services/planningCenter/checkinsImport.js`) handles normalisation, event summarisation, person resolution, and record building — all unit-tested with `node:test`. Three thin endpoints in `server/routes/integrations.js` (`events`, `preview`, `execute`) orchestrate PCO fetch + DB writes, reusing the existing `getPlanningCenterTokens` / `makePlanningCenterRequest` helpers and the session-upsert pattern from the Historical CSV importer. The frontend adds an Integrations card with a date-range → event-mapping → preview → confirm flow, plus an onboarding prompt when check-ins are detected.

**Tech Stack:** Node.js/Express, better-sqlite3 (`Database.query` / `Database.transaction`), `node:test`, React 19 + TypeScript, Tailwind, Axios. Tests run inside the dev container.

**Key invariants:**
- **Present-only.** Never write absent records.
- **LMPG attendance is truth.** Records use `INSERT ... ON CONFLICT(session_id, individual_id) DO NOTHING` — never overwrite an existing record.
- **PCO is source of truth for people only.** Unmatched former attendees are created with `is_active = 0`.

**Testing note:** All `node --test` commands run inside the dev container, per the project's docker-only build rule:
```bash
docker-compose -f docker-compose.dev.yml exec -T server node --test <path>
```
If the container is not already running: `docker-compose -f docker-compose.dev.yml up -d server`.

---

## File Structure

- **Create** `server/services/planningCenter/checkinsImport.js` — pure logic: `localDateInTz`, `normalizeCheckIns`, `summarizeEvents`, `resolvePeople`, `buildRecordWrites`.
- **Create** `server/services/planningCenter/checkinsImport.test.js` — unit tests for the above.
- **Modify** `server/routes/integrations.js` — replace the stubbed `POST /planning-center/import-checkins` with `GET /planning-center/checkins/events`, `POST /planning-center/import-checkins/preview`, `POST /planning-center/import-checkins/execute`.
- **Create** `client/src/components/PCOCheckinImport.tsx` — the importer UI (range → mapping → preview → confirm).
- **Modify** the Integrations settings UI to render `<PCOCheckinImport />` (file located in Task 7).
- **Modify** `client/src/pages/OnboardingPage.tsx` — detect check-ins after PCO connect and show a skippable prompt linking to the importer.
- **Modify** `client/src/services/api.ts` — add API methods for the three endpoints.

---

## Task 1: Pure helper — `localDateInTz`

**Files:**
- Create: `server/services/planningCenter/checkinsImport.js`
- Test: `server/services/planningCenter/checkinsImport.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/services/planningCenter/checkinsImport.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { localDateInTz } = require('./checkinsImport');

test('localDateInTz returns YYYY-MM-DD in the church timezone', () => {
  // 2025-02-09T09:30:00Z is Sunday morning in Sydney (+11 in Feb, DST)
  assert.strictEqual(localDateInTz('2025-02-09T09:30:00Z', 'Australia/Sydney'), '2025-02-09');
});

test('localDateInTz keeps an evening check-in on the same local day', () => {
  // 2025-02-09T12:00:00Z = 2025-02-09 23:00 in Sydney (still the 9th)
  assert.strictEqual(localDateInTz('2025-02-09T12:00:00Z', 'Australia/Sydney'), '2025-02-09');
});

test('localDateInTz rolls over correctly past local midnight', () => {
  // 2025-02-09T13:30:00Z = 2025-02-10 00:30 in Sydney (the 10th)
  assert.strictEqual(localDateInTz('2025-02-09T13:30:00Z', 'Australia/Sydney'), '2025-02-10');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: FAIL — `Cannot find module './checkinsImport'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/services/planningCenter/checkinsImport.js

// Returns the calendar date (YYYY-MM-DD) of an ISO timestamp, evaluated in tz.
function localDateInTz(isoString, tz) {
  const d = new Date(isoString);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

module.exports = { localDateInTz };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/checkinsImport.js server/services/planningCenter/checkinsImport.test.js
git commit -m "feat(pco): add localDateInTz helper for check-in date bucketing"
```

---

## Task 2: Pure — `normalizeCheckIns`

Turns the raw PCO `check_ins` payload (`data` + `included`) into a flat, de-duplicated list of `{ pcoEventId, eventName, pcoPersonId, firstName, lastName, date }`, one entry per person-per-event-per-date.

**Files:**
- Modify: `server/services/planningCenter/checkinsImport.js`
- Test: `server/services/planningCenter/checkinsImport.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to checkinsImport.test.js
const { normalizeCheckIns } = require('./checkinsImport');

function rawPayload() {
  return {
    data: [
      { id: 'c1', attributes: { checked_in_at: '2025-02-09T09:30:00Z' },
        relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p1' } } } },
      // same person, same event, same day -> deduped
      { id: 'c2', attributes: { checked_in_at: '2025-02-09T09:45:00Z' },
        relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p1' } } } },
      { id: 'c3', attributes: { checked_in_at: '2025-02-16T09:30:00Z' },
        relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p1' } } } },
      { id: 'c4', attributes: { checked_in_at: '2025-02-09T09:30:00Z' },
        relationships: { event: { data: { id: 'e2' } }, person: { data: { id: 'p2' } } } },
    ],
    included: [
      { type: 'Event', id: 'e1', attributes: { name: 'Sunday Gathering' } },
      { type: 'Event', id: 'e2', attributes: { name: 'Kids Church' } },
      { type: 'Person', id: 'p1', attributes: { first_name: 'Sarah', last_name: 'Wierenga' } },
      { type: 'Person', id: 'p2', attributes: { first_name: 'Tim', last_name: 'Brown' } },
    ],
  };
}

test('normalizeCheckIns flattens, names, and dedupes person-per-event-per-date', () => {
  const out = normalizeCheckIns(rawPayload(), 'Australia/Sydney');
  assert.strictEqual(out.length, 3); // c1 & c2 collapse
  const sunday = out.find((r) => r.pcoEventId === 'e1' && r.date === '2025-02-09');
  assert.deepStrictEqual(sunday, {
    pcoEventId: 'e1', eventName: 'Sunday Gathering',
    pcoPersonId: 'p1', firstName: 'Sarah', lastName: 'Wierenga', date: '2025-02-09',
  });
});

test('normalizeCheckIns skips check-ins missing event or person', () => {
  const payload = { data: [
    { id: 'x', attributes: { checked_in_at: '2025-02-09T09:30:00Z' },
      relationships: { event: { data: null }, person: { data: { id: 'p1' } } } },
  ], included: [] };
  assert.strictEqual(normalizeCheckIns(payload, 'Australia/Sydney').length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: FAIL — `normalizeCheckIns is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to checkinsImport.js (above module.exports)

function buildIncludedMaps(included = []) {
  const events = {};
  const people = {};
  for (const item of included) {
    if (item.type === 'Event') {
      events[item.id] = item.attributes.name || 'Unknown Event';
    } else if (item.type === 'Person') {
      people[item.id] = {
        firstName: item.attributes.first_name || '',
        lastName: item.attributes.last_name || '',
      };
    }
  }
  return { events, people };
}

// payload = { data, included }; returns flat, de-duped rows.
function normalizeCheckIns(payload, tz) {
  const { events, people } = buildIncludedMaps(payload.included);
  const seen = new Set();
  const out = [];
  for (const ci of payload.data || []) {
    const pcoEventId = ci.relationships?.event?.data?.id;
    const pcoPersonId = ci.relationships?.person?.data?.id;
    const checkedInAt = ci.attributes?.checked_in_at;
    if (!pcoEventId || !pcoPersonId || !checkedInAt) continue;
    const date = localDateInTz(checkedInAt, tz);
    const key = `${pcoEventId}|${pcoPersonId}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const person = people[pcoPersonId] || { firstName: '', lastName: '' };
    out.push({
      pcoEventId,
      eventName: events[pcoEventId] || 'Unknown Event',
      pcoPersonId,
      firstName: person.firstName,
      lastName: person.lastName,
      date,
    });
  }
  return out;
}
```

Update the exports line:

```js
module.exports = { localDateInTz, normalizeCheckIns };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/checkinsImport.js server/services/planningCenter/checkinsImport.test.js
git commit -m "feat(pco): normalize check-ins into deduped flat rows"
```

---

## Task 3: Pure — `summarizeEvents`

Aggregates normalised rows into the per-event summary the mapping screen needs.

**Files:**
- Modify: `server/services/planningCenter/checkinsImport.js`
- Test: `server/services/planningCenter/checkinsImport.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to checkinsImport.test.js
const { summarizeEvents } = require('./checkinsImport');

test('summarizeEvents groups by event with counts and date span', () => {
  const normalized = normalizeCheckIns(rawPayload(), 'Australia/Sydney');
  const events = summarizeEvents(normalized);
  const e1 = events.find((e) => e.pcoEventId === 'e1');
  assert.deepStrictEqual(e1, {
    pcoEventId: 'e1', eventName: 'Sunday Gathering',
    checkinCount: 2, sessionCount: 2, firstDate: '2025-02-09', lastDate: '2025-02-16',
  });
  const e2 = events.find((e) => e.pcoEventId === 'e2');
  assert.strictEqual(e2.checkinCount, 1);
  assert.strictEqual(e2.firstDate, '2025-02-09');
});
```

> `checkinCount` = total person-date rows for the event; `sessionCount` = distinct dates.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: FAIL — `summarizeEvents is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to checkinsImport.js

function summarizeEvents(normalized) {
  const byEvent = new Map();
  for (const row of normalized) {
    let e = byEvent.get(row.pcoEventId);
    if (!e) {
      e = { pcoEventId: row.pcoEventId, eventName: row.eventName, checkinCount: 0, dates: new Set() };
      byEvent.set(row.pcoEventId, e);
    }
    e.checkinCount += 1;
    e.dates.add(row.date);
  }
  return Array.from(byEvent.values()).map((e) => {
    const sorted = Array.from(e.dates).sort();
    return {
      pcoEventId: e.pcoEventId,
      eventName: e.eventName,
      checkinCount: e.checkinCount,
      sessionCount: sorted.length,
      firstDate: sorted[0] || null,
      lastDate: sorted[sorted.length - 1] || null,
    };
  });
}
```

Update exports:

```js
module.exports = { localDateInTz, normalizeCheckIns, summarizeEvents };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/checkinsImport.js server/services/planningCenter/checkinsImport.test.js
git commit -m "feat(pco): summarize normalized check-ins per event"
```

---

## Task 4: Pure — `resolvePeople`

Given the distinct PCO people in the normalised set and a map of existing individuals keyed by `planning_center_id`, decide who is already in LMPG and who must be created (inactive).

**Files:**
- Modify: `server/services/planningCenter/checkinsImport.js`
- Test: `server/services/planningCenter/checkinsImport.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to checkinsImport.test.js
const { resolvePeople } = require('./checkinsImport');

test('resolvePeople matches existing (active or archived) and lists the rest to create', () => {
  const normalized = normalizeCheckIns(rawPayload(), 'Australia/Sydney');
  const existingByPcoId = new Map([
    ['p1', { id: 11, isActive: 1 }],
    // p2 not present -> must be created inactive
  ]);
  const r = resolvePeople(normalized, existingByPcoId);

  assert.deepStrictEqual(r.matched, [{ pcoPersonId: 'p1', individualId: 11 }]);
  assert.deepStrictEqual(r.toCreate, [
    { pcoPersonId: 'p2', firstName: 'Tim', lastName: 'Brown' },
  ]);
});

test('resolvePeople gives a placeholder last name when PCO name is blank', () => {
  const normalized = [{ pcoEventId: 'e', eventName: 'E', pcoPersonId: 'p9', firstName: '', lastName: '', date: '2025-01-05' }];
  const r = resolvePeople(normalized, new Map());
  assert.deepStrictEqual(r.toCreate, [{ pcoPersonId: 'p9', firstName: 'Unknown', lastName: 'Attendee' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: FAIL — `resolvePeople is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to checkinsImport.js

// normalized: rows from normalizeCheckIns
// existingByPcoId: Map<pcoPersonId, { id, isActive }>
function resolvePeople(normalized, existingByPcoId) {
  const distinct = new Map(); // pcoPersonId -> {firstName,lastName}
  for (const row of normalized) {
    if (!distinct.has(row.pcoPersonId)) {
      distinct.set(row.pcoPersonId, { firstName: row.firstName, lastName: row.lastName });
    }
  }
  const matched = [];
  const toCreate = [];
  for (const [pcoPersonId, name] of distinct) {
    const existing = existingByPcoId.get(pcoPersonId);
    if (existing) {
      matched.push({ pcoPersonId, individualId: existing.id });
    } else {
      toCreate.push({
        pcoPersonId,
        firstName: (name.firstName || '').trim() || 'Unknown',
        lastName: (name.lastName || '').trim() || 'Attendee',
      });
    }
  }
  return { matched, toCreate };
}
```

Update exports:

```js
module.exports = { localDateInTz, normalizeCheckIns, summarizeEvents, resolvePeople };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/checkinsImport.js server/services/planningCenter/checkinsImport.test.js
git commit -m "feat(pco): resolve check-in people to existing or to-create-inactive"
```

---

## Task 5: Pure — `buildRecordWrites`

Given normalised rows, a resolved person map (`pcoPersonId → individualId`), and an event→gathering map (`pcoEventId → gatheringTypeId`), produce the distinct `(gatheringTypeId, date, individualId)` present-records to write. Events not in the mapping are skipped.

**Files:**
- Modify: `server/services/planningCenter/checkinsImport.js`
- Test: `server/services/planningCenter/checkinsImport.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to checkinsImport.test.js
const { buildRecordWrites } = require('./checkinsImport');

test('buildRecordWrites maps events to gatherings and resolves individuals', () => {
  const normalized = normalizeCheckIns(rawPayload(), 'Australia/Sydney');
  const personToIndividual = new Map([['p1', 11], ['p2', 22]]);
  const eventToGathering = new Map([['e1', 100]]); // e2 NOT mapped -> skipped

  const writes = buildRecordWrites(normalized, personToIndividual, eventToGathering);

  assert.deepStrictEqual(writes.sort((a, b) => a.date.localeCompare(b.date)), [
    { gatheringTypeId: 100, date: '2025-02-09', individualId: 11 },
    { gatheringTypeId: 100, date: '2025-02-16', individualId: 11 },
  ]);
});

test('buildRecordWrites dedupes identical gathering/date/individual', () => {
  const normalized = [
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-03-02', eventName: 'S', firstName: 'A', lastName: 'B' },
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-03-02', eventName: 'S', firstName: 'A', lastName: 'B' },
  ];
  const writes = buildRecordWrites(normalized, new Map([['p1', 5]]), new Map([['e1', 9]]));
  assert.strictEqual(writes.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: FAIL — `buildRecordWrites is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to checkinsImport.js

// personToIndividual: Map<pcoPersonId, individualId>
// eventToGathering: Map<pcoEventId, gatheringTypeId>
function buildRecordWrites(normalized, personToIndividual, eventToGathering) {
  const seen = new Set();
  const writes = [];
  for (const row of normalized) {
    const gatheringTypeId = eventToGathering.get(row.pcoEventId);
    const individualId = personToIndividual.get(row.pcoPersonId);
    if (gatheringTypeId == null || individualId == null) continue;
    const key = `${gatheringTypeId}|${row.date}|${individualId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    writes.push({ gatheringTypeId, date: row.date, individualId });
  }
  return writes;
}
```

Update exports:

```js
module.exports = {
  localDateInTz, normalizeCheckIns, summarizeEvents, resolvePeople, buildRecordWrites,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/checkinsImport.js server/services/planningCenter/checkinsImport.test.js
git commit -m "feat(pco): build deduped present-record writes from mapping"
```

---

## Task 6: Backend endpoints (events / preview / execute)

Replace the stubbed `POST /planning-center/import-checkins` with three endpoints. These touch the network and DB, so they are verified by inspecting server logs against a connected church rather than by unit test.

**Files:**
- Modify: `server/routes/integrations.js` (replace lines `2471`–`2542`, the stub handler ending in the `TODO`)

- [ ] **Step 1: Add a shared fetch helper near the existing check-in code**

Add this helper just above the existing `router.get('/planning-center/checkins', ...)` handler (around line 2024). It centralises the paginated fetch and the timezone lookup.

```js
const checkinsImport = require('../services/planningCenter/checkinsImport');

// Fetches ALL check-ins for a range (paginated) and returns the merged
// { data, included } payload plus the church timezone.
async function fetchAllCheckins({ tokens, userId, churchId, startDate, endDate }) {
  let url = `https://api.planningcenteronline.com/check-ins/v2/check_ins?` +
    `filter=checked_in_at&where[checked_in_at][gte]=${startDate}&where[checked_in_at][lte]=${endDate}&` +
    `per_page=100&include=event,person`;

  let data = [];
  let included = [];
  let nextUrl = url;
  while (nextUrl) {
    const response = await makePlanningCenterRequest(nextUrl, tokens, userId, churchId);
    if (response.status !== 200) {
      throw new Error('Failed to fetch check-ins from Planning Center');
    }
    data = data.concat(response.data.data || []);
    included = included.concat(response.data.included || []);
    nextUrl = response.data.links?.next || null;
  }

  const settings = await Database.query(
    `SELECT timezone FROM church_settings WHERE church_id = ? LIMIT 1`, [churchId]
  );
  const timezone = (settings[0] && settings[0].timezone) || 'Australia/Sydney';
  return { payload: { data, included }, timezone };
}

// Resolves the effective date range. If either bound is missing, default to
// all available history: earliest check-in (PCO has data from ~2010) to today.
function resolveRange(startDate, endDate) {
  return {
    startDate: startDate || '2010-01-01',
    endDate: endDate || new Date().toISOString().slice(0, 10),
  };
}
```

- [ ] **Step 2: Add the `events` endpoint**

Add after the existing `GET /planning-center/checkins` handler:

```js
// List distinct PCO events that have check-ins in range (for the mapping screen).
router.get('/planning-center/checkins/events', async (req, res) => {
  try {
    const userId = req.user.id;
    const churchId = req.user.church_id;
    const { startDate, endDate } = resolveRange(req.query.startDate, req.query.endDate);

    const tokens = await getPlanningCenterTokens(userId, churchId);
    if (!tokens || !tokens.access_token) {
      return res.status(400).json({ error: 'Planning Center not connected.' });
    }

    const { payload, timezone } = await fetchAllCheckins({ tokens, userId, churchId, startDate, endDate });
    const normalized = checkinsImport.normalizeCheckIns(payload, timezone);
    const events = checkinsImport.summarizeEvents(normalized);

    res.json({ success: true, startDate, endDate, events });
  } catch (error) {
    console.error('PCO check-in events error:', error);
    res.status(500).json({ success: false, error: 'Failed to list Planning Center check-in events.', details: error.message });
  }
});
```

- [ ] **Step 3: Replace the stub with `preview` and `execute`**

Delete the existing `router.post('/planning-center/import-checkins', ...)` handler (the one ending at the `TODO` / `note: 'Check-in mapping ... not yet implemented'`). Insert the two handlers below in its place.

The request body for both is:
```
{ startDate?, endDate?, mappings: [ { pcoEventId, target: 'existing'|'new', gatheringTypeId?, newGatheringName? } ] }
```

```js
// Shared core: fetch, normalize, resolve people, and (optionally) write.
async function runCheckinImport({ req, commit }) {
  const userId = req.user.id;
  const churchId = req.user.church_id;
  const { startDate, endDate } = resolveRange(req.body.startDate, req.body.endDate);
  const mappings = Array.isArray(req.body.mappings) ? req.body.mappings : [];

  const tokens = await getPlanningCenterTokens(userId, churchId);
  if (!tokens || !tokens.access_token) {
    const err = new Error('Planning Center not connected.');
    err.statusCode = 400;
    throw err;
  }

  const { payload, timezone } = await fetchAllCheckins({ tokens, userId, churchId, startDate, endDate });
  const normalized = checkinsImport.normalizeCheckIns(payload, timezone);

  // Existing individuals keyed by planning_center_id (active OR archived).
  const existingRows = await Database.query(
    `SELECT id, planning_center_id AS pcoId, is_active AS isActive
       FROM individuals WHERE church_id = ? AND planning_center_id IS NOT NULL`,
    [churchId]
  );
  const existingByPcoId = new Map(existingRows.map((r) => [r.pcoId, { id: r.id, isActive: r.isActive }]));

  const people = checkinsImport.resolvePeople(normalized, existingByPcoId);

  // Build the event->gathering map. For preview, "new" events have no id yet.
  const mappingByEvent = new Map(mappings.map((m) => [m.pcoEventId, m]));

  const summary = {
    startDate, endDate, timezone,
    matchedPeople: people.matched.length,
    peopleToCreate: people.toCreate.length,
    events: checkinsImport.summarizeEvents(normalized)
      .filter((e) => mappingByEvent.has(e.pcoEventId))
      .map((e) => ({ ...e, mapping: mappingByEvent.get(e.pcoEventId) })),
  };

  if (!commit) {
    // Preview: compute counts using a placeholder gathering id per mapped event.
    const eventToGathering = new Map();
    for (const m of mappings) eventToGathering.set(m.pcoEventId, m.gatheringTypeId || -1);
    const personToIndividual = new Map(people.matched.map((p) => [p.pcoPersonId, p.individualId]));
    // include to-create people with a placeholder so record count is accurate
    for (const c of people.toCreate) personToIndividual.set(c.pcoPersonId, -1);
    const writes = checkinsImport.buildRecordWrites(normalized, personToIndividual, eventToGathering);

    summary.recordsToWrite = writes.length;
    summary.sessionsInvolved = new Set(writes.map((w) => `${w.gatheringTypeId}|${w.date}`)).size;
    return summary;
  }

  // Commit: everything inside one transaction.
  let createdPeople = 0, gatheringsCreated = 0, sessionsCreated = 0, recordsWritten = 0, recordsSkipped = 0;

  await Database.transaction(async (conn) => {
    // 1) Create missing (inactive) people, capture ids.
    const personToIndividual = new Map(people.matched.map((p) => [p.pcoPersonId, p.individualId]));
    for (const c of people.toCreate) {
      const ins = await conn.query(
        `INSERT INTO individuals (first_name, last_name, people_type, is_active, planning_center_id, created_by, church_id)
         VALUES (?, ?, 'regular', 0, ?, ?, ?)`,
        [c.firstName, c.lastName, c.pcoPersonId, userId, churchId]
      );
      personToIndividual.set(c.pcoPersonId, ins.insertId);
      createdPeople++;
    }

    // 2) Resolve event -> gathering, creating new gatherings where requested.
    const eventToGathering = new Map();
    for (const m of mappings) {
      if (m.target === 'new') {
        const ins = await conn.query(
          `INSERT INTO gathering_types (name, attendance_type, created_by, church_id)
           VALUES (?, 'standard', ?, ?)`,
          [m.newGatheringName || 'Imported Gathering', userId, churchId]
        );
        eventToGathering.set(m.pcoEventId, ins.insertId);
        gatheringsCreated++;
      } else if (m.gatheringTypeId) {
        eventToGathering.set(m.pcoEventId, m.gatheringTypeId);
      }
    }

    // 3) Build writes and apply, upserting sessions and DO NOTHING on records.
    const writes = checkinsImport.buildRecordWrites(normalized, personToIndividual, eventToGathering);
    const sessionCache = new Map(); // `${gid}|${date}` -> sessionId
    const latestPresent = new Map(); // individualId -> max date

    for (const w of writes) {
      const sKey = `${w.gatheringTypeId}|${w.date}`;
      let sessionId = sessionCache.get(sKey);
      if (sessionId == null) {
        const existing = await conn.query(
          `SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?`,
          [w.gatheringTypeId, w.date, churchId]
        );
        if (existing.length > 0) {
          sessionId = existing[0].id;
        } else {
          const ins = await conn.query(
            `INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id) VALUES (?, ?, ?, ?)`,
            [w.gatheringTypeId, w.date, userId, churchId]
          );
          sessionId = ins.insertId;
          sessionsCreated++;
        }
        sessionCache.set(sKey, sessionId);
      }

      const result = await conn.query(
        `INSERT INTO attendance_records (session_id, individual_id, present, people_type_at_time, church_id)
         VALUES (?, ?, 1, 'regular', ?)
         ON CONFLICT(session_id, individual_id) DO NOTHING`,
        [sessionId, w.individualId, churchId]
      );
      if (result.affectedRows && result.affectedRows > 0) recordsWritten++; else recordsSkipped++;

      const prev = latestPresent.get(w.individualId);
      if (!prev || prev < w.date) latestPresent.set(w.individualId, w.date);
    }

    // 4) Move last_attendance_date forward only.
    for (const [individualId, date] of latestPresent) {
      await conn.query(
        `UPDATE individuals SET last_attendance_date = ?
           WHERE id = ? AND church_id = ? AND (last_attendance_date IS NULL OR last_attendance_date < ?)`,
        [date, individualId, churchId, date]
      );
    }
  });

  return { ...summary, createdPeople, gatheringsCreated, sessionsCreated, recordsWritten, recordsSkipped };
}

// Preview — no writes.
router.post('/planning-center/import-checkins/preview', async (req, res) => {
  try {
    const summary = await runCheckinImport({ req, commit: false });
    res.json({ success: true, ...summary });
  } catch (error) {
    console.error('PCO check-in preview error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// Execute — writes inside a transaction.
router.post('/planning-center/import-checkins/execute', async (req, res) => {
  try {
    const summary = await runCheckinImport({ req, commit: true });
    res.json({ success: true, ...summary });
  } catch (error) {
    console.error('PCO check-in execute error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});
```

> **Verify `result.affectedRows` semantics:** confirm the DB layer returns `affectedRows: 0` for a `DO NOTHING` no-op. Check `server/config/database.js` for the `INSERT`/`run` return shape. If it instead returns `changes`, adjust the `recordsWritten` check accordingly (e.g. `result.changes > 0`). This is the one place the abstraction could bite.

- [ ] **Step 4: Restart server and verify it boots cleanly**

Run:
```bash
docker-compose -f docker-compose.dev.yml restart server
docker-compose -f docker-compose.dev.yml logs --tail=40 server
```
Expected: server starts with no syntax/require errors; no mention of the old `import-checkins` stub.

- [ ] **Step 5: Manual smoke test against the connected Kingston church**

Using the browser dev session (logged in as a Kingston admin), in the browser console or via the UI once Task 7 lands:
```
GET  /api/integrations/planning-center/checkins/events           -> events list with counts
POST /api/integrations/planning-center/import-checkins/preview   -> { recordsToWrite, peopleToCreate, ... }
```
Expected: `events` returns Kingston's PCO events with non-zero counts; `preview` returns sensible numbers and writes nothing (re-query `attendance_records` count to confirm unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): add check-in events/preview/execute import endpoints"
```

---

## Task 7: Frontend — API client methods

**Files:**
- Modify: `client/src/services/api.ts`

- [ ] **Step 1: Locate the integrations API group**

Run: `grep -n "planning-center\|integrationsAPI\|planningCenter" client/src/services/api.ts | head`
Expected: an existing object grouping Planning Center calls (e.g. `integrationsAPI` or similar). Note its name and style.

- [ ] **Step 2: Add the three methods**

Add to the existing Planning Center API group, matching its surrounding style (the example below assumes an `api` Axios instance and an object literal of methods):

```ts
// within the Planning Center integration API group
getCheckinEvents: (params: { startDate?: string; endDate?: string }) =>
  api.get('/integrations/planning-center/checkins/events', { params }),

previewCheckinImport: (body: {
  startDate?: string;
  endDate?: string;
  mappings: Array<{
    pcoEventId: string;
    target: 'existing' | 'new';
    gatheringTypeId?: number;
    newGatheringName?: string;
  }>;
}) => api.post('/integrations/planning-center/import-checkins/preview', body),

executeCheckinImport: (body: {
  startDate?: string;
  endDate?: string;
  mappings: Array<{
    pcoEventId: string;
    target: 'existing' | 'new';
    gatheringTypeId?: number;
    newGatheringName?: string;
  }>;
}) => api.post('/integrations/planning-center/import-checkins/execute', body),
```

- [ ] **Step 3: Verify it type-checks via the client container build**

Run:
```bash
docker-compose -f docker-compose.dev.yml logs --tail=30 client
```
Expected: Vite recompiles with no TypeScript errors after the file saves (HMR). If the client isn't running: `docker-compose -f docker-compose.dev.yml up -d client`.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat(pco): add check-in import API client methods"
```

---

## Task 8: Frontend — `PCOCheckinImport` component

A self-contained card: date range → "Find events" → event mapping list → preview → confirm.

**Files:**
- Create: `client/src/components/PCOCheckinImport.tsx`

- [ ] **Step 1: Find the gatherings list source**

Run: `grep -n "getGatherings\|gatheringsAPI\|getAll" client/src/services/api.ts | head`
Expected: an existing method that returns the church's gatherings (e.g. `gatheringsAPI.getAll()`). Note its exact name; use it in Step 2 where marked.

- [ ] **Step 2: Write the component**

```tsx
// client/src/components/PCOCheckinImport.tsx
import React, { useEffect, useState } from 'react';
import { integrationsAPI, gatheringsAPI } from '../services/api'; // adjust names to match Step 1 / Task 7

interface PcoEvent {
  pcoEventId: string;
  eventName: string;
  checkinCount: number;
  sessionCount: number;
  firstDate: string | null;
  lastDate: string | null;
}

interface Gathering { id: number; name: string; }

type Mapping = {
  target: 'skip' | 'existing' | 'new';
  gatheringTypeId?: number;
  newGatheringName?: string;
};

const PCOCheckinImport: React.FC = () => {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [events, setEvents] = useState<PcoEvent[]>([]);
  const [gatherings, setGatherings] = useState<Gathering[]>([]);
  const [mappings, setMappings] = useState<Record<string, Mapping>>({});
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);

  useEffect(() => {
    gatheringsAPI.getAll() // adjust to the method from Step 1
      .then((r: any) => setGatherings(r.data.gatherings || r.data || []))
      .catch(() => setGatherings([]));
  }, []);

  const buildMappingsPayload = () =>
    Object.entries(mappings)
      .filter(([, m]) => m.target !== 'skip')
      .map(([pcoEventId, m]) => ({
        pcoEventId,
        target: m.target,
        gatheringTypeId: m.target === 'existing' ? m.gatheringTypeId : undefined,
        newGatheringName: m.target === 'new' ? m.newGatheringName : undefined,
      }));

  const findEvents = async () => {
    setLoading(true); setError(null); setPreview(null); setDone(null);
    try {
      const r = await integrationsAPI.getCheckinEvents({ startDate, endDate });
      setEvents(r.data.events || []);
      setStartDate(r.data.startDate);
      setEndDate(r.data.endDate);
      const defaults: Record<string, Mapping> = {};
      for (const e of r.data.events || []) {
        defaults[e.pcoEventId] = { target: 'new', newGatheringName: e.eventName };
      }
      setMappings(defaults);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load events.');
    } finally { setLoading(false); }
  };

  const runPreview = async () => {
    setLoading(true); setError(null);
    try {
      const r = await integrationsAPI.previewCheckinImport({ startDate, endDate, mappings: buildMappingsPayload() });
      setPreview(r.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Preview failed.');
    } finally { setLoading(false); }
  };

  const runExecute = async () => {
    if (!window.confirm('Import these check-ins as attendance? Existing LMPG records will not be changed.')) return;
    setLoading(true); setError(null);
    try {
      const r = await integrationsAPI.executeCheckinImport({ startDate, endDate, mappings: buildMappingsPayload() });
      setDone(r.data);
      setPreview(null);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Import failed.');
    } finally { setLoading(false); }
  };

  const setMap = (id: string, patch: Partial<Mapping>) =>
    setMappings((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  return (
    <div className="rounded-lg border border-gray-200 p-4 space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Import attendance history from Planning Center</h3>
        <p className="text-sm text-gray-500">
          Pull historical check-ins into LMPG as present-only attendance. Existing LMPG attendance is never overwritten.
          Leave dates blank to import all available history.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Start
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="block border rounded px-2 py-1" />
        </label>
        <label className="text-sm">End
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="block border rounded px-2 py-1" />
        </label>
        <button onClick={findEvents} disabled={loading}
          className="bg-primary-600 text-white rounded px-3 py-2 disabled:opacity-50">
          {loading ? 'Loading…' : 'Find events'}
        </button>
      </div>

      {error && <div className="text-red-600 text-sm">{error}</div>}

      {events.length > 0 && (
        <div className="space-y-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1">PCO Event</th><th>Check-ins</th><th>Dates</th><th>Import as</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => {
                const m = mappings[ev.pcoEventId] || { target: 'skip' };
                return (
                  <tr key={ev.pcoEventId} className="border-t">
                    <td className="py-2">{ev.eventName}</td>
                    <td>{ev.checkinCount} ({ev.sessionCount} dates)</td>
                    <td>{ev.firstDate} → {ev.lastDate}</td>
                    <td className="space-x-2">
                      <select value={m.target}
                        onChange={(e) => setMap(ev.pcoEventId, { target: e.target.value as Mapping['target'] })}
                        className="border rounded px-1 py-1">
                        <option value="skip">Skip</option>
                        <option value="new">New gathering</option>
                        <option value="existing">Existing gathering</option>
                      </select>
                      {m.target === 'new' && (
                        <input value={m.newGatheringName || ''} placeholder="Gathering name"
                          onChange={(e) => setMap(ev.pcoEventId, { newGatheringName: e.target.value })}
                          className="border rounded px-1 py-1" />
                      )}
                      {m.target === 'existing' && (
                        <select value={m.gatheringTypeId || ''}
                          onChange={(e) => setMap(ev.pcoEventId, { gatheringTypeId: Number(e.target.value) })}
                          className="border rounded px-1 py-1">
                          <option value="">Choose…</option>
                          {gatherings.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button onClick={runPreview} disabled={loading}
            className="bg-gray-700 text-white rounded px-3 py-2 disabled:opacity-50">Preview import</button>
        </div>
      )}

      {preview && (
        <div className="rounded bg-gray-50 p-3 text-sm space-y-1">
          <div className="font-medium">Preview</div>
          <div>Records to write (present): <strong>{preview.recordsToWrite}</strong></div>
          <div>Sessions involved: {preview.sessionsInvolved}</div>
          <div>Matched people: {preview.matchedPeople}</div>
          <div>New (inactive) people to create: {preview.peopleToCreate}</div>
          <button onClick={runExecute} disabled={loading}
            className="mt-2 bg-green-600 text-white rounded px-3 py-2 disabled:opacity-50">
            Confirm import
          </button>
        </div>
      )}

      {done && (
        <div className="rounded bg-green-50 p-3 text-sm space-y-1">
          <div className="font-medium text-green-800">Import complete</div>
          <div>Records written: {done.recordsWritten}</div>
          <div>Records skipped (already in LMPG): {done.recordsSkipped}</div>
          <div>Sessions created: {done.sessionsCreated}</div>
          <div>Gatherings created: {done.gatheringsCreated}</div>
          <div>People created (inactive): {done.createdPeople}</div>
        </div>
      )}
    </div>
  );
};

export default PCOCheckinImport;
```

- [ ] **Step 3: Verify it compiles**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=30 client`
Expected: Vite recompiles with no TypeScript errors. Fix any import-name mismatches against Task 7 / Step 1.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/PCOCheckinImport.tsx
git commit -m "feat(pco): add check-in import UI component"
```

---

## Task 9: Frontend — mount the importer in Integrations settings

**Files:**
- Modify: the Integrations settings UI

- [ ] **Step 1: Locate the integrations settings UI**

Run: `grep -rln "planning.center\|Planning Center\|pco_success\|tab=integrations" client/src/pages client/src/components | head`
Expected: the page/component rendering the Integrations tab (e.g. `client/src/pages/SettingsPage.tsx` or a Planning Center settings component). Pick the one that renders the PCO connection status/card.

- [ ] **Step 2: Render the component (only when PCO connected)**

In that file, import and render the importer beneath the existing PCO connection card, gated on the connection status the page already tracks:

```tsx
import PCOCheckinImport from '../components/PCOCheckinImport'; // adjust relative path

// ...where PCO is shown as connected (reuse the existing connected boolean):
{pcoConnected && <PCOCheckinImport />}
```

> Use the page's existing "connected" state variable. If it's named differently (e.g. `planningCenterConnected`, `status?.connected`), use that exact name — confirm with: `grep -n "connected\|status" <that file>`.

- [ ] **Step 3: Verify in the browser**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=20 client`, then load Settings → Integrations in the dev browser as a connected church.
Expected: the "Import attendance history from Planning Center" card renders under the PCO connection card. "Find events" returns events.

- [ ] **Step 4: Commit**

```bash
git add <the integrations settings file>
git commit -m "feat(pco): mount check-in importer in integrations settings"
```

---

## Task 10: Frontend — onboarding detection prompt

After PCO connect during onboarding, detect whether check-ins exist and show a skippable prompt linking to the importer.

**Files:**
- Modify: `client/src/pages/OnboardingPage.tsx`

- [ ] **Step 1: Find the post-PCO-connect point in onboarding**

Run: `grep -n "planning\|pco\|PCO\|connect\|step" client/src/pages/OnboardingPage.tsx | head -40`
Expected: the onboarding step/state handling where PCO connection completes. Note the step state variable and how navigation to Settings is done elsewhere (reuse existing navigation).

- [ ] **Step 2: Add detection + prompt**

After PCO is connected in onboarding, call the events endpoint with no range (defaults to all history) and, if any events have check-ins, show a non-blocking prompt. Add this state and effect within the onboarding component:

```tsx
import { integrationsAPI } from '../services/api';
// ...
const [checkinPrompt, setCheckinPrompt] = useState<{ count: number } | null>(null);

// Call this once PCO shows as connected (reuse the existing connected flag/effect):
const detectCheckins = async () => {
  try {
    const r = await integrationsAPI.getCheckinEvents({});
    const total = (r.data.events || []).reduce((n: number, e: any) => n + e.checkinCount, 0);
    if (total > 0) setCheckinPrompt({ count: total });
  } catch {
    setCheckinPrompt(null);
  }
};
```

Render the prompt (skippable):

```tsx
{checkinPrompt && (
  <div className="rounded-lg border border-primary-200 bg-primary-50 p-4 my-4">
    <p className="font-medium">We found {checkinPrompt.count} check-ins in Planning Center.</p>
    <p className="text-sm text-gray-600">
      Want to import this attendance history into LMPG? You can do this now or later from Settings → Integrations.
    </p>
    <div className="mt-2 flex gap-2">
      <button
        onClick={() => navigate('/app/settings?tab=integrations')}  // reuse existing navigate
        className="bg-primary-600 text-white rounded px-3 py-2">
        Import now
      </button>
      <button onClick={() => setCheckinPrompt(null)} className="text-gray-600 px-3 py-2">
        Skip for now
      </button>
    </div>
  </div>
)}
```

> Wire `detectCheckins()` into the existing effect/handler that fires when PCO becomes connected during onboarding. Use the page's existing `navigate` (from `useNavigate`) — confirm with `grep -n "useNavigate\|navigate(" client/src/pages/OnboardingPage.tsx`.

- [ ] **Step 3: Verify**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=20 client`, then walk the onboarding PCO step in the dev browser with a check-in-enabled church.
Expected: after connecting PCO, the prompt appears with a non-zero count; "Skip for now" dismisses it; "Import now" navigates to Integrations.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/OnboardingPage.tsx
git commit -m "feat(pco): prompt to import check-in history during onboarding"
```

---

## Task 11: End-to-end verification (Kingston)

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS (10 tests).

- [ ] **Step 2: Preview against Kingston, confirm zero writes**

In the dev browser as a Kingston admin: Settings → Integrations → importer → blank dates → Find events → Preview.
Record `attendance_records` count before/after preview (admin panel at `http://localhost:7777` or a query) and confirm it is unchanged.

- [ ] **Step 3: Execute a narrow range, verify present-only + idempotency**

Pick one event + a one-month range, map to a new gathering, Confirm import. Then:
- Verify new `attendance_sessions` and `attendance_records` exist with `present = 1` only (no `present = 0` rows from this import).
- Verify unmatched attendees were created with `is_active = 0`.
- Re-run the identical import; confirm `recordsWritten = 0` and `recordsSkipped` equals the prior `recordsWritten` (idempotent, no duplicates).

- [ ] **Step 4: Verify "LMPG wins"**

Manually mark one imported person absent on an imported date via the Attendance UI. Re-run the import for that range. Confirm the manual absent record is preserved (still absent), proving `DO NOTHING`.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(pco): verify check-in import end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** events→gathering mapping with create-new (Tasks 3, 6, 8); present-only writes (Task 5/6); LMPG-wins via `DO NOTHING` (Task 6, verified Task 11.4); unmatched → inactive create (Tasks 4, 6); idempotency (Task 5/6, verified Task 11.3); default-all date range (Task 6 `resolveRange`); timezone bucketing (Task 1); Integrations placement + onboarding prompt (Tasks 9, 10); stub replacement (Task 6). All spec sections mapped.
- **Out of scope (per spec):** ongoing sync, family linking of created people, child/visitor typing, headcount targets — none implemented, by design.
- **Known integration risk:** the `affectedRows` return shape of the DB layer for `DO NOTHING` (flagged in Task 6 Step 3). The `recordsWritten`/`recordsSkipped` split depends on it, but correctness of the *data* does not — `DO NOTHING` protects existing records regardless.
