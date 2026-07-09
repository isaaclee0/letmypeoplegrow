# PCO Monthly Schedule Day-of-Month Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins pick a day-of-month (1–31) for `monthly` Planning Center sync schedules — both batch sync and reconciliation — instead of the day always being hardcoded to the 1st.

**Architecture:** Reuse the existing `schedule_day` / `planning_center_reconciliation_day` integer columns (no migration): the value already means "day of week" for `weekly`, and will now also mean "day of month" for `monthly`, disambiguated by the sibling `frequency` field. One shared `isDueToday()` function gates both schedules, so fixing it once fixes both call sites. Server validation and client pickers become frequency-aware.

**Tech Stack:** Node.js/Express, better-sqlite3, `node:test` for server unit tests, React 19 + TypeScript + Vite, vitest for client unit tests. Server and client tests run inside the dev Docker containers (`docker-compose -f docker-compose.dev.yml exec -T server node --test <path>` / `docker-compose -f docker-compose.dev.yml exec client npx vitest run <path>`), never on the host, per this project's Docker-only-builds convention.

**Spec:** `docs/superpowers/specs/2026-07-10-pco-monthly-schedule-day-design.md`

---

### Task 1: Fix `isDueToday()` to honor day-of-month for monthly schedules

**Files:**
- Modify: `server/services/planningCenterSync.js:372-380`
- Test: `server/services/planningCenterSync.test.js`

- [ ] **Step 1: Add failing tests for monthly day-of-month behavior**

Append to the end of `server/services/planningCenterSync.test.js`:

```js
test('isDueToday: monthly matches an exact mid-month day', () => {
  const the14th = new Date('2026-07-14T02:00:00');
  const the15th = new Date('2026-07-15T02:00:00');
  const the16th = new Date('2026-07-16T02:00:00');
  assert.strictEqual(isDueToday('monthly', 15, the14th), false);
  assert.strictEqual(isDueToday('monthly', 15, the15th), true);
  assert.strictEqual(isDueToday('monthly', 15, the16th), false);
});

test('isDueToday: monthly day 31 clamps to the last day of a 30-day month', () => {
  const april29 = new Date('2026-04-29T02:00:00');
  const april30 = new Date('2026-04-30T02:00:00'); // April has 30 days
  assert.strictEqual(isDueToday('monthly', 31, april29), false);
  assert.strictEqual(isDueToday('monthly', 31, april30), true);
});

test('isDueToday: monthly day 29 clamps to the 28th in a non-leap February', () => {
  const feb27 = new Date('2026-02-27T02:00:00');
  const feb28 = new Date('2026-02-28T02:00:00'); // 2026 is not a leap year
  assert.strictEqual(isDueToday('monthly', 29, feb27), false);
  assert.strictEqual(isDueToday('monthly', 29, feb28), true);
});

test('isDueToday: monthly day 29 matches exactly in a leap February', () => {
  const feb28 = new Date('2028-02-28T02:00:00');
  const feb29 = new Date('2028-02-29T02:00:00'); // 2028 is a leap year
  assert.strictEqual(isDueToday('monthly', 29, feb28), false);
  assert.strictEqual(isDueToday('monthly', 29, feb29), true);
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenterSync.test.js`

Expected: The 5 pre-existing tests still PASS. The 4 new tests FAIL (current implementation always uses `now.getDate() === 1` for monthly, so e.g. `isDueToday('monthly', 15, the15th)` returns `false` instead of `true`).

- [ ] **Step 3: Implement the fix**

Replace `server/services/planningCenterSync.js:372-380`:

```js
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

with:

```js
// Decides whether a church's sync is due to run "tonight" given its configured
// frequency/day. Weekly day-of-week: 0=Sunday..6=Saturday (JS Date convention).
// Monthly day-of-month: 1-31, clamped to the last day of shorter months (e.g.
// day 31 runs on April 30th; day 29 runs on Feb 28th outside leap years).
function isDueToday(frequency, day, now = new Date()) {
  if (frequency === 'daily') return true;
  if (frequency === 'monthly') {
    const targetDay = typeof day === 'number' ? day : 1;
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return now.getDate() === Math.min(targetDay, lastDayOfMonth);
  }
  // weekly (default, and fallback for unrecognized frequencies)
  const targetDay = typeof day === 'number' ? day : 1;
  return now.getDay() === targetDay;
}
```

- [ ] **Step 4: Run the tests to verify they all pass**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenterSync.test.js`

Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenterSync.js server/services/planningCenterSync.test.js
git commit -m "fix(pco): honor day-of-month for monthly sync schedules

