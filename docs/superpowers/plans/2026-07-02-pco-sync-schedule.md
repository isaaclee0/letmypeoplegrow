# PCO Sync Frequency & Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a church admin configure Planning Center sync to run daily, weekly (on a chosen day, default Monday), or monthly (always the 1st) — without exposing a time-of-day control — while the existing single nightly 2 AM cron and sequential per-church loop stay unchanged.

**Architecture:** Two new `church_settings` columns store frequency + day. A pure `isDueToday(frequency, day, now)` helper gates whether `syncChurch` runs for a given church on a given night. The settings API and the PCO integration panel expose the two fields alongside the existing `enabled`/allowlist config, saved together via the existing "Save sync settings" button.

**Tech Stack:** Node.js/Express, better-sqlite3, node-cron, `node:test` (server tests), React/TypeScript (client).

---

### Task 1: Schema — add frequency/day columns

**Files:**
- Modify: `server/config/schema.js:113` (church_settings table def)
- Modify: `server/config/database.js:143-145` (migration for existing DBs)

- [ ] **Step 1: Add columns to the schema definition**

In `server/config/schema.js`, in the `CREATE TABLE IF NOT EXISTS church_settings` block, right after the `planning_center_sync_enabled` line (line 113), add:

```js
  planning_center_sync_enabled INTEGER DEFAULT 0,
  planning_center_sync_frequency TEXT DEFAULT 'weekly',
  planning_center_sync_day INTEGER DEFAULT 1,
```

(Keep `planning_center_membership_allowlist` and everything after it as-is — just insert the two new lines after `planning_center_sync_enabled`.)

- [ ] **Step 2: Add migration for existing per-church databases**

In `server/config/database.js`, right after the `planning_center_sync_enabled` migration block (after line 145), add:

```js
      if (!settingsCols.some(c => c.name === 'planning_center_sync_frequency')) {
        db.exec("ALTER TABLE church_settings ADD COLUMN planning_center_sync_frequency TEXT DEFAULT 'weekly'");
      }
      if (!settingsCols.some(c => c.name === 'planning_center_sync_day')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_sync_day INTEGER DEFAULT 1');
      }
```

- [ ] **Step 3: Verify schema loads cleanly**

Run: `cd server && node -e "const Database = require('./config/database'); Database.setChurchContext('testchurch1', async () => { const rows = await Database.query('SELECT planning_center_sync_frequency, planning_center_sync_day FROM church_settings LIMIT 1'); console.log(rows); }).then(() => process.exit(0));"`

Expected: prints an array (empty is fine — a fresh test church has no `church_settings` row yet) with no SQL errors. If it errors with "no such column", re-check Step 1/2.

- [ ] **Step 4: Commit**

```bash
git add server/config/schema.js server/config/database.js
git commit -m "feat(server): add planning_center_sync_frequency/day columns"
```

---

### Task 2: `isDueToday` helper + scheduling gate

**Files:**
- Modify: `server/services/planningCenterSync.js` (add helper, wire into `syncChurch`, export helper)
- Test: `server/services/planningCenterSync.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `server/services/planningCenterSync.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isDueToday } = require('./planningCenterSync');

test('isDueToday: daily is always due', () => {
  const monday = new Date('2026-07-06T02:00:00'); // a Monday
  const wednesday = new Date('2026-07-08T02:00:00');
  assert.strictEqual(isDueToday('daily', 1, monday), true);
  assert.strictEqual(isDueToday('daily', 1, wednesday), true);
});

test('isDueToday: weekly matches only the configured day', () => {
  const monday = new Date('2026-07-06T02:00:00');
  const tuesday = new Date('2026-07-07T02:00:00');
  assert.strictEqual(isDueToday('weekly', 1, monday), true); // 1 = Monday
  assert.strictEqual(isDueToday('weekly', 1, tuesday), false);
  assert.strictEqual(isDueToday('weekly', 2, tuesday), true); // 2 = Tuesday
});

test('isDueToday: weekly defaults to Monday when day is not a number', () => {
  const monday = new Date('2026-07-06T02:00:00');
  const tuesday = new Date('2026-07-07T02:00:00');
  assert.strictEqual(isDueToday('weekly', null, monday), true);
  assert.strictEqual(isDueToday('weekly', undefined, tuesday), false);
});

test('isDueToday: monthly matches only the 1st', () => {
  const first = new Date('2026-07-01T02:00:00');
  const second = new Date('2026-07-02T02:00:00');
  assert.strictEqual(isDueToday('monthly', 1, first), true);
  assert.strictEqual(isDueToday('monthly', 1, second), false);
});

