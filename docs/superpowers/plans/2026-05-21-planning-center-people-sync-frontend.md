# Planning Center People Sync — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use the `frontend-design` skill when building the React components so they match the app's Tailwind + Headless UI style.

**Goal:** Build the admin UI for the Planning Center people sync: replace the old one-time PCO import flow with a configurable allow-list (in Settings) and a "Sync & Review" workspace (on the Import page) that drives the already-built `sync/plan` + `sync/apply` backend.

**Architecture:** A small backend `membership-summary` endpoint feeds an allow-list editor in Settings; the Import page's PCO tab becomes a review workspace that fetches a dry-run plan, lets the admin resolve ambiguous matches / deselect adds, and applies. Two focused components plus a pure selection-builder helper keep the page files thin.

**Tech Stack:** React 19 + TypeScript + Vite, Tailwind CSS, Axios (`client/src/services/api.ts`), vitest (+ @testing-library/react). Backend: Express + `node:test`. **All builds/tests run in Docker** (project rule), never on the host.

**Spec:** `docs/superpowers/specs/2026-05-21-planning-center-people-sync-frontend-design.md`

---

## File Structure

- Create `server/services/planningCenter/summary.js` — pure `tallyMembership(people)` helper
- Create `server/services/planningCenter/summary.test.js` — node:test
- Modify `server/services/planningCenterSync.js` — export `fetchAllPcoPeople`
- Modify `server/routes/integrations.js` — add `membership-summary` route; add `lastSyncResult` to the status route
- Modify `client/src/services/api.ts` — add 5 methods, remove 3 old ones
- Create `client/src/components/planningCenter/syncSelections.ts` — pure `buildSelections` helper
- Create `client/src/components/planningCenter/syncSelections.test.ts` — vitest
- Create `client/src/components/planningCenter/MembershipAllowlistEditor.tsx`
- Create `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`
- Modify `client/src/pages/SettingsPage.tsx` — swap the autoArchive toggle for the sync-config block
- Modify `client/src/pages/ImportPage.tsx` — replace the PCO tab body with `<PlanningCenterSyncReview>`; remove old browse/import/link state

**Test commands (Docker):**
- Backend: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/summary.test.js`
- Frontend unit: `docker compose -f docker-compose.dev.yml exec client npx vitest run src/components/planningCenter/syncSelections.test.ts`
- Frontend typecheck (for component tasks): `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
- (If `tsc --noEmit` errors on project setup, fall back to `docker compose -f docker-compose.dev.yml exec client npm run build`.)

---

## Task 1: Backend — membership tally helper

**Files:**
- Create: `server/services/planningCenter/summary.js`
- Test: `server/services/planningCenter/summary.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/planningCenter/summary.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { tallyMembership } = require('./summary');

test('tallyMembership counts by membership, sorted desc, with total', () => {
  const people = [
    { membership: 'Church Members' },
    { membership: 'Church Members' },
    { membership: 'Community Contact' },
    { membership: null },
  ];
  const result = tallyMembership(people);
  assert.strictEqual(result.total, 4);
  assert.deepStrictEqual(result.values, [
    { membership: 'Church Members', count: 2 },
    { membership: 'Community Contact', count: 1 },
    { membership: '(none)', count: 1 },
  ]);
});

test('tallyMembership handles empty input', () => {
  assert.deepStrictEqual(tallyMembership([]), { total: 0, values: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/summary.test.js`
Expected: FAIL — cannot find module `./summary`.

- [ ] **Step 3: Write the implementation**

Create `server/services/planningCenter/summary.js`:
```javascript
// Tally projected PCO people by membership value. Null/empty membership -> '(none)'.
// Returns { total, values: [{membership, count}] } sorted by count desc.
function tallyMembership(people) {
  const counts = new Map();
  for (const p of people) {
    const key = p.membership || '(none)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const values = [...counts.entries()]
    .map(([membership, count]) => ({ membership, count }))
    .sort((a, b) => b.count - a.count);
  return { total: people.length, values };
}

module.exports = { tallyMembership };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f docker-compose.dev.yml exec server node --test services/planningCenter/summary.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/summary.js server/services/planningCenter/summary.test.js
git commit -m "feat(pco): add membership tally helper"
```

