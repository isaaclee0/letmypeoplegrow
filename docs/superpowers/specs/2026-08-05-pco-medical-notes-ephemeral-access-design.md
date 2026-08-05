# PCO Medical Notes: Ephemeral Access and Gathering-Scoped Indicators

**Date:** 2026-08-05

**Status:** Approved design

**Scope:** Planning Center integration settings, medical-note presence refresh, Take Attendance, People, live note access, auditing, and privacy controls

## Summary

Let My People Grow (LMPG) will show selected users that a Planning Center Online (PCO) person has medical notes and will let those users read the current note on demand. Medical-note text remains owned by PCO and must never be persisted by LMPG. LMPG stores only a boolean presence flag and non-content operational metadata.

The feature is disabled by default. An administrator must enable it, choose the minimum LMPG role that may see medical information, and select the standard-attendance gatherings for which medical notes are relevant. The indicator and live-note action appear only for people assigned to one of those gatherings.

The browser never contacts PCO directly and never receives a PCO credential. A church-scoped backend endpoint authorizes each reveal, fetches the current Person through LMPG's centralized PCO credential path, emits a content-free audit record, and returns only the medical-note string with strict no-store headers.

## Goals

- Make relevant PCO medical notes available during authenticated Take Attendance and People workflows.
- Persist only whether a medical note exists, never its text.
- Let each church choose the minimum LMPG role allowed to see the indicator and text.
- Limit exposure by gathering assignment.
- Remain safe and understandable on offline or patchy connections.
- Record every reveal attempt without recording medical content.
- Reuse the centralized PCO credential and refresh coordination path.

## Non-goals

- Editing PCO medical notes from LMPG.
- Copying notes into family notes, person badges, custom fields, exports, reports, notifications, WebSocket events, or offline data.
- Showing medical information in self check-in/kiosk or leader check-in.
- Mirroring a user's personal PCO permissions. LMPG uses the church's connected PCO credential and therefore enforces its own explicit authorization policy.
- Guaranteeing physical zeroization of JavaScript strings. LMPG can remove all application-controlled references but cannot control garbage-collector memory reuse.
- Handling PCO profile Notes resources or note categories. This feature concerns only `Person.attributes.medical_notes`.

## Review of the Initial Idea

The initial proposal has the correct central policy: raw medical text must not be stored, and the live value must be fetched only when requested. The app's current architecture requires the following corrections and additions:

1. The React client must not call PCO directly. PCO OAuth credentials are stored server-side, may have been connected by another user, and must never be exposed to the browser.
2. Component state alone is insufficient unless the HTTP response is also non-cacheable and excluded from service-worker behavior, client caches, logging, analytics, and error capture.
3. The attendance roster is deliberately cached in `localStorage`. Only the permitted boolean may enter that response; medical text must use a separate endpoint and response path.
4. LMPG roles do not map to the connected PCO user's permissions. The feature needs an administrator-configured LMPG role threshold and server-side enforcement.
5. The existence of a medical note is itself sensitive. Users below the configured threshold must receive neither `true` nor `false`; the field must be omitted.
6. Gathering relevance must be enforced by the server. Client filtering is not an authorization boundary.
7. The generic audit middleware is unsuitable because it records only successful responses asynchronously, may serialize request bodies, and coalesces nearby events.
8. Request cancellation removes application references but cannot promise physical memory erasure.

## Authoritative Privacy Invariant

LMPG may persist:

- `pco_has_medical_notes`, as `0` or `1`;
- whether the feature is enabled;
- the configured minimum viewer role;
- selected gathering IDs;
- refresh timestamps and content-free refresh outcomes;
- content-free access-audit metadata.

LMPG must never persist or intentionally retain:

- the medical-note string or an excerpt;
- note length, a hash, keywords, classification, or derived summary;
- a raw PCO Person payload containing `medical_notes`;
- a serialized provider error or request/response object that may contain medical text;
- the note in SQLite, local storage, session storage, IndexedDB, Cache Storage, service-worker caches, global React contexts, smart caches, offline queues, logs, traces, analytics, audit rows, notifications, exports, sync plans, or WebSocket messages.

