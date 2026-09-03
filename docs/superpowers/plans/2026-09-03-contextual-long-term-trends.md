# Contextual Long-Term Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate report workspaces and Primary/Other engagement model with contextual long-term attendance direction, regularity tiers, and a compact declining-attendance list driven by the gatherings already selected on Reports.

**Architecture:** Add a selection-scoped engagement calculation path that validates church-owned gathering IDs, loads a fixed completed-week window, derives weekly person opportunities from current assignments, and returns a purpose-built schema. The existing SelectedPeriodReport owns gathering selection and renders a focused LongTermTrends component beneath its date-scoped content; tier settings remain church-scoped but no longer read or write gathering roles.

**Tech Stack:** Node.js 24 test runner, Express 5, better-sqlite3 through the existing Database abstraction, React 19, TypeScript, Axios, Chart.js, Vitest, Testing Library.

## Global Constraints

- Long-term calculations use the latest 52 fully completed weeks; when less valid history exists, use all available completed weeks and expose the actual coverage.
- The selected start and end dates never alter Long-term trends.
- Current selected gathering IDs define the report; multiple selected gatherings are weekly alternatives for person-level calculations.
- Person-level population is active regulars currently assigned to at least one selected standard gathering.
- Standard and headcount gatherings may appear in Attendance direction; only standard gatherings contribute to Regularity and People attending less often.
- Every requested gathering must be validated inside the authenticated church, and every database query must retain church isolation.
- Do not add a destructive schema migration. Existing engagement and pastoral fields may remain unused.
- Keep tier thresholds, labels, and colours configurable; remove gathering roles from the settings contract and UI.
- Do not expose Primary, Other participation, Community, candidate, confirmation, movement-axis, or evidence-counter terminology in the new Reports experience.

---

## File Structure

- `server/services/engagement/contextual.js`: pure weekly calculations plus church-scoped source loading and overview construction.
- `server/services/engagement/contextual.dbintegration.test.js`: selection, assignment, weekly deduplication, short history, mixed gathering, decline, and isolation coverage.
- `server/routes/reports/engagement.js`: accept canonical `gatheringTypeIds` and serve contextual overview/people/session drill-downs.
- `server/routes/reports.engagement.test.js`: HTTP validation, access control, foreign-ID rejection, and fixed-window tests.
- `server/services/engagement/settings.js`: threshold/style-only validation and persistence.
- `server/routes/settings.engagement.test.js`, `server/services/engagement/settings.dbintegration.test.js`: revised settings contract and rules-version behaviour.
- `client/src/services/api.ts`: contextual DTOs and selection-aware API signatures.
- `client/src/services/engagementReportCache.ts`: schema-v4 selection-scoped cache validation.
- `client/src/services/engagementReportCache.test.ts`: canonical key, church/selection isolation, and malformed-cache tests.
- `client/src/components/reports/LongTermTrends.tsx`: composed long-term section.
- `client/src/components/reports/LongTermTrends.test.tsx`: rendering, copy, states, requests, drill-down, and stale response tests.
- `client/src/components/reports/RegularitySettings.tsx`: threshold/style-only administrator dialog body.
- `client/src/components/reports/RegularitySettings.test.tsx`: validation and save contract tests.
- `client/src/components/reports/SelectedPeriodReport.tsx`: pass current gathering selection into LongTermTrends and add gathering-selection help copy.
- `client/src/pages/ReportsPage.tsx`: render only SelectedPeriodReport, without tab state.
- `client/src/components/reports/ReportsPage.test.tsx`: assert the single-page structure and removed terminology.
- Delete retired UI files after integration: `ReportTabs.tsx`, `LongTermHealthReport.tsx`, `LongTermHealthReport.test.tsx`, `PastoralCareReport.tsx`, `PastoralCareReport.test.tsx`, `EngagementMatrix.tsx`, `EngagementMovementPanel.tsx`, and `EngagementMovementPanel.test.tsx`.

---

### Task 1: Make regularity settings independent of gathering roles

**Files:**
- Modify: `server/services/engagement/settings.js`
- Modify: `server/services/engagement/settings.dbintegration.test.js`
- Modify: `server/routes/settings.engagement.test.js`

