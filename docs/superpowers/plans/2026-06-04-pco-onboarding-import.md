# PCO Onboarding Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Planning Center setup branch to onboarding that connects PCO, imports people (allowlist-filtered), creates gatherings from PCO check-in events, imports historical check-ins as attendance, and auto-assigns current regulars to their gatherings.

**Architecture:** Mostly an orchestration + UX layer over existing capabilities. Backend: one small OAuth `returnTo` change, plus a new pure helper (`buildGatheringListAdds`) and an `assignToGatherings`/`recencyWeeks` option wired into the existing check-in `execute` transaction to populate `gathering_lists`. Frontend: `OnboardingPage.tsx` becomes a small step machine (`form → code → choose-path → pco-connect → pco-people → pco-gatherings → done`) whose PCO sub-steps compose the existing `MembershipAllowlistEditor` and a lightly-parameterized `PCOCheckinImport`.

**Tech Stack:** Node/Express, better-sqlite3 (`Database.query` / `Database.transaction`), `node:test`, React 19 + TypeScript, Vite, Tailwind, Axios.

**Invariants carried from the shipped check-in importer:**
- Present-only attendance; `attendance_records` insert stays `ON CONFLICT DO NOTHING`.
- The **standalone Settings importer must not change behavior** — it never touches `gathering_lists`. The new `gathering_lists` population happens ONLY when `assignToGatherings` is true (onboarding sets it; Settings does not).

**Testing note:** all `node --test` and build checks run **inside the dev container** (project docker-only rule):
```bash
docker-compose -f docker-compose.dev.yml exec -T server node --test <path>
```
Frontend changes are verified by checking the client container logs for transform errors:
```bash
docker-compose -f docker-compose.dev.yml logs --tail=40 client
```
The dev containers are already running (`server`, `client`, `nginx`, `admin`).

**Git:** The user is working on `main` with **no commits** for this 2.0 work. **Skip every commit step** unless the user says otherwise — leave changes in the working tree.

---

## File Structure

- **Modify** `server/services/planningCenter/checkinsImport.js` — add pure `buildGatheringListAdds` + export.
- **Modify** `server/services/planningCenter/checkinsImport.test.js` — tests for the new helper.
- **Modify** `server/routes/integrations.js` — (a) `assignToGatherings`/`recencyWeeks` in `runCheckinImport` execute path; (b) OAuth `returnTo` in `authorize` + `callback`.
- **Modify** `client/src/services/api.ts` — `authorizePlanningCenter(returnTo?)`; add `assignToGatherings?`/`recencyWeeks?` to the `executeCheckinImport` body type.
- **Modify** `client/src/components/PCOCheckinImport.tsx` — optional onboarding-mode props (`assignToGatherings`, `recencyWeeks`, `onComplete`, `onSkip`, `showSkip`); default behavior unchanged when props absent.
- **Modify** `client/src/pages/OnboardingPage.tsx` — step machine, choose-path screen, PCO connect/people/gatherings sub-steps, `?pco=connected` resume.

---

## Task 1: Pure helper — `buildGatheringListAdds`

Decides which (gathering, individual) roll memberships to create from check-in history: an active individual who attended a mapped event within the recency window.

