# PCO Sync Batches — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single global PCO filter UI with a list of named, saved sync batches (each editable/runnable/deletable independently, with its own people-type default, optional gathering, and schedule), plus a separate reconciliation UI for detecting people no longer found in PCO at all.

**Architecture:** `PlanningCenterIntegrationPanel` now renders a master enable toggle, a list of saved batches (Edit / Run now / Review & sync / Delete per row), a "New batch" button, and a reconciliation card. A new `PlanningCenterBatchEditor` form (reusing the existing `MembershipAllowlistEditor`/`FieldFilterEditor`) creates/edits one batch, including an inline "pick existing gathering or create a new one" control (no such reusable control exists yet — built fresh, modeled on `gatheringsAPI`). `PlanningCenterSyncReview` is narrowed to a single batch (drops the `archiveExtras`/`unmatchedVisitors` sections, which move to a new small `PlanningCenterReconciliationReview` component). `OnboardingPage`'s `pco-people` step is rebuilt around `PlanningCenterBatchEditor`; `pco-gatherings` (PCO check-in import) is untouched.

**Tech Stack:** React 19, TypeScript, Tailwind CSS. No client test harness exists for these components (per prior PCO specs) — verification is manual, via the running dev server.

**Spec:** [docs/superpowers/specs/2026-07-03-pco-sync-batches-design.md](../specs/2026-07-03-pco-sync-batches-design.md)
**Depends on:** [docs/superpowers/plans/2026-07-03-pco-sync-batches-backend.md](2026-07-03-pco-sync-batches-backend.md) (routes must exist first)

**Conventions for this plan:**
- Client verification is manual in the browser against the dev stack (`docker-compose -f docker-compose.dev.yml up -d`), not an automated test run — matches the existing gap noted in prior PCO specs ("no existing test harness for that panel").
- Commit after every task.

---

## File Structure

- Modify `client/src/services/api.ts` — remove the single-filter/sync-plan/sync-apply methods; add batch CRUD/plan/apply + reconciliation methods and a `SyncBatch`/`SyncBatchInput` type; adjust `settingsAPI.getIntegrationSettings`/`updateIntegrationSettings` for the master switch + reconciliation schedule fields.
- Modify `client/src/components/planningCenter/syncSelections.ts` — drop `skipArchiveExtraIds` from `SyncSelections`/`buildSelections`; add `ReconciliationSelections`/`buildReconciliationSelections`.
- Modify `client/src/components/planningCenter/PlanningCenterSyncReview.tsx` — take a `batchId` prop; call batch-scoped endpoints; remove the `archiveExtras`/`unmatchedVisitors` sections and `skipArchiveExtras` state.
- Create `client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx` — small review UI for `archiveExtras` (with skip checkboxes) + `unmatchedVisitors` (informational), backed by the reconciliation endpoints.
- Create `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx` — name, membership/field filter editors (reused), default people-type select, gathering picker (existing dropdown + inline "create new"), schedule frequency/day picker.
- Modify `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx` — master toggle, batch list, "New batch" button, reconciliation card; removes the old single-filter form.
- Modify `client/src/pages/OnboardingPage.tsx` — `pco-people` step renders `PlanningCenterBatchEditor` and auto-applies the created batch; `pco-gatherings` step and `finishOnboarding` unchanged.

---

## Task 1: `api.ts` — batch + reconciliation API methods

**Files:**
- Modify: `client/src/services/api.ts`

- [ ] **Step 1: Add the `SyncBatch`/`SyncBatchInput` types**

Above `export const integrationsAPI = {` in `client/src/services/api.ts`, add:
```typescript
export interface SyncBatchInput {
  name: string;
  membershipFilterEnabled: boolean;
  membershipAllowlist: string[];
  fieldFilterEnabled: boolean;
  fieldFilters: { fieldDefinitionId: string; tabName: string | null; fieldName: string; values: string[] }[];
  defaultPeopleType: 'regular' | 'local_visitor' | 'traveller_visitor';
  gatheringTypeId: number | null;
  scheduleEnabled: boolean;
  scheduleFrequency: 'daily' | 'weekly' | 'monthly';
  scheduleDay: number;
}

export interface SyncBatchLastResult {
  at: string;
  added: number;
  updated: number;
  archived: number;
  reactivated: number;
  linked: number;
  ambiguous: number;
  visitorMatches: number;
  errors: number;
}

export interface SyncBatch extends SyncBatchInput {
  id: number;
  lastSyncAt: string | null;
  lastSyncResult: SyncBatchLastResult | null;
}
```

- [ ] **Step 2: Remove the single-filter/sync-plan/sync-apply methods**

In `integrationsAPI`, remove:
```typescript
  getPlanningCenterSyncFilter: () =>
    api.get('/integrations/planning-center/sync-filter'),
  savePlanningCenterSyncFilter: (data: {
    enabled: boolean;
    membershipFilterEnabled: boolean;
    membershipAllowlist: string[];
    fieldFilterEnabled: boolean;
    fieldFilters: { fieldDefinitionId: string; tabName: string | null; fieldName: string; values: string[] }[];
  }) => api.put('/integrations/planning-center/sync-filter', data),
  getPlanningCenterSyncPlan: (opts?: { force?: boolean }) =>
    api.get('/integrations/planning-center/sync/plan', {
      params: opts?.force ? { refresh: 1 } : undefined,
      timeout: 120000,
    }),
  applyPlanningCenterSync: (data: { selections?: { ambiguous?: Record<string, string>; skipAddPcoIds?: string[] } }) =>
    api.post('/integrations/planning-center/sync/apply', data, { timeout: 120000 }),
```

- [ ] **Step 3: Add the batch CRUD/plan/apply + reconciliation methods**