---

## Task 2: Backend — membership-summary endpoint + lastSyncResult on status

**Files:**
- Modify: `server/services/planningCenterSync.js` (export `fetchAllPcoPeople`)
- Modify: `server/routes/integrations.js` (new route + status field)

- [ ] **Step 1: Export `fetchAllPcoPeople` from the sync service**

In `server/services/planningCenterSync.js`, find the `module.exports` block:
```javascript
module.exports = {
  start, stop, runNow, syncChurch,
  getAccessTokenForChurch, computePlanForChurch, applyForChurch,
};
```
Replace it with (add `fetchAllPcoPeople`):
```javascript
module.exports = {
  start, stop, runNow, syncChurch,
  getAccessTokenForChurch, computePlanForChurch, applyForChurch, fetchAllPcoPeople,
};
```

- [ ] **Step 2: Add a require for the tally helper + the membership-summary route**

In `server/routes/integrations.js`, near the existing `const pcoSync = require('../services/planningCenterSync');`, add:
```javascript
const { tallyMembership } = require('../services/planningCenter/summary');
```
Then, immediately after the `GET /planning-center/sync/plan` route, add:
```javascript
// Membership distribution for the allow-list editor (person counts only, no check-ins)
router.get('/planning-center/membership-summary', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const people = await pcoSync.fetchAllPcoPeople(accessToken);
    res.json({ success: true, ...tallyMembership(people) });
  } catch (error) {
    logger.error('PCO membership summary error:', error);
    res.status(500).json({ error: 'Failed to load membership summary.' });
  }
});
```

- [ ] **Step 3: Add `lastSyncResult` to the status response**

In `server/routes/integrations.js`, find the `GET /planning-center/status` handler. Locate where it builds the connected-status JSON response (the object containing `connected: true` / `planningCenterAccount`). Just before that `res.json({...})`, add a read of the stored summary:
```javascript
      let lastSyncResult = null;
      try {
        const rows = await Database.query(
          `SELECT planning_center_last_sync_result AS r FROM church_settings WHERE church_id = ? LIMIT 1`,
          [req.user.church_id]
        );
        if (rows.length && rows[0].r) lastSyncResult = JSON.parse(rows[0].r);
      } catch (_) { lastSyncResult = null; }
```
Then add `lastSyncResult` to that response object, e.g. change `res.json({ enabled: true, connected: true, planningCenterAccount: accountName });` to `res.json({ enabled: true, connected: true, planningCenterAccount: accountName, lastSyncResult });`.
(Read the actual handler first and match its real variable names/shape — add the `lastSyncResult` field to whatever the connected response object is.)

- [ ] **Step 4: Restart and verify routes load + summary returns 401 unauthenticated**

```
docker compose -f docker-compose.dev.yml up -d server nginx && sleep 3 && docker compose -f docker-compose.dev.yml logs --tail=15 server
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/api/integrations/planning-center/membership-summary
```
Expected: clean boot; the curl returns `401` (registered, behind auth — not 404).

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenterSync.js server/routes/integrations.js
git commit -m "feat(pco): add membership-summary endpoint and lastSyncResult on status"
```

---

## Task 3: API client methods

**Files:**
- Modify: `client/src/services/api.ts`

- [ ] **Step 1: Replace the old PCO data methods with the new sync methods**

In `client/src/services/api.ts`, in the `integrationsAPI` object, find these lines:
```typescript
  getPlanningCenterPeople: () => api.get('/integrations/planning-center/people', { timeout: 120000 }),
  getPlanningCenterCheckins: (params: { startDate: string; endDate: string }) =>
    api.get('/integrations/planning-center/checkins', { params, timeout: 120000 }),
  linkPlanningCenterFamily: (data: { householdId: string; familyId: number }) => api.post('/integrations/planning-center/link-family', data),
  importPeopleFromPlanningCenter: (data?: { householdIds?: string[] }) => api.post('/integrations/planning-center/import-people', data || {}, { timeout: 120000 }),
