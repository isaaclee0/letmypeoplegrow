# Final Residual Safety Fix Report

## Status

DONE

All five residual review findings are implemented and regression-covered. The
result now fails closed across Elvanto credential replacement, response-delivery
loss, browser unmounts, cancelled source-health writes, and exported Elvanto
authentication errors.

## Corrections

### 1. Elvanto reconciliation is bound to a durable credential generation

- Elvanto preconditions read the durable
  `integration_connection_generations` value before reading credentials. This
  ordering prevents a reconnect between the two reads from pairing a new
  credential with a generation that can still pass apply.
- Reviewed plans include `sourceContext.connectionGeneration`; it is covered by
  the canonical plan digest and therefore by the signed review token.
- Reviewed and unattended apply carry the same generation expectation into the
  church transaction. Before any people mutation, apply verifies both that the
  plan and expectation agree and that the durable database generation is still
  exact.
- Database regressions replace the Elvanto account while reviewed and unattended
  provider reads are in flight. Both paths return `SYNC_PLAN_STALE` and leave
  people unchanged. The durable table makes this check process-independent.

### 2. Preview ownership transfers only after the response finishes

- The authority-preview route now treats Node's `finish` event as successful
  response ownership transfer.
- `res.json()` / `writableEnded` is no longer sufficient: a `close` or request
  abort before `finish` aborts the pipeline and conditionally cancels the exact
  route-owned preview ID.
- Lifecycle listeners remain attached after the async handler returns and
  detach only when `finish` or premature disconnect settles ownership.

### 3. Client cancellation ownership survives failures and unmounts

- `PeopleSourceControl` and `ElvantoOnboarding` use one detached, deduplicated
  cancellation job keyed by the immutable provider and authority-preview ID.
- Failed exact cancellations retry with capped backoff after navigation or
  component unmount; explicit cancellation cannot lose ownership when its first
  request rejects after unmount.
- Completion clears the active ownership ref only if it still names that exact
  preview. Retries never reread the ref and therefore cannot cancel a newer
  generation. The server endpoint's exact, idempotent CAS supplies the matching
  final guard.
- Existing late-response/generation tests plus new failed-cleanup regressions
  cover both components. A hard browser termination still falls back to the
  server's existing preview-intent expiry.

### 4. Aborted previews cannot publish source health or notifications

- The route abort signal is passed into active-source available and failure
  persistence.
- Source-health updates, admin lookup, and missing-source notification inserts
  run in one church transaction with cancellation checks after lock acquisition
  and after every awaited operation.
- If cancellation arrives during an awaited health write or notification
  operation, the check throws inside the transaction and rolls everything back.
- Failure recording reasserts cancellation after its await and does not swallow
  the cancellation as a best-effort health error.

### 5. Generic people-sync routes recognize the emitted Elvanto auth code

- The generic route imports and compares the exported `ELVANTO_AUTH` constant
  instead of the obsolete literal `ELVANTO_AUTH` code string.
- The emitted value (`SYNC_SOURCE_AUTH`) now maps to HTTP 401 with reconnect
  guidance rather than a generic 502 provider failure.

## Verification

Focused client lifecycle suites:

```sh
cd client
npm test -- --run src/components/peopleSync/PeopleSourceControl.test.tsx src/components/elvanto/ElvantoOnboarding.test.tsx
```

Result: **45 passed, 0 failed**.

Relevant server service/database suites:

```sh
cd server
node --test --test-concurrency=1 \
  services/peopleSync/orchestrator.test.js \
  services/peopleSync/orchestrator.dbintegration.test.js \
  services/peopleSync/apply.dbintegration.test.js \
  services/peopleSync/connectionStore.dbintegration.test.js \
  services/peopleSync/planDigest.test.js \
  services/peopleSync/sourceHealth.dbintegration.test.js \
  services/elvanto/legacyCredential.dbintegration.test.js
```

Result: **168 passed, 0 failed**.

Relevant route suites:

```sh
cd server
node --test --test-concurrency=1 \
  routes/integrations/peopleSync.test.js \
  routes/integrations/elvanto.test.js
```

Result: **64 passed, 0 failed**.

Repository-wide verification:

```sh
cd server
node --test --test-concurrency=1

cd ../client
npm test
npm run build
```

Results:

- Server: **809 passed, 0 failed**.
- Client: **21 test files, 167 tests passed, 0 failed**.
- Production build passed (**1,157 modules transformed**).
- The existing bundle-size warning remains non-blocking.
- `git diff --check` passed.

The server route and full suites ran outside the filesystem sandbox because
their Express/WebSocket tests require local loopback sockets; no external
provider calls were used.

## Scope note

`client/public/sw.js` was regenerated by the required production build. It was
already a known generated/pre-existing worktree change and is intentionally
excluded from this fix commit.
