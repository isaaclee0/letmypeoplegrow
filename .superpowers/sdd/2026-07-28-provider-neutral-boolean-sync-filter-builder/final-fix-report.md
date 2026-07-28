# Final whole-branch fix wave

## Phase 1: root-cause evidence and hypotheses

### Finding 1 — cold metadata and uncovered dimensions

Evidence traced through `filterBuilder.js`, `filterSnapshot.js`, both adapters, and `BatchFilterControls.tsx`:

- `dimensionsFromBatches()` returns only dimensions already used by active/draft/proposed filters. On the first empty refresh that set is empty.
- `captureFilterSnapshotInput()` passes that facts-coverage set to `buildFilterDimensions()`. Both adapters use it to suppress the dimension itself, not merely its observed counts. Therefore an empty first refresh caches `dimensions: []`, even though the same provider response contains intrinsic dimensions and custom-field definitions.
- Refresh validates the proposed filter against the previous cache before fetching metadata. A newly selected custom dimension absent from that cache is rejected before explicit discovery can run.
- Adapter metadata-backed values currently use `counts.get(value) || 0`; this reports an uncovered value as an exact zero instead of an unavailable count.
- `BatchFilterControls` renders Refresh only inside `FilterPreviewSummary`, which is mounted only after metadata GET succeeds. A cold 409 therefore offers only “Retry filter metadata”, which cannot provider-fetch by contract.

Hypothesis: dimension discovery and fact coverage have been conflated. The minimal correct boundary is to let explicit refresh discover all canonical provider dimensions from the same full snapshot/definition response, retain a narrower `coveredDimensionIds` set for facts, represent uncovered counts as `null`, and validate a proposed filter structurally before discovery then canonically against the newly captured metadata before cache replacement. Metadata GET/preview remain cache-only; refresh remains the single provider-fetching builder endpoint.

### Finding 2 — discarded initial draft becomes schedulable

Evidence traced through `batchRepository.js`, the draft-delete route, client controls, and `orchestrator.runUnattended()`:

- Schema-2 creation persists the canonical empty active sentinel at revision 1 plus an initial draft.
- `discardFilterDraft()` clears that draft unconditionally. The resulting row is enabled, schema 2, revision 1, canonical empty active, and has no `needsFilterReview` signal.
- The unattended guard checks only for a schema-2 draft. With the draft gone, it calls `startRun` and fetches the provider; an empty positive expression selects nobody and authoritative reconciliation can archive managed people.
- A legitimately reviewed empty/nobody filter is distinguishable: promotion increments `filter_revision` from 1 to 2 atomically.

Hypothesis: “initial review complete” needs an explicit invariant independent of draft presence. The deterministic invariant `schema 2 + revision 1 + canonical empty active` identifies the unpromoted sentinel. Expose it as `initialFilterReviewPending`, reject discarding its initial draft, hide that UI action, and independently block unattended execution before `startRun`/fetch. Promotion to revision 2 makes a reviewed empty filter runnable.

### Finding 3 — Planning Center master switch is ignored

Evidence traced through `settings.js`, `PlanningCenterIntegrationPanel.tsx`, `scheduler.js`, and `orchestrator.js`:

- The UI says “Master switch — turns all batches below on or off” and writes `church_settings.planning_center_sync_enabled`.
- The generic scheduler gates only on authority, due/enabled batch state, and connection status; it never reads that column.
- Manual review/apply and check-in import are separate routes and should remain available while scheduled sync is off.

Hypothesis: the column is an unattended Planning Center scheduling gate, not an authority replacement. Add one shared unattended-policy reader, apply it at scheduler dispatch and again in `runUnattended` before `startRun`, and leave Elvanto plus interactive flows unaffected. The existing authority check remains independently authoritative.

### Finding 4 — schema-2 PCO create validation gap

Evidence traced through `validateBatchBody()`, schema-2 update validation, and real HTTP routes:

- The v1 create branch and schema-2 update branch enforce weekly 0–6 and monthly 1–31; schema-2 create stops after checking that `scheduleDay` is an integer.
- Every branch accepts zero/negative/unsafe gathering IDs because it checks only `Number.isInteger`.
- Schema-2 create does not strictly allowlist fields; route IDs use a safe positive parser for PUT but DELETE lacks that check.

Hypothesis: duplicated validators drifted. Reuse shared schedule and nullable-positive-safe-ID validators across v1 create, schema-2 create, and schema-2 update; strictly allowlist exact typed create/update fields while retaining the documented v1 omission compatibility for `gatheringAutoRemoveEnabled`; and use the existing safe positive request-ID rule for every batch-id route.

