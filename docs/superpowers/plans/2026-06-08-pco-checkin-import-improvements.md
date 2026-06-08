# PCO Check-in Import Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live fetch progress bar, remembered import settings, member-roster auto-fill, staff-user assignment, and editable schedules to the Planning Center check-in import flow.

**Architecture:** Server-side pure helpers (schedule inference, import-state merge) are built and unit-tested first. The shared `fetchAllCheckins` gains an `onProgress` callback that emits `pco:import_progress` over the existing Socket.io broadcast. A new JSON column on `church_settings` persists mappings/imported-markers/last-range. The execute route additionally writes gathering schedules, staff-user assignments, and member rosters for newly-created gatherings. The client renders a progress bar and an inline config sub-panel for new gatherings.

**Tech Stack:** Node.js/Express, better-sqlite3, Socket.io, React 19 + TypeScript, `node:test` for unit tests.

**Spec:** [docs/superpowers/specs/2026-06-08-pco-checkin-import-improvements-design.md](../specs/2026-06-08-pco-checkin-import-improvements-design.md)

**Conventions for this plan:**
- Server unit tests run inside the dev container (per project "Docker-only builds" rule):
  `docker-compose -f docker-compose.dev.yml exec -T server node --test <path-relative-to-/app>`
  The server container's working dir is `/app` (= the `server/` directory), so paths look like `services/planningCenter/checkinsImport.test.js`.
- Client verification is via Docker build, not local `npm run build`.
- Commit after every task.

---

## File Structure

**Server**
- `server/services/planningCenter/checkinsImport.js` — add `deriveSchedule` + `mergeCheckinImportState`; have `summarizeEvents` attach `suggestedSchedule`.
- `server/services/planningCenter/checkinsImport.test.js` — NEW: unit tests for the new helpers.
- `server/config/schema.js` — add `planning_center_checkin_import_state` column to `church_settings`.
- `server/config/database.js` — additive migration for the new column on existing DBs.
- `server/routes/integrations.js` — `onProgress` threading + WS emit; events route enrichment; new state GET endpoint; execute route schedule/assignment/roster/persist.

**Client**
- `client/src/services/api.ts` — extend check-in API method signatures; add `getCheckinImportState`.
- `client/src/components/PCOCheckinImport.tsx` — progress bar, socket subscription, new-gathering sub-panel, saved-mapping/date pre-fill, imported badge.

---

## Task 1: `deriveSchedule` helper (pure, TDD)

