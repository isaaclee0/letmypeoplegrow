# Kiosk Mode Env-Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `KIOSK_MODE_ENABLED` server env var (default disabled) that fully hides and blocks self check-in / kiosk mode, closing off the data-exposure risk until it's redesigned.

**Architecture:** Server-side: a middleware in `server/routes/kiosk.js` rejects all kiosk routes with `403 KIOSK_DISABLED` unless `process.env.KIOSK_MODE_ENABLED === 'true'`, plus a new `GET /api/kiosk/status` route (defined before that middleware, so it's always reachable) that reports the flag to the client. Client-side: both entry points that let a gathering be put into self-checkin mode — `CheckInsPage.tsx` (the actual usage flow) and `ManageGatheringsPage.tsx` (the admin toggle that turns it on per-gathering) — fetch that status once and hide/neutralize self check-in when it's off, while leaving the unrelated "Leader Check-in" mode untouched.

**Tech Stack:** Express (`server/routes/kiosk.js`), React/TypeScript (`client/src/pages/CheckInsPage.tsx`, `client/src/pages/ManageGatheringsPage.tsx`, `client/src/services/api.ts`).

**Testing approach:** This repo has zero existing tests for Express routes (only service-level unit tests under `server/services/**/*.test.js`), and the approved design spec (`docs/superpowers/specs/2026-07-13-kiosk-mode-env-gate-design.md`) explicitly rules out building new test infrastructure for this change. Each task below is verified manually instead (curl for the server change, browser for the client changes), with a full end-to-end pass in Task 6. Per project convention, all verification runs through `docker-compose.dev.yml` — never build or run the app locally.

---

### Task 1: Server-side gate on kiosk routes

**Files:**
- Modify: `server/routes/kiosk.js:1-20`
- Modify: `server/.env.example`

- [ ] **Step 1: Add the env-check helper, the status route, and the blocking middleware**

In `server/routes/kiosk.js`, replace:

```js
const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireGatheringAccess, auditLog } = require('../middleware/auth');
const { columnExists } = require('../utils/databaseSchema');
const logger = require('../config/logger');

const router = express.Router();

router.use(verifyToken);

// Middleware to disable caching
const disableCache = (req, res, next) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.removeHeader('ETag');
  next();
};
```

with:

```js
const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireGatheringAccess, auditLog } = require('../middleware/auth');
const { columnExists } = require('../utils/databaseSchema');
const logger = require('../config/logger');

const router = express.Router();

router.use(verifyToken);

// Self check-in / kiosk mode is off by default: the client UI loads the
// entire church roster into the browser for an unattended, PIN-locked
// device. See docs/superpowers/specs/2026-07-13-kiosk-mode-env-gate-design.md.
// Only set KIOSK_MODE_ENABLED=true once that data-exposure issue is fixed.
function kioskModeEnabled() {
  return process.env.KIOSK_MODE_ENABLED === 'true';
}

// ===== Report whether self check-in / kiosk mode is enabled =====
// GET /api/kiosk/status
router.get('/status', (req, res) => {
  res.json({ enabled: kioskModeEnabled() });
});

// Block every other kiosk route while the feature is globally disabled.
router.use((req, res, next) => {
  if (!kioskModeEnabled()) {
    return res.status(403).json({ code: 'KIOSK_DISABLED', error: 'Self check-in is currently disabled.' });
  }
  next();
});

// Middleware to disable caching
const disableCache = (req, res, next) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.removeHeader('ETag');
  next();
};
```

Note: the `GET /status` route is registered *before* the blocking `router.use`, so Express matches and answers it without ever reaching the gate. Every other route in the file (`POST /:gatheringTypeId/:date`, `GET /history/...` x2, `DELETE /history/...`) is registered after the gate, so all of them get blocked.

- [ ] **Step 2: Document the env var**

Append to `server/.env.example` (it currently ends after the Elvanto section):

```
# Kiosk / Self Check-in Configuration (optional - defaults to disabled)
# The self check-in UI currently loads the full church roster into the
# browser for use on an unattended, PIN-locked device. Leave disabled until
# that is redesigned. See docs/superpowers/specs/2026-07-13-kiosk-mode-env-gate-design.md
KIOSK_MODE_ENABLED=false
```

- [ ] **Step 3: Rebuild and manually verify**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
docker-compose -f docker-compose.dev.yml logs --tail=30 server
```

Expected: server starts cleanly, no errors in the log tail.

With `KIOSK_MODE_ENABLED` unset (the default), confirm the gate is active. Get a valid auth cookie by logging in through the running app first (or reuse a browser session cookie), then:

```bash
curl -s http://localhost/api/kiosk/status -H "Cookie: <your session cookie>"
```

Expected: `{"enabled":false}`

```bash
curl -s -X POST http://localhost/api/kiosk/1/2026-07-13 \
  -H "Cookie: <your session cookie>" -H "Content-Type: application/json" \
  -d '{"individualIds":[1],"action":"checkin"}'
```

Expected: HTTP 403, body `{"code":"KIOSK_DISABLED","error":"Self check-in is currently disabled."}`

Then set `KIOSK_MODE_ENABLED=true` in `server/.env`, restart the server (`docker-compose -f docker-compose.dev.yml restart server`), and re-run the status curl — expect `{"enabled":true}`. Set it back to unset/false afterward so the default-off behavior is what's actually running (this repo's `.env` isn't committed, so leaving it either way doesn't affect other developers, but the point of this task is to ship default-off).

- [ ] **Step 4: Commit**

```bash
git add server/routes/kiosk.js server/.env.example
git commit -m "$(cat <<'EOF'
feat(kiosk): gate self check-in behind KIOSK_MODE_ENABLED, default off

Self check-in currently loads the full church roster into an
unattended, PIN-locked device. Block it server-side by default until
that's redesigned; add a status route so the client can hide the UI.
EOF
)"
```

---

### Task 2: Client API method for the status check

**Files:**
- Modify: `client/src/services/api.ts:440-455`

- [ ] **Step 1: Add `getStatus` to `kioskAPI`**

Replace:

```ts
export const kioskAPI = {
  record: (gatheringTypeId: number, date: string, data: {
    individualIds: number[];
    action: 'checkin' | 'checkout';
    signerName?: string;
  }) =>
    api.post(`/kiosk/${gatheringTypeId}/${date}`, data),

  getHistory: (gatheringTypeId: number, limit?: number) =>
    api.get(`/kiosk/history/${gatheringTypeId}`, { params: { limit: limit || 20 } }),

  getHistoryDetail: (gatheringTypeId: number, date: string) =>
    api.get(`/kiosk/history/${gatheringTypeId}/${date}`),

  deleteSession: (gatheringTypeId: number, date: string) =>
    api.delete(`/kiosk/history/${gatheringTypeId}/${date}`),
};
```

with:

```ts
export const kioskAPI = {
  getStatus: () =>
    api.get('/kiosk/status'),

  record: (gatheringTypeId: number, date: string, data: {
    individualIds: number[];
    action: 'checkin' | 'checkout';
    signerName?: string;
  }) =>
    api.post(`/kiosk/${gatheringTypeId}/${date}`, data),

  getHistory: (gatheringTypeId: number, limit?: number) =>
    api.get(`/kiosk/history/${gatheringTypeId}`, { params: { limit: limit || 20 } }),

  getHistoryDetail: (gatheringTypeId: number, date: string) =>
    api.get(`/kiosk/history/${gatheringTypeId}/${date}`),

  deleteSession: (gatheringTypeId: number, date: string) =>
    api.delete(`/kiosk/history/${gatheringTypeId}/${date}`),
};
```

- [ ] **Step 2: Rebuild client and check for compile errors**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
docker-compose -f docker-compose.dev.yml logs --tail=30 client
```