**Interfaces:**
- Produces: `validateInput(input) -> { coreMinimum, casualMinimum, tiers }`
- Produces: `getEngagementSettings(churchId) -> { coreMinimum, casualMinimum, tiers, calculationRulesVersion }`
- Produces: `updateEngagementSettings(churchId, actorId, input) -> { settings, rulesChanged }`
- Removes from the public contract: `gatheringRoles`, `assignmentPreview`

- [ ] **Step 1: Replace settings tests with the threshold/style-only contract**

Add route assertions equivalent to:

```js
const payload = {
  coreMinimum: 60,
  casualMinimum: 20,
  tiers: {
    core: { label: 'Regular', colour: '#16A34A' },
    casual: { label: 'Occasional', colour: '#D97706' },
    irregular: { label: 'Infrequent', colour: '#DC2626' },
  },
};
const response = await request.put('/engagement').send(payload);
assert.equal(response.status, 200);
assert.equal('gatheringRoles' in response.body.settings, false);
assert.equal('assignmentPreview' in response.body.settings, false);
```

Retain tests for integer thresholds, `0 <= casual < core <= 100`, non-empty labels, valid CSS hex colours, admin-only writes, and church isolation. Add a database test proving a settings update does not modify `gathering_types.engagement_role`.

- [ ] **Step 2: Run the settings tests and verify the old contract fails**

Run:

```bash
cd server
node --test services/engagement/settings.dbintegration.test.js routes/settings.engagement.test.js
```

Expected: FAIL because `gatheringRoles` is currently required and returned.

- [ ] **Step 3: Remove role validation, role loading, assignment previews, and gathering updates**

Change `validateInput` to destructure only `coreMinimum`, `casualMinimum`, and `tiers`. In `getEngagementSettings`, load only the settings row. In `updateEngagementSettings`, compare only thresholds when deciding whether to advance `calculationRulesVersion`; label/colour-only edits must not advance it.

Use this return shape:

```js
return {
  coreMinimum: row?.coreMinimum ?? DEFAULT_ENGAGEMENT_SETTINGS.coreMinimum,
  casualMinimum: row?.casualMinimum ?? DEFAULT_ENGAGEMENT_SETTINGS.casualMinimum,
  tiers: row ? persistedTiers(row) : cloneDefaultTiers(),
  calculationRulesVersion: row?.calculationRulesVersion ?? 1,
};
```

Do not delete the `engagement_role` column or rewrite existing values.

- [ ] **Step 4: Run the focused settings tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the settings contract**

```bash
git add server/services/engagement/settings.js server/services/engagement/settings.dbintegration.test.js server/routes/settings.engagement.test.js
git commit -m "refactor: decouple regularity settings from gatherings"
```

---

### Task 2: Build the contextual long-term calculation service

**Files:**
- Create: `server/services/engagement/contextual.js`
- Create: `server/services/engagement/contextual.dbintegration.test.js`
- Reuse: `server/services/engagement/tiers.js`
- Reuse: `server/services/engagement/drilldownTokens.js`
- Reuse: `server/utils/churchTime.js`

**Interfaces:**
- Produces: `canonicalGatheringIds(values) -> number[]`, sorted, unique positive integers
- Produces: `getContextualWindow(asOf, timeZone) -> { completedWeekEnd, startDate, endDate, maximumWeeks: 52 }`
- Produces: `buildContextualLongTermOverview(churchId, gatheringTypeIds, options?) -> Promise<ContextualLongTermOverview>`
- Produces: `listContextualPeople(churchId, options) -> Promise<{ rows, nextCursor }>`
- Produces: `listContextualSessions(churchId, options) -> Promise<{ rows, nextCursor }>`
- Consumes: threshold/style-only `getEngagementSettings(churchId)` from Task 1

- [ ] **Step 1: Write database integration tests for contextual selection and isolation**

Seed two churches, weekly AM/PM standard gatherings, a monthly youth gathering, and a headcount gathering. Cover these exact facts:

```js
const overview = await buildContextualLongTermOverview(churchId, [pmId, amId, amId], {
  asOf: new Date('2026-09-02T02:00:00Z'),
});
assert.deepEqual(overview.gatheringTypeIds, [amId, pmId]);
assert.equal(overview.window.completedWeekEnd, '2026-08-30');
assert.equal(overview.regularity.population, 2); // assigned active regulars only
assert.deepEqual(rowFor(overview, personId).evidence, {
  attendedWeeks: 1,
  opportunityWeeks: 1,
}); // AM + PM attendance in one week is deduplicated
```

Also prove:

- a week with no held selected session creates no opportunity;
- only currently assigned active regulars enter the population;
- selecting Youth alone creates Youth tiers;
- mixed standard/headcount selection returns both trend series but only standard person evidence;
- headcount-only selection returns `regularity: null` and `declines: null`;
- a foreign-church gathering ID throws an error with code `INVALID_REPORT_GATHERING` before report data is returned;
- 31 available completed weeks report `availableWeeks: 31`, while older data is capped at 52 completed weeks;
- unreliable unknown-roster weeks are excluded from person evidence and increase `excludedWeeks`.

- [ ] **Step 2: Run the new service test and verify it fails**

```bash
cd server
node --test services/engagement/contextual.dbintegration.test.js
```

Expected: FAIL because `contextual.js` does not exist.

- [ ] **Step 3: Implement canonical selection, fixed window, and source loading**

In `contextual.js`, validate IDs before loading attendance:

```js
function canonicalGatheringIds(values) {
  if (!Array.isArray(values) || values.length === 0) throw invalidGatheringSelection();
  const ids = [...new Set(values.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw invalidGatheringSelection();
  return ids.sort((a, b) => a - b);
}
```

Query selected gatherings with both `id IN (...)` and `church_id = ?`, then compare the returned ID set with the request. Load only the bounded 52-week interval and retain `church_id` predicates on individuals, gathering lists, sessions, attendance records, and headcounts.

- [ ] **Step 4: Implement weekly opportunities and regularity**

Construct the population from the union of current `gathering_lists` assignments for selected active standard gatherings. Group reliable held sessions by Monday-started week. For every opportunity week and every population member, use reliable roster evidence when present and mark the week attended when any selected standard session has `present = 1`.

Return this distribution shape:

```js
regularity: {
  population: 42,
  tiers: [
    { tier: 'core', label: 'Core', colour: '#16A34A', count: 20, rate: 47.6, peopleToken: '...' },
    { tier: 'casual', label: 'Casual', colour: '#D97706', count: 15, rate: 35.7, peopleToken: '...' },
    { tier: 'irregular', label: 'Irregular', colour: '#DC2626', count: 7, rate: 16.7, peopleToken: '...' },
  ],
}
```

Do not emit Establishing or Not assigned tiers. Classify every population member from the valid evidence available; when a person has zero reliable opportunity weeks, omit them from the classified denominator and expose `unclassifiedBecauseNoEvidence` in data-availability metadata.

- [ ] **Step 5: Implement attendance direction and plain comparison**

Build 13 chronological four-week buckets for each selected gathering. Standard totals count present records; headcount totals use the existing aggregation semantics. Return one series per gathering with `gatheringTypeId`, `name`, `attendanceType`, bucket averages, and session tokens.

Compare the latest 12 completed weeks with the preceding 12 completed weeks:

```js
direction: {
  comparisonWeeks: 12,
  previousAverage: 121.4,
  recentAverage: 113.0,
  percentChange: -6.9,
  status: 'down', // 'up' | 'down' | 'steady' | 'unavailable'
}
```

Treat absolute changes below 1% as `steady`; use `unavailable` when either comparison period has no held session.

- [ ] **Step 6: Implement conservative contextual decline results**

Use the final eight valid opportunity weeks as the recent period and earlier valid opportunity weeks inside the 52-week window as baseline. Include a person only when:

- baseline has at least eight opportunity weeks;
- recent evidence has at least four opportunity weeks;
- the recent tier is lower than the baseline tier; and
- the rate fell by at least 20 percentage points.

Sort by tier drop descending, percentage-point drop descending, surname, given name, then ID. Return at most 10 preview rows plus `total` and a signed selection-scoped `peopleToken`. Each row contains:

```js
{
  individualId,
  firstName,
  lastName,
  baseline: { attendedWeeks, opportunityWeeks, rate },
  recent: { attendedWeeks, opportunityWeeks, rate },
  summary: 'Usually attends 3 weeks in 4; attended 1 of the last 6 weeks.',
}
```

