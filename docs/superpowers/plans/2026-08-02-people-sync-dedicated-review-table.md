# People Sync Dedicated Review Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inline Planning Center and Elvanto batch reviews with a dedicated, responsive table workflow that supports new identity decisions, exact rejection or deferral, and atomic correction of established links.

**Architecture:** Keep the existing V2 identity-decision contract for compatibility and add an optional signed link-correction contract. The server projects all submitted established-link corrections as one final mapping, recomputes the plan from the same provider snapshot, and signs that preview; apply rebuilds the identical projection and commits corrected links, exclusions or holds, PCO compatibility IDs, and downstream managed actions in one church-scoped transaction. A shared React review surface renders the new table, while a provider-neutral route page supplies batch metadata, API callbacks, navigation protection, and post-apply routing.

**Tech Stack:** Node.js 25 test runner, Express 5, SQLite via `better-sqlite3`, React 19, TypeScript 6, React Router 7, Tailwind CSS 4, Headless UI 2, Vitest 3, Testing Library.

## Global Constraints

- Every database query and mutation must remain explicitly church-scoped.
- No database migration: reuse `external_person_links`, `people_sync_match_exclusions`, `people_sync_match_holds`, and `individuals.planning_center_id`.
- Keep `decisionContractVersion: 2`; add `correctionContractVersion: 1` inside the signed review context so cached V2 clients continue to ignore corrections safely.
- The default **Decisions** tab excludes established links; **Already linked** contains only established identities represented by the reviewed batch source snapshot.
- The desktop columns are **Integration source name | Integration source family/household | LMPG name | LMPG family | ×**.
- Narrow screens use compact source/LMPG comparison rows and must not require horizontal scrolling.
- Search and filters precede pagination; the default page size is exactly 50 rows.
- The filters are **All**, **Needs attention**, **Matched**, **Adding**, and **Skipped**.
- **Reject this match** persists the old exact-pair exclusion and a `pair_rejected` hold; **Skip and ask again** persists a hold without an exclusion.
- Established-link corrections never infer a swap. Two explicit corrections may exchange targets because the server validates the complete final mapping rather than click order.
- A correction preview applies the newly linked identity's current managed values in the same final transaction; attendance, notes, unmanaged fields, and known values corresponding to missing provider data remain unchanged.
- There is no apply action in the header. Render one normal-sized **Apply sync** action after all options, destructive confirmations, and validation guidance.
- Preserve source-draft promotion, authority locks, connection/source generation fencing, one-time review tokens, stale-plan rejection, and transactional rollback.
- Do not add a runtime dependency.

---

### Task 1: Pure established-link correction contract

**Files:**
- Create: `server/services/peopleSync/linkCorrections.js`
- Create: `server/services/peopleSync/linkCorrections.test.js`

**Interfaces:**
- Produces: `validateAndProjectLinkCorrections({ rawCorrections, baseLinks, sourceExternalIds, localIndividualIds })`.
- Produces: `canonicalLinkCorrections(rawCorrections)` for deterministic plan signing and response serialization.
- `canonicalLinkCorrections` accepts either the keyed request record or an already canonical array and always returns the same sorted canonical array.
- Returns: `{ corrections, projectedLinks, exclusionsToAdd, holdsToUpsert, holdsToDelete, correctedExternalIds, unlinkedExternalIds, freedIndividualIds }`.
- `corrections` is a sorted array of `{ externalPersonId, fromIndividualId, outcome: 'relink', individualId }` or `{ externalPersonId, fromIndividualId, outcome: 'unlink' }`.

- [ ] **Step 1: Write failing normalization and final-mapping tests**

```js
test('projects corrections simultaneously so two explicit rows can exchange targets', () => {
  const result = validateAndProjectLinkCorrections({
    rawCorrections: {
      'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 },
      'ext-b': { outcome: 'relink', fromIndividualId: 20, individualId: 10 },
    },
    baseLinks: [link('ext-a', 10), link('ext-b', 20)],
    sourceExternalIds: new Set(['ext-a', 'ext-b']),
    localIndividualIds: new Set([10, 20]),
  });
  assert.deepEqual(result.projectedLinks.map(pair), [['ext-a', 20], ['ext-b', 10]]);
});

test('rejects an implicit collision with an unchanged established link', () => {
  assert.throws(() => validateAndProjectLinkCorrections({
    rawCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
    baseLinks: [link('ext-a', 10), link('ext-b', 20)],
    sourceExternalIds: new Set(['ext-a', 'ext-b']),
    localIndividualIds: new Set([10, 20]),
  }), /still linked to ext-b/i);
});
```

Also cover unknown external IDs, an external identity outside the reviewed source, stale `fromIndividualId`, nonexistent local targets, self-relinks, duplicate final local targets, deterministic key ordering, unlink exclusions/holds, and relink hold deletion.

- [ ] **Step 2: Run the correction-contract test and verify failure**

Run: `cd server && node --test services/peopleSync/linkCorrections.test.js`

Expected: FAIL with `Cannot find module './linkCorrections'`.

- [ ] **Step 3: Implement strict parsing and simultaneous projection**

```js
function validateAndProjectLinkCorrections({
  rawCorrections = {}, baseLinks = [], sourceExternalIds = new Set(), localIndividualIds = new Set(),
} = {}) {
  const corrections = canonicalLinkCorrections(rawCorrections);
  const byExternal = new Map(baseLinks.map((link) => [String(link.externalPersonId), link]));
  for (const correction of corrections) {
    const current = byExternal.get(correction.externalPersonId);
    assertReviewedEstablishedLink(current, correction, sourceExternalIds, localIndividualIds);
    byExternal.delete(correction.externalPersonId);
  }
  for (const correction of corrections) {
    if (correction.outcome === 'relink') {
      byExternal.set(correction.externalPersonId, {
        ...baseLinks.find((link) => String(link.externalPersonId) === correction.externalPersonId),
        individualId: correction.individualId,
        linkSource: 'manual',
      });
    }
  }
  assertUniqueFinalIndividuals(byExternal.values());
  return correctionProjection(corrections, [...byExternal.values()]);
}
```

Reject unknown object keys, non-positive integer IDs, unsupported outcomes, and no-op relinks. Emit one old-pair exclusion per correction, a `pair_rejected` hold only for unlink, and a hold deletion only for relink.

- [ ] **Step 4: Run the correction-contract test and verify success**

Run: `cd server && node --test services/peopleSync/linkCorrections.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the pure correction model**

```bash
git add server/services/peopleSync/linkCorrections.js server/services/peopleSync/linkCorrections.test.js
git commit -m "feat(sync): model established link corrections"
```

---

### Task 2: Signed review context and corrected plan projection

**Files:**
- Modify: `server/services/peopleSync/reviewContext.js`
- Modify: `server/services/peopleSync/reviewContext.test.js`
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/plan.js`
- Modify: `server/services/peopleSync/plan.test.js`