isDueToday() previously ignored the configured day for monthly
frequency and always ran on the 1st. This is the shared gate for both
batch sync and reconciliation schedules."
```

---

### Task 2: Make batch schedule-day validation frequency-aware

**Files:**
- Modify: `server/routes/integrations.js:2180-2183`

- [ ] **Step 1: Replace the hardcoded 0-6 range check**

Replace `server/routes/integrations.js:2180-2183`:

```js
  if (typeof scheduleEnabled !== 'boolean') return 'scheduleEnabled must be a boolean.';
  if (!PCO_BATCH_FREQUENCIES.includes(scheduleFrequency)) return 'scheduleFrequency must be one of daily, weekly, monthly.';
  if (!Number.isInteger(scheduleDay) || scheduleDay < 0 || scheduleDay > 6) return 'scheduleDay must be an integer between 0 and 6.';
  return null;
```

with:

```js
  if (typeof scheduleEnabled !== 'boolean') return 'scheduleEnabled must be a boolean.';
  if (!PCO_BATCH_FREQUENCIES.includes(scheduleFrequency)) return 'scheduleFrequency must be one of daily, weekly, monthly.';
  if (!Number.isInteger(scheduleDay)) return 'scheduleDay must be an integer.';
  if (scheduleFrequency === 'weekly' && (scheduleDay < 0 || scheduleDay > 6)) {
    return 'scheduleDay must be an integer between 0 and 6 for weekly schedules.';
  }
  if (scheduleFrequency === 'monthly' && (scheduleDay < 1 || scheduleDay > 31)) {
    return 'scheduleDay must be an integer between 1 and 31 for monthly schedules.';
  }
  return null;
```

`validateBatchBody` always receives `scheduleFrequency` and `scheduleDay` together (the batch editor sends a full upsert on every save), so this is safe without a fallback case. `daily` frequency has no range check — `scheduleDay` is stored but never read for daily.

- [ ] **Step 2: Verify no other validation callers broke**

Run: `docker-compose -f docker-compose.dev.yml exec -T server node --test services/planningCenterSync.test.js`

Expected: All 9 tests still PASS (this file doesn't test `validateBatchBody` directly — there is no existing test harness for `server/routes/integrations.js` — this step just confirms the docker container's server process still starts cleanly; see manual verification in Task 7 for actual coverage).

Run: `docker-compose -f docker-compose.dev.yml up -d server && docker-compose -f docker-compose.dev.yml logs --tail=30 server`

Expected: No syntax/startup errors in the log tail.

- [ ] **Step 3: Commit**

```bash
git add server/routes/integrations.js
git commit -m "fix(pco): validate batch scheduleDay range per frequency

Was hardcoded to 0-6 (day-of-week) even for monthly schedules, which
will now use 1-31 (day-of-month)."
```

---

### Task 3: Make reconciliation schedule-day validation frequency-aware

**Files:**
- Modify: `server/routes/settings.js:567-573`

- [ ] **Step 1: Replace the hardcoded 0-6 range check**

Replace `server/routes/settings.js:567-573`:

```js
    if (planningCenterReconciliationDay !== undefined) {
      if (!Number.isInteger(planningCenterReconciliationDay) || planningCenterReconciliationDay < 0 || planningCenterReconciliationDay > 6) {
        return res.status(400).json({ error: 'planningCenterReconciliationDay must be an integer between 0 and 6.' });
      }
      updates.push('planning_center_reconciliation_day = ?');
      params.push(planningCenterReconciliationDay);
    }
```

with:

```js
    if (planningCenterReconciliationDay !== undefined) {
      if (!Number.isInteger(planningCenterReconciliationDay)) {
        return res.status(400).json({ error: 'planningCenterReconciliationDay must be an integer.' });
      }
      // planningCenterReconciliationFrequency and planningCenterReconciliationDay are
      // independent optional fields on this PATCH-style endpoint, so when frequency
      // isn't present in this same request we fall back to the permissive union range
      // (0-31) rather than guessing. The client always sends both together.
      const minDay = planningCenterReconciliationFrequency === 'monthly' ? 1 : 0;
      const maxDay = planningCenterReconciliationFrequency === 'weekly' ? 6 : 31;
      if (planningCenterReconciliationDay < minDay || planningCenterReconciliationDay > maxDay) {
        return res.status(400).json({ error: `planningCenterReconciliationDay must be an integer between ${minDay} and ${maxDay}.` });
      }
      updates.push('planning_center_reconciliation_day = ?');
      params.push(planningCenterReconciliationDay);
    }
```

- [ ] **Step 2: Verify the server still starts cleanly**

Run: `docker-compose -f docker-compose.dev.yml up -d server && docker-compose -f docker-compose.dev.yml logs --tail=30 server`

Expected: No syntax/startup errors in the log tail.

- [ ] **Step 3: Commit**

```bash
git add server/routes/settings.js
git commit -m "fix(pco): validate reconciliation day range per frequency

