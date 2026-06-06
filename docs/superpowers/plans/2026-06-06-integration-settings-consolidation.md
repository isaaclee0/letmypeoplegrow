# Integration Settings Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all integration connection/config/import functionality (Elvanto, AI Insights, Planning Center) behind a per-integration detail panel inside Settings → Integrations, and delete the standalone Import page.

**Architecture:** A new `client/src/components/integrations/` module. `IntegrationsTab` owns the three integration status objects and an in-page `selectedIntegration` router: it shows a compact card list (status + Disconnect + pencil), and on selection swaps in a self-contained detail panel per integration. Each panel holds that integration's connect form, configuration, and import/sync actions — the Elvanto import flow and the Planning Center sync/check-in UI move out of the deleted `ImportPage`.

**Tech Stack:** React 19 + TypeScript + Vite, Tailwind CSS, Heroicons, existing `integrationsAPI`/`aiAPI`/`settingsAPI` clients, existing `<MembershipAllowlistEditor>`, `<PCOCheckinImport>`, `<PlanningCenterSyncReview>` components.

---

## Verification note (project rule)

Per the project's standing instruction, **never run builds or type checks locally**. After each code change, verify with Docker and read the logs:

```bash
docker-compose -f docker-compose.dev.yml up -d client
docker-compose -f docker-compose.dev.yml logs --tail=80 client
```