**Interfaces:**
- Consumes: `validateAndProjectLinkCorrections(...)` from Task 1.
- Extends `plan.reviewContext` with `correctionContractVersion: 1`, `establishedLinks`, `projectedEstablishedLinks`, and canonical `linkCorrections`.
- `establishedLinks` shape: `Record<string, { individualId: number }>` containing base links whose external IDs are in the reviewed source population.
- `projectedEstablishedLinks` has the same shape after applying the complete correction set and seeds collision checks for new decisions.
- `buildReviewContext` receives base links/exclusions/holds for the staleness digest and established rows, plus projected links/exclusions/holds for candidate eligibility and identity entries.
- Produces `correctionScopeExternalIds(eligibleByBatch, batchId)`: for a batch review it returns only that batch's eligible external IDs, even though the combined reconciliation plan still considers every enabled batch; for authority-wide reviews with `batchId === null`, it returns an empty set and exposes no established-link editor.
- Produces internal orchestrator units `pipelineInputFromPreconditions(...)`, `acquireCompleteProviderSources(...)`, `loadChurchScopedProjectionInputs(...)`, `acquirePipelineState(...)`, and `computePipelineProjection(acquired, { linkCorrections })` so base and corrected plans reuse one provider fetch. The first two acquisition helpers are mechanical extractions of the existing source-fetch loop and church-scoped `Promise.all` reads from `runPipelineBody`; preserve their call order, connection/source fencing, and source-health writes.
- Extends the internal `buildReview` input with optional `linkCorrections` for focused projection tests; active GET routes continue calling it without that field.

- [ ] **Step 1: Write failing review-context tests**

```js
test('signs source-visible established links while eligibility uses the projected mapping', () => {
  const context = buildReviewContext({
    plan: emptyPlan(),
    externalPeople: [external('ext-a')],
    localPeople: [local(10), local(20)],
    basePersonLinks: [{ externalPersonId: 'ext-a', individualId: 10, missingFullSyncCount: 0 }],
    projectedPersonLinks: [{ externalPersonId: 'ext-a', individualId: 20, missingFullSyncCount: 0 }],
    sourceExternalIds: new Set(['ext-a']),
    linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
  });
  assert.deepEqual(context.establishedLinks, { 'ext-a': { individualId: 10 } });
  assert.equal(context.manualCandidateIndividualIds.includes(10), true);
  assert.equal(context.manualCandidateIndividualIds.includes(20), false);
  assert.equal(context.correctionContractVersion, 1);
});
```

Assert the local identity digest uses the base links, correction keys are canonical, and out-of-source durable links are omitted from `establishedLinks` while still participating in collision checks.

- [ ] **Step 2: Run review-context tests and verify failure**

Run: `cd server && node --test services/peopleSync/reviewContext.test.js`

Expected: FAIL because `establishedLinks` and `correctionContractVersion` are absent.

- [ ] **Step 3: Extend `buildReviewContext` without weakening the base-state digest**

```js
return {
  version: DECISION_CONTRACT_VERSION,
  correctionContractVersion: 1,
  manualCandidateIndividualIds: eligibleManualIds(input.localPeople, input.projectedPersonLinks),
  localIdentityDigest: buildLocalIdentityDigest({
    localPeople: input.localPeople,
    localFamilies: input.localFamilies,
    personLinks: input.basePersonLinks,
    exclusions: input.baseExclusions,
    holds: input.baseHolds,
  }),
  establishedLinks: establishedLinksForSource(input.basePersonLinks, input.sourceExternalIds),
  projectedEstablishedLinks: establishedLinksForSource(input.projectedPersonLinks, input.sourceExternalIds),
  linkCorrections: canonicalLinkCorrections(input.linkCorrections),
  identities,
};
```

Keep `buildReviewDirectory` returning every local person for the picker. `matchEligible` continues to describe the projected mapping, while correction validation remains server-authoritative.

- [ ] **Step 4: Write failing corrected-projection tests in `orchestrator.test.js` and `plan.test.js`**

Cover these exact effects:

```js
test('a relink projection computes managed changes against the new local person from one provider read', async () => {
  const { deps, providerReads } = correctionDeps({
    external: person('ext-a', { firstName: 'Correct', lastName: 'Name' }),
    locals: [local(10, 'Wrong', 'Target'), local(20, 'Old', 'Name')],
    links: [link('ext-a', 10)],
  });
  const review = await buildReview({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    trigger: 'manual',
    linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
  }, deps);
  assert.equal(providerReads.length, 1);
  assert.deepEqual(review.plan.updateManagedFields[0].individualId, 20);
});
```

Also assert that unlink suppresses link/add/lifecycle actions for that external identity, adds one display-only skipped action with reason `link_correction_deferred`, retains the external ID in presence accounting, and does not clear known values when the provider value is null.

- [ ] **Step 5: Run the focused projection tests and verify failure**

Run: `cd server && node --test services/peopleSync/reviewContext.test.js services/peopleSync/plan.test.js services/peopleSync/orchestrator.test.js`

Expected: FAIL because the pipeline cannot project corrected links.

- [ ] **Step 6: Split provider acquisition from match/plan projection and apply corrections in memory**

```js
async function acquirePipelineState(input) {
  const {
    snapshot, sourceProvenance, contextPeople, seenMemberExternalIds,
    ignoredLifecycleExternalIds, eligibleByBatch,
  } = await acquireCompleteProviderSources(input);
  const [individuals, families, personLinks, familyLinks, matchReviewState, gatheringMemberships] =
    await loadChurchScopedProjectionInputs(input.churchId, input.provider, input.deps);
  return {
    ...input, snapshot, sourceProvenance, contextPeople, seenMemberExternalIds,
    ignoredLifecycleExternalIds, eligibleByBatch, individuals, families,
    personLinks, familyLinks, matchReviewState, gatheringMemberships,
  };
}

function computePipelineProjection(acquired, { linkCorrections = {} } = {}) {
  const correction = validateAndProjectLinkCorrections({
    rawCorrections: linkCorrections,
    baseLinks: acquired.personLinks,
    sourceExternalIds: correctionScopeExternalIds(acquired.eligibleByBatch, acquired.batchId),
    localIndividualIds: new Set(acquired.individuals.map(({ id }) => Number(id))),
  });
  const effectiveReviewState = applyCorrectionReviewState(acquired.matchReviewState, correction);
  const matcherResult = matchProjectedPeople(acquired, correction, effectiveReviewState);
  const plan = computeProjectedPlan(acquired, correction, matcherResult);
  return { ...acquired, correction, matcherResult, plan };
}
```

Filter `unlinkedExternalIds` from matcher input only; do not remove them from the complete source snapshot or `seenMemberExternalIds`. Append the friendly skipped action after plan computation. Build `reviewContext` with base links/state for staleness and projected links/state for eligibility and downstream planning.

- [ ] **Step 7: Run the projection tests and the complete orchestrator suite**

Run: `cd server && node --test services/peopleSync/reviewContext.test.js services/peopleSync/plan.test.js services/peopleSync/orchestrator.test.js`

Expected: PASS, including all pre-existing source-health, authority, and lifecycle race tests.

- [ ] **Step 8: Commit projected planning**

```bash
git add server/services/peopleSync/reviewContext.js server/services/peopleSync/reviewContext.test.js server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/plan.js server/services/peopleSync/plan.test.js
git commit -m "feat(sync): project corrected identity mappings"
```

---

### Task 3: Correction-preview orchestration and signed-token lifecycle

