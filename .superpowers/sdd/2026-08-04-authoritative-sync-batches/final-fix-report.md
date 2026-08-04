# Final fix report — authoritative sync batches

## Outcome

Fixed both Important whole-branch review findings without changing client contracts, database schema, ordinary authority behavior, Elvanto semantics, Planning Center token-refresh semantics, or the one-time import path.

1. Planning Center reviewed and unattended sync now binds the same durable connection generation already used for Elvanto. Generation is checked around every provider source read and again inside the apply transaction before source, people, authority, or review-token writes.
2. Reviewed and unattended plans now bind a deterministic digest of every plan-affecting batch field. Apply rebuilds that expectation inside the church transaction, using an exact enabled-batch set for authority-wide operations and the participating set for ordinary operations.

## RED evidence

The implementation began with focused failing regressions:

- Planning Center OAuth replacement left the durable generation at `0` instead of advancing it to `1`.
- A reconnect during a blocked Planning Center authority read did not reject the stale apply.
- An ordinary reviewed apply whose destructive gathering auto-removal setting changed while the provider read was blocked did not reject as stale.
- The shared batch-configuration expectation tests failed because the deterministic builder and transaction validator did not yet exist.

Each failure was observed before production changes were made.

## Implementation

### Durable Planning Center account generation

- Added a transaction-scoped connection-generation increment helper in `connectionStore.js`.
- Advanced Planning Center generation atomically for explicit OAuth replacement, successful legacy credential migration, and a disconnect that actually removes encrypted or legacy credentials.
- Kept routine rotating-token refresh generation-stable, because it preserves the logical Planning Center account.
- Signed the connection generation for both providers, checked it before and after every source fetch to prevent mixed-account multi-source snapshots, and retained the final apply-transaction check.

### Plan-affecting batch configuration

- Added one deterministic expectation builder shared by preview/apply and transaction validation.
- Bound `enabled`, `defaultPeopleType`, `gatheringTypeId`, `gatheringAutoRemoveEnabled`, and the Planning Center legacy-provider batch marker that changes operational/retired scope.
- Deliberately excluded display/source-health and scheduling fields because they do not alter the reviewed reconciliation plan.
- Bound the configuration digest into signed source context and revalidated the current database state before any apply writes.
- Authority-wide applies require the exact current enabled-batch set. Ordinary reviews bind only their participating batches.

## Files changed

- `server/services/peopleSync/apply.js`
- `server/services/peopleSync/batchRepository.js`
- `server/services/peopleSync/connectionStore.js`
- `server/services/peopleSync/orchestrator.js`
- `server/services/peopleSync/pcoCredentialMigration.js`
- `server/services/peopleSync/batchRepository.dbintegration.test.js`
- `server/services/peopleSync/orchestrator.dbintegration.test.js`
- `server/services/peopleSync/orchestrator.test.js`
- `server/services/peopleSync/pcoCredentialMigration.dbintegration.test.js`

No client or schema files changed.

## GREEN verification

### Core sync and one-time import

Command:

```bash
cd server
node --test --test-concurrency=1 \
  services/peopleSync/orchestrator.test.js \
  services/peopleSync/orchestrator.dbintegration.test.js \
  services/peopleSync/batchRepository.dbintegration.test.js \
  services/peopleSync/apply.test.js \
  services/peopleSync/apply.dbintegration.test.js \
  services/peopleSync/connectionStore.dbintegration.test.js \
  services/peopleSync/pcoCredentialMigration.dbintegration.test.js \
  services/peopleSync/sourceHealth.dbintegration.test.js \
  services/peopleSync/elvantoLegacyCredential.dbintegration.test.js \
  services/peopleImport/orchestrator.test.js \
  services/peopleImport/orchestrator.dbintegration.test.js
```

Result: **293 tests, 293 passed, 0 failed**.

This includes the new blocked-read reconnect, mixed-account multi-source, ordinary destructive-config race, authority config race, rollback/no-token-consumption, generation lifecycle, deterministic digest, exact-set, and schedule-exclusion coverage.

### Routes, schema, migration, and connection behavior

Command:

```bash
cd server
node --test --test-concurrency=1 \
  routes/integrations.pcoConnection.test.js \
  routes/integrations.elvantoLegacyKey.test.js \
  routes/integrations.elvanto.dbintegration.test.js \
  routes/integrations/peopleSync.test.js \
  routes/integrations.pcoSyncBatches.dbintegration.test.js \
  config/peopleSyncSchema.dbintegration.test.js \
  config/database.test.js
```

Result: **117 tests, 117 passed, 0 failed**.

The first sandboxed attempt encountered Node/Winston `uv_uptime EPERM` before assertions ran. The identical suite passed serially outside the sandbox as shown above; this was an execution-environment issue, not a product regression.

### Whitespace validation

`git diff --check` passed with no output.

Total final focused verification: **410 tests, 410 passed, 0 failed**.

## Self-review

- Confirmed every new transaction check runs before review-token claim and all people, link, source-promotion, and authority writes.
- Confirmed reconnect/migration/disconnect advance Planning Center generation while routine refresh, validation, and metadata updates do not.
- Confirmed generation checks bracket each Planning Center source read and the transaction check closes the final fetch-to-commit window.
- Confirmed the batch digest is deterministic across input order and includes all batch fields consumed by planning or operational-scope selection.
- Confirmed authority exact-set validation catches newly enabled, disabled, removed, or reconfigured batches; ordinary validation remains scoped to participating batches.
- Confirmed church ID and provider constrain every new database read/write.
- Confirmed no credentials or provider data are logged or added to signed context.
- Confirmed the pre-existing untracked `server/node_modules` path is not part of the change.

## Commit

This report and implementation are committed together as `fix(sync): bind reviewed applies to durable state`.

## Concerns

No known product concerns remain within the two requested findings. The test runner's sandbox-only `uv_uptime EPERM` behavior remains an environmental limitation; the affected tests pass outside that sandbox.
