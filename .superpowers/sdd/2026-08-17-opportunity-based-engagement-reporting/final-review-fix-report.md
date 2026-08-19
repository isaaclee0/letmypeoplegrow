# Opportunity-Based Engagement Reporting — Final Review Fix Report

Date: 2026-08-19

Reviewed range: `e5accdee8d2808c29ec53d4df2ce6976fd7c794e..35f9fa8`

Worktree: `/Users/isaaclee/Projects/Let My People Grow/letmypeoplegrow/.worktrees/codex-engagement-reporting`

## Method and environment

Every numbered Critical/Important finding was traced to its live data flow, reproduced with a focused regression before its production change, and fixed at the narrowest shared boundary. Where the second independent diff review found a missing edge in an initial regression, that edge received its own RED/GREEN cycle before this report was frozen.

For each finding, the GREEN rerun used the identical exact focused command printed in its RED section unless a broader command is printed separately; only the observed post-fix result changes in the GREEN section.

The engagement worktree intentionally has no installed server dependencies. Server tests used the established compatible dependency tree:

```text
NODE_PATH=/Users/isaaclee/Projects/Let My People Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules
```

Real Express route tests initially cannot bind loopback in the sandbox (`listen EPERM 127.0.0.1`). Those tests were rerun with the already-approved outside-sandbox local execution. No network service was contacted: listeners were ephemeral localhost listeners and the PCO HTTPS boundary was mocked. No package or lock file was modified.

## Finding 1 — fresh-schema `attendance_records.updated_by`

### Root-cause trace

The standard attendance route selected and wrote `attendance_records.updated_by`, but neither the fresh `CHURCH_SCHEMA` table nor `ensureEngagementSchema` added the column. A newly created church therefore reached the real write transaction and failed with `SQLITE_ERROR: no such column: updated_by`.

### Regression and RED

- `server/config/engagementSchema.dbintegration.test.js`
  - `ensureEngagementSchema upgrades a legacy database and backfills only evidenced sessions`
  - `CHURCH_SCHEMA creates the same engagement contract for fresh databases`
- `server/routes/attendance.sessionState.test.js`
  - `REST standard and headcount writes finalize the session in the write transaction`

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test config/engagementSchema.dbintegration.test.js
tests 2; pass 0; fail 2
updated_by was undefined in both the upgrade and fresh contracts.

cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test routes/attendance.sessionState.test.js
real route returned 500 (no such column: updated_by), expected 200.
```

### Fix

Added nullable `updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL` to the fresh table and additive upgrade. The route remains actor-aware and deletion-safe. The real-route assertion verifies a non-empty standard write persists the actor.

### GREEN

```text
config/engagementSchema.dbintegration.test.js: 2 passed, 0 failed
routes/attendance.sessionState.test.js (final full file): 3 passed, 0 failed
```

## Finding 2 — migrated held provenance-v0 sessions

### Root-cause trace

`finalizeStandardSessionWithConnection` captured a roster whenever a standard session was unsnapshotted. It did not distinguish a genuinely open live session from migrated held history, so editing held v0 history copied today's roster and upgraded the historical provenance to v1.

### Regression and RED

- `server/services/attendanceSessionState.dbintegration.test.js`
  - `editing a migrated held provenance-v0 session does not snapshot the current roster`

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='editing a migrated held provenance-v0 session' services/attendanceSessionState.dbintegration.test.js
actual roster_provenance_version=1 and roster_snapshotted=1; expected 0 and 0.
tests 1; pass 0; fail 1
```

### Fix

Roster capture now occurs only for an `open`, unsnapshotted standard session without reliable v1 provenance. A held v0 session remains held v0 and unsnapshotted; existing v1 snapshots remain immutable.

### GREEN

```text
focused test: 1 passed, 0 failed
full attendance session-state file in Task 14: 10 passed, 0 failed
```

## Finding 3 — immutable `people_type_at_time`

### Root-cause trace

All live standard attendance upserts assigned `people_type_at_time = excluded.people_type_at_time` on conflict. A later edit therefore replaced a non-null historical visitor/regular classification with the person's current classification.

### Regression and RED

- `server/routes/attendance.sessionState.test.js`
  - `REST attendance edits preserve a non-null historical people type`