**Files:**
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/planDigest.test.js`

**Interfaces:**
- Consumes: `acquirePipelineState` and `computePipelineProjection` from Task 2.
- Produces: `previewLinkCorrections({ churchId, provider, batchId, baseReviewToken, linkCorrections })`.
- Returns: `{ reviewToken, decisionContractVersion: 2, summary, coverage, plan, snapshot }`; it deliberately has no new audit `runId`.
- `applyReviewed` reads `selections.linkCorrections || {}` before rebuilding the final plan.

- [ ] **Step 1: Write failing preview-token tests**

```js
test('correction preview verifies the base review then signs the corrected plan without another provider read', async () => {
  const { deps, providerReads, started } = correctionPreviewDeps();
  const preview = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken,
    linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
  }, deps);
  assert.equal(providerReads.length, 1);
  assert.equal(started.length, 0, 'interactive correction previews must not create audit-run noise');
  assert.match(preview.reviewToken, /^review:/);
  assert.equal(preview.plan.reviewContext.linkCorrections[0].individualId, 20);
});
```

Add tests for invalid/expired/stale base tokens, source changes, local-link changes, invalid corrections, deterministic corrected digests, and a corrected apply token becoming stale if the submitted correction set differs.

- [ ] **Step 2: Run preview-token tests and verify failure**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/planDigest.test.js`

Expected: FAIL because `previewLinkCorrections` is not exported.

- [ ] **Step 3: Implement preview without creating a sync-run audit row**

```js
async function previewLinkCorrections({ churchId, provider, batchId, baseReviewToken, linkCorrections } = {}, overrides = {}) {
  const deps = mergeDeps(overrides);
  const pre = await loadPreconditions({ churchId, provider, batchId, deps });
  const acquired = await acquirePipelineState(pipelineInputFromPreconditions(pre, {
    churchId, provider, batchId, trigger: 'manual',
  }));
  const base = computePipelineProjection(acquired, { linkCorrections: {} });
  const baseDigest = deps.digestPlan(base.plan);
  const baseVerification = deps.verifyReviewToken(baseReviewToken, {
    churchId, provider, batchId, planDigest: baseDigest,
  });
  if (!baseVerification.ok) {
    throw new OrchestratorError(
      baseVerification.code,
      reviewTokenErrorMessage(baseVerification.code),
      reviewTokenErrorStatus(baseVerification.code),
    );
  }
  const corrected = computePipelineProjection(acquired, { linkCorrections });
  const correctedDigest = deps.digestPlan(corrected.plan);
  const reviewToken = deps.createReviewToken({
    churchId, provider, batchId, planDigest: correctedDigest,
    expiresInSeconds: REVIEW_TOKEN_TTL_SECONDS,
  });
  return {
    reviewToken,
    decisionContractVersion: DECISION_CONTRACT_VERSION,
    summary: summarizePlan(corrected.plan),
    coverage: reviewCoverage(corrected.matcherResult, corrected.individuals),
    plan: sanitizePlanForReview(
      corrected.plan, corrected.externalPeople, corrected.individuals,
      corrected.snapshot.families, corrected.families,
    ),
    snapshot: { fetchedAt: corrected.plan.snapshot.fetchedAt, mode: corrected.plan.snapshot.mode },
  };
}
```

Use the existing `SYNC_REVIEW_INVALID`, `SYNC_REVIEW_EXPIRED`, and `SYNC_PLAN_STALE` codes. Validate the base token before accepting a correction, and sign the canonical corrections inside the corrected plan digest.

- [ ] **Step 4: Rebuild corrected plans during apply**

In `applyReviewed`, pass `selections.linkCorrections || {}` to `computePipelineProjection` before calculating `planDigest`. Verify the submitted review token against that corrected digest. An old base token remains valid only when the correction set is empty.

- [ ] **Step 5: Run focused and complete orchestrator tests**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/planDigest.test.js`

Expected: PASS.

- [ ] **Step 6: Commit signed correction previews**

```bash
git add server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/planDigest.test.js
git commit -m "feat(sync): sign established link previews"
```

---

### Task 4: Atomic correction apply and PCO compatibility IDs

**Files:**
- Modify: `server/services/peopleSync/linkRepository.js`
- Modify: `server/services/peopleSync/linkRepository.dbintegration.test.js`
- Modify: `server/services/peopleSync/identityDecisions.js`
- Modify: `server/services/peopleSync/identityDecisions.test.js`
- Modify: `server/services/peopleSync/apply.js`
- Modify: `server/services/peopleSync/apply.test.js`
- Modify: `server/services/peopleSync/apply.dbintegration.test.js`

**Interfaces:**
- Produces: `applyPersonLinkCorrectionsWithConnection(conn, { churchId, provider, corrections })` in `linkRepository.js`.
- Produces: `validateSignedLinkCorrections(version, signedCorrections, submittedCorrections)` in `identityDecisions.js`; it canonicalizes both values and rejects any mismatch.
- Extends accepted V2 selections with `linkCorrections`, `correctionExclusionsToAdd`, `correctionHoldsToUpsert`, and `correctionHoldsToDelete` derived only from the signed context.
- `PeopleSyncSelections.linkCorrections` is the same keyed record submitted to correction preview.

- [ ] **Step 1: Write failing repository transaction tests**

```js
test('explicit PCO relinks clear old compatibility IDs before inserting final links', async () => {
  await applyPersonLinkCorrectionsWithConnection(conn, {
    churchId, provider: 'planning_center',
    corrections: [
      { externalPersonId: 'pco-a', fromIndividualId: firstId, outcome: 'relink', individualId: secondId },
      { externalPersonId: 'pco-b', fromIndividualId: secondId, outcome: 'relink', individualId: firstId },
    ],
  });
  assert.deepEqual(await personLinkPairs(churchId, 'planning_center'), [
    ['pco-a', secondId], ['pco-b', firstId],
  ]);
  assert.deepEqual(await pcoIds(firstId, secondId), ['pco-b', 'pco-a']);
});
```

Cover guarded old-link mismatch, church isolation, target uniqueness, unlink clearing `planning_center_id`, Elvanto leaving the compatibility column untouched, and complete rollback after an insert failure.

- [ ] **Step 2: Run repository integration tests and verify failure**

Run: `cd server && node --test services/peopleSync/linkRepository.dbintegration.test.js`

Expected: FAIL because the correction method is absent.

- [ ] **Step 3: Implement delete-all-then-insert correction semantics**

```js
async function applyPersonLinkCorrectionsWithConnection(conn, { churchId, provider, corrections }) {
  await assertExactBasePairs(conn, churchId, provider, corrections);
  for (const correction of corrections) {
    await conn.query(`DELETE FROM external_person_links
      WHERE church_id = ? AND provider = ? AND external_person_id = ? AND individual_id = ?`,
    [churchId, provider, correction.externalPersonId, correction.fromIndividualId]);
    if (provider === 'planning_center') {
      await conn.query(`UPDATE individuals SET planning_center_id = NULL, updated_at = datetime('now')
        WHERE church_id = ? AND id = ? AND planning_center_id = ?`,
      [churchId, correction.fromIndividualId, correction.externalPersonId]);
    }
  }
  for (const correction of corrections.filter(({ outcome }) => outcome === 'relink')) {
    await upsertPersonLinkWithConnection(conn, {
      churchId, provider, externalPersonId: correction.externalPersonId,
      individualId: correction.individualId, linkSource: 'manual',
    });
    await setPlanningCenterCompatibilityId(conn, churchId, provider, correction);
  }
}
```

Keep ordinary `upsertPersonLinkWithConnection` collision-strict.

- [ ] **Step 4: Write failing selection-validation tests**

Assert apply rejects corrections not byte-equivalent after canonicalization to `plan.reviewContext.linkCorrections`, rejects correction fields when `correctionContractVersion !== 1`, seeds identity claims from the projected established mapping, and permits a newly freed local person to be selected by another reviewed identity.

- [ ] **Step 5: Run selection tests and verify failure**

Run: `cd server && node --test services/peopleSync/identityDecisions.test.js services/peopleSync/apply.test.js`

Expected: FAIL because V2 validation does not consume signed link corrections.

- [ ] **Step 6: Extend V2 validation with the optional correction contract**

```js
const acceptedCorrections = validateSignedLinkCorrections(
  context.correctionContractVersion,
  context.linkCorrections,
  selections.linkCorrections,
);
const claimedIndividualIds = new Set(
  Object.values(context.projectedEstablishedLinks || {}).map(({ individualId }) => individualId),
);
```

Implement the validator as:

```js
function validateSignedLinkCorrections(version, signedCorrections, submittedCorrections) {
  const signed = canonicalLinkCorrections(version === 1 ? signedCorrections : {});
  const submitted = canonicalLinkCorrections(submittedCorrections || {});
  if (JSON.stringify(signed) !== JSON.stringify(submitted)) {
    throw new Error('Established-link corrections do not match the signed review preview');
  }
  return signed;
}
```

After equality validation, derive correction effects only from that returned canonical array:

```js
const correctionExclusionsToAdd = linkCorrections.map(({ externalPersonId, fromIndividualId }) => ({
  externalPersonId, individualId: fromIndividualId,
}));
const correctionHoldsToUpsert = linkCorrections
  .filter(({ outcome }) => outcome === 'unlink')
  .map(({ externalPersonId }) => ({ externalPersonId, reason: 'pair_rejected' }));
