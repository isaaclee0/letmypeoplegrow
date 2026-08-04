# Authoritative-Only Sync Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sync batches operational only for the authoritative provider and replace the duplicate first-batch/source-of-truth reviews with one atomic authoritative review.

**Architecture:** Derive batch operational state from saved configuration, source-review state, and church authority; use it consistently in routes, scheduling, and UI. Extend the existing authority preview/apply pipeline to evaluate all covered target-provider drafts and promote them as a set inside the same transaction that applies people changes and activates authority. Reuse one authority-review controller for settings toggles and the first-batch review route.

**Tech Stack:** Node.js 22, Express 5, SQLite/better-sqlite3, `node:test`, React 19, TypeScript 6, React Router 7, Axios, Vitest, Testing Library, Tailwind CSS.

## Global Constraints

- Complete the one-time provider import plan before this plan; non-authoritative batch review is removed only after a replacement import workflow exists.
- A batch is runnable only when it is enabled, has no pending source review, and its provider equals `people_sync_settings.authority_provider`.
- Prepared/non-authoritative batches may retain source drafts, enabled intent, schedule configuration, links, and history, but cannot run manually or unattended.
- Creating the first batch when authority is `none` produces one authority review; successful apply promotes its source, applies reconciliation, consumes the token, and activates authority in one church-scoped transaction.
- Switching authority reviews the union of every enabled target-provider batch, using each covered draft in preference to its active source, and promotes every covered draft atomically.
- Old-provider batches become operationally inactive by derived state; they are not deleted or rewritten merely because authority changes.
- Both provider connections, credentials, links, batch settings, and audit history survive authority switching and disabling.
- Preview/apply use complete paginated snapshots, fail closed on source/read errors, and reject changed source drafts, enabled batch sets, connection generations, local identities, or authority intent.
- Existing initial source drafts remain non-discardable.
- No new npm dependencies and no unrelated integration refactor.

---

## File structure

**New server unit**

- `server/services/peopleSync/batchOperationalState.js` — one pure source of truth for operational state and runnable assertions.

**Authority pipeline changes**

- `server/services/peopleSync/orchestrator.js` — draft-aware authority batch selection, multi-promotion context, prepared-batch rejection for ordinary reviews.
- `server/services/peopleSync/apply.js` and `batchRepository.js` — atomic promotion of a reviewed draft set.
- Existing authority routes retain their URLs and cancellation/timeout ownership model.

**New client units**

- `client/src/components/peopleSync/AuthorityReviewWorkspace.tsx` — reusable preview/cancel/apply lifecycle extracted from `PeopleSourceControl`.
- `client/src/pages/PeopleSyncAuthorityReviewPage.tsx` — dedicated first-batch authority review route.

**Focused UI changes**

- Integration panels navigate first batches to authority review when authority is `none`, show prepared state under another authority, and retain normal batch review for the active authority.
- `PeopleSourceControl` keeps connection/authority selection and warning copy but delegates review mechanics.

---

### Task 1: Derived batch operational state

**Files:**
- Create: `server/services/peopleSync/batchOperationalState.js`
- Create: `server/services/peopleSync/batchOperationalState.test.js`
- Modify: `server/services/peopleSync/scheduler.js`
- Modify: `server/services/peopleSync/scheduler.test.js`

**Interfaces:**
- Produces: `deriveBatchOperationalState(batch, authorityProvider) -> 'active' | 'prepared' | 'disabled' | 'source_review_required'`.
- Produces: `isBatchRunnable(batch, authorityProvider) -> boolean`.
- Produces: `isBatchReviewable(batch, authorityProvider) -> boolean`; this allows an enabled active-authority batch with an active source or draft to resolve source review while still blocking provider-mismatched prepared batches.
- Produces: `assertBatchRunnable(batch, authorityProvider) -> void`, throwing `{ code: 'SYNC_BATCH_PREPARED', status: 409 }` or existing source-review error codes.
- Produces: `assertBatchReviewable(batch, authorityProvider) -> void`.

- [ ] **Step 1: Write the failing truth-table tests**

