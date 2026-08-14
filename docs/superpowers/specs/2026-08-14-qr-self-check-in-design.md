# QR Self-check-in

**Date:** 2026-08-14

**Status:** Approved design

**Scope:** Replace the roster-loading self-service kiosk with a camera-based QR scanner while preserving leader check-in as a separate mode

## Summary

Leader check-in remains an authenticated workflow in which an authorized leader can see and act on the people assigned to a gathering. Self-check-in becomes a separate, restricted camera workflow. An administrator, coordinator, or assigned attendance taker starts a scanner for one gathering and date, locks the app with a PIN, and leaves the device waiting for reusable person QR cards. The scanner receives no roster, search data, family list, or offline allowlist.

Each eligible person has one reusable QR credential for all self-check-in-enabled gatherings to which that person is assigned. The QR contains a random opaque identifier, version metadata, and a server signature. It contains no name, person ID, family ID, church ID, gathering ID, or URL. On each scan, the server resolves the credential within the authenticated scanner's church, rechecks gathering eligibility, records the action, and returns only the person's first name and last initial for a two-second confirmation.

QR credential administration belongs under People because QR codes are durable person data, not live session controls. Admins and coordinators can generate, regenerate, download, and export credentials. Check-ins remains the operational home for starting leader check-in or self-check-in and viewing history.

## Goals

- Prevent self-check-in users and unattended devices from receiving the church roster.
- Support low-friction check-in and checkout with one durable QR card per person.
- Validate every scan against current church, person, gathering, and assignment state.
- Preserve the familiar PIN-locked unattended-device workflow with a server-enforced restriction.
- Keep leader check-in separate and unchanged in purpose.
- Let admins and coordinators bulk-manage QR credentials and produce CSV, PDF, and Word exports.
- Remove the product term `kiosk` from new UI, APIs, code contracts, configuration, and documentation.

## Non-goals

- Phone accounts, family portals, one-time codes, family PINs, or rotating phone QR codes.
- One QR code per person-gathering pair.
- Searching for people, selecting families, adding visitors, or editing person data in self-check-in mode.
- Offline self-check-in or locally cached eligibility data.
- A free-form drag-and-drop document designer.
- Encoding private person or church data in QR payloads.
- Replacing leader check-in or ordinary attendance management.

## Terminology and placement

- **Leader check-in:** an authenticated leader views permitted people and records actions on their behalf.
- **Self-check-in:** an unattended, PIN-locked scanner accepts reusable person QR credentials without loading a roster.
- **QR credential:** the signed opaque value represented by one person's reusable QR code.
- **Scanner session:** the server-enforced restricted app session for one church, gathering, and date.

The primary application menu retains **Check-ins**. Its operational area starts leader or self-check-in sessions and shows check-in history. QR credential management appears under **People → Self-check-in QR codes**. Admins and coordinators see that area; attendance takers do not. Self-check-in setup may contain a shortcut to the People QR area for admins and coordinators.

An individual person's actions include Download QR and Regenerate QR only while that person is eligible. The bulk QR area lists only eligible people.

## Eligibility and authorization

### Person eligibility

A person is eligible to generate, download, regenerate, or use a QR credential when all of the following are true:

- the individual is active and belongs to the authenticated church;
- the individual is assigned through `gathering_lists` to at least one active gathering in that church;
- at least one such gathering uses standard individual attendance and has `self_checkin_enabled = 1`.

Eligibility is recalculated on every management operation and scan. Removing a gathering assignment or disabling self-check-in takes effect immediately. A credential may remain stored while temporarily ineligible so it works again if eligibility returns, but it cannot be generated, downloaded, regenerated, or used during that period.

### Scanner startup

- Admins may start self-check-in for any eligible gathering in their church.
- Coordinators and attendance takers must have a church-scoped `user_gathering_assignments` row for the gathering.
- The gathering must be active, use standard attendance, and have `self_checkin_enabled = 1`.
- The date follows the same gathering-date selection rules as leader check-in.

### QR administration

Only active admins and coordinators may access credential lists, generation, regeneration, downloads, and exports. All queries and mutations include `church_id`. Client-submitted church, role, eligibility, person-name, or gathering-membership claims are ignored.

## QR credential design

### Payload

The encoded value has a versioned format equivalent to:

```text
lmpg-sc1.<key-id>.<credential-id>.<credential-version>.<signature>
```

- `credential-id` is at least 128 random bits encoded with base64url.
- `credential-version` changes when the credential is regenerated.
- `key-id` identifies a verification key without revealing key material.
- `signature` is a base64url HMAC-SHA-256 over the format version, authenticated scanner church ID, credential ID, and credential version.

The server uses a dedicated self-check-in signing-key ring, separate from JWT and other application secrets. One key is active for new exports; retained verification keys keep existing cards usable during planned key rotation. Key removal is an explicit operational revocation and is outside normal credential regeneration.

The database stores the random identifier and version, not the complete signed payload. A database-only disclosure therefore does not supply a usable QR credential without the signing key. The server can reproduce the signed payload for later authorized downloads.

Signature comparison is constant-time. Parsing or validation failure returns the same public response as a revoked, unknown, foreign-church, inactive, or ineligible credential.

### Credential lifecycle

- Generate creates a credential only when none exists and the person is eligible.
- Bulk generation creates missing credentials only. It never rotates existing credentials.
- Download deterministically reproduces the current credential without changing it.
- Regenerate requires an explicit confirmation, replaces the identifier, increments the version, and immediately invalidates every previous printout or screenshot.
- Exports never regenerate credentials implicitly. If selected eligible people lack credentials, the user must explicitly approve generate-missing before export.

Possession of a QR is a bearer authority to check only that individual in or out at an eligible active scanner. A copied card has the same narrow capability. Revocation through regeneration is the remedy for a lost or copied card. No second factor is required.

## Data model

### Gathering setting

Add to `gathering_types`:

```sql
self_checkin_enabled INTEGER NOT NULL DEFAULT 0
```

The new setting defaults off. Do not reuse dormant legacy kiosk columns. The gathering's existing `end_time` supplies the automatic mode-switch boundary.

### Person credentials

Add a church-scoped `self_checkin_credentials` table with:

- `id`
- `church_id`
- `individual_id`
- `credential_id`
- `credential_version`
- `generated_by`
- `regenerated_by`
- `created_at`
- `updated_at`

Enforce one current row per `(church_id, individual_id)` and one credential ID per church. Foreign keys use the repository's existing SQLite conventions. Credential rows may remain after eligibility changes but are deleted with the individual.

### Scanner sessions

Add `self_checkin_sessions` with:

- random session ID;
- `church_id`, `gathering_type_id`, `session_date`, and initiating `user_id`;
- current action mode: `checkin` or `checkout`;
- whether a manual mode override is active;
- an adaptive hash of the session PIN;
- failed-attempt count and temporary lock-until time;
- created, last-used, expiry, unlocked, and ended timestamps.

A scanner session has a maximum lifetime of 12 hours and cannot be moved to another church, gathering, or date. Ending, unlocking, expiry, gathering disablement, assignment loss, or user deactivation closes it for further scans.

### Check-in audit

Retain existing historical data and the legacy internal `kiosk_checkins` table to avoid a destructive migration. Use the neutral shared check-in domain described by the leader-check-in design and persist new self-check-in rows with `checkin_mode = 'self'` and an operation ID. No new public route, event, client symbol, log message, or product copy uses `kiosk`.

## Scanner authentication and PIN lock

Starting self-check-in requires the operator to enter and confirm a 4–6 digit PIN. The server stores only an adaptive password hash. It creates a scanner session and replaces the browser's normal authentication cookie with a restricted, HTTP-only scanner token referencing that session.

The restricted token authorizes only:

- scanner-session status;
- camera scan submission;
- current-mode change;
- PIN unlock; and
- logout.

All normal authenticated APIs reject a scanner token. Direct navigation, a modified client, or handcrafted requests therefore cannot read the roster or other app data.

Refreshing or reopening the installed PWA restores the restricted scanner screen. Entering the correct PIN ends the scanner session, reloads the initiating user from the database, rechecks that the user is active and approved, and issues a normal token using the user's current role and church. Five failed attempts trigger a 30-second delay; repeated groups of failures progressively delay attempts up to 15 minutes. Logout is always available, closes the scanner session, clears authentication, and is the recovery path for a forgotten PIN.