The medical-note string may exist only in the following transient locations for the duration required to serve an authorized request:

- the current PCO HTTP response buffer on the server;
- a local variable in the dedicated extraction path;
- the outbound no-store HTTP response;
- the open modal's component state.

Code handling the string must avoid broad object spreading, raw-object logging, or passing the provider envelope beyond the dedicated service boundary.

## Data Model

### Individuals

Add to both the base schema and additive migration path:

```sql
pco_has_medical_notes INTEGER NOT NULL DEFAULT 0
```

SQLite boolean semantics apply: `0` is false and `1` is true. The API converts authorized values to JSON booleans.

The field belongs on `individuals`, not a generic Person model; this app has no separate Person persistence layer.

### Church settings

Add:

- `planning_center_medical_notes_enabled INTEGER NOT NULL DEFAULT 0`
- `planning_center_medical_notes_minimum_role TEXT NOT NULL DEFAULT 'admin'`
- `planning_center_medical_notes_last_refreshed_at TEXT`
- `planning_center_medical_notes_last_refresh_result TEXT`

The allowed role values are `admin`, `coordinator`, and `attendance_taker`. Validation occurs in application code because existing additive migrations do not rebuild tables to add constraints.

`planning_center_medical_notes_last_refresh_result` contains only a bounded status code and safe counts, never provider payloads or medical values.

### Relevant gatherings

Create a normalized join table:

```sql
CREATE TABLE IF NOT EXISTS planning_center_medical_note_gatherings (
  church_id TEXT NOT NULL,
  gathering_type_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (church_id, gathering_type_id),
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE
);
```

All reads and writes include `church_id`. Saving settings validates that every selected gathering belongs to the church, is active, and has `attendance_type = 'standard'`.

## Role Policy

Roles form this explicit visibility hierarchy:

| Configured minimum | Authorized LMPG roles |
|---|---|
| `admin` | admin |
| `coordinator` | admin, coordinator |
| `attendance_taker` | admin, coordinator, attendance_taker |

The same rule controls both the boolean indicator and live text. Users below the threshold receive no medical-note field in DTOs and cannot call the live endpoint successfully.

The server owns this mapping. The client may mirror it to avoid rendering controls, but client checks are not authoritative.

## Gathering Eligibility

### Take Attendance

A person is eligible only when all of the following are true:

- the feature is enabled;
- the viewer meets the configured role threshold;
- the selected gathering is in `planning_center_medical_note_gatherings`;
- the viewer has access to the selected gathering under the existing `requireGatheringAccess` policy;
- the individual is active, belongs to the church, has a nonblank `planning_center_id`, and is currently assigned to that gathering through `gathering_lists`.

Historical attendance alone does not confer eligibility after the person is removed from the current gathering roster.

The main roster and eligible recent-visitor rows may receive the boolean. The **All People** section must not show it for people who are not currently assigned to the selected gathering.

### People

The People route remains limited to its existing admin/coordinator page access. An otherwise-authorized person is eligible when assigned to at least one selected medical-notes gathering. This is union semantics across selected gatherings.

The server computes eligibility with a church-scoped `EXISTS` query. The client does not infer eligibility from cached gathering arrays.

### Excluded surfaces

Self check-in/kiosk, leader check-in, reports, exports, notifications, and WebSocket messages must not receive either the boolean or note text.

## Settings Experience

Add a **Medical notes** section to the Planning Center integration panel with:

- an enable switch, default off;
- a minimum-access select using user-facing labels:
  - Admins;
  - Coordinators and Admins;
  - Attendance Takers, Coordinators, and Admins;
- a multi-select of active standard gatherings;
- the last successful indicator-refresh time;
- a **Refresh indicators now** action;
- privacy copy stating that LMPG stores only whether a note exists and fetches note text live without retaining it.

