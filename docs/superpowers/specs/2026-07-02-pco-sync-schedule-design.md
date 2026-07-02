# Planning Center Sync: Configurable Frequency & Day

**Date:** 2026-07-02
**Status:** Approved

## Problem

Planning Center sync (`server/services/planningCenterSync.js`) runs for
*every* enabled church, *every* night, via a single fixed 2 AM cron. There is
no way for a church to sync less often (e.g. monthly) or to pick which day of
the week it runs on.

## Goals

1. Let an admin choose a sync frequency: `daily`, `weekly` (default), or
   `monthly`.
2. For `weekly`, let the admin choose the day of week. Default: **Monday**.
3. Do not expose a time-of-day control — the server always runs its existing
   nightly 2 AM window; frequency/day only gate *whether* a given church runs
   on a given night.

## Non-Goals

- No change to the cron trigger time or to the sequential per-church
  processing loop — the existing 2 AM nightly cron, iterating churches one at
  a time, already spreads load adequately. No new staggering/offset logic.
- No day-of-month picker for `monthly` — it always runs on the 1st.
- No change to what a sync does (`syncChurch`'s plan/apply logic) or to the
  manual "Sync now" / "Review & sync" flows, which remain on-demand and
  frequency-independent.
- No backfill/catch-up logic if the server is down during a scheduled night
  (e.g. a `weekly` church misses its Monday because the server was offline).
  Same behavior as today: no run happens, next scheduled night is the next
  match.

## Design

### Schema (`server/config/schema.js` + migration in `server/config/database.js`)

Two new columns on `church_settings`:

- `planning_center_sync_frequency TEXT DEFAULT 'weekly'` — `'daily' |
  'weekly' | 'monthly'`
- `planning_center_sync_day INTEGER DEFAULT 1` — day of week, `0`=Sunday ..
  `6`=Saturday, default `1` (Monday). Only meaningful when frequency is
  `'weekly'`; stored but ignored otherwise.

Follow the existing migration pattern: add both columns to the
`CREATE TABLE church_settings` definition in `schema.js`, and add
`ALTER TABLE church_settings ADD COLUMN ...` migration statements in
`database.js` alongside the other `planning_center_*` migrations, so existing
per-church databases pick them up.

### Scheduling gate (`server/services/planningCenterSync.js`)

The cron itself is untouched (`cron.schedule('0 2 * * *', ...)`, still loops
`Database.listChurches()` sequentially). Inside `syncChurch`, after loading
`church_settings` and confirming sync is `enabled` (existing check), add a
new gate before calling `computePlanForChurch`/`applyForChurch`:

```js
function isDueToday(frequency, day, now = new Date()) {
  if (frequency === 'daily') return true;
  if (frequency === 'monthly') return now.getDate() === 1;
  // weekly (default)
  return now.getDay() === (typeof day === 'number' ? day : 1);
}
```

`syncChurch` selects `planning_center_sync_frequency,
planning_center_sync_day` alongside the existing settings columns, and skips
(returns early, no-op, no log spam beyond existing patterns) when
`!isDueToday(...)`.

`runNow()` (manual trigger / "Sync now" button) is unaffected — it bypasses
the schedule gate entirely, same as today.

### API (`server/routes/settings.js`)

`GET /api/settings/integrations` response gains:
- `planningCenterSyncFrequency: 'daily' | 'weekly' | 'monthly'`
- `planningCenterSyncDay: number` (0-6)

`PUT /api/settings/integrations` accepts optional `planningCenterSyncFrequency`
and `planningCenterSyncDay`:
- `planningCenterSyncFrequency` validated against the 3 allowed values;
  reject with 400 otherwise.
- `planningCenterSyncDay` validated as an integer 0-6; reject with 400
  otherwise. Accepted regardless of current frequency (so the UI can save day
  before/independent of switching to weekly).

### Client

`settingsAPI.updateIntegrationSettings` (`client/src/services/api.ts`) type
signature extended with the two optional fields.

`PlanningCenterIntegrationPanel.tsx`: within the existing "Enable Planning
Center sync" section (below the enable toggle, above the membership
allowlist editor), add:

- A frequency `<select>`: Daily / Weekly / Monthly.
- A day-of-week `<select>` (Sunday..Saturday), rendered only when frequency
  is Weekly.

Both are loaded via `settingsAPI.getIntegrationSettings()` (already fetched
on mount) and saved via the existing `savePcSyncConfig` "Save sync settings"
button — i.e. they join `pcSyncEnabled`/`pcAllowlist` as part of the same
dirty-tracked config, not a separate save action.

## Testing

No automated test runner for the client; server has Jest coverage for
`planningCenterSync`-adjacent modules (e.g. `apply.test.js`) but not for
`planningCenterSync.js` itself currently. Add a unit test for the new
`isDueToday` helper (exported for testability) covering: daily always true,
weekly matches/mismatches day, monthly matches only the 1st. Manual
verification for the settings UI (save/reload round-trip) since there's no
existing test harness for that panel.
