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