Expected: no TypeScript errors in the log tail.

- [ ] **Step 3: Commit**

```bash
git add client/src/services/api.ts
git commit -m "$(cat <<'EOF'
feat(kiosk): add kioskAPI.getStatus client method
EOF
)"
```

---

### Task 3: Gate `CheckInsPage.tsx`

This is the actual usage flow: it decides which gatherings are offered for self check-in, and it's what renders `SelfCheckInMode` (the component that loads the full roster). All four touch points below work off two shared local variables — `all` (the gathering list, already stripped of `kioskEnabled` when the flag is off) and `kioskModeEnabled` (the raw flag, used as a render-time safety net) — so no other line in the file needs to change: `kioskList`, `hasSelf`/`hasLeader` auto-start logic, `handleGatheringSelect`, and the mode-selection buttons all already read from `all`/`selectedGathering`, which will be correctly sanitized.

**Files:**
- Modify: `client/src/pages/CheckInsPage.tsx:5` (import)
- Modify: `client/src/pages/CheckInsPage.tsx:36` (state)
- Modify: `client/src/pages/CheckInsPage.tsx:42-56` (cache-read sanitize)
- Modify: `client/src/pages/CheckInsPage.tsx:58-121` (fresh-fetch sanitize)
- Modify: `client/src/pages/CheckInsPage.tsx:122-137` (fetch-failure fallback sanitize)
- Modify: `client/src/pages/CheckInsPage.tsx:146` and `:160` (render guards)