**Files:**
- Modify: `server/services/planningCenter/checkinsImport.js`
- Test: `server/services/planningCenter/checkinsImport.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to server/services/planningCenter/checkinsImport.test.js
const { buildGatheringListAdds } = require('./checkinsImport');

test('buildGatheringListAdds adds active people who attended a mapped event within the recency window', () => {
  const normalized = [
    // p1 attended recently -> include
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-05-25', eventName: 'S', firstName: 'A', lastName: 'B' },
    // p1 also long ago (still included once, via the recent row)
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2020-01-05', eventName: 'S', firstName: 'A', lastName: 'B' },
    // p2 only attended long ago -> excluded by recency
    { pcoEventId: 'e1', pcoPersonId: 'p2', date: '2020-01-05', eventName: 'S', firstName: 'C', lastName: 'D' },
    // p3 attended recently but is inactive -> excluded
    { pcoEventId: 'e1', pcoPersonId: 'p3', date: '2025-05-25', eventName: 'S', firstName: 'E', lastName: 'F' },
    // p1 recent on an UNMAPPED event -> excluded
    { pcoEventId: 'e9', pcoPersonId: 'p1', date: '2025-05-25', eventName: 'X', firstName: 'A', lastName: 'B' },
  ];
  const personToIndividual = new Map([['p1', 11], ['p2', 22], ['p3', 33]]);
  const eventToGathering = new Map([['e1', 100]]); // e9 unmapped
  const activeIndividualIds = new Set([11, 22]); // 33 inactive
  const adds = buildGatheringListAdds(
    normalized, activeIndividualIds, personToIndividual, eventToGathering, 8, '2025-06-04'
  );
  assert.deepStrictEqual(adds, [{ gatheringTypeId: 100, individualId: 11 }]);
});

test('buildGatheringListAdds dedupes multiple recent check-ins for the same person/gathering', () => {
  const normalized = [
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-05-25', eventName: 'S', firstName: 'A', lastName: 'B' },
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-06-01', eventName: 'S', firstName: 'A', lastName: 'B' },
  ];
  const adds = buildGatheringListAdds(
    normalized, new Set([11]), new Map([['p1', 11]]), new Map([['e1', 100]]), 8, '2025-06-04'
  );
  assert.strictEqual(adds.length, 1);
});

test('buildGatheringListAdds includes a check-in exactly on the cutoff date', () => {
  // recencyWeeks 8 -> 56 days before 2025-06-04 is 2025-04-09
  const normalized = [
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-04-09', eventName: 'S', firstName: 'A', lastName: 'B' },
  ];
  const adds = buildGatheringListAdds(
    normalized, new Set([11]), new Map([['p1', 11]]), new Map([['e1', 100]]), 8, '2025-06-04'
  );
  assert.deepStrictEqual(adds, [{ gatheringTypeId: 100, individualId: 11 }]);
});

test('buildGatheringListAdds returns empty for empty input', () => {
  assert.deepStrictEqual(
    buildGatheringListAdds([], new Set(), new Map(), new Map(), 8, '2025-06-04'),
    []
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: FAIL — `buildGatheringListAdds is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add to server/services/planningCenter/checkinsImport.js (above module.exports)

// Computes the cutoff date (YYYY-MM-DD) that is `weeks` before `today` (YYYY-MM-DD).
function recencyCutoff(today, weeks) {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - weeks * 7);
  return t.toISOString().slice(0, 10);
}