**Files:**
- Modify: `server/services/planningCenter/checkinsImport.js`
- Test: `server/services/planningCenter/checkinsImport.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/services/planningCenter/checkinsImport.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { deriveSchedule } = require('./checkinsImport');

// Helper: build N consecutive weekly Sundays starting 2025-01-05 (a Sunday).
function weeklySundays(n) {
  const out = [];
  const d = new Date('2025-01-05T00:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

test('deriveSchedule detects a weekly Sunday service', () => {
  const s = deriveSchedule(weeklySundays(6), '10:00');
  assert.deepStrictEqual(s, { dayOfWeek: 'Sunday', startTime: '10:00', frequency: 'weekly', irregular: false });
});

test('deriveSchedule detects biweekly', () => {
  const dates = ['2025-01-05', '2025-01-19', '2025-02-02', '2025-02-16'];
  const s = deriveSchedule(dates, null);
  assert.strictEqual(s.frequency, 'biweekly');
  assert.strictEqual(s.dayOfWeek, 'Sunday');
  assert.strictEqual(s.irregular, false);
});

test('deriveSchedule detects monthly', () => {
  const dates = ['2025-01-05', '2025-02-02', '2025-03-02', '2025-03-30'];
  const s = deriveSchedule(dates, null);
  assert.strictEqual(s.frequency, 'monthly');
  assert.strictEqual(s.irregular, false);
});

test('deriveSchedule flags annual/irregular (Good Friday-style) as irregular with blank schedule', () => {
  const dates = ['2023-04-07', '2024-03-29', '2025-04-18'];
  const s = deriveSchedule(dates, null);
  assert.strictEqual(s.irregular, true);
  assert.strictEqual(s.dayOfWeek, null);
  assert.strictEqual(s.frequency, null);
});

test('deriveSchedule flags a single occurrence as irregular but keeps startTime', () => {
  const s = deriveSchedule(['2025-06-01'], '09:30');
  assert.deepStrictEqual(s, { dayOfWeek: null, startTime: '09:30', frequency: null, irregular: true });
});

test('deriveSchedule flags inconsistent weekday as irregular', () => {
  // weekly-ish gaps but weekday jumps around
  const dates = ['2025-01-06', '2025-01-14', '2025-01-20', '2025-01-29']; // Mon, Tue, Mon, Wed
  const s = deriveSchedule(dates, null);
  assert.strictEqual(s.irregular, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: FAIL — `deriveSchedule is not a function`.

- [ ] **Step 3: Implement `deriveSchedule`**

In `server/services/planningCenter/checkinsImport.js`, add before the `module.exports` block:

```js
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayOf(dateStr) {
  return WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classifyFrequency(medGap) {
  if (medGap >= 6 && medGap <= 8) return 'weekly';
  if (medGap >= 12 && medGap <= 16) return 'biweekly';
  if (medGap >= 26 && medGap <= 35) return 'monthly';
  return null;
}

// Infer a gathering schedule from an event's service dates.
// dates: array of 'YYYY-MM-DD'; serviceTime: 'HH:MM' or null.
// Returns { dayOfWeek, startTime, frequency, irregular }. When the dates don't
// fit a consistent weekday + regular cadence (e.g. annual Good Friday), it
// returns irregular:true with dayOfWeek/frequency null (startTime is kept).
function deriveSchedule(dates, serviceTime = null) {
  const startTime = serviceTime || null;
  const uniq = [...new Set(dates)].sort();
  if (uniq.length < 2) {
    return { dayOfWeek: null, startTime, frequency: null, irregular: true };
  }
  const counts = {};
  for (const d of uniq) {
    const w = weekdayOf(d);
    counts[w] = (counts[w] || 0) + 1;
  }
  let topDay = null;
  let topCount = 0;
  for (const [w, c] of Object.entries(counts)) {
    if (c > topCount) { topCount = c; topDay = w; }
  }
  const weekdayConsistent = topCount / uniq.length >= 0.6;
  const gaps = [];
  for (let i = 1; i < uniq.length; i++) {
    gaps.push((new Date(`${uniq[i]}T00:00:00Z`) - new Date(`${uniq[i - 1]}T00:00:00Z`)) / 86400000);
  }
  const frequency = classifyFrequency(median(gaps));
  if (weekdayConsistent && frequency) {
    return { dayOfWeek: topDay, startTime, frequency, irregular: false };
  }
  return { dayOfWeek: null, startTime, frequency: null, irregular: true };
}
```

Add `deriveSchedule` to `module.exports`:

```js
module.exports = {
  localDateInTz, normalizeCheckIns, summarizeEvents, resolvePeople, buildRecordWrites, buildGatheringListAdds,
  suggestGatheringId, deriveSchedule,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS (all `deriveSchedule` tests green).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/checkinsImport.js server/services/planningCenter/checkinsImport.test.js
git commit -m "feat(pco): add deriveSchedule helper for inferring gathering schedules"
```

---

## Task 2: `summarizeEvents` attaches `suggestedSchedule`

**Files:**
- Modify: `server/services/planningCenter/checkinsImport.js:168-192`
- Test: `server/services/planningCenter/checkinsImport.test.js`

- [ ] **Step 1: Write the failing test**

Append to `checkinsImport.test.js`:

```js
const { summarizeEvents } = require('./checkinsImport');

test('summarizeEvents attaches a suggestedSchedule per event', () => {
  const normalized = [
    { pcoEventId: 'e1', eventName: 'Sunday', pcoPersonId: 'p1', firstName: 'A', lastName: 'B', date: '2025-01-05' },
    { pcoEventId: 'e1', eventName: 'Sunday', pcoPersonId: 'p2', firstName: 'C', lastName: 'D', date: '2025-01-12' },
    { pcoEventId: 'e1', eventName: 'Sunday', pcoPersonId: 'p1', firstName: 'A', lastName: 'B', date: '2025-01-19' },
  ];
  const [e] = summarizeEvents(normalized);
  assert.deepStrictEqual(e.suggestedSchedule, {
    dayOfWeek: 'Sunday', startTime: null, frequency: 'weekly', irregular: false,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: FAIL — `e.suggestedSchedule` is `undefined`.

- [ ] **Step 3: Implement**

In `summarizeEvents`, the final `.map((e) => {...})` builds a `summary` object. After the `firstDate`/`lastDate` lines and before the `if (e.serviceTime)` line, add the schedule using the already-collected `sorted` dates:

```js
    const summary = {
      pcoEventId: e.pcoEventId,
      eventName: e.eventName,
      checkinCount: e.checkinCount,
      sessionCount: sorted.length,
      firstDate: sorted[0] || null,
      lastDate: sorted[sorted.length - 1] || null,
      suggestedSchedule: deriveSchedule(sorted, e.serviceTime || null),
    };
    if (e.serviceTime) summary.serviceTime = e.serviceTime;
    return summary;
```

(`deriveSchedule` is defined in the same module from Task 1.)

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/checkinsImport.js server/services/planningCenter/checkinsImport.test.js
git commit -m "feat(pco): attach suggestedSchedule to summarizeEvents output"
```

---

## Task 3: `mergeCheckinImportState` helper (pure, TDD)

**Files:**
- Modify: `server/services/planningCenter/checkinsImport.js`
- Test: `server/services/planningCenter/checkinsImport.test.js`

- [ ] **Step 1: Write the failing test**

Append to `checkinsImport.test.js`:

```js
const { mergeCheckinImportState } = require('./checkinsImport');

test('mergeCheckinImportState merges into null prev', () => {
  const next = mergeCheckinImportState(null, {
    lastRange: { startDate: '2025-01-01', endDate: '2025-02-01' },
    mappings: { e1: { target: 'new', newGatheringName: 'Sunday' } },
    imported: { e1: { lastImportedDate: '2025-01-26', gatheringTypeId: 7 } },
  });
  assert.deepStrictEqual(next, {
    lastRange: { startDate: '2025-01-01', endDate: '2025-02-01' },
    mappings: { e1: { target: 'new', newGatheringName: 'Sunday' } },
    imported: { e1: { lastImportedDate: '2025-01-26', gatheringTypeId: 7 } },
  });
});

test('mergeCheckinImportState preserves prior events and overlays new ones', () => {
  const prev = {
    lastRange: { startDate: '2024-01-01', endDate: '2024-06-01' },
    mappings: { e1: { target: 'existing', gatheringTypeId: 1 } },
    imported: { e1: { lastImportedDate: '2024-05-26', gatheringTypeId: 1 } },
  };
  const next = mergeCheckinImportState(prev, {
    lastRange: { startDate: '2025-01-01', endDate: '2025-02-01' },
    mappings: { e2: { target: 'new', newGatheringName: 'Friday' } },
    imported: { e2: { lastImportedDate: '2025-01-31', gatheringTypeId: 9 } },
  });
  assert.strictEqual(next.lastRange.startDate, '2025-01-01');
  assert.ok(next.mappings.e1, 'keeps e1 mapping');
  assert.ok(next.mappings.e2, 'adds e2 mapping');
  assert.strictEqual(next.imported.e1.lastImportedDate, '2024-05-26');
  assert.strictEqual(next.imported.e2.gatheringTypeId, 9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: FAIL — `mergeCheckinImportState is not a function`.

- [ ] **Step 3: Implement**

Add to `checkinsImport.js` (before `module.exports`):

```js
// Merges a new import result into the persisted check-in import state.
// prev may be null or a parsed state object. Per-event mappings/imported markers
// are overlaid (new wins), other events are preserved. lastRange is replaced.
function mergeCheckinImportState(prev, { lastRange, mappings, imported }) {
  const base = prev && typeof prev === 'object' ? prev : {};
  return {
    lastRange: lastRange || base.lastRange || null,
    mappings: { ...(base.mappings || {}), ...(mappings || {}) },
    imported: { ...(base.imported || {}), ...(imported || {}) },
  };
}
```

Add `mergeCheckinImportState` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/checkinsImport.js server/services/planningCenter/checkinsImport.test.js
git commit -m "feat(pco): add mergeCheckinImportState helper"
```

---

## Task 4: Persist column — schema + migration

**Files:**
- Modify: `server/config/schema.js` (church_settings table, near line 110-114)
- Modify: `server/config/database.js` (additive migration block, near line 127-150)

- [ ] **Step 1: Add the column to the schema**

In `server/config/schema.js`, inside the `church_settings` CREATE TABLE, add a column alongside the other `planning_center_*` columns (just before `created_at TEXT DEFAULT (datetime('now')),` at line 113):

```js
  planning_center_last_sync_result TEXT,
  planning_center_checkin_import_state TEXT,
  created_at TEXT DEFAULT (datetime('now')),
```

(Insert only the new `planning_center_checkin_import_state TEXT,` line; the others already exist.)

- [ ] **Step 2: Add the additive migration for existing DBs**

In `server/config/database.js`, find the block that does `PRAGMA table_info(church_settings)` and the series of `ALTER TABLE church_settings ADD COLUMN planning_center_*` calls (around lines 127-150). After the `planning_center_last_sync_result` ALTER (line 150), add:

```js
        if (!settingsCols.some(c => c.name === 'planning_center_checkin_import_state')) {
          db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_checkin_import_state TEXT');
        }
```

(Use the same `settingsCols` variable already declared for that block. If a fresh `PRAGMA table_info` snapshot is needed because `settingsCols` is out of scope at that point, re-read it the same way the surrounding code does.)

- [ ] **Step 3: Verify the migration applies**

Restart the dev server container so the migration runs on existing church DBs:

Run: `docker-compose -f docker-compose.dev.yml restart server`
Then: `docker-compose -f docker-compose.dev.yml logs --tail=40 server`
Expected: server boots with no SQLite errors mentioning `planning_center_checkin_import_state`.

Confirm the column exists (replace `<church_id>` with a real church DB filename):

Run: `docker-compose -f docker-compose.dev.yml exec -T server node -e "const Database=require('better-sqlite3'); const fs=require('fs'); const dir='data/churches'; const f=fs.readdirSync(dir).find(x=>x.endsWith('.sqlite')); const db=new Database(dir+'/'+f); console.log(db.prepare('PRAGMA table_info(church_settings)').all().map(c=>c.name).filter(n=>n.includes('checkin_import')));"`
Expected: prints `[ 'planning_center_checkin_import_state' ]`.

- [ ] **Step 4: Commit**

```bash
git add server/config/schema.js server/config/database.js
git commit -m "feat(pco): add planning_center_checkin_import_state column + migration"
```

---

## Task 5: Server — `onProgress` threading + WebSocket emit during fetch

**Files:**
- Modify: `server/routes/integrations.js` (fetch helpers ~2113-2183; events route ~2287-2316; require websocket service near top of file)

- [ ] **Step 1: Require the websocket singleton**

Near the top of `server/routes/integrations.js`, where other services are required, add (if not already present):

```js
const webSocketService = require('../services/websocket');
```

Confirm it isn't already required: `grep -n "services/websocket" server/routes/integrations.js`. If present, skip this step.

- [ ] **Step 2: Add a progress-emitter factory**

Just above `function fetchAllCheckins(args) {` (line ~2113), add:

```js
// Builds an onProgress callback that emits fetch/write progress to the church's
// sockets. The client filters by jobId. Emission is best-effort: failures are
// swallowed so progress reporting never breaks an import. Returns null when no
// jobId is supplied (e.g. server-internal calls), so callers can pass it through
// unconditionally.
function makeImportProgressEmitter(churchId, jobId, phase) {
  if (!jobId) return undefined;
  return ({ fetched, total }) => {
    const percent = total > 0 ? Math.min(100, Math.round((fetched / total) * 100)) : 0;
    try {
      webSocketService.broadcastToChurch(churchId, 'pco:import_progress', {
        jobId, phase, percent, fetched, total,
      });
    } catch (e) {
      logger.warn('Failed to emit pco:import_progress', { error: e.message });
    }
  };
}
```

- [ ] **Step 3: Thread `onProgress` through `fetchAllCheckins`**

Replace the body of `fetchAllCheckins` (lines ~2113-2132) so it forwards `onProgress` and reports 100% on cache hits:

```js
function fetchAllCheckins(args) {
  const { churchId, startDate, endDate, force = false, onProgress } = args;
  const key = `${churchId}|${startDate}|${endDate}`;
  const cached = checkinsCache.get(key);
  if (!force && cached && (Date.now() - cached.fetchedAt) < CHECKINS_CACHE_TTL_MS) {
    if (onProgress) {
      const n = (cached.payload.data || []).length;
      onProgress({ fetched: n, total: n });
    }
    return Promise.resolve({ payload: cached.payload, timezone: cached.timezone, fetchedAt: cached.fetchedAt });
  }
  return fetchAllCheckinsUncached(args).then((result) => {
    const fetchedAt = Date.now();
    checkinsCache.set(key, { ...result, fetchedAt });
    if (checkinsCache.size > CHECKINS_CACHE_MAX_ENTRIES) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of checkinsCache) if (v.fetchedAt < oldest) { oldest = v.fetchedAt; oldestKey = k; }
      if (oldestKey) checkinsCache.delete(oldestKey);
    }
    return { ...result, fetchedAt };
  });
}
```

- [ ] **Step 4: Emit progress from `fetchAllCheckinsUncached`**

In `fetchAllCheckinsUncached`, accept `onProgress` from the args and emit after the first page and after each batch. Change the signature line:

```js
async function fetchAllCheckinsUncached({ tokens, userId, churchId, startDate, endDate, onProgress }) {
```

After `const total = firstPage.meta?.total_count ?? data.length;` add:

```js
  if (onProgress) onProgress({ fetched: data.length, total });
```

Inside the batch loop, after `included = included.concat(p.included || []);` closes (i.e. after the inner `for (const p of pages)` loop, still inside the outer `for` over batches), add:

```js
    if (onProgress) onProgress({ fetched: data.length, total });
```

- [ ] **Step 5: Pass the emitter from the events route**

In `router.get('/planning-center/checkins/events', ...)`, replace the fetch call (line ~2299) to include a fetching emitter built from `req.query.jobId`:

```js
    const force = req.query.refresh === '1';
    const onProgress = makeImportProgressEmitter(churchId, req.query.jobId, 'fetching');
    const { payload, timezone } = await fetchAllCheckins({ tokens, userId, churchId, startDate, endDate, force, onProgress });
```

- [ ] **Step 6: Verify the server boots**

Run: `docker-compose -f docker-compose.dev.yml restart server && docker-compose -f docker-compose.dev.yml logs --tail=30 server`
Expected: no startup errors; route file loads.

- [ ] **Step 7: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): emit fetch progress over websocket during checkin events load"
```

---

## Task 6: Server — events route enrichment + import-state GET endpoint

**Files:**
- Modify: `server/routes/integrations.js` (events route ~2287-2316; add a `loadCheckinImportState` helper and a new GET route)

- [ ] **Step 1: Add a `loadCheckinImportState` helper**

Above the events route (near `resolveRange`, ~line 2207), add:

```js
// Reads and parses the persisted check-in import state for a church, or null.
async function loadCheckinImportState(churchId) {
  const rows = await Database.query(
    `SELECT planning_center_checkin_import_state AS s FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  if (!rows[0] || !rows[0].s) return null;
  try { return JSON.parse(rows[0].s); } catch { return null; }
}
```

- [ ] **Step 2: Enrich the events response with saved state**

In the events route, replace the `withSuggestions`/`res.json` block (lines ~2307-2312) with:

```js
    const state = await loadCheckinImportState(churchId);
    const savedMappings = (state && state.mappings) || {};
    const importedMarkers = (state && state.imported) || {};
    const withSuggestions = events.map((e) => ({
      ...e,
      suggestedGatheringTypeId: checkinsImport.suggestGatheringId(e.eventName, gatherings, e.serviceTime),
      savedMapping: savedMappings[e.pcoEventId] || null,
      alreadyImportedThrough: (importedMarkers[e.pcoEventId] && importedMarkers[e.pcoEventId].lastImportedDate) || null,
    }));

    res.json({ success: true, startDate, endDate, events: withSuggestions });
```

(`e` already carries `suggestedSchedule` from Task 2.)

- [ ] **Step 3: Add the import-state GET endpoint**

Immediately after the events route's closing `});`, add:

```js
// Returns persisted import settings so the client can pre-fill the date range.
router.get('/planning-center/checkin-import-state', async (req, res) => {
  try {
    const state = await loadCheckinImportState(req.user.church_id);
    res.json({ success: true, lastRange: (state && state.lastRange) || null });
  } catch (error) {
    logger.error('PCO checkin import-state error:', error);
    res.status(500).json({ success: false, error: 'Failed to load import state.' });
  }
});
```

- [ ] **Step 4: Verify the server boots**

Run: `docker-compose -f docker-compose.dev.yml restart server && docker-compose -f docker-compose.dev.yml logs --tail=30 server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): enrich checkin events with saved mappings + add import-state endpoint"
```

---

## Task 7: Server — execute route: schedules, staff-user assignment, roster fill, persist

**Files:**
- Modify: `server/routes/integrations.js` (`runCheckinImport` ~2686-2877; execute route ~2891-2899)

This task changes the commit path. Read `runCheckinImport` fully before editing.

- [ ] **Step 1: Hoist values needed after the transaction + accept jobId**

At the top of `runCheckinImport`, after `const mappings = ...` (line ~2690), add outer-scope holders and the jobId:

```js
  const jobId = req.body.jobId;
  // Captured inside the transaction, read afterwards to persist import state.
  let committedEventToGathering = new Map();
  const newGatheringIds = new Set();
  let userAssignmentsCreated = 0;
```

- [ ] **Step 2: Set schedule fields when creating new gatherings**

In the commit transaction, replace the "new gathering" INSERT (lines ~2785-2792) with one that writes schedule columns and records the new id + user-assignment job:

```js
    const userAssignmentJobs = []; // { gatheringTypeId, userAssignment }
    for (const m of mappings) {
      if (m.target === 'new') {
        const sched = m.schedule || {};
        const irregular = sched.irregular === true;
        const dayOfWeek = irregular ? null : (sched.dayOfWeek || null);
        const frequency = irregular ? null : (sched.frequency || null);
        const startTime = sched.startTime || null;
        const ins = await conn.query(
          `INSERT INTO gathering_types (name, attendance_type, day_of_week, start_time, frequency, created_by, church_id)
           VALUES (?, 'standard', ?, ?, ?, ?, ?)`,
          [m.newGatheringName, dayOfWeek, startTime, frequency, userId, churchId]
        );
        eventToGathering.set(m.pcoEventId, ins.insertId);
        newGatheringIds.add(ins.insertId);
        userAssignmentJobs.push({ gatheringTypeId: ins.insertId, userAssignment: m.userAssignment });
        gatheringsCreated++;
      } else if (m.gatheringTypeId) {
        eventToGathering.set(m.pcoEventId, m.gatheringTypeId);
      }
    }
```

(This replaces the existing `for (const m of mappings) { if (m.target === 'new') {...} else if ...}` block.)

- [ ] **Step 3: Replace the onboarding-gated roster fill with new-gathering roster fill**

Replace the entire `if (assignToGatherings) { ... }` block (lines ~2854-2873) with an unconditional roster fill restricted to newly-created gatherings, plus the staff-user assignment writes:

```js
    // Member roster auto-fill: add active, recently-attending people to the roll
    // of each NEWLY CREATED gathering they attended. Existing gatherings are left
    // untouched. (Onboarding maps everything to new gatherings, so its prior
    // behaviour is preserved.)
    const newEventToGathering = new Map();
    for (const [evId, gid] of eventToGathering) {
      if (newGatheringIds.has(gid)) newEventToGathering.set(evId, gid);
    }
    if (newEventToGathering.size > 0) {
      const activeRows = await conn.query(
        `SELECT id FROM individuals WHERE church_id = ? AND is_active = 1`,
        [churchId]
      );
      const activeIndividualIds = new Set(activeRows.map((r) => r.id));
      const today = new Date().toISOString().slice(0, 10);
      const adds = checkinsImport.buildGatheringListAdds(
        normalized, activeIndividualIds, personToIndividual, newEventToGathering, recencyWeeks, today
      );
      for (const a of adds) {
        const r = await conn.query(
          `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(gathering_type_id, individual_id) DO NOTHING`,
          [a.gatheringTypeId, a.individualId, userId, churchId]
        );
        if (r.affectedRows && r.affectedRows > 0) assignmentsCreated++;
      }
    }

    // Staff-user assignment for new gatherings: none / me / copy-from-source.
    for (const job of userAssignmentJobs) {
      const ua = job.userAssignment || { mode: 'none' };
      if (ua.mode === 'me') {
        const r = await conn.query(
          `INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by, church_id)
           VALUES (?, ?, ?, ?) ON CONFLICT(user_id, gathering_type_id) DO NOTHING`,
          [userId, job.gatheringTypeId, userId, churchId]
        );
        if (r.affectedRows && r.affectedRows > 0) userAssignmentsCreated++;
      } else if (ua.mode === 'copy' && ua.sourceGatheringTypeId) {
        const src = await conn.query(
          `SELECT user_id FROM user_gathering_assignments WHERE gathering_type_id = ? AND church_id = ?`,
          [ua.sourceGatheringTypeId, churchId]
        );
        for (const s of src) {
          const r = await conn.query(
            `INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by, church_id)
             VALUES (?, ?, ?, ?) ON CONFLICT(user_id, gathering_type_id) DO NOTHING`,
            [s.user_id, job.gatheringTypeId, userId, churchId]
          );
          if (r.affectedRows && r.affectedRows > 0) userAssignmentsCreated++;
        }
      }
    }

    committedEventToGathering = eventToGathering;
```

Note: `assignToGatherings` is now unused for roster logic. Leave the variable declaration (it's harmless) or remove its read; do NOT remove `recencyWeeks` — it's still used. The `recencyWeeks` default of 8 already applies when the body omits it.

- [ ] **Step 4: Emit `writing`-phase progress during record writes**

At the start of the writes loop (just before `for (const w of writes) {`, line ~2803), add a writing emitter and a counter:

```js
    const writeProgress = makeImportProgressEmitter(churchId, jobId, 'writing');
    const totalWrites = writes.length;
    let writeIndex = 0;
```

Inside the loop, right after `latestPresent.set(w.individualId, w.date);` line (end of loop body, ~2839), add:

```js
      writeIndex++;
      if (writeProgress && (writeIndex % 50 === 0 || writeIndex === totalWrites)) {
        writeProgress({ fetched: writeIndex, total: totalWrites });
      }
```

- [ ] **Step 5: Pass the fetching emitter into the execute fetch**

In `runCheckinImport`, replace the fetch call (line ~2727):

```js
  const onProgress = makeImportProgressEmitter(churchId, jobId, 'fetching');
  const { payload, timezone } = await fetchAllCheckins({ tokens, userId, churchId, startDate, endDate, onProgress });
```

- [ ] **Step 6: Persist import state after a successful commit**

After the `await Database.transaction(...)` call closes (just before `return { ...summary, ... }` at line ~2876), but only on the commit path (this whole block runs only when `commit` is true since preview returns earlier), add:

```js
  // Persist settings so a future import can skip re-deciding mappings.
  try {
    const eventSummaries = checkinsImport.summarizeEvents(normalized);
    const summaryByEvent = new Map(eventSummaries.map((e) => [e.pcoEventId, e]));
    const mappingsToSave = {};
    const importedToSave = {};
    for (const m of mappings) {
      const gid = committedEventToGathering.get(m.pcoEventId);
      mappingsToSave[m.pcoEventId] = {
        target: m.target,
        gatheringTypeId: gid || m.gatheringTypeId || null,
        newGatheringName: m.newGatheringName || null,
        schedule: m.schedule || null,
        userAssignment: m.userAssignment || null,
      };
      const s = summaryByEvent.get(m.pcoEventId);
      if (s && gid) importedToSave[m.pcoEventId] = { lastImportedDate: s.lastDate, gatheringTypeId: gid };
    }
    const prevState = await loadCheckinImportState(churchId);
    const nextState = checkinsImport.mergeCheckinImportState(prevState, {
      lastRange: { startDate, endDate },
      mappings: mappingsToSave,
      imported: importedToSave,
    });
    await Database.query(
      `UPDATE church_settings SET planning_center_checkin_import_state = ? WHERE church_id = ?`,
      [JSON.stringify(nextState), churchId]
    );
  } catch (e) {
    logger.warn('Failed to persist checkin import state', { error: e.message });
  }
```

- [ ] **Step 7: Include the new counter in the return value**

Update the final return (line ~2876) to expose `userAssignmentsCreated`:

```js
  return { ...summary, createdPeople, gatheringsCreated, sessionsCreated, recordsWritten, recordsSkipped, assignmentsCreated, userAssignmentsCreated };
```

- [ ] **Step 8: Verify the server boots**

Run: `docker-compose -f docker-compose.dev.yml restart server && docker-compose -f docker-compose.dev.yml logs --tail=40 server`
Expected: no startup or syntax errors.

- [ ] **Step 9: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): write schedules, staff assignments, rosters, and persist state on import"
```

---

## Task 8: Client — API method signatures

**Files:**
- Modify: `client/src/services/api.ts:846-870`

- [ ] **Step 1: Extend the check-in API methods**

Replace the block from `getCheckinEvents` through `executeCheckinImport` (lines ~847-870) with:

```ts
  getCheckinEvents: (params: { startDate?: string; endDate?: string; jobId?: string }) =>
    api.get('/integrations/planning-center/checkins/events', { params, timeout: 120000 }),
  getCheckinImportState: () =>
    api.get('/integrations/planning-center/checkin-import-state'),
  previewCheckinImport: (body: {
    startDate?: string;
    endDate?: string;
    mappings: Array<{
      pcoEventId: string;
      target: 'existing' | 'new';
      gatheringTypeId?: number;
      newGatheringName?: string;
    }>;
  }) => api.post('/integrations/planning-center/import-checkins/preview', body, { timeout: 120000 }),
  executeCheckinImport: (body: {
    startDate?: string;
    endDate?: string;
    jobId?: string;
    mappings: Array<{
      pcoEventId: string;
      target: 'existing' | 'new';
      gatheringTypeId?: number;
      newGatheringName?: string;
      schedule?: { dayOfWeek: string | null; startTime: string | null; frequency: string | null; irregular: boolean };
      userAssignment?: { mode: 'none' | 'me' | 'copy'; sourceGatheringTypeId?: number };
    }>;
    assignToGatherings?: boolean;
    recencyWeeks?: number;
  }) => api.post('/integrations/planning-center/import-checkins/execute', body, { timeout: 120000 }),
```

- [ ] **Step 2: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat(pco): extend checkin import API signatures (jobId, schedule, assignment)"
```

---

## Task 9: Client — progress bar + socket subscription

**Files:**
- Modify: `client/src/components/PCOCheckinImport.tsx`

- [ ] **Step 1: Import the websocket hook and add progress state**

At the top, change the imports and add state. Replace line 2 (`import { integrationsAPI, gatheringsAPI } from '../services/api';`) region to also import the hook:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { integrationsAPI, gatheringsAPI } from '../services/api';
import { useWebSocket } from '../contexts/WebSocketContext';
```

Inside the component, after `const autoLoadStarted = useRef(false);` (line ~56), add:

```tsx
  const { socket } = useWebSocket();
  const [progress, setProgress] = useState<{ phase: string; percent: number } | null>(null);
  const jobIdRef = useRef<string>('');
```

- [ ] **Step 2: Add a jobId generator**

Below the state declarations, add a helper:

```tsx
  const newJobId = () => {
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    jobIdRef.current = id;
    return id;
  };
```

- [ ] **Step 3: Subscribe to progress events**

Add an effect (after the existing effects, near line 119):

```tsx
  useEffect(() => {
    if (!socket) return;
    const handler = (data: { jobId: string; phase: string; percent: number }) => {
      if (data.jobId !== jobIdRef.current) return;
      setProgress({ phase: data.phase, percent: data.percent });
    };
    socket.on('pco:import_progress', handler);
    return () => { socket.off('pco:import_progress', handler); };
  }, [socket]);
```

- [ ] **Step 4: Send jobId on fetch and execute; clear progress when done**

In `findEvents`, change the API call and progress lifecycle. Replace the `try` body's first two lines (lines ~83-86):

```tsx
    const jobId = newJobId();
    setProgress({ phase: 'fetching', percent: 0 });
    try {
      const r = await integrationsAPI.getCheckinEvents({ ...query, jobId });
      setEvents(r.data.events || []);
      setStartDate(r.data.startDate ?? '');
      setEndDate(r.data.endDate ?? '');
```

In the `finally` of `findEvents`, also clear progress:

```tsx
    } finally { setLoading(false); setProgress(null); }
```

In `runExecute`, set jobId on the body and clear progress in `finally`. Replace the body assembly (lines ~134-140):

```tsx
    const jobId = newJobId();
    setProgress({ phase: 'fetching', percent: 0 });
    try {
      const body: any = { startDate, endDate, jobId, mappings: validMappings() };
      if (assignToGatherings) {
        body.assignToGatherings = true;
        body.recencyWeeks = recencyWeeks;
      }
      const r = await integrationsAPI.executeCheckinImport(body);
```

And its `finally`:

```tsx
    } finally { setLoading(false); setProgress(null); }
```

- [ ] **Step 5: Render the progress bar**

Just after the `{error && ...}` line (line ~200), add:

```tsx
      {progress && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-600 dark:text-gray-300">
            <span>{progress.phase === 'writing' ? 'Writing attendance…' : 'Fetching from Planning Center…'}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded h-2 overflow-hidden">
            <div className="bg-primary-600 h-2 transition-all duration-300" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}
```

- [ ] **Step 6: Verify the client builds**

Run: `docker-compose -f docker-compose.dev.yml build client`
Expected: build succeeds (TypeScript compiles).

- [ ] **Step 7: Commit**

```bash
git add client/src/components/PCOCheckinImport.tsx
git commit -m "feat(pco): show live fetch/write progress bar in checkin import"
```

---

## Task 10: Client — new-gathering sub-panel (schedule + staff-user) and saved-state pre-fill

**Files:**
- Modify: `client/src/components/PCOCheckinImport.tsx`

- [ ] **Step 1: Extend the local types**

Replace the `PcoEvent` interface and `Mapping` type (lines ~4-23) with:

```tsx
interface ScheduleSuggestion {
  dayOfWeek: string | null;
  startTime: string | null;
  frequency: string | null;
  irregular: boolean;
}

interface PcoEvent {
  pcoEventId: string;
  eventName: string;
  checkinCount: number;
  sessionCount: number;
  firstDate: string | null;
  lastDate: string | null;
  serviceTime?: string;
  suggestedGatheringTypeId?: number | null;
  suggestedSchedule?: ScheduleSuggestion;
  savedMapping?: Mapping | null;
  alreadyImportedThrough?: string | null;
}

interface Gathering { id: number; name: string; }

type UserAssignment = { mode: 'none' | 'me' | 'copy'; sourceGatheringTypeId?: number };

type Mapping = {
  target: 'skip' | 'existing' | 'new';
  gatheringTypeId?: number;
  newGatheringName?: string;
  schedule?: ScheduleSuggestion;
  userAssignment?: UserAssignment;
};
```

- [ ] **Step 2: Default new-gathering mappings from saved state / suggestions**

In `findEvents`, replace the defaults-building loop (lines ~88-96) so it prefers a saved mapping, else builds a new mapping carrying the suggested schedule:

```tsx
      const defaults: Record<string, Mapping> = {};
      for (const e of r.data.events || []) {
        if (e.savedMapping) {
          defaults[e.pcoEventId] = e.savedMapping;
        } else if (e.suggestedGatheringTypeId) {
          defaults[e.pcoEventId] = { target: 'existing', gatheringTypeId: e.suggestedGatheringTypeId };
        } else {
          defaults[e.pcoEventId] = {
            target: 'new',
            newGatheringName: e.eventName,
            schedule: e.suggestedSchedule || { dayOfWeek: null, startTime: null, frequency: null, irregular: false },
            userAssignment: { mode: 'none' },
          };
        }
      }
      setMappings(defaults);
```

- [ ] **Step 3: Send schedule + userAssignment in the payload**

Replace `buildMappingsPayload` (lines ~64-72) so new mappings carry the extra fields:

```tsx
  const buildMappingsPayload = () =>
    Object.entries(mappings)
      .filter(([, m]) => m.target !== 'skip')
      .map(([pcoEventId, m]) => ({
        pcoEventId,
        target: m.target as 'existing' | 'new',
        gatheringTypeId: m.target === 'existing' ? m.gatheringTypeId : undefined,
        newGatheringName: m.target === 'new' ? m.newGatheringName : undefined,
        schedule: m.target === 'new' ? m.schedule : undefined,
        userAssignment: m.target === 'new' ? m.userAssignment : undefined,
      }));
```

- [ ] **Step 4: Pre-fill dates from saved state on mount**

Add an effect after the gatherings-loading effect (after line 62):

```tsx
  useEffect(() => {
    integrationsAPI.getCheckinImportState()
      .then((r: any) => {
        const lr = r.data?.lastRange;
        if (lr) { setStartDate(lr.startDate || ''); setEndDate(lr.endDate || ''); }
      })
      .catch(() => { /* no saved state */ });
  }, []);
```

- [ ] **Step 5: Render the sub-panel and imported badge**

In the table body `.map`, the current `<tr>` ends at line ~241. Replace the whole returned row (from `return (` at line 213 to the matching `);` at line 241) with a fragment that adds an imported badge in the event cell and a full-width config sub-row for `new` targets:

```tsx
                return (
                  <React.Fragment key={ev.pcoEventId}>
                    <tr className="border-t border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100">
                      <td className="py-2">
                        {ev.eventName}
                        {ev.alreadyImportedThrough && (
                          <span className="ml-2 inline-block text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                            Imported through {ev.alreadyImportedThrough}
                          </span>
                        )}
                      </td>
                      <td>{ev.checkinCount} ({ev.sessionCount} dates)</td>
                      <td>{ev.firstDate ?? '—'} → {ev.lastDate ?? '—'}</td>
                      <td className="space-x-2">
                        <select value={m.target}
                          onChange={(e) => setMap(ev.pcoEventId, { target: e.target.value as Mapping['target'] })}
                          className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-1 py-1">
                          <option value="skip">Skip</option>
                          <option value="new">New gathering</option>
                          <option value="existing">Existing gathering</option>
                        </select>
                        {m.target === 'existing' && (
                          <select value={m.gatheringTypeId || ''}
                            onChange={(e) => setMap(ev.pcoEventId, { gatheringTypeId: Number(e.target.value) })}
                            className="border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-1 py-1">
                            <option value="">Choose…</option>
                            {gatherings.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                        )}
                      </td>
                    </tr>
                    {m.target === 'new' && (
                      <tr className="border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                        <td colSpan={4} className="py-3">
                          {renderNewGatheringPanel(ev, m)}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
```

- [ ] **Step 6: Implement `renderNewGatheringPanel` + schedule helpers**

Inside the component, before the `return (`, add the panel renderer and helpers:

```tsx
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const setSchedule = (id: string, patch: Partial<ScheduleSuggestion>) =>
    setMappings((prev) => ({
      ...prev,
      [id]: { ...prev[id], schedule: { dayOfWeek: null, startTime: null, frequency: null, irregular: false, ...prev[id]?.schedule, ...patch } },
    }));

  const setAssignment = (id: string, patch: Partial<UserAssignment>) =>
    setMappings((prev) => ({
      ...prev,
      [id]: { ...prev[id], userAssignment: { mode: 'none', ...prev[id]?.userAssignment, ...patch } },
    }));

  const renderNewGatheringPanel = (ev: PcoEvent, m: Mapping) => {
    const sched = m.schedule || { dayOfWeek: null, startTime: null, frequency: null, irregular: false };
    const ua = m.userAssignment || { mode: 'none' as const };
    const inputCls = 'border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded px-2 py-1 text-sm';
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-gray-700 dark:text-gray-300">Name
            <input value={m.newGatheringName || ''} placeholder="Gathering name"
              onChange={(e) => setMap(ev.pcoEventId, { newGatheringName: e.target.value })}
              className={`block ${inputCls}`} />
          </label>
          <label className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-1 self-center">
            <input type="checkbox" checked={sched.irregular}
              onChange={(e) => setSchedule(ev.pcoEventId, { irregular: e.target.checked })} />
            Irregular (no fixed schedule)
          </label>
        </div>
        {!sched.irregular && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm text-gray-700 dark:text-gray-300">Day
              <select value={sched.dayOfWeek || ''} onChange={(e) => setSchedule(ev.pcoEventId, { dayOfWeek: e.target.value || null })}
                className={`block ${inputCls}`}>
                <option value="">—</option>
                {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="text-sm text-gray-700 dark:text-gray-300">Time
              <input type="time" value={sched.startTime || ''} onChange={(e) => setSchedule(ev.pcoEventId, { startTime: e.target.value || null })}
                className={`block ${inputCls}`} />
            </label>
            <label className="text-sm text-gray-700 dark:text-gray-300">Frequency
              <select value={sched.frequency || ''} onChange={(e) => setSchedule(ev.pcoEventId, { frequency: e.target.value || null })}
                className={`block ${inputCls}`}>
                <option value="">—</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
          </div>
        )}
        <label className="text-sm text-gray-700 dark:text-gray-300 block">Assign staff users
          <select
            value={ua.mode === 'copy' ? `copy:${ua.sourceGatheringTypeId ?? ''}` : ua.mode}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'none' || v === 'me') setAssignment(ev.pcoEventId, { mode: v, sourceGatheringTypeId: undefined });
              else if (v.startsWith('copy:')) setAssignment(ev.pcoEventId, { mode: 'copy', sourceGatheringTypeId: Number(v.slice(5)) });
            }}
            className={`block ${inputCls}`}>
            <option value="none">None</option>
            <option value="me">Me</option>
            {gatherings.map((g) => <option key={g.id} value={`copy:${g.id}`}>Same as {g.name}</option>)}
          </select>
        </label>
      </div>
    );
  };
```

- [ ] **Step 7: Remove the now-duplicated inline name input**

The old inline `m.target === 'new'` name input (previously lines ~226-230) is now replaced by the sub-panel. Confirm it no longer appears in the `<td className="space-x-2">` cell (Step 5's replacement already omits it). No further action if Step 5 was applied verbatim.

- [ ] **Step 8: Verify the client builds**

Run: `docker-compose -f docker-compose.dev.yml build client`
Expected: TypeScript compiles, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/PCOCheckinImport.tsx
git commit -m "feat(pco): new-gathering config sub-panel with schedule, staff assignment, saved-state pre-fill"
```

---

## Task 11: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Bring up the dev stack**

Run: `docker-compose -f docker-compose.dev.yml up -d`
Then confirm: `docker-compose -f docker-compose.dev.yml ps` shows server + client healthy.

- [ ] **Step 2: Verify the flow in the UI**

In a browser (Settings → Integrations → Planning Center check-in import), confirm:
- A progress bar with a live `%` shows during the initial fetch and during import.
- A "new gathering" row expands an inline sub-panel with name, schedule (day/time/frequency or Irregular), and a staff-user dropdown (None / Me / Same as <gathering>).
- Pre-filled schedule matches the event's cadence; an annual event (if present) shows Irregular.
- After importing, re-opening the importer pre-fills the date range and remembered mappings, and already-imported events show an "Imported through <date>" badge.
- After import of a new gathering: that gathering exists with the chosen schedule, recent active attendees appear on its roll, and the chosen staff users are assigned.

- [ ] **Step 3: Confirm no server errors**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=60 server`
Expected: no errors during the import.

- [ ] **Step 4: Final commit (if any verification fixes were made)**

```bash
git add -A
git commit -m "chore(pco): verification fixes for checkin import improvements"
```

---

## Self-Review Notes

- **Spec coverage:** Progress (Tasks 5, 7, 9) ✓; persistence (Tasks 3, 4, 6, 7) ✓; roster auto-fill for new gatherings (Task 7) ✓; staff-user assignment None/Me/Copy (Tasks 7, 10) ✓; editable pre-filled schedule + irregular handling (Tasks 1, 2, 7, 10) ✓; inline sub-panel + non-destructive re-runs with badge (Tasks 6, 10) ✓.
- **Type consistency:** `ScheduleSuggestion`/`UserAssignment`/`Mapping` shapes match between client (`api.ts`, component) and server persisted/consumed JSON (`schedule.{dayOfWeek,startTime,frequency,irregular}`, `userAssignment.{mode,sourceGatheringTypeId}`). Helper names `deriveSchedule`, `mergeCheckinImportState`, `makeImportProgressEmitter`, `loadCheckinImportState`, `renderNewGatheringPanel` are used consistently.
- **Known limitation:** `startTime` is only auto-derived for multi-service (split) events that carry `serviceTime`; single-service events leave time blank for the user to fill — acceptable per spec.
