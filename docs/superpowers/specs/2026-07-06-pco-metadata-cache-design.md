# PCO Membership/Field Metadata Cache

## Problem

`PlanningCenterBatchEditor` (used both from onboarding's PCO step and from Settings >
Integrations) loads two things live from Planning Center every time it opens:

- **Membership categories** (`GET /planning-center/membership-summary`) — derived from a
  full paginated fetch of all PCO people, gated by an in-memory 10-minute cache
  (`pcoPeopleCache` in `services/planningCenterSync.js`) that's cold on every server
  restart.
- **Custom field definitions** (`GET /planning-center/field-definitions`) — a live
  paginated fetch of `/people/v2/field_definitions` on every call, with no caching at
  all.

For a church with a lot of PCO data, both of these can take several seconds, and that
wait happens every time anyone opens the batch editor — including the very first time,
right after connecting PCO during onboarding, when the user is trying to set up their
first sync filter.

## Goal

Make membership categories and custom-tab field options available **immediately** when
the batch editor opens, by proactively fetching and persisting them as soon as PCO is
connected. If the persisted data is more than an hour old, still show it immediately but
refresh it in the background, with a subtle indicator that Planning Center is being
checked for updates — so the user can start configuring a filter right away, without
being blocked on a live PCO round trip, but can see when fresher data has landed.

## Data model

New columns on `church_settings` (`server/config/schema.js`), alongside the existing
`planning_center_*` columns:

- `planning_center_membership_cache` — `TEXT`, JSON:
  `{ total, values: [{ membership, count }], fetchedAt }` (shape matches today's
  `tallyMembership` output, plus `fetchedAt`, an epoch-ms timestamp).
- `planning_center_field_definitions_cache` — `TEXT`, JSON:
  `{ definitions: [{ id, name, dataType, tabName, options }], fetchedAt }` (shape matches
  today's `fetchFieldDefinitions` output, plus `fetchedAt`).

Both default to `NULL` (no cache yet — the pre-existing behavior of blocking on a live
fetch is preserved for that case).

## Server changes

### New `server/services/planningCenter/metadataCache.js`

- `getMembershipCache(churchId)` — reads and JSON-parses
  `planning_center_membership_cache`, or returns `null`.
- `getFieldDefinitionsCache(churchId)` — same for
  `planning_center_field_definitions_cache`.
- `refreshMetadataForChurch(churchId, accessToken)` — runs both live fetches (reusing
  `getCachedPcoPeople` + `tallyMembership` from `services/planningCenter/summary.js`, and
  `fetchFieldDefinitions` from `services/planningCenter/fieldDefinitions.js`), writes both
  columns with `fetchedAt: Date.now()`. Wrapped in a `Map<churchId, Promise>` so
  concurrent callers (e.g. two admins opening the editor at once, or an on-demand
  refresh overlapping the connect-time one) share one in-flight fetch instead of
  triggering duplicate PCO calls — mirrors the existing dedup pattern for
  `pcoPeopleCache`.

`STALE_MS = 60 * 60 * 1000` (1 hour) lives alongside these functions.

### OAuth callback (`server/routes/integrations.js` `/planning-center/callback`)

After `savePlanningCenterTokens`, fire off
`refreshMetadataForChurch(churchId, tokens.access_token).catch((e) => logger.error(...))`
without `await`, so it doesn't delay the redirect. This is the "cache it when first
connected" trigger.

### `/planning-center/membership-summary` and `/planning-center/field-definitions`

Both change to:

1. Read the persisted cache.
2. If present: respond immediately with the cached payload plus `fetchedAt` and
   `refreshing` (`true` if cache age > `STALE_MS`). If stale, also call
   `refreshMetadataForChurch` (not awaited — response already went out).
3. If absent (no cache row yet — e.g. connect-time refresh hasn't landed, or PCO was
   connected before this feature existed): fall back to today's behavior, `await`ing the
   live fetch directly (existing code path, unchanged), and populate the cache columns
   as a side effect so subsequent calls hit the fast path.

Response shape gains two fields on both endpoints: `fetchedAt: number`,
`refreshing: boolean`. Existing `values`/`definitions` fields are unchanged.

## Client changes

`PlanningCenterBatchEditor.tsx`:

- Both `loadMembershipSummary` (existing) and the definitions fetch inside
  `FieldFilterEditor` start tracking `refreshing` from the response.
- `PlanningCenterBatchEditor` holds a combined `anyRefreshing` boolean (OR of the
  membership fetch's `refreshing` and a `refreshing` value lifted up from
  `FieldFilterEditor` via a new `onRefreshingChange` prop) and renders a slim banner
  pinned to the bottom of the editor: "Checking Planning Center for the latest data…"
  with an indeterminate progress animation.
- While `refreshing` is `true`, the component that received it polls the same endpoint
  again after a short delay (~3s) until a response comes back with `refreshing: false`,
  then stops. Newly returned `values`/`definitions` replace the previous list in place —
  since `MembershipAllowlistEditor` and `FieldFilterEditor` key selections by membership
  string / `fieldDefinitionId` (not list index), a user's already-checked boxes stay
  checked even if the list underneath changes, and a value/field that disappears from
  the fresh list simply stops rendering as a choice without clearing the user's existing
  selection of it.
- No polling loop starts if the initial response already has `refreshing: false`.

## Error handling & edge cases

- Background refresh failures (`refreshMetadataForChurch` rejecting) are logged and
  otherwise ignored — the stale cache keeps serving indefinitely until a refresh
  eventually succeeds. No user-facing error unless there's no cache at all, in which
  case the existing live-fetch error handling already in both routes applies unchanged.
- Disconnecting and reconnecting PCO naturally overwrites the cache on the next
  connect-time refresh; no explicit invalidation step is needed.
- If a user opens the batch editor and closes it again before a background refresh
  finishes, that refresh still runs to completion server-side (it's independent of the
  request/response cycle) and simply updates the cache for next time.

## Testing

- `metadataCache.test.js`: persist/read round-trip for both cache columns, staleness
  check at the `STALE_MS` boundary, and dedup (two concurrent
  `refreshMetadataForChurch` calls for the same church only trigger one underlying
  fetch).
- Route-level tests for `/membership-summary` and `/field-definitions` covering: no
  cache (blocks and populates it), fresh cache (serves immediately, no refresh
  triggered), stale cache (serves immediately, `refreshing: true`, refresh triggered
  exactly once).
