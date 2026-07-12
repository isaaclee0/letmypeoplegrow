# Gate PCO Check-in Import Behind Linked People Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block Planning Center check-in (attendance history) import until a church has linked at least one person to PCO, so importing check-ins never creates a flood of duplicate individuals instead of matching existing ones.

**Architecture:** Add a small, testable gate module (`server/services/planningCenter/checkinGate.js`, mirroring the existing `mode.js` pattern) that answers "has this church linked anyone to PCO yet?" and produces a standard 403 rejection. Wire it into the two places check-in import can be triggered server-side (`/checkins/events` and the shared `runCheckinImport` used by preview+execute), surface the same signal through `/checkins/availability` so the client can avoid dead-end UI, and update both call sites (`PlanningCenterIntegrationPanel.tsx`, `PCOCheckinImport.tsx`, `OnboardingPage.tsx`) to react to it.

**Tech Stack:** Node/Express + `better-sqlite3` backend, React/TypeScript frontend, Node's built-in `node:test` runner with the repo's `withTestChurchDb` DB-integration harness (`server/test-helpers/testChurchDb.js`) for backend tests, Vitest for client tests.

---

## Why this is needed (context for the engineer)

`runCheckinImport` (`server/routes/integrations.js:2615`) matches each PCO check-in's person **only by `planning_center_id`** (`checkinsImport.resolvePeople`, `server/services/planningCenter/checkinsImport.js:262`) — never by name. Anyone in the check-in data without a matching `planning_center_id` already set on an LMPG individual gets a **brand-new individual row created on the fly** (`server/routes/integrations.js:2712-2720`, `is_active = 0`, `planning_center_id` set at creation).

If a church imports check-in history **before** ever running a PCO sync batch (i.e. before any individual has `planning_center_id` set), every PCO attendee in range becomes a newly-created duplicate — including people who already exist in LMPG as manually-entered records. Those manual originals stay permanently unlinked afterward too: once the duplicate claims a PCO id, a later batch sync's matcher only considers `availablePco` (PCO people not already linked to *someone*), so the original record can no longer match that same PCO person by name.

There is currently **zero gating** on this: the standalone Integrations tab renders `PCOCheckinImport` regardless of whether any batch has ever run (`PlanningCenterIntegrationPanel.tsx:184-196`, `:497-517`), and onboarding has a real gap too — clicking "Cancel" on the first batch setup (`OnboardingPage.tsx:379`, `onCancel={() => setStep('pco-gatherings')}`) jumps straight to the check-in import step having linked nobody.

---

## Task 1: Add the `checkinGate` service module

**Files:**
- Create: `server/services/planningCenter/checkinGate.js`
- Create: `server/services/planningCenter/checkinGate.dbintegration.test.js`

- [ ] **Step 1: Write the failing DB-integration test**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { hasLinkedPeople, notLinkedResponse, PCO_NOT_LINKED } = require('./checkinGate');

async function seedIndividual(churchId, { planningCenterId = null } = {}) {
  const res = await Database.query(
    `INSERT INTO individuals (first_name, last_name, church_id, is_active, planning_center_id)
     VALUES ('Test', 'Person', ?, 1, ?)`,
    [churchId, planningCenterId]
  );
  return res.insertId;
}

test('hasLinkedPeople: false for a church with no individuals at all', async () => {
  await withTestChurchDb(async (churchId) => {
    assert.strictEqual(await hasLinkedPeople(churchId), false);
  });
});

test('hasLinkedPeople: false when individuals exist but none have a planning_center_id', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedIndividual(churchId);
    await seedIndividual(churchId);
    assert.strictEqual(await hasLinkedPeople(churchId), false);
  });
});

test('hasLinkedPeople: true once at least one individual has a planning_center_id', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedIndividual(churchId);
    await seedIndividual(churchId, { planningCenterId: 'pco_123' });
    assert.strictEqual(await hasLinkedPeople(churchId), true);
  });
});

test('hasLinkedPeople: is scoped per church (church isolation)', async () => {
  await withTestChurchDb(async (churchIdA) => {
    await withTestChurchDb(async (churchIdB) => {
      await seedIndividual(churchIdB, { planningCenterId: 'pco_999' });
      assert.strictEqual(await hasLinkedPeople(churchIdA), false);
      assert.strictEqual(await hasLinkedPeople(churchIdB), true);
    });
  });
});