const correctionHoldsToDelete = linkCorrections
  .filter(({ outcome }) => outcome === 'relink')
  .map(({ externalPersonId }) => externalPersonId);
```

Do not permit arbitrary correction IDs from the client. Return the exclusions/holds already derived from the canonical signed correction projection.

- [ ] **Step 7: Write failing end-to-end apply integration tests**

Cover in one transaction:

- old link deletion and new link creation;
- old exact-pair exclusion;
- hold deletion after relink and `pair_rejected` hold after unlink;
- managed name/child/people-type and family/gathering effects targeting the new person;
- old LMPG attendance and notes remaining unchanged;
- null provider values not clearing known local values;
- PCO compatibility IDs moving with the provider identity;
- source promotion and authority expectations still committing with the correction; and
- rollback of every link, exclusion, hold, managed field, and compatibility-ID mutation when a later action fails.

- [ ] **Step 8: Apply corrections before person-link and managed-action loops**

```js
await linkRepository.applyPersonLinkCorrectionsWithConnection(conn, {
  churchId, provider, corrections: accepted.linkCorrections,
});
await applyCorrectionReviewState(conn, {
  churchId, provider, accepted, userId,
});
// Existing accepted new links, additions, managed updates, lifecycle,
// gathering changes, source promotion, and authority activation follow.
```

Keep the operation inside the existing `Database.transactionForChurch` callback and after all expectation/token/local-digest checks.

- [ ] **Step 9: Run all correction/apply tests**

Run: `cd server && node --test services/peopleSync/linkRepository.dbintegration.test.js services/peopleSync/identityDecisions.test.js services/peopleSync/apply.test.js services/peopleSync/apply.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 10: Commit atomic apply support**

```bash
git add server/services/peopleSync/linkRepository.js server/services/peopleSync/linkRepository.dbintegration.test.js server/services/peopleSync/identityDecisions.js server/services/peopleSync/identityDecisions.test.js server/services/peopleSync/apply.js server/services/peopleSync/apply.test.js server/services/peopleSync/apply.dbintegration.test.js
git commit -m "feat(sync): apply link corrections atomically"
```

---

### Task 5: Provider routes and typed client API

**Files:**
- Modify: `server/routes/integrations/planningCenterPeopleSync.js`
- Modify: `server/routes/integrations/planningCenterPeopleSync.test.js`
- Modify: `server/routes/integrations/elvanto.js`
- Modify: `server/routes/integrations/elvanto.test.js`
- Modify: `client/src/components/peopleSync/types.ts`
- Modify: `client/src/services/api.ts`

**Interfaces:**
- Produces: `POST /integrations/{provider}/sync-batches/:id/preview-link-corrections`.
- Request: `{ baseReviewToken: string, linkCorrections: Record<string, EstablishedLinkCorrection> }`.
- Response: `{ success: true } & PeopleSyncCorrectionPreview`.
- Adds `EstablishedLinkCorrection`, `PeopleSyncEstablishedLink`, `PeopleSyncCorrectionPreview`, and optional `PeopleSyncSelections.linkCorrections` client types.
- Adds `previewPlanningCenterLinkCorrections(...)` and `elvantoSyncAPI.previewLinkCorrections(...)`.

- [ ] **Step 1: Write failing PCO and Elvanto route tests**

```js
const preview = await requestJson(`${base}/sync-batches/12/preview-link-corrections`, {
  method: 'POST',
  body: {
    baseReviewToken: 'base-review',
    linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
  },
});
assert.equal(preview.status, 200);
assert.deepEqual(calls[0], {
  churchId: ADMIN.church_id, provider: 'planning_center', batchId: 12,
  baseReviewToken: 'base-review',
  linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
});
```

For both providers, assert admin/church middleware remains active, unsafe batch IDs are rejected, missing base tokens return `SYNC_REVIEW_TOKEN_REQUIRED`, non-object corrections return 400, timeout handling matches plan/apply, and orchestrator error codes pass through.

- [ ] **Step 2: Run route tests and verify failure**

Run: `cd server && node --test routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js`

Expected: FAIL with 404 for the preview route.

- [ ] **Step 3: Add the route to each provider router**

```js
router.post('/sync-batches/:id/preview-link-corrections', async (req, res) => {
  const batchId = parseBatchId(req.params.id);
  const baseReviewToken = typeof req.body?.baseReviewToken === 'string'
    ? req.body.baseReviewToken.trim() : '';
  if (batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
  if (!baseReviewToken) {
    return res.status(400).json({
      error: 'A base review token is required.',
      code: 'SYNC_REVIEW_TOKEN_REQUIRED',
    });
  }
  if (!isPlainObject(req.body?.linkCorrections)) {
    return res.status(400).json({
      error: 'Link corrections must be an object.',
      code: 'SYNC_SELECTIONS_INVALID',
    });
  }
  const result = await withTimeout(deps.previewLinkCorrections({
    churchId: req.user.church_id, provider: PROVIDER, batchId,
    baseReviewToken, linkCorrections: req.body.linkCorrections,
  }), deps.routeTimeoutMs);
  return res.json({ success: true, ...result });
});
```

Use each file's established error responder and add `previewLinkCorrections` to `defaultDeps`.

- [ ] **Step 4: Run route tests and verify success**

Run: `cd server && node --test routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js`

Expected: PASS.

- [ ] **Step 5: Add exact client contracts and API methods**

```ts
export type EstablishedLinkCorrection =
  | { outcome: 'relink'; fromIndividualId: number; individualId: number }
  | { outcome: 'unlink'; fromIndividualId: number };

export interface PeopleSyncEstablishedLink {
  individualId: number;
}

export interface PeopleSyncReviewContext {
  version: 2;
  correctionContractVersion?: 1;
  establishedLinks?: Record<string, PeopleSyncEstablishedLink>;
  projectedEstablishedLinks?: Record<string, PeopleSyncEstablishedLink>;
  linkCorrections?: Array<{ externalPersonId: string } & EstablishedLinkCorrection>;
  manualCandidateIndividualIds: number[];
  identities: Record<string, IdentityReviewEntry>;
}

export type PeopleSyncCorrectionPreview = Omit<PeopleSyncReview, 'runId'>;
```