```js
const cases = [
  [{ enabled: false, provider: 'elvanto' }, 'elvanto', 'disabled'],
  [{ enabled: true, provider: 'elvanto', needsSourceReview: true }, 'elvanto', 'source_review_required'],
  [{ enabled: true, provider: 'elvanto', needsSourceReview: false }, 'planning_center', 'prepared'],
  [{ enabled: true, provider: 'elvanto', needsSourceReview: false }, 'elvanto', 'active'],
];
```

Add scheduler tests proving prepared/source-review/disabled batches produce no run creation and no provider fetch, while an active due batch keeps current behavior.
Add reviewability tests proving an active-authority initial/replacement draft is reviewable but not runnable, while the identical batch under another/no authority is neither reviewable nor runnable.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/batchOperationalState.test.js services/peopleSync/scheduler.test.js
```

Expected: FAIL because the shared helper does not exist and scheduler does not consume it.

- [ ] **Step 3: Implement the pure helper and scheduler gate**

State precedence is exact:

```js
function deriveBatchOperationalState(batch, authorityProvider) {
  if (batch?.enabled !== true) return 'disabled';
  if (batch?.needsSourceReview === true || !batch?.source) return 'source_review_required';
  if (batch.provider !== authorityProvider) return 'prepared';
  return 'active';
}
```

`isBatchReviewable` requires `batch.enabled === true`, `batch.provider === authorityProvider`, and `batch.source || batch.draftSource`. The scheduler must call `isBatchRunnable` before due-date calculation, run creation, credentials, or adapter access. Retain the existing independent provider scheduling master switch.

- [ ] **Step 4: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/peopleSync/batchOperationalState.js server/services/peopleSync/batchOperationalState.test.js server/services/peopleSync/scheduler.js server/services/peopleSync/scheduler.test.js
git commit -m "feat(sync): derive authoritative batch state"
```

---

### Task 2: Return operational state and reject prepared manual runs

**Files:**
- Modify: `server/routes/integrations/elvanto.js`
- Modify: `server/routes/integrations/elvanto.test.js`
- Modify: `server/routes/integrations/planningCenterPeopleSync.js`
- Modify: `server/routes/integrations/planningCenterPeopleSync.test.js`
- Modify: `server/routes/integrations/sourceBuilder.js`
- Modify: `server/routes/integrations/sourceBuilder.test.js`
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`

**Interfaces:**
- Batch responses add `operationalState`, `reviewable`, and `runnable`.
- Ordinary `buildReview({ batchId })` and per-batch apply require `reviewable`; interactive run-now requires `runnable`.
- Authority preview remains the only review path that may consume prepared target-provider batches.

- [ ] **Step 1: Write failing route/orchestrator tests**

Assert list/create/update DTOs contain:

```js
{
  operationalState: 'prepared',
  reviewable: false,
  runnable: false,
}
```

when another/no authority is active. Assert plan, apply, and run-now reject before startRun/provider fetch. Assert an active-authority batch still reaches ordinary review.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test routes/integrations/elvanto.test.js routes/integrations/planningCenterPeopleSync.test.js routes/integrations/sourceBuilder.test.js services/peopleSync/orchestrator.test.js
```

Expected: FAIL because responses and manual orchestration do not share operational state.

- [ ] **Step 3: Decorate batch DTOs at route boundaries**

Add one helper that receives the already-loaded authority state:

```js
function withOperationalState(batch, authorityProvider) {
  const operationalState = deriveBatchOperationalState(batch, authorityProvider);
  return {
    ...batch,
    operationalState,
    reviewable: isBatchReviewable(batch, authorityProvider),
    runnable: isBatchRunnable(batch, authorityProvider),
  };
}
```

Use it consistently for both providers and source-draft responses. Do not make `batchRepository` depend on authority storage.

- [ ] **Step 4: Gate ordinary orchestration**