// Which (gatheringTypeId, individualId) roll memberships to create.
// A person is added iff: their individual id is in activeIndividualIds, the
// event maps to a gathering, and they have >=1 check-in to it on/after the
// recency cutoff. Deduped.
// - normalized: rows from normalizeCheckIns
// - activeIndividualIds: Set<individualId> of is_active=1 individuals
// - personToIndividual: Map<pcoPersonId, individualId>
// - eventToGathering: Map<pcoEventId, gatheringTypeId>
// - recencyWeeks: integer window
// - today: 'YYYY-MM-DD'
function buildGatheringListAdds(normalized, activeIndividualIds, personToIndividual, eventToGathering, recencyWeeks, today) {
  const cutoff = recencyCutoff(today, recencyWeeks);
  const seen = new Set();
  const adds = [];
  for (const row of normalized) {
    if (row.date < cutoff) continue;
    const individualId = personToIndividual.get(row.pcoPersonId);
    if (individualId == null || !activeIndividualIds.has(individualId)) continue;
    const gatheringTypeId = eventToGathering.get(row.pcoEventId);
    if (gatheringTypeId == null) continue;
    const key = `${gatheringTypeId}|${individualId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    adds.push({ gatheringTypeId, individualId });
  }
  return adds;
}
```

Update the exports line to add `buildGatheringListAdds`:

```js
module.exports = {
  localDateInTz, normalizeCheckIns, summarizeEvents, resolvePeople, buildRecordWrites, buildGatheringListAdds,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS (existing 11 + 4 new = 15 tests).

- [ ] **Step 5: Commit** — SKIP (no commits; leave in working tree).

---

## Task 2: Wire `assignToGatherings` + `recencyWeeks` into the check-in execute

Populate `gathering_lists` inside the existing import transaction, only when requested. Settings behavior unchanged.

**Files:**
- Modify: `server/routes/integrations.js` (inside `runCheckinImport`, the commit/transaction branch — currently ends around line 2700; the `attendance_records` insert + counters are at ~2660–2700)

- [ ] **Step 1: Read the current transaction tail**

Run: `grep -n "latestPresent\|assignmentsCreated\|gathering_lists\|return { ...summary\|recordsWritten++" server/routes/integrations.js | head`
Expected: confirm the transaction builds `personToIndividual`, `eventToGathering`, writes records, and tracks `latestPresent`; confirm there is currently no `gathering_lists` insert in this function.

- [ ] **Step 2: Read onboarding options from the body**

Near the top of `runCheckinImport` (just after `const mappings = ...`), add:

```js
  // Onboarding-only: also populate gathering_lists for active, recent attendees.
  const assignToGatherings = req.body.assignToGatherings === true;
  let recencyWeeks = parseInt(req.body.recencyWeeks, 10);
  if (!Number.isInteger(recencyWeeks) || recencyWeeks < 1) recencyWeeks = 8;
```

- [ ] **Step 3: Add the assignment step inside the transaction**

Inside the `await Database.transaction(async (conn) => { ... })` block, AFTER the `for (const w of writes) { ... }` loop and AFTER the existing forward-only `last_attendance_date` update (i.e. as the last action in the transaction), add:

```js
    // Onboarding auto-assignment: add active, recently-attending people to the
    // roll of each gathering they attended. Only runs when assignToGatherings is
    // set (the Settings importer leaves this false and never touches gathering_lists).
    if (assignToGatherings) {
      const activeRows = await conn.query(
        `SELECT id FROM individuals WHERE church_id = ? AND is_active = 1`,
        [churchId]
      );
      const activeIndividualIds = new Set(activeRows.map((r) => r.id));
      const today = new Date().toISOString().slice(0, 10);
      const adds = checkinsImport.buildGatheringListAdds(
        normalized, activeIndividualIds, personToIndividual, eventToGathering, recencyWeeks, today
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
```

Note: `personToIndividual` and `eventToGathering` are already in scope inside the transaction (built earlier in the commit branch). `normalized` and `churchId`/`userId` are in scope from the function body.

- [ ] **Step 4: Add the `assignmentsCreated` counter and include it in the result**

Where the commit-branch counters are declared (the line `let createdPeople = 0, gatheringsCreated = 0, sessionsCreated = 0, recordsWritten = 0, recordsSkipped = 0;`), add `assignmentsCreated`:

```js
  let createdPeople = 0, gatheringsCreated = 0, sessionsCreated = 0, recordsWritten = 0, recordsSkipped = 0, assignmentsCreated = 0;
```

And in the final `return { ...summary, ... }` of the commit branch, add `assignmentsCreated`:

```js
  return { ...summary, createdPeople, gatheringsCreated, sessionsCreated, recordsWritten, recordsSkipped, assignmentsCreated };
```

- [ ] **Step 5: Verify server boots and the Settings path is unaffected**

Run:
```bash
docker-compose -f docker-compose.dev.yml restart server && sleep 3 && docker-compose -f docker-compose.dev.yml logs --tail=30 server
```
Expected: clean startup, no syntax errors. (Behavioral check happens in Task 9. The `assignToGatherings` default-false guard means the existing preview/execute behavior is unchanged for callers that don't send it.)

- [ ] **Step 6: Commit** — SKIP.

---

## Task 3: OAuth `returnTo` support

Let onboarding send the user through PCO OAuth and land back in onboarding instead of Settings.

**Files:**
- Modify: `server/routes/integrations.js` — `GET /planning-center/authorize` (~line 1784) and `GET /planning-center/callback` (~line 1811)

- [ ] **Step 1: Add `returnTo` to the authorize state**

In `router.get('/planning-center/authorize', ...)`, change the `state` construction to capture an optional, validated `returnTo` query param:

```js
  // Optional post-OAuth redirect target. Only app-relative '/app/...' paths are
  // allowed (prevents open redirect). Falls back to Settings when absent/invalid.
  const rawReturnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
  const returnTo = /^\/app\//.test(rawReturnTo) ? rawReturnTo : '';

  const state = Buffer.from(JSON.stringify({
    userId: req.user.id,
    churchId: req.user.church_id,
    timestamp: Date.now(),
    returnTo,
  })).toString('base64');
```

(Leave the rest of the handler — `authUrl` construction and `res.json({ authUrl })` — unchanged.)

- [ ] **Step 2: Honor `returnTo` in the callback**

In `router.get('/planning-center/callback', ...)`, where `stateData` is decoded, also read `returnTo`, and change the final redirect:

```js
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      userId = stateData.userId;
      churchId = stateData.churchId;
      var returnTo = stateData.returnTo; // may be undefined for older flows
```

Then replace the success redirect line
`res.redirect('/app/settings?tab=integrations&pco_success=true');`
with:

```js
    // Re-validate returnTo on the way out (defense in depth).
    if (returnTo && /^\/app\//.test(returnTo)) {
      const sep = returnTo.includes('?') ? '&' : '?';
      res.redirect(`${returnTo}${sep}pco=connected`);
    } else {
      res.redirect('/app/settings?tab=integrations&pco_success=true');
    }
```

> Note: `userId`/`churchId` are declared with `let` above the try; declare `returnTo` with `var` (or hoist a `let returnTo;` next to them) so it's in scope at the redirect. Match the existing variable-declaration style in that handler.

- [ ] **Step 3: Verify server boots**

Run: `docker-compose -f docker-compose.dev.yml restart server && sleep 3 && docker-compose -f docker-compose.dev.yml logs --tail=20 server`
Expected: clean startup.

- [ ] **Step 4: Commit** — SKIP.

---

## Task 4: API client — `returnTo` + execute body options

**Files:**
- Modify: `client/src/services/api.ts` (~line 822 `authorizePlanningCenter`; ~line 852–861 `executeCheckinImport`)

- [ ] **Step 1: Add `returnTo` to `authorizePlanningCenter`**

Replace:
```ts
  authorizePlanningCenter: () => api.get('/integrations/planning-center/authorize'),
```
with:
```ts
  authorizePlanningCenter: (returnTo?: string) =>
    api.get('/integrations/planning-center/authorize', { params: returnTo ? { returnTo } : {} }),
```

- [ ] **Step 2: Add onboarding options to the `executeCheckinImport` body type**

In `executeCheckinImport`, extend the body type to include the two optional fields (keep existing fields):

```ts
  executeCheckinImport: (body: {
    startDate?: string;
    endDate?: string;
    mappings: Array<{
      pcoEventId: string;
      target: 'existing' | 'new';
      gatheringTypeId?: number;
      newGatheringName?: string;
    }>;
    assignToGatherings?: boolean;
    recencyWeeks?: number;
  }) => api.post('/integrations/planning-center/import-checkins/execute', body, { timeout: 120000 }),
```

- [ ] **Step 3: Verify client compiles**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=30 client`
Expected: Vite recompiles, no TS errors. (If client not running: `docker-compose -f docker-compose.dev.yml up -d client`.)

- [ ] **Step 4: Commit** — SKIP.

---

## Task 5: Parameterize `PCOCheckinImport` for onboarding mode

Add optional props so the same component serves Settings (unchanged) and the onboarding gatherings step (auto-assign + recency input + Skip + onComplete). When the new props are absent, behavior is identical to today.

**Files:**
- Modify: `client/src/components/PCOCheckinImport.tsx`

- [ ] **Step 1: Add a props interface**

At the top of the component file, define props and accept them (default empty). Replace the component signature `const PCOCheckinImport: React.FC = () => {` with:

```tsx
interface PCOCheckinImportProps {
  /** Onboarding mode: also auto-assign active recent attendees to gathering rolls. */
  assignToGatherings?: boolean;
  /** Recency window (weeks) for auto-assignment; shown as an editable input when assignToGatherings. */
  defaultRecencyWeeks?: number;
  /** Show a Skip button (onboarding). */
  showSkip?: boolean;
  /** Called when the user skips the step (onboarding). */
  onSkip?: () => void;
  /** Called after a successful import (onboarding advances). */
  onComplete?: (result: any) => void;
}

const PCOCheckinImport: React.FC<PCOCheckinImportProps> = ({
  assignToGatherings = false,
  defaultRecencyWeeks = 8,
  showSkip = false,
  onSkip,
  onComplete,
}) => {
```

- [ ] **Step 2: Add recency state and include options in the execute body**

Add near the other `useState` declarations:

```tsx
  const [recencyWeeks, setRecencyWeeks] = useState(defaultRecencyWeeks);
```

In `runExecute`, change the body passed to `executeCheckinImport` to include the onboarding options when in assignment mode, and call `onComplete` on success. Replace the existing `runExecute` body-build + success handling with:

```tsx
  const runExecute = async () => {
    if (!window.confirm('Import these check-ins as attendance? Existing LMPG records will not be changed.')) return;
    setLoading(true); setError(null);
    try {
      const body: any = { startDate, endDate, mappings: validMappings() };
      if (assignToGatherings) {
        body.assignToGatherings = true;
        body.recencyWeeks = recencyWeeks;
      }
      const r = await integrationsAPI.executeCheckinImport(body);
      setDone(r.data);
      setPreview(null);
      if (onComplete) onComplete(r.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Import failed.');
    } finally { setLoading(false); }
  };
```

> If `validMappings` is the helper added in the earlier review, keep using it. If the component currently calls `buildMappingsPayload()` here, use whichever the file actually has (check the current code) — the point is only to add the two `assignToGatherings`/`recencyWeeks` fields and the `onComplete` call.

- [ ] **Step 3: Render the recency input (assignment mode only) and the Skip button**

Add the recency input near the date range controls, shown only in assignment mode:

```tsx
      {assignToGatherings && (
        <label className="text-sm text-gray-700 dark:text-gray-300">
          Treat as a current regular if they attended in the last
          <input
            type="number"
            min={1}
            value={recencyWeeks}
            onChange={(e) => setRecencyWeeks(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="mx-2 w-16 border rounded px-2 py-1 border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          />
          weeks
        </label>
      )}
```

Add a Skip button (onboarding) near the primary actions:

```tsx
      {showSkip && (
        <button
          onClick={() => onSkip && onSkip()}
          className="text-gray-600 dark:text-gray-300 underline text-sm"
        >
          Skip this step
        </button>
      )}
```

- [ ] **Step 4: Auto-skip when no check-ins (onboarding only)**

In the auto-load effect's completion, when in onboarding mode and zero events were found, advance automatically. Locate the auto-load effect added previously; after it sets `autoLoaded` and there are zero events, call skip. Concretely, add this effect AFTER the existing auto-load effect:

```tsx
  useEffect(() => {
    if (showSkip && autoLoaded && !error && events.length === 0 && onSkip) {
      onSkip();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoaded, events.length, error, showSkip]);
```

(This only fires in onboarding because `showSkip`/`onSkip` are only set there. In Settings it shows the existing "No Planning Center check-ins found." note.)

- [ ] **Step 5: Verify client compiles and Settings usage still type-checks**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=30 client`
Expected: no TS errors. The Settings render `<PCOCheckinImport />` (no props) still valid because all new props are optional.

- [ ] **Step 6: Commit** — SKIP.

---

## Task 6: Onboarding step machine + choose-path + PCO connect + resume

Convert `OnboardingPage.tsx` to a step machine and add the path fork and connect step. People/gatherings steps are added in Tasks 7–8.

**Files:**
- Modify: `client/src/pages/OnboardingPage.tsx`

- [ ] **Step 1: Expand the step type and add resume handling**

Change the step state type and add PCO connection detection on mount. Replace:
```tsx
  const [step, setStep] = useState<'form' | 'code'>('form');
```
with:
```tsx
  const [step, setStep] = useState<'form' | 'code' | 'choose-path' | 'pco-people' | 'pco-gatherings'>('form');
```

Add this effect (after the existing outside-click effect) to resume after the OAuth round-trip — when PCO redirects back to `/app/onboarding?pco=connected`, jump straight to the people step:

```tsx
  // Resume onboarding after the PCO OAuth round-trip.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('pco') === 'connected') {
      setStep('pco-people');
      // clean the query so a refresh doesn't re-trigger
      window.history.replaceState({}, '', '/app/onboarding');
    }
  }, []);
```

> The user remains authenticated via the JWT cookie across the redirect, so no re-login is needed.

- [ ] **Step 2: Route to the path fork after code verification**

In `handleCodeSubmit`, the church is created and onboarding marked. Today it ends with `navigate('/app/gatherings')`. Change ONLY the ending: instead of navigating away immediately, go to the path fork. Replace:
```tsx
      navigate('/app/gatherings');
```
with:
```tsx
      setStep('choose-path');
```
(Keep everything else in `handleCodeSubmit` — including `onboardingAPI.complete()` and `refreshOnboardingStatus()` — so the church is fully set up regardless of which path they pick.)

- [ ] **Step 3: Add a helper to finish onboarding**

Add this function in the component (it finalizes and leaves to the populated app):

```tsx
  const finishOnboarding = () => {
    navigate('/app/gatherings');
  };
```

- [ ] **Step 4: Add the choose-path screen**

Add a render branch for `step === 'choose-path'` inside the card (alongside the existing `step === 'form'` / `step === 'code'` branches). Use the existing button styles:

```tsx
          ) : step === 'choose-path' ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                Do you use Planning Center? We can set up your members, gatherings and attendance history from it.
              </p>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await integrationsAPI.authorizePlanningCenter('/app/onboarding');
                    window.location.href = res.data.authUrl;
                  } catch (err: any) {
                    setError(err.response?.data?.error || 'Could not start Planning Center connection.');
                  }
                }}
                className="w-full inline-flex justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700"
              >
                Set up from Planning Center
              </button>
              <button
                type="button"
                onClick={finishOnboarding}
                className="w-full inline-flex justify-center px-6 py-3 border border-gray-300 text-base font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                Start fresh
              </button>
            </div>