Add `linkCorrections?: Record<string, EstablishedLinkCorrection>` to `PeopleSyncSelections`. Do not use `any` in `types.ts`.

- [ ] **Step 6: Run TypeScript build and route tests**

Run: `cd client && npm run build`

Expected: PASS.

Run: `cd server && node --test routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js`

Expected: PASS.

- [ ] **Step 7: Commit transport contracts**

```bash
git add server/routes/integrations/planningCenterPeopleSync.js server/routes/integrations/planningCenterPeopleSync.test.js server/routes/integrations/elvanto.js server/routes/integrations/elvanto.test.js client/src/components/peopleSync/types.ts client/src/services/api.ts
git commit -m "feat(sync): expose link correction previews"
```

---

### Task 6: Client review-state, rows, search, filters, and pagination

**Files:**
- Modify: `client/src/components/peopleSync/syncSelections.ts`
- Modify: `client/src/components/peopleSync/syncSelections.test.ts`
- Create: `client/src/components/peopleSync/syncReviewModel.ts`
- Create: `client/src/components/peopleSync/syncReviewModel.test.ts`

**Interfaces:**
- Extends `SyncSelectionState` with `linkCorrections: Record<string, EstablishedLinkCorrection>`.
- Produces: `buildDecisionRows(review, state)`, `buildEstablishedRows(review, state)`, `filterReviewRows(rows, query, filter)`, `paginateReviewRows(rows, page, pageSize)`, `mergeSelectionsForPreview(previous, nextReview)`, `isReviewDirty(initial, current)`, and `selectedChangeCount(review, state)`.
- Row status union: `'needs_attention' | 'matched' | 'adding' | 'skipped' | 'established' | 'corrected'`.

- [ ] **Step 1: Write failing selection-state tests**

```ts
it('serializes canonical link corrections with V2 identity decisions', () => {
  const state = stateWith({
    linkCorrections: {
      'ext-b': { outcome: 'unlink', fromIndividualId: 20 },
      'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 30 },
    },
  });
  expect(buildSyncSelections(state).linkCorrections).toEqual({
    'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 30 },
    'ext-b': { outcome: 'unlink', fromIndividualId: 20 },
  });
});
```

Assert initialization has `{}`, refresh resets corrections, dirty comparison ignores pagination/search state, and a correction preview preserves still-valid identity decisions by external ID but clears decisions invalid under the new signed context.

- [ ] **Step 2: Write failing row-model tests**

Build a 55-row fixture and assert:

- suggested matches, proposed additions, unresolved identities, and deferred identities receive the correct status;
- established links never appear in `buildDecisionRows`;
- only source-visible `establishedLinks` appear in `buildEstablishedRows`;
- a relink row displays its projected target and an unlink row displays `Skipped for now`;
- search matches provider person, provider household member, LMPG person, and LMPG family member;
- **Needs attention**, **Matched**, **Adding**, and **Skipped** filters operate before pagination;
- page 1 has 50 rows and page 2 has 5;
- changing the query/filter clamps the page to 1; and
- filter counts describe all filtered state, not one page.

- [ ] **Step 3: Run model tests and verify failure**

Run: `cd client && npm test -- src/components/peopleSync/syncSelections.test.ts src/components/peopleSync/syncReviewModel.test.ts`

Expected: FAIL because the row model and correction state do not exist.

- [ ] **Step 4: Implement deterministic state and pure table derivation**

```ts
export function paginateReviewRows<T>(rows: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), page: safePage, totalPages };
}

export function normalizedSearchText(row: ReviewIdentityRow): string {
  return [row.externalPerson, row.externalFamily, row.localPerson, row.localFamily]
    .flatMap(searchableIdentityText)
    .join(' ')
    .normalize('NFKD')
    .toLocaleLowerCase();
}
```

Use `personDisplayName` and family-member names already present in the review directory. Keep all functions pure so table tests do not need DOM rendering.

- [ ] **Step 5: Run model tests and verify success**