Enabling requires an active PCO connection and at least one selected gathering. Settings are saved before the initial refresh begins. Until a complete initial refresh succeeds, no indicators appear and the panel shows a pending or failed refresh state.

Changing the role threshold takes effect on the next server response. Removing a gathering immediately removes eligibility. Adding a gathering can use existing account-wide flags.

Disabling the feature atomically sets the enabled flag to `0` and clears `pco_has_medical_notes` for every individual in the church. Gathering and role selections may be retained for convenient re-enablement.

Disconnecting PCO atomically turns this feature off and clears all flags for the church. It retains the configured minimum role and gathering selections, but an admin must explicitly re-enable the feature after reconnecting.

## Medical-Note Presence Refresh

### Dedicated service

Implement a medical-note status service separate from batch projection and apply logic. Its normalized snapshot contains only:

```js
{
  fetchedAt,
  complete: true,
  people: [{ id, hasMedicalNotes }]
}
```

`hasMedicalNotes` is true only when `medical_notes` is a string and `medical_notes.trim().length > 0`.

The service requests a complete, paginated account-wide PCO People snapshot using JSON:API sparse fields where supported, limited to the Person ID and `medical_notes`. It projects each Person immediately and discards each raw page before proceeding. It does not reuse the general people-sync normalized person object because that would make medical state available to match, review, and plan code that does not need it.

### Application

Only a complete snapshot may mutate flags. Apply it in one `transactionForChurch` operation:

1. Clear the flag on inactive or unlinked individuals in that church so stale sensitive metadata is not retained.
2. Load every active individual with a nonblank `planning_center_id` for that church.
3. Set the flag from the snapshot map.
4. Set the flag to false for a linked active individual absent from the complete snapshot.
5. Update the last-success timestamp and safe result counts.

An incomplete page sequence, authentication failure, timeout, rate-limit exhaustion, malformed Person resource, or provider error leaves all existing flags unchanged. Partial provider data must never be interpreted as note removal.

Only active linked LMPG individuals are updated, but the provider snapshot is account-wide so a person linked outside current batches is still accurate.

### Triggers and coalescing

Refresh when:

- an admin enables the feature;
- an admin selects **Refresh indicators now**;
- a manual or unattended PCO people-sync run completes successfully;
- the daily PCO scheduler reaches the medical-status refresh step.

Unattended refresh requires both the feature toggle and the existing Planning Center scheduling master switch. Manual refresh and live reads remain available while the scheduling master is off.

Use a church-scoped in-flight promise and short successful-snapshot TTL, following the background-check refresh pattern, so several batches cannot launch duplicate account-wide reads. Credential-epoch coordination must prevent applying a snapshot fetched with a superseded PCO connection.

## Live Note Endpoint

Add this backend-only endpoint:

```http
GET /api/individuals/:id/pco-medical-notes?context=:context&gatheringTypeId=:gatheringId
```

`context` is required and accepts only `attendance` or `people`. `gatheringTypeId` is required for `context=attendance` and forbidden for `context=people`. Missing, extra, or invalid context parameters are rejected before authorization or provider access.

### Authorization order

Before making a provider call, the endpoint verifies:

1. authenticated user and church context;
2. feature enabled;
3. configured role threshold;
4. local individual belongs to the church, is active, and is PCO-linked;
5. relevant-gathering eligibility;
6. existing viewer gathering access for attendance context.

The role threshold is checked before target lookup; a user below it receives `403 MEDICAL_NOTES_FORBIDDEN` without revealing whether the requested target exists. For an otherwise-authorized user, cross-church, missing, unlinked, inactive, or gathering-ineligible targets return the same `404 MEDICAL_NOTES_NOT_AVAILABLE` response so callers cannot probe person or gathering IDs. Every database query includes the church ID.

The endpoint requires the stored flag to be true. A stale false flag is refreshed by scheduled/manual presence refresh rather than allowing arbitrary linked-person probing through the live endpoint.

### Provider request and response

Fetch `/people/v2/people/{encodedPcoPersonId}` through `withPlanningCenterSourceToken`. Request only `medical_notes` through sparse fields where supported. Do not return the PCO Person envelope.

