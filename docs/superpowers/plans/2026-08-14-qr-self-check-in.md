# QR Self-check-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace roster-loading self-check-in with a PIN-locked, online QR scanner while preserving separately authorized leader check-in and adding reusable QR administration under People.

**Architecture:** First separate leader check-in into a shared church-scoped action service and dedicated transport contracts. Then add signed per-person credentials, restricted scanner JWT sessions, REST-only camera scans, and document exports. The scanner never receives a roster or offline eligibility data; every scan revalidates its church, gathering, person, and assignment on the server.

**Tech Stack:** Node.js, Express 5, better-sqlite3, bcryptjs, jsonwebtoken, Node test runner, React 19, TypeScript 6, Vite/Vitest, Tailwind CSS, `@zxing/browser`, `qrcode`, `pdf-lib`, `docx`, `pngjs`, and `jsqr`.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-14-qr-self-check-in-design.md` and `docs/superpowers/specs/2026-08-06-leader-checkin-separation-and-kiosk-retirement-design.md`.
- Every database lookup and mutation includes trusted `church_id`.
- Self-check-in is online-only: no roster endpoint, offline allowlist, roster cache, search, visitor creation, or offline queue.
- One credential works for one person across every currently eligible self-check-in gathering in the same church.
- QR format is `lmpg-sc1.<key-id>.<credential-id>.<credential-version>.<signature>` and contains no private or routing data.
- QR signing uses a dedicated HMAC-SHA-256 key ring, never `JWT_SECRET`, and comparisons are constant-time.
- Scanner authentication is restricted to status, mode, scan, unlock, and logout for one church/gathering/date and expires within 12 hours.
- Scanner success exposes only action, first name, last initial, timestamp, and already-current state; all person-validation failures are generic.
- Camera frames remain in the browser; only the decoded opaque payload and operation UUID cross the network.
- Logs and audit metadata exclude QR payloads, PINs/hashes, signing keys, names, contacts, camera data, and medical data.
- Check-in marks present; checkout records departure and never marks absent.
- Automatic checkout begins 15 minutes before church-local end time; manual mode overrides automation for the session.
- Use existing Tailwind tokens, dark mode, controls, accessibility, and responsive patterns.
- New product/API/client/config vocabulary uses `self-checkin`, never `kiosk`; legacy table/history remain.
- New gathering settings default off. Existing audit data and dormant legacy columns are preserved.
- Rebuild affected development containers after adding dependencies.

## File Structure

- `server/services/checkins/{accessPolicy,actionService}.js` — shared leader/self authorization and attendance transactions.
- `server/services/selfCheckIn/{signingKeys,credentialCodec,eligibility,credentialRepository}.js` — credential domain.
- `server/services/selfCheckIn/{sessionService,mode,scanService}.js` — restricted scanner domain.
- `server/services/selfCheckIn/{layout,qrImages,exports}.js` — common export model and renderers.
- `server/services/authTokens.js` and `server/middleware/selfCheckInAuth.js` — user/scanner token separation.
- `server/routes/leader-checkins.js` and `server/routes/self-checkin.js` — separate transport boundaries.
- `client/src/components/selfCheckIn/*` — setup, camera lifecycle, scanner, and pure mode helpers.
- `client/src/components/people/SelfCheckInQrAdmin.tsx` and `SelfCheckInExportDialog.tsx` — People-owned administration.
- `client/src/pages/SelfCheckInPage.tsx` — restricted route outside normal `Layout`.

---

### Task 1: Dependencies, schema, migration, and signing configuration

**Files:**
- Modify: `server/package.json`, `server/package-lock.json`, `client/package.json`, `client/package-lock.json`
- Modify: `server/config/schema.js`, `server/config/database.js`, `server/startup.js`
- Modify: `server/.env.example`, `docker-compose.yml`, `docker-compose.dev.yml`
- Create: `server/config/selfCheckInSchema.dbintegration.test.js`

**Interfaces:**
- Produces `self_checkin_enabled`, `self_checkin_credentials`, `self_checkin_sessions`, `checkin_mode`, `operation_id`, and the partial operation index.
- Produces `SELF_CHECKIN_QR_SIGNING_KEYS='{"v1":"<base64-32-bytes>"}'` and `SELF_CHECKIN_QR_ACTIVE_KEY_ID=v1`.

- [ ] **Step 1: Write failing fresh-schema and legacy-migration tests**

```js
test('self-check-in schema is additive and defaults disabled', async () => {
  await withTestChurchDb(async () => {
    const cols = await Database.query('PRAGMA table_info(gathering_types)');
    assert.equal(cols.find(c => c.name === 'self_checkin_enabled').dflt_value, '0');
    const tables = await Database.query("SELECT name FROM sqlite_master WHERE type='table'");
    assert(tables.some(r => r.name === 'self_checkin_credentials'));
    assert(tables.some(r => r.name === 'self_checkin_sessions'));
  });
});
```

Also create a legacy SQLite church, seed one audit row, reopen it through `Database.getChurchDb`, run initialization twice, and assert the row is unchanged and new structures exist once.

- [ ] **Step 2: Run the test and verify failure**

Run: `cd server && node --test config/selfCheckInSchema.dbintegration.test.js`

Expected: FAIL because the column/tables are absent.

- [ ] **Step 3: Install production dependencies**

```bash
cd server && npm install qrcode pdf-lib docx pngjs jsqr
cd ../client && npm install @zxing/browser
```

- [ ] **Step 4: Add canonical schema and idempotent migration**

```sql
CREATE TABLE IF NOT EXISTS self_checkin_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  individual_id INTEGER NOT NULL,
  credential_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  generated_by INTEGER NOT NULL,
  regenerated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(church_id, individual_id),
  UNIQUE(church_id, credential_id),
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE
);
```

Add the scanner-session table exactly as follows. Also add `checkin_mode TEXT NOT NULL DEFAULT 'legacy'`, `operation_id TEXT`, and unique `(church_id, operation_id, individual_id) WHERE operation_id IS NOT NULL`. Never reclassify legacy rows.

```sql
CREATE TABLE IF NOT EXISTS self_checkin_sessions (
  id TEXT PRIMARY KEY,
  church_id TEXT NOT NULL,
  gathering_type_id INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  action_mode TEXT NOT NULL CHECK(action_mode IN ('checkin','checkout')),
  manual_override INTEGER NOT NULL DEFAULT 0,
  pin_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  lock_until TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  unlocked_at TEXT,
  ended_at TEXT,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

- [ ] **Step 5: Document/pass through the signing key ring and remove `KIOSK_MODE_ENABLED`**

Require a stable JSON key ring and active key ID on all replicas. Missing/invalid configuration disables enablement and credential operations without taking down ordinary attendance.

- [ ] **Step 6: Run schema/database tests**

Run: `cd server && node --test config/selfCheckInSchema.dbintegration.test.js config/database.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json client/package.json client/package-lock.json server/config/schema.js server/config/database.js server/startup.js server/.env.example docker-compose.yml docker-compose.dev.yml server/config/selfCheckInSchema.dbintegration.test.js
git commit -m "feat(self-checkin): add schema and dependencies"
```

### Task 2: Neutral action service and dedicated leader contracts

**Files:**
- Create: `server/services/checkins/accessPolicy.js`, `accessPolicy.dbintegration.test.js`
- Create: `server/services/checkins/actionService.js`, `actionService.dbintegration.test.js`
- Create: `server/routes/leader-checkins.js`, `leader-checkins.dbintegration.test.js`
- Modify: `server/services/websocket.js`, `server/index.js`
- Replace: `server/services/websocket.kiosk.dbintegration.test.js` with `websocket.leaderCheckin.dbintegration.test.js`

**Interfaces:**
- `authorizeLeaderOperation({ churchId, userId, userRole, gatheringTypeId, operation })`, operation `write | history | delete`.
- `recordCheckInAction({ churchId, userId, gatheringTypeId, sessionDate, individualIds, action, signerName, checkinMode, operationId }) -> { duplicate, records }`.
- `listCheckInHistory({ churchId, gatheringTypeId, limit })`, `getCheckInHistoryForDate({ churchId, gatheringTypeId, sessionDate })`, and `deleteCheckInHistoryForDate({ churchId, gatheringTypeId, sessionDate })`.
- Dedicated `/api/leader-checkins` routes and `record_leader_checkin_action` socket event.

- [ ] **Step 1: Write failing policy and atomic-transaction tests**

Cover admin, assigned coordinator/taker, unassigned denial, inactive/headcount/disabled gathering, invalid/foreign individual atomic rollback, check-in attendance state, checkout non-absence, retry idempotency, and mismatched operation reuse.

```js
await assert.rejects(
  () => recordCheckInAction({ ...input, individualIds: [validId, foreignId] }),
  error => error.code === 'INDIVIDUAL_NOT_FOUND'
);
assert.deepEqual(await Database.query('SELECT * FROM kiosk_checkins'), []);
```

- [ ] **Step 2: Run and verify failures**

Run: `cd server && node --test services/checkins/accessPolicy.dbintegration.test.js services/checkins/actionService.dbintegration.test.js`

- [ ] **Step 3: Implement typed access errors and the neutral transaction**

Canonicalize unique sorted IDs and signer text before comparing operation reuse. Keep audit/attendance/people-type/last-attendance writes in one church transaction. Export history/delete functions from the same service; adapters broadcast only after commit.

- [ ] **Step 4: Write and implement leader REST/WebSocket contract tests**

Test POST action, both history GETs, admin DELETE, sender-only success/error, identical REST/socket policy, church-scoped broadcasts, and one concurrent commit. Mount `leader-checkins` in `index.js`; replace kiosk selection/checkout public events with leader names.

- [ ] **Step 5: Run focused tests**

Run: `cd server && node --test services/checkins/*.test.js routes/leader-checkins.dbintegration.test.js services/websocket.leaderCheckin.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/checkins server/routes/leader-checkins.js server/routes/leader-checkins.dbintegration.test.js server/services/websocket.js server/services/websocket.leaderCheckin.dbintegration.test.js server/services/websocket.kiosk.dbintegration.test.js server/index.js
git commit -m "feat(checkins): separate leader check-in domain"
```

### Task 3: Migrate leader client and retire roster self-check-in

**Files:**
- Modify: `client/src/services/api.ts`, `client/src/contexts/WebSocketContext.tsx`, `client/src/contexts/CheckInsContext.tsx`
- Modify: `client/src/components/checkins/LeaderCheckInMode.tsx`, `CheckInHistory.tsx`, `client/src/pages/CheckInsPage.tsx`
- Create: `client/src/components/checkins/LeaderCheckInMode.test.tsx`, `client/src/pages/CheckInsPage.test.tsx`
- Delete: `client/src/components/checkins/SelfCheckInMode.tsx`, `SelfCheckInMode.test.ts`
- Replace: `server/routes/kiosk.js`; create `server/routes/kiosk.retirement.dbintegration.test.js`

**Interfaces:**
- Produces `leaderCheckInsAPI`, `sendLeaderCheckInAction`, `onLeaderCheckout`, and neutral leader-selection functions.

- [ ] **Step 1: Write failing client/retirement tests**

Assert leader calls use `/leader-checkins`, one UUID survives socket-to-REST fallback, history uses the leader API, old self mode is absent, and every `/api/kiosk` path returns `410 KIOSK_RETIRED` without mutation.

- [ ] **Step 2: Run and verify failures**

```bash
cd client && npm test -- src/components/checkins/LeaderCheckInMode.test.tsx src/pages/CheckInsPage.test.tsx
cd ../server && node --test routes/kiosk.retirement.dbintegration.test.js
```

- [ ] **Step 3: Rename contracts and delete the old roster UI/state/cache/queue**

Remove plaintext PIN state, `kiosk_attendance_cache`, `kiosk_offline_queue`, welcome message, old self mode, and kiosk socket symbols. Preserve leader behavior through the new names.

- [ ] **Step 4: Add one-release non-mutating compatibility surfaces**

Return `{"code":"KIOSK_RETIRED","error":"This self check-in experience has been retired. Refresh the app to use the redesigned check-ins experience."}` and make old socket writes error without mutation.

- [ ] **Step 5: Run tests and commit**

```bash
cd client && npm test -- src/components/checkins src/pages/CheckInsPage.test.tsx
cd ../server && node --test routes/kiosk.retirement.dbintegration.test.js
git add client/src/services/api.ts client/src/contexts client/src/components/checkins client/src/pages/CheckInsPage.tsx client/src/pages/CheckInsPage.test.tsx server/routes/kiosk.js server/routes/kiosk.retirement.dbintegration.test.js
git commit -m "refactor(checkins): retire roster self-check-in"
```

### Task 4: Credential signing, eligibility, and lifecycle

**Files:**
- Create: `server/services/selfCheckIn/signingKeys.js`, `signingKeys.test.js`
- Create: `server/services/selfCheckIn/credentialCodec.js`, `credentialCodec.test.js`
- Create: `server/services/selfCheckIn/eligibility.js`, `eligibility.dbintegration.test.js`
- Create: `server/services/selfCheckIn/credentialRepository.js`, `credentialRepository.dbintegration.test.js`

**Interfaces:**
- `loadSigningKeyRing(env) -> { activeKeyId, keys: Map<string, Buffer> }`.
- `createCredentialId()`, `encodeCredential(input,keyRing)`, `verifyCredential(payload,churchId,keyRing)`.
- `isIndividualEligible({ churchId, individualId, gatheringTypeId? })`.
- Repository `listEligible`, `generateMissing`, `regenerate`, `getCurrent`.

- [ ] **Step 1: Write failing codec/eligibility/repository tests**

Use fixed 32-byte test keys. Assert repeat encoding, random IDs, wrong church/signature/key/version rejection, one generic error, active standard assignment eligibility, immediate disablement, atomic bulk generation, repeat download, and regeneration invalidation.

- [ ] **Step 2: Run and verify failures**

Run: `cd server && node --test services/selfCheckIn/signingKeys.test.js services/selfCheckIn/credentialCodec.test.js services/selfCheckIn/eligibility.dbintegration.test.js services/selfCheckIn/credentialRepository.dbintegration.test.js`

- [ ] **Step 3: Implement the exact signed format**

Sign `lmpg-sc1|${churchId}|${credentialId}|${credentialVersion}`. Use `crypto.randomBytes(16).toString('base64url')`; validate decoded signature lengths before `crypto.timingSafeEqual`; map all public verification failures to `INVALID_SELF_CHECKIN_CODE`.

```js
const message = `lmpg-sc1|${churchId}|${credentialId}|${credentialVersion}`;
const signature = crypto.createHmac('sha256', key).update(message).digest('base64url');
return `lmpg-sc1.${keyId}.${credentialId}.${credentialVersion}.${signature}`;
```

- [ ] **Step 4: Implement current eligibility and atomic lifecycle**

Eligibility joins active `individuals`, `gathering_lists`, and active standard `gathering_types.self_checkin_enabled = 1`. Generate missing only, recheck all explicit IDs before a transaction, increment version on regeneration, and retain credentials through temporary ineligibility.

- [ ] **Step 5: Run tests and commit**

```bash
cd server && node --test services/selfCheckIn/signingKeys.test.js services/selfCheckIn/credentialCodec.test.js services/selfCheckIn/eligibility.dbintegration.test.js services/selfCheckIn/credentialRepository.dbintegration.test.js
git add server/services/selfCheckIn
git commit -m "feat(self-checkin): add signed person credentials"
```

### Task 5: Credential administration API and QR image downloads

**Files:**
- Create: `server/routes/self-checkin.js`, `self-checkin.credentials.dbintegration.test.js`
- Create: `server/services/selfCheckIn/qrImages.js`, `qrImages.test.js`
- Modify: `server/index.js`

**Interfaces:**
- `GET /api/self-checkin/credentials` lists eligible people and status.
- `POST /api/self-checkin/credentials/generate` generates missing explicit IDs.
- `POST /api/self-checkin/credentials/:individualId/regenerate` rotates one code.
- `GET /api/self-checkin/credentials/:individualId/download?format=svg|png` reproduces one code; Task 6 extends it with one-card PDF.
- `POST /api/self-checkin/credentials/exports` produces CSV/PDF/DOCX for an explicit scope.
- `renderQrSvg(payload) -> Promise<string>` and `renderQrPng(payload,width=512) -> Promise<Buffer>` with error correction M and margin 4.

- [ ] **Step 1: Write failing authorization/lifecycle route tests**

Assert admin/coordinator success, attendance-taker denial, search/pagination/gathering filters, atomic invalid selection, repeat payload stability, regeneration changes, old payload invalidation, and omission of medical/contact fields.

- [ ] **Step 2: Write a failing PNG round-trip test**

Generate PNG, parse with `PNG.sync.read`, decode pixels with `jsQR`, and assert decoded text equals the signed payload.

- [ ] **Step 3: Run and verify failures**

Run: `cd server && node --test routes/self-checkin.credentials.dbintegration.test.js services/selfCheckIn/qrImages.test.js`

- [ ] **Step 4: Implement routes, scoped rate limits, safe audit, and images**

Use `verifyToken`, isolation, `requireRole(['admin','coordinator'])`, explicit validators, attachment headers, and safe audit fields. Never pass QR payloads to generic request-body auditing.

```js
router.use(verifyToken, ensureChurchIsolation, requireRole(['admin', 'coordinator']));
router.post('/credentials/generate', credentialAdminLimiter, validateIndividualIds, generateMissingHandler);
router.post('/credentials/:individualId/regenerate', credentialAdminLimiter, regenerateHandler);
```

- [ ] **Step 5: Run tests and commit**

```bash
cd server && node --test routes/self-checkin.credentials.dbintegration.test.js services/selfCheckIn/qrImages.test.js
git add server/routes/self-checkin.js server/routes/self-checkin.credentials.dbintegration.test.js server/services/selfCheckIn/qrImages.js server/services/selfCheckIn/qrImages.test.js server/index.js
git commit -m "feat(self-checkin): add QR credential API"
```

### Task 6: Shared layout model and CSV/PDF/DOCX exports

**Files:**
- Create: `server/services/selfCheckIn/layout.js`, `layout.test.js`
- Create: `server/services/selfCheckIn/exports.js`, `exports.test.js`
- Modify: `server/routes/self-checkin.js`, `self-checkin.credentials.dbintegration.test.js`

**Interfaces:**
- `normalizeLayout(input)` returns points; `computeGrid(layout,itemCount)` returns columns, rows, pages, placements.
- `renderCredentialExport({ format, people, churchName, layout }) -> { mimeType, fileName, bytes }`.

- [ ] **Step 1: Write failing geometry tests**

Cover A4, Letter, portrait, landscape, mm, inches, one-card pages, multi-page placement, asymmetric margins, gaps, and failure when no card fits.

- [ ] **Step 2: Write failing export tests**

Assert RFC-4180 CSV columns `fullName,familyName,churchName,qrPayload,credentialVersion,generatedDate` and escaping; PDF page sizes/counts via `PDFDocument.load`; DOCX ZIP media/table counts; and embedded PNG bytes matching the scannable image test.

- [ ] **Step 3: Run and verify failures**

Run: `cd server && node --test services/selfCheckIn/layout.test.js services/selfCheckIn/exports.test.js`

- [ ] **Step 4: Implement presets and one placement model**

Define `a4-cards`, `letter-cards`, `a4-labels`, `letter-labels`, `one-per-page`. Convert mm with `value * 72 / 25.4` and inches with `value * 72`. Use identical placements for pdf-lib and fixed DOCX table cells. Cards contain QR, full name, and church name only.

```js
const toPoints = (value, unit) => unit === 'mm' ? value * 72 / 25.4 : value * 72;
const columns = Math.floor((usableWidth + columnGap) / (cardWidth + columnGap));
if (columns < 1 || rowsPerPage < 1) throw layoutError('CARD_DOES_NOT_FIT');
```

- [ ] **Step 5: Wire ephemeral export response**

Accept `scope: selected | filtered | allEligible`, validate before rendering, require explicit `generateMissing: true`, audit without payloads, and stream bytes without writing files. Extend the individual download route with `format=pdf` by calling the same renderer with the `one-per-page` preset and exactly one person.

- [ ] **Step 6: Run tests and commit**

```bash
cd server && node --test services/selfCheckIn/layout.test.js services/selfCheckIn/exports.test.js routes/self-checkin.credentials.dbintegration.test.js
git add server/services/selfCheckIn/layout.js server/services/selfCheckIn/layout.test.js server/services/selfCheckIn/exports.js server/services/selfCheckIn/exports.test.js server/routes/self-checkin.js server/routes/self-checkin.credentials.dbintegration.test.js
git commit -m "feat(self-checkin): export QR cards"
```

### Task 7: Restricted scanner authentication and PIN sessions

**Files:**
- Create: `server/services/authTokens.js`, `authTokens.test.js`
- Modify: `server/routes/auth.js`, `server/middleware/auth.js`
- Create: `server/middleware/selfCheckInAuth.js`
- Create: `server/services/selfCheckIn/mode.js`, `mode.test.js`
- Create: `server/services/selfCheckIn/sessionService.js`, `sessionService.dbintegration.test.js`
- Modify: `server/routes/self-checkin.js`; create `self-checkin.sessions.dbintegration.test.js`
- Modify: `server/services/websocket.js`; create `server/services/websocket.scannerAuth.test.js`

**Interfaces:**
- `signUserToken`, `signScannerToken`, `setAuthCookie`, `clearAuthCookie`.
- Scanner claims `{ tokenType:'self_checkin', sessionId, userId, churchId }`.
- Session service `startSession`, `getActiveSession`, `setMode`, `unlockSession`, `endSession`.
- `effectiveMode(session,gathering,timeZone,now)`.
- Exact routes are `POST /api/self-checkin/sessions`, `GET /api/self-checkin/session`, `PATCH /api/self-checkin/session/mode`, `POST /api/self-checkin/session/scan`, `POST /api/self-checkin/session/unlock`, and `DELETE /api/self-checkin/session`.

- [ ] **Step 1: Write failing token/mode tests**

Assert normal middleware returns `403 SCANNER_SESSION_ONLY` for scanner JWT, scanner middleware rejects user JWT, WebSocket authentication rejects scanner JWT before joining a church room, church-time 15-minute boundary, missing end time, and session-long manual override.

- [ ] **Step 2: Write failing session tests**

Cover role/assignment/start checks, 4–6 digit PIN confirmation, bcrypt-only storage, normal-cookie replacement, refresh status, five-failure delay, progressive delay cap, 12-hour expiry, unlock reloading current user, deactivation, and PIN-less logout.

- [ ] **Step 3: Run and verify failures**

Run: `cd server && node --test services/authTokens.test.js services/websocket.scannerAuth.test.js services/selfCheckIn/mode.test.js services/selfCheckIn/sessionService.dbintegration.test.js routes/self-checkin.sessions.dbintegration.test.js`

- [ ] **Step 4: Centralize token/cookie issuance**

Refactor login, church switch, refresh, logout, scanner start/unlock/end through `authTokens.js` without changing existing secure/domain options. Reject scanner tokens before ordinary user lookup.

```js
if (decoded.tokenType === 'self_checkin') {
  return res.status(403).json({ code: 'SCANNER_SESSION_ONLY', error: 'Scanner session active.' });
}
```

- [ ] **Step 5: Implement sessions/routes**

Use bcrypt cost 12, UUID IDs, UTC timestamps, current assignment checks, and safe logging. Status returns gathering name/date/end, effective mode, override, `autoSwitchAt`, expiry, and no roster fields.

- [ ] **Step 6: Run tests and commit**

```bash
cd server && node --test services/authTokens.test.js services/websocket.scannerAuth.test.js services/selfCheckIn/mode.test.js services/selfCheckIn/sessionService.dbintegration.test.js routes/self-checkin.sessions.dbintegration.test.js routes/auth.timezone.dbintegration.test.js
git add server/services/authTokens.js server/services/authTokens.test.js server/routes/auth.js server/middleware/auth.js server/middleware/selfCheckInAuth.js server/services/websocket.js server/services/websocket.scannerAuth.test.js server/services/selfCheckIn/mode.js server/services/selfCheckIn/mode.test.js server/services/selfCheckIn/sessionService.js server/services/selfCheckIn/sessionService.dbintegration.test.js server/routes/self-checkin.js server/routes/self-checkin.sessions.dbintegration.test.js
git commit -m "feat(self-checkin): lock scanner sessions with PIN"
```

### Task 8: Privacy-safe scan transaction

**Files:**
- Create: `server/services/selfCheckIn/scanService.js`, `scanService.dbintegration.test.js`
- Modify: `server/routes/self-checkin.js`; create `server/routes/self-checkin.scan.dbintegration.test.js`

**Interfaces:**
- `scanCredential({ sessionId, payload, operationId, now? }) -> { action, firstName, lastInitial, occurredAt, alreadyCurrent, broadcast }`.

- [ ] **Step 1: Write failing service tests**

Cover valid check-in, checkout non-absence, forged/revoked/wrong-church/inactive/unassigned generic error, immediate eligibility loss, repeated/mismatched operation IDs, repeated same state, check-in→checkout→check-in, concurrent scanners, and expired session.

- [ ] **Step 2: Write failing route privacy tests**

Assert restricted JWT only, input limits, invalid-attempt rate limit, identical person-failure body/status, minimal success fields, and broadcast only after commit.

- [ ] **Step 3: Run and verify failures**

Run: `cd server && node --test services/selfCheckIn/scanService.dbintegration.test.js routes/self-checkin.scan.dbintegration.test.js`

- [ ] **Step 4: Implement authoritative scan flow**

Resolve mode at scan time, verify credential in session church, recheck current eligibility, call `recordCheckInAction` for one person with `checkinMode:'self'`, derive last initial server-side, and suppress write/broadcast for already-current state.

```js
return {
  action,
  firstName: individual.first_name,
  lastInitial: individual.last_name ? `${individual.last_name[0]}.` : '',
  occurredAt,
  alreadyCurrent,
};
```

- [ ] **Step 5: Run tests and commit**

```bash
cd server && node --test services/selfCheckIn/scanService.dbintegration.test.js routes/self-checkin.scan.dbintegration.test.js
git add server/services/selfCheckIn/scanService.js server/services/selfCheckIn/scanService.dbintegration.test.js server/routes/self-checkin.js server/routes/self-checkin.scan.dbintegration.test.js
git commit -m "feat(self-checkin): record privacy-safe QR scans"
```

### Task 9: Replace gathering kiosk settings with self-check-in

**Files:**
- Modify: `server/routes/gatherings.js`, `server/routes/gatherings.dbintegration.test.js`
- Modify: `client/src/services/api.ts`, `client/src/pages/ManageGatheringsPage.tsx`, `client/src/screens/SetupScreens.test.tsx`, `client/src/components/Layout.tsx`

**Interfaces:**
- Gathering DTO adds `selfCheckInEnabled`; removes live `kioskEnabled`, `kioskMessage`, and kiosk-settings API.

- [ ] **Step 1: Write failing setting tests**

Assert create/update/read, headcount forced false, default false, church scope, no kiosk fields in responses, and Check-ins navigation from either leader/self setting.

- [ ] **Step 2: Run and verify failures**

```bash
cd server && node --test routes/gatherings.dbintegration.test.js
cd ../client && npm test -- src/screens/SetupScreens.test.tsx
```

- [ ] **Step 3: Implement server DTO/writes and remove `/:id/kiosk-settings`**

Select/write `self_checkin_enabled`; preserve dormant schema columns only. Reject enablement when the signing key ring is invalid so operators cannot configure a broken scanner.

```js
const selfCheckInValue = attendanceType === 'standard' && selfCheckInEnabled ? 1 : 0;
updates.push('self_checkin_enabled = ?');
values.push(selfCheckInValue);
```

- [ ] **Step 4: Implement gathering UI and navigation copy**

Show “Enable self-check-in” only for standard gatherings, explain reusable QR cards/no roster, and invalidate `gatherings_cached_data` and `checkins_available` after changes.

- [ ] **Step 5: Run tests and commit**

```bash
git add server/routes/gatherings.js server/routes/gatherings.dbintegration.test.js client/src/services/api.ts client/src/pages/ManageGatheringsPage.tsx client/src/screens/SetupScreens.test.tsx client/src/components/Layout.tsx
git commit -m "feat(self-checkin): configure gatherings"
```

### Task 10: Client scanner auth bootstrap and API contracts

**Files:**
- Modify: `client/src/services/api.ts`, `client/src/contexts/authContextValue.ts`, `client/src/contexts/AuthContext.tsx`, `client/src/contexts/WebSocketContext.tsx`, `client/src/App.tsx`
- Create: `client/src/contexts/AuthContext.scanner.test.tsx`
- Create: `client/src/pages/SelfCheckInPage.tsx`, `SelfCheckInPage.test.tsx`
- Create: `client/src/utils/selfCheckInStorage.ts`, `selfCheckInStorage.test.ts`

**Interfaces:**
- Auth state `sessionMode: 'user' | 'scanner' | 'anonymous'`, `scannerSession`, and begin/refresh/unlock/logout scanner methods.
- `selfCheckInAPI` exposes credentials, exports, session start/status/mode/scan/unlock/end.

- [ ] **Step 1: Write failing auth/bootstrap tests**

Assert `SCANNER_SESSION_ONLY` triggers scanner status, clears cached user, renders `/self-checkin` outside Layout, blocks wrong token types, prevents WebSocket connection while `sessionMode === 'scanner'`, restores user on unlock, and returns to Check-ins.

- [ ] **Step 2: Write failing sensitive-storage cleanup tests**

Delete `kiosk_attendance_cache`, `kiosk_offline_queue`, `kiosk_state`, old self state, `attendance_cached_data`, and `attendance_offline_changes` without replay; retain theme/preferences.

- [ ] **Step 3: Run and verify failures**

Run: `cd client && npm test -- src/contexts/AuthContext.scanner.test.tsx src/pages/SelfCheckInPage.test.tsx src/utils/selfCheckInStorage.test.ts`

- [ ] **Step 4: Implement typed API/auth state machine**

Skip refresh for `SCANNER_SESSION_ONLY`. Do not store scanner session in localStorage; restore from server. Clear user/sensitive caches before hard navigation after session start.

```ts
export type SessionMode = 'user' | 'scanner' | 'anonymous';
if (error.response?.data?.code === 'SCANNER_SESSION_ONLY') {
  const { data } = await selfCheckInAPI.getSession();
  setScannerSession(data.session);
  setSessionMode('scanner');
}
```

- [ ] **Step 5: Add restricted route shell**

Handle loading, expiry, connection required, unlock, and logout without mounting `Layout` or roster-shaped WebSocket subscriptions.

- [ ] **Step 6: Run tests and commit**

```bash
cd client && npm test -- src/contexts/AuthContext.scanner.test.tsx src/pages/SelfCheckInPage.test.tsx src/utils/selfCheckInStorage.test.ts
git add client/src/services/api.ts client/src/contexts/authContextValue.ts client/src/contexts/AuthContext.tsx client/src/contexts/AuthContext.scanner.test.tsx client/src/contexts/WebSocketContext.tsx client/src/App.tsx client/src/pages/SelfCheckInPage.tsx client/src/pages/SelfCheckInPage.test.tsx client/src/utils/selfCheckInStorage.ts client/src/utils/selfCheckInStorage.test.ts
git commit -m "feat(self-checkin): bootstrap restricted scanner client"
```

### Task 11: Camera scanner and setup UI

**Files:**
- Create: `client/src/components/selfCheckIn/useQrScanner.ts`, `useQrScanner.test.ts`
- Create: `client/src/components/selfCheckIn/scannerMode.ts`, `scannerMode.test.ts`
- Create: `client/src/components/selfCheckIn/ScannerSetup.tsx`, `ScannerSetup.test.tsx`
- Create: `client/src/components/selfCheckIn/SelfCheckInScanner.tsx`, `SelfCheckInScanner.test.tsx`
- Modify: `client/src/pages/CheckInsPage.tsx`, `client/src/pages/SelfCheckInPage.tsx`

**Interfaces:**
- `useQrScanner({ videoRef, enabled, onDecode }) -> { state, devices, selectDevice, retry, stop }`.
- State `requesting | active | paused | permission-denied | unsupported | error`.

- [ ] **Step 1: Write failing camera lifecycle tests**

Mock `BrowserQRCodeReader.decodeFromConstraints`, `decodeFromVideoDevice`, returned `stop`, device listing, and media devices. Assert front constraint, alternate camera, unmount cleanup, decode pause, and permission/unsupported errors.

- [ ] **Step 2: Write failing scanner/setup UI tests**

Assert no roster request; eligible gathering/date/PIN setup; action toggle; automatic/manual mode; UUID per accepted scan; two-second `Alex T.` confirmation; generic invalid response; offline pause; unlock/logout.

- [ ] **Step 3: Run and verify failures**

Run: `cd client && npm test -- src/components/selfCheckIn`

- [ ] **Step 4: Implement camera lifecycle using official ZXing controls**

Use `decodeFromConstraints({ video:{ facingMode:'user' }, audio:false }, video, callback)` and `decodeFromVideoDevice` after explicit selection. Always stop returned controls. Pause submissions during result display and until retry after operational errors.

```ts
controlsRef.current = await reader.decodeFromConstraints(
  { video: { facingMode: 'user' }, audio: false },
  videoRef.current!,
  result => { if (result && !pausedRef.current) onDecode(result.getText()); },
);
```

- [ ] **Step 5: Integrate Check-ins mode selection**

Show leader/self independently from their settings. Setup runs under normal auth; only active scanning runs at `/self-checkin`.

- [ ] **Step 6: Run tests and commit**

```bash
cd client && npm test -- src/components/selfCheckIn src/pages/CheckInsPage.test.tsx src/pages/SelfCheckInPage.test.tsx
git add client/src/components/selfCheckIn client/src/pages/CheckInsPage.tsx client/src/pages/SelfCheckInPage.tsx
git commit -m "feat(self-checkin): scan QR cards with camera"
```

### Task 12: People QR administration and export preview

**Files:**
- Create: `client/src/components/people/SelfCheckInQrAdmin.tsx`, `SelfCheckInQrAdmin.test.tsx`
- Create: `client/src/components/people/SelfCheckInExportDialog.tsx`, `SelfCheckInExportDialog.test.tsx`
- Create: `client/src/components/people/selfCheckInLayout.ts`, `selfCheckInLayout.test.ts`
- Modify: `client/src/pages/PeoplePage.tsx`, `client/src/pages/PeoplePage.authority.test.ts`

**Interfaces:**
- People view `/app/people?view=self-checkin-qr`, admin/coordinator only.
- Preview request matches server layout fields and uses the same point conversions.

- [ ] **Step 1: Write failing role/placement/table tests**

Assert People placement, role visibility, eligible API data only, search/filter/pagination, selection, generate missing, repeat download, regeneration warning, and updated status.

- [ ] **Step 2: Write failing export-dialog tests**

Cover selected/filtered/all scopes; CSV mail-merge/bearer warning; PDF/DOCX presets; orientation, units, custom geometry; live page/card count; invalid geometry; explicit generate-missing; Blob filenames.

- [ ] **Step 3: Run and verify failures**

Run: `cd client && npm test -- src/components/people/SelfCheckInQrAdmin.test.tsx src/components/people/SelfCheckInExportDialog.test.tsx src/components/people/selfCheckInLayout.test.ts src/pages/PeoplePage.authority.test.ts`

- [ ] **Step 4: Implement focused components outside the large PeoplePage**

When `view=self-checkin-qr`, render the focused component before loading normal People datasets. Reuse app table/card/modal/dark-mode patterns and provide Return to People.

```tsx
if (searchParams.get('view') === 'self-checkin-qr' && ['admin', 'coordinator'].includes(user?.role || '')) {
  return <SelfCheckInQrAdmin onBack={() => navigate('/app/people')} />;
}
```

- [ ] **Step 5: Add person-row actions without inferring policy client-side**

Show Download/Regenerate only from server eligibility status and refresh after assignment changes; never infer from cached gathering names.

- [ ] **Step 6: Run tests and commit**

```bash
cd client && npm test -- src/components/people/SelfCheckInQrAdmin.test.tsx src/components/people/SelfCheckInExportDialog.test.tsx src/components/people/selfCheckInLayout.test.ts src/pages/PeoplePage.authority.test.ts
git add client/src/components/people/SelfCheckInQrAdmin.tsx client/src/components/people/SelfCheckInQrAdmin.test.tsx client/src/components/people/SelfCheckInExportDialog.tsx client/src/components/people/SelfCheckInExportDialog.test.tsx client/src/components/people/selfCheckInLayout.ts client/src/components/people/selfCheckInLayout.test.ts client/src/pages/PeoplePage.tsx client/src/pages/PeoplePage.authority.test.ts
git commit -m "feat(self-checkin): manage QR cards from People"
```

### Task 13: Cleanup, documentation, release, and end-to-end verification

**Files:**
- Modify: `AGENTS.md`, `README.md`, `docs/SECURITY_MODEL.md`, `docs/WEBSOCKET_IMPLEMENTATION.md`
- Modify: `VERSION`, both package manifests/locks, `client/src/utils/version.test.ts`
- Search/remove: live kiosk symbols outside historical specs/migrations/audit table

**Interfaces:**
- Produces release version `2.3.0` and regenerated service worker assets.

- [ ] **Step 1: Add version and stale-contract assertions**

Assert `VERSION`, both packages, and displayed version equal `2.3.0`; production client sources contain none of `kioskAPI`, `sendKioskAction`, `record_kiosk_action`, `kiosk_attendance_cache`, or `kiosk_offline_queue`.

- [ ] **Step 2: Verify failure before cleanup/bump**

Run: `cd client && npm test -- src/utils/version.test.ts src/pages/CheckInsPage.test.tsx`

- [ ] **Step 3: Remove remaining live terminology and document operations**

Document bearer risk, key backup/rotation, restricted token/PIN recovery, online/HTTPS requirement, per-gathering enablement, People administration, leader fallback, and compatibility retirement. Preserve historical specs and legacy table name.

- [ ] **Step 4: Set version 2.3.0 and regenerate service worker through normal build**

Run: `cd client && npm run build` after synchronizing `VERSION` and both package files; never invoke Vite directly.

- [ ] **Step 5: Run focused server verification**

```bash
cd server
node --test config/selfCheckInSchema.dbintegration.test.js services/checkins/*.test.js services/selfCheckIn/*.test.js routes/leader-checkins.dbintegration.test.js routes/kiosk.retirement.dbintegration.test.js routes/self-checkin.*.test.js routes/gatherings.dbintegration.test.js routes/auth.timezone.dbintegration.test.js services/websocket.leaderCheckin.dbintegration.test.js
```

- [ ] **Step 6: Run focused client verification and build**

```bash
cd client
npm test -- src/contexts/AuthContext.scanner.test.tsx src/components/checkins src/components/selfCheckIn src/components/people/SelfCheckInQrAdmin.test.tsx src/components/people/SelfCheckInExportDialog.test.tsx src/components/people/selfCheckInLayout.test.ts src/pages/CheckInsPage.test.tsx src/pages/PeoplePage.authority.test.ts src/pages/SelfCheckInPage.test.tsx src/utils/selfCheckInStorage.test.ts src/utils/version.test.ts
npm run build
```

- [ ] **Step 7: Rebuild dependency-changed development containers**

```bash
docker-compose -f docker-compose.dev.yml build server client
docker-compose -f docker-compose.dev.yml up -d server client
docker-compose -f docker-compose.dev.yml ps
```

- [ ] **Step 8: Perform HTTPS representative-device smoke tests**

Verify front/alternate camera, admin/coordinator/taker start policy, PIN refresh/unlock/logout, concurrent scanners, old regenerated card failure, check-in/checkout transitions, network pause, printed PDF/DOCX scans, and leader fallback. Confirm Network/Application panels contain no scanner roster response or roster storage key.

- [ ] **Step 9: Commit**

```bash
git add AGENTS.md README.md docs/SECURITY_MODEL.md docs/WEBSOCKET_IMPLEMENTATION.md VERSION client/package.json client/package-lock.json server/package.json server/package-lock.json client/src/utils/version.test.ts client/public
git commit -m "chore: release QR self-check-in 2.3.0"
```

## Official Library References

- ZXing camera lifecycle/stop controls: https://github.com/zxing-js/browser
- QR SVG/PNG rendering: https://github.com/soldair/node-qrcode/blob/master/README.md
- PDF PNG embedding: https://pdf-lib.js.org/docs/api/classes/pdfdocument
- DOCX documents/tables/images: https://docx.js.org/