- [ ] **Step 1: Import `kioskAPI`**

Replace:

```ts
import { gatheringsAPI, GatheringType } from '../services/api';
```

with:

```ts
import { gatheringsAPI, GatheringType, kioskAPI } from '../services/api';
```

- [ ] **Step 2: Add the `kioskModeEnabled` state**

Replace:

```ts
  const [kioskGatherings, setKioskGatherings] = useState<GatheringType[]>([]);
```

with:

```ts
  const [kioskGatherings, setKioskGatherings] = useState<GatheringType[]>([]);

  // Self check-in / kiosk mode is off unless KIOSK_MODE_ENABLED=true on the server
  const [kioskModeEnabled, setKioskModeEnabled] = useState(false);
```

- [ ] **Step 3: Sanitize the cache-read (Step 1 of `checkGatherings`)**

We haven't asked the server yet at this point, so treat self check-in as off until the fresh fetch confirms otherwise — this is what makes the feature fail closed instead of trusting a stale cached flag.

Replace:

```ts
      try {
        const cachedGatherings = localStorage.getItem('gatherings_cached_data');
        if (cachedGatherings) {
          const parsed = JSON.parse(cachedGatherings);
          const all: GatheringType[] = parsed.gatherings || [];
          const kioskList = all.filter((g: GatheringType) => (g.kioskEnabled || g.leaderCheckinEnabled) && g.attendanceType === 'standard');
          if (kioskList.length > 0) {
            setKioskGatherings(kioskList);
            setNoGatherings(false);
            setIsLoading(false); // Show UI immediately with cached data
          }
        }
      } catch {
        // ignore
      }
```

with:

```ts
      try {
        const cachedGatherings = localStorage.getItem('gatherings_cached_data');
        if (cachedGatherings) {
          const parsed = JSON.parse(cachedGatherings);
          const rawAll: GatheringType[] = parsed.gatherings || [];
          // Self check-in status isn't cached; assume disabled until Step 2 confirms it
          const all: GatheringType[] = rawAll.map(g => ({ ...g, kioskEnabled: false }));
          const kioskList = all.filter((g: GatheringType) => (g.kioskEnabled || g.leaderCheckinEnabled) && g.attendanceType === 'standard');
          if (kioskList.length > 0) {
            setKioskGatherings(kioskList);
            setNoGatherings(false);
            setIsLoading(false); // Show UI immediately with cached data
          }
        }
      } catch {
        // ignore
      }
```

- [ ] **Step 4: Fetch the status alongside gatherings and sanitize the fresh data**

Replace:

```ts
      // Step 2: Fetch fresh data and cache for next visit
      try {
        const response = await gatheringsAPI.getAll();
        const all: GatheringType[] = response.data.gatherings || [];
        const kioskList = all.filter(g => (g.kioskEnabled || g.leaderCheckinEnabled) && g.attendanceType === 'standard');
        setKioskGatherings(kioskList);
        setNoGatherings(kioskList.length === 0);
        try {
          localStorage.setItem('gatherings_cached_data', JSON.stringify({ gatherings: all, timestamp: Date.now() }));
        } catch {
          // ignore cache write failures
        }

        // Auto-start for attendance_taker with single gathering + single mode
        if (isAttendanceTaker && kioskList.length === 1 && !checkIns.gatheringId) {
          const g = kioskList[0];
          const hasSelf = !!g.kioskEnabled;
          const hasLeader = !!g.leaderCheckinEnabled;
          if (hasLeader && !hasSelf) {
            // Leader-only: go straight to leader check-in
            const { date, daysAway: da } = getNextGatheringDate(g);
            setSelectedGathering(g);
            setGatheringDate(date);
            setDaysAway(da);
            checkIns.startLeaderSession(g.id, g.name, date);
            setActiveMode('leader');
          } else if (hasSelf && !hasLeader) {
            // Self-only: auto-select gathering but show setup page (don't auto-start)
            const { date, daysAway: da } = getNextGatheringDate(g);
            setSelectedGathering(g);
            setGatheringDate(date);
            setDaysAway(da);
            checkIns.setMode('self');
            setActiveMode('self');
          }
        }

        // Restore persisted session from context
        if (checkIns.gatheringId && checkIns.mode) {
          const g = all.find(gr => gr.id === checkIns.gatheringId);
          if (g) {
            setSelectedGathering(g);
            if (checkIns.mode === 'leader' && checkIns.selectedDate) {
              setGatheringDate(checkIns.selectedDate);
              setDaysAway(0);
            } else {
              const { date, daysAway: da } = getNextGatheringDate(g);
              setGatheringDate(date);
              setDaysAway(da);
            }
          } else {
            setSelectedGathering({
              id: checkIns.gatheringId!,
              name: checkIns.gatheringName || 'Gathering',
              attendanceType: 'standard',
              isActive: true,
              kioskEnabled: true,
            } as GatheringType);
            if (checkIns.selectedDate) {
              setGatheringDate(checkIns.selectedDate);
            }
          }
          setActiveMode(checkIns.mode);
        }
      } catch {
```

with:

```ts
      // Step 2: Fetch fresh data (+ kiosk status) and cache for next visit
      try {
        const [gatheringsResponse, statusResponse] = await Promise.all([
          gatheringsAPI.getAll(),
          kioskAPI.getStatus().catch(() => ({ data: { enabled: false } })),
        ]);
        const kioskGloballyEnabled = !!statusResponse.data.enabled;
        setKioskModeEnabled(kioskGloballyEnabled);
        const rawAll: GatheringType[] = gatheringsResponse.data.gatherings || [];
        const all: GatheringType[] = kioskGloballyEnabled ? rawAll : rawAll.map(g => ({ ...g, kioskEnabled: false }));
        const kioskList = all.filter(g => (g.kioskEnabled || g.leaderCheckinEnabled) && g.attendanceType === 'standard');
        setKioskGatherings(kioskList);
        setNoGatherings(kioskList.length === 0);
        try {
          localStorage.setItem('gatherings_cached_data', JSON.stringify({ gatherings: rawAll, timestamp: Date.now() }));
        } catch {
          // ignore cache write failures
        }

        // Auto-start for attendance_taker with single gathering + single mode
        if (isAttendanceTaker && kioskList.length === 1 && !checkIns.gatheringId) {
          const g = kioskList[0];
          const hasSelf = !!g.kioskEnabled;
          const hasLeader = !!g.leaderCheckinEnabled;
          if (hasLeader && !hasSelf) {
            // Leader-only: go straight to leader check-in
            const { date, daysAway: da } = getNextGatheringDate(g);
            setSelectedGathering(g);
            setGatheringDate(date);
            setDaysAway(da);
            checkIns.startLeaderSession(g.id, g.name, date);
            setActiveMode('leader');
          } else if (hasSelf && !hasLeader) {
            // Self-only: auto-select gathering but show setup page (don't auto-start)
            const { date, daysAway: da } = getNextGatheringDate(g);
            setSelectedGathering(g);
            setGatheringDate(date);
            setDaysAway(da);
            checkIns.setMode('self');
            setActiveMode('self');
          }
        }

        // Restore persisted session from context
        if (checkIns.gatheringId && checkIns.mode) {
          const g = all.find(gr => gr.id === checkIns.gatheringId);
          if (g) {
            setSelectedGathering(g);
            if (checkIns.mode === 'leader' && checkIns.selectedDate) {
              setGatheringDate(checkIns.selectedDate);
              setDaysAway(0);
            } else {
              const { date, daysAway: da } = getNextGatheringDate(g);
              setGatheringDate(date);
              setDaysAway(da);
            }
          } else {
            setSelectedGathering({
              id: checkIns.gatheringId!,
              name: checkIns.gatheringName || 'Gathering',
              attendanceType: 'standard',
              isActive: true,
              kioskEnabled: kioskGloballyEnabled,
            } as GatheringType);
            if (checkIns.selectedDate) {
              setGatheringDate(checkIns.selectedDate);
            }
          }
          setActiveMode(checkIns.mode);
        }
      } catch {
```

