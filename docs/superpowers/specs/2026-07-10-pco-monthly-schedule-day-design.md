# Planning Center Sync: Day-of-Month for Monthly Schedules

**Date:** 2026-07-10
**Status:** Approved

## Problem

`2026-07-02-pco-sync-schedule-design.md` added configurable sync frequency
(daily/weekly/monthly) and a day-of-week picker for weekly, but explicitly
left monthly hardcoded to run on the 1st ("No day-of-month picker for
`monthly`" was a stated non-goal). `isDueToday()` in
`server/services/planningCenterSync.js:374` still reflects that:

```js
if (frequency === 'monthly') return now.getDate() === 1;
```

The shared `day` column/field exists and is already validated/stored, but is
silently ignored whenever frequency is `'monthly'`. This affects two
independent schedules that both route through `isDueToday()`:

1. **Batch sync** — `planning_center_sync_batches.schedule_day`
   (`server/routes/integrations.js`, `PlanningCenterBatchEditor.tsx`)
2. **Reconciliation** ("check for people who left") —
   `church_settings.planning_center_reconciliation_day`
   (`server/routes/settings.js`, `PlanningCenterIntegrationPanel.tsx`)

## Goals

1. For `monthly` frequency, let the admin pick a day of the month (1–31),
   for both batch schedules and the reconciliation schedule.
2. Months shorter than the configured day run on that month's **last day**
   instead of skipping (e.g. day 31 → April 30th; day 29 → Feb 28th in a
   non-leap year).
3. Reuse the existing `schedule_day` / `planning_center_reconciliation_day`
   integer columns — no schema migration. The column already means "day of
   week" for weekly and will now also mean "day of month" for monthly; its
   meaning is always determined by the sibling `frequency` field.

## Non-Goals

- No time-of-day control (unchanged from the original design — still the
  existing nightly cron window).
- No backfill/catch-up logic for a missed monthly run (unchanged policy from
  the original design).
- No change to `daily` behavior, which still ignores `day` entirely.

## Design

### `isDueToday()` (`server/services/planningCenterSync.js`)

```js
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

This is the single function both `runBatchSync`'s schedule gate and the
reconciliation schedule gate call (`planningCenterSync.js:498,501`), so the
fix applies to both without touching either call site.

### Server validation

Both spots currently hardcode a `0–6` range on `day`:

- `server/routes/integrations.js:2182` (`validateBatchBody`) — this function
  always receives `scheduleFrequency` and `scheduleDay` together (the batch
  editor sends a full upsert every save). Change the range check to depend
  on `scheduleFrequency`:
  - `weekly` → `0–6`
  - `monthly` → `1–31`
  - `daily` → still required to be an integer, no range check (value is
    stored but never read)

- `server/routes/settings.js:567-572` (reconciliation day) — frequency and
  day are each optional fields on a general settings PATCH, so a request
  could in principle patch `planningCenterReconciliationDay` without
  `planningCenterReconciliationFrequency` present. Use
  `planningCenterReconciliationFrequency` from the same request body when
  present to pick the `0–6` / `1–31` range; when frequency is absent from
  the request, fall back to the permissive union range `0–31` (the client
  always sends both fields together via `saveReconciliationConfig`, so this
  fallback only matters for a hypothetical day-only API call, not normal
  usage).

### Client UI

Both `PlanningCenterBatchEditor.tsx` and
`PlanningCenterIntegrationPanel.tsx` (reconciliation section) currently
render a day-of-week `<select>` only `{frequency === 'weekly' && (...)}`.
Add a parallel day-of-month `<select>` shown when `frequency === 'monthly'`:

- Options 1st–31st (`value={n}`, label = ordinal string, e.g. "1st", "2nd",
  "3rd", "4th", ... "31st").
- A short helper note below/beside the select for the 29–31 range:
  "Runs on the last day of the month if it's shorter."

When the frequency `<select>` changes, clamp the stored day value so a
value valid for the old frequency doesn't get silently saved as invalid
for the new one:

```js
onChange={(e) => {
  const freq = e.target.value;
  setScheduleFrequency(freq);
  setScheduleDay((prev) => {
    if (freq === 'weekly') return prev >= 0 && prev <= 6 ? prev : 1;
    if (freq === 'monthly') return prev >= 1 && prev <= 31 ? prev : 1;
    return prev; // daily: value unused
  });
}}
```

Apply the same pattern to both the batch editor's `scheduleFrequency`
select and the reconciliation panel's `reconciliationFrequency` select.

## Testing

Extend the existing `isDueToday` suite in
`server/services/planningCenterSync.test.js` with monthly day-of-month
cases:

- Exact match: `isDueToday('monthly', 15, <the 15th>)` → `true`
- Day 31 clamped in a 30-day month (April): due on the 30th, not before
- Day 29 clamped in a non-leap February: due on the 28th
- Day 29 exact match in a leap February: due on the 29th

No automated test harness exists for either client panel (consistent with
the original schedule design's testing section) — manual verification via
the running app: set a batch and the reconciliation schedule to monthly
with a day in the 29–31 range, confirm the UI shows the short-month note,
and confirm `isDueToday` unit coverage above stands in for the scheduling
logic itself.