- `server/services/websocket.sessionState.dbintegration.test.js`
  - `WebSocket attendance edits preserve a non-null historical people type`
- `server/services/websocket.kiosk.dbintegration.test.js`
  - `WebSocket kiosk check-in preserves a non-null historical people type`
  - `HTTP kiosk check-in preserves a non-null historical people type`

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test routes/attendance.sessionState.test.js services/websocket.sessionState.dbintegration.test.js services/websocket.kiosk.dbintegration.test.js
each mutation changed historical local_visitor to regular; expected local_visitor.
```

### Fix

Every live REST, socket, HTTP-kiosk, socket-kiosk, visitor, and add-person upsert now uses `COALESCE(attendance_records.people_type_at_time, excluded.people_type_at_time)`: a legacy null is filled once, while a non-null historical value is preserved.

### GREEN

```text
Task 14 attendance route/socket/kiosk files: all passed
static audit found no live raw `people_type_at_time = excluded.people_type_at_time` assignment.
```

## Finding 4 — PCO present-only import session state

### Root-cause trace

The PCO import loop selected only an existing session ID. New rows inherited the default `open` state, existing `open` sessions were not converted to present-only held history, and a cached cancelled session was still eligible for an attendance write and import-checkpoint advancement.

### Regression and RED

- `server/services/planningCenter/checkinsImport.dbintegration.test.js`
  - `PCO present-only imports create or transition held provenance-v0 sessions and reject cancelled sessions`
- `server/routes/integrations.pcoCheckins.dbintegration.test.js`
  - `real PCO check-in route holds present-only imports and rejects cancelled-session writes`

The live test uses the real router/JWT/church database/credential store and mocks only `https.request`.

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test routes/integrations.pcoCheckins.dbintegration.test.js
legacy creation RED: session_status was open, expected held.
cancelled-guard mutation RED: HTTP 200, expected typed 409.
```

### Fix

Extracted the exact transactional session decision to `ensureHeldImportSessionWithConnection`. It creates held/v0/unsnapshotted sessions, changes only `open -> held` while preserving an existing provenance/snapshot, leaves held rows unchanged, and throws `409 PCO_CHECKIN_SESSION_CANCELLED` before attendance, last-attendance, or checkpoint writes. Rejecting the whole transaction avoids falsely advancing the provider checkpoint for a skipped cancelled date.

### GREEN

```text
real route: 1 passed, 0 failed
PCO helper DB + pure suite: 33 passed, 0 failed
cancelled row, attendance rows, last_attendance_date, and checkpoint all remained unchanged.
```

## Finding 5 — socket authorization and kiosk gate

### Root-cause trace

REST gathering access was embedded in Express middleware and was not callable by sockets. Socket attendance, headcount, mode, and kiosk handlers entered dedupe/write/broadcast without checking the current church assignment; socket kiosk also never checked `KIOSK_MODE_ENABLED`. The HTTP kiosk POST imported access middleware but did not apply it.

### Regression and RED

- `server/services/websocket.sessionState.dbintegration.test.js`
  - `WebSocket attendance and headcount mutations require a current gathering assignment`
- `server/services/websocket.kiosk.dbintegration.test.js`
  - `WebSocket kiosk actions honor the feature gate before writing`
  - `HTTP and WebSocket kiosk actions require access to the gathering`

RED showed an unassigned attendance taker could write and receive success, and a disabled socket kiosk still persisted an action. Admin bypass and assigned-taker success were included to preserve compatibility.

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test services/websocket.sessionState.dbintegration.test.js services/websocket.kiosk.dbintegration.test.js
✖ WebSocket attendance and headcount mutations require a current gathering assignment
  unauthorized mutation emitted success and persisted a row; expected an error and zero rows.
✖ WebSocket kiosk actions honor the feature gate before writing
  persisted kiosk action count 1; expected 0 and code KIOSK_DISABLED.