In the gap left by Step 2 (still within `integrationsAPI`, right after `getPlanningCenterFieldSummary`), add:
```typescript
  getPlanningCenterSyncBatches: () =>
    api.get('/integrations/planning-center/sync-batches'),
  createPlanningCenterSyncBatch: (data: SyncBatchInput) =>
    api.post('/integrations/planning-center/sync-batches', data),
  updatePlanningCenterSyncBatch: (id: number, data: SyncBatchInput) =>
    api.put(`/integrations/planning-center/sync-batches/${id}`, data),
  deletePlanningCenterSyncBatch: (id: number) =>
    api.delete(`/integrations/planning-center/sync-batches/${id}`),
  getPlanningCenterBatchPlan: (id: number, opts?: { force?: boolean }) =>
    api.get(`/integrations/planning-center/sync-batches/${id}/plan`, {
      params: opts?.force ? { refresh: 1 } : undefined,
      timeout: 120000,
    }),
  applyPlanningCenterBatch: (id: number, data: { selections?: { ambiguous?: Record<string, string>; skipAddPcoIds?: string[]; visitorChoices?: Record<string, string> } }) =>
    api.post(`/integrations/planning-center/sync-batches/${id}/apply`, data, { timeout: 120000 }),
  getPlanningCenterReconciliationPlan: (opts?: { force?: boolean }) =>
    api.get('/integrations/planning-center/reconciliation/plan', {
      params: opts?.force ? { refresh: 1 } : undefined,
      timeout: 120000,
    }),
  applyPlanningCenterReconciliation: (data: { selections?: { skipArchiveExtraIds?: number[] } }) =>
    api.post('/integrations/planning-center/reconciliation/apply', data, { timeout: 120000 }),
```

- [ ] **Step 4: Update `settingsAPI` for the master switch + reconciliation schedule**

Replace:
```typescript
  updateIntegrationSettings: (data: {
    planningCenterSyncIndicator?: boolean;
    planningCenterAutoArchive?: boolean;
    planningCenterSyncFrequency?: 'daily' | 'weekly' | 'monthly';
    planningCenterSyncDay?: number;
  }) => api.put('/settings/integrations', data),
```
with:
```typescript
  updateIntegrationSettings: (data: {
    planningCenterSyncIndicator?: boolean;
    planningCenterAutoArchive?: boolean;
    planningCenterSyncEnabled?: boolean;
    planningCenterReconciliationScheduleEnabled?: boolean;
    planningCenterReconciliationFrequency?: 'daily' | 'weekly' | 'monthly';
    planningCenterReconciliationDay?: number;
  }) => api.put('/settings/integrations', data),
```
(`getIntegrationSettings` itself is untouched — it returns loosely-typed data, same as before; callers read `r.data.planningCenterSyncEnabled` etc. directly.)

- [ ] **Step 5: Verify the client still builds**

```
docker-compose -f docker-compose.dev.yml exec -T client npm run build
```
Expected: build succeeds (no TypeScript errors). This will actually fail at this point in the plan because `PlanningCenterIntegrationPanel.tsx`, `PlanningCenterSyncReview.tsx`, and `OnboardingPage.tsx` still reference the removed methods — that's expected; Tasks 3-7 fix each caller. Confirm the *specific* errors are only in those three files (no unrelated breakage), then proceed.

- [ ] **Step 6: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat(pco): add sync batch + reconciliation API client methods"
```

---

## Task 2: `syncSelections.ts` — drop archive-extras from batch selections; add reconciliation selections

**Files:**
- Modify: `client/src/components/planningCenter/syncSelections.ts`

- [ ] **Step 1: Replace the file contents**

Replace the full contents of `client/src/components/planningCenter/syncSelections.ts` with:
```typescript
// Shapes shared by the sync review UI.
export type VisitorChoice = 'promote' | 'keep';

export interface SyncSelections {
  ambiguous: Record<string, string>;
  skipAddPcoIds: string[];
  visitorChoices: Record<string, VisitorChoice>;
}

// ambiguousChoices: individualId -> chosen pcoId (or null when the reviewer skipped).
// skipAddPcoIds: set of add-bucket pcoIds the reviewer deselected.
// visitorChoices: individualId -> 'promote' (link + convert to regular) or 'keep'
//   (mark as link-declined so future syncs don't re-prompt). null/undefined means
//   the reviewer made no decision — no change is applied this run.
export function buildSelections(
  ambiguousChoices: Record<string, string | null>,
  skipAddPcoIds: Set<string>,
  visitorChoices: Record<string, VisitorChoice | null> = {},
): SyncSelections {
  const ambiguous: Record<string, string> = {};
  for (const [individualId, pcoId] of Object.entries(ambiguousChoices)) {
    if (pcoId) ambiguous[individualId] = pcoId;
  }
  const vChoices: Record<string, VisitorChoice> = {};
  for (const [individualId, choice] of Object.entries(visitorChoices)) {
    if (choice === 'promote' || choice === 'keep') vChoices[individualId] = choice;
  }
  return {
    ambiguous,
    skipAddPcoIds: [...skipAddPcoIds],
    visitorChoices: vChoices,
  };
}

export interface ReconciliationSelections {
  skipArchiveExtraIds: number[];
}