- [ ] **Step 5: Sanitize the fetch-failure cache fallback**

Replace:

```ts
      } catch {
        // API failed - try cache as fallback; if no cache, show no gatherings
        try {
          const cachedGatherings = localStorage.getItem('gatherings_cached_data');
          if (cachedGatherings) {
            const parsed = JSON.parse(cachedGatherings);
            const all: GatheringType[] = parsed.gatherings || [];
            const kioskList = all.filter((g: GatheringType) => (g.kioskEnabled || g.leaderCheckinEnabled) && g.attendanceType === 'standard');
            setKioskGatherings(kioskList);
            setNoGatherings(kioskList.length === 0);
          } else {
            setNoGatherings(true);
          }
        } catch {
          setNoGatherings(true);
        }
      } finally {
```

with:

```ts
      } catch {
        // API failed - try cache as fallback; if no cache, show no gatherings
        try {
          const cachedGatherings = localStorage.getItem('gatherings_cached_data');
          if (cachedGatherings) {
            const parsed = JSON.parse(cachedGatherings);
            const rawAll: GatheringType[] = parsed.gatherings || [];
            // Couldn't confirm kiosk status from the server; default self check-in to off
            const all: GatheringType[] = rawAll.map(g => ({ ...g, kioskEnabled: false }));
            const kioskList = all.filter((g: GatheringType) => (g.kioskEnabled || g.leaderCheckinEnabled) && g.attendanceType === 'standard');
            setKioskGatherings(kioskList);
            setNoGatherings(kioskList.length === 0);
          } else {
            setNoGatherings(true);
          }
        } catch {
          setNoGatherings(true);
        }
      } finally {
```

- [ ] **Step 6: Guard the two `SelfCheckInMode` render blocks**

This is the defense-in-depth net: it covers a session that was persisted (in `sessionStorage`, via `CheckInsContext`) with `mode: 'self'` *before* this deploy, or while `KIOSK_MODE_ENABLED` was flipped from true back to false. Without this, reloading such a tab would still restore `activeMode === 'self'` and render `SelfCheckInMode`, defeating the point of the gate — this is the one piece the "sanitize `all`" approach above can't reach on its own.

Replace:

```ts
  // If locked, go directly to self check-in
  if (checkIns.isLocked && selectedGathering && activeMode === 'self') {
```

with:

```ts
  // If locked, go directly to self check-in
  if (kioskModeEnabled && checkIns.isLocked && selectedGathering && activeMode === 'self') {
```

Replace:

```ts
  // Self check-in mode
  if (activeMode === 'self' && selectedGathering) {
```

with:

```ts
  // Self check-in mode
  if (kioskModeEnabled && activeMode === 'self' && selectedGathering) {
```

