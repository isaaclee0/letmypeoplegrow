# Planning Center People Sync — Frontend Design

**Date:** 2026-05-21
**Status:** Approved (design); pending implementation plan
**Backend spec:** `docs/superpowers/specs/2026-05-21-planning-center-people-sync-design.md`
**Backend plan (built + merged):** `docs/superpowers/plans/2026-05-21-planning-center-people-sync-backend.md`

## Problem & Goal

The backend for the PCO → LMPG people sync is built and merged: a reconcile pipeline (project → match → diff → apply) exposed via a nightly cron and HTTP endpoints (`membership-filter` GET/PUT, `sync/plan` dry-run, `sync/apply`). There is **no UI yet**. This spec covers the admin-facing frontend.

The app already has two relevant UI areas:
- **`SettingsPage.tsx` → Integrations → Planning Center**: OAuth connect/disconnect + a `syncIndicator` toggle + a legacy `autoArchive` toggle.
- **`ImportPage.tsx` → Planning Center tab**: a one-time "browse families & import" flow with a link-family modal.

## Key Decisions (locked)

| Decision | Choice |
|---|---|
| Old one-time PCO import flow | **Replace** it with the sync UI — single PCO people model ("PCO is source of truth") |
| Review/sync workspace home | **Repurpose the Import page's PCO tab** into a full-width "Sync & Review" workspace |
| Config home | **Settings → Integrations → Planning Center**: connection + allow-list config + Sync-now / Review-&-sync buttons |
| Allow-list editor data | **Membership value + person count** only (no check-in counts — check-ins are a declining/partial signal now that attendance lives in LMPG) |

## Backend Additions (small)

In `server/routes/integrations.js` + `server/services/planningCenterSync.js`:

1. **`GET /planning-center/membership-summary`** — 400 if not connected; else `getAccessTokenForChurch` → a projected people sweep → tally by `membership` → respond `{ total, values: [{ membership, count }] }` sorted by count desc. Reuses the sync service's fetch; export `fetchAllPcoPeople` from `planningCenterSync.js` for this. No check-in fetch.
2. **Surface last-sync result** — add `lastSyncResult` (parsed from `church_settings.planning_center_last_sync_result`, JSON, null-safe) to the existing `GET /planning-center/status` response so Settings can display the last run.

These are the only backend changes; all other endpoints already exist.

## API Client (`client/src/services/api.ts`)

Add:
- `getPlanningCenterMembershipSummary()` → `GET /integrations/planning-center/membership-summary` (timeout 120000)
- `getPlanningCenterMembershipFilter()` → `GET …/membership-filter`
- `savePlanningCenterMembershipFilter({ enabled, allowlist })` → `PUT …/membership-filter`
- `getPlanningCenterSyncPlan()` → `GET …/sync/plan` (timeout 120000)
- `applyPlanningCenterSync({ selections })` → `POST …/sync/apply` (timeout 120000)

Remove (old import flow being replaced):
- `getPlanningCenterPeople`, `importPeopleFromPlanningCenter`, `linkPlanningCenterFamily`

The backend `people`/`import-people`/`link-family` routes remain server-side (dead-but-harmless) — a later cleanup, out of scope here.

## Components

- **`client/src/components/planningCenter/MembershipAllowlistEditor.tsx`** — fetches `membership-summary`, renders a checklist (one row per membership value + person count + checkbox = sync this category). Props: current `allowlist`, `onChange`/`onSave`. Used in SettingsPage.
- **`client/src/components/planningCenter/PlanningCenterSyncReview.tsx`** — the review workspace (see below). Self-contained: fetches the plan, holds review state, applies. Rendered by ImportPage under the PCO tab.
- **`client/src/components/planningCenter/syncSelections.ts`** — pure helper `buildSelections(ambiguousChoices, skipAddPcoIds)` → `{ ambiguous: {individualId: pcoId}, skipAddPcoIds: string[] }`. Unit-tested.

Extracting these keeps `SettingsPage` and `ImportPage` from growing and gives each a single responsibility.

