# Planning Center Connection Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make revoked Planning Center OAuth credentials recoverable through a non-destructive reconnect flow, while transparently refreshing normal access-token expiry and safely handling unexpected `401` responses.

**Architecture:** Keep the existing church-scoped encrypted credential row and single-flight refresh manager as the only credential owner. Add a bounded, one-time forced-refresh retry wrapper around PCO source reads; surface a structured connection-recovery state through the existing status endpoint and integration panel. Reconnect reuses the normal OAuth callback, so it replaces credentials but does not alter batch, List, link, schedule, or authority data.

**Tech Stack:** Node.js/Express, SQLite connection store, React/TypeScript, Axios, Vitest, Node test runner.

## Global Constraints

- Planning Center List operations remain GET-only; never call a List run, refresh, create, edit, or delete endpoint.
- Credentials stay church-scoped in `integration_connections`; do not revive legacy per-user preference tokens.
- OAuth refresh uses the existing per-church single-flight mechanism and persists PCO's rotated refresh token.
- Retry exactly once after an unexpected PCO `401`; never loop or retry non-auth errors through the OAuth endpoint.
- A failed refresh/retry becomes `SYNC_SOURCE_AUTH`, source health `error`, no missing-source notification, and no roster mutation.
- Reconnect preserves source batches, source drafts, person/family links, authority configuration, and schedules.
- Disconnect remains blocked when Planning Center is the authority provider.
- All source and connection queries remain church-scoped.

---

### Task 1: Add forced credential refresh and one-retry PCO source reads

**Files:**
- Modify: `server/services/peopleSync/pcoCredentialMigration.js`
- Modify: `server/services/peopleSync/pcoCredentialMigration.dbintegration.test.js`
- Modify: `server/services/planningCenterSync.js`
- Modify: `server/services/planningCenterSync.test.js`
- Modify: `server/services/peopleSync/pcoAdapter.js`
- Modify: `server/services/peopleSync/pcoAdapter.test.js`

**Interfaces:**
- Produces `getAccessTokenForChurch(churchId, { forceRefresh?: boolean })`.
- Produces `withPlanningCenterSourceToken(churchId, operation)`, where `operation(accessToken)` may throw `PcoSourceError` with `details.status === 401`.
- `pcoAdapter.listSources` and `pcoAdapter.fetchSourceSnapshot` consume that wrapper instead of retaining a stale token.

- [ ] **Step 1: Write failing credential-refresh tests**

Add tests proving a non-expiring token is returned normally, but `forceRefresh: true` calls the injected refresh function, persists the rotated refresh token, and coalesces concurrent forced refreshes for one church.

```js
const refreshed = await getValidCredentials(churchId, requestRefresh, { forceRefresh: true });
assert.equal(refreshed.accessToken, 'new-access');
assert.equal(refreshCalls, 1);
assert.equal((await connectionStore.getConnection(churchId, 'planning_center')).credentials.refreshToken, 'new-refresh');
```

- [ ] **Step 2: Run the credential test to verify failure**

Run: `cd server && node --test services/peopleSync/pcoCredentialMigration.dbintegration.test.js`

Expected: FAIL because the existing helper has no forced-refresh option.

- [ ] **Step 3: Implement the forced-refresh option**

Extend `ensureFreshCredentials` and `getValidCredentials` with an optional `{ forceRefresh = false }` argument. When true, skip `isExpiringSoon`, retain the existing `refreshInFlight` keying/finally cleanup, and preserve the current failure rule: return usable unexpired credentials only when a refresh fails before true expiry; otherwise return `null`.

- [ ] **Step 4: Write failing source-read retry tests**

In `pcoAdapter.test.js`, inject a `withPlanningCenterSourceToken` dependency. Make the first operation throw `new PcoSourceError('rejected', 'SYNC_SOURCE_AUTH', { status: 401 })`, then assert one forced refresh supplies a new token and the second operation succeeds. Add cases for a failed forced refresh and a second `401`, both returning `SYNC_SOURCE_AUTH` with two total source-read attempts at most.