PINs, PIN hashes, and signing material are never logged or returned. QR payloads are returned only by explicitly authorized credential download/export endpoints and are never included in scanner setup, session-status, error, or logging surfaces.

## Scanner experience

### Setup

The operator chooses an eligible gathering and date, reviews the end time used for automatic mode selection, creates the lock PIN, grants camera permission, and starts the scanner. The client requests the front-facing camera with `facingMode: user`; if unavailable, it offers another detected camera.

The scanner is online-only and requires HTTPS camera access. It does not install an offline action queue or eligibility cache. Leader check-in is the fallback when the network or camera is unavailable.

### Active screen

The restricted full-screen view contains only:

- gathering name and date;
- connectivity state;
- a prominent Check in / Check out toggle;
- live camera preview and scan target;
- short instructions; and
- locked exit/logout controls.

It uses the application's existing Tailwind design tokens, controls, dark mode, responsive behavior, and accessibility patterns. It does not introduce a separate visual language.

Camera frames remain in the browser and are never uploaded. QR decoding occurs locally; only the decoded opaque payload and generated operation ID are submitted. Scanning pauses while a result is displayed to prevent frame-by-frame resubmission.

### Mode behavior

At session start, the default is checkout when church-local time is within 15 minutes of the gathering's configured end time; otherwise it is check-in. A session with no valid end time defaults to check-in.

Without a manual override, the active session switches to checkout at that same church-local threshold. Using the visible mode toggle sets a manual override for the remainder of that scanner session, so automation does not unexpectedly undo an operator's selection.

### Results

Successful check-in or checkout replaces the camera with a large confirmation for two seconds. It shows the action plus first name and last initial, for example `Checked in — Alex T.` It then clears all identity details and resumes scanning.

An already-current state returns `Already checked in` or `Already checked out` with the same minimal identity confirmation and creates no duplicate audit row.

Every invalid, malformed, revoked, foreign-church, inactive, or ineligible code shows the same message without a name: `Couldn't use this code. Please ask a check-in leader for help.` Connection, session-expiry, and camera-permission failures use distinct operational messages because they reveal no person information.

## Scan transaction and real-time behavior

The scan request includes the opaque QR payload and a client-generated UUID operation ID. The server:

1. authenticates and loads the scanner session;
2. verifies session lifetime, initiating user, gathering, assignment, and self-check-in configuration;
3. parses and verifies the QR signature using the scanner's trusted church ID;
4. resolves the active credential and individual within that church;
5. rechecks current person and gathering-list eligibility;
6. determines whether the requested action is already the person's latest check-in action for that gathering/date;
7. records the audit action and attendance mutation in one church-scoped transaction; and
8. broadcasts only after commit.

Check-in marks attendance present, snapshots `people_type_at_time` where supported, and updates `last_attendance_date`. Checkout adds a departure audit action but does not mark the person absent or erase attendance.

The operation ID is idempotent across retries. Reusing it with different canonical input is rejected. A partial unique index and SQLite transaction serialization prevent concurrent scanners from committing the same operation twice. A separate same-state check prevents a fresh operation ID caused by repeated camera detection from adding another identical action. A valid later transition such as check-in → checkout → check-in remains allowed.

Successful commits use the existing church-scoped attendance broadcast so leader and attendance views refresh. Scanner sessions do not subscribe to or receive roster-shaped WebSocket data.

## API boundaries

### Admin/coordinator credential API

- `GET /api/self-checkin/credentials` lists eligible people and current credential status, with search, pagination, and gathering filter;
- `POST /api/self-checkin/credentials/generate` generates missing credentials for an explicit individual set;
- `POST /api/self-checkin/credentials/:individualId/regenerate` explicitly regenerates one credential;
- `GET /api/self-checkin/credentials/:individualId/download?format=svg|png|pdf` reproduces one credential for download; and
- `POST /api/self-checkin/credentials/exports` creates a CSV, PDF, or Word export for an explicit selected/filter scope.

Every requested person ID is validated before mutation. A bulk request fails atomically if its explicit selection contains an invalid, foreign, or ineligible person; it does not silently process a subset.

### Scanner-session API

