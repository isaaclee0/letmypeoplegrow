# PCO Membership/Field Metadata Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist PCO membership categories and custom-field definitions per church so `PlanningCenterBatchEditor` can display them immediately instead of blocking on a live Planning Center fetch, refreshing stale data in the background with a visible indicator.

**Architecture:** Two new JSON blob columns on `church_settings` hold the cached membership tally and field-definitions list, each with a `fetchedAt` timestamp. A new `metadataCache.js` service reads/writes them and dedupes concurrent refreshes per church. The OAuth callback fires a background refresh the moment PCO is connected; the two read routes serve the cache immediately and kick off a background refresh when it's more than an hour old. The client polls the same endpoints while a response says `refreshing: true` and shows a small banner.

**Tech Stack:** Node.js/Express, better-sqlite3 (via `server/config/database.js`), `node:test`, React/TypeScript, Vitest.

**Reference spec:** `docs/superpowers/specs/2026-07-06-pco-metadata-cache-design.md`

---

### Task 1: Persisted cache columns on `church_settings`

**Files:**
- Modify: `server/config/schema.js:126` (end of the `planning_center_*` block in `CREATE TABLE church_settings`)
- Modify: `server/config/database.js:209` (church_settings migration block, right before the `planning_center_sync_batches` migration)

- [ ] **Step 1: Add the columns to the fresh-database schema**

In `server/config/schema.js`, the `church_settings` table currently ends its `planning_center_*` block like this (around line 122-126):

```js
  planning_center_reconciliation_schedule_enabled INTEGER DEFAULT 0,
  planning_center_reconciliation_frequency TEXT DEFAULT 'weekly',
  planning_center_reconciliation_day INTEGER DEFAULT 1,
  planning_center_reconciliation_last_run_at TEXT,
  planning_center_reconciliation_last_result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
```

Change it to:

```js
  planning_center_reconciliation_schedule_enabled INTEGER DEFAULT 0,
  planning_center_reconciliation_frequency TEXT DEFAULT 'weekly',
  planning_center_reconciliation_day INTEGER DEFAULT 1,
  planning_center_reconciliation_last_run_at TEXT,
  planning_center_reconciliation_last_result TEXT,
  planning_center_membership_cache TEXT,
  planning_center_field_definitions_cache TEXT,
  created_at TEXT DEFAULT (datetime('now')),
```

- [ ] **Step 2: Add the migration for existing church databases**

In `server/config/database.js`, find this block (around line 205-210):

```js
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_last_run_at')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_last_run_at TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_last_result')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_last_result TEXT');
      }
```

Add immediately after it:

```js
      if (!settingsCols.some(c => c.name === 'planning_center_membership_cache')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_membership_cache TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_field_definitions_cache')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_field_definitions_cache TEXT');
      }
```

- [ ] **Step 3: Verify the migration runs cleanly**