```

### Fix

Added church-explicit `canUserAccessGathering({ churchId, userId, gatheringTypeId })` in `middleware/auth.js`; `requireGatheringAccess` now delegates to it. It verifies an active same-church user/gathering, preserves unconditional admin bypass, and otherwise requires a same-church assignment. All socket mutation handlers call it before dedupe/write/broadcast. The feature gate moved to neutral `services/kioskMode.js`; HTTP and socket kiosk now share the `KIOSK_DISABLED` contract, and HTTP kiosk POST also applies gathering access.

### GREEN

```text
websocket.sessionState.dbintegration.test.js: 5 passed, 0 failed
websocket.kiosk.dbintegration.test.js: 6 passed, 0 failed
```

## Finding 6 — socket headcount validation/failure handling

### Root-cause trace

The socket handler admitted negative/non-finite counts and arbitrary modes. Its inner database catch logged a transaction/finalisation failure but continued into broadcast and success acknowledgement. The pre-transaction dedupe key also remained after failure, so retry could receive a false duplicate success.

### Regression and RED

- `server/services/websocket.sessionState.dbintegration.test.js`
  - `WebSocket headcount rejects invalid values and never acknowledges a failed transaction`

The regression covers negative/non-finite input, invalid mode, a deterministic cancelled-session finaliser failure, no `headcount_updated` broadcast, no row, no success, and a second retry proving the dedupe key was removed. RED accepted invalid values and acknowledged/broadcast after the failed transaction.

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='WebSocket headcount rejects invalid values' services/websocket.sessionState.dbintegration.test.js
✖ WebSocket headcount rejects invalid values and never acknowledges a failed transaction
  invalid values were accepted; cancelled-session failure still emitted success/broadcast.
```

### Fix

Counts require `Number.isFinite(headcount) && headcount >= 0`; modes use the existing allowlist. The REST combined headcount update uses the same allowlist. A failed transaction removes the dedupe entry, emits the typed error, and returns before broadcast or success.

### GREEN

```text
focused socket session-state file: 5 passed, 0 failed
```

## Finding 7 — rules-version retirement

### Root-cause trace

A rules-version change rebaselined evaluation state but left old factual events open in pastoral workflow and pending for delivery. The initial retirement trigger also depended on a mismatched `engagement_evaluation_state` row; dedupe/reset could remove that mutable row while old events remained. Pastoral loading and sending had no independent current-rules guard.

### Regression and RED

- `server/services/engagement/declines.dbintegration.test.js`
  - `rules-version rollover retires old workflow even when evaluation state was removed`
- `server/services/engagement/pastoral.dbintegration.test.js`
  - `pastoral workspace excludes decline events from retired calculation rules`
- `server/services/weeklyCaregiverEmail.dbintegration.test.js`
  - `sender independently cancels pending deliveries created under retired rules`

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='rules-version rollover retires old workflow' services/engagement/declines.dbintegration.test.js
declines initial RED: workflow open, delivery pending, cancellation reason null.
missing-state RED: same stale result after evaluation_state was absent.

cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='pastoral workspace excludes decline events from retired calculation rules' services/engagement/pastoral.dbintegration.test.js
pastoral RED: retired event remained visible.

cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='sender independently cancels pending deliveries created under retired rules' services/weeklyCaregiverEmail.dbintegration.test.js
sender RED: sent 1, expected 0.
```

### Fix

The existing event-load query now returns a constant-size `hasSupersededEvents` sentinel independently of evaluation state. When present, an idempotent transaction resolves old workflow rows and cancels pending deliveries with `rules_version_retired` without rewriting factual `recovered_at`. Pastoral source queries filter current rules, and the sender independently compares event/current rule versions before a provider call.

### GREEN

```text
rules retirement + 100-person query-bound selection: 2 passed, 0 failed
pastoral retired-rule selection: 1 passed, 0 failed
sender retired-rule selection: 1 passed, 0 failed
bounded evaluation remained 12 queries for 100 people.
```

## Finding 8 — fixed-source pastoral episode recurrence

### Root-cause trace

Reconciliation treated any resolved deterministic episode key as a collision and appended `:2`, recreating decline, visitor-next-step, and re-engagement episodes from the same immutable source. Only Community gaps are designed to recur after resolution.

### Regression and RED

- `server/services/engagement/pastoral.dbintegration.test.js`
  - `resolved fixed-source decline visitor and re-engagement episodes remain terminal`
  - existing `community-connected primary-irregular episodes can resolve and recur within one completed week`

RED recreated each fixed episode (including suffixed keys); expected no reactivation and no `:2`.

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='resolved fixed-source decline visitor and re-engagement episodes remain terminal' services/engagement/pastoral.dbintegration.test.js
✖ resolved fixed-source decline visitor and re-engagement episodes remain terminal
  actual recreated=true; expected false (and no suffixed episode key).
```