On success:

- extract and trim only for presence checking;
- return the original plain-text value as `{ "medicalNotes": "..." }` when nonblank;
- do not return HTML or other Person attributes.

If the live value is now blank, update the local boolean to false using an ID-, church-, and PCO-link-scoped update. Return `409 MEDICAL_NOTES_NO_LONGER_PRESENT` with no note field, and let the client remove the current indicator.

The route sets on every response:

```http
Cache-Control: private, no-store, max-age=0
Pragma: no-cache
Expires: 0
```

It removes `ETag`. Service-worker routing must not cache the endpoint. The response must not pass through `SmartCacheContext`, module caches, retry caches, or persistence helpers.

### Error taxonomy

Return bounded application errors without provider response bodies:

- `MEDICAL_NOTES_FORBIDDEN` when the requester is below the configured role threshold, checked before target lookup;
- `MEDICAL_NOTES_NOT_AVAILABLE` for disabled, disconnected, missing-link, cross-church, or gathering-ineligible cases;
- `MEDICAL_NOTES_PROVIDER_UNAVAILABLE` for PCO timeout, rate-limit exhaustion, or transient failure;
- `MEDICAL_NOTES_NO_LONGER_PRESENT` when a formerly true flag is now blank.

Do not serialize an Axios error, PCO envelope, request config, headers, or raw response into the application response or logs.

A browser-to-LMPG network failure has no server response code. The client maps it to the modal's unavailable/offline state.

## Audit Design

Create a dedicated medical-note audit writer rather than using generic `auditLog`.

Each reveal attempt has its own row and is never coalesced. Use an explicit metadata allowlist:

- action, such as `VIEW_PCO_MEDICAL_NOTES`;
- requesting user ID;
- church ID;
- local individual ID;
- gathering ID when supplied;
- context (`attendance` or `people`);
- timestamp;
- outcome (`success`, `denied`, `unavailable`, or `no_longer_present`);
- IP address and user agent, consistent with the existing audit table.

Do not record PCO response bodies, medical text, excerpts, note length, hashes, PCO tokens, request bodies, or raw errors.

Denied and failed attempts are recorded when possible. Before returning a successful note, the server must persist the success audit event. If that insert fails, discard the note reference and return an unavailable response. Disclosure therefore fails closed when success auditing is unavailable.

## Client Data Contracts

Add an optional `hasMedicalNotes?: boolean` field only to DTOs used by authorized Take Attendance and People responses.

- Authorized and eligible: return `true` or `false` as applicable. Rendering occurs only for `true`.
- Unauthorized or ineligible: omit the property entirely.
- Never put `medicalNotes` on an Individual, Visitor, family, attendance, or people-list DTO.

The only API method returning text is the dedicated live method. It must return directly to the modal component and must not update a global store or cached person object.

## User Interface

### Indicator

Render a small button beside the person's name when `hasMedicalNotes === true`. It must:

- have an accessible label such as `View medical notes for Jane Smith`;
- expose a tooltip with the same meaning;
- use a medical icon whose meaning does not depend on color alone;
- stop click and pointer event propagation so it cannot toggle attendance, add a person, select a card, or open an edit action;
- be absent rather than disabled for unauthorized users.

### Modal

The dedicated modal owns all note state and supports:

- `loading`;
- `success`;
- `no_longer_present`;
- `unavailable`.

Render medical text as plain React text with preserved line breaks (`white-space: pre-wrap`). Do not use `dangerouslySetInnerHTML`, Markdown rendering, linkification that creates active content, or copy the value into form state.

The unavailable message is:

> Unable to load medical notes right now. Check your connection and try again, or view them directly in Planning Center.

Provide **Try again** and **Close**. A direct Planning Center link may be shown only if it contains the already-known PCO person ID, opens safely, and does not carry tokens or medical values.

## Offline and Patchy Connectivity