```
Replace them with (drop people/link/import-people; keep checkins which is used by check-in import elsewhere — verify with a grep, see note):
```typescript
  getPlanningCenterCheckins: (params: { startDate: string; endDate: string }) =>
    api.get('/integrations/planning-center/checkins', { params, timeout: 120000 }),
  // People sync (replaces the old browse/import flow)
  getPlanningCenterMembershipSummary: () =>
    api.get('/integrations/planning-center/membership-summary', { timeout: 120000 }),
  getPlanningCenterMembershipFilter: () =>
    api.get('/integrations/planning-center/membership-filter'),
  savePlanningCenterMembershipFilter: (data: { enabled: boolean; allowlist: string[] }) =>
    api.put('/integrations/planning-center/membership-filter', data),
  getPlanningCenterSyncPlan: () =>
    api.get('/integrations/planning-center/sync/plan', { timeout: 120000 }),
  applyPlanningCenterSync: (data: { selections?: { ambiguous?: Record<string, string>; skipAddPcoIds?: string[] } }) =>
    api.post('/integrations/planning-center/sync/apply', data, { timeout: 120000 }),
```

Note: before deleting `getPlanningCenterCheckins`/`importCheckinsFromPlanningCenter`, grep for their usages: `grep -rn "getPlanningCenterCheckins\|importCheckinsFromPlanningCenter\|getPlanningCenterPeople\|importPeopleFromPlanningCenter\|linkPlanningCenterFamily" client/src`. Only remove the three people-flow methods (`getPlanningCenterPeople`, `linkPlanningCenterFamily`, `importPeopleFromPlanningCenter`). Keep the check-in methods (they belong to a different feature). Their call sites in ImportPage are removed in Task 7.

- [ ] **Step 2: Typecheck**

Run: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
Expected: No NEW errors referencing `api.ts`. (There will be errors in `ImportPage.tsx`/`SettingsPage.tsx` still referencing the removed methods — those are fixed in Tasks 5 and 7. If `tsc --noEmit` is noisy, that's expected at this interim step; the key check is that `api.ts` itself has no type errors. Proceed.)

- [ ] **Step 3: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat(pco): add sync API client methods, remove old import methods"
```

---

## Task 4: Pure selection-builder helper

**Files:**
- Create: `client/src/components/planningCenter/syncSelections.ts`
- Test: `client/src/components/planningCenter/syncSelections.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/planningCenter/syncSelections.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildSelections } from './syncSelections';

describe('buildSelections', () => {
  it('maps ambiguous choices and skip set into the apply payload', () => {
    const ambiguousChoices = { 12: 'pco_a', 34: 'pco_b' };
    const skipAddPcoIds = new Set(['pco_x', 'pco_y']);
    expect(buildSelections(ambiguousChoices, skipAddPcoIds)).toEqual({
      ambiguous: { 12: 'pco_a', 34: 'pco_b' },
      skipAddPcoIds: ['pco_x', 'pco_y'],
    });
  });

  it('omits ambiguous entries with no chosen pcoId (skipped)', () => {
    const ambiguousChoices = { 12: 'pco_a', 34: null };
    const result = buildSelections(ambiguousChoices, new Set());
    expect(result.ambiguous).toEqual({ 12: 'pco_a' });
    expect(result.skipAddPcoIds).toEqual([]);
  });

  it('returns empty selections when nothing chosen', () => {
    expect(buildSelections({}, new Set())).toEqual({ ambiguous: {}, skipAddPcoIds: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f docker-compose.dev.yml exec client npx vitest run src/components/planningCenter/syncSelections.test.ts`