```

Add the import at the top of the file:
```tsx
import { authAPI, onboardingAPI, integrationsAPI } from '../services/api';
```

- [ ] **Step 5: Verify client compiles**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=30 client`
Expected: no TS errors. Manually: completing the form/code now lands on the "Set up from Planning Center / Start fresh" fork; "Start fresh" goes to `/app/gatherings` as before; "Set up from Planning Center" kicks off OAuth.

- [ ] **Step 6: Commit** — SKIP.

---

## Task 7: Onboarding people step (allowlist import)

**Files:**
- Modify: `client/src/pages/OnboardingPage.tsx`

- [ ] **Step 1: Add people-step state and a loader**

Add state near the others:

```tsx
  const [membershipValues, setMembershipValues] = useState<{ membership: string; count: number }[]>([]);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [importingPeople, setImportingPeople] = useState(false);
```

Add a loader that fetches the membership summary and defaults the allowlist to all non-archived-looking categories (sensible default: select everything except categories whose name contains "archiv" or "inactive", case-insensitive):

```tsx
  const loadMembershipSummary = async () => {
    setMembershipLoading(true); setMembershipError(null);
    try {
      const r = await integrationsAPI.getPlanningCenterMembershipSummary();
      const values = r.data.values || r.data.summary || r.data || [];
      setMembershipValues(values);
      const defaults = values
        .map((v: any) => v.membership)
        .filter((m: string) => !/archiv|inactive/i.test(m || ''));
      setAllowlist(defaults);
    } catch (e: any) {
      setMembershipError(e.response?.data?.error || 'Failed to load membership categories.');
    } finally {
      setMembershipLoading(false);
    }
  };
```