- [ ] **Step 7: Rebuild client and manually verify**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
docker-compose -f docker-compose.dev.yml logs --tail=30 client
```

Expected: no compile errors.

With `KIOSK_MODE_ENABLED` unset/false on the server, open the app in a browser, go to a gathering that has "Self Check-in" enabled in its settings, and go to Check-ins. Expected: the "Self Check-in" mode button is not offered (if the gathering also has Leader Check-in enabled, only that button shows; if self check-in was its only mode, the gathering doesn't appear in the picker / "No Check-in Gatherings" shows).

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/CheckInsPage.tsx
git commit -m "$(cat <<'EOF'
feat(kiosk): hide self check-in entry points when globally disabled

Sanitizes fetched/cached gathering data so every existing self-checkin
check in this file (auto-start, mode buttons, persisted-session
restore) naturally resolves to "unavailable," plus a render-time guard
for sessions persisted before the flag existed.
EOF
)"
```

---

### Task 4: Gate the kiosk-settings toggle in `ManageGatheringsPage.tsx`

This is the admin form that turns `kiosk_enabled` on per-gathering. Hiding the checkbox here stops admins from re-enabling self check-in while it's globally off (the "Leader Check-in" checkbox next to it is untouched — that's a separate, unaffected feature).

**Files:**
- Modify: `client/src/pages/ManageGatheringsPage.tsx:5` (import)
- Modify: `client/src/pages/ManageGatheringsPage.tsx:145-149` (state + effect)
- Modify: `client/src/pages/ManageGatheringsPage.tsx:1131-1174` (edit-form toggle)
- Modify: `client/src/pages/ManageGatheringsPage.tsx:1359-1402` (create-form toggle)

- [ ] **Step 1: Import `kioskAPI`**

Replace:

```ts
import { gatheringsAPI, onboardingAPI } from '../services/api';
```

with:

```ts
import { gatheringsAPI, onboardingAPI, kioskAPI } from '../services/api';
```

- [ ] **Step 2: Fetch the kiosk status once on mount**

Replace:

```ts
  const [selectedGatherings, setSelectedGatherings] = useState<number[]>([]);

  useEffect(() => {
    loadGatherings();
  }, []);
```

with:

```ts
  const [selectedGatherings, setSelectedGatherings] = useState<number[]>([]);

  // Self check-in / kiosk mode is off unless KIOSK_MODE_ENABLED=true on the server
  const [kioskModeEnabled, setKioskModeEnabled] = useState(false);

  useEffect(() => {
    loadGatherings();
  }, []);

  useEffect(() => {
    kioskAPI.getStatus()
      .then(response => setKioskModeEnabled(!!response.data.enabled))
      .catch(() => setKioskModeEnabled(false));
  }, []);
```

- [ ] **Step 3: Hide the "Self Check-in" checkbox in the edit form**

Replace:

```ts
                {/* Check-in Mode Toggles - only for standard gatherings */}
                {editFormData.attendanceType === 'standard' && (
                  <div className="space-y-3">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Check-in Modes</label>
                    <div>
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editFormData.kioskEnabled || false}
                          onChange={(e) => setEditFormData({ ...editFormData, kioskEnabled: e.target.checked })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                        />
                        <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                          Self Check-in
                        </span>
                      </label>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                        Self-service / kiosk mode where individuals check themselves in.
                      </p>
                    </div>
                    <div>
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editFormData.leaderCheckinEnabled || false}
                          onChange={(e) => setEditFormData({ ...editFormData, leaderCheckinEnabled: e.target.checked })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                        />
                        <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                          Leader Check-in
                        </span>
                      </label>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                        A leader checks people in and out on their behalf.
                      </p>
                    </div>
                    {(editFormData.kioskEnabled || editFormData.leaderCheckinEnabled) && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 ml-6">
                        Uses the gathering's end time to close sign-in.
                        {editFormData.kioskEnabled && editFormData.leaderCheckinEnabled && ' Both modes will be available on the check-ins page.'}
                      </p>
                    )}
                  </div>
                )}
```

with:

```ts
                {/* Check-in Mode Toggles - only for standard gatherings */}
                {editFormData.attendanceType === 'standard' && (
                  <div className="space-y-3">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Check-in Modes</label>
                    {kioskModeEnabled && (
                      <div>
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editFormData.kioskEnabled || false}
                            onChange={(e) => setEditFormData({ ...editFormData, kioskEnabled: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                          />
                          <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                            Self Check-in
                          </span>
                        </label>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                          Self-service / kiosk mode where individuals check themselves in.
                        </p>
                      </div>
                    )}
                    <div>
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editFormData.leaderCheckinEnabled || false}
                          onChange={(e) => setEditFormData({ ...editFormData, leaderCheckinEnabled: e.target.checked })}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                        />
                        <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                          Leader Check-in
                        </span>
                      </label>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                        A leader checks people in and out on their behalf.
                      </p>
                    </div>
                    {(editFormData.kioskEnabled || editFormData.leaderCheckinEnabled) && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 ml-6">
                        Uses the gathering's end time to close sign-in.
                        {editFormData.kioskEnabled && editFormData.leaderCheckinEnabled && ' Both modes will be available on the check-ins page.'}
                      </p>
                    )}
                  </div>
                )}
```

- [ ] **Step 4: Hide the "Self Check-in" checkbox in the create form**

Replace:

```ts
                  {/* Check-in Mode Toggles - only for standard gatherings */}
                  {createGatheringData.attendanceType === 'standard' && (
                    <div className="space-y-3">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Check-in Modes</label>
                      <div>
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={createGatheringData.kioskEnabled || false}
                            onChange={(e) => setCreateGatheringData({ ...createGatheringData, kioskEnabled: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                          />
                          <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                            Self Check-in
                          </span>
                        </label>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                          Self-service / kiosk mode where individuals check themselves in.
                        </p>
                      </div>
                      <div>
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={createGatheringData.leaderCheckinEnabled || false}
                            onChange={(e) => setCreateGatheringData({ ...createGatheringData, leaderCheckinEnabled: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                          />
                          <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                            Leader Check-in
                          </span>
                        </label>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                          A leader checks people in and out on their behalf.
                        </p>
                      </div>
                      {(createGatheringData.kioskEnabled || createGatheringData.leaderCheckinEnabled) && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 ml-6">
                          Uses the gathering's end time to close sign-in.
                          {createGatheringData.kioskEnabled && createGatheringData.leaderCheckinEnabled && ' Both modes will be available on the check-ins page.'}
                        </p>
                      )}
                    </div>
                  )}
```

with:

```ts
                  {/* Check-in Mode Toggles - only for standard gatherings */}
                  {createGatheringData.attendanceType === 'standard' && (
                    <div className="space-y-3">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Check-in Modes</label>
                      {kioskModeEnabled && (
                        <div>
                          <label className="flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={createGatheringData.kioskEnabled || false}
                              onChange={(e) => setCreateGatheringData({ ...createGatheringData, kioskEnabled: e.target.checked })}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                            />
                            <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                              Self Check-in
                            </span>
                          </label>
                          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                            Self-service / kiosk mode where individuals check themselves in.
                          </p>
                        </div>
                      )}
                      <div>
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={createGatheringData.leaderCheckinEnabled || false}
                            onChange={(e) => setCreateGatheringData({ ...createGatheringData, leaderCheckinEnabled: e.target.checked })}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                          />
                          <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                            Leader Check-in
                          </span>
                        </label>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ml-6">
                          A leader checks people in and out on their behalf.
                        </p>
                      </div>
                      {(createGatheringData.kioskEnabled || createGatheringData.leaderCheckinEnabled) && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 ml-6">
                          Uses the gathering's end time to close sign-in.
                          {createGatheringData.kioskEnabled && createGatheringData.leaderCheckinEnabled && ' Both modes will be available on the check-ins page.'}
                        </p>
                      )}
                    </div>
                  )}
```