Expected: FAIL — cannot resolve `./syncSelections`.

- [ ] **Step 3: Write the implementation**

Create `client/src/components/planningCenter/syncSelections.ts`:
```typescript
// Shapes shared by the sync review UI.
export interface SyncSelections {
  ambiguous: Record<string, string>;
  skipAddPcoIds: string[];
}

// ambiguousChoices: individualId -> chosen pcoId (or null when the reviewer skipped).
// skipAddPcoIds: set of add-bucket pcoIds the reviewer deselected.
export function buildSelections(
  ambiguousChoices: Record<string, string | null>,
  skipAddPcoIds: Set<string>
): SyncSelections {
  const ambiguous: Record<string, string> = {};
  for (const [individualId, pcoId] of Object.entries(ambiguousChoices)) {
    if (pcoId) ambiguous[individualId] = pcoId;
  }
  return { ambiguous, skipAddPcoIds: [...skipAddPcoIds] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f docker-compose.dev.yml exec client npx vitest run src/components/planningCenter/syncSelections.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/planningCenter/syncSelections.ts client/src/components/planningCenter/syncSelections.test.ts
git commit -m "feat(pco): add buildSelections helper for sync review"
```

---

## Task 5: MembershipAllowlistEditor component

**Files:**
- Create: `client/src/components/planningCenter/MembershipAllowlistEditor.tsx`

- [ ] **Step 1: Write the component**

Create `client/src/components/planningCenter/MembershipAllowlistEditor.tsx`:
```tsx
import React from 'react';

export interface MembershipSummaryValue { membership: string; count: number; }

interface Props {
  values: MembershipSummaryValue[];      // from membership-summary
  loading: boolean;
  error: string | null;
  selected: string[];                    // current allowlist
  onChange: (next: string[]) => void;    // selection changed
  onReload: () => void;                   // re-fetch summary
}

export default function MembershipAllowlistEditor({ values, loading, error, selected, onChange, onReload }: Props) {
  const selectedSet = new Set(selected);

  const toggle = (membership: string) => {
    const next = new Set(selectedSet);
    if (next.has(membership)) next.delete(membership); else next.add(membership);
    onChange([...next]);
  };

  if (loading) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading membership categories…</p>;
  }
  if (error) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        {error} <button type="button" onClick={onReload} className="underline ml-1">Retry</button>
      </div>
    );
  }
  if (!values.length) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No membership categories found in Planning Center.</p>;
  }

  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
        Only checked categories add new people. Archiving/updates apply to everyone already linked.
      </p>
      <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
        {values.map((v) => (
          <li key={v.membership} className="flex items-center justify-between px-3 py-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedSet.has(v.membership)}
                onChange={() => toggle(v.membership)}
                className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <span className="text-sm text-gray-900 dark:text-gray-100">{v.membership}</span>
            </label>
            <span className="text-xs text-gray-500 dark:text-gray-400">{v.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck the component**

Run: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
Expected: no type errors originating in `MembershipAllowlistEditor.tsx` (interim errors elsewhere from Task 3 removals are acceptable until Tasks 6–7 land).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/planningCenter/MembershipAllowlistEditor.tsx
git commit -m "feat(pco): add MembershipAllowlistEditor component"
```

---

## Task 6: Settings sync-config block

**Files:**
- Modify: `client/src/pages/SettingsPage.tsx`