> Confirm the exact method name and response shape with: `grep -n "MembershipSummary\|membership-summary" client/src/services/api.ts` and adjust `getPlanningCenterMembershipSummary` / the response field accordingly. The Settings page that already uses `MembershipAllowlistEditor` shows the real shape — mirror it.

- [ ] **Step 2: Trigger the loader when entering the people step**

Add an effect:

```tsx
  useEffect(() => {
    if (step === 'pco-people') loadMembershipSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
```

- [ ] **Step 3: Add the import action**

```tsx
  const importPeople = async () => {
    setImportingPeople(true); setError('');
    try {
      // Save the chosen allowlist (one-time import; ongoing sync stays off).
      await integrationsAPI.savePlanningCenterMembershipFilter({ enabled: false, allowlist });
      // Apply the additive sync to import matching people + households.
      await integrationsAPI.applyPlanningCenterSync({});
      setStep('pco-gatherings');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to import people from Planning Center.');
    } finally {
      setImportingPeople(false);
    }
  };
```

> Confirm method names with: `grep -n "MembershipFilter\|applyPlanningCenterSync\|sync/apply" client/src/services/api.ts`. From the API client these are `savePlanningCenterMembershipFilter({ enabled, allowlist })` and the sync-apply method (the file shows `api.post('/integrations/planning-center/sync/apply', data, ...)`) — use the actual exported name. Pass `{}` (empty selections) as the body; the server sanitizes selections against its freshly-computed plan, and an empty object means "no overrides", i.e. import all additive candidates.