## TDD evidence

### RED

- Finding 1: adapter tests failed because cold/uncovered dimensions were absent; route tests failed because first refresh returned empty metadata and a proposed uncovered custom dimension was rejected before discovery. The new cold-cache UI test failed because no provider-fetching refresh action was rendered.
- Finding 2: repository tests showed the initial draft could be discarded, route tests returned 500 instead of the typed 409, orchestrator tests started/fetched/applied revision-1 empty sentinels, and the UI exposed `Discard draft` for the initial review.
- Finding 3: scheduler and orchestrator tests showed Planning Center unattended runs still dispatched with `planning_center_sync_enabled = 0`.
- Finding 4: real HTTP tests showed schema-2 POST accepted weekly day 7, unsafe batch/gathering IDs reached repository lookup, and Planning Center plan/apply accepted an unsafe integer request ID.

### GREEN

- Finding 1 server adapter/route slice: 86/86 tests passed.
- Finding 1 client filter-builder slice: 22/22 tests passed.
- Finding 2 repository/route/orchestrator slice, including real SQLite: all targeted tests passed; the real-database orchestrator file passed 14/14.
- Finding 3 scheduler/orchestrator slice: 62/62 unit tests passed; scheduler tests including the real `church_settings` toggle passed 23/23.
- Finding 4 real HTTP/unit slice: 17/17 tests passed.
- Combined impacted server slice: 298/298 tests passed.
- Combined impacted client slice: 49/49 tests passed before the final fixture sweep.

## Final verification

- `node --test --test-concurrency=1` in `server`: 918/918 passed. A preceding parallel run had 913 assertions pass and one Node test-runner IPC deserialization failure at a file boundary; the affected file then passed 7/7 alone, and the complete serial run was clean.
- `npm test -- --run` in `client`: 166/166 passed.
- `npm run build` in `client`: production build passed. `client/public/sw.js` was restored after the build and retained SHA-256 `c7122c6cf971c0ea0b035f390683f58fbe7dc804e71a4ee78cc0f0f392f1e239` byte-for-byte.
- `git diff --check`: passed.
- `npx tsc --noEmit` is not a clean repository gate: TypeScript 6 first rejects the existing `moduleResolution=node10` deprecation, and with `--ignoreDeprecations 6.0` reports the existing router declaration, Axios mock, and legacy component typing baseline. New `initialFilterReviewPending` fixture omissions found in that output were corrected; the production build and full Vitest suite are green.

## Authorized correction wave

### Root-cause trace and hypothesis

- Explicit refresh accepted only `filterConfig`, so it had no authoritative target-batch identity and could not distinguish a persisted unresolved selection from a newly invented unknown pair.
- Preview and draft-save already derive `allowedUnresolvedPairs` from the church/provider-scoped target batch, but refresh's post-fetch canonical validation omitted that option. When a provider removed a saved value, refresh fetched successfully and then rejected the persisted selection; when it removed the whole dimension, `validateFilterV2` rejected before its unresolved-pair allowance could apply. With an expired/null old cache this made the editor's only provider-fetching recovery action permanently fail.
- The adapters correctly omit removed definitions/values from refreshed metadata. The filter builder already retains a selected missing dimension/value from the saved config and renders it as unavailable/removable, so the safe boundary is not to fabricate provider metadata. It is to allow only exact pairs proven to exist in the target batch's persisted active filter or persisted draft. New-batch, omitted-identity, and arbitrary request pairs remain strict.
- Both integration-panel list views key `Discard draft` only from `needsFilterReview`, bypassing the initial-review invariant already enforced by the editor and server.
- Planning Center's master-switch copy and row schedule label still describe all sync as enabled even though the implemented policy gates only unattended scheduling; manual Review & sync remains available.

Hypothesis: add an optional strict `batchId` to explicit refresh, resolve it with the existing church/provider-scoped repository boundary, union only that row's active/draft pairs into canonical validation, and teach canonical validation to retain an absent dimension only when every requested pair for it is explicitly allowed. Thread the editor's batch ID through both refresh controls. Then align list actions/copy with the existing initial-review and unattended-policy semantics.

### Correction-wave TDD evidence

#### RED

- Filter-engine regression: 7 tests passed and the new absent-dimension test failed because an exact persisted-pair allowance still returned `UNKNOWN_DIMENSION`.
- Real refresh-route/adapter regressions: 21 tests passed and 5 failed. Planning Center and Elvanto both rejected persisted removed dimensions/values, and the scoped-missing-batch case returned the wrong status before identity lookup was implemented.
- Client regressions: 43 tests passed and 7 failed across existing-batch identity threading, unresolved refreshed metadata rendering/removal, initial-draft list actions, and Planning Center master-switch wording/status.
- An added unsafe-identity regression then proved that a numeric string (`"7"`) reached batch lookup; strict numeric validation made that case fail closed before provider access.