After church/provider/batch lookup but before audit/provider work, call `assertBatchReviewable` for `buildReview` and ordinary `applyReviewed(batchId)`. Call `assertBatchRunnable` for run-now and unattended work. Map `SYNC_BATCH_PREPARED` to: “This batch is prepared for a different people source. Switch source of truth before reviewing or running it.”

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/integrations/elvanto.js server/routes/integrations/elvanto.test.js server/routes/integrations/planningCenterPeopleSync.js server/routes/integrations/planningCenterPeopleSync.test.js server/routes/integrations/sourceBuilder.js server/routes/integrations/sourceBuilder.test.js server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js
git commit -m "feat(sync): enforce authoritative batch operations"
```

---

### Task 3: Atomic multi-draft source promotion

**Files:**
- Modify: `server/services/peopleSync/batchRepository.js`
- Modify: `server/services/peopleSync/batchRepository.dbintegration.test.js`
- Modify: `server/services/peopleSync/apply.js`
- Modify: `server/services/peopleSync/apply.test.js`
- Modify: `server/services/peopleSync/apply.dbintegration.test.js`
- Modify: `server/services/peopleImport/orchestrator.js`
- Modify: `server/services/peopleImport/orchestrator.test.js`

**Interfaces:**
- Produces: `promoteSourceDraftsWithConnection(conn, { churchId, provider, promotions })`.
- Changes `applyPeopleSyncPlan` input from singular `sourcePromotion` to `sourcePromotions: SourcePromotion[]`.
- `SourcePromotion`: `{ batchId, expectedBaseRevision, expectedDraftDigest }`.

- [ ] **Step 1: Write failing repository and apply tests**

Cover two successful promotions, stale first/second promotion rolling back both, duplicate batch IDs rejected, cross-church/provider batch rejected, and people/link changes rolled back when any promotion fails.

```js
await assert.rejects(() => applyPeopleSyncPlan({
  ...input,
  sourcePromotions: [validPromotion, stalePromotion],
}), { code: 'SYNC_PLAN_STALE' });
assert.deepEqual((await getBatch(churchId, provider, first.id)).draftSource, firstDraft);
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/batchRepository.dbintegration.test.js services/peopleSync/apply.test.js services/peopleSync/apply.dbintegration.test.js
```

Expected: FAIL because only one promotion is accepted.

- [ ] **Step 3: Implement validated promotion sets**

Normalize and sort promotions by numeric batch ID; reject duplicates and malformed digests before writes. Inside the existing apply transaction, call:

```js
await batchRepository.promoteSourceDraftsWithConnection(conn, {
  churchId,
  provider,
  promotions: sourcePromotions,
});
```

The repository may loop over the existing compare-and-swap function because the outer transaction guarantees rollback, but it must validate the complete set before the first promotion.

- [ ] **Step 4: Update every singular caller**

Change normal per-batch apply to pass either one-element `sourcePromotions` or `[]`. Change one-time import to pass `sourcePromotions: []`. Remove `sourcePromotion` from the public apply signature so a missed caller fails loudly.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/batchRepository.js server/services/peopleSync/batchRepository.dbintegration.test.js server/services/peopleSync/apply.js server/services/peopleSync/apply.test.js server/services/peopleSync/apply.dbintegration.test.js server/services/peopleImport/orchestrator.js server/services/peopleImport/orchestrator.test.js
git commit -m "feat(sync): promote reviewed source drafts atomically"
```

---

### Task 4: Draft-aware authority preview and signed source set

**Files:**
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/planDigest.js`
- Modify: `server/services/peopleSync/planDigest.test.js`
- Modify: `server/services/peopleSync/sourceModel.js`
- Modify: `server/services/peopleSync/sourceModel.test.js`

**Interfaces:**
- Produces: `effectiveAuthorityReviewBatches(batches)` selecting each covered draft in preference to active source.
- Authority plan `sourceContext` adds `promotions: SourcePromotion[]` and a deterministic participating-batch/source digest.
- New sync and authority tokens pass `operationKind: 'people_sync'` or `'authority_switch'` as introduced by the import plan.

- [ ] **Step 1: Write failing authority projection tests**

Cover:

- first batch with `source: null` and `draftSource` previews successfully;
- two initial drafts both fetch and appear in provenance/promotions;
- a replacement draft is used instead of its active source;
- disabled target-provider batches are excluded;
- duplicate/empty/malformed sources fail before authority staging;
- draft reads never update active-source health;
- plan digest changes when any batch ID, enabled state, revision, source identity, or promotion changes.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/orchestrator.test.js services/peopleSync/planDigest.test.js services/peopleSync/sourceModel.test.js
```

