# Final provider lifecycle fence fixes

## Delivered

- Captured the Elvanto connection generation before provider work and threaded
  it through successful and failed active-source health persistence. Health
  state and missing-source admin notifications now recheck that generation in
  the same church transaction as their writes, so an old account's fetch cannot
  publish effects after reconnect.
- Applied the same Elvanto generation fence to reviewed and unattended
  post-apply full-fetch presence accounting. A stale snapshot can no longer
  increment missing-person counters after the provider account changes.
- Kept Planning Center review digests rolling-deployment compatible by omitting
  `connectionGeneration` entirely from PCO source context and by applying the
  generation expectation only to Elvanto.
- Replaced unbounded authority-preview cancellation polling with an exact-intent
  single-flight job capped at four attempts, using 500 ms / 5 s / 15 s backoff,
  a 45-second retry budget, retryable-status filtering, and `Retry-After`
  handling. Each HTTP attempt has a five-second timeout. When bounded cleanup
  still cannot be confirmed, the durable server-side 30-minute intent expiry
  remains the final fallback.
- Preserved explicit cancellation recovery in both the shared source control and
  Elvanto onboarding: terminal failure returns the review to an actionable state
  and a later cancellation attempt can succeed. Detached unmount/supersession
  cleanup observes its rejection without creating an unhandled promise.
- Exempted provider `401` responses carrying `SYNC_SOURCE_AUTH` from the global
  LMPG session-refresh interceptor. The original provider error now reaches the
  integration UI without token refresh, request replay, user removal, or login
  redirect.

## Regression coverage

- Source health integration tests prove a stale Elvanto generation cannot mark
  a source available or missing and cannot create admin notifications.
- Presence integration tests prove a stale generation leaves missing counters
  unchanged, with orchestrator-level coverage for both reviewed and unattended
  post-apply paths.
- Orchestrator unit/integration tests cover generation propagation on fetch
  success and failure, stable `SYNC_PLAN_STALE` normalization, unchanged health
  after reconnect, and PCO source-context omission.
- Cancellation unit tests cover the finite attempt schedule, permanent `4xx`
  termination, oversized `Retry-After`, single-flight release, and later
  recovery. Component tests cover recoverable terminal cancellation in both UIs.
- Axios interceptor tests prove `SYNC_SOURCE_AUTH` bypasses refresh/replay while
  an ordinary expired-session `401` still refreshes and replays once.

## Verification

- Focused server regressions: 91 tests passed.
- Full server suite: 816 tests passed with `node --test --test-concurrency=1`.
  The sandboxed run could not bind the route tests' local ephemeral listeners;
  the identical command passed outside the sandbox.
- Full client suite: 23 files, 174 tests passed.
- Production client build: completed successfully (1,157 modules).
- `git diff --check`: clean.

## Notes

- Vite retains the existing warning that the main production chunk exceeds
  500 kB; this work does not change application bundling.
- Node retains the existing `module.register()` deprecation warning during
  client tests and build.
- The production build regenerated `client/public/sw.js`. It is intentionally
  excluded from this change as requested.

## Independent review

- A final read-only review found no critical, important, or minor issues and
  assessed the change as ready to merge.
- The reviewer specifically confirmed the transactional generation fences,
  finite exact-intent cancellation ownership, provider-auth interceptor bypass,
  PCO digest compatibility, and corresponding regression coverage.
