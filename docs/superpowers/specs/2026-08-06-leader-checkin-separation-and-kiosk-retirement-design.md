# Leader Check-in Separation and Legacy Kiosk Retirement

**Date:** 2026-08-06

**Status:** Approved design

**Scope:** Separate authenticated leader check-in from the retired roster-loading self-check-in kiosk

## Summary

Leader check-in and self-service kiosk check-in currently share the `/api/kiosk` REST routes, `record_kiosk_action` WebSocket event, client API, and audit terminology. The global `KIOSK_MODE_ENABLED` privacy gate therefore blocks legitimate leader check-in REST fallback and history requests when self-service kiosk mode is disabled. The WebSocket handler does not apply the same gate or gathering-access checks, so the two transports enforce different policies.

This change gives leader check-in its own REST and WebSocket contracts with one shared server-side authorization policy. The existing self-check-in implementation is retired rather than adapted: its full-roster browser UI, PIN lock, offline roster cache, write APIs, and WebSocket mutation path are removed. Existing audit history and legacy schema columns remain intact.

A future parent-operated QR and custom-code check-in flow is a separate project with a different trust model. It is not part of this design.

## Goals

- Make leader check-in independent of `KIOSK_MODE_ENABLED` and all retired self-service configuration.
- Apply the same church, gathering, role, assignment, and individual validation to REST and WebSocket writes.
- Preserve a unified historical check-in/check-out timeline across legacy and leader actions.
- Remove the browser-facing self-check-in implementation that exposes the full church roster on an unattended device.
- Give stale clients explicit, non-mutating retirement errors for one release.
- Retain existing data and dormant columns without a destructive migration.

## Non-goals

- Designing or implementing parent QR codes, custom family codes, phone authentication, or limited family views.
- Renaming or rebuilding the `kiosk_checkins` table.
- Guessing whether existing audit rows originated from leader or self-service mode.
- Changing ordinary attendance recording, attendance history, visitor creation, or attendance WebSocket broadcasts beyond the leader check-in integration points.
- Dropping legacy gathering columns.

## Terminology

- **Leader check-in:** An authenticated admin, coordinator, or attendance taker checks people in or out on their behalf.
- **Legacy kiosk:** The retired PIN-locked, full-roster self-service browser experience.
- **Future parent check-in:** A separately designed phone flow entered through a QR code and protected by a custom code. This term reserves no specific API or database value in this design.

## Current failure and security boundary

The current kiosk router authenticates the user, exposes `/api/kiosk/status`, and then rejects every remaining route with `403 KIOSK_DISABLED` unless `KIOSK_MODE_ENABLED=true`. Leader check-in uses those rejected routes for REST fallback and history, even when `leader_checkin_enabled` is set on the gathering.

The equivalent WebSocket handler accepts any authenticated socket and does not enforce the global gate, gathering assignment, or leader/self mode. A leader can therefore succeed over WebSocket but receive a 403 from REST for the same action. Authorization must belong to the leader check-in operation itself and must not depend on transport.

## Architecture

### Dedicated leader check-in domain

Introduce a leader check-in route module mounted at `/api/leader-checkins` and a shared server-side access policy used by both the route module and WebSocket service.

The shared policy accepts trusted server context:

- `churchId`
- `userId`
- `userRole`
- `gatheringTypeId`
- operation kind: `write`, `history`, or `delete`

It returns the church-scoped gathering when authorized and throws a typed error otherwise. Clients never choose or submit an authorization mode.

### Access policy

All lookups include `church_id` even though each church currently has its own SQLite database.

For writes:

- The gathering must exist in the authenticated church.
- The gathering must be active, use standard individual attendance, and have `leader_checkin_enabled = 1`.
- Admins may write without an assignment.
- Coordinators and attendance takers must have a matching `user_gathering_assignments` row.
- Any unsupported role is denied.
- Every submitted individual ID must exist in the same church. The request fails atomically if any ID is invalid; it must not partially write valid IDs.

For history reads:

- The gathering must exist in the authenticated church.
- Admins may read without an assignment.
- Coordinators and attendance takers must be assigned to the gathering.
- History remains readable when the gathering is inactive or leader check-in is later disabled.