```js
await assert.rejects(
  () => adapter.fetchSourceSnapshot({ churchId: 'c1', sourceKind: 'planning_center_list', sourceExternalId: 'l1' }),
  (error) => error.code === 'SYNC_SOURCE_AUTH'
);
assert.equal(sourceReadAttempts, 2);
assert.equal(forceRefreshCalls, 1);
```

- [ ] **Step 5: Implement the bounded wrapper and adapt the PCO adapter**

In `planningCenterSync.js`, implement `withPlanningCenterSourceToken(churchId, operation)`:

1. call `getAccessTokenForChurch(churchId)` and fail with `SYNC_SOURCE_AUTH` if unavailable;
2. invoke `operation(accessToken)`;
3. only when its error carries `details.status === 401`, call `getAccessTokenForChurch(churchId, { forceRefresh: true })` once and invoke `operation(refreshedToken)` once;
4. convert a null forced refresh or second 401 to a safe `PcoSourceError` with code `SYNC_SOURCE_AUTH`.

Update `pcoAdapter.js` so both List enumeration and snapshot reads call the wrapper. Do not retry `429`, transport, `5xx`, malformed, missing, or incomplete errors; existing source-health classification handles those separately.

- [ ] **Step 6: Run focused backend tests**

Run: `cd server && node --test services/peopleSync/pcoCredentialMigration.dbintegration.test.js services/peopleSync/pcoAdapter.test.js services/planningCenterSync.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/peopleSync/pcoCredentialMigration.js server/services/peopleSync/pcoCredentialMigration.dbintegration.test.js server/services/planningCenterSync.js server/services/planningCenterSync.test.js server/services/peopleSync/pcoAdapter.js server/services/peopleSync/pcoAdapter.test.js
git commit -m "fix: retry Planning Center source reads after token refresh"
```

### Task 2: Surface reconnect-required status and preserve destructive disconnect guard

**Files:**
- Modify: `server/routes/integrations.js`
- Modify: `server/routes/integrations.pcoSyncBatches.dbintegration.test.js` or create `server/routes/integrations.pcoConnection.test.js`
- Modify: `client/src/components/peopleSync/types.ts`
- Modify: `client/src/services/api.ts`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`

**Interfaces:**
- `GET /integrations/planning-center/status` adds optional `reconnectRequired: boolean` and `connectionErrorCode: 'SYNC_SOURCE_AUTH' | null`.
- `PlanningCenterStatus` exposes the same two fields.
- Existing `authorizePlanningCenter(returnTo?)` starts both initial connect and reconnect; no new credential-writing endpoint is introduced.

- [ ] **Step 1: Write failing status-route tests**

Stub a stored PCO connection whose validation or forced refresh returns `SYNC_SOURCE_AUTH`. Assert the status response returns HTTP 200 with `connected: false`, `reconnectRequired: true`, and `connectionErrorCode: 'SYNC_SOURCE_AUTH'`. Assert a genuinely absent connection returns `connected: false`, `reconnectRequired: false`. Assert disconnect still rejects/guards when authority is Planning Center.

```js
assert.deepEqual(response.body, expect.objectContaining({
  connected: false,
  reconnectRequired: true,
  connectionErrorCode: 'SYNC_SOURCE_AUTH',
}));
```

- [ ] **Step 2: Run the route test to verify failure**

Run: `cd server && node --test routes/integrations.pcoConnection.test.js`

Expected: FAIL because status does not yet return recovery fields.

- [ ] **Step 3: Implement structured status recovery**

Make the status path obtain a fresh church-scoped access token through `pcoSync.getAccessTokenForChurch`; validate it with the existing safe `me` request. On unavailable/failed refresh/401, return the structured reconnect state rather than leaking credential details or returning a server error. Keep `configured` true when encrypted connection data exists. Do not modify source health from the status probe; source reads remain the authoritative health writer.

- [ ] **Step 4: Write failing panel tests**

Add Vitest cases for:

1. `connected: false, reconnectRequired: true` renders **Reconnect Planning Center**, text that credentials will be replaced while Lists, batches, and linked people remain, and calls `authorizePlanningCenter()` when clicked;
2. plain disconnected state still renders **Connect to Planning Center**;
3. PCO authority does not disable Reconnect;
4. a connected authority-provider still shows the existing guarded Disconnect flow.

```tsx
expect(screen.getByRole('button', { name: 'Reconnect Planning Center' })).toBeEnabled();
expect(screen.getByText(/Lists, batches, and linked people/i)).toBeInTheDocument();
```

- [ ] **Step 5: Implement client status and recovery UI**

Extend the TypeScript status DTO and API response typing. In the panel, use `reconnectRequired` to replace the disconnected heading/button/copy with recovery-specific wording. Reuse `handlePlanningCenterConnect`; it must continue to use only the normal authorization endpoint and safe app-relative return target. Keep the existing disconnect modal and authority guard unchanged.

- [ ] **Step 6: Run focused route and UI tests**

Run: `cd server && node --test routes/integrations.pcoConnection.test.js`

Run: `cd client && npm test -- --run src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/routes/integrations.js server/routes/integrations.pcoConnection.test.js client/src/components/peopleSync/types.ts client/src/services/api.ts client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx
git commit -m "feat: add Planning Center reconnect recovery"
```

### Task 3: Verify source-health safety and document operations

**Files:**
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/sourceHealth.dbintegration.test.js`
- Modify: `docs/superpowers/specs/2026-07-30-planning-center-connection-recovery-design.md`
- Modify: `docs/runbooks/provider-owned-sync-source-cutover.md`