### Fix

Resolved fixed-source keys are terminal. Suffix recurrence is now exclusive to recurring Community gaps; that pre-existing recurrence behavior remains covered.

### GREEN

```text
selected fixed-source + Community recurrence tests: 2 passed, 0 failed
```

## Finding 9 — per-provider-call recipient revalidation

### Root-cause trace

The sender generated/revalidated all recipients once, then called the provider sequentially. Eligibility could change during an earlier provider call. A second gap remained when recipients originally shared an email: one regeneration could split that group into multiple digests, and the old inner loop sent both from the same snapshot.

### Regression and RED

- `server/services/weeklyCaregiverEmail.dbintegration.test.js`
  - `revalidates each queued recipient immediately before its provider call`
    - opt-out
    - assignment removal
    - pastoral dismissal
  - `revalidates a same-email group again after it splits before either provider call`

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='revalidates each queued recipient|revalidates a same-email group' services/weeklyCaregiverEmail.dbintegration.test.js
initial three scenarios: later recipient calls were 2, expected 1.
same-email split RED: provider calls were 3, expected 2.
```

### Fix

The initial digest is now only a stable recipient-ID queue. Each queued group is regenerated immediately before its single provider call. If current emails split a group, stable subgroups are re-enqueued and independently regenerated; there is no multi-send inner loop. Stale rows are cancelled with a machine-readable reason before send.

### GREEN

```text
weeklyCaregiverEmail.dbintegration.test.js: 19 passed, 0 failed
same-email aggregation and partial failure/retry compatibility remain green.
```

## Finding 10 — immutable event-time opportunity evidence

### Root-cause trace

The first fix bounded profile calculation to `effective_week_end`, but the calculator still reads current `gathering_lists` and current gathering roles. Later attendance was excluded, but removing a Primary assignment or changing its role made an old retry show `not_assigned, 0/0`. The original event schema stored no immutable counts/rate.

### Regression and RED

- `server/services/weeklyCaregiverEmail.dbintegration.test.js`
  - `delayed decline retries render Primary evidence from the event effective week`
  - `delayed retry preserves detection evidence after Primary assignment and role changes`
- `server/services/engagement/declines.dbintegration.test.js`
  - `persists each supported Primary decline once for a completed week` now asserts the snapshot
- `server/config/engagementSchema.dbintegration.test.js` asserts fresh/upgrade columns

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='delayed decline retries|delayed retry preserves detection evidence' services/weeklyCaregiverEmail.dbintegration.test.js
date-only RED: old event showed 9 opportunities after a later ninth session; expected 8.
metadata-mutation RED: retry showed {status:not_assigned, attended:0, opportunities:0, rate:null}; expected {status:casual, attended:3, opportunities:8, rate:0.375}.

cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test config/engagementSchema.dbintegration.test.js
schema RED: 2 failed; all three detection columns absent in fresh and upgrade contracts.
```

### Fix

Fresh and upgraded event tables now have nullable checked fields `primary_attended_at_detection`, `primary_opportunities_at_detection`, and `primary_rate_at_detection`. The decline transaction snapshots all three from the calculated Primary profile when it wins event insertion. Rendering derives status from immutable `to_tier` and prefers the persisted triplet. Legacy null events retain the bounded historical recomputation fallback. Dedupe collision merging copies the evidence atomically when the canonical event lacks a complete snapshot.

### GREEN

```text
schema: 2 passed, 0 failed
decline snapshot persistence: 1 passed, 0 failed
assignment/role mutation retry: 1 passed, 0 failed; both provider attempts rendered Casual 3/8 (0.375).
```

## Finding 11 — new-workflow failure isolation

### Root-cause trace

The scheduler placed decline evaluation in the same failure path as established weekly review delivery, and digest generation let pastoral/decline enrichment reject the whole operation. A new engagement failure therefore suppressed legacy weekly/absence email behavior.

### Regression and RED