For history deletion:

- The gathering must exist in the authenticated church.
- Only admins may delete.
- Deletion remains available after a gathering or feature is disabled.

Typed denials distinguish `LEADER_CHECKIN_DISABLED`, `GATHERING_ACCESS_DENIED`, `GATHERING_NOT_FOUND`, `INDIVIDUAL_NOT_FOUND`, and `ROLE_NOT_ALLOWED`. Authentication and church-approval middleware retain their existing behavior.

## REST API

The new API keeps the useful response shapes from the existing leader UI while changing the namespace and authorization.

### Record an action

`POST /api/leader-checkins/:gatheringTypeId/:date`

Request:

```json
{
  "operationId": "018f47e2-86a2-7f61-9eb8-8b93ecfe61c4",
  "individualIds": [12, 15],
  "action": "checkin",
  "signerName": "Parent or guardian name"
}
```

Rules:

- `operationId` is a required UUID generated once for the user action and reused by WebSocket and REST fallback attempts.
- `individualIds` is a non-empty, duplicate-free array of positive integer IDs.
- `action` is `checkin` or `checkout`.
- `signerName` is optional and normalized with the existing input-safety conventions.
- A check-in records the audit action, marks attendance present, snapshots `people_type_at_time` when available, and updates `last_attendance_date` in one church-scoped transaction.
- A checkout records the audit action but does not mark attendance absent.
- New rows explicitly set `checkin_mode = 'leader'`.
- Success continues to broadcast the existing church-scoped attendance update for check-ins and a leader check-out event for checkouts.

### Read history

- `GET /api/leader-checkins/history/:gatheringTypeId?limit=20`
- `GET /api/leader-checkins/history/:gatheringTypeId/:date`

History returns a unified timeline. It does not filter out legacy rows or future modes. Each raw record includes `checkinMode`, allowing the UI and audit consumers to identify `legacy` and `leader` entries without changing the existing per-person check-in/check-out summary.

### Delete a dated history session

`DELETE /api/leader-checkins/history/:gatheringTypeId/:date`

This remains admin-only and deletes all check-in modes for that gathering and date because the displayed timeline is unified.

## WebSocket contract

The leader client emits:

```text
record_leader_checkin_action
```

The payload contains `operationId`, `gatheringId`, `date`, `individualIds`, `action`, and `signerName`. The server derives user and church identity from the authenticated socket.

The server responds only to the sender with:

- `leader_checkin_action_success`
- `leader_checkin_action_error`

Errors include a stable safe `code` and user-safe `message`. The WebSocket handler calls the same access-policy and transactional domain functions as REST rather than maintaining a second authorization or write implementation.

Existing `attendance_update` broadcasts remain the canonical real-time notification for successful check-ins. Checkouts use `leader_checkin:checkout`. Selection-presence events used by multiple leaders may retain their current behavior but must be renamed if they contain kiosk terminology exposed as part of the public client contract.

## Shared domain service

REST and WebSocket must delegate to one leader check-in service for:

- access authorization;
- request normalization and individual validation;
- recording check-in/check-out audit rows;
- attendance-session upsert;
- attendance-record upsert;
- historical people-type snapshotting;
- last-attendance update; and
- construction of broadcast data.

This removes the current duplicated transaction bodies and prevents future policy drift. Transport adapters remain responsible only for authentication context, HTTP/socket response mapping, and broadcasting after a committed transaction.

The service treats `operationId` as an idempotency key within the church. A retry with the same canonical gathering, date, action, signer, and individual set returns the original success without adding audit rows or rebroadcasting. Reusing an operation ID with different canonical input fails with `409 OPERATION_ID_REUSED`. SQLite write-transaction serialization and the database index described below prevent concurrent WebSocket and REST attempts from both committing.

## Data model and migration

Retain `kiosk_checkins` as the audit table. Add:

```sql
checkin_mode TEXT NOT NULL DEFAULT 'legacy',
operation_id TEXT NULL
```