Run: `cd client && npm test -- src/components/peopleSync/syncSelections.test.ts src/components/peopleSync/syncReviewModel.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit client review model**

```bash
git add client/src/components/peopleSync/syncSelections.ts client/src/components/peopleSync/syncSelections.test.ts client/src/components/peopleSync/syncReviewModel.ts client/src/components/peopleSync/syncReviewModel.test.ts
git commit -m "feat(sync): model paginated review rows"
```

---

### Task 7: Accessible identity and correction dialogs

**Files:**
- Create: `client/src/components/peopleSync/PeoplePickerDialog.tsx`
- Create: `client/src/components/peopleSync/PeoplePickerDialog.test.tsx`
- Create: `client/src/components/peopleSync/IdentityRemovalDialog.tsx`
- Create: `client/src/components/peopleSync/IdentityRemovalDialog.test.tsx`
- Create: `client/src/components/peopleSync/EstablishedLinkDialog.tsx`
- Create: `client/src/components/peopleSync/EstablishedLinkDialog.test.tsx`

**Interfaces:**
- Produces `PeoplePickerDialog({ open, externalId, directory, availableIndividualIds, claimedBy, allowCreate, selectedIndividualId, excludedIndividualIds, onSelectPerson, onSelectCreate, onClose })`.
- Produces `IdentityRemovalDialog({ open, externalName, pairedIndividualId, onRejectPair, onSkip, onClose })`.
- Produces `EstablishedLinkDialog({ open, externalId, currentIndividualId, directory, availableIndividualIds, claimedBy, onRelink, onUnlink, onClose })`.

- [ ] **Step 1: Write failing person-picker tests**

```tsx
await user.click(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
const dialog = screen.getByRole('dialog', { name: 'Choose an LMPG person for Alex Smith' });
await user.type(within(dialog).getByRole('searchbox'), 'Jones family');
expect(within(dialog).getByRole('button', { name: 'Select Alex Jones' })).toBeEnabled();
expect(within(dialog).getByText('Already selected for another provider person')).toBeVisible();
```

Cover name/family/member search, disabled durable and in-review claims, **Add new person**, previously excluded-pair confirmation, Escape close, focus return, and no raw IDs in visible copy.

- [ ] **Step 2: Write failing rejection/skip and established-link dialog tests**

Assert a paired decision offers exactly **Reject this match** and **Skip and ask again**; an addition offers only **Skip and ask again**; clicking × alone does not mutate state; established links offer **Change linked person** and **Unlink and review again**; and unlink copy states that unattended sync is held.

- [ ] **Step 3: Run dialog tests and verify failure**

Run: `cd client && npm test -- src/components/peopleSync/PeoplePickerDialog.test.tsx src/components/peopleSync/IdentityRemovalDialog.test.tsx src/components/peopleSync/EstablishedLinkDialog.test.tsx`

Expected: FAIL because the dialog components are absent.

- [ ] **Step 4: Implement dialogs with Headless UI**

```tsx
<Dialog open={open} onClose={busy ? () => undefined : onClose} className="relative z-50">
  <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
  <div className="fixed inset-0 overflow-y-auto p-4">
    <DialogPanel className="mx-auto max-w-2xl rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
      <DialogTitle>{title}</DialogTitle>
      {children}
    </DialogPanel>
  </div>
</Dialog>
```

Use actual buttons for every selectable name. Let Headless UI manage focus trap/return, and explicitly focus the search input when the picker opens.

- [ ] **Step 5: Run dialog tests and verify success**

Run: `cd client && npm test -- src/components/peopleSync/PeoplePickerDialog.test.tsx src/components/peopleSync/IdentityRemovalDialog.test.tsx src/components/peopleSync/EstablishedLinkDialog.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit dialogs**

```bash
git add client/src/components/peopleSync/PeoplePickerDialog.tsx client/src/components/peopleSync/PeoplePickerDialog.test.tsx client/src/components/peopleSync/IdentityRemovalDialog.tsx client/src/components/peopleSync/IdentityRemovalDialog.test.tsx client/src/components/peopleSync/EstablishedLinkDialog.tsx client/src/components/peopleSync/EstablishedLinkDialog.test.tsx
git commit -m "feat(sync): add identity correction dialogs"
```

---

### Task 8: Responsive identity review table

**Files:**
- Create: `client/src/components/peopleSync/IdentityReviewTable.tsx`
- Create: `client/src/components/peopleSync/IdentityReviewTable.test.tsx`
- Modify: `client/src/components/peopleSync/PersonIdentitySummary.tsx`
- Create: `client/src/components/peopleSync/PersonIdentitySummary.test.tsx`

**Interfaces:**
- Consumes row/model functions from Task 6 and dialogs from Task 7.
- Produces `IdentityReviewTable({ review, state, onStateChange, onPreviewCorrections, previewing })`.
- `onPreviewCorrections(corrections)` returns `Promise<PeopleSyncReview>` and is called only after an established correction changes.
- Exposes `focusExternalId(externalId)` through a ref so apply guidance can move to an affected row.

- [ ] **Step 1: Write failing desktop and mobile rendering tests**

```tsx
expect(screen.getByRole('columnheader', { name: 'Integration source name' })).toBeVisible();
expect(screen.getByRole('columnheader', { name: 'Integration source family/household' })).toBeVisible();
expect(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' })).toBeVisible();
expect(screen.getByRole('button', { name: 'Remove matching decision for Alex Smith' })).toHaveTextContent('×');
expect(screen.getByTestId('mobile-identity-row-ext-a')).toHaveClass('md:hidden');
expect(screen.getByTestId('desktop-identity-table')).toHaveClass('hidden', 'md:table');
```

Assert abbreviated family member context, explicit no-family/unavailable labels, tab separation, counts, search, filters, 50-row pagination, rows-per-page selection, retained off-page decisions, × modal actions, Add → Match, Match → Add, established relink/unlink, preview loading/error/retry, and disabled correction targets.

- [ ] **Step 2: Run table tests and verify failure**

Run: `cd client && npm test -- src/components/peopleSync/IdentityReviewTable.test.tsx src/components/peopleSync/PersonIdentitySummary.test.tsx`

Expected: FAIL because the table component is absent.

- [ ] **Step 3: Add compact family text shared by desktop and mobile rows**

```tsx
export function FamilyContext({ family }: { family?: PeopleSyncFamilyDisplay }) {
  if (!family || family.state === 'unavailable') return <span>Household unavailable</span>;
  if (family.state === 'none') return <span>No family</span>;
  const preview = family.members.map(personDisplayName).join(', ');
  return <><span>{family.name || 'Unnamed family'}</span>{preview && <span>{preview}</span>}</>;
}
```

Pass provider/local fallback wording as a prop so source rows may say `No household` while local rows say `No family`.

- [ ] **Step 4: Implement table state and both responsive renderers**

Render one semantic desktop `<table>` and a separate narrow-screen `<ul>` of labelled comparison groups. Do not wrap the desktop table in horizontal overflow. Use one shared row-action handler so desktop/mobile decisions cannot diverge.

- [ ] **Step 5: Wire established corrections to signed-preview replacement**

```tsx
const commitCorrection = async (externalId: string, correction: EstablishedLinkCorrection) => {
  const nextCorrections = { ...state.linkCorrections, [externalId]: correction };
  onStateChange({ ...state, linkCorrections: nextCorrections });
  try {
    const nextReview = await onPreviewCorrections(nextCorrections);
    onStateChange(mergeSelectionsForPreview({ ...state, linkCorrections: nextCorrections }, nextReview));
  } catch (error) {
    setCorrectionError({ externalId, error });
  }
};
```

Use a request-generation ref or `AbortController` so a late preview cannot replace a newer correction. Preserve the draft correction on preview failure, disable apply through parent state, and offer **Retry preview** and **Revert correction**.

- [ ] **Step 6: Run table tests and verify success**

Run: `cd client && npm test -- src/components/peopleSync/IdentityReviewTable.test.tsx src/components/peopleSync/PersonIdentitySummary.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the responsive table**

```bash
git add client/src/components/peopleSync/IdentityReviewTable.tsx client/src/components/peopleSync/IdentityReviewTable.test.tsx client/src/components/peopleSync/PersonIdentitySummary.tsx client/src/components/peopleSync/PersonIdentitySummary.test.tsx
git commit -m "feat(sync): render responsive identity table"
```

---

### Task 9: Compact shared review and bottom-only apply

**Files:**
- Create: `client/src/components/peopleSync/SyncPlanSections.tsx`
- Create: `client/src/components/peopleSync/SyncPlanSections.test.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.tsx`
- Modify: `client/src/components/peopleSync/SyncReview.test.tsx`
- Delete: `client/src/components/peopleSync/MatchDecisionCard.tsx`

**Interfaces:**
- Consumes: `IdentityReviewTable` from Task 8.
- Extends `SyncReviewProps` with `batchName`, `sourceName`, `onPreviewCorrections`, and `onDirtyChange`.
- `onPreviewCorrections(baseReviewToken, corrections)` returns `Promise<PeopleSyncCorrectionPreview>`.
- `SyncReview` owns `baseReview`, `effectiveReview`, and selection state: correction previews always use `baseReview.reviewToken`, update only `effectiveReview`, and merge still-valid selections without triggering the ordinary external-refresh reset.
- Keeps legacy pre-V2 decision rendering isolated for stale cached reviews; current V2 reviews use the table.
- Produces `SyncPlanSections({ review, state, onStateChange })` for managed, family, gathering, archive/reactivation, and skipped sections.

- [ ] **Step 1: Replace card-oriented tests with failing compact-review assertions**

Update `SyncReview.test.tsx` to assert:

```tsx
expect(screen.getAllByRole('button', { name: /Apply .*selected changes|Apply sync/ })).toHaveLength(1);
expect(screen.getByRole('button', { name: 'Refresh plan' })).toBeInTheDocument();
expect(screen.queryByText('Accept suggested match')).not.toBeInTheDocument();
expect(screen.getByRole('table', { name: 'Identity decisions' })).toBeInTheDocument();
const destructive = screen.getByText(/destructive changes/i);
const apply = screen.getByRole('button', { name: 'Apply 3 selected changes' });
expect(destructive.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
```

Retain existing tests for malformed V2 fail-closed behavior, collisions, stale/already-applied errors, archive confirmations, source coverage notice, interaction-disabled state, review-token reset, and retry after a non-stale apply failure. Add correction-preview pending/failure/stale cases and `onDirtyChange` transitions.

- [ ] **Step 2: Run shared review tests and verify failure**

Run: `cd client && npm test -- src/components/peopleSync/SyncReview.test.tsx src/components/peopleSync/SyncPlanSections.test.tsx`

Expected: FAIL because the old header has an apply button and identity cards remain.

- [ ] **Step 3: Extract dense non-identity sections**

```tsx
<CompactSection title="Managed person updates" count={managedCount}>
  <DenseChangeList>{managedRows}</DenseChangeList>
</CompactSection>
<CompactSection title="Archives and reactivations" count={lifecycleCount} open={destructiveCount > 0} tone="amber">
  {lifecycleRows}
</CompactSection>
```

Omit empty sections, default routine sections closed, open decision/destructive sections, preserve per-archive and family-rename selections, and keep the overall destructive acknowledgement immediately above apply.

- [ ] **Step 4: Recompose `SyncReview` around compact chips, table, sections, and one final action**

```tsx
return <div className="space-y-5">
  <SyncReviewHeader provider={provider} batchName={batchName} sourceName={sourceName}
    fetchedAt={fetchedAt} counts={counts} onRefresh={guardedRefresh} />
  <IdentityReviewTable ref={tableRef} review={effectiveReview} state={state}
    onStateChange={setState} onPreviewCorrections={previewCorrections} previewing={previewing} />
  <SyncPlanSections review={effectiveReview} state={state} onStateChange={setState} />
  {destructiveConfirmation}
  {validationGuidance}
  <FinalApplyControls count={selectedChangeCount(effectiveReview, state)} onApply={submit} />
</div>;
```

The header refresh is small and secondary. Applying or accepting a successful refresh resets dirty state; pagination/search never affects it. The **Needs attention** shortcut selects that filter and focuses the first incomplete/colliding row.

Implement `previewCorrections` as a `SyncReview` callback that calls the page-supplied `onPreviewCorrections(baseReview.reviewToken, corrections)`, merges the returned correction preview with the retained `runId`, assigns it to `effectiveReview`, and returns it to `IdentityReviewTable`. A new `review` prop from an explicit provider refresh replaces both base/effective reviews and resets selections; a correction-preview token change does not.

- [ ] **Step 5: Remove the V2 card implementation and keep a local legacy renderer**

Delete `MatchDecisionCard.tsx` after all current V2 call sites use `IdentityReviewTable`. Keep only the pre-V2 compatibility controls inside `SyncReview.tsx`; they do not gain established-link correction support.

- [ ] **Step 6: Run shared review and dependent authority/onboarding tests**

Run: `cd client && npm test -- src/components/peopleSync/SyncReview.test.tsx src/components/peopleSync/SyncPlanSections.test.tsx src/components/peopleSync/PeopleSourceControl.test.tsx src/components/elvanto/ElvantoOnboarding.test.tsx src/components/planningCenter/PlanningCenterSyncReview.test.tsx`

Expected: PASS after updating assertions from cards/radios to table/picker interactions.

- [ ] **Step 7: Commit the shared review refactor**

```bash
git add client/src/components/peopleSync/SyncPlanSections.tsx client/src/components/peopleSync/SyncPlanSections.test.tsx client/src/components/peopleSync/SyncReview.tsx client/src/components/peopleSync/SyncReview.test.tsx client/src/components/peopleSync/MatchDecisionCard.tsx client/src/components/peopleSync/PeopleSourceControl.test.tsx client/src/components/elvanto/ElvantoOnboarding.test.tsx client/src/components/planningCenter/PlanningCenterSyncReview.test.tsx
git commit -m "feat(sync): streamline shared review workflow"
```

---

### Task 10: Dedicated provider-neutral batch review page

**Files:**
- Create: `client/src/components/peopleSync/batchReviewApi.ts`
- Create: `client/src/components/peopleSync/batchReviewApi.test.ts`
- Create: `client/src/hooks/useUnsavedReviewGuard.ts`
- Create: `client/src/hooks/useUnsavedReviewGuard.test.tsx`
- Create: `client/src/pages/PeopleSyncBatchReviewPage.tsx`
- Create: `client/src/pages/PeopleSyncBatchReviewPage.test.tsx`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Route: `/app/settings/integrations/:provider/batches/:batchId/review`, where `provider` is `planning-center` or `elvanto`.
- Produces `batchReviewApi(provider)` with `listBatches`, `loadReview`, `previewCorrections`, `applyReview`, and `returnTo`.
- Produces `useUnsavedReviewGuard({ dirty, onConfirmDiscard })` for before-unload, internal links, explicit back, and explicit refresh.

- [ ] **Step 1: Write failing provider-adapter tests**

```ts
expect(batchReviewApi('planning-center').returnTo)
  .toBe('/app/settings?tab=integrations&integration=planning-center');
await batchReviewApi('elvanto').previewCorrections(7, 'base-token', corrections);
expect(elvantoSyncAPI.previewLinkCorrections).toHaveBeenCalledWith(7, {
  baseReviewToken: 'base-token', linkCorrections: corrections,
});
```

Assert invalid provider slugs produce no adapter and both providers normalize API responses to the same functions.

- [ ] **Step 2: Write failing navigation-guard tests**

Cover clean navigation without a prompt, dirty internal anchor clicks, page back, plan refresh, browser `beforeunload`, confirm/discard, cancel/stay, and removal of listeners after apply/unmount. Use a captured click listener rather than migrating the app from `BrowserRouter` to a data router solely for `useBlocker`.

- [ ] **Step 3: Write failing page tests**

Use `createMemoryRouter` with the real route and assert:

- admin-only route rendering inside the existing `Layout` route tree;
- invalid provider or batch ID returns to integrations with an error;
- batch metadata and active/draft source name load beside the review;
- reload at the route reconstructs provider and batch context;
- load error retains retry/back actions;
- correction previews always use the original base review token but replace the effective apply token;
- late plan/preview responses are ignored;
- dirty refresh/navigation prompts;
- stale apply requires refresh;
- successful apply navigates to the provider integration and shows `Sync applied successfully.` through `client/src/components/ToastContainer.tsx`; and
- apply success followed by metadata refresh failure remains a success with a warning toast.

- [ ] **Step 4: Run page/adapter/guard tests and verify failure**

Run: `cd client && npm test -- src/components/peopleSync/batchReviewApi.test.ts src/hooks/useUnsavedReviewGuard.test.tsx src/pages/PeopleSyncBatchReviewPage.test.tsx`

Expected: FAIL because the route page and helpers are absent.

- [ ] **Step 5: Implement the provider adapter and navigation guard**

```ts
export function batchReviewApi(provider: SyncProvider): BatchReviewAdapter {
  return provider === 'planning_center' ? planningCenterAdapter : elvantoAdapter;
}

export function useUnsavedReviewGuard({ dirty, confirmDiscard }: GuardOptions) {
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const internalLink = (event: MouseEvent) => guardInternalAnchor(event, dirty, confirmDiscard);
    const popState = () => guardHistoryNavigation(dirty, confirmDiscard);
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('popstate', popState);
    document.addEventListener('click', internalLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('popstate', popState);
      document.removeEventListener('click', internalLink, true);
    };
  }, [dirty, confirmDiscard]);
}
```

The hook returns `confirmAction(action)` for the page's back and refresh buttons. `guardHistoryNavigation` uses the native confirmation for same-document browser back/forward and restores the prior history entry when the administrator cancels. Do not intercept modified clicks, downloads, `_blank`, same-page hash changes, or external origins.

- [ ] **Step 6: Implement the page and admin route**

```tsx
<Route path="settings/integrations/:provider/batches/:batchId/review" element={
  <RoleProtectedRoute allowedRoles={['admin']}>
    <PeopleSyncBatchReviewPage />
  </RoleProtectedRoute>
} />
```

Load batch metadata and the base review with request-generation fencing. Pass `batch.name`, `(batch.draftSource || batch.source)?.name`, provider callbacks, and dirty-state reporting into `SyncReview`. `SyncReview` retains the base token and effective correction preview as defined in Task 9; the page callback only normalizes the provider API response and returns it.

After apply succeeds, call `showSuccess('Sync applied successfully.')`, attempt one provider batch-list refresh, and navigate to `adapter.returnTo`. If that post-apply metadata refresh fails, keep the successful result, call `showWarning('Sync applied, but the latest batch status could not be loaded.')`, and still navigate.

- [ ] **Step 7: Run page/adapter/guard tests and verify success**

Run: `cd client && npm test -- src/components/peopleSync/batchReviewApi.test.ts src/hooks/useUnsavedReviewGuard.test.tsx src/pages/PeopleSyncBatchReviewPage.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit the dedicated page**