- `server/services/weeklyReviewScheduler.test.js`
  - `a decline evaluation failure does not suppress established weekly or absence email paths`
- `server/services/weeklyCaregiverEmail.dbintegration.test.js`
  - `pastoral enrichment failure still sends the established absence-only digest`

RED produced no weekly review and zero email sends after the injected engagement failure.

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='decline evaluation failure does not suppress|pastoral enrichment failure still sends' services/weeklyReviewScheduler.test.js services/weeklyCaregiverEmail.dbintegration.test.js
✖ scheduler: reviews=[], expected ['admin']
✖ caregiver sender: sent 0, expected 1 absence-only digest
```

### Fix

The scheduler catches/logs only the evaluator failure and continues the established review/digest path. Digest generation catches/logs decline/pastoral enrichment failure and retains already-derived absence cards.

### GREEN

```text
scheduler focused test: 1 passed, 0 failed
absence-only enrichment-failure test: 1 passed, 0 failed
```

## Finding 12 — bulk conflict/concurrent caregiver snapshot

### Root-cause trace

Bulk event insertion used `DO NOTHING`, then joined all candidate natural keys back to the event table. A transaction that lost a concurrent insert could therefore attach its later caregiver snapshot to the winner's factual event.

### Regression and RED

- `server/services/engagement/declines.dbintegration.test.js`
  - `bulk conflict loser cannot snapshot caregivers onto the winning decline event`

The deterministic interceptor inserts the winning event and a late caregiver immediately before the loser's insert. RED reported `deliveriesCreated=1`; expected `0` for the losing transaction.

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='bulk conflict loser cannot snapshot caregivers' services/engagement/declines.dbintegration.test.js
✖ bulk conflict loser cannot snapshot caregivers onto the winning decline event
  deliveriesCreated: actual 1, expected 0
```

### Fix

The database transaction connection gained the narrow `queryReturning` primitive. Bulk event insertion now uses `DO NOTHING RETURNING id...`; delivery creation joins only IDs returned by this transaction. No natural-key rejoin can claim a concurrent winner.

### GREEN

```text
selected conflict/idempotency/query-bound tests: 3 passed, 0 failed
full declines file in Task 14: all passed
100-recipient snapshot remained bounded at 2 queries.
```

## Finding 13 — FK-safe merge/delete/reset policy

### Root-cause trace

Decline events correctly restrict person deletion, but dedupe and permanent delete did not define that policy. Dedupe attempted to delete a referenced person and could collide with an existing natural-key event. Permanent delete leaked a generic 500. `pastoral_insight_states.subject_id` initially lacked an equivalent FK. A first collision merge also discarded non-null recovery/detection/evidence fields. Finally, destructive sample/wipe scripts did not order deletes around the new RESTRICT edges.

### Regression and RED

- `server/config/engagementSchema.dbintegration.test.js`
  - fresh and legacy-upgrade FK assertions, including a pre-fix pastoral table
- `server/routes/families.dbintegration.test.js`
  - `individual deduplication re-homes engagement history and canonicalises event collisions`
  - `permanent deletion with engagement history returns an archive-only conflict`
- `server/routes/onboarding.timezone.dbintegration.test.js`
  - `clear sample data removes engagement history before deleting people`

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test config/engagementSchema.dbintegration.test.js
schema RED: pastoral subject FK undefined.

cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='individual deduplication|permanent deletion' routes/families.dbintegration.test.js
dedupe RED: real route 500 instead of 200.
permanent delete RED: real route 500 instead of typed 409.
collision factual RED: canonical recovered_at/family/detected_at stayed null/later.
collision evidence RED: canonical evidence stayed null instead of 3/8/0.375.

cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test --test-name-pattern='clear sample data removes engagement history' routes/onboarding.timezone.dbintegration.test.js
sample reset RED: FOREIGN KEY constraint failed; HTTP 500 instead of 200.
```

### Fix

- Fresh schema defines event/person and pastoral-subject `ON DELETE RESTRICT`; upgrade rebuilds the pre-release pastoral table after removing unusable orphan workflow rows.
- Dedupe transactionally rehomes unique events, canonicalises collisions, merges delivery state/attempts, rehomes/canonicalises pastoral state, preserves earliest factual detection/recovery and a non-null historical family, atomically preserves a complete evidence triplet, then removes duplicates.
- Evaluation state is deliberately cleared to rebaseline after identity/attendance/assignment mutation; immutable event history is preserved.
- Permanent delete checks event or pastoral history first and returns `409 ENGAGEMENT_HISTORY_REQUIRES_ARCHIVE`; ordinary archive remains unchanged.
- The intentionally destructive clear-sample-data, wipe, and demo reseed paths delete pastoral state, deliveries, events, and evaluation state in dependency order before people.

### GREEN

```text
schema: 2 passed, 0 failed
full families real-route suite: 17 passed, 0 failed
onboarding route suite: 2 passed, 0 failed
combined directly affected PCO/family/onboarding files: 21 passed, 0 failed
PRAGMA foreign_key_check returned no violations after dedupe.
```

## Finding 14 — best-effort report cache

### Root-cause trace

Long-term overview cache enumeration, reads, writes, and removal could throw. Network data was written to storage before authoritative React state, so quota/blocked-storage errors converted a successful API response into UI failure. Settings save similarly cleared cache before exposing the successful server response.

### Regression and RED

- `client/src/services/engagementReportCache.test.ts`
  - storage enumeration/read/write/remove failure cases
- `client/src/components/reports/LongTermHealthReport.test.tsx`
  - successful API load and settings save under throwing storage

```text
cd client && npm test -- --run src/services/engagementReportCache.test.ts src/components/reports/LongTermHealthReport.test.tsx
Test Files 2 failed; Tests 4 failed, 20 passed.
```

### Fix

All localStorage access, including enumeration and cleanup, is best-effort. Successful network state is installed before cache persistence. Successful settings state is made visible before cache invalidation. Cache failure can no longer replace an authoritative response with an error.

### GREEN

```text
same focused command: Test Files 2 passed; Tests 24 passed, 0 failed.
complete targeted client suite: 51 passed, 0 failed.
```

## Complete verification

### Prescribed Task 14 server suite

Exact command (run outside sandbox only because real-route tests bind ephemeral loopback):

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test \
  config/engagementSchema.dbintegration.test.js \
  services/attendanceSessionState.dbintegration.test.js \
  routes/attendance.sessionState.test.js \
  services/websocket.sessionState.dbintegration.test.js \
  services/websocket.kiosk.dbintegration.test.js \
  services/engagement/settings.dbintegration.test.js \
  routes/settings.engagement.test.js \
  services/engagement/opportunities.dbintegration.test.js \
  services/engagement/drilldownTokens.test.js \
  services/engagement/overview.dbintegration.test.js \
  routes/reports.engagement.test.js \
  services/engagement/declines.dbintegration.test.js \
  services/engagement/pastoral.dbintegration.test.js \
  routes/reports.pastoral.test.js \
  services/weeklyReviewScheduler.test.js \
  services/weeklyCaregiverEmail.dbintegration.test.js

tests 107
pass 107
fail 0
duration_ms 3333.059167
```

Expected negative-path transaction/error logs were emitted by assertions for invalid session transitions, provider failure, and missing pastoral enrichment; they did not represent suite failures.

### Directly affected server suites outside Task 14

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test \
  routes/families.dbintegration.test.js \
  routes/onboarding.timezone.dbintegration.test.js \
  services/planningCenter/checkinsImport.dbintegration.test.js \
  routes/integrations.pcoCheckins.dbintegration.test.js

tests 21
pass 21
fail 0
duration_ms 1202.59325
```

```text
cd server && NODE_PATH=/Users/isaaclee/Projects/Let\ My\ People\ Grow/letmypeoplegrow/.worktrees/qr-self-check-in/server/node_modules node --test \
  services/planningCenter/checkinsImport.test.js \
  services/planningCenter/checkinsImport.dbintegration.test.js

tests 33
pass 33
fail 0
```

### Prescribed client suite

```text
cd client && npm test -- --run \
  src/components/reports/ReportsPage.test.tsx \
  src/components/reports/LongTermHealthReport.test.tsx \
  src/components/reports/PastoralCareReport.test.tsx \
  src/components/reports/EngagementSettings.test.tsx \
  src/services/engagementReportCache.test.ts

