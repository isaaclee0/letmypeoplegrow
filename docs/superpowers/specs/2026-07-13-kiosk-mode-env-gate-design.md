# Kiosk / Self Check-in Mode: Environment-Gate Off

## Problem

Kiosk (self check-in) mode is currently controlled only by a per-gathering DB
flag (`gathering_types.kiosk_enabled`), toggleable by any admin, with no
global gate. Once enabled for a gathering, any logged-in user with access to
that gathering can enter self-checkin, set a PIN, and the client
(`SelfCheckInMode.tsx`) loads the **entire church roster** — full names,
family groupings, family notes, visitor status — into the browser for
client-side search. The PIN only locks the screen overlay; it does not
protect the already-fetched data or the underlying authenticated session.
This is a data-exposure risk on an unattended kiosk device that needs a
redesign. Until that redesign happens, the feature should be off by default.

## Design

### 1. Environment variable

`KIOSK_MODE_ENABLED` in `server/.env` (and documented in
`server/.env.example`). Defaults to disabled when unset. Follows the existing
`PLANNING_CENTER_ENABLED`-style pattern already used in this codebase
(`server/routes/integrations.js`).

### 2. Server-side gate

- `server/routes/kiosk.js`: add a middleware immediately after `verifyToken`
  that checks the env var. If disabled, every route in this file (check-in
  record, history GET x2, history DELETE) responds `403` with
  `{ code: 'KIOSK_DISABLED', message: 'Self check-in is currently disabled' }`.
  This blocks usage regardless of any individual gathering's
  `kiosk_enabled` DB value.
- New `GET /api/kiosk/status` → `{ enabled: boolean }`. Auth-required (the
  file already applies `router.use(verifyToken)`), same shape as the
  existing PCO status endpoint pattern.

### 3. Client-side gate

- Add `kioskAPI.getStatus()` to `client/src/services/api.ts`.
- Fetch it once (small hook or inline in the relevant components) and use it
  to:
  - Hide the "Self Check-in" mode entry point in `CheckInsPage.tsx` entirely
    when disabled.
  - Hide the per-gathering kiosk-settings toggle in the admin gathering
    settings UI when disabled, so admins can't flip the DB flag while the
    feature is globally off. The toggle exists in both the edit and create
    gathering forms in `client/src/pages/ManageGatheringsPage.tsx` (edit
    form ~line 1139, create form ~line 1367); both need the same gate.
- The legacy `/app/kiosk` redirect (`client/src/App.tsx:208`) needs no
  change — it lands on `CheckInsPage`, which will simply not offer the
  self-checkin option.

### 4. Docs

- Add `KIOSK_MODE_ENABLED=false` (commented, matching the `.env.example`
  convention) to `server/.env.example`.
- Add a short note in `CLAUDE.md`'s Attendance System section: self-checkin
  is gated behind `KIOSK_MODE_ENABLED` and currently defaults off pending a
  security redesign of the data exposure described above.

## Out of scope

- No change to `attendance.js`'s full-roster endpoint — it's shared with
  leader check-in mode, and stops being reachable from kiosk context once
  the kiosk UI can't be entered.
- No change to the per-gathering DB flag's existing storage/behavior — it's
  simply superseded by the global gate.
- No new automated test infrastructure. The repo currently has zero kiosk
  tests; if a trivial route-level test fits the existing pattern in
  `server/routes/__tests__` it will be added, but this isn't a blocking
  requirement.
- No redesign of the underlying data-exposure problem itself — that's
  future work once kiosk mode is turned back on.

## Accepted consequences

- Any currently-active kiosk session (PIN-locked, mid-use) will start
  failing check-in/out attempts with a `KIOSK_DISABLED` error after this
  ships, until the page is reloaded. This is intentional — the goal is to
  cut off the exposure immediately.