- [ ] **Step 5: Rebuild client and manually verify**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
docker-compose -f docker-compose.dev.yml logs --tail=30 client
```

Expected: no compile errors. In the browser, as an admin, open Manage Gatherings, edit a standard gathering, and open its check-in modes: with `KIOSK_MODE_ENABLED` unset, only "Leader Check-in" is offered. Same for the "create gathering" form. Set `KIOSK_MODE_ENABLED=true` and restart the server; reload the page — "Self Check-in" reappears in both forms.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/ManageGatheringsPage.tsx
git commit -m "$(cat <<'EOF'
feat(kiosk): hide the self check-in admin toggle when globally disabled
EOF
)"
```

---

### Task 5: Document the flag in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md:164-180`

- [ ] **Step 1: Add a note to the Attendance System section**

Replace:

```markdown
### Attendance System

The application supports two attendance tracking modes:

1. **Standard Mode**: Individual check-ins with present/absent status
   - Family-grouped display
   - Visitor tracking with family grouping
   - Tri-state attendance: present, absent, not-tracking
   - Quick add for regulars and visitors

2. **Headcount Mode**: Simple headcount entry
   - Multiple attendance takers can submit counts independently
   - Supports three aggregation modes:
     - `separate` - Show individual counts
     - `combined` - Sum all counts
     - `averaged` - Average all counts
   - Real-time updates via WebSocket
```

with:

```markdown
### Attendance System

The application supports two attendance tracking modes:

1. **Standard Mode**: Individual check-ins with present/absent status
   - Family-grouped display
   - Visitor tracking with family grouping
   - Tri-state attendance: present, absent, not-tracking
   - Quick add for regulars and visitors
   - Includes an optional **self check-in / kiosk mode**, gated behind
     `KIOSK_MODE_ENABLED` in `server/.env` (default off). It's disabled by
     default because the current self-checkin UI loads the entire church
     roster into the browser for use on an unattended, PIN-locked device —
     see `docs/superpowers/specs/2026-07-13-kiosk-mode-env-gate-design.md`.
     Only turn it on once that's redesigned.

2. **Headcount Mode**: Simple headcount entry
   - Multiple attendance takers can submit counts independently
   - Supports three aggregation modes:
     - `separate` - Show individual counts
     - `combined` - Sum all counts
     - `averaged` - Average all counts
   - Real-time updates via WebSocket
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: note KIOSK_MODE_ENABLED gate in CLAUDE.md
EOF
)"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full stack rebuild**

```bash
docker-compose -f docker-compose.dev.yml build
docker-compose -f docker-compose.dev.yml up -d
docker-compose -f docker-compose.dev.yml logs --tail=50
```

Expected: both `server` and `client` start with no errors.

- [ ] **Step 2: Confirm default-off behavior end-to-end**

With `KIOSK_MODE_ENABLED` unset in `server/.env`:
- Log into the app as an admin.
- Manage Gatherings → edit a standard gathering that previously had "Self Check-in" enabled in the DB → confirm the checkbox is hidden and "Leader Check-in" still works normally.
- Check-ins page → confirm no "Self Check-in" button appears for any gathering, and any gathering whose *only* enabled mode was self check-in no longer appears in the gathering picker.
- `curl -s http://localhost/api/kiosk/status -H "Cookie: <session cookie>"` → `{"enabled":false}`.
- Attempt a direct POST to `/api/kiosk/<gatheringTypeId>/<date>` → `403 KIOSK_DISABLED`.

- [ ] **Step 3: Confirm the feature still works when explicitly re-enabled**

Set `KIOSK_MODE_ENABLED=true` in `server/.env`, `docker-compose -f docker-compose.dev.yml restart server`:
- Manage Gatherings → "Self Check-in" checkbox is visible again and can be toggled.
- Check-ins page → for a gathering with self check-in enabled, the button appears, and self check-in works end-to-end (set PIN, check someone in, see it reflected).

Set `KIOSK_MODE_ENABLED` back to unset/false afterward.

- [ ] **Step 4: Report results to the user**

No commit for this task — it's verification only. Summarize what was confirmed (or any deviations found) back to the user.