- `POST /api/self-checkin/sessions` starts a restricted scanner session and replaces normal authentication;
- `GET /api/self-checkin/session` reads status for the scanner session identified by the restricted cookie;
- `PATCH /api/self-checkin/session/mode` sets check-in or checkout mode and the manual override;
- `POST /api/self-checkin/session/scan` submits an opaque QR payload and operation ID;
- `POST /api/self-checkin/session/unlock` verifies the PIN and restores normal authentication; and
- `DELETE /api/self-checkin/session` ends the session and logs out when the PIN is unavailable.

Scanner responses never contain family IDs, full last names, attendance lists, medical indicators, notes, contact details, badges, people types, or eligibility explanations.

## QR administration experience

People → Self-check-in QR codes provides:

- search across eligible people;
- filtering by self-check-in-enabled gathering;
- person, family, eligible-gathering, and credential-status columns;
- row selection and select-all within an explicit filter scope;
- Generate for a missing individual credential;
- Generate selected for missing credentials only;
- Download for a current credential;
- Regenerate with revocation warning and confirmation; and
- export for selected people, the filtered gathering, or all eligible people.

Existing credentials show Active. Missing credentials show Not created. Existing credentials are never silently regenerated by bulk actions or exports.

## Export design

### CSV

CSV is mail-merge data, not an image format. Each row contains:

- full person name;
- family name when present;
- church name;
- exact QR payload;
- credential version; and
- generated date.

The export dialog explains that external mail-merge or label software must convert the payload field into a QR symbol. Because the payload is a working bearer credential, the dialog warns admins to handle the file like printed QR cards. Export creation is audited, and generated server files are not retained after delivery.

### Individual files

An individual credential can be downloaded as SVG or PNG and as a one-card PDF. Downloading reproduces the current credential and does not rotate it.

### PDF and Word

Rendered cards contain a QR symbol, full person name, and church name. Gathering names are omitted because one card works across all eligible gatherings.

Presets include:

- A4 card grid;
- US Letter card grid;
- common label/card grids; and
- one card per page.

Advanced controls include:

- portrait or landscape orientation;
- custom page width and height;
- card width and height;
- top, right, bottom, and left page margins;
- row and column gaps; and
- millimetres or inches.

One shared layout model drives the live preview, PDF geometry, and Word table/grid. The preview displays page breaks and card count. Invalid or impossible geometry blocks export with a specific explanation; it never silently clips or rescales. Word embeds QR images in a fixed table/grid. PDF uses the same computed dimensions for exact placement.

## Error handling and privacy

- Camera permission denial explains how to retry or use leader check-in.
- Unsupported cameras offer available-camera selection or leader fallback.
- Connectivity loss immediately pauses decoding and scan submission and shows Connection required.
- Expired or invalid scanner sessions stop scanning and offer logout.
- A committed scan remains successful if a later broadcast fails; the failure is logged without undoing attendance.
- All authorization and eligibility failures fail closed.
- Public scan errors do not distinguish unknown, revoked, foreign, inactive, or ineligible people.
- Rate limits apply to PIN attempts, invalid QR submissions, session creation, generation, regeneration, and exports.
- Logs may include church, user, session, gathering, individual, action, operation, and safe result codes. They exclude names, family names, PINs, hashes, QR payloads, signing keys, camera data, contact data, and medical information.

## Migration and retirement

Schema changes follow the repository's additive SQLite migration conventions for new and existing church databases.

The redesigned feature removes:

- the legacy full-roster `SelfCheckInMode` implementation;
- self-service search and family selection;
- roster and family caches;
- offline self-check-in queues;
- legacy kiosk REST writes and WebSocket mutations;
- kiosk PIN state that protects only client navigation;
- kiosk welcome-message and end-time configuration;
- `KIOSK_MODE_ENABLED` runtime gating; and
- user-facing, API, event, client-symbol, configuration, and documentation uses of `kiosk` for a live feature.

Obsolete local-storage keys are deleted without replay. Existing audit rows and dormant legacy columns remain unless a separately approved destructive migration removes them. Stale legacy clients receive a non-mutating retirement response during the compatibility window defined by the leader-check-in separation design.

Self-check-in is controlled solely by the new per-gathering setting and defaults off. Deployment must regenerate the service worker and ship client and server together.

## Testing strategy

### Credential and cryptography tests

- payload generation and repeat reproduction;
- signature verification and constant-time comparison path;
- malformed, forged, wrong-key, wrong-church, old-version, and regenerated credentials;
- key-ring verification and active-key export;
- database disclosure does not provide a complete working payload.