Test Files 5 passed (5)
Tests 51 passed (51)
Duration 1.44s
```

### Production build

```text
cd client && npm run build
service worker generated
1403 modules transformed
built in 504ms
exit 0
```

The existing Vite chunk-size warning and Node `DEP0205` warning remain warnings only. The generated service-worker timestamp/cache-key diff was restored so the verification build did not add unrelated generated-file churn.

### Static and bounded-query audits

- `git diff --check`: clean.
- `node --check`: all changed/untracked server JavaScript passed.
- Production engagement DB calls use explicit `queryForChurch` / `transactionForChurch`; manual loop audit found no person-loop database query.
- Overview/decline/caregiver representative query bounds remain constant; decline evaluation measured 12 queries for 100 people and caregiver snapshot 2 queries for 100 caregivers.
- No package or lock file changed.

## Files changed

Production:

- `client/src/components/reports/LongTermHealthReport.tsx`
- `client/src/services/engagementReportCache.ts`
- `server/config/database.js`
- `server/config/engagementSchema.js`
- `server/config/schema.js`
- `server/middleware/auth.js`
- `server/routes/attendance.js`
- `server/routes/individuals.js`
- `server/routes/integrations.js`
- `server/routes/kiosk.js`
- `server/routes/onboarding.js`
- `server/scripts/seed-demo.js`
- `server/scripts/wipeChurchPeopleAndFamilies.js`
- `server/services/attendanceSessionState.js`
- `server/services/engagement/declines.js`
- `server/services/engagement/pastoral.js`
- `server/services/kioskMode.js`
- `server/services/planningCenter/checkinsImport.js`
- `server/services/websocket.js`
- `server/services/weeklyCaregiverEmail.js`
- `server/services/weeklyReviewScheduler.js`

Regression coverage:

- `client/src/components/reports/LongTermHealthReport.test.tsx`
- `client/src/services/engagementReportCache.test.ts`
- `server/config/engagementSchema.dbintegration.test.js`
- `server/routes/attendance.sessionState.test.js`
- `server/routes/families.dbintegration.test.js`
- `server/routes/integrations.pcoCheckins.dbintegration.test.js`
- `server/routes/onboarding.timezone.dbintegration.test.js`
- `server/services/attendanceSessionState.dbintegration.test.js`
- `server/services/engagement/declines.dbintegration.test.js`
- `server/services/engagement/pastoral.dbintegration.test.js`
- `server/services/planningCenter/checkinsImport.dbintegration.test.js`
- `server/services/websocket.kiosk.dbintegration.test.js`
- `server/services/websocket.sessionState.dbintegration.test.js`
- `server/services/weeklyCaregiverEmail.dbintegration.test.js`
- `server/services/weeklyReviewScheduler.test.js`

## Self-review and residual concerns

- Independent whole-diff read-only review concluded **PASS** with no remaining concrete correctness or security regression. Its follow-up edge cases (same-email subgroup revalidation, mutable assignment evidence, state-independent rules retirement, collision recovery/evidence, and destructive reset ordering) are included above.
- Church isolation is explicit in all new predicates, route/service queries, and merge/reset mutations. No request payload/query church ID is trusted.
- Historical provenance and non-null people type are preserved; PCO history remains held v0; dedupe keeps factual event recovery/evidence.
- Recipient privacy is enforced immediately before every provider call. Transaction failure cannot broadcast/acknowledge success, and conflict-loser delivery snapshots cannot attach to a winner.
- Legacy decline events created before the three evidence columns existed necessarily have null immutable evidence. They use a bounded event-week recomputation fallback; exact assignment/role history cannot be reconstructed if that metadata has since changed. All newly detected events persist immutable evidence.
- Dedupe intentionally deletes mutable evaluation state and rebaselines because merging identities can change attendance, assignments, and family identity. This avoids treating either duplicate's state as factual; immutable events, recovery, deliveries, and pastoral workflow are rehomed.
- A non-required diagnostic `config/database.test.js` run produced 32/35 with three unrelated failures (fresh scheduled-PCO authority and two oldest legacy-schema cases). The exact same 32/35 and same failures reproduce from a clean `HEAD` archive before this fix wave, proving they are not introduced here. They were not addressed because they are outside the numbered scope and dependency/package changes were explicitly prohibited.
