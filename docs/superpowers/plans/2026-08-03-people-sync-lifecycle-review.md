# People Sync Lifecycle Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop source absence from archiving people, retain reviewed archive proposals for explicit provider Archived/Deceased states, and let administrators filter LMPG people by active-provider link status.

**Architecture:** Lifecycle planning becomes state-driven rather than presence-driven: provider terminal states produce the existing archive plan actions; complete source reads do not mutate or project missing counters. The shared review surface groups those archive actions under a lifecycle section with an accept-all control. PeoplePage derives linked status from its existing church-scoped `externalLinks` response and active people-sync authority setting, so no new endpoint, migration, or dependency is needed.

**Tech Stack:** Node.js test runner, Express, SQLite via better-sqlite3, React 19, TypeScript, Vitest, Testing Library, Tailwind CSS.

## Global Constraints

- Keep every database query and mutation explicitly church-scoped.
- Do not add a database migration or runtime dependency.
- Never archive because a person is absent from configured Planning Center or Elvanto sources, including after partial, full, scheduled, or manual sync reads.
- Existing `missing_full_sync_count` may remain stored but must not be read, incremented, reset, persisted, or used to generate a plan action.
- Only explicitly provider-reported `Archived` and `Deceased` states may produce a provider lifecycle archive proposal; retain all authority, source-generation, review-token, apply-confirmation, and transaction protections.
- **Accept all proposed archives** selects only current terminal-state archive proposals; it must never select unlinked/local-only people.
- Show the People **External source** filter only when `authorityProvider` is `planning_center` or `elvanto`; scope it only to that provider's durable external link.
- Preserve all existing PCO compatibility IDs and generic `external_person_links` behavior.

---

### Task 1: Remove absence-based lifecycle planning and persistence

**Files:**
- Modify: `server/services/peopleSync/plan.js`
- Modify: `server/services/peopleSync/plan.test.js`
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/linkRepository.js`
- Modify: `server/services/peopleSync/linkRepository.dbintegration.test.js`

**Interfaces:**
- `buildPlan(...)` continues to emit `plan.archive` only for explicit terminal provider state.
- `plan.presenceProjection` is removed from newly created plans, or is an immutable compatibility empty projection `{ completeFullSnapshot: false, updates: [] }`; choose one shape and update every consumer/test consistently.
- `runPipeline`/`applyReviewed` no longer call `recordFullFetchPresence` after applying a plan.
- `recordFullFetchPresence(...)` becomes a no-op compatibility boundary if it must remain exported for older callers; it must not write `missing_full_sync_count`.

- [ ] **Step 1: Write failing terminal-versus-absence plan tests**

```js
test('does not propose an archive when a durable link is absent from a complete source read', () => {
  const plan = buildPlan({
    authoritative: true,
    personLinks: [link('missing', 10, { missingFullSyncCount: 1 })],
    externalPeople: [], eligibleUnion: new Set(),
    snapshot: { mode: 'full', complete: true },
  });
  assert.deepEqual(plan.archive, []);
  assert.equal(plan.skipped.some((action) => action.reason === 'awaiting_missing_confirmation'), false);
});

test('still proposes archive only for an explicitly Archived or Deceased linked provider identity', () => {
  const archived = buildPlanForLinkedState('archived');
  const deceased = buildPlanForLinkedState('deceased');
  assert.equal(archived.archive[0].reason, 'provider_state_archived');
  assert.equal(deceased.archive[0].reason, 'provider_state_deceased');
});
```

Add a scheduled/manual orchestration test proving a complete source snapshot does not schedule a presence write, and a SQLite test proving calling the compatibility repository boundary cannot change a pre-seeded `missing_full_sync_count`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd server && node --test \
  services/peopleSync/plan.test.js \
  services/peopleSync/orchestrator.test.js \
  services/peopleSync/linkRepository.dbintegration.test.js
```

Expected: absence test fails because the current plan increments presence and emits `awaiting_missing_confirmation` / `confirmed_missing_full_sync`.

- [ ] **Step 3: Remove the presence lifecycle path**

Delete the call from plan construction that adds missing-source skipped/archive actions. Remove the post-apply `recordFullFetchPresence` invocation from orchestration. Retain terminal-state archive creation in the linked-identity loop, including its existing `isActive(localPerson)`, authority, and review safeguards. Make the repository compatibility boundary return without updating rows if it remains public.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Also run:

```bash
cd server && node --test services/peopleSync/*.test.js routes/integrations/*.test.js
```

Expected: all tests pass; no plan includes `confirmed_missing_full_sync` or `awaiting_missing_confirmation`.

- [ ] **Step 5: Commit**

```bash
git add server/services/peopleSync/plan.js server/services/peopleSync/plan.test.js \
  server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js \
  server/services/peopleSync/linkRepository.js server/services/peopleSync/linkRepository.dbintegration.test.js
git commit -m "fix(sync): remove absence-based archives"
```

---

### Task 2: Make terminal-state archives explicit and bulk-selectable in review

**Files:**
- Modify: `client/src/components/peopleSync/SyncPlanSections.tsx`
- Modify: `client/src/components/peopleSync/SyncPlanSections.test.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.test.tsx`