This project's SQLite migrations aren't unit tested (there's no `schema.test.js` or `database.test.js` in the codebase — verified by searching for both before writing this plan). Verify manually instead:

Run: `docker-compose -f docker-compose.dev.yml restart server` (or however the dev server is currently running — it auto-reloads on file change via nodemon, so a restart isn't strictly required, but do one to force the migration path to run against an already-existing church db)

Then check the columns exist on an existing church db, e.g.:

```bash
docker exec church_attendance_server_dev sqlite3 /app/data/churches/kin_29b2699f71b1.sqlite ".schema church_settings" | grep planning_center_membership_cache
```

Expected: prints the `planning_center_membership_cache TEXT` line with no errors in `docker logs church_attendance_server_dev`.

- [ ] **Step 4: Commit**

```bash
git add server/config/schema.js server/config/database.js
git commit -m "feat(pco): add persisted membership/field-definitions cache columns"
```

---

### Task 2: `metadataCache.js` service

**Files:**
- Create: `server/services/planningCenter/metadataCache.js`
- Test: `server/services/planningCenter/metadataCache.test.js`

This service has two kinds of logic: a pure staleness check (fully unit-testable) and DB/PCO-touching read/write/dedup functions. Note that none of the existing PCO services in this codebase unit-test their DB- or PCO-API-touching functions directly (e.g. `getCachedPcoPeople`'s in-memory cache/TTL in `planningCenterSync.js` has no dedicated test) — only pure logic like `isDueToday` is tested. This plan follows that same convention: TDD the pure `isStale` check, implement the rest directly, and verify it end-to-end manually in Task 8.

- [ ] **Step 1: Write the failing test for `isStale`**

Create `server/services/planningCenter/metadataCache.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isStale, STALE_MS } = require('./metadataCache');

test('isStale: missing fetchedAt is always stale', () => {
  assert.strictEqual(isStale(null), true);
  assert.strictEqual(isStale(undefined), true);
});

test('isStale: false when age is under the threshold', () => {
  const now = 1000000;
  assert.strictEqual(isStale(now - (STALE_MS - 1), now), false);
});

test('isStale: true when age is over the threshold', () => {
  const now = 1000000;
  assert.strictEqual(isStale(now - (STALE_MS + 1), now), true);
});

test('isStale: exactly at the threshold is not yet stale', () => {
  const now = 1000000;
  assert.strictEqual(isStale(now - STALE_MS, now), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test services/planningCenter/metadataCache.test.js`
Expected: FAIL — `Cannot find module './metadataCache'` (the file doesn't exist yet).

- [ ] **Step 3: Create `metadataCache.js` with `isStale` plus the full service**

Create `server/services/planningCenter/metadataCache.js`:

```js
const Database = require('../../config/database');
const { getCachedPcoPeople } = require('../planningCenterSync');
const { tallyMembership } = require('./summary');
const { fetchFieldDefinitions } = require('./fieldDefinitions');

// How old the persisted membership/field-definitions snapshot can get before a read
// triggers a background refresh. Independent of the 10-minute in-memory PCO-people
// cache in planningCenterSync.js — this one only gates the batch editor's metadata
// display, not sync correctness.
const STALE_MS = 60 * 60 * 1000; // 1 hour

function isStale(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return true;
  return (now - fetchedAt) > STALE_MS;
}

async function getMembershipCache(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    'SELECT planning_center_membership_cache AS raw FROM church_settings WHERE church_id = ?',
    [churchId]
  );
  const raw = rows[0] && rows[0].raw;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function getFieldDefinitionsCache(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    'SELECT planning_center_field_definitions_cache AS raw FROM church_settings WHERE church_id = ?',
    [churchId]
  );
  const raw = rows[0] && rows[0].raw;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Dedup concurrent refreshes for the same church — two admins opening the batch
// editor at once (or an on-demand refresh overlapping the connect-time one) share one
// underlying PCO fetch instead of triggering it twice.
const refreshInFlight = new Map(); // churchId -> Promise<{ membership, fieldDefinitions }>

async function refreshMetadataForChurch(churchId, accessToken) {
  const existing = refreshInFlight.get(churchId);
  if (existing) return existing;

  const promise = (async () => {
    const [{ people }, definitions] = await Promise.all([
      getCachedPcoPeople(churchId, accessToken),
      fetchFieldDefinitions(accessToken),
    ]);
    const membership = { ...tallyMembership(people), fetchedAt: Date.now() };
    const fieldDefinitions = { definitions, fetchedAt: Date.now() };
    await Database.queryForChurch(
      churchId,
      `UPDATE church_settings
          SET planning_center_membership_cache = ?, planning_center_field_definitions_cache = ?
        WHERE church_id = ?`,
      [JSON.stringify(membership), JSON.stringify(fieldDefinitions), churchId]
    );
    return { membership, fieldDefinitions };
  })();

  refreshInFlight.set(churchId, promise);
  try {
    return await promise;
  } finally {
    refreshInFlight.delete(churchId);
  }
}

module.exports = { STALE_MS, isStale, getMembershipCache, getFieldDefinitionsCache, refreshMetadataForChurch };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test services/planningCenter/metadataCache.test.js`
Expected: `pass 4`, `fail 0`.

- [ ] **Step 5: Run the full server test suite to check for regressions**

Run: `cd server && node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all tests pass (105 pre-existing + 4 new = 109; no failures).

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenter/metadataCache.js server/services/planningCenter/metadataCache.test.js
git commit -m "feat(pco): add persisted metadata cache service for membership/field definitions"
```

---

### Task 3: Warm the cache when PCO is first connected

**Files:**
- Modify: `server/routes/integrations.js:11` (add require)
- Modify: `server/routes/integrations.js:1906-1911` (OAuth callback)

- [ ] **Step 1: Add the require**

In `server/routes/integrations.js`, find (around line 9-11):

```js
const pcoSync = require('../services/planningCenterSync');
const { tallyMembership, tallyField } = require('../services/planningCenter/summary');
const { fetchFieldDefinitions } = require('../services/planningCenter/fieldDefinitions');
```

Add a line after it:

```js
const pcoSync = require('../services/planningCenterSync');
const { tallyMembership, tallyField } = require('../services/planningCenter/summary');
const { fetchFieldDefinitions } = require('../services/planningCenter/fieldDefinitions');
const metadataCache = require('../services/planningCenter/metadataCache');
```

- [ ] **Step 2: Fire a background refresh right after tokens are saved**

In the same file, find the OAuth callback (around line 1906-1911):

```js
    const tokens = response.data;
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000); // Calculate expiration time

    // Save tokens to database
    await savePlanningCenterTokens(userId, churchId, tokens);

    // Re-validate returnTo on the way out (defense in depth).
```

Change to:

```js
    const tokens = response.data;
    tokens.expires_at = Date.now() + (tokens.expires_in * 1000); // Calculate expiration time

    // Save tokens to database
    await savePlanningCenterTokens(userId, churchId, tokens);

    // Warm the membership/field-definitions cache as soon as PCO is connected, so the
    // batch editor has something to show immediately the first time someone opens it,
    // instead of blocking on a live fetch. Fire-and-forget — errors are logged, not
    // surfaced, and must not delay the redirect below.
    metadataCache.refreshMetadataForChurch(churchId, tokens.access_token)
      .catch((e) => logger.error('PCO connect-time metadata refresh error:', e));

    // Re-validate returnTo on the way out (defense in depth).
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): warm membership/field-definitions cache on PCO connect"
```

---

### Task 4: Serve cache-first from the two read routes

**Files:**
- Modify: `server/routes/integrations.js:2872-2899`

- [ ] **Step 1: Replace the membership-summary and field-definitions routes**

Find (around line 2871-2899):

```js
// Membership distribution for the allow-list editor (person counts only, no check-ins)
router.get('/planning-center/membership-summary', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const { people } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
    res.json({ success: true, ...tallyMembership(people) });
  } catch (error) {
    logger.error('PCO membership summary error:', error);
    res.status(500).json({ error: 'Failed to load membership summary.' });
  }
});

// Custom field definitions (select/checkbox only) for the field-filter editor
router.get('/planning-center/field-definitions', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const definitions = await fetchFieldDefinitions(accessToken);
    res.json({ success: true, definitions });
  } catch (error) {
    logger.error('PCO field definitions error:', error);
    res.status(500).json({ error: 'Failed to load custom field definitions.' });
  }
});
```

Replace with:

```js
// Membership distribution for the allow-list editor (person counts only, no check-ins).
// Serves the persisted cache immediately; if it's missing, blocks on a live fetch (and
// populates the cache as a side effect); if it's present but stale, serves it as-is and
// kicks off a background refresh, flagged via `refreshing` so the client can show it's
// checking Planning Center for updates.
router.get('/planning-center/membership-summary', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const cached = await metadataCache.getMembershipCache(churchId);
    if (!cached) {
      const { membership } = await metadataCache.refreshMetadataForChurch(churchId, accessToken);
      return res.json({ success: true, ...membership, refreshing: false });
    }
    const stale = metadataCache.isStale(cached.fetchedAt);
    if (stale) {
      metadataCache.refreshMetadataForChurch(churchId, accessToken)
        .catch((e) => logger.error('PCO membership cache refresh error:', e));
    }
    res.json({ success: true, ...cached, refreshing: stale });
  } catch (error) {
    logger.error('PCO membership summary error:', error);
    res.status(500).json({ error: 'Failed to load membership summary.' });
  }
});

// Custom field definitions (select/checkbox only) for the field-filter editor. Same
// cache-first/background-refresh treatment as membership-summary above.
router.get('/planning-center/field-definitions', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const cached = await metadataCache.getFieldDefinitionsCache(churchId);
    if (!cached) {
      const { fieldDefinitions } = await metadataCache.refreshMetadataForChurch(churchId, accessToken);
      return res.json({ success: true, ...fieldDefinitions, refreshing: false });
    }
    const stale = metadataCache.isStale(cached.fetchedAt);
    if (stale) {
      metadataCache.refreshMetadataForChurch(churchId, accessToken)
        .catch((e) => logger.error('PCO field definitions cache refresh error:', e));
    }
    res.json({ success: true, ...cached, refreshing: stale });
  } catch (error) {
    logger.error('PCO field definitions error:', error);
    res.status(500).json({ error: 'Failed to load custom field definitions.' });
  }
});
```

Note: the `field-summary` route directly below (per-field value counts, `tallyField`) is unchanged — it's out of scope per the design doc (only definitions + membership are cached, not per-field counts).

- [ ] **Step 2: Check for now-unused imports**

`tallyMembership` and `fetchFieldDefinitions` are still used elsewhere in this file (inside `metadataCache.js` for `fetchFieldDefinitions`/`tallyMembership`, but those are separate module-local requires — check whether `server/routes/integrations.js` itself still uses its own top-level `tallyMembership` and `fetchFieldDefinitions` imports anywhere else in the file, e.g. the `field-summary` route uses `fetchFieldDefinitions` and `tallyField`).

Run: `grep -n "tallyMembership\|fetchFieldDefinitions" server/routes/integrations.js`

Expected: `fetchFieldDefinitions` still used in the `field-summary` route; `tallyMembership` now has zero remaining call sites in this file. Remove the now-dead `tallyMembership` import from the destructured require on line 10 (leave `tallyField`):

```js
const { tallyField } = require('../services/planningCenter/summary');
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/integrations.js
git commit -m "feat(pco): serve membership/field-definitions cache-first with background refresh"
```

---

### Task 5: Client polling hook

**Files:**
- Create: `client/src/hooks/usePcoRefreshPoll.ts`

No test file for this one — this codebase has no test files for any of its existing hooks (`client/src/hooks/*.ts`, verified by search before writing this plan), so a new hook test would be inventing a pattern the codebase doesn't otherwise use. Verified instead via the browser in Task 8.

- [ ] **Step 1: Create the hook**

Create `client/src/hooks/usePcoRefreshPoll.ts`:

```ts
import { useEffect, useRef } from 'react';

const POLL_INTERVAL_MS = 3000;

// Re-runs `check` every POLL_INTERVAL_MS while `refreshing` is true, and stops as soon
// as it becomes false (or the component unmounts). `check` is expected to update
// `refreshing` itself once its fetch resolves — each call either flips `refreshing` to
// false (stopping the loop) or schedules the next one.
export function usePcoRefreshPoll(refreshing: boolean, check: () => void): void {
  const checkRef = useRef(check);
  checkRef.current = check;

  useEffect(() => {
    if (!refreshing) return;
    const timeoutId = setTimeout(() => checkRef.current(), POLL_INTERVAL_MS);
    return () => clearTimeout(timeoutId);
  }, [refreshing]);
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/hooks/usePcoRefreshPoll.ts
git commit -m "feat(pco): add polling hook for background metadata refresh"
```

---

### Task 6: `FieldFilterEditor` tracks and reports refresh state

**Files:**
- Modify: `client/src/components/planningCenter/FieldFilterEditor.tsx`

- [ ] **Step 1: Track `refreshing`, add the `onRefreshingChange` prop, and poll**

The current top of the file:

```tsx
import React, { useEffect, useState } from 'react';
import { integrationsAPI } from '../../services/api';

export interface FieldDefinition {
  id: string;
  name: string;
  dataType: string;
  tabName: string | null;
}

export interface FieldFilterRule {
  fieldDefinitionId: string;
  tabName: string | null;
  fieldName: string;
  values: string[];
}

interface Props {
  rules: FieldFilterRule[];
  onChange: (next: FieldFilterRule[]) => void;
}

export default function FieldFilterEditor({ rules, onChange }: Props) {
  const [definitions, setDefinitions] = useState<FieldDefinition[]>([]);
  const [definitionsLoading, setDefinitionsLoading] = useState(true);
  const [definitionsError, setDefinitionsError] = useState<string | null>(null);
  // Per-field-definition value tally state, loaded lazily when a field is chosen.
  // Keyed by fieldDefinitionId (not array index) so it stays valid when rules are reordered/removed.
  const [valueOptions, setValueOptions] = useState<Record<string, { value: string; count: number }[]>>({});
  const [valueLoading, setValueLoading] = useState<Record<string, boolean>>({});
  const [valueError, setValueError] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let cancelled = false;
    setDefinitionsLoading(true);
    setDefinitionsError(null);
    integrationsAPI.getPlanningCenterFieldDefinitions()
      .then((res) => { if (!cancelled) setDefinitions(res.data.definitions || []); })
      .catch((e) => { if (!cancelled) setDefinitionsError(e.response?.data?.error || 'Failed to load custom fields.'); })
      .finally(() => { if (!cancelled) setDefinitionsLoading(false); });
    return () => { cancelled = true; };
  }, []);
```

Replace with:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { integrationsAPI } from '../../services/api';
import { usePcoRefreshPoll } from '../../hooks/usePcoRefreshPoll';

export interface FieldDefinition {
  id: string;
  name: string;
  dataType: string;
  tabName: string | null;
}

export interface FieldFilterRule {
  fieldDefinitionId: string;
  tabName: string | null;
  fieldName: string;
  values: string[];
}

interface Props {
  rules: FieldFilterRule[];
  onChange: (next: FieldFilterRule[]) => void;
  onRefreshingChange?: (refreshing: boolean) => void;
}

export default function FieldFilterEditor({ rules, onChange, onRefreshingChange }: Props) {
  const [definitions, setDefinitions] = useState<FieldDefinition[]>([]);
  const [definitionsLoading, setDefinitionsLoading] = useState(true);
  const [definitionsError, setDefinitionsError] = useState<string | null>(null);
  const [definitionsRefreshing, setDefinitionsRefreshing] = useState(false);
  // Per-field-definition value tally state, loaded lazily when a field is chosen.
  // Keyed by fieldDefinitionId (not array index) so it stays valid when rules are reordered/removed.
  const [valueOptions, setValueOptions] = useState<Record<string, { value: string; count: number }[]>>({});
  const [valueLoading, setValueLoading] = useState<Record<string, boolean>>({});
  const [valueError, setValueError] = useState<Record<string, string | null>>({});

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadDefinitions = () => {
    setDefinitionsError(null);
    return integrationsAPI.getPlanningCenterFieldDefinitions()
      .then((res) => {
        if (!mountedRef.current) return;
        setDefinitions(res.data.definitions || []);
        setDefinitionsRefreshing(!!res.data.refreshing);
      })
      .catch((e) => {
        if (!mountedRef.current) return;
        setDefinitionsError(e.response?.data?.error || 'Failed to load custom fields.');
        setDefinitionsRefreshing(false);
      })
      .finally(() => { if (mountedRef.current) setDefinitionsLoading(false); });
  };

  useEffect(() => {
    setDefinitionsLoading(true);
    loadDefinitions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePcoRefreshPoll(definitionsRefreshing, loadDefinitions);

  useEffect(() => {
    onRefreshingChange?.(definitionsRefreshing);
  }, [definitionsRefreshing, onRefreshingChange]);
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/planningCenter/FieldFilterEditor.tsx
git commit -m "feat(pco): report background-refresh state from FieldFilterEditor"
```

---

### Task 7: `PlanningCenterBatchEditor` tracks refresh state and shows the banner

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`

- [ ] **Step 1: Add refreshing state, wire it through `loadMembershipSummary`, and poll**

Find (around line 1-53):

```tsx
import React, { useEffect, useState } from 'react';
import { gatheringsAPI, integrationsAPI, SyncBatch, SyncBatchInput } from '../../services/api';
import logger from '../../utils/logger';
import MembershipAllowlistEditor from './MembershipAllowlistEditor';
import FieldFilterEditor, { FieldFilterRule } from './FieldFilterEditor';
```

Add the hook import:

```tsx
import React, { useEffect, useState } from 'react';
import { gatheringsAPI, integrationsAPI, SyncBatch, SyncBatchInput } from '../../services/api';
import logger from '../../utils/logger';
import MembershipAllowlistEditor from './MembershipAllowlistEditor';
import FieldFilterEditor, { FieldFilterRule } from './FieldFilterEditor';
import { usePcoRefreshPoll } from '../../hooks/usePcoRefreshPoll';
```

Find:

```tsx
  const [membershipValues, setMembershipValues] = useState<{ membership: string; count: number }[]>([]);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
```

Replace with:

```tsx
  const [membershipValues, setMembershipValues] = useState<{ membership: string; count: number }[]>([]);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipRefreshing, setMembershipRefreshing] = useState(false);
  const [fieldsRefreshing, setFieldsRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anyRefreshing = membershipRefreshing || fieldsRefreshing;
```

Find:

```tsx
  const loadMembershipSummary = async () => {
    setMembershipLoading(true); setMembershipError(null);
    try {
      const sum = await integrationsAPI.getPlanningCenterMembershipSummary();
      setMembershipValues(sum.data.values || []);
    } catch (e: any) {
      setMembershipError(e.response?.data?.error || 'Failed to load membership categories.');
    } finally {
      setMembershipLoading(false);
    }
  };
```

Replace with:

```tsx
  const loadMembershipSummary = async () => {
    setMembershipLoading(true); setMembershipError(null);
    try {
      const sum = await integrationsAPI.getPlanningCenterMembershipSummary();
      setMembershipValues(sum.data.values || []);
      setMembershipRefreshing(!!sum.data.refreshing);
    } catch (e: any) {
      setMembershipError(e.response?.data?.error || 'Failed to load membership categories.');
      setMembershipRefreshing(false);
    } finally {
      setMembershipLoading(false);
    }
  };

  usePcoRefreshPoll(membershipRefreshing, loadMembershipSummary);
```

- [ ] **Step 2: Wire `onRefreshingChange` into `FieldFilterEditor` and render the banner**

Find:

```tsx
        {fieldFilterEnabled && (
          <FieldFilterEditor rules={fieldFilters} onChange={setFieldFilters} />
        )}
```

Replace with:

```tsx
        {fieldFilterEnabled && (
          <FieldFilterEditor rules={fieldFilters} onChange={setFieldFilters} onRefreshingChange={setFieldsRefreshing} />
        )}
```

Find the end of the component, the save/cancel row and closing tags:

```tsx
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !name.trim() || (!membershipFilterEnabled && !fieldFilterEnabled)}
          className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : batch ? 'Save batch' : 'Create batch'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm underline text-gray-600 dark:text-gray-300">Cancel</button>
      </div>
    </div>
  );
}
```

Replace with:

```tsx
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !name.trim() || (!membershipFilterEnabled && !fieldFilterEnabled)}
          className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : batch ? 'Save batch' : 'Create batch'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm underline text-gray-600 dark:text-gray-300">Cancel</button>
      </div>

      {anyRefreshing && (
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700 pt-3">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-green-600 animate-spin" />
          Checking Planning Center for the latest data…
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterBatchEditor.tsx
git commit -m "feat(pco): show background-refresh banner in the sync batch editor"
```

---

### Task 8: End-to-end verification

**Files:** none (verification only)

This codebase's convention (per `CLAUDE.md`) is to verify UI/frontend changes by running the app in a browser rather than writing component tests (none exist for any component in this codebase). Follow that here.

- [ ] **Step 1: Run the full server test suite**

Run: `cd server && node --test $(find . -name "*.test.js" -not -path "*/node_modules/*")`
Expected: all tests pass, no failures.

- [ ] **Step 2: Confirm the dev containers picked up the changes**

Run: `docker logs church_attendance_server_dev --tail 30` and `docker logs church_attendance_client_dev --tail 30`
Expected: no errors, no crash loop (both mount `./server` and `./client` live, so nodemon/Vite should have already reloaded).

- [ ] **Step 3: Exercise the batch editor for a church with PCO already connected**

Using the browser preview tooling against the running dev app (`http://localhost:3000` or via nginx on `:80`): log in as a church that already has Planning Center connected (its `church_settings` row won't have the new cache columns populated yet, since it connected before this feature existed), open Settings → Integrations → Planning Center → create or edit a sync batch, and confirm:
- The membership and custom-field sections load (first time will be a live fetch, since the cache is empty for a pre-existing connection — this populates the cache as a side effect, per Task 4 Step 1).
- Close and reopen the batch editor. This time the lists should render without any visible delay (served from the now-populated cache).

- [ ] **Step 4: Confirm the background-refresh banner appears when the cache is stale**

Force staleness for the test church without waiting an hour:

```bash
docker exec church_attendance_server_dev sqlite3 /app/data/churches/kin_29b2699f71b1.sqlite \
  "UPDATE church_settings SET planning_center_membership_cache = json_set(planning_center_membership_cache, '\$.fetchedAt', 0) WHERE church_id = 'kin_29b2699f71b1';"
```

(Adjust the church id to whichever one you're testing with, and confirm PCO is connected for it first.) Reopen the batch editor and confirm the "Checking Planning Center for the latest data…" banner appears, then disappears once the background refresh completes (within a few seconds), with the membership list still showing its previous values throughout — not a blank/loading state.

- [ ] **Step 5: Confirm a brand-new PCO connection also warms the cache**

If a test/sandbox PCO account is available: disconnect and reconnect Planning Center for a test church, then immediately open the batch editor. The membership/field lists should either already be populated (if the connect-time background refresh finished first) or briefly show the refreshing banner while empty, without erroring. If no sandbox account is available for this step, confirm instead via `docker logs church_attendance_server_dev --tail 50 | grep "metadata refresh"` that no errors were logged around a manual reconnect.

- [ ] **Step 6: Report results**

Summarize what was verified (and any deviations) back to the user — do not mark this task complete without having actually driven the browser through Steps 3-4 at minimum.