## Settings Panel (`SettingsPage.tsx`)

When PCO is **connected**, replace the legacy `autoArchive` toggle with a sync-config block (keep OAuth connect/disconnect and the `syncIndicator` toggle as-is):

1. **"Enable Planning Center sync" toggle** — local state bound to `planning_center_sync_enabled`. The legacy `autoArchive` UI toggle is removed (backend already retires that flag on save).
2. **`<MembershipAllowlistEditor>`** — checklist of membership values + counts; selected = `allowlist` (local state). Helper text: "Only checked categories add new people; archiving applies to everyone already linked."
3. **Explicit "Save sync settings" button** — persists both the enable toggle and the allow-list together via one `savePlanningCenterMembershipFilter({ enabled, allowlist })` call (no auto-save/debounce — these settings drive nightly behavior, so saving is deliberate). Disabled until a change is made; shows saved/error feedback. Initial values loaded via `getPlanningCenterMembershipFilter`.
4. **Status + actions:**
   - **Last sync** summary from `status.lastSyncResult` (added/updated/archived/reactivated/linked, ambiguous/unmatched, timestamp).
   - **"Sync now"** → `applyPlanningCenterSync({})` (auto mode); result toast/summary; disabled while running.
   - **"Review & sync"** → navigate to `/import?source=planning-center`.

Loading/empty/error states; admin-only (matches Integrations tab gating).

## Sync & Review Workspace (`ImportPage.tsx` PCO tab → `PlanningCenterSyncReview`)

Replace the existing PCO browse/import UI (and its `pcSelectedFamilies`, link-family modal, browse/import handlers) with the review component.

**Flow:**
1. On tab open (connected): `getPlanningCenterSyncPlan()` (dry-run). Loading state — fetches all PCO people, so a few seconds.
2. **Summary bar** of bucket counts: link / add / update / archive / reactivate / ambiguous / unmatched.
3. **Sections:**
   - **Auto-link** (high-confidence): count + expandable list. Informational (applied on confirm).
   - **Ambiguous** (needs you): per individual — LMPG name + radio list of candidate PCO people (name + membership) + "Skip / leave unlinked". **Default = skip** (no accidental links).
   - **New people to add**: grouped by family, checkbox default-on; deselect to skip. (Already allow-list-filtered server-side.)
   - **Update / Archive / Reactivate**: informational collapsed lists with counts (applied automatically).
   - **Unmatched**: informational ("stays in LMPG, unlinked").
4. **Apply** → `applyPlanningCenterSync({ selections })` with `selections = buildSelections(ambiguousChoices, skipAddPcoIds)`. Backend re-computes + sanitizes + applies, returns result. Show result summary + "Re-run plan" to refresh.

**States:** not connected → prompt + link to Settings; sync disabled or allow-list empty → notice that adds won't happen until configured, link to Settings.

## Error Handling

- API failures surface inline (not silent); reuse the page's existing error display patterns.
- Apply returns per-item `errors` — show an "N errors" affordance with a generic message; do not surface raw DB text.
- Long fetches (plan, summary) use the 120s timeout already used by the old PCO calls; show spinners.

## Testing

Run via Docker (project rule), client uses vitest:
- **Unit:** `syncSelections.test.ts` — payload building (ambiguous map → object, skip set → array, empty/partial cases).
- **Component:** `MembershipAllowlistEditor` (renders rows from summary; toggling updates selection/allowlist) and `PlanningCenterSyncReview` (renders buckets from a mocked plan; ambiguous radio updates the apply payload; deselecting an add removes it).
- **Manual:** full connect → configure allow-list → review → apply round-trip against the dev stack.

Build aesthetics: use the `frontend-design` skill at implementation time so panels/review screen match the app's Tailwind + Headless UI style.

## Out of Scope

- Removing the dead backend `people`/`import-people`/`link-family` routes (later cleanup).
- Any change to the matching/diff/apply logic (backend is done).
- Bulk one-time CSV import UI (unchanged; only the PCO import path is replaced).