- `navigator.onLine === false` may produce an immediate offline state, but `true` is not treated as proof of connectivity.
- Use `AbortController` with a 20-second client deadline. The server's provider operation has a 15-second overall deadline, including server-side retries.
- Do not automatically retry from the browser. Retrying is an explicit user action.
- Clear any previously displayed text before starting a retry.
- Closing, changing person, navigating away, or unmounting aborts the request and clears note state.
- Use a monotonically increasing request generation or equivalent guard so a late response cannot populate a closed modal or the wrong person's modal.
- Server-side PCO retry behavior remains in the existing bounded read client. The live request has an overall deadline so layered retries cannot leave the modal loading indefinitely.
- Never fall back to a cached or previously viewed note.
- If connectivity fails after the status indicator was loaded from the permitted attendance `localStorage` cache, the indicator may remain visible but opening it shows the unavailable state.
- A partially downloaded scheduled status snapshot makes no database changes. Existing booleans remain until a complete refresh succeeds.

The medical text may remain visible in the currently open modal if connectivity drops after a completed reveal. It is cleared when the modal closes or changes target.

## Logging and Observability

Operational logs may include:

- church ID;
- local individual ID;
- safe outcome code;
- duration;
- HTTP/provider status category;
- count of flags updated by a complete refresh.

They must not include the PCO Person payload, medical content, content-derived metadata, access/refresh tokens, provider headers, or serialized provider errors.

Metrics should count refresh and reveal outcomes only. Error-reporting and tracing integrations must receive sanitized errors constructed at the medical service boundary.

## Security and Failure Behavior

- All database access is church-scoped.
- PCO IDs are encoded before constructing provider paths.
- Role and gathering eligibility are re-evaluated on every reveal.
- Disabling the feature or removing a gathering revokes access without waiting for a client refresh.
- PCO authentication errors do not clear flags; they surface as unavailable and preserve the last complete snapshot.
- A blank live note self-corrects only the exact linked individual in the current church.
- A deleted or relinked individual cannot be updated by an in-flight response because the correction update also matches the original `planning_center_id`.
- Note content is never broadcast over Socket.io.
- No note content enters application error messages.

## Testing Strategy

### Schema and settings

- New church databases contain the column, settings, and relevance table.
- Existing databases receive additive migrations without losing data.
- Feature defaults to off and minimum role defaults to admin.
- Invalid roles, inactive/headcount/cross-church gatherings, and enabled-with-empty-selection settings are rejected.
- Gathering deletion cascades only the matching church relevance row.
- Disable and PCO disconnect clear flags for only the current church.

### Projection and refresh

- Null, missing, non-string, empty, and whitespace-only values map to false.
- Populated strings map to true.
- Raw projected objects contain no medical string after projection.
- Pagination must complete before applying any flags.
- Incomplete/malformed/error snapshots leave flags and success timestamp unchanged.
- A complete snapshot updates all active linked people, resets missing linked people to false, and clears stale flags on unlinked or inactive records.
- Church isolation and credential-epoch protection are covered by database integration tests.
- Concurrent triggers coalesce and the success TTL avoids redundant provider reads.

### API authorization and privacy

- Test all three minimum-role matrices.
- Test Take Attendance with selected/unselected gatherings, assigned/unassigned people, and allowed/denied gathering access.
- Test People union eligibility across selected gatherings.
- Cross-church individual and gathering IDs never disclose existence or trigger PCO calls.
- Unauthorized and ineligible list DTOs omit the boolean.
- Kiosk, leader check-in, reports, exports, and WebSockets omit all medical fields.
- Live endpoint requests sparse PCO fields and uses centralized token recovery.
- Provider failures return bounded sanitized errors.
- Blank live results self-correct the exact boolean.
- Every response carries strict no-store headers and no ETag.

### Audit

- Success, denial, unavailable, and no-longer-present outcomes receive separate safe events.
- Audit events contain only allowlisted metadata.
- Success-audit insertion completes before the response is sent.
- Success-audit failure prevents medical text disclosure.

### Client