- [ ] **Step 7: Bind drill-down tokens to church, selection, completed week, and selector**

Tokens must include sorted gathering IDs and expire using the existing token lifetime. Reject replay with another church, selection, completed week, or selector. `listContextualPeople` supports tier and decline selectors; `listContextualSessions` supports a gathering-series selector. Preserve cursor pagination and a maximum page size of 100.

- [ ] **Step 8: Run the contextual service tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 9: Commit the contextual service**

```bash
git add server/services/engagement/contextual.js server/services/engagement/contextual.dbintegration.test.js
git commit -m "feat: calculate contextual long-term trends"
```

---

### Task 3: Expose selection-scoped report endpoints

**Files:**
- Modify: `server/routes/reports/engagement.js`
- Modify: `server/routes/reports.engagement.test.js`

**Interfaces:**
- Consumes: Task 2 contextual service functions
- Produces: `GET /api/reports/engagement/overview?gatheringTypeIds=1,2`
- Produces: existing `/people` and `/sessions` paths with contextual signed tokens

- [ ] **Step 1: Write failing route tests**

Update the test request helper to support the new query. Assert:

```js
const response = await app.request(`/overview?gatheringTypeIds=${amId},${pmId}`);
assert.equal(response.status, 200);
assert.deepEqual(response.body.gatheringTypeIds, [amId, pmId]);
assert.equal(response.body.schemaVersion, 4);
```

Add 400 cases for missing, empty, non-integer, and duplicate-free-but-unknown IDs; expect code `INVALID_REPORT_GATHERING`. Retain 400 responses for `startDate`, `endDate`, and `asOf`, and the admin/coordinator access test.

- [ ] **Step 2: Run the route test and verify it fails**

```bash
cd server
node --test routes/reports.engagement.test.js
```

Expected: FAIL because overview currently rejects every query parameter.

- [ ] **Step 3: Wire the contextual service and error mapping**

Parse the single comma-delimited query parameter without accepting alternative spellings:

```js
const ids = typeof req.query.gatheringTypeIds === 'string'
  ? req.query.gatheringTypeIds.split(',')
  : [];
return res.json(await buildContextualLongTermOverview(req.user.church_id, ids));
```

Allow only `gatheringTypeIds` on overview. Map `INVALID_REPORT_GATHERING` to status 400 and a user-safe message. Leave fixed-window date filters unsupported.

- [ ] **Step 4: Run route and service tests**

