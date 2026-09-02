# Final review fix wave report

## Scope

Addressed the two Important findings from the whole-branch review only:

1. A current-rules tier-state row with a null `established_tier` was incorrectly presented as established when live evidence happened to be classifiable.
2. Individual deduplication could begin rehoming/deletion without first proving that the survivor and every source were a valid, complete, church-scoped participant set.

## Changes

- `server/services/engagement/overview.js`
  - Treats an axis as established only when the persisted `established_tier` is classified.
  - Leaves a null persisted tier as `calculated_fallback`, keeps that axis in baseline-pending totals, and excludes it from both confirming and recently-confirmed movement claims.
- `server/services/engagement/overview.dbintegration.test.js`
  - Adds a regression where a null persisted tier becomes live-classifiable before evaluator execution.
  - Verifies fallback provenance, pending baseline, and absence from both movement drilldowns.
  - Corrects the existing established-activity fixture expectation so all null persisted axes remain pending.
- `server/routes/individuals.js`
  - Normalizes the survivor and source IDs as distinct positive integers.
  - Requires at least one source and rejects survivor/source overlap and duplicate sources.
  - Loads every participant inside the transaction, scoped to the authenticated church, and requires exact cardinality before any history rehoming.
  - Runs the legacy cross-church tier-reference guard across the survivor and every source.
  - Returns explicit 400/404 validation responses while preserving existing 409 integrity responses.
- `server/routes/families.dbintegration.test.js`
  - Adds no-mutation rejection coverage for empty, duplicate, overlapping, non-positive, fractional, missing, and foreign participants.
  - Adds survivor-side cross-church tier-reference rollback coverage.
  - Keeps the valid multi-source collision test focused on internally consistent participants.

## TDD evidence

### RED

- Overview regression failed with `pendingAxes: 7` instead of `8`, proving that the null state row was being counted as established.
- Deduplication regression cases returned `200` instead of the required `400`/`404` for empty sources, duplicates, overlap, fractional IDs, and missing/foreign participants.
- Survivor cross-church tier-reference regression returned `200` instead of `409` when the guard was source-only.

### GREEN

- Overview integration file: **7 passed, 0 failed**.
- Focused deduplication validation group: **10 passed, 0 failed**.
- Full families/individuals route integration file: **31 passed, 0 failed**.
- Full 14-file engagement feature server matrix: **139 passed, 0 failed**.
  - Includes bounded overview queries for 1,000 regulars across 56 weeks.
  - Includes evaluator concurrency and stale-run protection, lifecycle rollback, pastoral/digest behavior, scheduler behavior, and cross-church token/reference isolation.

## Hygiene

- `node --check server/services/engagement/overview.js` — passed.
- `node --check server/routes/individuals.js` — passed.
- `git diff --check` — passed.
- Package and lock files — unchanged.
- Client files — unchanged.

## Concerns

None introduced by this fix wave. The database transaction wrapper logs expected validation rollbacks during negative integration cases; this is pre-existing transaction logging behavior and does not change API responses or test outcomes.

## Scoped re-review follow-up

The scoped re-review identified one remaining presentation path for the first finding: a valid or stale confirmation token could still return a candidate row for an axis whose persisted `established_tier` was null, even though the overview summary correctly reported zero confirmations.

- Extended `confirmationRows` to require the person/axis key to be present in the overview's `establishedKeys` set before returning a confirmation row.
- Extended the null-established integration regression to use the generated confirmation token and assert an empty result.
- The pre-existing established-tier confirmation case continues to return its detailed confirmation row.

TDD and verification:

- RED: the null-established confirmation drilldown returned Amy with `establishedTier: null` instead of an empty result.
- GREEN: overview integration **7 passed, 0 failed**.
- Full 14-file engagement server matrix **139 passed, 0 failed**.
- Production syntax, diff hygiene, and package/lock checks passed; no client or unrelated files changed.
