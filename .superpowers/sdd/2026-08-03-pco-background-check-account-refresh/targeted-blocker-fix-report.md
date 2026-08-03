# Targeted blocker fix report

## Status

PASS. Both residual review blockers are fixed in the isolated
`pco-background-check-account-refresh` worktree. No live Planning Center or
Kingston reconciliation was run.

Base commit: `2fb9fef9e4eba40569910cd4008f02861bc3e1d9`

## Blocker 1: oldest supported database startup

### Root cause

Production startup executed one aggregate `UPDATED_AT_TRIGGERS` script. SQLite
aborted that script as soon as an oldest-supported database lacked a target
table, and a persisted legacy `individuals_updated_at` trigger could still
reference an `updated_at` column that did not exist. The existing legacy test
opened the database but did not invoke the full `ensureChurchSchema` startup
path, so the incompatibility escaped coverage.

### Fix

- Refactored timestamp triggers into named table-aware descriptors while
  retaining the aggregate SQL export used by import and seed tools.
- Added a capability-aware installer that creates each app-owned trigger only
  when its target table exists and has `updated_at`; otherwise it drops the
  incompatible app-owned trigger by its exact name.
- Explicitly removes the stale legacy individuals timestamp trigger when the
  oldest schema has no `individuals.updated_at` column.
- Runs the same installer for fresh and upgraded databases and remains
  idempotent on repeated startup.
- Added a production-path test using the oldest fixture, a persisted invalid
  trigger, repeated `ensureChurchSchema`, trigger-target introspection, and a
  normal person update.

This deliberately does not add a nullable `updated_at` column to old tables or
change their insert/update semantics. It repairs only the application's named
triggers and leaves the migration marker open for a future compatible schema
upgrade.

## Blocker 2: credential mutation versus snapshot apply

### Root cause

Credential replacement/disconnect and background-check cache invalidation used
different coordination boundaries. A fetched or cached snapshot could pass its
generation check, queue its database transaction behind the credential
transaction, then write after replacement/deletion committed but before the
route performed invalidation.

### Fix

- Added one per-church Planning Center account coordinator shared by credential
  replacement/disconnect and background snapshot commits.
- Credential mutations advance the church credential epoch before entering the
  local credential transaction and retain the coordination boundary through
  commit.
- Both cached and fetched snapshot applications acquire the same boundary and
  recheck their captured epoch immediately before local application.
- Epoch capture itself joins the boundary, so a refresh cannot observe a new
  epoch and then read old credentials while a mutation transaction is paused.
- Provider/token HTTP work remains outside the coordinator.
- Preserved same-epoch singleflight behavior, including callers arriving while
  an apply is active.
- Bounded stale-credential retries to one and returns the safe typed error
  `PCO_BACKGROUND_CHECK_CREDENTIAL_CHANGED` if credentials keep changing.
- Moved invalidation ownership from individual routes into the shared credential
  mutation layer so non-route callers get the same guarantee.

The local order is now total: an apply either completes before a mutation, or
the mutation commits first and the old apply is rejected before entering its
transaction. Lock order is coordinator, existing credential queue, then church
database transaction. No provider request is made while those local locks are
held.

## TDD evidence

Every command below ran in the existing server image with the isolated worktree
server bind-mounted at `/app`, the existing server `node_modules` volume, and
`--network none`.

### Baseline

The exact prior 12-file regression set passed before edits:

```text
node --test config/database.test.js config/peopleSyncSchema.dbintegration.test.js routes/integrations.pcoConnection.test.js routes/integrations.pcoSyncBatches.dbintegration.test.js routes/integrations/planningCenterPeopleSync.test.js services/planningCenter/backgroundCheckSync.test.js services/planningCenter/backgroundCheckSync.dbintegration.test.js services/planningCenter/readClient.test.js services/planningCenter/projection.test.js services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/runRepository.dbintegration.test.js
209 passed, 0 failed; duration 2135.454959 ms
```

### Oldest-schema RED/GREEN

RED:

```text
node --test --test-name-pattern='ensureChurchSchema keeps the oldest supported individuals table writable' config/database.test.js
0 passed, 1 failed: unwanted exception `no such table: main.attendance_sessions`
```

GREEN, including the existing timestamp-trigger replacement regression:

```text
node --test --test-name-pattern='(ensureChurchSchema keeps the oldest supported individuals table writable|getChurchDb replaces the legacy individuals timestamp trigger)' config/database.test.js
2 passed, 0 failed; duration 167.203417 ms
```

### Replacement/disconnect race RED/GREEN

RED:

```text
node --test --test-name-pattern='(OAuth replacement blocks an old fetched snapshot|PCO disconnect blocks a cached old snapshot)' routes/integrations.pcoConnection.test.js
0 passed, 2 failed: replacement performed no fresh-token read; cached refresh fulfilled after disconnect
```

The cached path was also rerun alone after tightening rejection capture:

```text
node --test --test-name-pattern='PCO disconnect blocks a cached old snapshot' routes/integrations.pcoConnection.test.js
0 passed, 1 failed: actual `fulfilled`, expected `rejected`
```

GREEN:

```text
node --test --test-name-pattern='(OAuth replacement blocks an old fetched snapshot|PCO disconnect blocks a cached old snapshot)' routes/integrations.pcoConnection.test.js
2 passed, 0 failed; duration 365.843875 ms
```

An intermediate broader run exposed a same-epoch singleflight regression
(36 passed, 1 failed). Moving the first same-epoch join ahead of coordinated
epoch capture restored the established contract:

```text
node --test services/planningCenter/backgroundCheckSync.test.js
10 passed, 0 failed; duration 74.564376 ms
```

### Retry-bound mutation test

The test was mutation-checked by temporarily allowing a second retry.

RED under the deliberate mutation:

```text
node --test --test-name-pattern='refresh bounds automatic retries' services/planningCenter/backgroundCheckSync.test.js
0 passed, 1 failed: Missing expected rejection
```

GREEN after restoring the one-retry bound:

```text
node --test --test-name-pattern='refresh bounds automatic retries' services/planningCenter/backgroundCheckSync.test.js
1 passed, 0 failed; duration 60.903583 ms
```

## Final verification

Affected database, credential, route, background-sync, orchestrator, and run
repository set:

```text
node --test config/database.test.js config/peopleSyncSchema.dbintegration.test.js routes/integrations.pcoConnection.test.js services/peopleSync/pcoCredentialMigration.dbintegration.test.js services/planningCenter/backgroundCheckSync.test.js services/planningCenter/backgroundCheckSync.dbintegration.test.js services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/runRepository.dbintegration.test.js
187 passed, 0 failed; duration 2018.798459 ms
```

Exact prior 12-file regression set after all edits:

```text
node --test config/database.test.js config/peopleSyncSchema.dbintegration.test.js routes/integrations.pcoConnection.test.js routes/integrations.pcoSyncBatches.dbintegration.test.js routes/integrations/planningCenterPeopleSync.test.js services/planningCenter/backgroundCheckSync.test.js services/planningCenter/backgroundCheckSync.dbintegration.test.js services/planningCenter/readClient.test.js services/planningCenter/projection.test.js services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/runRepository.dbintegration.test.js
213 passed, 0 failed; duration 2014.47071 ms
```

`git diff --check` also passed.

## Files changed

- `server/config/database.js`
- `server/config/database.test.js`
- `server/config/schema.js`
- `server/routes/integrations.js`
- `server/routes/integrations.pcoConnection.test.js`
- `server/services/peopleSync/pcoCredentialMigration.js`
- `server/services/planningCenter/accountCoordinator.js`
- `server/services/planningCenter/backgroundCheckSync.js`
- `server/services/planningCenter/backgroundCheckSync.test.js`
- this report

## Self-review and residual concerns

- No credential or snapshot payload logging was added.
- Existing aggregate trigger consumers remain compatible.
- The background provider read remains outside database and account locks.
- Both new race tests use the real encrypted credential store and real church
  transactions; external OAuth exchange/validation are the only provider-side
  stubs.
- The account coordinator, like the generation guard it replaces, is
  process-local. The deployed server is a single Node process; a future
  multi-process writer topology would require a durable account epoch checked
  atomically in the apply transaction.
- No live Kingston/provider reconciliation was attempted, by instruction.

## Review fix round 1: caller-owned retry accounting

### Finding and root cause

The per-church `refreshInFlight` entry represented the promise creator's entire
recursive retry chain. A caller that had already consumed its one stale-epoch
retry could join a newer top-level caller's in-flight promise and inherit that
caller's unused retry. In a three-epoch sequence, the original caller therefore
survived two credential changes and fulfilled from epoch three.

### Fix

- The shared singleflight now represents exactly one credential-epoch attempt
  and resolves to the coordinator's tagged `{ stale, value }` outcome.
- The public refresh function owns the retry loop and remaining budget for each
  invocation. Joined callers independently interpret the shared stale outcome.
- Fetch/apply coalescing, cache reapplication, per-church isolation, and the
  credential-mutation apply boundary are unchanged.
- Added a deterministic three-epoch concurrency test. Deferred provider reads
  and a pass-through observation of the real epoch comparison establish the
  join boundary without sleeps. It proves the original caller rejects with
  `PCO_BACKGROUND_CHECK_CREDENTIAL_CHANGED`, the newer caller succeeds on its
  one eligible retry, provider reads are exactly one per epoch, and only the
  epoch-three snapshot applies.

### RED/GREEN evidence

All commands used the isolated server mount and existing `node_modules` volume
in Docker with `--network none`.

RED against the pre-fix production code:

```text
node --test --test-name-pattern='each caller owns one stale-credential retry' services/planningCenter/backgroundCheckSync.test.js
0 passed, 1 failed; expected original caller status `rejected`, actual `fulfilled`; duration 67.48575 ms
```

GREEN after moving retry ownership outside the shared epoch promise:

```text
node --test --test-name-pattern='each caller owns one stale-credential retry' services/planningCenter/backgroundCheckSync.test.js
1 passed, 0 failed; duration 61.933042 ms
```

Focused credential-coordinator, route-race, and background-sync set:

```text
node --test routes/integrations.pcoConnection.test.js services/peopleSync/pcoCredentialMigration.dbintegration.test.js services/planningCenter/backgroundCheckSync.test.js services/planningCenter/backgroundCheckSync.dbintegration.test.js
45 passed, 0 failed; duration 907.839167 ms
```

Affected database, credential, route, background-sync, orchestrator, and run
repository set:

```text
node --test config/database.test.js config/peopleSyncSchema.dbintegration.test.js routes/integrations.pcoConnection.test.js services/peopleSync/pcoCredentialMigration.dbintegration.test.js services/planningCenter/backgroundCheckSync.test.js services/planningCenter/backgroundCheckSync.dbintegration.test.js services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/runRepository.dbintegration.test.js
188 passed, 0 failed; duration 1770.987668 ms
```