- [ ] **Step 4: Render the people step**

Import the editor at the top:
```tsx
import MembershipAllowlistEditor from '../components/planningCenter/MembershipAllowlistEditor';
```

Add a render branch for `step === 'pco-people'`:

```tsx
          ) : step === 'pco-people' ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">Choose which Planning Center people to import.</p>
              <MembershipAllowlistEditor
                values={membershipValues}
                loading={membershipLoading}
                error={membershipError}
                selected={allowlist}
                onChange={setAllowlist}
                onReload={loadMembershipSummary}
              />
              <div className="flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep('pco-gatherings')}
                  className="text-gray-600 underline text-sm"
                >
                  Skip
                </button>
                <button
                  type="button"
                  disabled={importingPeople || allowlist.length === 0}
                  onClick={importPeople}
                  className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  {importingPeople ? 'Importing…' : 'Import people'}
                </button>
              </div>
            </div>
```

- [ ] **Step 5: Verify client compiles**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=30 client`
Expected: no TS errors.

- [ ] **Step 6: Commit** — SKIP.

---

## Task 8: Onboarding gatherings step (reuse `PCOCheckinImport` in onboarding mode)

**Files:**
- Modify: `client/src/pages/OnboardingPage.tsx`

- [ ] **Step 1: Import the component**

At the top of the file:
```tsx
import PCOCheckinImport from '../components/PCOCheckinImport';
```

- [ ] **Step 2: Render the gatherings step**

Add a render branch for `step === 'pco-gatherings'`. It composes the parameterized component in assignment mode, with Skip and onComplete both advancing to finish:

```tsx
          ) : step === 'pco-gatherings' ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                Create your gatherings from Planning Center events and import attendance history.
                People who attended recently will be added to each gathering automatically.
              </p>
              <PCOCheckinImport
                assignToGatherings
                defaultRecencyWeeks={8}
                showSkip
                onSkip={finishOnboarding}
                onComplete={finishOnboarding}
              />
            </div>