`checkin_mode` deliberately has no database `CHECK` enum. Existing rows become `legacy` through the additive default; the migration must not infer their origin. New leader writes explicitly store `leader`. Future work may add another application-validated value without rebuilding the SQLite table.

All rows created by one leader action share its operation ID. Existing rows retain `NULL`. Add a partial unique index on `(church_id, operation_id, individual_id)` where `operation_id IS NOT NULL`; this prevents duplicate per-person audit rows while allowing multiple people in one action and unlimited legacy nulls. Before treating an existing operation as an idempotent success, the service compares its complete canonical input and rejects mismatched reuse.

Schema application follows the repository's additive migration conventions:

- include the column in the canonical `server/config/schema.js` table definition for new church databases;
- add an idempotent startup/schema migration for existing church databases; and
- verify the migration independently for multiple church databases.

The following gathering columns remain present but dormant:

- `kiosk_enabled`
- `kiosk_message`
- `kiosk_end_time`

They are no longer exposed by ordinary gathering API responses, accepted in create/update requests, or rendered in the client. No migration drops or rewrites them.

## Client changes

### Leader workflow

- Replace `kioskAPI` with `leaderCheckInsAPI` for recording and history.
- Rename the WebSocket context method to `sendLeaderCheckInAction` and use the new events.
- Keep `LeaderCheckInMode`, `CheckInHistory`, leader selection coordination, REST fallback, visitor handling, and ordinary attendance refresh behavior.
- The Check-ins page lists only standard gatherings with `leaderCheckinEnabled`.
- Admins and coordinators retain the leader mode selection where applicable; an attendance taker with one assigned leader-enabled gathering may continue to auto-start.
- Gathering management retains only the leader check-in toggle and leader-facing explanatory copy.

### Remove legacy self-service UI

Remove:

- `SelfCheckInMode`;
- PIN setup/unlock and locked-session state;
- kiosk welcome-message and end-time UI;
- the full-roster self-service presentation;
- offline kiosk roster cache and submission queue;
- self/leader mode selection state that is no longer necessary;
- `kioskAPI.getStatus()` calls;
- self-check-in navigation and availability logic; and
- client types and response mapping for dormant kiosk fields.

The leader page must not load or retain any retired self-service state from local storage. Obsolete kiosk cache and queue keys are removed during client startup without attempting to submit queued actions.

## Retirement and stale clients

For one release, keep an authenticated compatibility router at `/api/kiosk` that performs no reads or mutations and returns:

```json
{
  "code": "KIOSK_RETIRED",
  "error": "This self check-in experience has been retired. Refresh the app to use leader check-in."
}
```

The response status is `410 Gone`. This includes the former status, record, history, and delete paths. No old request is silently forwarded because the server cannot reliably prove whether a stale client intended leader or self-service behavior.

For the same release, retain `record_kiosk_action` only as a non-mutating listener that emits `kiosk_action_error` with code `KIOSK_RETIRED`. Remove both compatibility surfaces in the following release after operational logs show stale usage has ceased.

The deployment must regenerate the service worker so installed PWAs receive the new client. Operators should monitor counts of `KIOSK_RETIRED` responses/events during the compatibility release.

## Configuration and documentation

Remove `KIOSK_MODE_ENABLED` from compose files, environment examples, deployment documentation, and runtime code. It no longer protects a live feature.

Update architecture and operator documentation to state:

- leader check-in is authenticated and assignment-scoped;
- the legacy full-roster kiosk is retired;
- dormant database columns and legacy audit rows remain intentionally; and
- parent QR check-in requires a separate approved design before implementation.

## Error handling and transaction behavior

- Validation and authorization occur before opening the write transaction where practical.
- Individual validation is repeated or protected within the same church context immediately before mutation so the operation fails closed.
- Any failed write rolls back the audit row and attendance mutation together.
- Broadcasts occur only after commit. Broadcast failure is logged but does not relabel or undo a committed write.
- REST fallback must reuse the WebSocket attempt's required operation ID. A committed action with a lost acknowledgement is returned as an idempotent success and is not rebroadcast; mismatched operation-ID reuse is rejected.
- Logs include church ID, user ID, gathering ID, action, transport, error code, and record count without names, signer text, medical information, or raw payloads.