Context: the PCO panel currently has (when connected) a `syncIndicator` toggle and an `autoArchive` toggle (the autoArchive block is around lines 1930–1950, handler `handlePcAutoArchiveToggle`, state `pcAutoArchive`). Keep `syncIndicator`. Replace the `autoArchive` toggle with the new sync-config block. Use `useNavigate` from `react-router-dom` for the "Review & sync" button (confirm it's already imported in this file; if not, add it).

- [ ] **Step 1: Add state + load logic**

Near the other Planning Center state (around line 83), add:
```tsx
  const [pcSyncEnabled, setPcSyncEnabled] = useState(false);
  const [pcAllowlist, setPcAllowlist] = useState<string[]>([]);
  const [pcSummary, setPcSummary] = useState<{ membership: string; count: number }[]>([]);
  const [pcSummaryLoading, setPcSummaryLoading] = useState(false);
  const [pcSummaryError, setPcSummaryError] = useState<string | null>(null);
  const [pcConfigDirty, setPcConfigDirty] = useState(false);
  const [pcConfigSaving, setPcConfigSaving] = useState(false);
  const [pcLastSync, setPcLastSync] = useState<any>(null);
  const [pcSyncRunning, setPcSyncRunning] = useState(false);
```

Add a loader function (near `fetchPlanningCenterStatus`):
```tsx
  const loadPcSyncConfig = useCallback(async () => {
    try {
      const filter = await integrationsAPI.getPlanningCenterMembershipFilter();
      setPcSyncEnabled(!!filter.data.enabled);
      setPcAllowlist(Array.isArray(filter.data.allowlist) ? filter.data.allowlist : []);
    } catch (e) { logger.error('Failed to load PCO sync filter', e); }
    setPcSummaryLoading(true);
    setPcSummaryError(null);
    try {
      const sum = await integrationsAPI.getPlanningCenterMembershipSummary();
      setPcSummary(sum.data.values || []);
    } catch (e: any) {
      setPcSummaryError(e.response?.data?.error || 'Failed to load membership categories.');
    } finally {
      setPcSummaryLoading(false);
    }
  }, []);
```

In the existing `fetchPlanningCenterStatus` success path, also capture last sync: after setting status, add `setPcLastSync(response.data.lastSyncResult || null);`. And where the page loads PCO status on mount / when connected, call `loadPcSyncConfig()` when `connected` is true. (Find the existing effect that runs when `planningCenterStatus.connected` becomes true; if none, add `useEffect(() => { if (planningCenterStatus.connected) loadPcSyncConfig(); }, [planningCenterStatus.connected, loadPcSyncConfig]);`.)

- [ ] **Step 2: Add save + sync-now + navigate handlers**

Add near the other PCO handlers:
```tsx
  const savePcSyncConfig = async () => {
    setPcConfigSaving(true);
    try {
      await integrationsAPI.savePlanningCenterMembershipFilter({ enabled: pcSyncEnabled, allowlist: pcAllowlist });
      setPcConfigDirty(false);
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Failed to save sync settings.');
    } finally {
      setPcConfigSaving(false);
    }
  };

  const runPcSyncNow = async () => {
    setPcSyncRunning(true);
    try {
      const res = await integrationsAPI.applyPlanningCenterSync({});
      setPcLastSync(res.data.summary || null);
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Sync failed.');
    } finally {
      setPcSyncRunning(false);
    }
  };
```
Ensure `const navigate = useNavigate();` exists in the component (add the import `import { useNavigate } from 'react-router-dom';` and the hook call if missing).

- [ ] **Step 3: Replace the autoArchive toggle JSX with the sync-config block**

Find the `autoArchive` toggle block (the `<div>` containing the "Automatically archive people…" description and the toggle button calling `handlePcAutoArchiveToggle`). Replace that entire block with:
```tsx
                        {/* Full people sync configuration */}
                        <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Enable Planning Center sync</p>
                              <p className="text-sm text-gray-500 dark:text-gray-400">
                                Treat Planning Center as the source of truth: add eligible people, sync names, archive when inactive (runs nightly).
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => { setPcSyncEnabled(!pcSyncEnabled); setPcConfigDirty(true); }}
                              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${pcSyncEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                              role="switch"
                              aria-checked={pcSyncEnabled}
                            >
                              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${pcSyncEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                            </button>
                          </div>

                          <div className="mt-4">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">Sync these membership categories</p>
                            <MembershipAllowlistEditor
                              values={pcSummary}
                              loading={pcSummaryLoading}
                              error={pcSummaryError}
                              selected={pcAllowlist}
                              onChange={(next) => { setPcAllowlist(next); setPcConfigDirty(true); }}
                              onReload={loadPcSyncConfig}
                            />
                          </div>

                          <div className="mt-4 flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              onClick={savePcSyncConfig}
                              disabled={!pcConfigDirty || pcConfigSaving}
                              className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
                            >
                              {pcConfigSaving ? 'Saving…' : 'Save sync settings'}
                            </button>
                            <button
                              type="button"
                              onClick={runPcSyncNow}
                              disabled={pcSyncRunning}
                              className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                            >
                              {pcSyncRunning ? 'Syncing…' : 'Sync now'}
                            </button>
                            <button
                              type="button"
                              onClick={() => navigate('/import?source=planning-center')}
                              className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                            >
                              Review &amp; sync
                            </button>
                          </div>

                          {pcLastSync && (
                            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                              Last sync {pcLastSync.at ? new Date(pcLastSync.at).toLocaleString() : ''}: {pcLastSync.added ?? 0} added, {pcLastSync.updated ?? 0} updated, {pcLastSync.archived ?? 0} archived, {pcLastSync.reactivated ?? 0} reactivated, {pcLastSync.linked ?? 0} linked{typeof pcLastSync.ambiguous === 'number' ? `, ${pcLastSync.ambiguous} need review` : ''}.
                            </p>
                          )}
                        </div>
```

- [ ] **Step 4: Remove the now-unused autoArchive state/handler**

Delete `pcAutoArchive`/`setPcAutoArchive` state (line ~84), the `handlePcAutoArchiveToggle` function (~256-264), and the line in the mount loader that sets `setPcAutoArchive(...)` (~805). Add the import for the component at the top: `import MembershipAllowlistEditor from '../components/planningCenter/MembershipAllowlistEditor';`.

- [ ] **Step 5: Typecheck**

Run: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
Expected: no errors in `SettingsPage.tsx`. (ImportPage may still error until Task 7.)

- [ ] **Step 6: Manual smoke (optional but recommended)**

Restart client if needed (`docker compose -f docker-compose.dev.yml up -d client`), open Settings → Integrations → Planning Center as an admin on a connected church, and confirm the toggle, the category checklist, and the three buttons render and Save persists (reload the page; values stick).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/SettingsPage.tsx
git commit -m "feat(pco): settings sync config (enable toggle, allow-list, sync now)"
```

---

## Task 7: Sync & Review workspace (Import page)

**Files:**
- Create: `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`
- Modify: `client/src/pages/ImportPage.tsx`

- [ ] **Step 1: Create the review component**

Create `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`:
```tsx
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';
import { buildSelections } from './syncSelections';

interface AmbiguousEntry { individualId: number; firstName?: string; lastName?: string; candidates: string[]; }
interface Plan {
  link: { individualId: number; pcoId: string }[];
  ambiguous: AmbiguousEntry[];
  unmatched: number[];
  add: { pcoId: string; firstName: string; lastName: string; isChild: boolean; householdId: string | null; membership: string | null }[];
  update: { individualId: number; firstName: string; lastName: string }[];
  archive: { individualId: number; pcoId: string }[];
  reactivate: { individualId: number; pcoId: string }[];
}

export default function PlanningCenterSyncReview({ connected }: { connected: boolean }) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, string | null>>({});
  const [skipAdd, setSkipAdd] = useState<Set<string>>(new Set());

  const loadPlan = useCallback(async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await integrationsAPI.getPlanningCenterSyncPlan();
      setPlan(res.data.plan);
      setAmbiguousChoices({});      // default: skip every ambiguous
      setSkipAdd(new Set());        // default: add everyone proposed
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to compute sync plan.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (connected) loadPlan(); }, [connected, loadPlan]);

  const apply = async () => {
    setApplying(true); setError(null);
    try {
      const selections = buildSelections(ambiguousChoices, skipAdd);
      const res = await integrationsAPI.applyPlanningCenterSync({ selections });
      setResult(res.data.result);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to apply sync.');
    } finally {
      setApplying(false);
    }
  };

  if (!connected) {
    return (
      <div className="text-sm text-gray-600 dark:text-gray-300">
        Planning Center is not connected.{' '}
        <button className="underline" onClick={() => navigate('/app/settings?tab=integrations')}>Connect it in Settings</button>.
      </div>
    );
  }
  if (loading) return <p className="text-sm text-gray-500 dark:text-gray-400">Computing sync plan… (fetching everyone from Planning Center)</p>;
  if (error) return <div className="text-sm text-red-600 dark:text-red-400">{error} <button className="underline ml-1" onClick={loadPlan}>Retry</button></div>;
  if (!plan) return null;

  const toggleSkip = (pcoId: string) => {
    setSkipAdd((prev) => { const n = new Set(prev); n.has(pcoId) ? n.delete(pcoId) : n.add(pcoId); return n; });
  };

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="flex flex-wrap gap-3 text-sm">
        {([['Link', plan.link.length], ['Add', plan.add.length], ['Update', plan.update.length], ['Archive', plan.archive.length], ['Reactivate', plan.reactivate.length], ['Ambiguous', plan.ambiguous.length], ['Unmatched', plan.unmatched.length]] as [string, number][]).map(([label, n]) => (
          <span key={label} className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-100">{label}: {n}</span>
        ))}
      </div>

      {/* Ambiguous — needs decisions */}
      {plan.ambiguous.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Needs your decision ({plan.ambiguous.length})</h4>
          <ul className="space-y-3">
            {plan.ambiguous.map((a) => (
              <li key={a.individualId} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                <p className="text-sm text-gray-900 dark:text-gray-100 mb-2">{a.firstName} {a.lastName} — choose the Planning Center match:</p>
                <div className="space-y-1">
                  {a.candidates.map((pcoId) => (
                    <label key={pcoId} className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`amb-${a.individualId}`} checked={ambiguousChoices[a.individualId] === pcoId}
                        onChange={() => setAmbiguousChoices((p) => ({ ...p, [a.individualId]: pcoId }))} />
                      <span>PCO #{pcoId}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`amb-${a.individualId}`} checked={!ambiguousChoices[a.individualId]}
                      onChange={() => setAmbiguousChoices((p) => ({ ...p, [a.individualId]: null }))} />
                    <span>Skip (leave unlinked)</span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* New people to add */}
      {plan.add.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">New people to add ({plan.add.length - skipAdd.size} selected)</h4>
          <ul className="max-h-64 overflow-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {plan.add.map((p) => (
              <li key={p.pcoId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <input type="checkbox" checked={!skipAdd.has(p.pcoId)} onChange={() => toggleSkip(p.pcoId)} />
                <span>{p.firstName} {p.lastName}{p.isChild ? ' (child)' : ''} — {p.membership || 'no membership'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Informational buckets */}
      <details className="text-sm text-gray-600 dark:text-gray-300">
        <summary className="cursor-pointer">Auto-applied: {plan.link.length} link, {plan.update.length} update, {plan.archive.length} archive, {plan.reactivate.length} reactivate; {plan.unmatched.length} unmatched (stay unlinked)</summary>
      </details>

      {/* Apply */}
      <div className="flex items-center gap-3">
        <button onClick={apply} disabled={applying}
          className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
          {applying ? 'Applying…' : 'Apply sync'}
        </button>
        <button onClick={loadPlan} disabled={applying} className="text-sm underline text-gray-600 dark:text-gray-300">Re-run plan</button>
      </div>

      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Applied: {result.added} added, {result.updated} updated, {result.archived} archived, {result.reactivated} reactivated, {result.linked} linked
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
    </div>
  );
}
```

Note: confirm the Settings route path used in the "Connect it in Settings" button matches the app's actual route (the OAuth callback handling in SettingsPage uses a `tab=integrations` query param; verify the real settings path — it may be `/app/settings` or `/settings`). Match the existing route used elsewhere in the app for navigating to settings.

- [ ] **Step 2: Wire the component into ImportPage's PCO tab; remove old PCO people state**

In `client/src/pages/ImportPage.tsx`:
- Add import: `import PlanningCenterSyncReview from '../components/planningCenter/PlanningCenterSyncReview';`
- Find the PCO tab body (the JSX rendered when `sourceTab === 'planning-center'` — the browse/families/import UI). Replace that entire body with:
```tsx
                <PlanningCenterSyncReview connected={planningCenterStatus.connected} />
```
- Remove the now-unused PCO people state and handlers: `pcPeople`, `pcPeopleLoading`, `pcPeopleLoaded`, `pcSelectedFamilies`, `pcError`, `linkModal`, `togglePcFamily`, `togglePcFamilySelected`, `fetchPlanningCenterPeople`, the import handler that called `importPeopleFromPlanningCenter`, the link-family handler/modal, and the `getPlanningCenterCheckins`/check-in browse blocks if they were part of this PCO people tab (keep check-in import only if it's a separate, still-wanted feature — grep first; if it's wired into this same tab and out of scope, leave the check-in code untouched and only remove the people-browse code). Keep `planningCenterStatus` + `fetchPlanningCenterStatus` (still used to gate the tab and detect connection).

Work carefully and incrementally; after removing each unused symbol, re-run typecheck to confirm nothing else referenced it.

- [ ] **Step 3: Typecheck the whole client**

Run: `docker compose -f docker-compose.dev.yml exec client npx tsc --noEmit`
Expected: NO errors now (Tasks 3, 6, 7 together remove every reference to the deleted API methods). If any remain, fix the referencing code.

- [ ] **Step 4: Run the full frontend unit suite**

Run: `docker compose -f docker-compose.dev.yml exec client npm test`
Expected: all tests pass (including `syncSelections.test.ts`).

- [ ] **Step 5: Manual round-trip (recommended)**

With the dev stack up and a PCO-connected church: Settings → configure allow-list + enable → Save → "Review & sync" → the Import PCO tab shows the plan → resolve an ambiguous match / deselect an add → Apply → confirm the result summary and that people/families changed as expected.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterSyncReview.tsx client/src/pages/ImportPage.tsx
git commit -m "feat(pco): replace PCO import tab with Sync & Review workspace"
```

---

## Self-Review Notes

- **Spec coverage:** membership-summary endpoint + lastSyncResult (Task 2), API client methods (Task 3), buildSelections helper (Task 4), MembershipAllowlistEditor (Task 5), Settings sync-config block incl. enable toggle / allow-list / explicit Save / Sync-now / Review-&-sync / last-sync display (Task 6), Sync & Review workspace replacing old import incl. ambiguous-default-skip and add-deselect (Tasks 1+7). Tally helper (Task 1) backs Task 2.
- **Type consistency:** `buildSelections(ambiguousChoices, skipAddPcoIds: Set)` → `{ambiguous, skipAddPcoIds}` is produced in Task 4 and consumed in Task 7; matches the backend apply contract (`selections.ambiguous`, `selections.skipAddPcoIds`). `MembershipSummaryValue {membership,count}` shape from Task 1's endpoint is consumed by Task 5's component and Task 6's state. `applyPlanningCenterSync({selections})` signature (Task 3) matches usage in Tasks 6–7.
- **Known interim state:** after Task 3 the client won't typecheck clean until Tasks 6–7 remove the old call sites — flagged in each task's expected output. Final clean typecheck is gated in Task 7 Step 3.
- **Out of scope:** removing dead backend `people`/`import-people`/`link-family` routes; component-level automated tests beyond the pure helper (verified via typecheck + manual, since `main` has no established component-render test setup).