```bash
git add client/src/components/peopleSync/batchReviewApi.ts client/src/components/peopleSync/batchReviewApi.test.ts client/src/hooks/useUnsavedReviewGuard.ts client/src/hooks/useUnsavedReviewGuard.test.tsx client/src/pages/PeopleSyncBatchReviewPage.tsx client/src/pages/PeopleSyncBatchReviewPage.test.tsx client/src/App.tsx
git commit -m "feat(sync): add dedicated batch review page"
```

---

### Task 11: Integration-panel navigation and end-to-end regression

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/ElvantoIntegrationPanel.test.tsx`
- Modify: `client/src/components/integrations/IntegrationsTab.tsx`
- Modify: `client/src/components/integrations/IntegrationsTab.test.tsx`
- Modify: `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`
- Modify: `client/src/components/planningCenter/PlanningCenterSyncReview.test.tsx`
- Modify: `client/src/pages/OnboardingPage.tsx`
- Modify: `client/src/pages/OnboardingPage.integrations.test.tsx`

**Interfaces:**
- Consumes: dedicated route from Task 10.
- Integration return URL: `/app/settings?tab=integrations&integration=<provider-slug>`.
- `IntegrationsTab` reads the `integration` query parameter and opens the corresponding provider panel after status loading.

- [ ] **Step 1: Write failing panel-navigation tests**

```tsx
await user.click(await screen.findByRole('button', { name: 'Review & sync Members' }));
expect(mockNavigate).toHaveBeenCalledWith(
  '/app/settings/integrations/planning-center/batches/7/review',
);
expect(screen.queryByRole('region', { name: /Members sync review/ })).not.toBeInTheDocument();
```

Repeat for Elvanto. Assert the buttons remain available when unattended scheduling is off, no inline review fetch occurs, and batch edit/delete/source-draft controls retain their behavior.

- [ ] **Step 2: Write failing integration-query restoration tests**

Render `/app/settings?tab=integrations&integration=elvanto` and `/app/settings?tab=integrations&integration=planning-center`; assert the correct provider panel opens after statuses resolve. Assert an unknown integration query falls back to the integration card list.

- [ ] **Step 3: Run panel/integration tests and verify failure**

Run: `cd client && npm test -- src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/components/integrations/IntegrationsTab.test.tsx`

Expected: FAIL because **Review & sync** still expands inline.

- [ ] **Step 4: Replace inline review state with route navigation**

Use `useNavigate()` in both panels and remove `reviewingBatchId`, inline Elvanto review loading/apply state, and inline `PlanningCenterSyncReview` rendering. Keep `PlanningCenterSyncReview` as the onboarding wrapper only; update it to the bottom-only shared `SyncReview` API and add correction preview only if onboarding ever receives source-visible established links.

- [ ] **Step 5: Restore provider panels from the integration query**

```tsx
const integrationParam = new URLSearchParams(location.search).get('integration');
useEffect(() => {
  if (integrationParam === 'planning-center' || integrationParam === 'elvanto') {
    setSelected(integrationParam);
  }
}, [integrationParam]);
```

When a provider panel's **Back to integrations** is clicked, remove `integration` while retaining `tab=integrations`.

- [ ] **Step 6: Update retired onboarding compatibility tests**

The retired onboarding route remains unmounted, but its components must compile. Update assertions to the new shared table/picker and single bottom apply action; do not reintroduce an inline batch review into the active settings flow.

- [ ] **Step 7: Run all affected client tests**

Run: `cd client && npm test -- src/components/integrations/PlanningCenterIntegrationPanel.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/components/integrations/IntegrationsTab.test.tsx src/components/planningCenter/PlanningCenterSyncReview.test.tsx src/pages/OnboardingPage.integrations.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit panel navigation**