## Security and privacy requirements

- No leader endpoint or event trusts client-supplied church, user, role, or mode.
- Every gathering, assignment, individual, attendance, and history query is church-scoped.
- REST and WebSocket execute the same authorization policy and domain transaction.
- The retired router never returns roster or history data.
- The client no longer places a full church roster or queued self-service actions into kiosk-specific local-storage keys.
- Leader check-in responses continue to exclude medical-note indicators and other fields outside the established leader UI contract.
- A future QR flow must expose only an explicitly authorized family/household subset and must not reactivate the retired full-roster design.

## Testing strategy

### Access-policy unit tests

- Admin write access to a leader-enabled standard gathering.
- Assigned coordinator and attendance-taker access.
- Unassigned non-admin denial.
- Unsupported-role denial.
- Disabled, inactive, headcount, missing, and foreign-church gathering denial for writes.
- Historical read access after leader check-in is disabled.
- Admin-only deletion.

### REST database integration tests

- Leader check-in succeeds with `KIOSK_MODE_ENABLED` absent or false.
- Check-in and checkout persist `checkin_mode = 'leader'`.
- Invalid or foreign individual IDs cause a full rollback.
- Retrying an operation ID through the other transport is idempotent, while mismatched reuse returns `OPERATION_ID_REUSED`.
- Check-in updates attendance, people-type history, and last attendance.
- Checkout does not mark attendance absent.
- Unified history returns legacy and leader records with their modes.
- Cross-church history and deletion are inaccessible.
- Retired kiosk endpoints return 410 and cause no database changes.

### WebSocket database integration tests

- The new event produces the same committed state as REST.
- Assigned and unassigned users receive the same authorization outcomes as REST.
- Invalid individuals roll back the full action.
- Success and error acknowledgements use only the new event names.
- The retired event returns `KIOSK_RETIRED` and performs no mutation.
- Concurrent REST and WebSocket attempts with one operation ID commit once.
- Broadcasts are church-scoped and occur only after commit.

### Client tests

- Check-ins availability depends only on `leaderCheckinEnabled`.
- Leader actions call `leaderCheckInsAPI` and the new WebSocket method.
- REST fallback uses the leader endpoint.
- History reads and admin deletion use the leader endpoint.
- No self-check-in mode, kiosk status request, PIN state, offline queue, or kiosk gathering controls remain.
- Stale kiosk local-storage keys are deleted without replay.

### Migration tests

- A legacy database gains `checkin_mode`, `operation_id`, and the partial unique index idempotently.
- Existing rows read as `legacy` without data loss.
- New church databases contain the column.
- Re-running schema initialization does not rewrite modes.

## Rollout

1. Add the database column and shared leader check-in domain/access services.
2. Add and verify the new REST and WebSocket contracts.
3. Switch the client leader workflow and history to the new contracts.
4. Remove the self-service UI, local caches, configuration, and environment flag.
5. Install the non-mutating 410 and WebSocket retirement compatibility surfaces.
6. Regenerate the PWA service worker and deploy server and client together.
7. Verify leader check-in through WebSocket, forced REST fallback, history, and checkout using admin and assigned attendance-taker accounts.
8. Monitor retirement codes and authorization denials by code, without payload data.
9. Remove the compatibility router/listener in the following release once stale usage is acceptably low.

## Acceptance criteria

- Leader check-in works when no kiosk environment flag exists.
- REST and WebSocket apply identical leader authorization and church isolation.
- Leader history contains the combined legacy and leader timeline with an explicit mode per raw record.
- The current self-check-in UI and all of its write paths, roster caches, configuration controls, and runtime flag are absent.
- Old kiosk clients receive a typed, non-mutating retirement response for one release.
- Existing audit history and dormant gathering columns are preserved.
- Tests demonstrate that unassigned or cross-church users cannot record or read leader check-ins.
- The future parent QR flow remains explicitly out of scope and cannot accidentally inherit the retired full-roster trust model.
