# Integration Settings Consolidation — Design

**Date:** 2026-06-06
**Status:** Approved (pending spec review)

## Problem

Integration functionality is split awkwardly across two pages:

- **Settings → Integrations tab** holds connection + configuration for Elvanto, AI
  Insights, and Planning Center. The Planning Center card inlines a large amount of
  config (sync-indicator toggle, sync-enable toggle, membership allowlist, Save / Sync
  now / "Review & sync" buttons, and the `<PCOCheckinImport>` check-in importer).
- **Import page** (`/app/import`) holds the actual import/sync flows: the Elvanto
  import UI (people/families + gatherings), the Planning Center People sync review
  (`<PlanningCenterSyncReview>`), a read-only Planning Center check-ins viewer, and a
  dev-only Historical CSV importer.

The result is overlap and an unclear mental model: configuration lives in Settings,
but the actions those settings drive live on a separate page, and the "Review & sync"
button in Settings navigates the user away to the Import page.

## Goal

Consolidate **everything** for each integration (connection, configuration, and
import/sync actions) behind a single per-integration view in **Settings →
Integrations**. The integrations list itself should be minimal: each integration shows
only its connection status, a disconnect control, and an edit (pencil) control that
opens its full configuration view. When a user first connects an integration, take
them straight to that view to configure it.

Remove the Import page entirely.

## Design

### Information architecture

A two-level, in-page experience inside the existing Settings → Integrations tab. No new
routes; navigation is driven by local component state.

**Level 1 — card list.** One compact card per integration: Elvanto, AI Insights,
Planning Center. Each card shows:

- icon, name, one-line description
- connection-status badge (Connected / Not Connected)
- when **connected**: a **Disconnect** button and a **pencil** (edit) button
- when **not connected**: a single **Set up** button

No toggles, key fields, allowlists, or import flows appear at this level.

**Level 2 — detail panel.** Selecting the pencil (connected) or **Set up** (not
connected) replaces the card list with that integration's full panel, headed by a
**← Back to integrations** control. State: `selectedIntegration: 'elvanto' | 'ai' |
'planning-center' | null`. `null` renders the card list; any value renders that panel.

**First-connect behaviour.** After a successful connection, set `selectedIntegration`
to that integration so the user lands on its configuration panel:

- **Planning Center** connects via OAuth redirect. The callback returns to
  `/app/settings?tab=integrations` (existing `?pco=connected` handling). Extend that
  handler to also set `selectedIntegration = 'planning-center'`.
- **Elvanto** and **AI Insights** connect inline within their own panels (the connect
  form lives in the panel), so on success they simply remain in-panel and reveal the
  post-connect configuration.

**Icon choice.** Use `PencilIcon` for the edit control, matching the Settings nav item
and existing conventions.

### Component decomposition

`SettingsPage.tsx` is already ~2400 lines; folding three import flows into it inline is
untenable. Introduce `client/src/components/integrations/`:

- **`IntegrationsTab.tsx`** — owns `selectedIntegration` state; renders either the card
  list or the active panel. Replaces the inline `activeTab === 'integrations'` block in
  `SettingsPage.tsx`. Receives (or itself fetches) the per-integration status currently
  fetched in `SettingsPage` (`fetchElvantoStatus`, `fetchAiStatus`,
  `fetchPlanningCenterStatus`).
- **`IntegrationCard.tsx`** — reusable compact card: icon, name, description, status
  badge, and slots for the disconnect + pencil (or Set up) controls.
- **`ElvantoIntegrationPanel.tsx`** — Elvanto API-key connect/disconnect **plus the
  full Elvanto import flow** (People & Families and Gatherings sub-tabs, search, select,
  import, the gathering-edit modal) moved out of `ImportPage.tsx`.
- **`AiIntegrationPanel.tsx`** — AI provider/key form used both for first-time setup
  and for changing the key later, plus disconnect. (AI has no other post-connect
  settings; the cog opens this form.)
- **`PlanningCenterIntegrationPanel.tsx`** — OAuth connect/disconnect; sync-indicator
  toggle; sync-enable toggle; `<MembershipAllowlistEditor>`; Save sync settings; Sync
  now; **Review & sync** (now reveals `<PlanningCenterSyncReview>` inline in the panel
  instead of navigating to the Import page); and `<PCOCheckinImport>`. Reuses the
  existing sub-components unchanged.

The existing `<MembershipAllowlistEditor>`, `<PCOCheckinImport>`,
`<PlanningCenterSyncReview>`, and `syncSelections` helpers are reused as-is.

### Import page removal

- Delete the **Import** nav item (`Layout.tsx:151`).
- Delete the `/app/import` route and its `RoleProtectedRoute` wrapper in `App.tsx`.
- Delete `client/src/pages/ImportPage.tsx`.
- **Drop the Historical CSV importer** (dev-only, effectively unused).
- **Drop the read-only Planning Center check-ins viewer** that lived on the Import page
  — it is redundant with `<PCOCheckinImport>`, which is the actual importer and moves
  into the PCO panel.
- Update `SettingsPage.tsx:2023`: the "Review & sync" button no longer navigates to
  `/app/import?source=planning-center`; it reveals `<PlanningCenterSyncReview>` in-panel.

### References that remain valid

`?tab=integrations` deep links continue to work because the Integrations tab itself is
unchanged in identity — only its contents are restructured. These need no change:

- `AiInsightsPage.tsx:293` → `/app/settings?tab=integrations`
- `PlanningCenterSyncReview.tsx:87` → `/app/settings?tab=integrations` (its "not
  connected" branch; harmless since the component is only rendered when connected)
- `SettingsPage.tsx:504,508` → OAuth callback `replaceState` to
  `/app/settings?tab=integrations` (extend to also open the PCO panel)

## Out of scope

- Server routes and the integrations API surface — unchanged.
- The standalone `/app/ai-insights` page and its nav item — unchanged (separate feature
  from the AI Insights *connection* card).
- `Layout.tsx` `integrationsConfigured` status logic — unchanged.

## Testing

- Existing tests for `PCOCheckinImport` (`checkinsImport.test.js` is server-side;
  client-side coverage as present) continue to pass against the reused component.
- Manual/Docker verification of: card list rendering for each connection state;
  pencil/Set up opening the correct panel; back navigation; first-connect redirect for
  all three integrations; Elvanto import flow working from its new home; PCO sync config,
  Sync now, Review & sync (inline), and check-in import working from the PCO panel; the
  `/app/import` route returning to nav-less state (404/redirect) and no dangling links.

## Open questions

None outstanding. (Historical CSV and the read-only check-ins viewer are confirmed for
removal; `PlanningCenterSyncReview` is confirmed to move inline into the PCO panel.)