```bash
git add client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx client/src/components/integrations/ElvantoIntegrationPanel.tsx client/src/components/integrations/ElvantoIntegrationPanel.test.tsx client/src/components/integrations/IntegrationsTab.tsx client/src/components/integrations/IntegrationsTab.test.tsx client/src/components/planningCenter/PlanningCenterSyncReview.tsx client/src/components/planningCenter/PlanningCenterSyncReview.test.tsx client/src/pages/OnboardingPage.tsx client/src/pages/OnboardingPage.integrations.test.tsx
git commit -m "feat(sync): open reviews in dedicated workspace"
```

- [ ] **Step 9: Run the complete server people-sync and route suites**

Run: `cd server && node --test services/peopleSync/*.test.js routes/integrations/planningCenterPeopleSync.test.js routes/integrations/elvanto.test.js routes/integrations/peopleSync.test.js`

Expected: PASS with no cross-church, source-generation, connection-generation, authority, stale-token, or rollback regression.

- [ ] **Step 10: Run the complete client suite and production build**

Run: `cd client && npm test`

Expected: PASS.

Run: `cd client && npm run build`

Expected: PASS and service worker generation completes.

- [ ] **Step 11: Verify the development containers and perform the manual responsive smoke test**

Run: `docker-compose -f docker-compose.dev.yml up -d`

Expected: development services start successfully.

Run: `docker-compose -f docker-compose.dev.yml ps`

Expected: `client` and `server` report running status.

Manual checks at desktop and narrow mobile widths:

1. Open Planning Center and Elvanto batch lists and confirm **Review & sync** navigates to the dedicated content page while the LMPG sidebar remains.
2. Confirm the desktop columns and mobile comparison rows match the approved labels and do not scroll horizontally.
3. Search and filter a fixture with more than 50 decisions; change a decision on page 2 and confirm it survives navigation back to page 1.
4. Change **Add new person** to an LMPG match, change a suggested match, reject an exact pair, and skip an addition.
5. Search **Already linked**, relink one person, unlink another, and confirm the signed preview lists the target's managed changes before apply enables.
6. Attempt an implicit collision and confirm apply stays disabled; explicitly correct both rows and confirm the final mapping becomes valid.
7. Trigger refresh/back with dirty decisions and confirm cancel preserves state.
8. Confirm destructive sections precede the only **Apply sync** button.
9. Apply a correction and verify return to the correct provider panel with a success toast.

- [ ] **Step 12: Confirm the implementation handoff is clean**

```bash
git status --short
```

Expected: no unstaged or uncommitted implementation files. If a verification command required a correction, return to the task that owns that file, repeat its focused failing/passing test cycle, amend that task's implementation with a new focused commit, and rerun Steps 9–11 before handoff.