```bash
cd server
node --test routes/reports.engagement.test.js services/engagement/contextual.dbintegration.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the report API**

```bash
git add server/routes/reports/engagement.js server/routes/reports.engagement.test.js
git commit -m "feat: scope long-term reports to selected gatherings"
```

---

### Task 4: Add the contextual client contract and cache

**Files:**
- Modify: `client/src/services/api.ts`
- Modify: `client/src/services/engagementReportCache.ts`
- Modify: `client/src/services/engagementReportCache.test.ts`

**Interfaces:**
- Produces: `ContextualLongTermOverviewDto` matching schema version 4 from Tasks 2–3
- Produces: `reportsAPI.getLongTermTrends(gatheringTypeIds: number[])`
- Produces: `readLongTermTrendsCache(churchId, gatheringTypeIds)`
- Produces: `writeLongTermTrendsCache(overview)`
- Produces: `clearLongTermTrendsCache(churchId, gatheringTypeIds?)`

- [ ] **Step 1: Write failing cache tests**

Prove sorted selections share a key and different selections/churches do not:

```ts
writeLongTermTrendsCache(overview({ churchId: 'church-a', gatheringTypeIds: [2, 1] }));
expect(readLongTermTrendsCache('church-a', [1, 2])).not.toBeNull();
expect(readLongTermTrendsCache('church-a', [1])).toBeNull();
expect(readLongTermTrendsCache('church-b', [1, 2])).toBeNull();
```

Add malformed tests for mismatched selection, invalid canonical dates, wrong schema version, invalid direction status, invalid tier token, malformed decline evidence, and mixed/headcount availability metadata.

- [ ] **Step 2: Run the cache test and verify it fails**

```bash
cd client
npm test -- --run src/services/engagementReportCache.test.ts
```

Expected: FAIL because the contextual cache API does not exist.

- [ ] **Step 3: Define schema-v4 DTOs and API requests**

Replace role-oriented public overview types with focused types. Encode IDs canonically:

```ts
getLongTermTrends: (gatheringTypeIds: number[]) => api.get<ContextualLongTermOverviewDto>(
  '/reports/engagement/overview',
  { params: { gatheringTypeIds: [...new Set(gatheringTypeIds)].sort((a, b) => a - b).join(',') } },
),
```

Change `EngagementSettingsInput` and `EngagementSettingsDto` to omit gathering roles and assignment previews. Keep the generic drill-down page types that remain useful.

- [ ] **Step 4: Implement strict selection-scoped cache validation**

Use a new prefix such as `long-term-trends:v4:<church>:<ids>:<completedWeekEnd>`. Validate every field read by the UI rather than accepting partial objects. Retain a small per-church entry cap and delete only matching entries when clearing a selection.

- [ ] **Step 5: Run API/cache tests and TypeScript build**

```bash
cd client
npm test -- --run src/services/engagementReportCache.test.ts
npm run build
```

Expected: cache tests PASS; the build may still identify old UI consumers that Tasks 5–6 will replace. Record those consumer paths and do not weaken the new types to accommodate retired fields.

- [ ] **Step 6: Commit the client contract**

```bash
git add client/src/services/api.ts client/src/services/engagementReportCache.ts client/src/services/engagementReportCache.test.ts
git commit -m "refactor: add contextual long-term report contract"
```

---

### Task 5: Build the Long-term trends interface

**Files:**
- Create: `client/src/components/reports/LongTermTrends.tsx`
- Create: `client/src/components/reports/LongTermTrends.test.tsx`
- Create: `client/src/components/reports/RegularitySettings.tsx`
- Create: `client/src/components/reports/RegularitySettings.test.tsx`
- Modify: `client/src/components/reports/EngagementPeoplePanel.tsx`
- Modify: `client/src/components/reports/EngagementDrilldown.tsx`

**Interfaces:**
- Consumes: `churchId: string`, `selectedGatherings: GatheringType[]`, `canConfigure: boolean`
- Consumes: Task 4 API/cache functions
- Produces: `<LongTermTrends churchId selectedGatherings canConfigure />`
- Produces: `<RegularitySettings settings onSaved />`

- [ ] **Step 1: Write LongTermTrends rendering and request tests**

Mock Chart.js as existing report tests do. Cover:

- no selection: no request and an explanatory empty state;
- sorted selected IDs passed to `getLongTermTrends`;
- gathering changes ignore stale prior responses;
- fixed-window copy and shorter-history copy;
- multiple-standard copy: “Attendance at any selected gathering counts once per week.”;
- headcount-only and mixed-selection messages;
- direction summary for up/down/steady/unavailable;
- labelled tier counts and visible tier people panel;
- at most 10 decline preview rows, plain evidence, and View all;
- matching cached data during refresh and saved-data warning after refresh failure;
- local retry state when no cache exists;
- settings action visible only to administrators.

- [ ] **Step 2: Run the component test and verify it fails**

```bash
cd client
npm test -- --run src/components/reports/LongTermTrends.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the composed section and request lifecycle**

Use three semantic regions under one long-term heading. Keep the component focused by extracting small render helpers inside the same file only when they do not need independent state. The request effect must bind both church and canonical selection:

```ts
const selectionKey = useMemo(
  () => selectedGatherings.map(({ id }) => id).sort((a, b) => a - b).join(','),
  [selectedGatherings],
);
```

Increment a request generation on church or selection changes and ignore late responses. Display cached data only when its `churchId` and `gatheringTypeIds` match.

- [ ] **Step 4: Implement visible drill-down behaviour**

Adapt `EngagementPeoplePanel` so tier and decline tokens display contextual columns (`Name`, `Attendance`, optional `Recent change`) without Primary/Other columns. Adapt the session drill-down heading to selected gathering names. Ensure opening the panel scrolls/focuses its heading and closing restores focus to the trigger.

- [ ] **Step 5: Write failing RegularitySettings tests**