#### GREEN

- Filter engine plus real refresh routes/adapters: 34/34 tests passed. The provider tests mock only the external fetch boundary and exercise both production adapters.
- Combined server people-sync/Elvanto/filter-builder impact slice: 396/396 tests passed.
- Combined client controls/builder/integration-panel slice: 51/51 tests passed.
- Removed-dimension and removed-value cases now refresh successfully only with the exact church/provider-scoped persisted pair. No identity, a missing batch, partial allowances, newly invented pairs, non-positive/fractional/unsafe IDs, and numeric strings remain rejected. Failed validation preserves the previous cache, and successful responses expose only safe metadata/snapshot fields.

### Correction-wave final verification

- `node --test` in `server`: 924/924 passed.
- `npm test -- --run` in `client`: 171/171 passed.
- `npm run build` in `client`: production build passed. Its only diagnostic was the existing bundle-size warning.
- `client/public/sw.js` was backed up before the build, restored afterward, compared byte-for-byte, and retained SHA-256 `c7122c6cf971c0ea0b035f390683f58fbe7dc804e71a4ee78cc0f0f392f1e239`.
- `git diff --check`: passed.

## Correction continuation

### Root-cause trace and hypotheses

- The correction wave made unresolved metadata request-specific during validation but then wrote its synthetic dimensions and values into `filterFactsCache`, whose key is only church/provider. That turns batch A's removed pair into shared canonical metadata: metadata GET and batch B validation can subsequently treat it as provider-backed. The correct boundary is to cache and return only `captureFilterSnapshotInput()`'s provider-derived dimensions. Batch A remains editable because `FilterBuilder` already projects missing selected dimensions/values from its saved config and marks them unavailable.
- Refresh reads the target batch only before the provider fetch. Active/draft filters can be edited, promoted, discarded, or deleted during that network window, leaving the original unresolved allowance stale when post-fetch validation replaces the shared cache. The request needs an authoritative pre-fetch identity and an immediate post-fetch scoped re-read comparing schema/revision plus canonical active/draft digests; a mismatch must return a typed stale response without replacing the old cache.
- The Planning Center automatic-sync switch starts as boolean `false`, ignores settings-load failure, and lets both the initial GET and overlapping mutations write state whenever they resolve. Consequently unknown/error is presented as OFF/paused, a late initial GET can overwrite a successful toggle, and rapid mutations can resolve out of order. The switch needs explicit loading/known/error state, a response generation guard, serialized mutation, visible retry, and rollback to the last confirmed server value on mutation failure.

### Continuation TDD evidence

#### RED

- The focused real-route run passed 22/29 tests and failed all 7 new expectations: Planning Center and Elvanto each exposed removed dimensions/values through shared metadata, and controlled draft-edit, promotion, and deletion races reached cache replacement and returned 500. A distinct draft-discard case was added once the generalized identity check existed to prove the no-revision-change path too.
- The focused client run passed 24/29 tests and failed all 5 new Planning Center settings cases: there was no named guarded switch, no serialized mutation, no visible mutation/load failure, and loading/error rows claimed a definite schedule state. The canonical-metadata `FilterBuilder` regression passed before production changes, confirming its saved-config projection already keeps batch A's removed selections visible and removable without synthetic metadata.

#### GREEN

- Focused refresh route: 30/30 tests passed, including both real provider adapters, shared GET metadata, batch-B draft rejection, batch-A retained validation, and deferred edit/promotion/discard/deletion races with zero cache replacement.
- Combined server people-sync/Elvanto/filter-builder impact slice: 400/400 tests passed.
- Focused Planning Center state machine plus canonical `FilterBuilder`: 29/29 tests passed.
- Combined client controls/builder/integration-panel slice: 56/56 tests passed.

### Continuation final verification

- `node --test` in `server`: 928/928 passed.
- `npm test -- --run` in `client`: 176/176 passed.
- `npm run build` in `client`: production build passed. Its only diagnostic was the existing bundle-size warning.
- `client/public/sw.js` was backed up before the build, restored afterward, compared byte-for-byte, and retained SHA-256 `c7122c6cf971c0ea0b035f390683f58fbe7dc804e71a4ee78cc0f0f392f1e239`.
- `git diff --check`: passed.