**Interfaces:**
- `SyncPlanSections` receives the current `archive` plan actions and an `onAcceptAllArchives()` callback.
- It renders a **Lifecycle review** section only when archive actions are present.
- The section's **Accept all proposed archives** callback selects every current archive action ID; individual checkboxes still delegate to the existing archive-selection state.

- [ ] **Step 1: Write failing lifecycle-section tests**

```tsx
it('renders provider terminal archive proposals with an accept-all action', async () => {
  render(<SyncReview review={reviewWithArchives([
    archive('ext-a', 10, 'provider_state_archived'),
    archive('ext-b', 20, 'provider_state_deceased'),
  ])} {...props} />);
  await user.click(screen.getByRole('button', { name: 'Accept all proposed archives' }));
  expect(screen.getByRole('button', { name: 'Apply sync' })).toBeEnabled();
  expect(props.onApply).toHaveBeenCalledWith(expect.objectContaining({
    acceptedArchiveIds: expect.arrayContaining([10, 20]),
  }));
});
```

Add tests that no lifecycle section appears without archive actions, and that accepting all never touches any unrelated/locally unlinked person state.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd client && npm test -- --run \
  src/components/peopleSync/SyncPlanSections.test.tsx \
  src/components/peopleSync/SyncReview.test.tsx
```

Expected: fail because no lifecycle section or accept-all archive control exists.

- [ ] **Step 3: Implement the lifecycle review section**

Move archive rendering into a clearly labelled **Lifecycle review** group. Render the existing archive confirmation/copy and controls there; add an explicit button that adds every current archive action's `individualId` to the selected archive set. Do not create any archive action or selection for a person merely lacking an external link. Keep the one final Apply sync action unchanged at the end of `SyncReview`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command, then:

```bash
cd client && npm test
```

Expected: all client tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/peopleSync/SyncPlanSections.tsx \
  client/src/components/peopleSync/SyncPlanSections.test.tsx \
  client/src/components/peopleSync/SyncReview.tsx \
  client/src/components/peopleSync/SyncReview.test.tsx
git commit -m "feat(sync): add lifecycle archive review"
```

---

### Task 3: Add active-provider link filtering to People

**Files:**
- Modify: `client/src/pages/PeoplePage.tsx`
- Create: `client/src/pages/PeoplePage.externalSource.test.tsx`

**Interfaces:**
- Add local state: `externalSourceFilter: 'all' | 'linked' | 'unlinked'`.
- Add pure helper exported for testing:

```ts
export function matchesExternalSourceFilter(
  person: Pick<Person, 'externalLinks'>,
  authorityProvider: AuthorityProvider,
  filter: 'all' | 'linked' | 'unlinked',
): boolean;
```

- Link presence is `Boolean(person.externalLinks?.[authorityProvider])` when authority is `planning_center` or `elvanto`. For `none`, the helper returns true and the UI control is not rendered.

- [ ] **Step 1: Write failing filter tests**

```tsx
it('shows only people linked to the active provider when Linked is selected', () => {
  renderPeoplePage({ authorityProvider: 'planning_center', people: [
    person(1, { externalLinks: { planning_center: 'pco-1' } }),
    person(2, { externalLinks: { elvanto: 'elv-2' } }),
  ] });
  await user.selectOptions(screen.getByLabelText('External source'), 'linked');
  expect(screen.getByText('Person 1')).toBeInTheDocument();
  expect(screen.queryByText('Person 2')).not.toBeInTheDocument();
});
```

Also cover **Not linked**, an Elvanto active authority, `authorityProvider: 'none'` hiding the control, family-grouped filtering (families remain only if a member matches), and individual view.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd client && npm test -- --run src/pages/PeoplePage.externalSource.test.tsx
```

Expected: FAIL because `External source` filter and `matchesExternalSourceFilter` do not exist.

- [ ] **Step 3: Implement provider-scoped filtering**

Add the select control beside existing People filters only when an active authority exists. Apply `matchesExternalSourceFilter` before grouping/sorting to both `filteredGroupedPeople` and `filteredIndividualPeople`; do not mutate the source `people` array while filtering groups. Reset selected people whose IDs disappear after changing the filter. Keep visitors outside this first-release filter unless they are already part of the regular People list.

- [ ] **Step 4: Run client verification and verify GREEN**

Run:

```bash
cd client && npm test -- --run src/pages/PeoplePage.externalSource.test.tsx
npm test
npm run build
```

Expected: all tests and the production build pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/PeoplePage.tsx client/src/pages/PeoplePage.externalSource.test.tsx
git commit -m "feat(people): filter by external source link"
```

## Final Verification

- [ ] Run `cd server && node --test services/peopleSync/*.test.js routes/integrations/*.test.js`.
- [ ] Run `cd client && npm test && npm run build`.
- [ ] Confirm a complete source read that omits a linked person produces no archive proposal, while an explicitly Archived or Deceased linked person appears in Lifecycle review.
- [ ] Confirm **Accept all proposed archives** selects only those terminal-state proposals.
- [ ] Confirm People shows no External source filter without an active authority and provider-scoped Linked/Not linked results with PCO and Elvanto authority.