test('isDueToday: unknown frequency falls back to weekly behavior', () => {
  const monday = new Date('2026-07-06T02:00:00');
  const tuesday = new Date('2026-07-07T02:00:00');
  assert.strictEqual(isDueToday('bogus', 1, monday), true);
  assert.strictEqual(isDueToday('bogus', 1, tuesday), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test services/planningCenterSync.test.js`
Expected: FAIL — `isDueToday` is not exported / not defined (the require will throw or the destructured value will be `undefined`, causing a TypeError when called).

- [ ] **Step 3: Implement `isDueToday` and wire it into `syncChurch`**

In `server/services/planningCenterSync.js`, add the helper near the top of the "Per-church sync" section (just above `async function syncChurch`, i.e. before line 219):

```js
// ─── Scheduling ──────────────────────────────────────────────────────────────

// Decides whether a church's sync is due to run "tonight" given its configured
// frequency/day. Weekly day-of-week: 0=Sunday..6=Saturday (JS Date convention).
function isDueToday(frequency, day, now = new Date()) {
  if (frequency === 'daily') return true;
  if (frequency === 'monthly') return now.getDate() === 1;
  // weekly (default, and fallback for unrecognized frequencies)
  const targetDay = typeof day === 'number' ? day : 1;
  return now.getDay() === targetDay;
}
```

Then modify `syncChurch` (currently lines 219-263) to select the new columns and gate on them. Replace the existing settings query and enabled check:

```js
async function syncChurch(church) {
  const churchId = church.church_id;
  await Database.setChurchContext(churchId, async () => {
    try {
      const settings = await Database.query(
        `SELECT planning_center_sync_enabled, planning_center_auto_archive,
                planning_center_sync_frequency, planning_center_sync_day,
                (SELECT user_id FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens' LIMIT 1) AS token_user
           FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId, churchId]
      );
      const enabled = settings.length && (settings[0].planning_center_sync_enabled || settings[0].planning_center_auto_archive);
      if (!enabled) return;

      const frequency = settings[0].planning_center_sync_frequency || 'weekly';
      const day = settings[0].planning_center_sync_day;
      if (!isDueToday(frequency, day)) return;

      const accessToken = await getAccessTokenForChurch(churchId);
```

(Everything from `if (!accessToken) { ... }` onward stays exactly as it is today — no other changes to the function body.)

- [ ] **Step 4: Export `isDueToday`**

In the `module.exports` block at the bottom of `server/services/planningCenterSync.js`, add `isDueToday`:

```js
module.exports = {
  start, stop, runNow, syncChurch, isDueToday,
  getAccessTokenForChurch, computePlanForChurch, applyForChurch, fetchAllPcoPeople,
  getCachedPcoPeople, invalidatePcoPeopleCache,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --test services/planningCenterSync.test.js`
Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenterSync.js server/services/planningCenterSync.test.js
git commit -m "feat(server): gate PCO nightly sync by configured frequency/day"
```

---

### Task 3: Settings API — expose frequency/day

**Files:**
- Modify: `server/routes/settings.js:502-547` (GET/PUT `/integrations`)

- [ ] **Step 1: Extend the GET handler**

In `server/routes/settings.js`, replace the `GET /integrations` handler (lines 503-521) with:

```js
router.get('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const rows = await Database.query(
      `SELECT planning_center_sync_indicator, planning_center_auto_archive,
              planning_center_last_sync, planning_center_last_sync_archived,
              planning_center_sync_frequency, planning_center_sync_day
       FROM church_settings WHERE church_id = ? LIMIT 1`,
      [req.user.church_id]
    );
    const row = rows[0] || {};
    res.json({
      planningCenterSyncIndicator: !!(row.planning_center_sync_indicator),
      planningCenterAutoArchive: !!(row.planning_center_auto_archive),
      planningCenterLastSync: row.planning_center_last_sync || null,
      planningCenterLastSyncArchived: row.planning_center_last_sync_archived || 0,
      planningCenterSyncFrequency: row.planning_center_sync_frequency || 'weekly',
      planningCenterSyncDay: typeof row.planning_center_sync_day === 'number' ? row.planning_center_sync_day : 1,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve integration settings.' });
  }
});
```

- [ ] **Step 2: Extend the PUT handler with validation**

Replace the `PUT /integrations` handler (lines 523-547) with:

```js
const PCO_SYNC_FREQUENCIES = ['daily', 'weekly', 'monthly'];

router.put('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const { planningCenterSyncIndicator, planningCenterAutoArchive, planningCenterSyncFrequency, planningCenterSyncDay } = req.body;
    const updates = [];
    const params = [];
    if (typeof planningCenterSyncIndicator === 'boolean') {
      updates.push('planning_center_sync_indicator = ?');
      params.push(planningCenterSyncIndicator ? 1 : 0);
    }
    if (typeof planningCenterAutoArchive === 'boolean') {
      updates.push('planning_center_auto_archive = ?');
      params.push(planningCenterAutoArchive ? 1 : 0);
    }
    if (planningCenterSyncFrequency !== undefined) {
      if (!PCO_SYNC_FREQUENCIES.includes(planningCenterSyncFrequency)) {
        return res.status(400).json({ error: 'planningCenterSyncFrequency must be one of daily, weekly, monthly.' });
      }
      updates.push('planning_center_sync_frequency = ?');
      params.push(planningCenterSyncFrequency);
    }
    if (planningCenterSyncDay !== undefined) {
      if (!Number.isInteger(planningCenterSyncDay) || planningCenterSyncDay < 0 || planningCenterSyncDay > 6) {
        return res.status(400).json({ error: 'planningCenterSyncDay must be an integer between 0 and 6.' });
      }
      updates.push('planning_center_sync_day = ?');
      params.push(planningCenterSyncDay);
    }
    if (updates.length) {
      params.push(req.user.church_id);
      await Database.query(
        `UPDATE church_settings SET ${updates.join(', ')} WHERE church_id = ?`,
        params
      );
    }
    res.json({ message: 'Integration settings updated.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update integration settings.' });
  }
});
```

- [ ] **Step 3: Manual smoke test**

This route requires an authenticated admin session, so verify via the full app in Task 5's manual test rather than curl in isolation. For now, just confirm the file has no syntax errors:

Run: `cd server && node -e "require('./routes/settings.js'); console.log('OK')"`
Expected: prints `OK` with no errors.

- [ ] **Step 4: Commit**

```bash
git add server/routes/settings.js
git commit -m "feat(server): expose PCO sync frequency/day in integrations settings API"
```

---

### Task 4: Client — API types

**Files:**
- Modify: `client/src/services/api.ts:794-796`

- [ ] **Step 1: Extend the types and payload**

In `client/src/services/api.ts`, replace lines 794-796:

```ts
  getIntegrationSettings: () => api.get('/settings/integrations'),
  updateIntegrationSettings: (data: { planningCenterSyncIndicator?: boolean; planningCenterAutoArchive?: boolean }) =>
    api.put('/settings/integrations', data),
```

with:

```ts
  getIntegrationSettings: () => api.get('/settings/integrations'),
  updateIntegrationSettings: (data: {
    planningCenterSyncIndicator?: boolean;
    planningCenterAutoArchive?: boolean;
    planningCenterSyncFrequency?: 'daily' | 'weekly' | 'monthly';
    planningCenterSyncDay?: number;
  }) => api.put('/settings/integrations', data),
```

- [ ] **Step 2: Type-check via Docker**

Per project convention, don't run client builds/type-checks locally. Skip standalone verification here — Task 5's Docker rebuild will surface any type error when the panel component (Task 5) uses this type.

- [ ] **Step 3: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat(client): add PCO sync frequency/day to integration settings API types"
```

---

### Task 5: Client — frequency/day controls in the PCO panel

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`

- [ ] **Step 1: Add state for frequency/day**

In `PlanningCenterIntegrationPanel.tsx`, near the other `pcSync*` state declarations (after line 36, `const [pcSyncEnabled, setPcSyncEnabled] = useState(false);`), add:

```tsx
  const [pcSyncFrequency, setPcSyncFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [pcSyncDay, setPcSyncDay] = useState(1);
```

- [ ] **Step 2: Load the new fields alongside the existing sync indicator fetch**

Replace the `useEffect` at lines 127-134:

```tsx
  useEffect(() => {
    if (status.connected) {
      loadPcSyncConfig();
      settingsAPI.getIntegrationSettings().then(r => {
        setPcSyncIndicator(!!r.data.planningCenterSyncIndicator);
      }).catch(() => {});
    }
  }, [status.connected, loadPcSyncConfig]);
```

with:

```tsx
  useEffect(() => {
    if (status.connected) {
      loadPcSyncConfig();
      settingsAPI.getIntegrationSettings().then(r => {
        setPcSyncIndicator(!!r.data.planningCenterSyncIndicator);
        setPcSyncFrequency(r.data.planningCenterSyncFrequency || 'weekly');
        setPcSyncDay(typeof r.data.planningCenterSyncDay === 'number' ? r.data.planningCenterSyncDay : 1);
      }).catch(() => {});
    }
  }, [status.connected, loadPcSyncConfig]);
```

- [ ] **Step 3: Include the new fields in the save action**

Replace `savePcSyncConfig` (lines 75-85):

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
```

with:

```tsx
  const savePcSyncConfig = async () => {
    setPcConfigSaving(true);
    try {
      await integrationsAPI.savePlanningCenterMembershipFilter({ enabled: pcSyncEnabled, allowlist: pcAllowlist });
      await settingsAPI.updateIntegrationSettings({
        planningCenterSyncFrequency: pcSyncFrequency,
        planningCenterSyncDay: pcSyncDay,
      });
      setPcConfigDirty(false);
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Failed to save sync settings.');
    } finally {
      setPcConfigSaving(false);
    }
  };
```

- [ ] **Step 4: Add the frequency/day controls to the UI**

In the "Full people sync configuration" block, right after the membership allowlist editor (after line 304, i.e. after the closing `/>` and `</div>` of `MembershipAllowlistEditor`, before the `<div className="mt-4 flex flex-wrap items-center gap-3">` save/sync-now buttons block that starts at line 306), insert:

```tsx
                <div className="mt-4">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">Sync schedule</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <select
                      value={pcSyncFrequency}
                      onChange={(e) => { setPcSyncFrequency(e.target.value as 'daily' | 'weekly' | 'monthly'); setPcConfigDirty(true); }}
                      className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                    {pcSyncFrequency === 'weekly' && (
                      <select
                        value={pcSyncDay}
                        onChange={(e) => { setPcSyncDay(Number(e.target.value)); setPcConfigDirty(true); }}
                        className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
                      >
                        <option value={0}>Sunday</option>
                        <option value={1}>Monday</option>
                        <option value={2}>Tuesday</option>
                        <option value={3}>Wednesday</option>
                        <option value={4}>Thursday</option>
                        <option value={5}>Friday</option>
                        <option value={6}>Saturday</option>
                      </select>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {pcSyncFrequency === 'monthly'
                      ? 'Runs overnight on the 1st of each month.'
                      : pcSyncFrequency === 'daily'
                        ? 'Runs every night.'
                        : 'Runs overnight on the selected day each week.'}
                  </p>
                </div>
```

- [ ] **Step 5: Rebuild client container and verify no build errors**

Run: `docker-compose -f docker-compose.dev.yml build client`
Expected: build succeeds with no TypeScript errors.

Run: `docker-compose -f docker-compose.dev.yml up -d client && docker-compose -f docker-compose.dev.yml logs --tail=50 client`
Expected: no compile errors in logs.

- [ ] **Step 6: Manual verification in the browser**

1. Start the full dev stack: `docker-compose -f docker-compose.dev.yml up -d`
2. Log in as an admin, go to Settings → Integrations → Planning Center (must already be connected — connect first if needed).
3. Confirm the "Sync schedule" row shows a Frequency dropdown defaulted to **Weekly** and a Day dropdown defaulted to **Monday**.
4. Change frequency to Monthly — confirm the Day dropdown disappears and the helper text updates to "Runs overnight on the 1st of each month."
5. Change frequency back to Weekly, pick Wednesday, click "Save sync settings" — confirm no error toast/banner.
6. Reload the page — confirm Frequency still shows Weekly and Day still shows Wednesday (round-trip persisted).
7. Switch to Daily, save, reload — confirm it persists as Daily with no day dropdown shown.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/integrations/PlanningCenterIntegrationPanel.tsx
git commit -m "feat(client): add PCO sync frequency/day controls to integration panel"
```

---

### Task 6: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run full server test suite for touched files**

Run: `cd server && node --test services/planningCenterSync.test.js services/planningCenter/*.test.js`
Expected: all tests PASS, no regressions in the existing `planningCenter/*` suite.

- [ ] **Step 2: Confirm existing PCO sync flows still work**

In the running dev stack (from Task 5), click "Sync now" in the PCO panel — confirm it still runs immediately regardless of the configured frequency/day (manual trigger bypasses the schedule gate, per spec Non-Goals).

- [ ] **Step 3: Review full diff**

Run: `git diff main --stat`
Expected: changes confined to `server/config/schema.js`, `server/config/database.js`, `server/services/planningCenterSync.js`, `server/services/planningCenterSync.test.js`, `server/routes/settings.js`, `client/src/services/api.ts`, `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`.