Same hardcoded 0-6 range bug as the batch schedule validation, for the
separate reconciliation schedule settings endpoint."
```

---

### Task 4: Add a shared `ordinalDay` formatting helper

**Files:**
- Create: `client/src/utils/pcoSchedule.ts`
- Test: `client/src/utils/pcoSchedule.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/pcoSchedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ordinalDay } from './pcoSchedule';

describe('ordinalDay', () => {
  it('formats 1st, 2nd, 3rd, 4th correctly', () => {
    expect(ordinalDay(1)).toBe('1st');
    expect(ordinalDay(2)).toBe('2nd');
    expect(ordinalDay(3)).toBe('3rd');
    expect(ordinalDay(4)).toBe('4th');
  });

  it('formats 11th, 12th, 13th as "th" (not "st"/"nd"/"rd")', () => {
    expect(ordinalDay(11)).toBe('11th');
    expect(ordinalDay(12)).toBe('12th');
    expect(ordinalDay(13)).toBe('13th');
  });

  it('formats 21st, 22nd, 23rd correctly', () => {
    expect(ordinalDay(21)).toBe('21st');
    expect(ordinalDay(22)).toBe('22nd');
    expect(ordinalDay(23)).toBe('23rd');
  });

  it('formats 31st correctly', () => {
    expect(ordinalDay(31)).toBe('31st');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker-compose -f docker-compose.dev.yml exec client npx vitest run src/utils/pcoSchedule.test.ts`

Expected: FAIL — `Failed to resolve import "./pcoSchedule"` (file doesn't exist yet).

- [ ] **Step 3: Implement `ordinalDay`**

Create `client/src/utils/pcoSchedule.ts`:

```ts
// Formats a day-of-month integer (1-31) as an ordinal string, e.g. "1st",
// "22nd", "31st". Used by the PCO monthly schedule day-of-month pickers.
export function ordinalDay(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `docker-compose -f docker-compose.dev.yml exec client npx vitest run src/utils/pcoSchedule.test.ts`

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/pcoSchedule.ts client/src/utils/pcoSchedule.test.ts
git commit -m "feat(pco): add ordinalDay helper for monthly schedule pickers"
```

---

### Task 5: Add day-of-month picker to the batch schedule editor

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`

- [ ] **Step 1: Import `ordinalDay`**

In `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`, add to the top imports (after the existing `usePcoRefreshPoll` import at line 6):

```tsx
import { ordinalDay } from '../../utils/pcoSchedule';
```

- [ ] **Step 2: Replace the frequency/day schedule controls**

Replace lines 236-259 (the `scheduleFrequency` select and the `scheduleFrequency === 'weekly'` block):

```tsx
              <select
                value={scheduleFrequency}
                onChange={(e) => setScheduleFrequency(e.target.value as SyncBatchInput['scheduleFrequency'])}
                className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              {scheduleFrequency === 'weekly' && (
                <select
                  value={scheduleDay}
                  onChange={(e) => setScheduleDay(Number(e.target.value))}
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
```

with:

```tsx
              <select
                value={scheduleFrequency}
                onChange={(e) => {
                  const freq = e.target.value as SyncBatchInput['scheduleFrequency'];
                  setScheduleFrequency(freq);
                  setScheduleDay((prev) => {
                    if (freq === 'weekly') return prev >= 0 && prev <= 6 ? prev : 1;
                    if (freq === 'monthly') return prev >= 1 && prev <= 31 ? prev : 1;
                    return prev; // daily: value unused
                  });
                }}
                className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              {scheduleFrequency === 'weekly' && (
                <select
                  value={scheduleDay}
                  onChange={(e) => setScheduleDay(Number(e.target.value))}
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
              {scheduleFrequency === 'monthly' && (
                <>
                  <select
                    value={scheduleDay}
                    onChange={(e) => setScheduleDay(Number(e.target.value))}
                    className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
                  >
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>{ordinalDay(d)}</option>
                    ))}
                  </select>
                  {scheduleDay >= 29 && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      Runs on the last day of the month if it's shorter.
                    </span>
                  )}
                </>
              )}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterBatchEditor.tsx
git commit -m "feat(pco): add day-of-month picker to batch schedule editor"
```

---

### Task 6: Add day-of-month picker to the reconciliation schedule

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`

- [ ] **Step 1: Import `ordinalDay`**

Add to the top imports of `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx` (after the `logger` import at line 16):

```tsx
import { ordinalDay } from '../../utils/pcoSchedule';
```

- [ ] **Step 2: Replace the reconciliation frequency/day controls**

Replace lines 425-444 (the `reconciliationFrequency` select and the `reconciliationFrequency === 'weekly'` block):

```tsx
                      <select value={reconciliationFrequency}
                        onChange={(e) => { setReconciliationFrequency(e.target.value as 'daily' | 'weekly' | 'monthly'); setReconciliationDirty(true); }}
                        className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500">
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                      {reconciliationFrequency === 'weekly' && (
                        <select value={reconciliationDay}
                          onChange={(e) => { setReconciliationDay(Number(e.target.value)); setReconciliationDirty(true); }}
                          className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500">
                          <option value={0}>Sunday</option>
                          <option value={1}>Monday</option>
                          <option value={2}>Tuesday</option>
                          <option value={3}>Wednesday</option>
                          <option value={4}>Thursday</option>
                          <option value={5}>Friday</option>
                          <option value={6}>Saturday</option>
                        </select>
                      )}
```

with:

```tsx
                      <select value={reconciliationFrequency}
                        onChange={(e) => {
                          const freq = e.target.value as 'daily' | 'weekly' | 'monthly';
                          setReconciliationFrequency(freq);
                          setReconciliationDay((prev) => {
                            if (freq === 'weekly') return prev >= 0 && prev <= 6 ? prev : 1;
                            if (freq === 'monthly') return prev >= 1 && prev <= 31 ? prev : 1;
                            return prev; // daily: value unused
                          });
                          setReconciliationDirty(true);
                        }}
                        className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500">
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                      {reconciliationFrequency === 'weekly' && (
                        <select value={reconciliationDay}
                          onChange={(e) => { setReconciliationDay(Number(e.target.value)); setReconciliationDirty(true); }}
                          className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500">
                          <option value={0}>Sunday</option>
                          <option value={1}>Monday</option>
                          <option value={2}>Tuesday</option>
                          <option value={3}>Wednesday</option>
                          <option value={4}>Thursday</option>
                          <option value={5}>Friday</option>
                          <option value={6}>Saturday</option>
                        </select>
                      )}
                      {reconciliationFrequency === 'monthly' && (
                        <>
                          <select value={reconciliationDay}
                            onChange={(e) => { setReconciliationDay(Number(e.target.value)); setReconciliationDirty(true); }}
                            className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500">
                            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                              <option key={d} value={d}>{ordinalDay(d)}</option>
                            ))}
                          </select>
                          {reconciliationDay >= 29 && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              Runs on the last day of the month if it's shorter.
                            </span>
                          )}
                        </>
                      )}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/integrations/PlanningCenterIntegrationPanel.tsx
git commit -m "feat(pco): add day-of-month picker to reconciliation schedule"
```

---

### Task 7: Manual end-to-end verification

**Files:** None (verification only)

- [ ] **Step 1: Bring up the dev stack**

Run: `docker-compose -f docker-compose.dev.yml up -d`

Wait for `client`, `server`, and `nginx` to report healthy/running (check with `docker-compose -f docker-compose.dev.yml ps`).

- [ ] **Step 2: Verify the batch editor's monthly picker in the browser**

Navigate to Settings → Integrations → Planning Center (requires PCO connected and `PLANNING_CENTER_ENABLED=true`; if not connected in this dev environment, open a batch editor via "New batch" — the schedule section renders regardless of connection status). In a batch editor:

1. Toggle the schedule switch on, set frequency to Monthly.
2. Confirm a day-of-month dropdown (1st–31st) appears, day-of-week dropdown does not.
3. Select the 31st. Confirm the "Runs on the last day of the month if it's shorter." note appears.
4. Select the 15th. Confirm the note disappears.
5. Switch frequency to Weekly. Confirm the day resets to a valid weekly value (Monday) rather than showing "31" in a 0-6 dropdown.
6. Switch frequency back to Monthly, save the batch, and confirm no validation error from the server (network tab / no error banner).

- [ ] **Step 3: Verify the reconciliation schedule's monthly picker**

In the same Settings → Integrations → Planning Center page, under "Check for people who left":

1. Toggle its schedule switch on, set frequency to Monthly, pick day 29.
2. Confirm the short-month note appears.
3. Click "Save schedule" and confirm it saves without a validation error.
4. Reload the page and confirm the monthly/29 selection persisted (round-trips through `GET /api/settings/integrations`).

- [ ] **Step 4: Confirm no regressions in server logs**

Run: `docker-compose -f docker-compose.dev.yml logs --tail=50 server`

Expected: No new errors during the above interactions.

---

## Self-Review Notes

- **Spec coverage:** Goal 1 (day-of-month picker for both schedules) → Tasks 5, 6. Goal 2 (clamp to last day of month) → Task 1. Goal 3 (reuse existing columns, no migration) → confirmed no schema task exists in this plan. Non-goals (no time-of-day control, no backfill, no daily behavior change) → untouched by any task.
- **Placeholder scan:** No TBD/TODO; every code step shows complete before/after code.
- **Type consistency:** `ordinalDay(day: number): string` defined in Task 4 is imported and called identically in Tasks 5 and 6. `scheduleFrequency`/`scheduleDay` and `reconciliationFrequency`/`reconciliationDay` naming matches each file's existing state variables (verified against current source, not assumed).