Expected: FAIL because authority preview reads active sources only and carries no promotion set.

- [ ] **Step 3: Implement deterministic authority candidates**

```js
function effectiveAuthorityReviewBatches(batches) {
  return batches
    .filter((batch) => batch.enabled)
    .map((batch) => ({
      ...batch,
      effectiveSource: batch.draftSource || batch.source,
      effectiveSourceIsDraft: Boolean(batch.draftSource),
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}
```

Reject any enabled target batch with neither source nor draft. Authority preview must use this set for fetching, eligibility, source expectations, source context, and plan digest.

- [ ] **Step 4: Bind promotions and operation kind**

Build promotions only from `effectiveSourceIsDraft` batches and include the sorted array in `plan.sourceContext`. Pass `operationKind: 'authority_switch'` to token creation/verification. Ordinary batch reviews pass `people_sync`; import remains `people_import`.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/planDigest.js server/services/peopleSync/planDigest.test.js server/services/peopleSync/sourceModel.js server/services/peopleSync/sourceModel.test.js
git commit -m "feat(sync): review authority against prepared drafts"
```

---

### Task 5: Apply the combined authority review atomically

**Files:**
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/orchestrator.dbintegration.test.js`
- Modify: `server/routes/integrations/peopleSync.js`
- Modify: `server/routes/integrations/peopleSync.test.js`

**Interfaces:**
- Existing `previewAuthoritySwitch` and `applyReviewed({ batchId: null })` URLs remain stable.
- Authority apply rebuilds the same draft-aware batch set and passes every signed promotion to `applyPeopleSyncPlan`.

- [ ] **Step 1: Write failing unit and DB integration tests**

Prove one first-batch apply creates/reconciles people, promotes its source, activates authority, and consumes the review token. Prove a two-batch switch promotes both drafts. For stale second draft, changed enabled set, replaced preview ID, connection change, local identity change, and provider membership change, assert zero people/source/authority/token partial commits.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js routes/integrations/peopleSync.test.js
```

Expected: FAIL because authority apply currently passes no source promotions.

- [ ] **Step 3: Rebuild the same authority candidate set at apply**

When `pending_authority_provider === provider`, use `effectiveAuthorityReviewBatches(pre.batches)` instead of the ordinary batch selection. Set:

```js
const sourcePromotions = reviewBatches
  .filter((batch) => batch.effectiveSourceIsDraft)
  .map(toSourcePromotion);
```

The plan's signed `sourceContext.promotions` must exactly equal this fresh set before apply. Pass it into the transaction with the existing authority expectation and exact preview ID.

- [ ] **Step 4: Preserve post-commit semantics**

Once the transaction returns, audit/refresh failures report “authority applied; refresh status” and never mark the run failed or expose the old Apply action. Do not call provider extras until the critical transaction has committed.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/orchestrator.dbintegration.test.js server/routes/integrations/peopleSync.js server/routes/integrations/peopleSync.test.js
git commit -m "feat(sync): combine source promotion and authority apply"
```

---

### Task 6: Client operational-state contract and prepared-batch UI

**Files:**
- Modify: `client/src/components/peopleSync/types.ts`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.test.tsx`
- Modify: `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`
- Modify: `client/src/components/elvanto/ElvantoBatchEditor.tsx`

**Interfaces:**
- `PeopleSyncBatch` adds `operationalState`, `reviewable`, and `runnable`.
- Panels render `Active`, `Prepared for source switch`, `Disabled`, or `Source review required` from the server value.

- [ ] **Step 1: Write failing panel tests**

Assert prepared batches show no **Review & sync** or **Run now**, retain Edit/Delete/source draft controls, and show “Switch source of truth to activate this batch.” Assert active batches preserve current controls. Assert `source_review_required` with `reviewable: true` shows **Review source & sync** but no **Run now**. Assert editor schedule copy says a prepared schedule starts only after authority activation.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
cd client
npm test -- src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/components/planningCenter/PlanningCenterBatchEditor.test.tsx src/components/elvanto/ElvantoBatchEditor.test.tsx
```

Expected: FAIL because the client has no operational-state contract.

- [ ] **Step 3: Add types and state-specific rendering**

```ts
export type BatchOperationalState = 'active' | 'prepared' | 'disabled' | 'source_review_required';
```