- Indicator visibility on Take Attendance and People follows server DTOs.
- Indicator interaction does not toggle attendance or trigger parent-card behavior.
- Loading, success, no-longer-present, offline, timeout, and retry states render correctly.
- Provider text is rendered as inert plain text.
- Retry clears the old value.
- Close, target change, and unmount abort and clear state.
- Late responses are ignored.
- No API helper, context, module cache, or persistence layer retains the text.

### Sentinel privacy test

Use a unique fixture value, for example `MEDICAL_SENTINEL_DO_NOT_PERSIST_8F3A`, as the provider note in refresh and reveal integration tests. After each flow, assert that the sentinel does not appear in:

- any SQLite table, including `audit_log` and settings;
- captured logger/error-reporter calls;
- sync plan/review/run records;
- local storage, session storage, IndexedDB, or Cache Storage in the browser test;
- serialized client person/attendance state after modal closure.

The live success response and the open modal are the only expected transient appearances.

## Manual Verification

1. Enable the feature for one standard gathering with minimum role Admin.
2. Refresh indicators against a PCO test person with a unique sentinel medical note.
3. Confirm only the boolean exists in SQLite and list responses.
4. Confirm admin success on Take Attendance and People.
5. Confirm coordinator and attendance-taker DTOs omit the field and live calls are denied.
6. Change the threshold and confirm access changes immediately.
7. Remove the person's gathering assignment and confirm both surfaces lose access.
8. Test browser offline mode, slow/throttled networking, request timeout, manual retry, close during request, and rapid switching between people.
9. Inspect local storage, session storage, Cache Storage, service-worker requests, server logs, audit rows, and SQLite for the sentinel.
10. Blank the PCO note, reveal from a stale indicator, and confirm the flag self-corrects to false.
11. Disable the feature and confirm all church flags clear and live access is denied.

## Acceptance Criteria

- The feature is default off and cannot be enabled without an active PCO connection and at least one active standard gathering.
- Admins can choose Admin, Coordinator, or Attendance Taker as the minimum viewer role.
- The same authorization rule governs both indicator existence and live text.
- Every active linked individual receives an accurate boolean after a complete refresh, independent of sync-batch membership.
- Only selected-gathering assignments expose indicators or live actions.
- Take Attendance and People are the only supported surfaces.
- The browser never receives a PCO credential or calls PCO directly.
- Medical text is fetched live through a church-scoped, authorized backend endpoint.
- The live response is strictly non-cacheable and never enters persistent or shared client state.
- No raw medical text or content-derived value is persisted in LMPG-controlled storage or logs.
- Offline and patchy-network failures produce a bounded, retryable unavailable state without stale text fallback.
- Every reveal attempt is content-free audited; a success audit failure prevents disclosure.
- Disabling or disconnecting clears the church's boolean flags.
- Automated and manual sentinel checks find no medical text outside the transient success response and open modal.

## Implementation Boundaries

Likely areas of change include:

- `server/config/schema.js` and `server/config/database.js`;
- a dedicated module under `server/services/planningCenter/` for medical status and live reads;
- the centralized PCO scheduler/orchestrator trigger points;
- Planning Center settings routes and `PlanningCenterIntegrationPanel`;
- `server/routes/individuals.js` and the full attendance response;
- `client/src/services/api.ts`;
- a dedicated medical-note modal/indicator component used by `AttendancePage` and `PeoplePage`;
- co-located unit, database-integration, route, and component tests.

Do not add medical content to the generic people-sync projection, sync plans, existing badge system, family notes, offline attendance hook, or shared smart cache.

## External API Basis

Planning Center's People API documents `medical_notes` as a Person string attribute and supports reading an individual Person at `/people/v2/people/{id}`. Planning Center API requests act on behalf of the connected user and inherit that user's current permissions. These facts justify the backend proxy and LMPG-specific authorization boundary.

- [Planning Center People API: Person](https://api.planningcenteronline.com/docs/apps/people/versions/2025-11-10/vertices/person)
- [Planning Center API authentication](https://api.planningcenteronline.com/docs/overview/authentication)