```

> `finishOnboarding` (Task 6 Step 3) navigates to `/app/gatherings`. The component auto-skips (Task 5 Step 4) when no check-ins are detected, which calls `onSkip` → `finishOnboarding`.

- [ ] **Step 3: Verify client compiles**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=30 client`
Expected: no TS errors.

- [ ] **Step 4: Commit** — SKIP.

---

## Task 9: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the unit suite**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenter/checkinsImport.test.js`
Expected: PASS (15 tests).

- [ ] **Step 2: Settings importer regression (no gathering_lists writes)**

In the dev browser as a connected church, run the Settings → Integrations check-in importer for a small range (no onboarding mode). Confirm `attendance_records` get `present = 1` and that **no** new `gathering_lists` rows were created by that run (query before/after via the admin panel at `http://localhost:7777` or a count). This proves `assignToGatherings` defaults off.

- [ ] **Step 3: Full onboarding PCO branch (test church)**

Walk a fresh onboarding: create church → verify code → "Set up from Planning Center" → complete OAuth → confirm it returns to `/app/onboarding` and resumes at the people step. Pick an allowlist → Import people → confirm individuals/families created with `planning_center_id` and `is_active = 1`. On the gatherings step, confirm events auto-detected, leave defaults (create new) → set recency → Confirm. Then verify:
- gatherings were created from events;
- `attendance_records` present-only written;
- `gathering_lists` contains only **active** people who attended within the recency window (spot-check: someone who only attended >recency ago is NOT on the roll; an archived/inactive attendee is NOT on the roll but DOES have present records).