Never re-derive permissions client-side. Use `batch.reviewable` for review controls, `batch.runnable` for run controls, and `operationalState` for copy/badges. Keep missing-source freshness/health UI separate.

- [ ] **Step 4: Run focused tests and build**

Run:

```bash
cd client
npm test -- src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/components/planningCenter/PlanningCenterBatchEditor.test.tsx src/components/elvanto/ElvantoBatchEditor.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/peopleSync/types.ts client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx client/src/components/integrations/ElvantoIntegrationPanel.tsx client/src/components/integrations/ElvantoIntegrationPanel.test.tsx client/src/components/planningCenter/PlanningCenterBatchEditor.tsx client/src/components/elvanto/ElvantoBatchEditor.tsx
git commit -m "feat(sync): show prepared authoritative batches"
```

---

### Task 7: Reusable authority review workspace

**Files:**
- Create: `client/src/components/peopleSync/AuthorityReviewWorkspace.tsx`
- Create: `client/src/components/peopleSync/AuthorityReviewWorkspace.test.tsx`
- Modify: `client/src/components/peopleSync/PeopleSourceControl.tsx`
- Modify: `client/src/components/peopleSync/PeopleSourceControl.test.tsx`

**Interfaces:**
- Produces: `AuthorityReviewWorkspace({ provider, autoStart, onApplied, onCancel })`.
- The workspace owns exact preview intent, generation fencing, cancel, refresh, apply, and post-commit refresh state.
- `PeopleSourceControl` owns provider choice, connection/batch prerequisites, warnings, and disable confirmation.

- [ ] **Step 1: Write characterization tests around the current lifecycle**

Move/copy the existing tests for preview replacement, late responses, exact preview cancellation, timeout cleanup, stale apply, double apply, refresh-after-commit, and unmount cancellation to the new workspace test before extraction.

- [ ] **Step 2: Run tests and confirm the new component is absent**

Run:

```bash
cd client
npm test -- src/components/peopleSync/AuthorityReviewWorkspace.test.tsx src/components/peopleSync/PeopleSourceControl.test.tsx
```

Expected: FAIL on the new component tests; existing control tests pass.

- [ ] **Step 3: Extract without changing API calls**

Move the refs/state/effects that own `previewAuthority`, `cancelAuthorityPreview`, and `applyAuthority` into the workspace. Its state union remains explicit:

```ts
type AuthorityReviewState = 'idle' | 'previewing' | 'reviewing' | 'applying' | 'cancelling' | 'refreshing_after_apply' | 'apply_refresh_pending' | 'error';
```

`autoStart` runs preview once per provider/generation. The workspace renders `SyncReview operationKind="authority_switch"` and retains the exact authority preview ID until apply/cancel ownership ends.

- [ ] **Step 4: Make warnings accurate**

PeopleSourceControl confirmation says linked people/families become provider-managed, local lifecycle/edit operations are restricted, target schedules may run, and the other provider remains connected but its batches become inactive. Remove any copy implying disconnection.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/peopleSync/AuthorityReviewWorkspace.tsx client/src/components/peopleSync/AuthorityReviewWorkspace.test.tsx client/src/components/peopleSync/PeopleSourceControl.tsx client/src/components/peopleSync/PeopleSourceControl.test.tsx
git commit -m "refactor(sync): share authority review workspace"
```

---

### Task 8: Dedicated first-batch authority review route

**Files:**
- Create: `client/src/pages/PeopleSyncAuthorityReviewPage.tsx`
- Create: `client/src/pages/PeopleSyncAuthorityReviewPage.test.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.test.tsx`

**Interfaces:**
- Adds route `/app/settings/integrations/:provider/authority-review` for `planning-center` and `elvanto`.
- Consumes `AuthorityReviewWorkspace` with `autoStart` only after warning confirmation.

- [ ] **Step 1: Write failing route and navigation tests**

Cover admin-only access, invalid provider redirect, warning content, Cancel return URL, first preview, apply return, refresh failure, and no duplicate preview under React Strict Mode. Panel tests assert:

```ts
expect(mockNavigate).toHaveBeenCalledWith(
  '/app/settings/integrations/planning-center/authority-review?reason=first-batch'
);
```

only when the saved batch's provider has `authorityProvider === 'none'`. Active-authority creation continues to the existing batch-review route. A different active authority leaves the batch prepared and returns to the panel with switch guidance.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd client
npm test -- src/pages/PeopleSyncAuthorityReviewPage.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx
```