test('notLinkedResponse: default message and PCO_NOT_LINKED code', () => {
  const body = notLinkedResponse();
  assert.strictEqual(body.code, PCO_NOT_LINKED);
  assert.match(body.error, /link/i);
});

test('notLinkedResponse: accepts a custom message', () => {
  const body = notLinkedResponse('custom message');
  assert.strictEqual(body.error, 'custom message');
  assert.strictEqual(body.code, PCO_NOT_LINKED);
});
```

- [ ] **Step 2: Run it to confirm it fails (module doesn't exist yet)**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/checkinGate.dbintegration.test.js`
Expected: FAIL — `Cannot find module './checkinGate'`.

- [ ] **Step 3: Write the module**

```javascript
// server/services/planningCenter/checkinGate.js
// Gate for PCO check-in (attendance history) import.
//
// The check-in importer matches PCO attendees to LMPG individuals only by
// planning_center_id (see checkinsImport.js's resolvePeople) — never by name.
// Importing before any person has ever been linked would silently create a
// brand-new duplicate individual for every attendee instead of matching
// existing ones, and any pre-existing manual record with the same name becomes
// permanently unlinkable afterward (the PCO person is already claimed). This
// module answers "has this church linked anyone yet?" so routes can refuse to
// import until that's no longer true.

const Database = require('../../config/database');

const PCO_NOT_LINKED = 'PCO_NOT_LINKED';

// True once at least one individual in this church has planning_center_id set,
// however that link happened (a sync batch, a manual link, or a prior check-in
// import that already matched someone).
async function hasLinkedPeople(churchId) {
  const rows = await Database.query(
    `SELECT 1 FROM individuals WHERE church_id = ? AND planning_center_id IS NOT NULL LIMIT 1`,
    [churchId]
  );
  return rows.length > 0;
}

// Standard reject payload so the frontend can render a uniform message.
function notLinkedResponse(message) {
  return {
    error: message || 'Link at least one person to Planning Center before importing check-in history.',
    code: PCO_NOT_LINKED,
  };
}

module.exports = { PCO_NOT_LINKED, hasLinkedPeople, notLinkedResponse };
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/checkinGate.dbintegration.test.js`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/checkinGate.js server/services/planningCenter/checkinGate.dbintegration.test.js
git commit -m "feat(pco): add checkinGate module to detect whether a church has linked anyone"
```

---

## Task 2: Wire the gate into the check-in import routes

**Files:**
- Modify: `server/routes/integrations.js`

- [ ] **Step 1: Import the gate near the other PCO service requires**

```javascript
// old_string
const pcoSync = require('../services/planningCenterSync');
const { tallyField } = require('../services/planningCenter/summary');
const { searchPcoPeople } = require('../services/planningCenter/peopleSearch');
const { resolveManualLinks } = require('../services/planningCenter/selectionValidation');
const metadataCache = require('../services/planningCenter/metadataCache');
const { isEligible } = require('../services/planningCenter/eligibility');
```

```javascript
// new_string
const pcoSync = require('../services/planningCenterSync');
const { tallyField } = require('../services/planningCenter/summary');
const { searchPcoPeople } = require('../services/planningCenter/peopleSearch');
const { resolveManualLinks } = require('../services/planningCenter/selectionValidation');
const metadataCache = require('../services/planningCenter/metadataCache');
const { isEligible } = require('../services/planningCenter/eligibility');
const { hasLinkedPeople, notLinkedResponse } = require('../services/planningCenter/checkinGate');
```

- [ ] **Step 2: Gate `/planning-center/checkins/events`**

```javascript
// old_string
// List distinct PCO events that have check-ins in range (for the mapping screen).
router.get('/planning-center/checkins/events', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const { startDate, endDate } = resolveRange(req.query.startDate, req.query.endDate);
```

```javascript
// new_string
// List distinct PCO events that have check-ins in range (for the mapping screen).
router.get('/planning-center/checkins/events', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    if (!(await hasLinkedPeople(churchId))) {
      return res.status(403).json(notLinkedResponse());
    }
    const { startDate, endDate } = resolveRange(req.query.startDate, req.query.endDate);
```

- [ ] **Step 3: Gate the shared `runCheckinImport` (covers both preview and execute)**

```javascript
// old_string
async function runCheckinImport({ req, commit }) {
  const userId = req.user.id;
  const churchId = req.user.church_id;
  const { startDate, endDate } = resolveRange(req.body.startDate, req.body.endDate);
```

```javascript
// new_string
async function runCheckinImport({ req, commit }) {
  const userId = req.user.id;
  const churchId = req.user.church_id;
  if (!(await hasLinkedPeople(churchId))) {
    const body = notLinkedResponse();
    const err = new Error(body.error);
    err.statusCode = 403;
    err.code = body.code;
    throw err;
  }
  const { startDate, endDate } = resolveRange(req.body.startDate, req.body.endDate);
```

- [ ] **Step 4: Propagate `error.code` through the preview/execute catch blocks so the client can tell this apart from other failures**

```javascript
// old_string
// Preview — no writes.
router.post('/planning-center/import-checkins/preview', async (req, res) => {
  try {
    const summary = await runCheckinImport({ req, commit: false });
    res.json({ success: true, ...summary });
  } catch (error) {
    logger.error('PCO check-in preview error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// Execute — writes inside a transaction.
router.post('/planning-center/import-checkins/execute', async (req, res) => {
  try {
    const summary = await runCheckinImport({ req, commit: true });
    res.json({ success: true, ...summary });
  } catch (error) {
    logger.error('PCO check-in execute error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});
```

```javascript
// new_string
// Preview — no writes.
router.post('/planning-center/import-checkins/preview', async (req, res) => {
  try {
    const summary = await runCheckinImport({ req, commit: false });
    res.json({ success: true, ...summary });
  } catch (error) {
    logger.error('PCO check-in preview error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
  }
});

// Execute — writes inside a transaction.
router.post('/planning-center/import-checkins/execute', async (req, res) => {
  try {
    const summary = await runCheckinImport({ req, commit: true });
    res.json({ success: true, ...summary });
  } catch (error) {
    logger.error('PCO check-in execute error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
  }
});
```

- [ ] **Step 5: Surface `peopleLinked` from `/planning-center/checkins/availability` so the client can avoid a dead-end nudge**

```javascript
// old_string
router.get('/planning-center/checkins/availability', async (req, res) => {
  try {
    const churchId = req.user.church_id;

    // Once a check-in import has happened, never nudge again.
    const state = await loadCheckinImportState(churchId);
    const hasImported = !!(state && state.imported && Object.keys(state.imported).length > 0);
    if (hasImported) {
      return res.json({ success: true, hasImported: true, available: false });
    }

    const owned = await getChurchPlanningCenterTokens(churchId);
    if (!owned || !owned.tokens.access_token) {
      return res.json({ success: true, hasImported: false, available: false });
    }

    const response = await makePlanningCenterRequest(
      'https://api.planningcenteronline.com/check-ins/v2/check_ins?per_page=1',
      owned.tokens, owned.ownerUserId, churchId
    );
    const total = (response && response.status === 200)
      ? (response.data?.meta?.total_count ?? (response.data?.data?.length || 0))
      : 0;
    res.json({ success: true, hasImported: false, available: total > 0, total });
  } catch (error) {
    logger.error('PCO checkin availability error:', error);
    // Non-fatal: the UI just won't prompt.
    res.json({ success: true, hasImported: false, available: false });
  }
});
```

```javascript
// new_string
router.get('/planning-center/checkins/availability', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const peopleLinked = await hasLinkedPeople(churchId);

    // Once a check-in import has happened, never nudge again.
    const state = await loadCheckinImportState(churchId);
    const hasImported = !!(state && state.imported && Object.keys(state.imported).length > 0);
    if (hasImported) {
      return res.json({ success: true, hasImported: true, available: false, peopleLinked });
    }

    const owned = await getChurchPlanningCenterTokens(churchId);
    if (!owned || !owned.tokens.access_token) {
      return res.json({ success: true, hasImported: false, available: false, peopleLinked });
    }

    const response = await makePlanningCenterRequest(
      'https://api.planningcenteronline.com/check-ins/v2/check_ins?per_page=1',
      owned.tokens, owned.ownerUserId, churchId
    );
    const total = (response && response.status === 200)
      ? (response.data?.meta?.total_count ?? (response.data?.data?.length || 0))
      : 0;
    res.json({ success: true, hasImported: false, available: total > 0, total, peopleLinked });
  } catch (error) {
    logger.error('PCO checkin availability error:', error);
    // Non-fatal: the UI just won't prompt.
    res.json({ success: true, hasImported: false, available: false, peopleLinked: false });
  }
});
```

- [ ] **Step 6: Run the DB-integration test suite for this file's neighbors to sanity-check nothing else broke**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/checkinGate.dbintegration.test.js services/planningCenter/apply.dbintegration.test.js`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): block check-in import until at least one person is linked"
```

---

## Task 3: Update `PCOCheckinImport.tsx` to show a clear blocked state

**Files:**
- Modify: `client/src/components/PCOCheckinImport.tsx`

- [ ] **Step 1: Add a `notLinked` state and detect the `PCO_NOT_LINKED` code in `findEvents`**

```typescript
// old_string
  const [done, setDone] = useState<any>(null);
  const [autoLoaded, setAutoLoaded] = useState(false);
```

```typescript
// new_string
  const [done, setDone] = useState<any>(null);
  const [notLinked, setNotLinked] = useState(false);
  const [autoLoaded, setAutoLoaded] = useState(false);
```

```typescript
// old_string
  const findEvents = async (range?: { startDate: string; endDate: string }) => {
    const query = range ?? { startDate, endDate };
    setLoading(true); setError(null); setPreview(null); setDone(null);
    const jobId = newJobId(); setProgress({ phase: 'fetching', percent: 0 });
    try {
      const r = await integrationsAPI.getCheckinEvents({ ...query, jobId });
      setEvents(r.data.events || []);
      setStartDate(r.data.startDate ?? '');
      setEndDate(r.data.endDate ?? '');
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
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load events.');
    } finally { setLoading(false); setProgress(null); }
  };
```

```typescript
// new_string
  const findEvents = async (range?: { startDate: string; endDate: string }) => {
    const query = range ?? { startDate, endDate };
    setLoading(true); setError(null); setNotLinked(false); setPreview(null); setDone(null);
    const jobId = newJobId(); setProgress({ phase: 'fetching', percent: 0 });
    try {
      const r = await integrationsAPI.getCheckinEvents({ ...query, jobId });
      setEvents(r.data.events || []);
      setStartDate(r.data.startDate ?? '');
      setEndDate(r.data.endDate ?? '');
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
    } catch (e: any) {
      if (e.response?.data?.code === 'PCO_NOT_LINKED') {
        setNotLinked(true);
      } else {
        setError(e.response?.data?.error || 'Failed to load events.');
      }
    } finally { setLoading(false); setProgress(null); }
  };
```

- [ ] **Step 2: Don't auto-skip past the blocked state without explanation (onboarding)**

```typescript
// old_string
  useEffect(() => {
    if (showSkip && autoLoaded && !error && events.length === 0 && onSkip) {
      onSkip();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoaded, events.length, error, showSkip]);
```

```typescript
// new_string
  useEffect(() => {
    if (showSkip && autoLoaded && !error && !notLinked && events.length === 0 && onSkip) {
      onSkip();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoaded, events.length, error, notLinked, showSkip]);
```

- [ ] **Step 3: Render a dedicated blocked message (with a Skip button when applicable) instead of the normal import UI**

```typescript
// old_string
      {events.length > 0 && (
        <div className="rounded bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-sm px-3 py-2">
          Found {events.reduce((n, e) => n + e.checkinCount, 0)} check-ins across {events.length} event{events.length === 1 ? '' : 's'} available to import.
        </div>
      )}

      {autoLoaded && !error && events.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">No Planning Center check-ins found.</div>
      )}

      <div className="flex flex-wrap items-end gap-3">
```

```typescript
// new_string
      {notLinked ? (
        <div className="rounded-md bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 px-4 py-3 space-y-2">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Link your people to Planning Center first — set up and run a sync batch — before importing check-in history.
            Importing now would create a new record for every attendee instead of matching them to your existing people.
          </p>
          {showSkip && onSkip && (
            <button type="button" onClick={() => onSkip()} className="text-sm underline text-amber-800 dark:text-amber-200">
              Skip this step
            </button>
          )}
        </div>
      ) : (
        <>
      {events.length > 0 && (
        <div className="rounded bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-sm px-3 py-2">
          Found {events.reduce((n, e) => n + e.checkinCount, 0)} check-ins across {events.length} event{events.length === 1 ? '' : 's'} available to import.
        </div>
      )}

      {autoLoaded && !error && events.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">No Planning Center check-ins found.</div>
      )}

      <div className="flex flex-wrap items-end gap-3">
```

- [ ] **Step 4: Close the new fragment at the end of the component's returned JSX**

```typescript
// old_string
      {done && (
        <div className="rounded bg-green-50 dark:bg-green-900/30 p-3 text-sm space-y-1 text-green-800 dark:text-green-200">
          <div className="font-medium text-green-800 dark:text-green-200">Import complete</div>
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
```

```typescript
// new_string
      {done && (
        <div className="rounded bg-green-50 dark:bg-green-900/30 p-3 text-sm space-y-1 text-green-800 dark:text-green-200">
          <div className="font-medium text-green-800 dark:text-green-200">Import complete</div>
          <div>Records written: {done.recordsWritten}</div>
          <div>Records skipped (already in LMPG): {done.recordsSkipped}</div>
          <div>Sessions created: {done.sessionsCreated}</div>
          <div>Gatherings created: {done.gatheringsCreated}</div>
          <div>People created (inactive): {done.createdPeople}</div>
        </div>
      )}
      </>
      )}
    </div>
  );
};
```

Note: everything between the `<div className="flex flex-wrap items-end gap-3">...Start date...` block and the `{done && (...)}` block (error display, progress bar, events list, preview panel, confirm Modal) stays exactly as it is today — only wrapped inside the new `{!notLinked && (<>...</>)}` fragment via the two edits above. Read the file after applying Step 3 and Step 4 to confirm the JSX is balanced (every `(` from Step 3's opening `<>` has the matching `)` from Step 4's closing `</>`).

- [ ] **Step 5: Rebuild the client and check for JSX/TypeScript errors**

Run: `docker-compose -f docker-compose.dev.yml build client`
Expected: build succeeds, no unbalanced-JSX or unused-variable errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/PCOCheckinImport.tsx
git commit -m "feat(pco): show a clear message instead of erroring when import is blocked"
```

---

## Task 4: Gate the standalone Integrations tab

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`

- [ ] **Step 1: Track `peopleLinked` alongside `checkinAvailable`**

```typescript
// old_string
  const [showImport, setShowImport] = useState(false);
  const [checkinAvailable, setCheckinAvailable] = useState(false);
```

```typescript
// new_string
  const [showImport, setShowImport] = useState(false);
  const [checkinAvailable, setCheckinAvailable] = useState(false);
  const [peopleLinked, setPeopleLinked] = useState(true);
```

(Defaults to `true` so the section doesn't flash a warning before the availability check resolves — the server-side gate in Task 2 is the real enforcement; this is only a UX nicety to avoid a dead-end click.)

- [ ] **Step 2: Read `peopleLinked` from the availability response**

```typescript
// old_string
      // Cheap probe: nudge to import check-ins only if data exists and none has
      // been imported yet.
      integrationsAPI.getCheckinAvailability()
        .then(r => setCheckinAvailable(!!r.data.available && !r.data.hasImported))
        .catch(() => setCheckinAvailable(false));
```

```typescript
// new_string
      // Cheap probe: nudge to import check-ins only if data exists and none has
      // been imported yet.
      integrationsAPI.getCheckinAvailability()
        .then(r => {
          setCheckinAvailable(!!r.data.available && !r.data.hasImported);
          setPeopleLinked(r.data.peopleLinked !== false);
        })
        .catch(() => setCheckinAvailable(false));
```

- [ ] **Step 3: Show an explanatory message instead of the import controls when nobody is linked yet**

```typescript
// old_string
              {/* Check-in attendance import */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                {checkinAvailable && (
                  <div className="mb-3 rounded-md bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 px-4 py-3 flex items-center justify-between gap-3">
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      Check-in data is available in Planning Center — would you like to import it?
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowImport(true)}
                      className="shrink-0 inline-flex items-center px-3 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                    >
                      Import now
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setShowImport(true)}
                  className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Import attendance history
                </button>
              </div>
```

```typescript
// new_string
              {/* Check-in attendance import */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                {!peopleLinked ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Link your people to Planning Center first — add a sync batch above and run it — before importing
                    check-in history. This keeps imported attendance matched to the right person instead of creating
                    duplicates.
                  </p>
                ) : (
                  <>
                    {checkinAvailable && (
                      <div className="mb-3 rounded-md bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 px-4 py-3 flex items-center justify-between gap-3">
                        <p className="text-sm text-blue-800 dark:text-blue-200">
                          Check-in data is available in Planning Center — would you like to import it?
                        </p>
                        <button
                          type="button"
                          onClick={() => setShowImport(true)}
                          className="shrink-0 inline-flex items-center px-3 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                        >
                          Import now
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowImport(true)}
                      className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Import attendance history
                    </button>
                  </>
                )}
              </div>
```

- [ ] **Step 4: Rebuild the client and check for errors**

Run: `docker-compose -f docker-compose.dev.yml build client`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/integrations/PlanningCenterIntegrationPanel.tsx
git commit -m "feat(pco): hide check-in import behind a linked-people explainer until ready"
```

---

## Task 5: Skip the onboarding check-in nudge cleanly when nobody is linked

**Files:**
- Modify: `client/src/pages/OnboardingPage.tsx`

- [ ] **Step 1: Treat "not linked yet" the same as "no check-in data" in the onboarding probe**

```typescript
// old_string
    integrationsAPI.getCheckinAvailability()
      .then((r: any) => {
        if (cancelled) return;
        if (r.data?.available && !r.data?.hasImported) {
          setCheckinProbe('available');
        } else {
          setCheckinProbe('unavailable');
          finishOnboarding();
        }
      })
```

```typescript
// new_string
    integrationsAPI.getCheckinAvailability()
      .then((r: any) => {
        if (cancelled) return;
        if (r.data?.available && !r.data?.hasImported && r.data?.peopleLinked !== false) {
          setCheckinProbe('available');
        } else {
          setCheckinProbe('unavailable');
          finishOnboarding();
        }
      })
```

This means an admin who clicks "Cancel" on the first batch setup (skipping `pco-people`/`pco-review` entirely, `OnboardingPage.tsx:379`) now finishes onboarding quietly instead of being teased with an "Import" button that would immediately hit the Task 3 blocked state. They can still set up a batch and import check-ins later from Settings → Integrations.

- [ ] **Step 2: Rebuild the client and check for errors**

Run: `docker-compose -f docker-compose.dev.yml build client`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/OnboardingPage.tsx
git commit -m "fix(pco): don't dangle a dead-end check-in import prompt in onboarding"
```

---

## Task 6: Full regression pass and manual verification

- [ ] **Step 1: Run the new and neighboring backend tests together**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/checkinGate.dbintegration.test.js services/planningCenter/apply.dbintegration.test.js services/planningCenter/apply.test.js`
Expected: all PASS.

- [ ] **Step 2: Run the client test suite**

Run: `docker-compose -f docker-compose.dev.yml run --rm client npm test -- --run`
Expected: all PASS.

- [ ] **Step 3: Manual smoke test — blocked state**

Using a test church that has Planning Center connected but has never run a sync batch (or run `DELETE FROM individuals WHERE planning_center_id IS NOT NULL` in that church's dev DB to simulate it — confirm you're pointed at a disposable dev/test church before running any DELETE):
1. Settings → Integrations → Planning Center: confirm the "Check-in attendance import" section shows the explanatory message, not the "Import attendance history" button.
2. Directly hit `GET /api/integrations/planning-center/checkins/events` (e.g. via the browser while logged in, or `curl` with the session cookie) and confirm a 403 with `code: "PCO_NOT_LINKED"`.
3. Run through onboarding's "choose-path" → "Set up from Planning Center" → click **Cancel** on the first batch screen → confirm it lands on `finishOnboarding()` without showing a check-in import prompt.

- [ ] **Step 4: Manual smoke test — unblocked state**

For a church that has run at least one batch sync (so at least one individual has `planning_center_id` set):
1. Settings → Integrations → Planning Center: confirm the normal "Import attendance history" button and (if check-in data exists) the blue nudge banner render as before.
2. Run a preview and an execute of a small date range and confirm attendance imports successfully, matching already-linked people and creating new (inactive) individuals only for genuinely new attendees — this is existing, correct behavior and should be unchanged.