### Authorization and isolation tests

- admin, assigned coordinator, and assigned attendance-taker scanner startup;
- unassigned and unsupported-role denial;
- admin/coordinator QR administration and attendance-taker denial;
- inactive, headcount, disabled, missing, and foreign-church gatherings;
- foreign-church and ineligible individuals at every management and scan endpoint;
- scanner token denial on all normal roster and app APIs.

### Session and PIN tests

- normal token replacement with restricted scanner token;
- refresh restores the scanner route;
- allowed restricted endpoints and denial elsewhere;
- correct PIN restores a freshly validated normal user token;
- failed-attempt delays, expiry, logout, deactivation, assignment loss, and gathering disablement;
- PIN and payload values never appear in logs or responses.

### Attendance integration tests

- check-in audit and attendance writes commit together;
- checkout records departure without marking absent;
- people-type snapshot and last-attendance update;
- repeated frame and repeated operation idempotency;
- mismatched operation-ID reuse rejection;
- valid check-in → checkout → check-in transitions;
- concurrent scanners commit one canonical action;
- broadcasts occur after commit and stay church-scoped.

### Client tests

- no roster, family, search, visitor, medical, or offline-cache request in self-check-in mode;
- front-camera request and alternate-camera fallback;
- connectivity and permission error states;
- church-time automatic transition and session-long manual override;
- two-second first-name/last-initial confirmation and identity clearing;
- generic invalid-code response;
- scanner lock restoration, PIN unlock, and logout;
- role-based People QR area and individual actions;
- old kiosk local-storage deletion without replay.

### Export tests

- CSV escaping and exact payload reproduction;
- SVG/PNG QR readability;
- PDF and Word card content;
- A4, Letter, one-card, portrait, landscape, millimetre, inch, and custom geometry;
- invalid geometry rejection;
- multi-page counts, margins, gaps, and page breaks;
- exported QR codes scan successfully after document rendering;
- regeneration invalidates QR codes from earlier exports.

### Migration tests

- new church databases contain the new setting and tables;
- existing church databases migrate idempotently;
- self-check-in defaults off;
- legacy attendance and audit history remain unchanged;
- re-running schema initialization does not rotate or rewrite credentials.

## Rollout

1. Add additive schema and credential-signing configuration.
2. Add credential, eligibility, scanner-session, PIN, and scan-domain services with isolation tests.
3. Add admin/coordinator QR APIs and document exports.
4. Add People QR administration and person actions.
5. Add the restricted scanner setup and camera UI.
6. Integrate attendance transactions and church-scoped broadcasts.
7. Remove the roster-based self-check-in implementation, caches, queue, and legacy live contracts.
8. Remove live `kiosk` product/configuration terminology and the global environment gate.
9. Regenerate the PWA service worker and deploy client and server together.
10. Enable self-check-in on a test gathering, generate test cards, and verify concurrent check-in and checkout using representative devices.
11. Monitor safe result codes, scanner failures, retirement responses, and export errors without logging private payloads.

## Acceptance criteria

- No self-check-in client request or stored browser value contains a roster or eligibility allowlist.
- One reusable QR per eligible person works across all currently assigned self-check-in gatherings in the same church.
- The QR contains no personal or church data and cannot be forged from database values alone.
- Regeneration immediately invalidates old copies; authorized users can re-download an unchanged current credential.
- Every scan rechecks church, person, gathering, assignment, and active state on the server.
- The unattended device is constrained by a server-enforced restricted token, not only client navigation.
- PIN unlock restores normal access; forgotten-PIN logout is always available.
- Successful confirmation shows only first name and last initial for two seconds.
- Invalid-person responses disclose no identity or eligibility detail.
- Check-in is idempotent, checkout preserves attendance, and valid later transitions work.
- Admins and coordinators can generate, regenerate, download, and export from People; attendance takers cannot administer QR credentials.
- PDF and Word support presets and validated custom page/card geometry; CSV supplies mail-merge payloads.
- Self-check-in is online-only and fails safely when camera, HTTPS, connectivity, or session requirements are unavailable.
- The legacy full-roster self-check-in UI, roster cache, offline queue, and live kiosk contracts are absent.
- Leader check-in remains separately authorized and operational.