Expected: FAIL because the route and conditional navigation do not exist.

- [ ] **Step 3: Implement the route warning and workspace**

Render the existing app shell. Before auto-start, show one confirmation with **Review and enable source of truth**. After confirmation, render `AuthorityReviewWorkspace`. Cancel before preview navigates back directly; cancel during/after preview waits for exact preview cancellation before navigating.

- [ ] **Step 4: Update panel creation callbacks**

Use the already-loaded `peopleSyncSettings.authorityProvider` rather than refetching after create. Never invoke ordinary batch plan for a first prepared batch. For another authority, show a success notice: “Batch prepared. Switch source of truth to review and activate it.”

- [ ] **Step 5: Run focused tests and build**

Run:

```bash
cd client
npm test -- src/pages/PeopleSyncAuthorityReviewPage.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/PeopleSyncAuthorityReviewPage.tsx client/src/pages/PeopleSyncAuthorityReviewPage.test.tsx client/src/App.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx client/src/components/integrations/ElvantoIntegrationPanel.tsx client/src/components/integrations/ElvantoIntegrationPanel.test.tsx
git commit -m "feat(sync): combine first batch and authority review"
```

---

### Task 9: Provider-switch and disable UX

**Files:**
- Modify: `client/src/components/peopleSync/PeopleSourceControl.tsx`
- Modify: `client/src/components/peopleSync/PeopleSourceControl.test.tsx`
- Modify: `client/src/components/integrations/IntegrationsTab.tsx`
- Modify: `client/src/components/integrations/IntegrationsTab.test.tsx`

**Interfaces:**
- Switching to a provider with enabled prepared batches opens one provider-wide workspace review.
- Disabling authority changes server-derived batch display to prepared after refresh; it never disconnects.

- [ ] **Step 1: Write failing UX tests**

Assert switch warnings mention target prepared batch count, old-provider inactivity, retained connections, editing locks, and schedules. Assert switching is disabled when the target has zero enabled batches or any enabled batch has neither active source nor draft. Assert post-switch refresh renders target active and old prepared. Assert disable renders current batches prepared.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd client
npm test -- src/components/peopleSync/PeopleSourceControl.test.tsx src/components/integrations/IntegrationsTab.test.tsx
```

Expected: FAIL on prepared-batch/switch copy and prerequisites.

- [ ] **Step 3: Implement target-batch prerequisites and copy**

Pass provider batch summaries into `PeopleSourceControl`. Its prerequisite is satisfied only when at least one target batch is enabled and every enabled target batch has `source || draftSource`. It delegates the actual review to the shared workspace and refreshes both settings and provider batch lists after apply/disable.

- [ ] **Step 4: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/peopleSync/PeopleSourceControl.tsx client/src/components/peopleSync/PeopleSourceControl.test.tsx client/src/components/integrations/IntegrationsTab.tsx client/src/components/integrations/IntegrationsTab.test.tsx
git commit -m "feat(sync): clarify prepared provider switching"
```

---

### Task 10: Remove residual non-authoritative batch semantics

**Files:**
- Modify: `server/services/peopleSync/plan.js`
- Modify: `server/services/peopleSync/plan.test.js`
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `client/src/services/api.ts`
- Modify: `client/src/components/peopleSync/batchReviewApi.ts`
- Modify: `client/src/components/peopleSync/batchReviewApi.test.ts`
- Modify: `client/src/pages/PeopleSyncBatchReviewPage.tsx`
- Modify: `client/src/pages/PeopleSyncBatchReviewPage.test.tsx`

**Interfaces:**
- Ordinary sync batch plans are always authoritative.
- One-time additive behavior exists only in `peopleImport` services/routes.

- [ ] **Step 1: Write failing invariant tests**