// skipArchiveExtraIds: archiveExtras individualIds the reviewer deselected
//   (i.e. these LMPG individuals will NOT be archived this run).
export function buildReconciliationSelections(skipArchiveExtraIds: Set<number>): ReconciliationSelections {
  return { skipArchiveExtraIds: [...skipArchiveExtraIds] };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/planningCenter/syncSelections.ts
git commit -m "refactor(pco): split batch selections from reconciliation selections"
```

---

## Task 3: `PlanningCenterSyncReview.tsx` — scope to one batch

**Files:**
- Modify: `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`

- [ ] **Step 1: Replace the file contents**

Replace the full contents of `client/src/components/planningCenter/PlanningCenterSyncReview.tsx` with:
```typescript
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';
import { buildSelections, VisitorChoice } from './syncSelections';

interface CandidateDetail { pcoId: string; firstName: string; lastName: string; membership: string | null; }
interface AmbiguousEntry { individualId: number; firstName: string; lastName: string; candidates: string[]; candidateDetails: CandidateDetail[]; }
interface VisitorMatchEntry {
  individualId: number;
  firstName: string;
  lastName: string;
  peopleType: string;
  candidate: { pcoId: string; firstName: string; lastName: string; membership: string | null };
}
interface Plan {
  link: { individualId: number; pcoId: string }[];
  restore: { individualId: number; pcoId: string }[];
  ambiguous: AmbiguousEntry[];
  visitorMatches: VisitorMatchEntry[];
  add: { pcoId: string; firstName: string; lastName: string; isChild: boolean; householdId: string | null; membership: string | null }[];
  update: { individualId: number; firstName: string; lastName: string }[];
  archive: { individualId: number; pcoId: string }[];
  reactivate: { individualId: number; pcoId: string }[];
  pcoFetchedAt?: string;
}

export default function PlanningCenterSyncReview({ connected, batchId }: { connected: boolean; batchId: number }) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, string | null>>({});
  const [skipAdd, setSkipAdd] = useState<Set<string>>(new Set());
  const [visitorChoices, setVisitorChoices] = useState<Record<string, VisitorChoice | null>>({});

  // force: bypass the server-side PCO cache (explicit "Refresh from Planning Center").
  // preserveResult: keep the "Applied: …" message visible when reloading after an apply.
  const loadPlan = useCallback(async (opts?: { force?: boolean; preserveResult?: boolean }) => {
    setLoading(true); setError(null);
    if (!opts?.preserveResult) setResult(null);
    try {
      const res = await integrationsAPI.getPlanningCenterBatchPlan(batchId, { force: opts?.force });
      setPlan(res.data.plan);
      setAmbiguousChoices({});
      setSkipAdd(new Set());
      setVisitorChoices({});
    } catch (e: any) {
      logger.error('Failed to compute PCO batch sync plan', e);
      setError(e.response?.data?.error || 'Failed to compute sync plan.');
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => { if (connected) loadPlan(); }, [connected, batchId, loadPlan]);

  const apply = async () => {
    setApplying(true); setError(null);
    try {
      const selections = buildSelections(ambiguousChoices, skipAdd, visitorChoices);
      const res = await integrationsAPI.applyPlanningCenterBatch(batchId, { selections });
      setResult(res.data.result);
      // Refresh the plan so the lists reflect the post-apply DB state instead of
      // showing the rows we just acted on. PCO is unchanged, so this is a cache hit.
      await loadPlan({ preserveResult: true });
    } catch (e: any) {
      logger.error('Failed to apply PCO batch sync', e);
      setError(e.response?.data?.error || 'Failed to apply sync.');
    } finally {
      setApplying(false);
    }
  };

  if (!connected) {
    return (
      <div className="text-sm text-gray-600 dark:text-gray-300">
        Planning Center is not connected.{' '}
        <button className="underline" onClick={() => navigate('/app/settings?tab=integrations')}>Connect it in Settings</button>.
      </div>
    );
  }
  if (loading) return <p className="text-sm text-gray-500 dark:text-gray-400">Computing sync plan… (fetching everyone from Planning Center)</p>;
  if (error) return <div className="text-sm text-red-600 dark:text-red-400">{error} <button className="underline ml-1" onClick={() => loadPlan()}>Retry</button></div>;
  if (!plan) return null;

  const toggleSkip = (pcoId: string) => {
    setSkipAdd((prev) => { const n = new Set(prev); if (n.has(pcoId)) n.delete(pcoId); else n.add(pcoId); return n; });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3 text-sm">
        {([
          ['Link', plan.link.length],
          ['Restore', plan.restore.length],
          ['Add', plan.add.length],
          ['Update', plan.update.length],
          ['Archive', plan.archive.length],
          ['Reactivate', plan.reactivate.length],
          ['Ambiguous', plan.ambiguous.length],
          ['Visitor matches', plan.visitorMatches.length],
        ] as [string, number][]).map(([label, n]) => (
          <span key={label} className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-100">{label}: {n}</span>
        ))}
      </div>

      {plan.ambiguous.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Needs your decision ({plan.ambiguous.length})</h4>
          <ul className="space-y-3">
            {plan.ambiguous.map((a) => (
              <li key={a.individualId} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                <p className="text-sm text-gray-900 dark:text-gray-100 mb-2">{a.firstName} {a.lastName} — choose the Planning Center match:</p>
                <div className="space-y-1">
                  {a.candidateDetails.map((c) => (
                    <label key={c.pcoId} className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`amb-${a.individualId}`} checked={ambiguousChoices[a.individualId] === c.pcoId}
                        onChange={() => setAmbiguousChoices((p) => ({ ...p, [a.individualId]: c.pcoId }))} />
                      <span>{c.firstName} {c.lastName}{c.membership ? ` — ${c.membership}` : ''}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`amb-${a.individualId}`} checked={!ambiguousChoices[a.individualId]}
                      onChange={() => setAmbiguousChoices((p) => ({ ...p, [a.individualId]: null }))} />
                    <span>Skip (leave unlinked)</span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.visitorMatches.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Visitors found in Planning Center — promote or keep? ({plan.visitorMatches.length})
          </h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
            These visitors share a name with someone in Planning Center. Promoting links them and makes them a regular member (Planning Center takes ownership). Keeping leaves them as a visitor and won't ask again.
          </p>
          <ul className="space-y-3">
            {plan.visitorMatches.map((v) => (
              <li key={v.individualId} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                <p className="text-sm text-gray-900 dark:text-gray-100 mb-2">
                  {v.firstName} {v.lastName} ({v.peopleType === 'local_visitor' ? 'local visitor' : 'traveller visitor'}) — matches {v.candidate.firstName} {v.candidate.lastName}{v.candidate.membership ? ` — ${v.candidate.membership}` : ''}
                </p>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`vis-${v.individualId}`}
                      checked={visitorChoices[v.individualId] === 'promote'}
                      onChange={() => setVisitorChoices((p) => ({ ...p, [v.individualId]: 'promote' }))}
                    />
                    <span>Promote to member (link to Planning Center)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`vis-${v.individualId}`}
                      checked={visitorChoices[v.individualId] === 'keep'}
                      onChange={() => setVisitorChoices((p) => ({ ...p, [v.individualId]: 'keep' }))}
                    />
                    <span>Keep as visitor (don't ask again)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`vis-${v.individualId}`}
                      checked={!visitorChoices[v.individualId]}
                      onChange={() => setVisitorChoices((p) => ({ ...p, [v.individualId]: null }))}
                    />
                    <span>Decide later (no change this run)</span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.add.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">New people to add ({plan.add.length - skipAdd.size} selected)</h4>
          <ul className="max-h-64 overflow-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {plan.add.map((p) => (
              <li key={p.pcoId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <input type="checkbox" checked={!skipAdd.has(p.pcoId)} onChange={() => toggleSkip(p.pcoId)} />
                <span>{p.firstName} {p.lastName}{p.isChild ? ' (child)' : ''} — {p.membership || 'no membership'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="text-sm text-gray-600 dark:text-gray-300">
        <summary className="cursor-pointer">Auto-applied: {plan.link.length} link, {plan.restore.length} restore, {plan.update.length} update, {plan.archive.length} archive, {plan.reactivate.length} reactivate</summary>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={apply} disabled={applying || loading}
          className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
          {applying ? 'Applying…' : 'Apply sync'}
        </button>
        <button onClick={() => loadPlan()} disabled={applying || loading} className="text-sm underline text-gray-600 dark:text-gray-300">Re-run plan</button>
        <button onClick={() => loadPlan({ force: true })} disabled={applying || loading} className="text-sm underline text-gray-600 dark:text-gray-300">Refresh from Planning Center</button>
      </div>

      {plan.pcoFetchedAt && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Planning Center data as of {new Date(plan.pcoFetchedAt).toLocaleTimeString()}. Re-run plan reuses this snapshot; use “Refresh from Planning Center” to pull the latest.
        </p>
      )}

      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Applied: {result.added} added, {result.updated} updated, {result.archived} archived, {result.reactivated} reactivated, {result.linked} linked
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
    </div>
  );
}
```

Note the two behavioural changes from the previous version: it now takes a required `batchId` prop and calls the batch-scoped endpoints, and the `archiveExtras`/`unmatchedVisitors` sections are gone entirely (those buckets no longer appear in a batch's plan response at all — see the backend plan's Task 4).

- [ ] **Step 2: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterSyncReview.tsx
git commit -m "refactor(pco): scope PlanningCenterSyncReview to a single batch"
```

---

## Task 4: `PlanningCenterReconciliationReview.tsx` — new whole-roster review UI

**Files:**
- Create: `client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx`

- [ ] **Step 1: Create the component**

```typescript
import React, { useEffect, useState, useCallback } from 'react';
import { integrationsAPI } from '../../services/api';
import logger from '../../utils/logger';
import { buildReconciliationSelections } from './syncSelections';

interface ExtraEntry { individualId: number; firstName: string; lastName: string; }
interface UnmatchedVisitorEntry { individualId: number; firstName: string; lastName: string; peopleType: string; }
interface Plan {
  archiveExtras: ExtraEntry[];
  unmatchedVisitors: UnmatchedVisitorEntry[];
  pcoFetchedAt?: string;
}

export default function PlanningCenterReconciliationReview() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [skipArchiveExtras, setSkipArchiveExtras] = useState<Set<number>>(new Set());

  const loadPlan = useCallback(async (opts?: { force?: boolean; preserveResult?: boolean }) => {
    setLoading(true); setError(null);
    if (!opts?.preserveResult) setResult(null);
    try {
      const res = await integrationsAPI.getPlanningCenterReconciliationPlan({ force: opts?.force });
      setPlan(res.data.plan);
      setSkipArchiveExtras(new Set());
    } catch (e: any) {
      logger.error('Failed to compute PCO reconciliation plan', e);
      setError(e.response?.data?.error || 'Failed to compute reconciliation plan.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  const toggleSkipExtra = (individualId: number) => {
    setSkipArchiveExtras((prev) => {
      const n = new Set(prev);
      if (n.has(individualId)) n.delete(individualId); else n.add(individualId);
      return n;
    });
  };

  const apply = async () => {
    setApplying(true); setError(null);
    try {
      const selections = buildReconciliationSelections(skipArchiveExtras);
      const res = await integrationsAPI.applyPlanningCenterReconciliation({ selections });
      setResult(res.data.result);
      await loadPlan({ preserveResult: true });
    } catch (e: any) {
      logger.error('Failed to apply PCO reconciliation', e);
      setError(e.response?.data?.error || 'Failed to apply reconciliation.');
    } finally {
      setApplying(false);
    }
  };

  if (loading) return <p className="text-sm text-gray-500 dark:text-gray-400">Checking Planning Center for people who left…</p>;
  if (error) return <div className="text-sm text-red-600 dark:text-red-400">{error} <button className="underline ml-1" onClick={() => loadPlan()}>Retry</button></div>;
  if (!plan) return null;

  return (
    <div className="space-y-6">
      {plan.archiveExtras.length === 0 && plan.unmatchedVisitors.length === 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-300">Everyone active in Let My People Grow was found in Planning Center. Nothing to review.</p>
      )}

      {plan.archiveExtras.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Not found in Planning Center — will be archived ({plan.archiveExtras.length - skipArchiveExtras.size} selected)
          </h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
            Active members in Let My People Grow whose name doesn't match anyone in Planning Center at all. Uncheck any you want to keep active.
          </p>
          <ul className="max-h-64 overflow-auto border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
            {plan.archiveExtras.map((x) => (
              <li key={x.individualId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <input type="checkbox" checked={!skipArchiveExtras.has(x.individualId)} onChange={() => toggleSkipExtra(x.individualId)} />
                <span>{x.firstName} {x.lastName}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.unmatchedVisitors.length > 0 && (
        <details className="text-sm text-gray-600 dark:text-gray-300">
          <summary className="cursor-pointer">Unmatched visitors ({plan.unmatchedVisitors.length}) — no action; visitors are managed in Let My People Grow</summary>
          <ul className="mt-2 pl-4 list-disc">
            {plan.unmatchedVisitors.map((v) => (
              <li key={v.individualId}>{v.firstName} {v.lastName}</li>
            ))}
          </ul>
        </details>
      )}

      {plan.archiveExtras.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={apply} disabled={applying || loading}
            className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
            {applying ? 'Applying…' : 'Archive selected'}
          </button>
          <button onClick={() => loadPlan()} disabled={applying || loading} className="text-sm underline text-gray-600 dark:text-gray-300">Re-run check</button>
          <button onClick={() => loadPlan({ force: true })} disabled={applying || loading} className="text-sm underline text-gray-600 dark:text-gray-300">Refresh from Planning Center</button>
        </div>
      )}

      {plan.pcoFetchedAt && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Planning Center data as of {new Date(plan.pcoFetchedAt).toLocaleTimeString()}.
        </p>
      )}

      {result && (
        <div className="text-sm text-green-700 dark:text-green-400">
          Archived: {result.archived}
          {result.errors?.length ? <span className="text-red-600 dark:text-red-400"> · {result.errors.length} errors</span> : null}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx
git commit -m "feat(pco): add reconciliation review UI (people no longer in PCO)"
```

---

## Task 5: `PlanningCenterBatchEditor.tsx` — create/edit one batch

**Files:**
- Create: `client/src/components/planningCenter/PlanningCenterBatchEditor.tsx`

- [ ] **Step 1: Create the component**

```typescript
import React, { useEffect, useState } from 'react';
import { gatheringsAPI, integrationsAPI, SyncBatch, SyncBatchInput } from '../../services/api';
import logger from '../../utils/logger';
import MembershipAllowlistEditor from './MembershipAllowlistEditor';
import FieldFilterEditor, { FieldFilterRule } from './FieldFilterEditor';

interface GatheringOption { id: number; name: string; }

interface Props {
  batch: SyncBatch | null; // null = creating a new batch
  onSaved: (batch: SyncBatch) => void;
  onCancel: () => void;
}

export default function PlanningCenterBatchEditor({ batch, onSaved, onCancel }: Props) {
  const [name, setName] = useState(batch?.name || '');
  const [membershipFilterEnabled, setMembershipFilterEnabled] = useState(batch?.membershipFilterEnabled ?? true);
  const [membershipAllowlist, setMembershipAllowlist] = useState<string[]>(batch?.membershipAllowlist || []);
  const [fieldFilterEnabled, setFieldFilterEnabled] = useState(batch?.fieldFilterEnabled ?? false);
  const [fieldFilters, setFieldFilters] = useState<FieldFilterRule[]>(batch?.fieldFilters || []);
  const [defaultPeopleType, setDefaultPeopleType] = useState<SyncBatchInput['defaultPeopleType']>(batch?.defaultPeopleType || 'regular');
  const [gatheringMode, setGatheringMode] = useState<'none' | 'existing' | 'new'>(batch?.gatheringTypeId ? 'existing' : 'none');
  const [gatheringTypeId, setGatheringTypeId] = useState<number | null>(batch?.gatheringTypeId ?? null);
  const [newGatheringName, setNewGatheringName] = useState('');
  const [gatherings, setGatherings] = useState<GatheringOption[]>([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(batch?.scheduleEnabled ?? false);
  const [scheduleFrequency, setScheduleFrequency] = useState<SyncBatchInput['scheduleFrequency']>(batch?.scheduleFrequency || 'weekly');
  const [scheduleDay, setScheduleDay] = useState(batch?.scheduleDay ?? 1);
  const [membershipValues, setMembershipValues] = useState<{ membership: string; count: number }[]>([]);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    gatheringsAPI.getAll()
      .then((r: any) => setGatherings(r.data.gatherings || r.data || []))
      .catch(() => setGatherings([]));
    loadMembershipSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMembershipSummary = async () => {
    setMembershipLoading(true); setMembershipError(null);
    try {
      const sum = await integrationsAPI.getPlanningCenterMembershipSummary();
      setMembershipValues(sum.data.values || []);
    } catch (e: any) {
      setMembershipError(e.response?.data?.error || 'Failed to load membership categories.');
    } finally {
      setMembershipLoading(false);
    }
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      let finalGatheringTypeId: number | null = null;
      if (gatheringMode === 'existing') {
        finalGatheringTypeId = gatheringTypeId;
      } else if (gatheringMode === 'new') {
        if (!newGatheringName.trim()) { setError('Enter a name for the new gathering.'); setSaving(false); return; }
        const created = await gatheringsAPI.create({ name: newGatheringName.trim(), attendanceType: 'standard' });
        finalGatheringTypeId = (created.data as any).id ?? (created.data as any).gathering?.id ?? null;
      }
      const payload: SyncBatchInput = {
        name: name.trim(),
        membershipFilterEnabled,
        membershipAllowlist,
        fieldFilterEnabled,
        fieldFilters,
        defaultPeopleType,
        gatheringTypeId: finalGatheringTypeId,
        scheduleEnabled,
        scheduleFrequency,
        scheduleDay,
      };
      const res = batch
        ? await integrationsAPI.updatePlanningCenterSyncBatch(batch.id, payload)
        : await integrationsAPI.createPlanningCenterSyncBatch(payload);
      onSaved(res.data.batch);
    } catch (e: any) {
      logger.error('Failed to save PCO sync batch', e);
      setError(e.response?.data?.error || 'Failed to save sync batch.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 border border-gray-200 dark:border-gray-700 rounded-md p-4">
      <div>
        <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Batch name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Members, Youth Group, Visitors"
          className="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
        />
      </div>

      <div className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Filter by membership category</p>
          <button type="button" onClick={() => setMembershipFilterEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${membershipFilterEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
            role="switch" aria-checked={membershipFilterEnabled}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${membershipFilterEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        {membershipFilterEnabled && (
          <MembershipAllowlistEditor
            values={membershipValues}
            loading={membershipLoading}
            error={membershipError}
            selected={membershipAllowlist}
            onChange={setMembershipAllowlist}
            onReload={loadMembershipSummary}
          />
        )}
      </div>

      <div className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Filter by custom tab fields</p>
          <button type="button" onClick={() => setFieldFilterEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${fieldFilterEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
            role="switch" aria-checked={fieldFilterEnabled}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${fieldFilterEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        {fieldFilterEnabled && (
          <FieldFilterEditor rules={fieldFilters} onChange={setFieldFilters} />
        )}
      </div>

      {!membershipFilterEnabled && !fieldFilterEnabled && (
        <div className="text-sm text-yellow-700 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md px-3 py-2">
          No one will match this batch — enable at least one filter above.
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">New people from this batch are added as</label>
        <select
          value={defaultPeopleType}
          onChange={(e) => setDefaultPeopleType(e.target.value as SyncBatchInput['defaultPeopleType'])}
          className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
        >
          <option value="regular">Regulars</option>
          <option value="local_visitor">Local visitors</option>
          <option value="traveller_visitor">Traveller visitors</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Add everyone from this batch to a gathering</label>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={gatheringMode}
            onChange={(e) => setGatheringMode(e.target.value as 'none' | 'existing' | 'new')}
            className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
          >
            <option value="none">Don't assign a gathering</option>
            <option value="existing">Existing gathering</option>
            <option value="new">Create a new gathering</option>
          </select>
          {gatheringMode === 'existing' && (
            <select
              value={gatheringTypeId ?? ''}
              onChange={(e) => setGatheringTypeId(e.target.value ? Number(e.target.value) : null)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
            >
              <option value="">Choose…</option>
              {gatherings.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {gatheringMode === 'new' && (
            <input
              type="text"
              value={newGatheringName}
              onChange={(e) => setNewGatheringName(e.target.value)}
              placeholder="New gathering name"
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500"
            />
          )}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">Schedule</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setScheduleEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${scheduleEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
            role="switch" aria-checked={scheduleEnabled}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${scheduleEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
          <span className="text-sm text-gray-700 dark:text-gray-300">{scheduleEnabled ? 'Runs automatically' : 'Manual only'}</span>
          {scheduleEnabled && (
            <>
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
            </>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !name.trim() || (!membershipFilterEnabled && !fieldFilterEnabled)}
          className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : batch ? 'Save batch' : 'Create batch'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm underline text-gray-600 dark:text-gray-300">Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterBatchEditor.tsx
git commit -m "feat(pco): add PlanningCenterBatchEditor for creating/editing sync batches"
```

---

## Task 6: `PlanningCenterIntegrationPanel.tsx` — batch list + reconciliation card

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`

- [ ] **Step 1: Replace the sync-config state, loaders, and the "Full people sync configuration" JSX block**

Replace the entire block of state declarations from `pcSyncIndicator` through `showSyncReview` (currently lines 36-51):
```typescript
  const [pcSyncIndicator, setPcSyncIndicator] = useState(false);
  const [pcSyncEnabled, setPcSyncEnabled] = useState(false);
  const [pcSyncFrequency, setPcSyncFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [pcSyncDay, setPcSyncDay] = useState(1);
  const [pcMembershipFilterEnabled, setPcMembershipFilterEnabled] = useState(true);
  const [pcAllowlist, setPcAllowlist] = useState<string[]>([]);
  const [pcSummary, setPcSummary] = useState<{ membership: string; count: number }[]>([]);
  const [pcSummaryLoading, setPcSummaryLoading] = useState(false);
  const [pcSummaryError, setPcSummaryError] = useState<string | null>(null);
  const [pcFieldFilterEnabled, setPcFieldFilterEnabled] = useState(false);
  const [pcFieldFilters, setPcFieldFilters] = useState<FieldFilterRule[]>([]);
  const [pcConfigDirty, setPcConfigDirty] = useState(false);
  const [pcConfigSaving, setPcConfigSaving] = useState(false);
  const [pcLastSync, setPcLastSync] = useState<any>(null);
  const [pcSyncRunning, setPcSyncRunning] = useState(false);
  const [showSyncReview, setShowSyncReview] = useState(false);
```
with:
```typescript
  const [pcSyncIndicator, setPcSyncIndicator] = useState(false);
  const [pcSyncEnabled, setPcSyncEnabled] = useState(false);
  const [batches, setBatches] = useState<SyncBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [batchesError, setBatchesError] = useState<string | null>(null);
  const [editingBatch, setEditingBatch] = useState<SyncBatch | 'new' | null>(null);
  const [reviewingBatchId, setReviewingBatchId] = useState<number | null>(null);
  const [runningBatchId, setRunningBatchId] = useState<number | null>(null);
  const [reconciliationScheduleEnabled, setReconciliationScheduleEnabled] = useState(false);
  const [reconciliationFrequency, setReconciliationFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [reconciliationDay, setReconciliationDay] = useState(1);
  const [reconciliationLastResult, setReconciliationLastResult] = useState<any>(null);
  const [reconciliationDirty, setReconciliationDirty] = useState(false);
  const [reconciliationSaving, setReconciliationSaving] = useState(false);
  const [showReconciliationReview, setShowReconciliationReview] = useState(false);
```

Update the import line near the top (currently):
```typescript
import MembershipAllowlistEditor from '../planningCenter/MembershipAllowlistEditor';
import FieldFilterEditor, { FieldFilterRule } from '../planningCenter/FieldFilterEditor';
import PCOCheckinImport from '../PCOCheckinImport';
import PlanningCenterSyncReview from '../planningCenter/PlanningCenterSyncReview';
```
to:
```typescript
import PCOCheckinImport from '../PCOCheckinImport';
import PlanningCenterSyncReview from '../planningCenter/PlanningCenterSyncReview';
import PlanningCenterReconciliationReview from '../planningCenter/PlanningCenterReconciliationReview';
import PlanningCenterBatchEditor from '../planningCenter/PlanningCenterBatchEditor';
import { SyncBatch } from '../../services/api';
```
(`MembershipAllowlistEditor`/`FieldFilterEditor` move into `PlanningCenterBatchEditor`; the panel no longer renders them directly.)

- [ ] **Step 2: Replace `loadPcSyncConfig` and add batch/reconciliation loaders**

Replace:
```typescript
  const loadPcSyncConfig = useCallback(async () => {
    try {
      const filter = await integrationsAPI.getPlanningCenterSyncFilter();
      setPcSyncEnabled(!!filter.data.enabled);
      setPcMembershipFilterEnabled(filter.data.membershipFilterEnabled !== false);
      setPcAllowlist(Array.isArray(filter.data.membershipAllowlist) ? filter.data.membershipAllowlist : []);
      setPcFieldFilterEnabled(!!filter.data.fieldFilterEnabled);
      setPcFieldFilters(Array.isArray(filter.data.fieldFilters) ? filter.data.fieldFilters : []);
    } catch (e) { logger.error('Failed to load PCO sync filter', e); }
    setPcSummaryLoading(true);
    setPcSummaryError(null);
    try {
      const sum = await integrationsAPI.getPlanningCenterMembershipSummary();
      setPcSummary(sum.data.values || []);
    } catch (e: any) {
      setPcSummaryError(e.response?.data?.error || 'Failed to load membership categories.');
    } finally {
      setPcSummaryLoading(false);
    }
  }, []);
```
with:
```typescript
  const loadBatches = useCallback(async () => {
    setBatchesLoading(true); setBatchesError(null);
    try {
      const res = await integrationsAPI.getPlanningCenterSyncBatches();
      setBatches(res.data.batches || []);
    } catch (e: any) {
      setBatchesError(e.response?.data?.error || 'Failed to load sync batches.');
    } finally {
      setBatchesLoading(false);
    }
  }, []);
```

- [ ] **Step 3: Replace `savePcSyncConfig`/`runPcSyncNow` with batch + master-switch + reconciliation actions**

Replace:
```typescript
  const savePcSyncConfig = async () => {
    setPcConfigSaving(true);
    try {
      await integrationsAPI.savePlanningCenterSyncFilter({
        enabled: pcSyncEnabled,
        membershipFilterEnabled: pcMembershipFilterEnabled,
        membershipAllowlist: pcAllowlist,
        fieldFilterEnabled: pcFieldFilterEnabled,
        fieldFilters: pcFieldFilters,
      });
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

  const runPcSyncNow = async () => {
    setPcSyncRunning(true);
    try {
      const res = await integrationsAPI.applyPlanningCenterSync({});
      setPcLastSync(res.data.summary || null);
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Sync failed.');
    } finally {
      setPcSyncRunning(false);
    }
  };
```
with:
```typescript
  const toggleMasterSync = async (value: boolean) => {
    setPcSyncEnabled(value);
    try {
      await settingsAPI.updateIntegrationSettings({ planningCenterSyncEnabled: value });
    } catch (error) {
      logger.error('Failed to update master sync switch:', error);
      setPcSyncEnabled(!value);
    }
  };

  const runBatchNow = async (batchId: number) => {
    setRunningBatchId(batchId);
    try {
      await integrationsAPI.applyPlanningCenterBatch(batchId, {});
      await loadBatches();
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Sync failed.');
    } finally {
      setRunningBatchId(null);
    }
  };

  const deleteBatch = async (batchId: number) => {
    try {
      await integrationsAPI.deletePlanningCenterSyncBatch(batchId);
      await loadBatches();
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Failed to delete sync batch.');
    }
  };

  const saveReconciliationConfig = async () => {
    setReconciliationSaving(true);
    try {
      await settingsAPI.updateIntegrationSettings({
        planningCenterReconciliationScheduleEnabled: reconciliationScheduleEnabled,
        planningCenterReconciliationFrequency: reconciliationFrequency,
        planningCenterReconciliationDay: reconciliationDay,
      });
      setReconciliationDirty(false);
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Failed to save reconciliation schedule.');
    } finally {
      setReconciliationSaving(false);
    }
  };
```

- [ ] **Step 4: Update the load-on-connect effect**

Replace:
```typescript
  // Load sync config, summary, and sync indicator when connected
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
with:
```typescript
  // Load batches, sync indicator, master switch, and reconciliation config when connected
  useEffect(() => {
    if (status.connected) {
      loadBatches();
      settingsAPI.getIntegrationSettings().then(r => {
        setPcSyncIndicator(!!r.data.planningCenterSyncIndicator);
        setPcSyncEnabled(!!r.data.planningCenterSyncEnabled);
        setReconciliationScheduleEnabled(!!r.data.planningCenterReconciliationScheduleEnabled);
        setReconciliationFrequency(r.data.planningCenterReconciliationFrequency || 'weekly');
        setReconciliationDay(typeof r.data.planningCenterReconciliationDay === 'number' ? r.data.planningCenterReconciliationDay : 1);
        setReconciliationLastResult(r.data.planningCenterReconciliationLastResult || null);
      }).catch(() => {});
    }
  }, [status.connected, loadBatches]);
```

- [ ] **Step 5: Replace the "Full people sync configuration" JSX block**

Replace the entire block currently spanning from `{/* Full people sync configuration */}` through the closing of the `{pcLastSync && (...)}` paragraph (lines 295-441) with:
```typescript
              {/* Sync batches */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Enable Planning Center sync</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Master switch — turns off all batches and the "check for people who left" schedule below.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleMasterSync(!pcSyncEnabled)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${pcSyncEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                    role="switch"
                    aria-checked={pcSyncEnabled}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${pcSyncEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Sync batches</p>
                  {editingBatch === null && (
                    <button type="button" onClick={() => setEditingBatch('new')}
                      className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700">
                      New batch
                    </button>
                  )}
                </div>

                {batchesError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{batchesError}</p>}
                {batchesLoading && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Loading batches…</p>}

                {editingBatch !== null && (
                  <div className="mt-3">
                    <PlanningCenterBatchEditor
                      batch={editingBatch === 'new' ? null : editingBatch}
                      onSaved={() => { setEditingBatch(null); loadBatches(); }}
                      onCancel={() => setEditingBatch(null)}
                    />
                  </div>
                )}

                {!batchesLoading && batches.length === 0 && editingBatch === null && (
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No sync batches yet — create one to start importing people from Planning Center.</p>
                )}

                <ul className="mt-3 space-y-3">
                  {batches.map((batch) => (
                    <li key={batch.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{batch.name}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {batch.gatheringTypeId ? 'Assigns to a gathering · ' : ''}
                            {batch.scheduleEnabled ? `Runs ${batch.scheduleFrequency}` : 'Manual only'}
                          </p>
                          {batch.lastSyncResult && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              Last run {new Date(batch.lastSyncResult.at).toLocaleString()}: {batch.lastSyncResult.added} added, {batch.lastSyncResult.updated} updated, {batch.lastSyncResult.linked} linked
                              {batch.lastSyncResult.ambiguous ? `, ${batch.lastSyncResult.ambiguous} need review` : ''}.
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setEditingBatch(batch)} className="text-sm underline text-gray-600 dark:text-gray-300">Edit</button>
                          <button type="button" onClick={() => runBatchNow(batch.id)} disabled={runningBatchId === batch.id}
                            className="text-sm underline text-gray-600 dark:text-gray-300 disabled:opacity-50">
                            {runningBatchId === batch.id ? 'Syncing…' : 'Run now'}
                          </button>
                          <button type="button" onClick={() => setReviewingBatchId(reviewingBatchId === batch.id ? null : batch.id)}
                            className="text-sm underline text-gray-600 dark:text-gray-300">
                            {reviewingBatchId === batch.id ? 'Hide review' : 'Review & sync'}
                          </button>
                          <button type="button" onClick={() => deleteBatch(batch.id)} className="text-sm underline text-red-600 dark:text-red-400">Delete</button>
                        </div>
                      </div>
                      {reviewingBatchId === batch.id && (
                        <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
                          <PlanningCenterSyncReview connected={status.connected} batchId={batch.id} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Reconciliation: people no longer in PCO at all */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Check for people who left</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Finds active people whose name doesn't match anyone in Planning Center at all, across every saved batch.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => { setReconciliationScheduleEnabled((v) => !v); setReconciliationDirty(true); }}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${reconciliationScheduleEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                    role="switch" aria-checked={reconciliationScheduleEnabled}>
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${reconciliationScheduleEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                  <span className="text-sm text-gray-700 dark:text-gray-300">{reconciliationScheduleEnabled ? 'Runs automatically' : 'Manual only'}</span>
                  {reconciliationScheduleEnabled && (
                    <>
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
                      <button type="button" onClick={saveReconciliationConfig} disabled={!reconciliationDirty || reconciliationSaving}
                        className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
                        {reconciliationSaving ? 'Saving…' : 'Save schedule'}
                      </button>
                    </>
                  )}
                  <button type="button" onClick={() => setShowReconciliationReview((v) => !v)}
                    className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
                    {showReconciliationReview ? 'Hide check' : 'Check now'}
                  </button>
                </div>
                {reconciliationLastResult && (
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Last checked {new Date(reconciliationLastResult.at).toLocaleString()}: {reconciliationLastResult.archived} archived.
                  </p>
                )}
                {showReconciliationReview && (
                  <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
                    <PlanningCenterReconciliationReview />
                  </div>
                )}
              </div>
```

- [ ] **Step 6: Verify manually in the browser**

Start the dev stack, log in as an admin at a church already connected to Planning Center, open Settings → Integrations:
```
docker-compose -f docker-compose.dev.yml up -d
```
Confirm: the master toggle works; "New batch" opens the editor and creates a batch with a membership filter, a `local_visitor` default type, and a new gathering; "Run now" applies it and updates the last-run line; "Review & sync" shows the batch-scoped review (no archive-extras section); "Check now" under "Check for people who left" shows the reconciliation review; Delete removes a batch.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/integrations/PlanningCenterIntegrationPanel.tsx
git commit -m "feat(pco): batch list + reconciliation card in the integration panel"
```

---

## Task 7: `OnboardingPage.tsx` — `pco-people` step creates the first batch

**Files:**
- Modify: `client/src/pages/OnboardingPage.tsx`

- [ ] **Step 1: Replace the PCO-people-related imports and state**

Replace:
```typescript
import MembershipAllowlistEditor from '../components/planningCenter/MembershipAllowlistEditor';
import PCOCheckinImport from '../components/PCOCheckinImport';
```
with:
```typescript
import PlanningCenterBatchEditor from '../components/planningCenter/PlanningCenterBatchEditor';
import PCOCheckinImport from '../components/PCOCheckinImport';
import { SyncBatch } from '../services/api';
```

Replace:
```typescript
  const [membershipValues, setMembershipValues] = useState<{ membership: string; count: number }[]>([]);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [importingPeople, setImportingPeople] = useState(false);
```
with:
```typescript
  const [importingPeople, setImportingPeople] = useState(false);
```

- [ ] **Step 2: Replace `loadMembershipSummary`/`importPeople` with a single batch-created handler**

Replace:
```typescript
  const loadMembershipSummary = async () => {
    setMembershipLoading(true); setMembershipError(null);
    try {
      const r = await integrationsAPI.getPlanningCenterMembershipSummary();
      const values = r.data.values || [];
      setMembershipValues(values);
      const defaults = values
        .map((v: any) => v.membership)
        .filter((m: string) => m && m !== '(none)' && !/archiv|inactive/i.test(m));
      setAllowlist(defaults);
    } catch (e: any) {
      setMembershipError(e.response?.data?.error || 'Failed to load membership categories.');
    } finally {
      setMembershipLoading(false);
    }
  };

  const importPeople = async () => {
    setImportingPeople(true); setError('');
    try {
      // Save the chosen allowlist (one-time import; ongoing sync stays off). Onboarding
      // only offers membership-category selection, so the field-filter source stays off.
      await integrationsAPI.savePlanningCenterSyncFilter({
        enabled: false,
        membershipFilterEnabled: true,
        membershipAllowlist: allowlist,
        fieldFilterEnabled: false,
        fieldFilters: [],
      });
      // Apply the additive sync to import matching people + households.
      await integrationsAPI.applyPlanningCenterSync({});
      setStep('pco-gatherings');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to import people from Planning Center.');
    } finally {
      setImportingPeople(false);
    }
  };
```
with:
```typescript
  // The batch is created/saved by PlanningCenterBatchEditor itself; this just
  // runs an immediate, auto-applied import (no manual review — same one-time,
  // no-review behaviour onboarding had before) and advances the wizard.
  const onFirstBatchSaved = async (batch: SyncBatch) => {
    setImportingPeople(true); setError('');
    try {
      await integrationsAPI.applyPlanningCenterBatch(batch.id, {});
      setStep('pco-gatherings');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to import people from Planning Center.');
    } finally {
      setImportingPeople(false);
    }
  };
```

- [ ] **Step 3: Replace the `pco-people` step JSX**

Replace:
```typescript
          ) : step === 'pco-people' ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">Choose which Planning Center people to import.</p>
              <MembershipAllowlistEditor
                values={membershipValues}
                loading={membershipLoading}
                error={membershipError}
                selected={allowlist}
                onChange={setAllowlist}
                onReload={loadMembershipSummary}
              />
              <div className="flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep('pco-gatherings')}
                  className="text-gray-600 underline text-sm"
                >
                  Skip
                </button>
                <button
                  type="button"
                  disabled={importingPeople || allowlist.length === 0}
                  onClick={importPeople}
                  className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  {importingPeople ? 'Importing…' : 'Import people'}
                </button>
              </div>
            </div>
```
with:
```typescript
          ) : step === 'pco-people' ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">Choose which Planning Center people to import, and optionally assign them to a gathering.</p>
              {importingPeople ? (
                <p className="text-sm text-gray-700">Importing…</p>
              ) : (
                <PlanningCenterBatchEditor
                  batch={null}
                  onSaved={onFirstBatchSaved}
                  onCancel={() => setStep('pco-gatherings')}
                />
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
```
(`PlanningCenterBatchEditor`'s own "Cancel" button now serves as onboarding's "Skip.")

The `pco-gatherings` step and `finishOnboarding` are untouched — `PCOCheckinImport` still runs immediately after, unaffected by any of this.

- [ ] **Step 4: Verify the client builds and the onboarding flow works manually**

```
docker-compose -f docker-compose.dev.yml exec -T client npm run build
```
Expected: build succeeds. Then manually walk through onboarding for a fresh church: connect Planning Center, land on `pco-people`, fill in the batch editor (name, membership filter, optionally a new gathering), save, confirm it imports and advances to `pco-gatherings`, confirm `PCOCheckinImport` still runs unchanged.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/OnboardingPage.tsx
git commit -m "feat(pco): onboarding's pco-people step creates the first sync batch"
```

---

## Final manual verification checklist

With the full dev stack running and a church connected to Planning Center:

1. Settings → Integrations: create two batches with different membership categories; run each; confirm each batch's review only shows people relevant to its own filter, and people already linked via one batch show as informational in the other (not re-created).
2. Create a batch with a new gathering; run it; confirm new/linked people appear on that gathering's roster page.
3. Create a batch with `defaultPeopleType` = local visitor; run it; confirm newly-created people show as local visitors, not regulars.
4. Run "Check for people who left"; confirm it only lists people who don't match any PCO person by name at all.
5. Onboarding: walk through a brand-new church signup end-to-end through `pco-people` → `pco-gatherings` → gatherings page.