- [ ] **Step 4: Skip + no-data + start-fresh paths**

- On the gatherings step, click "Skip this step" → lands on `/app/gatherings`, onboarding complete.
- With a church that has no check-ins, the gatherings step auto-advances (no dead-end).
- "Start fresh" from the fork → `/app/gatherings`, unchanged from today's behavior.

- [ ] **Step 5: returnTo open-redirect guard**

Confirm that hitting authorize with a hostile `returnTo` (e.g. `https://evil.com`) is rejected: the callback falls back to `/app/settings?...` rather than redirecting off-site. (Check by reading the validated `returnTo` regex path; optionally test the authorize endpoint returns state that ignores the bad value.)

- [ ] **Step 6: Commit** — SKIP (unless the user opts to commit the 2.0 work).

---

## Self-Review Notes

- **Spec coverage:** OAuth return-to (Task 3, guard verified Task 9.5); import-people via allowlist reusing existing pieces (Task 7); events→gatherings + check-in import skippable + no-data auto-advance (Tasks 5, 8); auto-assign active+recent to gathering_lists (Tasks 1–2, verified 9.3); branch vs start-fresh (Task 6); people-before-checkins ordering (Task 7 → 8). All spec sections mapped.
- **Settings regression guard:** `assignToGatherings` defaults false; Settings renders `<PCOCheckinImport />` with no props; verified Task 9.2.
- **Type/name consistency:** new pure fn `buildGatheringListAdds` (Task 1) used identically in Task 2; `assignToGatherings`/`recencyWeeks` body fields consistent across Task 4 (api type), Task 5 (execute body), Task 2 (server read).
- **Known cross-checks flagged for the implementer (grep-and-confirm, not guesses):** exact api.ts method names/response shapes for membership summary, save membership filter, and sync apply (Task 7 Steps 1, 3); whether `PCOCheckinImport` currently uses `validMappings()` vs `buildMappingsPayload()` at the execute call (Task 5 Step 2).
- **Out of scope (per spec):** ongoing source-of-truth sync toggle during onboarding; inferring gathering day/time from event times (flagged nice-to-have only).