Assert ordinary batch review rejects whenever provider authority is not active. Assert every successful ordinary batch plan has `authoritative: true`. Assert no client batch review adapter can open/apply a prepared batch and the page displays the server's switch-source guidance for stale bookmarked URLs.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd server
node --test services/peopleSync/plan.test.js services/peopleSync/orchestrator.test.js
cd ../client
npm test -- src/components/peopleSync/batchReviewApi.test.ts src/pages/PeopleSyncBatchReviewPage.test.tsx
```

Expected: FAIL while non-authoritative sync planning remains reachable.

- [ ] **Step 3: Delete the non-authoritative sync branch**

Remove `reviewedReimport`, `create_regular_non_authoritative`, and manual non-authoritative managed-update behavior from sync planning after confirming their only former product use has moved to `peopleImport/plan.js`. Keep active-authority protection and provider switching logic.

- [ ] **Step 4: Make ordinary review stance explicit**

After `assertBatchRunnable`, set:

```js
authoritative: true,
activeAuthority: provider,
```

for ordinary batch review/apply. Do not infer a permissive import stance from trigger names.

- [ ] **Step 5: Run focused tests**

Run the Step 2 commands.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/plan.js server/services/peopleSync/plan.test.js server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js client/src/services/api.ts client/src/components/peopleSync/batchReviewApi.ts client/src/components/peopleSync/batchReviewApi.test.ts client/src/pages/PeopleSyncBatchReviewPage.tsx client/src/pages/PeopleSyncBatchReviewPage.test.tsx
git commit -m "refactor(sync): retire non-authoritative batch review"
```

---

### Task 11: Authoritative batch regression verification

**Files:**
- Modify only files required to correct failures caused by Tasks 1–10; do not broaden scope.

**Interfaces:**
- Verifies combined first-batch authority, provider switching, batch gating, and preservation of import behavior.

- [ ] **Step 1: Run affected server unit suites**

```bash
cd server
node --test \
  services/peopleSync/batchOperationalState.test.js \
  services/peopleSync/scheduler.test.js \
  services/peopleSync/batchRepository.dbintegration.test.js \
  services/peopleSync/plan.test.js \
  services/peopleSync/planDigest.test.js \
  services/peopleSync/sourceModel.test.js \
  services/peopleSync/apply.test.js \
  services/peopleSync/orchestrator.test.js \
  routes/integrations/peopleSync.test.js \
  routes/integrations/elvanto.test.js \
  routes/integrations/planningCenterPeopleSync.test.js \
  routes/integrations/sourceBuilder.test.js
```

Expected: PASS.

- [ ] **Step 2: Run transaction and church-isolation suites**

```bash
cd server
node --test \
  services/peopleSync/apply.dbintegration.test.js \
  services/peopleSync/orchestrator.dbintegration.test.js \
  services/peopleSync/authority.dbintegration.test.js \
  services/peopleSync/sourceHealth.dbintegration.test.js \
  routes/integrations.pcoSyncBatches.dbintegration.test.js \
  services/peopleImport/orchestrator.dbintegration.test.js
```

Expected: PASS; both connections and old-provider batch/link rows survive switching.

- [ ] **Step 3: Run affected client suites and build**

```bash
cd client
npm test -- \
  src/components/peopleSync/AuthorityReviewWorkspace.test.tsx \
  src/components/peopleSync/PeopleSourceControl.test.tsx \
  src/components/peopleSync/batchReviewApi.test.ts \
  src/components/integrations/PlanningCenterIntegrationPanel.test.tsx \
  src/components/integrations/ElvantoIntegrationPanel.test.tsx \
  src/components/integrations/IntegrationsTab.test.tsx \
  src/pages/PeopleSyncAuthorityReviewPage.test.tsx \
  src/pages/PeopleSyncBatchReviewPage.test.tsx \
  src/components/peopleImport \
  src/pages/PeoplePage.import.test.tsx \
  src/pages/OnboardingPage.integrations.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 4: Search for forbidden runtime paths and stale copy**

```bash
rg -n "create_regular_non_authoritative|reviewedReimport" server client
rg -n "disconnect.*other|other.*disconnect" client/src/components/peopleSync client/src/components/integrations
git diff --check HEAD~10..HEAD
```

Expected: no runtime references to retired non-authoritative planning; no copy claims the other provider is disconnected; diff check is clean.