The Vite dev server type-checks on compile; a successful HMR/compile with no TypeScript errors in the logs is the "test passes" signal for each task. Manual smoke checks in the browser (http://localhost:3000) confirm behaviour. There is no unit-test harness for these UI components, so verification is compile-clean + manual smoke, not automated assertions.

Commit after each task.

---

## Shared interfaces (used across tasks)

These types are defined inside `IntegrationsTab.tsx` and imported by the panels via a small shared file. Define them in Task 1.

```ts
// client/src/components/integrations/types.ts
export interface ElvantoStatus {
  connected: boolean;
  loading: boolean;
  elvantoAccount: string | null;
  error?: string | null;
}

export interface AiStatus {
  configured: boolean;
  provider: 'openai' | 'anthropic' | 'grok' | null;
  loading: boolean;
}

export interface PlanningCenterStatus {
  enabled: boolean;
  connected: boolean;
  loading: boolean;
}

export type IntegrationKey = 'elvanto' | 'ai' | 'planning-center';

export interface PanelProps<S> {
  status: S;
  refreshStatus: () => void | Promise<void>;
  onBack: () => void;
}
```

(The exact shapes mirror the inline state objects currently in `SettingsPage.tsx` lines 45–58, 67–71, 79–83. Match the real fields when you move them.)

---

## Task 1: Scaffolding — types + IntegrationCard

**Files:**
- Create: `client/src/components/integrations/types.ts`
- Create: `client/src/components/integrations/IntegrationCard.tsx`

- [ ] **Step 1: Create `types.ts`**

Paste the "Shared interfaces" block above into `client/src/components/integrations/types.ts`.

- [ ] **Step 2: Create `IntegrationCard.tsx`**

A pure presentational card. Connected → status badge + Disconnect + pencil. Not connected → "Set up" button.

```tsx
import React from 'react';
import {
  ShieldCheckIcon,
  ShieldExclamationIcon,
  ArrowPathIcon,
  PencilIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';

interface IntegrationCardProps {
  name: string;
  description: string;
  /** Coloured 12x12 icon block rendered on the left. */
  icon: React.ReactNode;
  connected: boolean;
  loading: boolean;
  /** Optional sub-line shown under the description when connected (e.g. account name). */
  connectedLabel?: string;
  /** Opens the detail panel (pencil when connected, "Set up" when not). */
  onOpen: () => void;
  /** Only rendered when connected. */
  onDisconnect?: () => void;
}

const IntegrationCard: React.FC<IntegrationCardProps> = ({
  name, description, icon, connected, loading, connectedLabel, onOpen, onDisconnect,
}) => {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="shrink-0">{icon}</div>
          <div>
            <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">{name}</h4>
            <p className="text-sm text-gray-600 dark:text-gray-400">{description}</p>
            {connected && connectedLabel && (
              <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center">
                <CheckCircleIcon className="w-3 h-3 mr-1" />
                {connectedLabel}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center space-x-3">
          {loading ? (
            <ArrowPathIcon className="w-5 h-5 animate-spin text-gray-400" />
          ) : connected ? (
            <>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                <ShieldCheckIcon className="w-3 h-3 mr-1" />
                Connected
              </span>
              {onDisconnect && (
                <button
                  onClick={onDisconnect}
                  className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                >
                  Disconnect
                </button>
              )}
              <button
                onClick={onOpen}
                aria-label={`Edit ${name} settings`}
                className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                <PencilIcon className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                Not Connected
              </span>
              <button
                onClick={onOpen}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
              >
                Set up
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default IntegrationCard;
```

- [ ] **Step 3: Verify compile**

Run the Docker logs command from the verification note. Expected: client compiles with no TypeScript errors (the new files are not yet imported anywhere, so this only checks they're internally valid).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/integrations/types.ts client/src/components/integrations/IntegrationCard.tsx
git commit -m "feat(integrations): add IntegrationCard and shared types"
```

---

## Task 2: AiIntegrationPanel

Move the AI Insights connect/disconnect state, handlers, JSX, and the AI disconnect modal out of `SettingsPage.tsx` into a self-contained panel. (Do NOT yet delete from SettingsPage — that happens in Task 6 when the tab is swapped. For now, create the new component using the same logic so it can be wired up.)

**Files:**
- Create: `client/src/components/integrations/AiIntegrationPanel.tsx`
- Reference (copy from): `client/src/pages/SettingsPage.tsx` lines 67–76 (state), 194–240 (`fetchAiStatus`, `handleAiConnect`, `confirmAiDisconnect`), 1699–1842 (AI card JSX), 2329–2378 (AI disconnect modal)

- [ ] **Step 1: Create `AiIntegrationPanel.tsx`**

Structure:
- Props: `PanelProps<AiStatus>` (`status`, `refreshStatus`, `onBack`).
- Internal state (moved from SettingsPage 72–76): `aiApiKey`, `aiProvider`, `aiSaving`, `aiError`, `showAiDisconnectModal`.
- Handlers `handleAiConnect` and `confirmAiDisconnect` copied from SettingsPage 205–240, with every `setAiStatus(...)`/`fetchAiStatus()` call replaced by `refreshStatus()`. Keep the `aiAPI` import and the `localStorage`/cache clearing logic exactly as in the original `confirmAiDisconnect`.
- Render a header row: a `← Back to integrations` button calling `onBack`, then the AI panel body.
- Body: reuse the AI card JSX from SettingsPage 1699–1842 verbatim, EXCEPT:
  - replace the status read `aiStatus.configured`/`aiStatus.loading`/`aiStatus.provider` with `status.configured`/`status.loading`/`status.provider`.
  - the Disconnect button stays (it opens the modal); the connected/not-connected badge can stay as-is (it duplicates the card but is fine inside the panel) or be removed — keep it for now.
- Append the AI disconnect `<Modal>` from SettingsPage 2329–2378 verbatim, swapping `confirmAiDisconnect`/`setShowAiDisconnectModal` to the local copies.

Imports needed: `React, { useState }`, `aiAPI` from `../../services/api`, `Modal` from `../Modal`, `logger` from `../../utils/logger`, the Heroicons used in the copied JSX (`ArrowPathIcon, LinkIcon, ShieldCheckIcon, ShieldExclamationIcon, CheckCircleIcon, InformationCircleIcon, ArrowLeftIcon`), and `AiStatus`, `PanelProps` from `./types`.

Back-button header pattern (reused by all three panels):

```tsx
<button
  onClick={onBack}
  className="inline-flex items-center text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 mb-4"
>
  <ArrowLeftIcon className="h-4 w-4 mr-1.5" />
  Back to integrations
</button>
```

- [ ] **Step 2: Verify compile**

Run Docker logs command. Expected: no TypeScript errors. (Still not imported anywhere.)

- [ ] **Step 3: Commit**

```bash
git add client/src/components/integrations/AiIntegrationPanel.tsx
git commit -m "feat(integrations): add AiIntegrationPanel"
```

---

## Task 3: ElvantoIntegrationPanel (connect form + import flow)

This is the largest task: it combines the Elvanto connect/disconnect (from SettingsPage) with the entire Elvanto import flow (from ImportPage).

**Files:**
- Create: `client/src/components/integrations/ElvantoIntegrationPanel.tsx`
- Reference (connect/disconnect): `client/src/pages/SettingsPage.tsx` lines 45–64 (Elvanto state), 175–193 (`fetchElvantoStatus`), 714–838 (`handleElvantoConnect`, `handleElvantoDisconnect`, `confirmDisconnect`), 1562–1697 (Elvanto card JSX: header, API-key form, "what you'll get"), 2162–2276 (API key guide modal), 2278–2327 (Elvanto disconnect modal)
- Reference (import flow): `client/src/pages/ImportPage.tsx` — interfaces 22–73; all Elvanto state and handlers (everything for People & Families and Gatherings: `loadFamilies`, `loadGatherings`, selection helpers, `handleImport`, `performPeopleImport`, `handleImportGatherings`, `checkAndShowEditModal`, `performGatheringImport`, `getPersonDisplayName`); the Elvanto JSX `sourceTab === 'elvanto' && isConnected` block (ImportPage ~946–1342), the floating import button (~1343), and the gathering-selection / edit modals (~1634–1721)

- [ ] **Step 1: Create `ElvantoIntegrationPanel.tsx` skeleton with connect form**

- Props: `PanelProps<ElvantoStatus>`.
- Internal state: the Elvanto connect bits from SettingsPage 60–64 (`elvantoApiKey`, `savingConfig`, `connectionError`, `showApiKeyGuide`, `showDisconnectModal`).
- Handlers `handleElvantoConnect`, `handleElvantoDisconnect`, `confirmDisconnect` copied from SettingsPage 714–838, replacing `setElvantoStatus(...)`/`fetchElvantoStatus()` with `refreshStatus()`. Preserve the localStorage clearing logic in `confirmDisconnect` exactly.
- Render: back-button header; then:
  - when `!status.connected`: the Elvanto connect card body (API-key form) from SettingsPage 1612–1696, plus the API-key guide `<Modal>` (2162–2276).
  - when `status.connected`: a Disconnect button + the Elvanto import UI (added in Step 2) + the Elvanto disconnect `<Modal>` (2278–2327).
- Swap status reads `elvantoStatus.connected`/`.loading`/`.elvantoAccount` → `status.connected`/`.loading`/`.elvantoAccount`.

- [ ] **Step 2: Move the Elvanto import flow into the panel**

Into the `status.connected` branch, port from `ImportPage.tsx`:
- The interfaces `ElvantoPerson`, `ElvantoFamily`, `ElvantoGroup`, `ElvantoService`, `ServiceType`, and `type TabType = 'people' | 'gatherings'` (ImportPage 22–75). Put them at the top of the panel file.
- All Elvanto-specific `useState`/`useCallback` from ImportPage that the People and Gatherings tabs use (search term, families, members, selectedPeople, groups, services, import-result state, edit-modal state, etc.). Copy them verbatim.
- The handlers listed in the Files section, verbatim, except: any `navigate(...)` to `/app/import...` is removed, and gating on `isConnected` is replaced by `status.connected`.
- The JSX: the Elvanto sub-tabs nav + People tab content + Gatherings tab content + floating import button + gathering selection/edit modals (ImportPage ~948–1342, 1343–1633, 1634–1721). Drop the outer `sourceTab === 'elvanto'` wrapper and the "Elvanto Not Connected" warning block (ImportPage 923–945) — the panel already handles the not-connected case via the connect form.
- `createPortal` import from `react-dom` is needed for the floating button (ImportPage uses it).

Imports: `React, { useState, useEffect, useCallback }`, `createPortal`, `integrationsAPI, gatheringsAPI, aiAPI?` (only what's used; Elvanto uses `integrationsAPI` + `gatheringsAPI`), `Modal`, `logger`, the Heroicons used by both the connect card and the import flow (union of ImportPage's icon imports + `ArrowLeftIcon`), and `ElvantoStatus, PanelProps` from `./types`.

- [ ] **Step 3: Verify compile**

Run Docker logs command. Expected: no TypeScript errors. Watch specifically for unused imports and missing state vars — the import flow has many; the compiler will flag any you missed.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/integrations/ElvantoIntegrationPanel.tsx
git commit -m "feat(integrations): add ElvantoIntegrationPanel with connect + import flow"
```

---

## Task 4: PlanningCenterIntegrationPanel

Move the Planning Center card + all its config out of SettingsPage, and inline `<PlanningCenterSyncReview>` behind the "Review & sync" button (replacing the old navigate to `/app/import`).

**Files:**
- Create: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Reference: `client/src/pages/SettingsPage.tsx` lines 79–96 (PC state), 242–336 (`fetchPlanningCenterStatus`, `loadPcSyncConfig`, `loadPcSummary` if present, `handlePcSyncIndicatorToggle`, `savePcSyncConfig`, `runPcSyncNow`, `handlePlanningCenterConnect`, `confirmPlanningCenterDisconnect`), 1844–2044 (PC card JSX), 2380–2429 (PC disconnect modal)
- Reuse: `client/src/components/planningCenter/MembershipAllowlistEditor`, `client/src/components/PCOCheckinImport`, `client/src/components/planningCenter/PlanningCenterSyncReview`

- [ ] **Step 1: Create `PlanningCenterIntegrationPanel.tsx`**

- Props: `PanelProps<PlanningCenterStatus>`.
- Internal state: all `pc*` state from SettingsPage 84–96 (`planningCenterConnecting`, `planningCenterError`, `showPlanningCenterDisconnectModal`, `pcSyncIndicator`, `pcSyncEnabled`, `pcAllowlist`, `pcSummary`, `pcSummaryLoading`, `pcSummaryError`, `pcConfigDirty`, `pcConfigSaving`, `pcLastSync`, `pcSyncRunning`), plus a NEW `const [showSyncReview, setShowSyncReview] = useState(false)`.
- Handlers copied from SettingsPage 257–336 verbatim, replacing `setPlanningCenterStatus(...)`/`fetchPlanningCenterStatus()` with `refreshStatus()`. Keep `loadPcSyncConfig`/summary loading exactly.
- A `useEffect` to call `loadPcSyncConfig()` (and summary load + sync-indicator fetch) when `status.connected` becomes true — mirror whatever the SettingsPage `useEffect` at ~840–849 did for PC so config loads on entry.
- Render: back-button header; then the PC card body from SettingsPage 1846–2044, with:
  - status reads `planningCenterStatus.*` → `status.*`.
  - **Replace** the "Review & sync" button (SettingsPage 2021–2027, `onClick={() => navigate('/app/import?source=planning-center')}`) with `onClick={() => setShowSyncReview(v => !v)}` and label `{showSyncReview ? 'Hide review' : 'Review & sync'}`.
  - Immediately after that button row, render the inline review:
    ```tsx
    {showSyncReview && status.connected && (
      <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
        <PlanningCenterSyncReview connected={status.connected} />
      </div>
    )}
    ```
  - Keep the `<MembershipAllowlistEditor>` and `<PCOCheckinImport>` usages as-is.
- Append the PC disconnect `<Modal>` from SettingsPage 2380–2429, swapping `confirmPlanningCenterDisconnect`/`setShowPlanningCenterDisconnectModal` to local copies.

Imports: `React, { useState, useEffect, useCallback }`, `integrationsAPI, settingsAPI` from `../../services/api`, `Modal`, `logger`, `MembershipAllowlistEditor`, `PCOCheckinImport`, `PlanningCenterSyncReview`, the Heroicons used in the copied JSX + `ArrowLeftIcon`, and `PlanningCenterStatus, PanelProps` from `./types`.

- [ ] **Step 2: Verify compile**

Run Docker logs command. Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/integrations/PlanningCenterIntegrationPanel.tsx
git commit -m "feat(integrations): add PlanningCenterIntegrationPanel with inline sync review"
```

---

## Task 5: IntegrationsTab (card list + panel router + status ownership)

**Files:**
- Create: `client/src/components/integrations/IntegrationsTab.tsx`

- [ ] **Step 1: Create `IntegrationsTab.tsx`**

Responsibilities:
- Own the three status objects and their fetchers (move the logic from SettingsPage `fetchElvantoStatus` 175–193, `fetchAiStatus` 194–204, `fetchPlanningCenterStatus` 242–256). Fetch all three on mount via `useEffect`.
- Own `const [selected, setSelected] = useState<IntegrationKey | null>(null)`.
- On mount, read URL params for the OAuth return: if `pco === 'connected'` → `setSelected('planning-center')` and refresh PC status; if `pco_error` present → `setSelected('planning-center')` and surface the error (pass it down or store it). Then `window.history.replaceState({}, '', '/app/settings?tab=integrations')`. (This is the logic currently in SettingsPage 497–509; it moves here. SettingsPage keeps only the part that sets `activeTab='integrations'` — see Task 6.)
- Props: `interface IntegrationsTabProps { autoOpen?: IntegrationKey | null }` — SettingsPage passes `autoOpen` when it detected a `pco` param so the tab opens the PC panel even if the URL was already cleaned. (If you handle the param entirely inside IntegrationsTab per the bullet above, `autoOpen` is optional/defensive.)

Render:

```tsx
if (selected === 'elvanto') {
  return <ElvantoIntegrationPanel status={elvantoStatus} refreshStatus={fetchElvantoStatus} onBack={() => setSelected(null)} />;
}
if (selected === 'ai') {
  return <AiIntegrationPanel status={aiStatus} refreshStatus={fetchAiStatus} onBack={() => setSelected(null)} />;
}
if (selected === 'planning-center') {
  return <PlanningCenterIntegrationPanel status={pcStatus} refreshStatus={fetchPlanningCenterStatus} onBack={() => setSelected(null)} />;
}
// otherwise the card list:
```

Card list (header + three `<IntegrationCard>`s). Use the coloured icon blocks from the original cards:
- Elvanto: blue block, the document-stack svg (SettingsPage 1568–1572).
- AI Insights: purple block, the lightbulb svg (SettingsPage 1705–1709).
- Planning Center: green block, the check-circle svg (SettingsPage 1850–1854). Only render the PC card when `pcStatus.enabled` (mirrors the existing `planningCenterStatus.enabled` guard at SettingsPage 1845).

Each card's `onOpen` → `setSelected(key)`; `onDisconnect` for connected cards opens that integration's disconnect flow. **Decision:** to keep disconnect confirmation modals inside the panels (where they already live), the card's Disconnect button should `setSelected(key)` AND signal the panel to open its disconnect modal. Simplest implementation: card Disconnect just opens the panel (`setSelected(key)`); the user clicks Disconnect again inside the panel. To avoid a double-click, instead pass an `openDisconnect` intent: add optional `initialAction?: 'disconnect'` to each panel's props and have the panel open its modal on mount when set. Implement the intent variant:
  - Add `const [pendingDisconnect, setPendingDisconnect] = useState<IntegrationKey | null>(null)`.
  - Card `onDisconnect={() => { setSelected(key); setPendingDisconnect(key); }}`.
  - Pass `initialAction={pendingDisconnect === key ? 'disconnect' : undefined}` to the panel, and clear `pendingDisconnect` after.
  - In each panel, add `initialAction?: 'disconnect'` to props and `useEffect(() => { if (initialAction === 'disconnect') setShow<X>DisconnectModal(true); }, [initialAction])`.

Header text: reuse SettingsPage 1556–1559 ("External Integrations" + description).

Imports: `React, { useState, useEffect, useCallback }`, `integrationsAPI, aiAPI` from `../../services/api`, `logger`, `IntegrationCard`, the three panels, and the types.

- [ ] **Step 2: Update the three panels for `initialAction`**

Add the optional `initialAction?: 'disconnect'` prop and the `useEffect` opening the disconnect modal to `AiIntegrationPanel`, `ElvantoIntegrationPanel`, and `PlanningCenterIntegrationPanel`. (Extend each `PanelProps<S>` usage with the extra optional field, or add it inline to each panel's props type.)

- [ ] **Step 3: Verify compile**

Run Docker logs command. Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/integrations/
git commit -m "feat(integrations): add IntegrationsTab card list + panel router"
```

---

## Task 6: Wire IntegrationsTab into SettingsPage and remove the old inline integrations code

**Files:**
- Modify: `client/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Import and render IntegrationsTab**

Add `import IntegrationsTab from '../components/integrations/IntegrationsTab';` near the other imports.

Replace the entire inline integrations block (SettingsPage 1553–2049, `{activeTab === 'integrations' && user?.role === 'admin' && ( ... )}`) with:

```tsx
{activeTab === 'integrations' && user?.role === 'admin' && (
  <IntegrationsTab autoOpen={pcoAutoOpen} />
)}
```

- [ ] **Step 2: Trim the OAuth-callback effect**

In the effect at SettingsPage ~489–510, keep setting `activeTab` from the `tab` param. For the `pco`/`pco_error` branch (497–509): keep `setActiveTab('integrations')` and set a new local state `const [pcoAutoOpen, setPcoAutoOpen] = useState<'planning-center' | null>(null)` to `'planning-center'`. Remove the `fetchPlanningCenterStatus()`, `setPlanningCenterError(...)`, `alert(...)`, and `replaceState` lines here — that handling now lives in `IntegrationsTab` (Task 5 Step 1). Leave the URL as-is so IntegrationsTab can read `pco`/`pco_error` on its own mount, then clean it.

- [ ] **Step 3: Delete now-dead integration state, handlers, and modals from SettingsPage**

Remove (these all moved into panels/IntegrationsTab):
- State: 45–64 (Elvanto), 67–76 (AI), 79–96 (Planning Center).
- Handlers: `fetchElvantoStatus` (175–193), `fetchAiStatus` (194–204), `handleAiConnect` (205–225), `confirmAiDisconnect` (226–240), `fetchPlanningCenterStatus` (242–256), `loadPcSyncConfig` (257–274), `handlePcSyncIndicatorToggle` (275–284), `savePcSyncConfig` (285–296), `runPcSyncNow` (297–308), `handlePlanningCenterConnect` (310–321), `confirmPlanningCenterDisconnect` (324–336), `handleElvantoConnect` (714–736), `handleElvantoDisconnect` (737–741), `confirmDisconnect` (742–838), and any PCO summary loader.
- The mount `useEffect` calls to `fetchElvantoStatus/fetchAiStatus/fetchPlanningCenterStatus` (in the effect ~840–849) — remove those three calls but KEEP `fetchLocation()` and its deps. Adjust the dependency array accordingly.
- Modals: API key guide (2162–2276), Elvanto disconnect (2278–2327), AI disconnect (2329–2378), PC disconnect (2380–2429).
- Now-unused imports: `MembershipAllowlistEditor`, `PCOCheckinImport`, and any Heroicons/`integrationsAPI`/`aiAPI` references used only by the removed code. **Let the compiler tell you** which imports are now unused, and remove exactly those. Do NOT remove imports still used by other tabs (General/MyInfo/Notifications/Data).

Keep `navigate` import only if still used elsewhere in SettingsPage; otherwise remove it.

- [ ] **Step 4: Verify compile + smoke test**

Run Docker logs command. Expected: no TypeScript errors, no unused-variable errors. Then in the browser:
- Go to Settings → Integrations. The card list renders (Elvanto, AI, Planning Center if enabled), each with correct connected/disconnected state.
- Click a pencil → opens that panel; Back returns to the list.
- Click "Set up" on a disconnected integration → opens the panel with its connect form.
- Click Disconnect on a connected card → opens the panel with the disconnect confirmation modal.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SettingsPage.tsx
git commit -m "refactor(settings): render IntegrationsTab and remove inline integration code"
```

---

## Task 7: Remove the Import page

**Files:**
- Modify: `client/src/components/Layout.tsx` (remove nav item line 151)
- Modify: `client/src/App.tsx` (remove the `/app/import` route + import of `ImportPage`)
- Delete: `client/src/pages/ImportPage.tsx`

- [ ] **Step 1: Remove the Import nav item**

In `client/src/components/Layout.tsx`, delete the admin Import entry (line ~150–152):

```tsx
...(user?.role === 'admin' ? [
  { name: 'Import', href: '/app/import', icon: ArrowDownTrayIcon }
] : []),
```

If `ArrowDownTrayIcon` becomes unused in Layout after this, remove it from the Heroicons import (compiler will confirm).

- [ ] **Step 2: Remove the route**

In `client/src/App.tsx`, delete the `<Route path="import" ... >` block (lines ~200–209) and the `import ImportPage from './pages/ImportPage';` line (line 25).

- [ ] **Step 3: Delete the page**

```bash
git rm client/src/pages/ImportPage.tsx
```

- [ ] **Step 4: Verify no dangling references**

```bash
grep -rn "/app/import\|ImportPage\|source=planning-center" client/src
```

Expected: no matches (the only prior matches were Layout 151, App.tsx import/route, SettingsPage 2023, and ImportPage itself — all now removed/changed). If `PlanningCenterSyncReview.tsx:87` still references `/app/settings?tab=integrations`, that is fine (valid link), leave it.

- [ ] **Step 5: Verify compile + smoke test**

Run Docker logs command. Expected: no TypeScript errors. In the browser:
- The Import item is gone from the sidebar.
- Navigating to `/app/import` directly no longer renders the page (falls through to the app's not-found/redirect behaviour).
- Elvanto import (people + gatherings) works from Settings → Integrations → Elvanto pencil.
- Planning Center: connect status, sync config, Sync now, Review & sync (inline), and check-in import all work from Settings → Integrations → Planning Center pencil.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Layout.tsx client/src/App.tsx
git commit -m "refactor: remove standalone Import page; integration import lives in Settings"
```

---

## Task 8: Full-flow verification

**Files:** none (verification only)

- [ ] **Step 1: Rebuild client fresh and watch logs**

```bash
docker-compose -f docker-compose.dev.yml up -d --build client
docker-compose -f docker-compose.dev.yml logs --tail=120 client
```

Expected: clean compile, no TypeScript or ESLint errors.

- [ ] **Step 2: Manual matrix in the browser (http://localhost:3000, admin user)**

Verify each:
- Integrations card list shows correct status for all three.
- First-connect redirect: connect Elvanto (API key) → lands in Elvanto panel showing import UI. Connect AI → lands in AI panel connected state. Connect Planning Center (OAuth) → returns to `/app/settings?tab=integrations` with the Planning Center panel open.
- Disconnect from a card opens the confirmation modal in-panel; confirming returns the card to "Not Connected".
- Elvanto People & Families import and Gatherings import both function (search, select, import, gathering edit modal).
- Planning Center: sync-indicator toggle, enable-sync toggle, allowlist save, Sync now, Review & sync (inline `PlanningCenterSyncReview` with Apply), and check-in import all function.
- Back button from every panel returns to the card list.
- AI Insights nav item and `/app/ai-insights` page still work (untouched).

- [ ] **Step 3: Final commit (if any verification fixes were needed)**

Commit any small fixes discovered during verification with a descriptive message. If no fixes were needed, this step is a no-op.

---

## Self-review notes

- **Spec coverage:** card list (Task 5) ✓; pencil/Set up → panel (Tasks 1,5) ✓; first-connect redirect (Tasks 5,6) ✓; in-page sub-view, no routes (Task 5) ✓; component decomposition into `integrations/` (Tasks 1–5) ✓; Elvanto import moved (Task 3) ✓; AI cog config (Task 2) ✓; PCO config + inline review (Task 4) ✓; Import page + Historical CSV + check-ins viewer removed (Tasks 3 drops viewer by not porting it, Task 7 removes page) ✓; deep links remain valid (Task 7 Step 4) ✓.
- **Type consistency:** `status`/`refreshStatus`/`onBack`/`initialAction` props are identical across all three panels; `IntegrationKey` union matches `selected` state.
- **Out of scope honoured:** server, `/app/ai-insights`, and Layout `integrationsConfigured` logic are untouched (Task 7 only removes the Import nav line).