**Interfaces:**
- A `SYNC_SOURCE_AUTH` thrown after a forced-refresh retry continues through the existing `sourceHealth.recordSourceError` path.
- A successful future source read clears source error state through the existing `recordSourceAvailable` path.

- [ ] **Step 1: Write failing source-health regressions**

Add an unattended orchestration test where the PCO adapter returns `SYNC_SOURCE_AUTH` after retry exhaustion. Assert no plan/apply mutation occurs, source status becomes `error`, error code is stored, and no admin notification is created. Add a follow-up successful snapshot assertion that source status becomes `available` and error code clears.

```js
assert.equal(updated.sourceStatus, 'error');
assert.equal(updated.sourceStatusErrorCode, 'SYNC_SOURCE_AUTH');
assert.equal(notificationCalls, 0);
assert.equal(applyCalls, 0);
```

- [ ] **Step 2: Run the regression tests to verify failure if needed**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/sourceHealth.dbintegration.test.js`

Expected: PASS after Tasks 1–2; if an assertion exposes a different health path, correct the minimal orchestration error mapping without changing missing-source semantics.

- [ ] **Step 3: Update operational documentation**

Change the design status to **Implemented** only after all verification passes. Add a runbook note: short-lived access tokens auto-refresh; when Reconnect is shown, an active admin completes OAuth, then confirms a successful source read/audit entry before re-enabling or relying on unattended sync. Explicitly state reconnect preserves batch configuration and disconnect remains authority-guarded.

- [ ] **Step 4: Run full verification**

Run: `cd server && node --test --test-concurrency=1`

Run: `cd client && npm test -- --run`

Run: `cd client && npm run build`

Expected: all tests and the production build PASS. Restore generated `client/public/sw.js` if the build changes it.

- [ ] **Step 5: Run security/static checks**

Run:

```bash
rg -n "lists/.*/run|planningcenter.*lists.*run|method:\s*['\"](?:POST|PATCH|DELETE)['\"]" server/services/planningCenter server/services/peopleSync/pcoAdapter.js
rg -n "reconnectRequired|SYNC_SOURCE_AUTH|withPlanningCenterSourceToken" server client/src
git diff --check
```

Expected: no Planning Center List write/run path; recovery references are structured/safe; no whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/orchestrator.test.js server/services/peopleSync/sourceHealth.dbintegration.test.js
git add -f docs/superpowers/specs/2026-07-30-planning-center-connection-recovery-design.md docs/runbooks/provider-owned-sync-source-cutover.md
git commit -m "test: cover Planning Center reconnect safety"
```