Assert the form renders threshold, label, and colour inputs only; contains no gathering roles; performs client validation; and calls:

```ts
settingsAPI.updateEngagementSettings({ coreMinimum, casualMinimum, tiers });
```

- [ ] **Step 6: Implement RegularitySettings**

Reuse the useful tier field markup from `EngagementSettings.tsx`, change the heading to **Regularity settings**, remove gathering-role state and copy, and preserve save/error/disabled behaviour. Keep exact percentage explanations rather than monthly attendance approximations, since selected gatherings can have any cadence.

- [ ] **Step 7: Run the focused UI tests**

```bash
cd client
npm test -- --run src/components/reports/LongTermTrends.test.tsx src/components/reports/RegularitySettings.test.tsx src/components/reports/EngagementDrilldown.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit the long-term interface**

```bash
git add client/src/components/reports/LongTermTrends.tsx client/src/components/reports/LongTermTrends.test.tsx client/src/components/reports/RegularitySettings.tsx client/src/components/reports/RegularitySettings.test.tsx client/src/components/reports/EngagementPeoplePanel.tsx client/src/components/reports/EngagementDrilldown.tsx client/src/components/reports/EngagementDrilldown.test.tsx
git commit -m "feat: add contextual long-term trends section"
```

---

### Task 6: Integrate trends into Reports and retire the extra workspaces

**Files:**
- Modify: `client/src/components/reports/SelectedPeriodReport.tsx`
- Modify: `client/src/pages/ReportsPage.tsx`
- Modify: `client/src/components/reports/ReportsPage.test.tsx`
- Delete: `client/src/components/reports/ReportTabs.tsx`
- Delete: `client/src/components/reports/LongTermHealthReport.tsx`
- Delete: `client/src/components/reports/LongTermHealthReport.test.tsx`
- Delete: `client/src/components/reports/PastoralCareReport.tsx`
- Delete: `client/src/components/reports/PastoralCareReport.test.tsx`
- Delete: `client/src/components/reports/EngagementMatrix.tsx`
- Delete: `client/src/components/reports/EngagementMovementPanel.tsx`
- Delete: `client/src/components/reports/EngagementMovementPanel.test.tsx`
- Delete or reduce if unreferenced: `client/src/components/reports/EngagementSettings.tsx`, `client/src/components/reports/EngagementSettings.test.tsx`, `client/src/components/reports/EngagementEvidence.tsx`, `client/src/components/reports/EngagementTierBadge.tsx`, `client/src/components/reports/CaregiverPicker.tsx`

**Interfaces:**
- Consumes: `LongTermTrends` from Task 5
- Produces: one Reports page with shared `selectedGatherings`

- [ ] **Step 1: Rewrite ReportsPage tests around the single-page experience**

Assert there is no tablist and no Long-term health or Pastoral care tab. Assert the selected-period controls render immediately. Mock LongTermTrends and verify the selected gathering IDs flow into it after toggling gathering checkboxes.

Add a terminology assertion over the rendered page:

```ts
expect(screen.queryByText(/Primary|Other participation|Pastoral casebook/i)).not.toBeInTheDocument();
expect(screen.getByRole('heading', { name: 'Long-term trends' })).toBeInTheDocument();
```

- [ ] **Step 2: Run the report-page test and verify it fails**

```bash
cd client
npm test -- --run src/components/reports/ReportsPage.test.tsx
```

Expected: FAIL because the workspace tabs still render.

- [ ] **Step 3: Render LongTermTrends from SelectedPeriodReport**

Pass the existing `selectedGatherings` state and authenticated church/role context into the component below all date-scoped report content. Add this helper copy beneath **Gathering Types**:

> Choose the gathering you want to report on. If you choose more than one, attendance at any selected gathering counts as attendance for that week in Long-term trends.

Do not move selection state to a new global context; the owning component already has the correct state and preferences lifecycle.

- [ ] **Step 4: Simplify ReportsPage and delete retired UI modules**

Remove `activeTab`, `ReportTabs`, `LongTermHealthReport`, and `PastoralCareReport`. Render only the page heading and `SelectedPeriodReport`. Delete the retired modules listed above after using `rg` to prove they have no remaining imports.

Do not remove server pastoral tables, scheduled transition processing, or email workflows in this task; those may have consumers outside the removed Reports tab and require a separate data-retention design.

- [ ] **Step 5: Run focused reports tests and build**

```bash
cd client
npm test -- --run src/components/reports/ReportsPage.test.tsx src/components/reports/LongTermTrends.test.tsx src/components/reports/RegularitySettings.test.tsx
npm run build
```

Expected: PASS and successful Vite/PWA build. `ReportsPage.test.tsx` provides integration coverage because this repository has no separate `SelectedPeriodReport.test.tsx`.

- [ ] **Step 6: Commit the integrated Reports page**

```bash
git add client/src/pages/ReportsPage.tsx client/src/components/reports
git commit -m "refactor: integrate long-term trends into reports"
```

---

### Task 7: Remove obsolete client contracts and verify the end-to-end slice

**Files:**
- Modify: `client/src/services/api.ts`
- Modify: `client/src/services/engagementReportCache.ts`
- Modify: `client/src/services/engagementReportCache.test.ts`
- Modify: `client/src/components/reports/ReportsPage.test.tsx`
- Modify: `client/src/components/reports/LongTermTrends.test.tsx`

**Interfaces:**
- Removes unused client `Pastoral*`, role, matrix, movement, establishing, and not-assigned types/functions
- Preserves server-side pastoral storage and background workflows unless separately authorized
- Leaves `server/routes/reports.js` and the pastoral HTTP endpoints mounted because server-side workflows are intentionally deferred

- [ ] **Step 1: Prove obsolete client symbols have no consumers**

```bash
rg -n "ReportTabs|LongTermHealthReport|PastoralCareReport|EngagementMatrix|EngagementMovementPanel|getPastoralInsights|applyPastoralInsightAction|EngagementGatheringRole|primaryDistribution|tierMovement" client/src
```

Expected: only obsolete type/cache definitions or tests remain. Investigate every runtime hit before deletion.

- [ ] **Step 2: Delete dead client API types, methods, cache validators, and tests**

Remove the old schema-v3 overview and pastoral client cache/API surface once no current UI imports it. Keep generic types shared by the contextual drill-downs. Do not weaken schema-v4 cache validation to simplify cleanup.

- [ ] **Step 3: Run the complete relevant verification set**

```bash
cd server
node --test services/engagement/contextual.dbintegration.test.js services/engagement/settings.dbintegration.test.js routes/reports.engagement.test.js routes/settings.engagement.test.js
cd ../client
npm test -- --run src/services/engagementReportCache.test.ts src/components/reports
npm run build
```

Expected: all tests PASS and build succeeds.

- [ ] **Step 4: Verify terminology and destructive-scope boundaries**

```bash
rg -n "Primary|Other participation|Pastoral casebook|Long-term health" client/src/pages/ReportsPage.tsx client/src/components/reports
git diff --check
git status --short
```

Expected: no obsolete user-facing report terminology; no whitespace errors; only planned files plus pre-existing unrelated changes are present. Confirm there are no schema deletions and no cross-church queries lacking `church_id` filters.

- [ ] **Step 5: Perform a browser smoke test**

With the development stack running, visit Reports and verify:

1. No workspace tabs appear.
2. Changing dates updates the period report but does not change the Long-term trends window.
3. Selecting one standard gathering shows its direction, tiers, and declining people.
4. Selecting two standard gatherings shows the weekly-alternative explanation and refreshes all long-term data.
5. Selecting only a headcount gathering hides person-level results with explanatory copy.
6. Tier and decline drill-downs visibly open and close with keyboard focus restored.
7. Regularity settings contain no gathering-role controls.

- [ ] **Step 6: Commit final cleanup**

```bash
git add client/src/services/api.ts client/src/services/engagementReportCache.ts client/src/components/reports client/src/pages/ReportsPage.tsx
git commit -m "chore: remove retired engagement report client code"
```

---

## Deferred Work

- Destructive removal of engagement-role columns, pastoral tables, transition history, or obsolete server services.
- Redesigning case assignment, snoozing, dismissal, and resolution as a dedicated Follow-up area.
- Removing background pastoral/email consumers before their independent product and data-retention implications are reviewed.
