# Provider-Neutral People Sync and Elvanto Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build reviewed Elvanto onboarding/import and strict Elvanto source-of-truth sync on a provider-neutral people-sync core that preserves current PCO behaviour.

**Architecture:** Add provider-neutral connection, link, batch, authority, matching, plan/apply, audit, and scheduling services around the existing per-church SQLite model. Wrap PCO behind compatibility adapters before adding an Elvanto adapter, then replace the monolithic Elvanto UI with shared batch/review components and an onboarding path. Migrate additively: legacy PCO columns/tables remain readable and dual-written until the new path is proven.

**Tech Stack:** Node.js 20+, Express 5, CommonJS, `node:test`, `better-sqlite3`, native Node `crypto`, React 19, TypeScript 6, Axios, Tailwind CSS, Vitest, Testing Library.

## Global Constraints

- Both PCO and Elvanto may be connected, but `authority_provider` is exactly one of `none`, `planning_center`, or `elvanto`.
- Only the current authority locks linked records and performs unattended lifecycle reconciliation.
- Preserve church isolation in every table, query, unique index, background job, review token, and route.
- All user-triggered imports use matching and review; no import path blindly creates selected people.
- Elvanto authentication is API-key only; OAuth and bidirectional writes are out of scope.
- Elvanto Contacts default to included as `local_visitor`; people-type alignment defaults on and is church-level.
- Email/mobile matching is out of scope because LMPG individuals do not store those fields.
- Elvanto attendance/check-in import and a general contact-information model are out of scope.
- Integration secrets are encrypted with AES-256-GCM, are write-only after submission, and never appear in logs, exports, admin output, review payloads, or audit rows.
- Production refuses to store a credential unless `INTEGRATION_CREDENTIALS_KEY` is a valid base64-encoded 32-byte key; there is no plaintext fallback.
- Missing Elvanto people are archived only after two consecutive successful full reconciliations confirm absence.
- A sync batch may remove only gathering-roster rows carrying that batch's own provenance.
- Legacy PCO schema remains in place during this project; no destructive schema migrations.
- Existing PCO plan/apply, scheduling, check-in, background-check, and lock tests must remain green after every PCO compatibility task.
- Use test-first development and make the exact commit at the end of every task; do not combine task commits.

## Deployment Layers

1. **Foundation:** Tasks 1-7 add inert provider-neutral schema/services and generic authority locks while PCO remains behaviourally unchanged.
2. **PCO compatibility:** Tasks 8-10 move PCO links, batches, credentials, plan/apply, and scheduler behind the generic contracts with dual-write compatibility.
3. **Elvanto backend:** Tasks 11-16 add the Elvanto API adapter, metadata/filters, plan/apply, routes, audit, and scheduling.
4. **Frontend/onboarding:** Tasks 17-21 add shared types, Elvanto batch/review UI, authority controls, onboarding, and retire unsafe legacy entry points.
5. **Release verification:** Task 22 runs the full regression/security/build matrix and updates operator documentation.

## File Structure

### New backend files

- `server/services/peopleSync/credentialCipher.js` — AES-256-GCM JSON encryption/decryption.
- `server/services/peopleSync/connectionStore.js` — church-level provider credential persistence and status.
- `server/services/peopleSync/linkRepository.js` — provider-neutral person/family links and missing counters.
- `server/services/peopleSync/batchRepository.js` — provider-neutral batch CRUD and row mapping.
- `server/services/peopleSync/runRepository.js` — sanitized sync-run audit rows and watermarks.
- `server/services/peopleSync/authority.js` — authority state machine, lock lookup, and provider-aware errors.
- `server/services/peopleSync/providerRegistry.js` — adapter registration/lookup contract.
- `server/services/peopleSync/matcher.js` — provider-neutral name/child/family matcher.
- `server/services/peopleSync/plan.js` — pure combined-batch plan generation.
- `server/services/peopleSync/planDigest.js` — deterministic plan digest and expiring review token.
- `server/services/peopleSync/apply.js` — transactional provider-neutral apply and roster provenance.
- `server/services/peopleSync/orchestrator.js` — fetch/filter/match/plan/apply coordination.
- `server/services/peopleSync/scheduler.js` — provider-neutral batch and full-reconciliation schedules.
- `server/services/peopleSync/reviewNotification.js` — de-duplicated provider-aware admin review notices.
- `server/services/peopleSync/pcoAdapter.js` — PCO compatibility adapter over existing services.
- `server/services/elvanto/httpClient.js` — authenticated Elvanto requests and pagination.
- `server/services/elvanto/normalizer.js` — raw Elvanto response projection.
- `server/services/elvanto/metadata.js` — account metadata discovery/cache projection.
- `server/services/elvanto/filter.js` — versioned Elvanto filter validation/evaluation.
- `server/services/elvanto/adapter.js` — provider adapter implementation.
- `server/routes/integrations/peopleSync.js` — generic connection/authority/run routes.
- `server/routes/integrations/elvanto.js` — Elvanto connection, metadata, batch, plan, and apply routes.

Each backend file receives a co-located `.test.js`; stateful repositories/apply/authority also receive `.dbintegration.test.js` suites using `withTestChurchDb`.

### New frontend files

- `client/src/components/peopleSync/types.ts` — shared provider, batch, plan, and selection types.
- `client/src/components/peopleSync/syncSelections.ts` — provider-neutral review selection serializer.
- `client/src/components/peopleSync/PeopleSourceControl.tsx` — authority selection/reconciliation UI.
- `client/src/components/peopleSync/SyncReview.tsx` — provider-neutral review buckets and apply controls.
- `client/src/components/elvanto/ElvantoBatchEditor.tsx` — Elvanto filters, schedule, and gathering target.
- `client/src/components/elvanto/ElvantoFilterEditor.tsx` — metadata-driven filter controls.
- `client/src/components/elvanto/ElvantoOnboarding.tsx` — connect/configure/review onboarding flow.
- `client/src/utils/authorityLock.ts` — provider-neutral client lock decisions and labels.

### Existing files modified

- `server/config/schema.js`, `server/config/database.js`, `server/config/database.test.js`
- `server/services/planningCenterSync.js`, `server/services/planningCenter/*.js`
- `server/routes/integrations.js`, `server/routes/settings.js`, `server/routes/individuals.js`, `server/routes/families.js`
- `server/routes/takeout.js`, `server/admin/index.js`, `server/index.js`
- `client/src/services/api.ts`
- `client/src/components/integrations/{types,IntegrationsTab,ElvantoIntegrationPanel,PlanningCenterIntegrationPanel}.tsx`
- `client/src/components/planningCenter/{PlanningCenterBatchEditor,PlanningCenterSyncReview}.tsx`
- `client/src/pages/{PeoplePage,OnboardingPage}.tsx`
- `client/src/utils/pcoLock.ts` (compatibility re-export, then deletion in the cleanup task)

---

### Task 1: Add Provider-Neutral Schema and Idempotent Backfill

**Files:**
- Modify: `server/config/schema.js`
- Modify: `server/config/database.js`
- Modify: `server/config/database.test.js`
- Test: `server/config/peopleSyncSchema.dbintegration.test.js`

**Interfaces:**
- Produces tables `integration_connections`, `external_person_links`, `external_family_links`, `people_sync_settings`, `people_sync_batches`, and `people_sync_runs`.
- Produces `gathering_lists.added_by_sync_batch_id` and `backfillProviderNeutralSync(db, churchId)` for Tasks 3, 4, 8, and 10.

- [ ] **Step 1: Write failing new-database schema tests**

Create `server/config/peopleSyncSchema.dbintegration.test.js` with assertions for every table, unique index, default, and foreign key:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('./database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

test('new church contains provider-neutral people-sync schema', async () => {
  await withTestChurchDb(async (churchId) => {
    const tables = await Database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%sync%' OR name LIKE 'external_%' OR name = 'integration_connections')"
    );
    const names = new Set(tables.map((row) => row.name));
    for (const name of ['integration_connections', 'external_person_links', 'external_family_links', 'people_sync_settings', 'people_sync_batches', 'people_sync_runs']) {
      assert.ok(names.has(name), `missing ${name}`);
    }
    const settings = await Database.query('SELECT * FROM people_sync_settings WHERE church_id = ?', [churchId]);
    assert.equal(settings[0].authority_provider, 'none');
    assert.equal(settings[0].elvanto_include_contacts, 1);
    assert.equal(settings[0].elvanto_align_people_type, 1);
    const gl = await Database.query('PRAGMA table_info(gathering_lists)');
    assert.ok(gl.some((column) => column.name === 'added_by_sync_batch_id'));
  });
});
```

- [ ] **Step 2: Run the schema test and verify failure**

Run: `cd server && node --test config/peopleSyncSchema.dbintegration.test.js`

Expected: FAIL because the tables and generic gathering provenance do not exist.

- [ ] **Step 3: Add exact schema definitions**

Add the tables to `CHURCH_SCHEMA` in `server/config/schema.js`. Use this shape, including church-scoped uniqueness and provider checks:

```sql
CREATE TABLE IF NOT EXISTS integration_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('planning_center', 'elvanto')),
  auth_type TEXT NOT NULL CHECK(auth_type IN ('oauth', 'api_key')),
  credential_ciphertext TEXT NOT NULL,
  credential_nonce TEXT NOT NULL,
  credential_auth_tag TEXT NOT NULL,
  credential_key_version INTEGER NOT NULL DEFAULT 1,
  connection_status TEXT NOT NULL DEFAULT 'connected'
    CHECK(connection_status IN ('connected', 'invalid', 'validation_unavailable')),
  connected_by INTEGER,
  connected_at TEXT DEFAULT (datetime('now')),
  last_validated_at TEXT,
  last_error_code TEXT,
  metadata TEXT,
  metadata_cached_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, provider),
  FOREIGN KEY (connected_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS external_person_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('planning_center', 'elvanto')),
  external_person_id TEXT NOT NULL,
  individual_id INTEGER NOT NULL,
  link_source TEXT NOT NULL CHECK(link_source IN ('matched', 'created', 'manual', 'legacy_backfill')),
  linked_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  missing_full_sync_count INTEGER NOT NULL DEFAULT 0,
  review_declined INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, provider, external_person_id),
  UNIQUE(church_id, provider, individual_id),
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_family_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('planning_center', 'elvanto')),
  external_family_id TEXT NOT NULL,
  family_id INTEGER NOT NULL,
  link_source TEXT NOT NULL CHECK(link_source IN ('matched', 'created', 'manual', 'legacy_backfill')),
  linked_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, provider, external_family_id),
  UNIQUE(church_id, provider, family_id),
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS people_sync_settings (
  church_id TEXT PRIMARY KEY,
  authority_provider TEXT NOT NULL DEFAULT 'none'
    CHECK(authority_provider IN ('none', 'planning_center', 'elvanto')),
  pending_authority_provider TEXT
    CHECK(pending_authority_provider IS NULL OR pending_authority_provider IN ('planning_center', 'elvanto')),
  elvanto_include_contacts INTEGER NOT NULL DEFAULT 1,
  elvanto_align_people_type INTEGER NOT NULL DEFAULT 1,
  full_reconciliation_frequency TEXT NOT NULL DEFAULT 'weekly',
  full_reconciliation_day INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS ensure_people_sync_settings
AFTER INSERT ON church_settings
BEGIN
  INSERT OR IGNORE INTO people_sync_settings (church_id, authority_provider)
  VALUES (
    NEW.church_id,
    CASE WHEN NEW.planning_center_sync_indicator = 1 THEN 'planning_center' ELSE 'none' END
  );
END;

CREATE TABLE IF NOT EXISTS people_sync_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('planning_center', 'elvanto')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  filter_schema_version INTEGER NOT NULL DEFAULT 1,
  filter_config TEXT NOT NULL DEFAULT '{}',
  default_people_type TEXT NOT NULL DEFAULT 'regular'
    CHECK(default_people_type IN ('regular', 'local_visitor', 'traveller_visitor')),
  gathering_type_id INTEGER,
  gathering_auto_remove_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_frequency TEXT NOT NULL DEFAULT 'weekly',
  schedule_day INTEGER NOT NULL DEFAULT 1,
  legacy_provider_batch_id INTEGER,
  last_external_watermark TEXT,
  last_sync_at TEXT,
  last_sync_result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, provider, legacy_provider_batch_id),
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS people_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('planning_center', 'elvanto')),
  batch_id INTEGER,
  trigger TEXT NOT NULL CHECK(trigger IN ('onboarding', 'manual', 'run_now', 'scheduled', 'authority_switch', 'full_reconciliation')),
  fetch_mode TEXT NOT NULL CHECK(fetch_mode IN ('full', 'incremental')),
  status TEXT NOT NULL CHECK(status IN ('running', 'review_required', 'applied', 'failed', 'cancelled')),
  counts TEXT NOT NULL DEFAULT '{}',
  review_notification_fingerprint TEXT,
  error_code TEXT,
  error_message TEXT,
  external_watermark TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES people_sync_batches(id) ON DELETE SET NULL
);
```

Add indexes for every `church_id`, link lookup, run lookup, and batch provider lookup. Add `added_by_sync_batch_id INTEGER REFERENCES people_sync_batches(id) ON DELETE SET NULL` to `gathering_lists`.

- [ ] **Step 4: Add existing-database migration and backfill**

In `server/config/database.js`, create and export an idempotent helper:

```js
function backfillProviderNeutralSync(db, churchId) {
  db.prepare(`INSERT OR IGNORE INTO people_sync_settings
    (church_id, authority_provider)
    SELECT church_id,
      CASE WHEN planning_center_sync_indicator = 1 THEN 'planning_center' ELSE 'none' END
    FROM church_settings WHERE church_id = ?`).run(churchId);

  db.prepare(`INSERT OR IGNORE INTO external_person_links
    (church_id, provider, external_person_id, individual_id, link_source, last_seen_at)
    SELECT church_id, 'planning_center', planning_center_id, id, 'legacy_backfill', datetime('now')
    FROM individuals
    WHERE church_id = ? AND planning_center_id IS NOT NULL AND planning_center_id <> ''`).run(churchId);

  db.prepare(`INSERT OR IGNORE INTO external_family_links
    (church_id, provider, external_family_id, family_id, link_source, last_seen_at)
    SELECT church_id, 'planning_center', planning_center_id, id, 'legacy_backfill', datetime('now')
    FROM families
    WHERE church_id = ? AND planning_center_id IS NOT NULL AND planning_center_id <> ''`).run(churchId);
}
```

Create missing tables/columns/indexes before calling the helper. Backfill each `planning_center_sync_batches` row into `people_sync_batches` with `legacy_provider_batch_id`, converting the old membership/field columns into filter JSON:

```js
{
  membershipFilterEnabled: !!row.membership_filter_enabled,
  membershipAllowlist: JSON.parse(row.membership_allowlist || '[]'),
  fieldFilterEnabled: !!row.field_filter_enabled,
  fieldFilters: JSON.parse(row.field_filters || '[]'),
}
```

Backfill `gathering_lists.added_by_sync_batch_id` from the existing `added_by_pco_batch_id` column by joining it to `people_sync_batches.legacy_provider_batch_id`.

- [ ] **Step 5: Add migration idempotency and uniqueness tests**

Seed legacy PCO IDs/batches/provenance, call `backfillProviderNeutralSync` twice, and assert one link/batch per source. Also assert a PCO and Elvanto link may point to the same `individual_id`, while two Elvanto IDs for the same individual fail the provider-scoped unique constraint.

- [ ] **Step 6: Run schema tests**

Run: `cd server && node --test config/peopleSyncSchema.dbintegration.test.js config/database.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/config/schema.js server/config/database.js server/config/database.test.js server/config/peopleSyncSchema.dbintegration.test.js
git commit -m "feat(sync): add provider-neutral sync schema"
```

### Task 2: Encrypt and Store Church-Level Integration Credentials

**Files:**
- Create: `server/services/peopleSync/credentialCipher.js`
- Create: `server/services/peopleSync/credentialCipher.test.js`
- Create: `server/services/peopleSync/connectionStore.js`
- Create: `server/services/peopleSync/connectionStore.dbintegration.test.js`
- Modify: `server/routes/takeout.js`
- Modify: `server/admin/index.js`
- Modify: `README.md`

**Interfaces:**
- Produces `encryptCredential(value)`, `decryptCredential(row)`, `upsertConnection(input)`, `getConnection(churchId, provider)`, `getCredentials(churchId, provider)`, `markValidated(...)`, `updateMetadataCache(...)`, and `disconnectConnection(...)`.
- Consumed by PCO compatibility in Task 10 and Elvanto routes in Task 16.

- [ ] **Step 1: Write failing AES-GCM tests**

```js
test('credential cipher round-trips JSON without exposing plaintext', () => {
  process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  const encrypted = encryptCredential({ apiKey: 'secret-value' });
  assert.equal(encrypted.credential_ciphertext.includes('secret-value'), false);
  assert.deepEqual(decryptCredential(encrypted), { apiKey: 'secret-value' });
});

test('credential cipher rejects an invalid key', () => {
  process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(16).toString('base64');
  assert.throws(() => encryptCredential({ apiKey: 'x' }), /32-byte/);
});

test('credential cipher rejects tampered ciphertext', () => {
  const encrypted = encryptCredential({ apiKey: 'x' });
  encrypted.credential_ciphertext = `${encrypted.credential_ciphertext.slice(0, -2)}AA`;
  assert.throws(() => decryptCredential(encrypted));
});
```

- [ ] **Step 2: Run cipher tests and verify failure**

Run: `cd server && node --test services/peopleSync/credentialCipher.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the cipher**

Use native `crypto` only:

```js
const crypto = require('node:crypto');

function keyBuffer() {
  const key = Buffer.from(process.env.INTEGRATION_CREDENTIALS_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('INTEGRATION_CREDENTIALS_KEY must be a base64-encoded 32-byte key');
  return key;
}

function encryptCredential(value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    credential_ciphertext: ciphertext.toString('base64'),
    credential_nonce: nonce.toString('base64'),
    credential_auth_tag: cipher.getAuthTag().toString('base64'),
    credential_key_version: 1,
  };
}

function decryptCredential(row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(), Buffer.from(row.credential_nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(row.credential_auth_tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.credential_ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

module.exports = { encryptCredential, decryptCredential };
```

- [ ] **Step 4: Write failing connection-store tests**

Use `withTestChurchDb` to assert:

- credentials are encrypted in the database;
- status reads never include credential columns;
- a second admin replaces one church connection rather than creating a user-owned duplicate;
- church B cannot read church A's connection;
- disconnect deletes only the requested provider; and
- validation metadata contains no credential value.

The status assertion must be exact:

```js
assert.deepEqual(await getConnection(churchId, 'elvanto'), {
  provider: 'elvanto',
  authType: 'api_key',
  connectionStatus: 'connected',
  connectedAt: result.connectedAt,
  lastValidatedAt: null,
  lastErrorCode: null,
  metadata: {},
  metadataCachedAt: null,
});
```

- [ ] **Step 5: Implement `connectionStore.js`**

Use church-scoped upsert and explicit safe projection:

```js
async function upsertConnection({ churchId, provider, authType, credentials, connectedBy, metadata = {} }) {
  const encrypted = encryptCredential(credentials);
  await Database.query(`INSERT INTO integration_connections
    (church_id, provider, auth_type, credential_ciphertext, credential_nonce,
     credential_auth_tag, credential_key_version, connection_status, connected_by, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
    ON CONFLICT(church_id, provider) DO UPDATE SET
      auth_type = excluded.auth_type,
      credential_ciphertext = excluded.credential_ciphertext,
      credential_nonce = excluded.credential_nonce,
      credential_auth_tag = excluded.credential_auth_tag,
      credential_key_version = excluded.credential_key_version,
      connection_status = 'connected', connected_by = excluded.connected_by,
      connected_at = datetime('now'), last_error_code = NULL,
      metadata = excluded.metadata, updated_at = datetime('now')`, [
    churchId, provider, authType,
    encrypted.credential_ciphertext, encrypted.credential_nonce,
    encrypted.credential_auth_tag, encrypted.credential_key_version,
    connectedBy || null, JSON.stringify(metadata),
  ]);
  return getConnection(churchId, provider);
}
```

`getCredentials` selects the encrypted columns and decrypts them; no other exported function returns them.

`updateMetadataCache(churchId, provider, metadata)` reads the existing safe metadata object, replaces only its `syncMetadata` property, and updates `metadata_cached_at`; it preserves keys such as PCO `accountName`/Elvanto `connectionLabel`. Reject keys named `apiKey`, `accessToken`, `refreshToken`, `credential`, or `authorization` at any nesting level.

- [ ] **Step 6: Harden exports and admin tooling**

Add all credential fields to `REDACT_COLUMNS` in `server/routes/takeout.js` and `server/admin/index.js`. Add tests or extracted redaction-helper assertions proving `credential_ciphertext`, nonce, auth tag, and legacy `elvanto_api_key`/`planning_center_tokens` values are absent.

- [ ] **Step 7: Document the encryption prerequisite before any credential migration ships**

Add `openssl rand -base64 32` and `INTEGRATION_CREDENTIALS_KEY` setup to `README.md`. State that the key must be stable across restarts/replicas and backed up separately; losing it makes saved integration credentials unrecoverable.

- [ ] **Step 8: Run tests**

Run: `cd server && node --test services/peopleSync/credentialCipher.test.js services/peopleSync/connectionStore.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/services/peopleSync/credentialCipher.js server/services/peopleSync/credentialCipher.test.js server/services/peopleSync/connectionStore.js server/services/peopleSync/connectionStore.dbintegration.test.js server/routes/takeout.js server/admin/index.js README.md
git commit -m "feat(sync): store encrypted church integration credentials"
```

### Task 3: Add Link, Batch, and Run Repositories

**Files:**
- Create: `server/services/peopleSync/linkRepository.js`
- Create: `server/services/peopleSync/linkRepository.dbintegration.test.js`
- Create: `server/services/peopleSync/batchRepository.js`
- Create: `server/services/peopleSync/batchRepository.dbintegration.test.js`
- Create: `server/services/peopleSync/runRepository.js`
- Create: `server/services/peopleSync/runRepository.dbintegration.test.js`

**Interfaces:**
- Produces link repository methods `listPersonLinks`, `upsertPersonLink`, `upsertPersonLinkWithConnection`, `upsertFamilyLink`, `upsertFamilyLinkWithConnection`, `markPeopleSeen`, and `recordFullFetchPresence`.
- Produces batch methods `listBatches`, `getBatch`, `createBatch`, `updateBatch`, `deleteBatch`, and `recordBatchResult`.
- Produces run methods `startRun`, `finishRun`, `failRun`, `setReviewNotificationFingerprint`, `findLatestReviewNotificationFingerprint`, and `listRecentRuns`.

- [ ] **Step 1: Write failing link-repository tests**

Cover one person linked to both providers, provider collision rejection, church isolation, last-seen reset, and missing full-sync counters:

```js
const first = await recordFullFetchPresence(churchId, 'elvanto', new Set());
assert.equal(first.missingCandidates[0].missingFullSyncCount, 1);
const second = await recordFullFetchPresence(churchId, 'elvanto', new Set());
assert.equal(second.missingCandidates[0].missingFullSyncCount, 2);
await recordFullFetchPresence(churchId, 'elvanto', new Set(['elvanto-1']));
const links = await listPersonLinks(churchId, 'elvanto');
assert.equal(links[0].missingFullSyncCount, 0);
```

- [ ] **Step 2: Run link tests and verify failure**

Run: `cd server && node --test services/peopleSync/linkRepository.dbintegration.test.js`

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement link repository with explicit provider/church predicates**

`recordFullFetchPresence` must run transactionally and never accept a partial-fetch flag:

```js
async function recordFullFetchPresence(churchId, provider, seenExternalIds, { complete }) {
  if (complete !== true) throw new Error('Refusing missing-person accounting for an incomplete full fetch');
  return Database.transaction(async (conn) => {
    const links = await conn.query(
      `SELECT id, external_person_id, individual_id, missing_full_sync_count
       FROM external_person_links WHERE church_id = ? AND provider = ?`,
      [churchId, provider]
    );
    const missingCandidates = [];
    for (const link of links) {
      const seen = seenExternalIds.has(link.external_person_id);
      const next = seen ? 0 : Number(link.missing_full_sync_count) + 1;
      await conn.query(
        `UPDATE external_person_links SET missing_full_sync_count = ?,
          last_seen_at = CASE WHEN ? THEN datetime('now') ELSE last_seen_at END,
          updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [next, seen ? 1 : 0, link.id, churchId]
      );
      if (!seen) missingCandidates.push({ ...link, missingFullSyncCount: next });
    }
    return { missingCandidates };
  });
}
```

`upsertPersonLinkWithConnection(conn, input)` and `upsertFamilyLinkWithConnection(conn, input)` contain the SQL used by the public repository methods and by Task 7's larger transaction. The public `upsertPersonLink(input)` wrapper opens its own `Database.transaction`; nested callers use the explicit-connection variant so person/family/link writes remain atomic.

- [ ] **Step 4: Write failing batch/run repository tests**

Assert camel-case mapping, JSON parse failure safety, schema version retention, provider/church isolation, schedule fields, sanitized counts, and that raw provider payload/credential-shaped fields are rejected from audit input.

- [ ] **Step 5: Implement batch and run repositories**

Use a stable batch DTO:

```js
{
  id, provider, name, enabled, filterSchemaVersion, filterConfig,
  defaultPeopleType, gatheringTypeId, gatheringAutoRemoveEnabled,
  scheduleEnabled, scheduleFrequency, scheduleDay,
  legacyProviderBatchId, lastExternalWatermark, lastSyncAt, lastSyncResult,
}
```

`startRun` accepts only `{ churchId, provider, batchId, trigger, fetchMode }`; `finishRun` accepts only sanitized count keys defined by the plan contract. `setReviewNotificationFingerprint(runId, churchId, fingerprint)` accepts only a 64-character lowercase SHA-256 hex digest, and its read pair is scoped by church and provider. Never spread caller objects into SQL.

`recordBatchResult` updates `last_external_watermark` only after a successful applied or review-required scheduled run. Failed and partial fetches leave the previous watermark untouched.

- [ ] **Step 6: Run repository tests**

Run: `cd server && node --test services/peopleSync/linkRepository.dbintegration.test.js services/peopleSync/batchRepository.dbintegration.test.js services/peopleSync/runRepository.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/peopleSync/linkRepository.js server/services/peopleSync/linkRepository.dbintegration.test.js server/services/peopleSync/batchRepository.js server/services/peopleSync/batchRepository.dbintegration.test.js server/services/peopleSync/runRepository.js server/services/peopleSync/runRepository.dbintegration.test.js
git commit -m "feat(sync): add link batch and run repositories"
```

### Task 4: Replace PCO-Only Locks with a Provider-Neutral Authority Service

**Files:**
- Create: `server/services/peopleSync/authority.js`
- Create: `server/services/peopleSync/authority.dbintegration.test.js`
- Modify: `server/services/planningCenter/mode.js`
- Modify: `server/services/planningCenter/mode.dbintegration.test.js`
- Modify: `server/routes/individuals.js`
- Modify: `server/routes/families.js`
- Modify: `server/routes/settings.js`
- Modify: `server/routes/families.dbintegration.test.js`

**Interfaces:**
- Produces `getAuthority(churchId)`, `beginAuthoritySwitch(churchId, provider)`, `commitAuthoritySwitch(churchId, provider)`, `disableAuthority(churchId)`, `getManagedLinks(churchId, individualIds)`, `isPersonLocked(authority, links)`, and `lockedResponse(provider, action)`.
- Keeps `server/services/planningCenter/mode.js` as a temporary compatibility re-export.

- [ ] **Step 1: Write failing authority state-machine tests**

```js
test('authority switch is pending until explicitly committed', async () => {
  await withTestChurchDb(async (churchId) => {
    await beginAuthoritySwitch(churchId, 'elvanto');
    assert.deepEqual(await getAuthority(churchId), { active: 'none', pending: 'elvanto' });
    await commitAuthoritySwitch(churchId, 'elvanto');
    assert.deepEqual(await getAuthority(churchId), { active: 'elvanto', pending: null });
  });
});

test('only the active provider link locks a person', async () => {
  const links = new Map([[7, new Set(['planning_center', 'elvanto'])]]);
  assert.equal(isPersonLocked('elvanto', links.get(7)), true);
  assert.equal(isPersonLocked('none', links.get(7)), false);
});
```

Also cover invalid providers, switching cancellation, disabled authority, and church isolation.

- [ ] **Step 2: Run authority tests and verify failure**

Run: `cd server && node --test services/peopleSync/authority.dbintegration.test.js`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement authority service and generic error payload**

```js
const PEOPLE_SOURCE_LOCKED = 'PEOPLE_SOURCE_LOCKED';
const PROVIDER_LABELS = { planning_center: 'Planning Center', elvanto: 'Elvanto' };

function lockedResponse(provider, action = 'change this person') {
  const label = PROVIDER_LABELS[provider] || 'the configured people source';
  return {
    error: `This person is managed by ${label}. Make the change in ${label} and sync again.`,
    code: PEOPLE_SOURCE_LOCKED,
    provider,
    action,
  };
}
```

`commitAuthoritySwitch` must require the same provider currently stored as pending. `disableAuthority` clears both active and pending.

- [ ] **Step 4: Convert backend locks without changing PCO behaviour**

In `individuals.js` and `families.js`, replace `planning_center_id` checks with provider link lookups. For update/delete/restore/permanent-delete/deduplicate/merge, use:

```js
const { active } = await getAuthority(req.user.church_id);
const managed = await getManagedLinks(req.user.church_id, involvedIds);
if (involvedIds.some((id) => isPersonLocked(active, managed.get(Number(id))))) {
  return res.status(403).json(lockedResponse(active, 'merge'));
}
```

For an authority-linked person, reject changes to first name, last name, child state, family ID, and people type with `403 PEOPLE_SOURCE_LOCKED`; badges and local notes remain editable. Reject family rename/type/member-move operations when that family has an active-authority family link or contains an active-authority person link. Block `POST /individuals` whenever `active !== 'none'`. Keep `/families/visitor` available only for `local_visitor` and `traveller_visitor`; reject `regular` there while authority is active.

- [ ] **Step 5: Update settings read API, but keep legacy fields**

`GET /api/settings/integrations` returns:

```js
{
  authorityProvider: active,
  pendingAuthorityProvider: pending,
  elvantoIncludeContacts: !!settings.elvanto_include_contacts,
  elvantoAlignPeopleType: !!settings.elvanto_align_people_type,
  planningCenterSyncIndicator: active === 'planning_center',
  planningCenterSyncEnabled: legacyEnabled,
  planningCenterTrackBackgroundChecks: legacyBackgroundCheck,
}
```

Until the reviewed authority UI lands in Tasks 16 and 20, preserve the existing PCO toggle: `planningCenterSyncIndicator: true` writes `authority_provider = 'planning_center'` and the legacy indicator in one transaction, and `false` writes `none`/`0`. Mark this compatibility path in code and tests. Task 21 removes client use of it and changes future activation to return `409 AUTHORITY_REVIEW_REQUIRED`; this temporary bridge prevents a deploy between backend and frontend tasks from breaking current PCO administration.

- [ ] **Step 6: Keep the PCO mode module as a compatibility adapter**

`isPcoModeActive(churchId)` becomes `return (await getAuthority(churchId)).active === 'planning_center'`; `isIndividualLocked` remains usable by old callers until Task 21 removes them.

- [ ] **Step 7: Expose provider-neutral links in people/family reads**

Load links with `linkRepository.listPersonLinks`/family equivalent and add `externalLinks: { planning_center?: string, elvanto?: string }` plus `managedBy` to individual/family response DTOs. During the compatibility window, `getManagedLinks` also treats a non-empty legacy `individuals.planning_center_id` as a PCO link; this preserves locks for PCO applies that occur before Task 9 begins dual-writing.

- [ ] **Step 8: Run lock regressions**

Run: `cd server && node --test services/peopleSync/authority.dbintegration.test.js services/planningCenter/mode.dbintegration.test.js routes/families.dbintegration.test.js`

Expected: PASS, including existing PCO lock cases and new Elvanto authority cases.

- [ ] **Step 9: Commit**

```bash
git add server/services/peopleSync/authority.js server/services/peopleSync/authority.dbintegration.test.js server/services/planningCenter/mode.js server/services/planningCenter/mode.dbintegration.test.js server/routes/individuals.js server/routes/families.js server/routes/settings.js server/routes/families.dbintegration.test.js
git commit -m "refactor(sync): make people authority provider-neutral"
```

### Task 5: Define the Provider Adapter Contract and Generic Matcher

**Files:**
- Create: `server/services/peopleSync/providerRegistry.js`
- Create: `server/services/peopleSync/providerRegistry.test.js`
- Create: `server/services/peopleSync/matcher.js`
- Create: `server/services/peopleSync/matcher.test.js`

**Interfaces:**
- Produces `registerProvider(name, adapter)`, `getProvider(name)`, `validateAdapter(adapter)`, and `matchPeople(input)`.
- Adapter contract consumed by PCO in Task 8 and Elvanto in Tasks 13-14.

- [ ] **Step 1: Write failing provider-contract tests**

The required adapter interface is exact:

```js
{
  provider: 'planning_center' | 'elvanto',
  validateConnection({ churchId, credentials }),
  fetchSnapshot({ churchId, credentials, mode, watermark }),
  fetchMetadata({ churchId, credentials, force }),
  validateFilter(filterConfig, schemaVersion),
  isEligible(person, filterConfig),
}
```

Test duplicate registration, unknown provider, missing method, and mismatched `adapter.provider`.

- [ ] **Step 2: Implement provider registry**

```js
const REQUIRED = ['validateConnection', 'fetchSnapshot', 'fetchMetadata', 'validateFilter', 'isEligible'];
const adapters = new Map();

function registerProvider(name, adapter) {
  if (adapter.provider !== name) throw new Error(`Adapter provider mismatch: ${name}`);
  for (const method of REQUIRED) {
    if (typeof adapter[method] !== 'function') throw new Error(`Provider ${name} missing ${method}`);
  }
  if (adapters.has(name)) throw new Error(`Provider already registered: ${name}`);
  adapters.set(name, Object.freeze(adapter));
}
```

- [ ] **Step 3: Write matcher tests before implementation**

Cover durable links, unique exact names, child narrowing, family corroboration, duplicates, visitor matches, archived matches, deterministic ordering, and Unicode/punctuation normalization. Explicitly prove email/mobile are ignored:

```js
test('does not auto-match on email because local people do not model it', () => {
  const result = matchPeople({
    externalPeople: [{ id: 'e1', firstName: 'Different', lastName: 'Name', email: 'same@example.com', child: null, familyId: null }],
    localPeople: [{ id: 1, firstName: 'Local', lastName: 'Person', isChild: false, familyId: null, peopleType: 'regular', isActive: true }],
    existingLinks: [], localFamilyMembers: new Map(), externalFamilyMembers: new Map(),
  });
  assert.deepEqual(result.unmatchedExternalIds, ['e1']);
});
```

- [ ] **Step 4: Implement the normalized matcher**

Use this output contract:

```js
{
  linked: [{ individualId, externalPersonId, reason: 'existing_link' }],
  matches: [{ individualId, externalPersonId, reason: 'unique_name' | 'child_narrowing' | 'family_corroboration' }],
  ambiguous: [{ externalPersonId, candidateIndividualIds, reason }],
  unmatchedExternalIds: [],
  unmatchedLocalIds: [],
  visitorMatches: [{ externalPersonId, individualId, peopleType }],
  archivedMatches: [{ externalPersonId, individualId }],
}
```

Sort external people by stable string ID and local candidates by numeric ID before matching. Consume each external/local candidate at most once.

- [ ] **Step 5: Run unit tests**

Run: `cd server && node --test services/peopleSync/providerRegistry.test.js services/peopleSync/matcher.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/providerRegistry.js server/services/peopleSync/providerRegistry.test.js server/services/peopleSync/matcher.js server/services/peopleSync/matcher.test.js
git commit -m "feat(sync): add provider contract and generic matcher"
```

### Task 6: Build Pure Plan Generation Across Overlapping Batches

**Files:**
- Create: `server/services/peopleSync/plan.js`
- Create: `server/services/peopleSync/plan.test.js`
- Create: `server/services/peopleSync/planDigest.js`
- Create: `server/services/peopleSync/planDigest.test.js`

**Interfaces:**
- Produces `computePeopleSyncPlan(input)`, `summarizePlan(plan)`, `digestPlan(plan)`, `createReviewToken(context)`, and `verifyReviewToken(token, expected)`.
- Plan contract consumed by generic apply in Task 7 and all provider routes.

- [ ] **Step 1: Write failing union/filter plan tests**

Test these exact cases:

- a person qualifying for batch A but not B remains in the combined population;
- gathering eligibility remains separate per batch;
- Active maps to regular, Contact maps to local visitor when enabled;
- Contacts disappear from authoritative population when disabled;
- alignment off preserves an existing person's people type;
- Archived/Deceased propose archive;
- linked reappearance proposes reactivate;
- unknown child state never proposes an update;
- non-authoritative plans cannot update authority-owned fields or create regulars;
- manual re-import with no active authority proposes reviewed updates for already-linked records;
- unmatched local regulars are review-only baseline items; and
- missing counters below 2 do not archive, while confirmed count 2 does.

Use a fixture builder in the test, not production:

```js
function person(overrides = {}) {
  return { id: 'ext-1', firstName: 'Ada', lastName: 'Lovelace', child: false,
    state: 'active', familyId: null, attributes: {}, ...overrides };
}
```

- [ ] **Step 2: Run plan tests and verify failure**

Run: `cd server && node --test services/peopleSync/plan.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the stable plan contract**

Return every bucket even when empty:

```js
{
  provider,
  authoritative,
  snapshot: { fetchedAt, watermark, mode },
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [],
  updateManagedFields: [], promoteToRegular: [], demoteToLocalVisitor: [],
  archive: [], reactivate: [], moveFamily: [], renameFamily: [],
  addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
}
```

Build `eligibleByBatch: Map<batchId, Set<externalPersonId>>`, then take its union for lifecycle decisions. Add/remove gathering actions use individual batch sets and `added_by_sync_batch_id` provenance.

- [ ] **Step 4: Write failing digest/token tests**

Assert deterministic digest despite object key order, church/provider/batch binding, expiry, signature tampering, and stale-plan rejection:

```js
const token = createReviewToken({ churchId: 'c1', provider: 'elvanto', batchId: 3, planDigest: digestPlan(plan), expiresInSeconds: 900 });
assert.deepEqual(verifyReviewToken(token, { churchId: 'c1', provider: 'elvanto', batchId: 3, planDigest: digestPlan(plan) }).ok, true);
assert.equal(verifyReviewToken(token, { churchId: 'c2', provider: 'elvanto', batchId: 3, planDigest: digestPlan(plan) }).ok, false);
```

- [ ] **Step 5: Implement deterministic digest and HMAC review token**

Canonicalize recursively by sorted object keys and hash with SHA-256. Before hashing, remove volatile display fields (`snapshot.fetchedAt`, run IDs, cached metadata timestamps) while retaining the external watermark, action IDs, candidates, and local/external values used by every action. Sign a base64url payload with HMAC-SHA256 using `SYNC_REVIEW_SECRET || JWT_SECRET`. Payload fields are `{ churchId, provider, batchId, planDigest, exp }`. `verifyReviewToken` returns `{ ok: false, code: 'SYNC_PLAN_STALE' | 'SYNC_REVIEW_EXPIRED' | 'SYNC_REVIEW_INVALID' }` rather than throwing on user input.

- [ ] **Step 6: Run plan/token tests**

Run: `cd server && node --test services/peopleSync/plan.test.js services/peopleSync/planDigest.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/peopleSync/plan.js server/services/peopleSync/plan.test.js server/services/peopleSync/planDigest.js server/services/peopleSync/planDigest.test.js
git commit -m "feat(sync): generate reviewable provider-neutral plans"
```

### Task 7: Apply Provider-Neutral Plans Transactionally

**Files:**
- Create: `server/services/peopleSync/apply.js`
- Create: `server/services/peopleSync/apply.test.js`
- Create: `server/services/peopleSync/apply.dbintegration.test.js`
- Modify: `server/services/peopleSync/linkRepository.js`

**Interfaces:**
- Produces `applyPeopleSyncPlan({ churchId, provider, plan, selections, userId })` and `validateSelections(plan, selections)`.
- Consumes the Task 6 plan contract and Task 3 link repository.
- Produces result counts matching `summarizePlan` plus `familyNamesUpdated`, `gatheringAssigned`, and `gatheringRemoved`.

- [ ] **Step 1: Write failing pure selection-validation tests**

Define this provider-neutral selection payload:

```js
{
  ambiguous: { [externalPersonId]: individualId },
  skipExternalPersonIds: [],
  visitorChoices: { [externalPersonId]: 'promote' | 'keep' },
  acceptArchiveIndividualIds: [],
  acceptFamilyRenameIds: [],
}
```

Test that choices must appear in the plan, may not collide with another accepted link/add, and cannot reference another church indirectly through an arbitrary local ID.

- [ ] **Step 2: Write failing transactional integration tests**

Cover:

- link creation writes `external_person_links` and dual-writes the legacy PCO ID only when provider is PCO;
- person/family creation and link creation commit together;
- a forced family-link constraint error rolls back the newly created person and family;
- managed updates ignore `child: null`;
- Active/Contact type alignment and archive/reactivate transitions;
- a non-authoritative plan cannot modify an authority-linked record;
- gathering insert uses `added_by_sync_batch_id`;
- manual/other-batch gathering rows are never removed; and
- an owner batch does not remove a row while any other enabled batch targeting the same gathering still qualifies that person.

The rollback assertion must query all three tables after the thrown error:

```js
assert.equal((await Database.query('SELECT COUNT(*) AS n FROM individuals WHERE church_id = ?', [churchId]))[0].n, 0);
assert.equal((await Database.query('SELECT COUNT(*) AS n FROM families WHERE church_id = ?', [churchId]))[0].n, 0);
assert.equal((await Database.query('SELECT COUNT(*) AS n FROM external_person_links WHERE church_id = ?', [churchId]))[0].n, 0);
```

- [ ] **Step 3: Run apply tests and verify failure**

Run: `cd server && node --test services/peopleSync/apply.test.js services/peopleSync/apply.dbintegration.test.js`

Expected: FAIL because the apply service does not exist.

- [ ] **Step 4: Implement one critical transaction**

Do not copy the current PCO apply service's per-item catch-and-continue behaviour. Use one critical transaction:

```js
async function applyPeopleSyncPlan({ churchId, provider, plan, selections = {}, userId }) {
  const accepted = validateSelections(plan, selections);
  return Database.transaction(async (conn) => {
    const result = emptyResult();
    for (const action of [...plan.linkPeople, ...accepted.ambiguousLinks]) {
      await linkRepository.upsertPersonLinkWithConnection(conn, {
        churchId, provider, externalPersonId: action.externalPersonId,
        individualId: action.individualId, linkSource: action.linkSource || 'matched',
      });
      if (provider === 'planning_center') {
        await conn.query(
          `UPDATE individuals SET planning_center_id = ?, updated_at = datetime('now')
           WHERE id = ? AND church_id = ?`,
          [action.externalPersonId, action.individualId, churchId]
        );
      }
      result.linked++;
    }
    // Apply the remaining buckets in dependency order:
    // families -> people -> links -> field/lifecycle changes -> gatherings.
    return result;
  });
}
```

Use explicit SQL for each bucket. Throw on a critical person/family/link failure so the transaction rolls back. Optional provider extras, such as PCO background-check projection, execute after the critical transaction and report their own sanitized warning count.

- [ ] **Step 5: Implement family and gathering provenance rules**

When creating a family, derive the reviewed `familyName` already present in the plan; apply never rebuilds names. Before deleting an owned gathering row, query current eligible actions for all batches targeting that gathering and skip deletion if another batch still qualifies the individual.

- [ ] **Step 6: Run apply tests and PCO apply regressions**

Run: `cd server && node --test services/peopleSync/apply.test.js services/peopleSync/apply.dbintegration.test.js services/planningCenter/apply.test.js services/planningCenter/apply.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/peopleSync/apply.js server/services/peopleSync/apply.test.js server/services/peopleSync/apply.dbintegration.test.js server/services/peopleSync/linkRepository.js
git commit -m "feat(sync): apply provider-neutral plans transactionally"
```

### Task 8: Wrap PCO Fetching and Filtering in the Provider Contract

**Files:**
- Create: `server/services/peopleSync/pcoAdapter.js`
- Create: `server/services/peopleSync/pcoAdapter.test.js`
- Modify: `server/services/planningCenterSync.js`
- Modify: `server/services/planningCenter/eligibility.js`
- Modify: `server/services/planningCenter/projection.js`

**Interfaces:**
- Registers provider `planning_center` using the Task 5 adapter contract.
- Converts current PCO projections into normalized people with `state`, `child`, `familyId`, and `attributes`.
- Leaves check-in and background-check APIs provider-specific.

- [ ] **Step 1: Write failing adapter tests using injected PCO functions**

Avoid real network calls by constructing the adapter with dependencies:

```js
const adapter = createPcoAdapter({
  getAccessToken: async () => 'token',
  fetchPeople: async () => ({ people: [rawProjectedPerson], householdPrimaryContacts: new Map(), fetchedAt: 123 }),
  fetchMetadata: async () => ({ memberships: [], fieldDefinitions: [] }),
});
const snapshot = await adapter.fetchSnapshot({ churchId: 'c1', credentials: { accessToken: 'token' }, mode: 'full' });
assert.equal(snapshot.people[0].state, 'active');
assert.equal(snapshot.people[0].provider, 'planning_center');
```

Cover active/inactive status, household IDs, field values, and PCO filter equivalence with the existing `isEligible` tests.

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `cd server && node --test services/peopleSync/pcoAdapter.test.js`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the PCO adapter as a compatibility wrapper**

```js
function createPcoAdapter(deps = defaultDeps) {
  return {
    provider: 'planning_center',
    async validateConnection({ credentials }) {
      return deps.validateToken(credentials.accessToken);
    },
    async fetchSnapshot({ churchId, credentials, mode }) {
      const fetched = await deps.fetchPeople(churchId, credentials.accessToken, { force: mode === 'full' });
      return {
        provider: 'planning_center', mode: 'full', complete: true,
        fetchedAt: new Date(fetched.fetchedAt || Date.now()).toISOString(), watermark: null,
        people: fetched.people.map(toNormalizedPcoPerson),
        families: projectPcoHouseholds(fetched.people, fetched.householdPrimaryContacts),
      };
    },
    fetchMetadata: deps.fetchMetadata,
    validateFilter: validatePcoFilter,
    isEligible(person, filterConfig) { return isEligible(fromNormalized(person), filterConfig); },
  };
}
```

PCO is full-fetch only in this phase. Do not alter its existing cache behaviour.

- [ ] **Step 4: Export dependency-safe helpers from existing PCO modules**

Expose current fetch/cache/metadata methods rather than duplicating HTTPS/token code. Keep old exports and tests intact.

- [ ] **Step 5: Run the complete PCO unit suite**

Run: `cd server && node --test services/planningCenter/*.test.js services/planningCenterSync.test.js services/peopleSync/pcoAdapter.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/peopleSync/pcoAdapter.js server/services/peopleSync/pcoAdapter.test.js server/services/planningCenterSync.js server/services/planningCenter/eligibility.js server/services/planningCenter/projection.js
git commit -m "refactor(pco): expose provider-neutral adapter"
```

### Task 9: Route PCO Batches and Reviews Through Generic Repositories

**Files:**
- Modify: `server/services/planningCenterSync.js`
- Modify: `server/services/planningCenterSync.test.js`
- Modify: `server/routes/integrations.js`
- Modify: `server/routes/integrations.sync-stats.dbintegration.test.js`
- Modify: `server/services/planningCenter/apply.js`
- Modify: `server/services/planningCenter/apply.dbintegration.test.js`

**Interfaces:**
- Existing `/planning-center/sync-batches` and review/apply response shapes remain compatible.
- Generic `people_sync_batches`, `external_*_links`, and `added_by_sync_batch_id` become canonical; legacy PCO fields are dual-written.

- [ ] **Step 1: Add failing PCO compatibility tests**

Test that:

- listing a backfilled generic PCO batch returns the existing `SyncBatch` DTO;
- create/update/delete writes generic batch rows and legacy rows during compatibility;
- a reviewed PCO apply writes both `external_person_links` and `individuals.planning_center_id`;
- gathering assignment writes both generic and PCO provenance for a legacy-backed batch;
- old clients omitting `gatheringAutoRemoveEnabled` still default false; and
- plan/apply summaries retain current fields.

- [ ] **Step 2: Run focused PCO tests and verify failure**

Run: `cd server && node --test services/planningCenterSync.test.js services/planningCenter/apply.dbintegration.test.js routes/integrations.sync-stats.dbintegration.test.js`

Expected: at least one new compatibility assertion fails.

- [ ] **Step 3: Make generic batches canonical behind current PCO functions**

Replace internals, not public signatures:

```js
async function listBatches(churchId) {
  const batches = await batchRepository.listBatches(churchId, 'planning_center');
  return batches.map(toLegacyPcoBatchDto);
}

function batchFilterConfig(batch) {
  return batch.filterConfig || {
    membershipFilterEnabled: batch.membershipFilterEnabled,
    membershipAllowlist: batch.membershipAllowlist,
    fieldFilterEnabled: batch.fieldFilterEnabled,
    fieldFilters: batch.fieldFilters,
  };
}
```

Create/update routes write `people_sync_batches` first. During the compatibility window, upsert the corresponding legacy row and store its ID as `legacy_provider_batch_id`.

- [ ] **Step 4: Dual-write links and gathering provenance**

When existing PCO apply code links/creates a person/family, call repository helpers using the same transaction connection. When it inserts a gathering row, set `added_by_sync_batch_id` and, when present, `added_by_pco_batch_id`.

- [ ] **Step 5: Run all PCO tests and server schema tests**

Run: `cd server && node --test services/planningCenter/*.test.js services/planningCenterSync.test.js config/peopleSyncSchema.dbintegration.test.js routes/integrations.sync-stats.dbintegration.test.js`

Expected: PASS with unchanged route response snapshots.

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenterSync.js server/services/planningCenterSync.test.js server/routes/integrations.js server/routes/integrations.sync-stats.dbintegration.test.js server/services/planningCenter/apply.js server/services/planningCenter/apply.dbintegration.test.js
git commit -m "refactor(pco): use generic sync links and batches"
```

### Task 10: Centralize PCO Credentials and Scheduling

**Files:**
- Modify: `server/services/planningCenterSync.js`
- Create: `server/services/peopleSync/pcoCredentialMigration.dbintegration.test.js`
- Create: `server/services/peopleSync/scheduler.js`
- Create: `server/services/peopleSync/scheduler.test.js`
- Modify: `server/routes/integrations.js`
- Modify: `server/index.js`

**Interfaces:**
- PCO OAuth callback stores `{ accessToken, refreshToken, expiresAt }` in `integration_connections`.
- Produces `scheduler.start()`, `scheduler.stop()`, `scheduler.runChurch(churchId, options)`, and shared `isDueToday`.
- Keeps `planningCenterSync.start/stop/runNow` compatibility wrappers.

- [ ] **Step 1: Write failing PCO credential-migration tests**

Seed legacy `user_preferences` tokens and assert:

- one distinct credential is encrypted/migrated at first access;
- two identical legacy token rows collapse safely;
- two different token rows return `PCO_RECONNECT_REQUIRED` and do not guess;
- refresh writes one church connection row; and
- no refreshed token is written back to an arbitrary user's preference row.

- [ ] **Step 2: Write failing scheduler tests**

Inject repositories/adapters and verify:

- only enabled/due batches run;
- only the authoritative provider may run lifecycle apply unattended;
- non-authoritative scheduled batches are skipped;
- review-required counts create a sanitized notification summary;
- one church failure does not stop another church; and
- background work executes inside `Database.setChurchContext`.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd server && node --test services/peopleSync/pcoCredentialMigration.dbintegration.test.js services/peopleSync/scheduler.test.js`

Expected: FAIL.

- [ ] **Step 4: Move OAuth and token refresh to `connectionStore`**

The callback exchanges the code, then performs:

```js
await connectionStore.upsertConnection({
  churchId: req.user.church_id,
  provider: 'planning_center',
  authType: 'oauth',
  credentials: {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: Date.now() + Number(tokenResponse.expires_in) * 1000,
  },
  connectedBy: req.user.id,
  metadata: { accountName },
});
```

Use one per-church refresh promise/mutex so concurrent callers share the same refresh operation. Replace all three independent token-refresh paths with this manager.

- [ ] **Step 5: Implement the provider-neutral scheduler**

Move `isDueToday` unchanged. At 02:00, iterate registry churches sequentially and call `runChurch`. In this task the scheduler accepts an injected `executeBatch` and its production default delegates PCO batches to the existing `runBatchSync`; this keeps the module deployable before the generic orchestrator exists. Task 15 replaces that executor with `orchestrator.runUnattended`. The scheduler still loads `authority_provider`, due generic batches, and connection status before dispatch.

`planningCenterSync.start/stop/runNow` delegate to the new scheduler during compatibility; `server/index.js` starts only `peopleSync/scheduler`, never both cron jobs.

- [ ] **Step 6: Run PCO scheduling/token regressions**

Run: `cd server && node --test services/peopleSync/pcoCredentialMigration.dbintegration.test.js services/peopleSync/scheduler.test.js services/planningCenterSync.test.js services/planningCenter/*.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/planningCenterSync.js server/services/peopleSync/pcoCredentialMigration.dbintegration.test.js server/services/peopleSync/scheduler.js server/services/peopleSync/scheduler.test.js server/routes/integrations.js server/index.js
git commit -m "refactor(pco): centralize credentials and scheduling"
```

### Task 11: Implement the Elvanto HTTP Client and Complete Pagination

**Files:**
- Create: `server/services/elvanto/httpClient.js`
- Create: `server/services/elvanto/httpClient.test.js`

**Interfaces:**
- Produces `createElvantoClient({ apiKey, request })` with `get(path, params)`, `post(path, body)`, and `getAll(path, params, collectionKey, itemKey)`.
- Used by Elvanto normalizer/adapter in Tasks 12-13.

- [ ] **Step 1: Write failing request/pagination tests**

Use an injected `request` function and assert Basic auth, timeout, status/body errors, single-object normalization, page size 1000, termination by `total`, and abort on partial-page failure:

```js
const client = createElvantoClient({
  apiKey: 'key',
  request: async ({ path, params, headers }) => {
    assert.equal(headers.Authorization, `Basic ${Buffer.from('key:x').toString('base64')}`);
    return { status: 200, data: { status: 'ok', people: { page: 1, per_page: 1000, total: 1, person: { id: 'p1' } } } };
  },
});
assert.deepEqual(await client.getAll('/people/getAll.json', {}, 'people', 'person'), [{ id: 'p1' }]);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `cd server && node --test services/elvanto/httpClient.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement request and error classes**

Define `ElvantoError` with codes `ELVANTO_AUTH`, `ELVANTO_UNAVAILABLE`, `ELVANTO_RESPONSE`, and `ELVANTO_PAGINATION`. Never include the API key, Authorization header, or full person payload in `.message` or `.details`.

`getAll` must reject `page_size` outside 10-1000, stop after 1000 pages, and return `{ items, complete: true, pages, total }`; it never returns accumulated partial items after a later page fails.

- [ ] **Step 4: Run tests**

Run: `cd server && node --test services/elvanto/httpClient.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/elvanto/httpClient.js server/services/elvanto/httpClient.test.js
git commit -m "feat(elvanto): add safe paginated API client"
```

### Task 12: Normalize Elvanto People, Families, Status, and Child State

**Files:**
- Create: `server/services/elvanto/normalizer.js`
- Create: `server/services/elvanto/normalizer.test.js`
- Create: `server/services/elvanto/fixtures/people.js`

**Interfaces:**
- Produces `normalizePerson(raw, memberships)`, `normalizeSnapshot(rawPeople, groupMemberships)`, `deriveElvantoState(raw)`, `deriveChildState(raw)`, and `buildElvantoFamilies(people)`.
- Returns the Task 5 normalized person/family shape.

- [ ] **Step 1: Add representative sanitized fixtures**

Include Active, Contact, Archived, Deceased, overlapping flags, Primary Contact, Spouse, Child, solo person, preferred name, missing names, single-value/list custom fields, and absent optional fields. Fixtures contain no real church data.

- [ ] **Step 2: Write failing normalizer tests**

Assert status precedence `deceased > archived > contact > active`, exact external IDs, trimmed names, `child: true|false|null`, family grouping, and family naming:

```js
assert.equal(deriveElvantoState({ deceased: '1', archived: '0', contact: '1' }), 'deceased');
assert.equal(deriveElvantoState({ archived: '1', contact: '1' }), 'archived');
assert.equal(deriveChildState({ family_relationship: 'Child' }), true);
assert.equal(deriveChildState({ family_relationship: '', birthday: '' }), null);
```

For newly created people, `child: null` remains null in the plan; apply defaults it to adult only at insert time.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd server && node --test services/elvanto/normalizer.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement deterministic normalization**

Normalized person shape:

```js
{
  provider: 'elvanto', id, firstName, preferredName, lastName,
  state, child, familyId, familyRelationship, categoryId,
  modifiedAt, attributes: {
    groups: [], demographics: [], departments: [], serviceTypes: [],
    locations: [], customFields: {},
  },
}
```

Drop records missing stable ID or both usable first/last name into `skipped` with reason codes; do not invent names during normalization. Sort people and family members by stable ID.

- [ ] **Step 5: Run tests**

Run: `cd server && node --test services/elvanto/normalizer.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/elvanto/normalizer.js server/services/elvanto/normalizer.test.js server/services/elvanto/fixtures/people.js
git commit -m "feat(elvanto): normalize people and families"
```

### Task 13: Discover Elvanto Metadata and Evaluate Versioned Filters

**Files:**
- Create: `server/services/elvanto/metadata.js`
- Create: `server/services/elvanto/metadata.test.js`
- Create: `server/services/elvanto/filter.js`
- Create: `server/services/elvanto/filter.test.js`

**Interfaces:**
- Produces `fetchElvantoMetadata(client, snapshot)`, `validateElvantoFilter(config, version)`, and `isElvantoEligible(person, config)`.
- Defines Elvanto filter schema version `1` for batch repository/adapter/UI use.
- Persists sanitized metadata through `connectionStore.updateMetadataCache(churchId, 'elvanto', metadata)` and serves cached metadata with `metadataCachedAt`.

- [ ] **Step 1: Write failing metadata tests**

Inject client responses and assert normalized metadata for categories, groups, service types, locations, departments, and custom-field definitions. Derive demographics and any unavailable definition lists from distinct projected person values rather than inventing undocumented endpoints.

The returned shape is exact:

```js
{
  fetchedAt: '2026-07-25T00:00:00.000Z',
  categories: [{ id: 'cat-1', name: 'Members' }],
  groups: [{ id: 'group-1', name: 'Youth', status: 'Active', memberCount: 12 }],
  demographics: [{ value: 'Young Adults', count: 8 }],
  departments: [{ value: 'Worship Team', count: 5 }],
  serviceTypes: [{ id: 'service-1', name: 'Sunday AM' }],
  locations: [{ id: 'loc-1', name: 'North Campus' }],
  customFields: [{ id: 'field-1', name: 'Ministries', type: 'select_multi', values: [{ id: 'v1', name: 'Golf Guys' }] }],
}
```

- [ ] **Step 2: Write failing filter validation/evaluation tests**

Version 1 filter shape:

```js
{
  statuses: ['active', 'contact'],
  categoryIds: ['cat-1'],
  groups: { ids: ['g1', 'g2'], operator: 'any' },
  demographics: { values: [], operator: 'any' },
  departments: { values: [], operator: 'any' },
  serviceTypes: { ids: [], operator: 'any' },
  locations: { ids: [], operator: 'any' },
  customFields: [{ fieldId: 'field-1', values: ['v1'], operator: 'any' }],
}
```

Assert:

- selected values within one dimension obey `any`/`all`;
- non-empty dimensions combine with AND;
- empty dimensions are ignored;
- empty `statuses` is rejected;
- unknown operator, key, status, schema version, or non-array value is rejected;
- duplicate IDs are normalized away; and
- `contact` cannot qualify when the church-wide include-contacts setting removes it before filter evaluation.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd server && node --test services/elvanto/metadata.test.js services/elvanto/filter.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement metadata projection**

Call documented definition endpoints for categories, groups, service types, locations, departments, and custom fields. Convert object-or-array response fields with one `asArray(value)` helper. Build counts from the already fetched normalized snapshot, keyed by stable ID/value. Sort every option by case-insensitive label then ID.

After a complete fetch, write the normalized metadata JSON under `connection.metadata.syncMetadata` and set `metadata_cached_at = datetime('now')` through `connectionStore.updateMetadataCache`. If a refresh fails and a cache exists, return `{ metadata: cached, stale: true, refreshing: false }`; if no cache exists, propagate the typed provider error. Never cache raw people or credential data.

- [ ] **Step 5: Implement strict filter validation and evaluation**

Use an allow-list of top-level keys and return `{ ok, value, errors }`:

```js
function isElvantoEligible(person, config) {
  if (!config.statuses.includes(person.state)) return false;
  if (config.categoryIds.length && !config.categoryIds.includes(person.categoryId)) return false;
  if (!matchesSet(person.attributes.groups, config.groups.ids, config.groups.operator)) return false;
  if (!matchesSet(person.attributes.demographics, config.demographics.values, config.demographics.operator)) return false;
  if (!matchesSet(person.attributes.departments, config.departments.values, config.departments.operator)) return false;
  if (!matchesSet(person.attributes.serviceTypes, config.serviceTypes.ids, config.serviceTypes.operator)) return false;
  if (!matchesSet(person.attributes.locations, config.locations.ids, config.locations.operator)) return false;
  return config.customFields.every((rule) =>
    matchesSet(person.attributes.customFields[rule.fieldId] || [], rule.values, rule.operator)
  );
}
```

`matchesSet` returns true for an empty selected set.

- [ ] **Step 6: Run tests**

Run: `cd server && node --test services/elvanto/metadata.test.js services/elvanto/filter.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/elvanto/metadata.js server/services/elvanto/metadata.test.js server/services/elvanto/filter.js server/services/elvanto/filter.test.js
git commit -m "feat(elvanto): add metadata and batch filters"
```

### Task 14: Implement the Elvanto Provider Adapter and Incremental Watermarks

**Files:**
- Create: `server/services/elvanto/adapter.js`
- Create: `server/services/elvanto/adapter.test.js`
- Modify: `server/services/peopleSync/providerRegistry.js`

**Interfaces:**
- Registers provider `elvanto` using the Task 5 adapter contract.
- Full snapshot returns every status and `complete: true` only after all people/group pages succeed.
- Incremental snapshot uses an overlapping UTC `date_modified` watermark and returns a new watermark only after a complete fetch.

- [ ] **Step 1: Write failing adapter connection tests**

Assert a small `people/getAll` request validates an API key, auth failures return `ELVANTO_AUTH`, provider outages return `ELVANTO_UNAVAILABLE`, and no status/error value includes the submitted key.

- [ ] **Step 2: Write failing full/incremental snapshot tests**

Test:

- full people pagination requests optional fields needed by normalization;
- group membership is indexed by person ID;
- custom field names are requested using `custom_<id>`;
- full snapshots include Active, Contact, Archived, and Deceased;
- incremental search sends UTC `search[date_modified]` five minutes before the stored watermark;
- duplicate people across the overlap de-duplicate by ID using newest `date_modified`;
- a failed group page makes the snapshot incomplete and throws;
- the output watermark is the greatest valid `date_modified`, not wall-clock time; and
- a group membership change is caught by the mandatory periodic full path even if the person timestamp did not change.

- [ ] **Step 3: Run adapter tests and verify failure**

Run: `cd server && node --test services/elvanto/adapter.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement adapter composition**

```js
function createElvantoAdapter({ clientFactory = createElvantoClient, now = () => new Date() } = {}) {
  return {
    provider: 'elvanto',
    async validateConnection({ credentials }) {
      const client = clientFactory({ apiKey: credentials.apiKey });
      await client.get('/people/getAll.json', { page: 1, page_size: 10 });
      return { ok: true, metadata: { connectionLabel: 'Connected via API key' } };
    },
    async fetchSnapshot({ credentials, mode, watermark, customFieldIds = [] }) {
      const client = clientFactory({ apiKey: credentials.apiKey });
      return mode === 'incremental'
        ? fetchIncrementalSnapshot(client, watermark, customFieldIds, now)
        : fetchFullSnapshot(client, customFieldIds, now);
    },
    async fetchMetadata({ credentials, snapshot }) {
      return fetchElvantoMetadata(clientFactory({ apiKey: credentials.apiKey }), snapshot);
    },
    validateFilter: validateElvantoFilter,
    isEligible: isElvantoEligible,
  };
}
```

`fetchFullSnapshot` builds group memberships from fully paginated groups with `fields[]=people`. `fetchIncrementalSnapshot` still refreshes the group membership index before evaluating changed people; it does not reuse stale group membership for a destructive decision.

- [ ] **Step 5: Register the adapter once at startup**

Export `registerBuiltInProviders()` from `providerRegistry.js`; it registers PCO and Elvanto idempotently for production startup while tests may create isolated registries.

- [ ] **Step 6: Run adapter and contract tests**

Run: `cd server && node --test services/elvanto/*.test.js services/peopleSync/providerRegistry.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/services/elvanto/adapter.js server/services/elvanto/adapter.test.js server/services/peopleSync/providerRegistry.js
git commit -m "feat(elvanto): add source adapter and incremental fetch"
```

### Task 15: Orchestrate Fetch, Match, Review, Apply, and Audit

**Files:**
- Create: `server/services/peopleSync/orchestrator.js`
- Create: `server/services/peopleSync/orchestrator.test.js`
- Create: `server/services/peopleSync/orchestrator.dbintegration.test.js`
- Create: `server/services/peopleSync/reviewNotification.js`
- Create: `server/services/peopleSync/reviewNotification.dbintegration.test.js`
- Modify: `server/services/peopleSync/scheduler.js`
- Modify: `server/services/peopleSync/scheduler.test.js`

**Interfaces:**
- Produces `buildReview({ churchId, provider, batchId, trigger, forceFull })`, `applyReviewed({ churchId, provider, batchId, reviewToken, selections, userId })`, `runUnattended({ churchId, provider, batchId, forceFull })`, and `previewAuthoritySwitch(...)`.
- Produces `notifyReviewRequired({ churchId, provider, runId, counts })`, de-duplicated by provider and unchanged pending counts.
- Centralizes all plan/apply calls; routes never call adapter or apply modules directly.

- [ ] **Step 1: Write failing orchestrator unit tests with dependency injection**

Assert exact call order:

1. load connection;
2. load/validate batches and settings;
3. start audit run;
4. fetch snapshot;
5. load local state/links and existing missing counters;
6. match;
7. compute the plan, including the projected next missing count for a complete full snapshot;
8. create a review token or apply safe unattended actions;
9. persist full-fetch presence at most once for an applied review or completed unattended reconciliation;
10. finish audit run.

Assert any fetch/validation error calls `failRun` and never calls apply.

Pure previews (`buildReview`) do not increment missing counters. Re-fetching during `applyReviewed` also does not count separately: the counter is written once only after the apply succeeds. A successful scheduled full reconciliation counts once even when it finishes as `review_required`; repeated button clicks on preview never satisfy the two-reconciliation disappearance rule.

- [ ] **Step 2: Write failing integration tests**

Use a fake registered provider with a complete snapshot. Cover onboarding/manual review, stale token returning 409 semantics, first authority reconciliation remaining pending until apply, non-authoritative import restrictions, full missing-count behaviour, and sanitized run counts.

- [ ] **Step 3: Run orchestrator tests and verify failure**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement local-state loading and review creation**

Load all active and archived individuals/families, generic links, gathering provenance, enabled provider batches, settings, and current authority in church context. `buildReview` always uses a full snapshot for onboarding, manual, `review & sync`, and authority switching.

Return only:

```js
{
  runId,
  reviewToken,
  summary: summarizePlan(plan),
  plan: sanitizePlanForReview(plan),
  snapshot: { fetchedAt: plan.snapshot.fetchedAt, mode: plan.snapshot.mode },
}
```

`sanitizePlanForReview` drops raw attributes/custom-field maps not needed to explain an action.

- [ ] **Step 5: Implement reviewed apply and stale-plan handling**

`applyReviewed` fetches a fresh full snapshot, rebuilds the plan, calculates its digest, verifies the token against church/provider/batch/digest, validates selections, then applies. Return `{ status: 409, code: 'SYNC_PLAN_STALE' }` through a typed error when the digest differs.

For authority switching, call `commitAuthoritySwitch` only after `applyPeopleSyncPlan` succeeds. After the transaction commits, call `recordFullFetchPresence(..., { complete: true })` once for that run. If presence accounting fails, record a warning and leave lifecycle data unchanged; do not reapply the person plan.

- [ ] **Step 6: Implement unattended safety policy**

`runUnattended` is permitted only when `provider === active authority`. It may apply deterministic links, additions, managed updates, explicit upstream archive/reactivate, and provenance-safe gathering changes. It must strip/hold `ambiguousPeople`, `familyConflicts`, `renameFamily`, `unmatchedLocalRegulars`, and first-time hard-absence archive proposals, then mark the run `review_required` with pending counts.

For a complete scheduled full snapshot, persist presence once after plan classification. A disappearance archive is eligible only when the stored prior count was already `1` and this run projects `2`; an incremental snapshot never reads or updates disappearance counters.

- [ ] **Step 7: Connect scheduler to orchestrator**

Scheduler calls `runUnattended` for due authoritative batches. Once weekly on configured day, force a full run; other scheduled runs may use the adapter's incremental watermark. Persist the returned watermark only after successful apply/review classification.

- [ ] **Step 8: Add persistent review-required notifications**

Write an integration test that seeds two admins, calls `notifyReviewRequired` twice with unchanged counts, and asserts one notification per admin; changed counts create one new notice. Hash the stable provider plus pending-count object with SHA-256, store it in `people_sync_runs.review_notification_fingerprint`, and compare it through `findLatestReviewNotificationFingerprint`; do not reuse provider-specific church settings. Message copy names the provider and links users to Settings → Integrations; it contains no person names or provider payloads.

- [ ] **Step 9: Run orchestrator/scheduler tests**

Run: `cd server && node --test services/peopleSync/orchestrator.test.js services/peopleSync/orchestrator.dbintegration.test.js services/peopleSync/reviewNotification.dbintegration.test.js services/peopleSync/scheduler.test.js`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/orchestrator.dbintegration.test.js server/services/peopleSync/reviewNotification.js server/services/peopleSync/reviewNotification.dbintegration.test.js server/services/peopleSync/scheduler.js server/services/peopleSync/scheduler.test.js
git commit -m "feat(sync): orchestrate reviewed and scheduled sync"
```

### Task 16: Add Generic Authority and Elvanto Sync Routes

**Files:**
- Create: `server/routes/integrations/peopleSync.js`
- Create: `server/routes/integrations/peopleSync.test.js`
- Create: `server/routes/integrations/elvanto.js`
- Create: `server/routes/integrations/elvanto.test.js`
- Create: `server/services/elvanto/legacyCredential.js`
- Create: `server/services/elvanto/legacyCredential.dbintegration.test.js`
- Modify: `server/routes/integrations.js`

**Interfaces:**
- Adds `/api/integrations/people-sync/*` and replaces `/api/integrations/elvanto/*` people-sync endpoints.
- Existing gathering-import endpoints remain temporarily available and are cleaned up in Task 21.

- [ ] **Step 1: Write failing route tests with a small Express harness**

Use injected service dependencies rather than real network calls. Assert admin-only access, church ID forwarding, request validation, safe errors, timeouts, and these endpoints:

```text
GET    /people-sync/settings
PUT    /people-sync/settings
POST   /people-sync/authority/preview
POST   /people-sync/authority/apply
POST   /people-sync/authority/disable
GET    /people-sync/runs

GET    /elvanto/status
POST   /elvanto/connect
POST   /elvanto/disconnect
GET    /elvanto/metadata
POST   /elvanto/metadata/refresh
GET    /elvanto/sync-batches
POST   /elvanto/sync-batches
PUT    /elvanto/sync-batches/:id
DELETE /elvanto/sync-batches/:id
GET    /elvanto/sync-batches/:id/plan
POST   /elvanto/sync-batches/:id/apply
POST   /elvanto/sync-batches/:id/run-now
```

- [ ] **Step 2: Write legacy API-key migration tests**

Seed `user_preferences.preference_key = 'elvanto_api_key'` and assert:

- one distinct key validates, encrypts, and becomes church-level;
- identical keys across users collapse;
- different keys produce `ELVANTO_RECONNECT_REQUIRED` without choosing one;
- invalid legacy key is not migrated;
- successful migration removes legacy key preferences only after encrypted save; and
- no response returns key prefixes or lengths.

- [ ] **Step 3: Run route/migration tests and verify failure**

Run: `cd server && node --test routes/integrations/peopleSync.test.js routes/integrations/elvanto.test.js services/elvanto/legacyCredential.dbintegration.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement connection routes with validate-before-replace**

```js
router.post('/connect', async (req, res) => {
  const apiKey = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!apiKey) return res.status(400).json({ error: 'API key is required.' });
  const validation = await adapter.validateConnection({ churchId: req.user.church_id, credentials: { apiKey } });
  await connectionStore.upsertConnection({
    churchId: req.user.church_id, provider: 'elvanto', authType: 'api_key',
    credentials: { apiKey }, connectedBy: req.user.id, metadata: validation.metadata,
  });
  res.json({ success: true, status: await connectionStore.getConnection(req.user.church_id, 'elvanto') });
});
```

If validation fails, leave the previous connection untouched. Disconnecting an authoritative Elvanto connection calls `disableAuthority` before deleting credentials; links/batches remain.

- [ ] **Step 5: Implement batch/metadata/plan/apply routes**

Validate all filter payloads through the adapter before repository writes. Map typed orchestrator errors:

- `SYNC_PLAN_STALE` -> 409
- `SYNC_REVIEW_EXPIRED` -> 409
- `AUTHORITY_REVIEW_REQUIRED` -> 409
- `ELVANTO_AUTH` -> 401 for fetch, 400 for submitted replacement key
- provider unavailable -> 503
- not connected/batch missing -> 400/404

`run-now` calls the unattended safe policy and returns pending-review counts; it does not bypass review for destructive/ambiguous actions.

`PUT /people-sync/settings` accepts only `{ elvantoIncludeContacts?: boolean, elvantoAlignPeopleType?: boolean, fullReconciliationFrequency?: 'daily'|'weekly'|'monthly', fullReconciliationDay?: number }`. Reject empty bodies and unknown keys. These settings never switch authority; authority uses the preview/apply endpoints exclusively.

- [ ] **Step 6: Mount subrouters before legacy Elvanto routes**

At the top of authenticated/admin `server/routes/integrations.js`:

```js
router.use('/people-sync', createPeopleSyncRouter(defaultDependencies));
router.use('/elvanto', createElvantoRouter(defaultDependencies));
```

Remove or rename duplicate legacy `/elvanto/status`, `/connect`, `/disconnect`, `/people`, `/families`, and `/import` handlers in the same commit so there is exactly one reachable implementation. Preserve legacy gathering/service endpoints until Task 21.

- [ ] **Step 7: Run route, church-isolation, and integration suites**

Run: `cd server && node --test routes/integrations/peopleSync.test.js routes/integrations/elvanto.test.js services/elvanto/legacyCredential.dbintegration.test.js routes/integrations.sync-stats.dbintegration.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/routes/integrations/peopleSync.js server/routes/integrations/peopleSync.test.js server/routes/integrations/elvanto.js server/routes/integrations/elvanto.test.js server/services/elvanto/legacyCredential.js server/services/elvanto/legacyCredential.dbintegration.test.js server/routes/integrations.js
git commit -m "feat(elvanto): add reviewed sync API"
```

### Task 17: Add Client Types, API Methods, and Provider-Neutral Lock Utilities

**Files:**
- Create: `client/src/components/peopleSync/types.ts`
- Create: `client/src/utils/authorityLock.ts`
- Create: `client/src/utils/authorityLock.test.ts`
- Modify: `client/src/utils/pcoLock.ts`
- Modify: `client/src/services/api.ts`

**Interfaces:**
- Produces `SyncProvider`, `AuthorityProvider`, `PeopleSyncBatch<T>`, `PeopleSyncPlan`, `PeopleSyncReview`, `SyncSelections`, `ExternalLinks`, `isAuthorityLocked`, and `authorityLabel`.
- Adds typed `peopleSyncAPI` and Elvanto batch/metadata/review methods.

- [ ] **Step 1: Define shared client contracts**

Create `types.ts` with exact server DTOs:

```ts
export type SyncProvider = 'planning_center' | 'elvanto';
export type AuthorityProvider = SyncProvider | 'none';
export type PeopleType = 'regular' | 'local_visitor' | 'traveller_visitor';
export type ExternalLinks = Partial<Record<SyncProvider, string>>;

export interface PeopleSyncBatch<TFilter = Record<string, unknown>> {
  id: number;
  provider: SyncProvider;
  name: string;
  enabled: boolean;
  filterSchemaVersion: number;
  filterConfig: TFilter;
  defaultPeopleType: PeopleType;
  gatheringTypeId: number | null;
  gatheringAutoRemoveEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleFrequency: 'daily' | 'weekly' | 'monthly';
  scheduleDay: number;
  lastExternalWatermark: string | null;
  lastSyncAt: string | null;
  lastSyncResult: Record<string, number | string> | null;
}

export interface SyncSelections {
  ambiguous: Record<string, number>;
  skipExternalPersonIds: string[];
  visitorChoices: Record<string, 'promote' | 'keep'>;
  acceptArchiveIndividualIds: number[];
  acceptFamilyRenameIds: number[];
}
```

Define each `PeopleSyncPlan` bucket using server property names from Task 6; do not use `any`.

- [ ] **Step 2: Write failing lock utility tests**

```ts
expect(isAuthorityLocked({ planning_center: 'p1', elvanto: 'e1' }, 'elvanto')).toBe(true);
expect(isAuthorityLocked({ planning_center: 'p1' }, 'elvanto')).toBe(false);
expect(isAuthorityLocked({ elvanto: 'e1' }, 'none')).toBe(false);
expect(authorityLabel('planning_center')).toBe('Planning Center');
expect(authorityLabel('elvanto')).toBe('Elvanto');
```

- [ ] **Step 3: Run lock tests and verify failure**

Run: `cd client && npm test -- src/utils/authorityLock.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement lock helpers and compatibility re-export**

```ts
export const PEOPLE_SOURCE_LOCKED = 'PEOPLE_SOURCE_LOCKED';

export function isAuthorityLocked(links: ExternalLinks | undefined, authority: AuthorityProvider): boolean {
  return authority !== 'none' && !!links?.[authority];
}

export function authorityLabel(provider: AuthorityProvider): string {
  return provider === 'planning_center' ? 'Planning Center' : provider === 'elvanto' ? 'Elvanto' : 'None';
}
```

Make `pcoLock.ts` delegate to `isAuthorityLocked({ planning_center: person.planningCenterId }, flag ? 'planning_center' : 'none')` so old imports keep compiling until Task 21.

- [ ] **Step 5: Add typed API methods**

Add:

```ts
export const peopleSyncAPI = {
  getSettings: () => api.get('/integrations/people-sync/settings'),
  previewAuthority: (provider: SyncProvider) => api.post('/integrations/people-sync/authority/preview', { provider }, { timeout: 120000 }),
  applyAuthority: (provider: SyncProvider, reviewToken: string, selections: SyncSelections) =>
    api.post('/integrations/people-sync/authority/apply', { provider, reviewToken, selections }, { timeout: 120000 }),
  disableAuthority: () => api.post('/integrations/people-sync/authority/disable'),
  getRuns: () => api.get('/integrations/people-sync/runs'),
};
```

Replace old Elvanto people/family import methods with metadata, generic batch CRUD, plan, apply, and safe run-now methods. Keep gathering-import methods explicitly labeled `legacy gathering import` until Task 21.

Extend `Individual` with `externalLinks?: ExternalLinks` and `managedBy?: SyncProvider | null`.

- [ ] **Step 6: Run unit tests and TypeScript build**

Run: `cd client && npm test -- src/utils/authorityLock.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/peopleSync/types.ts client/src/utils/authorityLock.ts client/src/utils/authorityLock.test.ts client/src/utils/pcoLock.ts client/src/services/api.ts
git commit -m "feat(sync): add client sync contracts and authority locks"
```

### Task 18: Build a Shared Sync Review Component

**Files:**
- Create: `client/src/components/peopleSync/syncSelections.ts`
- Create: `client/src/components/peopleSync/syncSelections.test.ts`
- Create: `client/src/components/peopleSync/SyncReview.tsx`
- Create: `client/src/components/peopleSync/SyncReview.test.tsx`
- Modify: `client/src/components/planningCenter/PlanningCenterSyncReview.tsx`
- Modify: `client/src/components/planningCenter/syncSelections.ts`
- Modify: `client/src/components/planningCenter/syncSelections.test.ts`

**Interfaces:**
- `SyncReview` consumes `{ provider, review, onRefresh, onApply, applying }` and emits `SyncSelections`.
- PCO review becomes a data-loading wrapper around the shared presentation component.

- [ ] **Step 1: Write failing selection serializer tests**

```ts
expect(buildSyncSelections({
  ambiguousChoices: { ext1: 7, ext2: null },
  skippedExternalIds: new Set(['ext3']),
  visitorChoices: { ext4: 'promote', ext5: null },
  acceptedArchiveIds: new Set([10]),
  acceptedFamilyRenameIds: new Set([20]),
})).toEqual({
  ambiguous: { ext1: 7 },
  skipExternalPersonIds: ['ext3'],
  visitorChoices: { ext4: 'promote' },
  acceptArchiveIndividualIds: [10],
  acceptFamilyRenameIds: [20],
});
```

Sort all arrays/record entries to keep payloads deterministic.

- [ ] **Step 2: Write failing review-component tests**

Using Testing Library, render one item in every destructive and non-destructive bucket. Assert:

- summary counts render;
- destructive sections have warning styling/text;
- ambiguous selection and visitor promote/keep serialize correctly;
- archives and family renames are opt-in;
- clicking Apply calls `onApply` with selections and review token;
- stale-plan error shows `Refresh plan` and does not retry automatically; and
- provider labels are Elvanto/Planning Center, never hard-coded PCO copy.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd client && npm test -- src/components/peopleSync/syncSelections.test.ts src/components/peopleSync/SyncReview.test.tsx`

Expected: FAIL.

- [ ] **Step 4: Implement `SyncReview`**

Render sections in this order: needs decision, destructive changes, links/restores, adds, managed updates, gathering changes, skipped. Use native form controls and existing Tailwind patterns. The apply handler is:

```tsx
const submit = () => onApply(review.reviewToken, buildSyncSelections(state));
```

Require an explicit checkbox before enabling Apply when `archive`, `removeFromGathering`, or accepted family renames are non-empty.

- [ ] **Step 5: Adapt PCO without changing endpoints**

Map the current PCO plan to `PeopleSyncPlan` in a pure `mapLegacyPcoPlan` helper, then render `SyncReview`. Translate generic selections back to the old PCO apply payload until PCO routes adopt the generic response. Preserve manual PCO person search as a provider-specific `renderCandidateSearch` slot.

- [ ] **Step 6: Run shared and existing PCO review tests/build**

Run: `cd client && npm test -- src/components/peopleSync/syncSelections.test.ts src/components/peopleSync/SyncReview.test.tsx src/components/planningCenter/syncSelections.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/peopleSync/syncSelections.ts client/src/components/peopleSync/syncSelections.test.ts client/src/components/peopleSync/SyncReview.tsx client/src/components/peopleSync/SyncReview.test.tsx client/src/components/planningCenter/PlanningCenterSyncReview.tsx client/src/components/planningCenter/syncSelections.ts client/src/components/planningCenter/syncSelections.test.ts
git commit -m "refactor(sync): share plan review UI"
```

### Task 19: Build Elvanto Filters and Batch Editor

**Files:**
- Create: `client/src/components/elvanto/ElvantoFilterEditor.tsx`
- Create: `client/src/components/elvanto/ElvantoFilterEditor.test.tsx`
- Create: `client/src/components/elvanto/ElvantoBatchEditor.tsx`
- Create: `client/src/components/elvanto/ElvantoBatchEditor.test.tsx`
- Modify: `client/src/components/peopleSync/types.ts`

**Interfaces:**
- Produces controlled `ElvantoFilterEditor({ metadata, value, onChange })` and `ElvantoBatchEditor({ batch, metadata, gatherings, onSaved, onCancel })`.
- Uses Elvanto filter schema version 1 from Task 13.

- [ ] **Step 1: Add exact Elvanto client types**

```ts
export interface ElvantoFilterConfig {
  statuses: Array<'active' | 'contact' | 'archived' | 'deceased'>;
  categoryIds: string[];
  groups: { ids: string[]; operator: 'any' | 'all' };
  demographics: { values: string[]; operator: 'any' | 'all' };
  departments: { values: string[]; operator: 'any' | 'all' };
  serviceTypes: { ids: string[]; operator: 'any' | 'all' };
  locations: { ids: string[]; operator: 'any' | 'all' };
  customFields: Array<{ fieldId: string; values: string[]; operator: 'any' | 'all' }>;
}
```

Add a typed `ElvantoMetadata` matching Task 13.

- [ ] **Step 2: Write failing filter-editor tests**

Assert metadata sections appear only when options exist, Active and Contact are selected by default, group any/all changes the controlled value, category/group selection uses stable IDs, removed metadata IDs display a warning, and custom-field rules retain field/value IDs.

- [ ] **Step 3: Write failing batch-editor tests**

Mock API/gathering calls and assert create/edit payloads, empty name validation, schedule day validation, gathering creation, auto-remove confirmation, metadata refresh, and qualifying preview split by Active/Contact/Archived/Deceased.

- [ ] **Step 4: Run tests and verify failure**

Run: `cd client && npm test -- src/components/elvanto/ElvantoFilterEditor.test.tsx src/components/elvanto/ElvantoBatchEditor.test.tsx`

Expected: FAIL.

- [ ] **Step 5: Implement metadata-driven filters**

Use reusable controlled checkbox/select helpers inside the file. For each multi-value dimension, show a segmented `Match any` / `Match all` control only when two or more values are selected. Different dimensions display connecting `AND` labels so filter semantics are visible.

- [ ] **Step 6: Implement batch editor**

Follow `PlanningCenterBatchEditor` schedule/gathering patterns, but keep provider filter logic in `ElvantoFilterEditor`. Default payload:

```ts
{
  provider: 'elvanto', name: 'Elvanto people', enabled: true,
  filterSchemaVersion: 1,
  filterConfig: defaultElvantoFilter(),
  defaultPeopleType: 'regular', gatheringTypeId: null,
  gatheringAutoRemoveEnabled: false, scheduleEnabled: false,
  scheduleFrequency: 'weekly', scheduleDay: 1,
}
```

- [ ] **Step 7: Run tests/build**

Run: `cd client && npm test -- src/components/elvanto/ElvantoFilterEditor.test.tsx src/components/elvanto/ElvantoBatchEditor.test.tsx && npm run build`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/elvanto/ElvantoFilterEditor.tsx client/src/components/elvanto/ElvantoFilterEditor.test.tsx client/src/components/elvanto/ElvantoBatchEditor.tsx client/src/components/elvanto/ElvantoBatchEditor.test.tsx client/src/components/peopleSync/types.ts
git commit -m "feat(elvanto): add batch and filter editor"
```

### Task 20: Replace the Elvanto Panel and Add Source-of-Truth Controls

**Files:**
- Create: `client/src/components/peopleSync/PeopleSourceControl.tsx`
- Create: `client/src/components/peopleSync/PeopleSourceControl.test.tsx`
- Create: `client/src/components/elvanto/ElvantoGatheringImport.tsx`
- Rewrite: `client/src/components/integrations/ElvantoIntegrationPanel.tsx`
- Create: `client/src/components/integrations/ElvantoIntegrationPanel.test.tsx`
- Modify: `client/src/components/integrations/types.ts`
- Modify: `client/src/components/integrations/IntegrationsTab.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/pages/PeoplePage.tsx`

**Interfaces:**
- Elvanto panel manages church-level key, metadata, batches, reviews, runs, and preserved gathering import.
- `PeopleSourceControl` is shared by both provider panels and commits authority only through reviewed apply.
- People page consumes `authorityProvider` and `externalLinks`.

- [ ] **Step 1: Write failing source-control tests**

Mock both providers connected. Assert:

- radio options None/Planning Center/Elvanto;
- selecting a provider calls preview, not direct settings update;
- preview coverage/locked/add/update/archive counts render;
- authority changes only after review apply succeeds;
- cancellation leaves active authority unchanged;
- selecting None requires confirmation; and
- disconnected provider is disabled with explanatory copy.

- [ ] **Step 2: Write failing Elvanto panel tests**

Assert:

- API key input is password-type and cleared after successful connect;
- saved key is never rendered;
- invalid replacement retains `connected` state and explains the failure;
- metadata/batches load only while connected;
- Review & sync renders `SyncReview`;
- Run now surfaces pending-review counts;
- disconnect warns when Elvanto is authoritative; and
- recent runs contain sanitized summaries only;
- Include Contacts defaults on and updates `elvantoIncludeContacts` explicitly;
- Keep people type aligned defaults on and updates `elvantoAlignPeopleType` explicitly; and
- changing either option explains that the next review may propose type/lifecycle changes.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd client && npm test -- src/components/peopleSync/PeopleSourceControl.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx`

Expected: FAIL.

- [ ] **Step 4: Implement `PeopleSourceControl`**

Use a local state machine `idle | previewing | reviewing | applying | disabling | error`. On provider selection:

```tsx
const preview = await peopleSyncAPI.previewAuthority(nextProvider);
setPendingReview(preview.data);
```

Render `SyncReview`; its successful apply refreshes integration settings/status before closing. Never call `settingsAPI.updateIntegrationSettings({ planningCenterSyncIndicator: true })`.

- [ ] **Step 5: Rewrite the Elvanto panel as small sections**

Compose `ConnectionSection`, `PeopleSourceControl`, batch list/editor, `SyncReview`, recent runs, and `ElvantoGatheringImport`. Extract the existing gathering/service-type import UI without changing its API contract. Delete people/family checkbox import state and all Elvanto localStorage cleanup logic.

Render the two church-level Elvanto toggles above the batches. Save them through `PUT /people-sync/settings`; do not copy them into individual batch filter JSON. Contacts remain selected in a new batch's default status filter, but the church-level include-contacts setting is the final gate.

- [ ] **Step 6: Make integration cards authority-aware**

`IntegrationsTab` fetches people-sync settings once and passes connection states to `PeopleSourceControl`. Card descriptions become:

- Elvanto: “Import people and families once, or keep LMPG aligned with Elvanto.”
- PCO: “Import people and check-ins, or use Planning Center as your people source of truth.”

Show an `Authoritative people source` badge on the active card.

- [ ] **Step 7: Convert People page locks and badges**

Backend people responses now include `externalLinks` and settings include `authorityProvider`. Replace `planningCenterSyncIndicator` checks with:

```tsx
const locked = isAuthorityLocked(person.externalLinks, authorityProvider);
const managedLabel = locked ? authorityLabel(authorityProvider) : null;
```

Display PCO or Elvanto badge. Hide/disable edit, archive, restore, delete, deduplicate, and merge actions under the same conditions enforced by the backend. Preserve background-check UI as PCO-specific and independent.

- [ ] **Step 8: Run UI tests/build**

Run: `cd client && npm test -- src/components/peopleSync/PeopleSourceControl.test.tsx src/components/integrations/ElvantoIntegrationPanel.test.tsx src/utils/authorityLock.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/peopleSync/PeopleSourceControl.tsx client/src/components/peopleSync/PeopleSourceControl.test.tsx client/src/components/elvanto/ElvantoGatheringImport.tsx client/src/components/integrations/ElvantoIntegrationPanel.tsx client/src/components/integrations/ElvantoIntegrationPanel.test.tsx client/src/components/integrations/types.ts client/src/components/integrations/IntegrationsTab.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/pages/PeoplePage.tsx
git commit -m "feat(elvanto): add sync panel and authority controls"
```

### Task 21: Add Elvanto Onboarding and Remove Unsafe Legacy Import Paths

**Files:**
- Create: `client/src/components/elvanto/ElvantoOnboarding.tsx`
- Create: `client/src/components/elvanto/ElvantoOnboarding.test.tsx`
- Modify: `client/src/pages/OnboardingPage.tsx`
- Create: `client/src/pages/OnboardingPage.integrations.test.tsx`
- Modify: `server/routes/integrations.js`
- Modify: `server/routes/settings.js`
- Create: `server/routes/settings.integrations.dbintegration.test.js`
- Modify: `client/src/services/api.ts`
- Delete: `client/src/utils/pcoLock.ts`

**Interfaces:**
- Onboarding offers Planning Center, Elvanto, or Start fresh.
- Elvanto onboarding uses the same connect, batch, review, and optional authority endpoints as Settings.
- No client or server path remains that imports selected Elvanto people without matching/review.

- [ ] **Step 1: Write failing Elvanto onboarding tests**

Assert the sequence:

1. enter/validate API key;
2. load metadata;
3. configure and save first batch;
4. review and apply import;
5. optionally preview/apply Elvanto authority;
6. continue to gatherings.

Also assert invalid key retry, provider unavailable retry, skip before connection, skip after saved batch, and no API key in component state after successful connection.

- [ ] **Step 2: Write failing onboarding choice tests**

Render `OnboardingPage` at `choose-path` and assert three visible choices. Planning Center retains OAuth flow; Elvanto enters `elvanto-connect`; Start fresh completes unchanged. Add step union members:

```ts
type Step = 'form' | 'code' | 'choose-path' |
  'pco-people' | 'pco-review' | 'pco-gatherings' |
  'elvanto-connect' | 'elvanto-batch' | 'elvanto-review' | 'elvanto-authority';
```

- [ ] **Step 3: Run tests and verify failure**

Run: `cd client && npm test -- src/components/elvanto/ElvantoOnboarding.test.tsx src/pages/OnboardingPage.integrations.test.tsx`

Expected: FAIL.

- [ ] **Step 4: Implement the onboarding component**

Reuse `ElvantoBatchEditor` and `SyncReview`; do not duplicate filter/review logic. After successful import, present:

```text
Keep LMPG aligned with Elvanto?
If enabled, linked names, child status, family membership and active status are managed in Elvanto.
[Use Elvanto as source of truth] [Not now]
```

The first button starts authority preview/review; it never flips authority directly.

- [ ] **Step 5: Integrate the choice flow**

Replace “Do you use Planning Center?” with “Bring your people with you” and three cards/buttons. Elvanto completion proceeds directly to gatherings; it has no attendance-history step.

- [ ] **Step 6: Delete unsafe legacy people-import API surface**

From `server/routes/integrations.js` remove any remaining `/elvanto/people`, `/elvanto/families`, `/elvanto/import`, and `/elvanto/debug-dump` routes. From `client/src/services/api.ts` remove their methods. Confirm `rg -n "debugDumpElvanto|importFromElvanto|getElvantoPeople|getElvantoFamilies" server client/src` returns no matches.

Keep `/elvanto/groups`, `/services`, `/check-gathering-duplicates`, and `/import-gatherings` only if used by `ElvantoGatheringImport`; ensure they use the church-level encrypted connection, not user preferences.

- [ ] **Step 7: Close the temporary legacy authority-toggle bridge**

Remove all client writes to `planningCenterSyncIndicator`. Change `PUT /api/settings/integrations` so `planningCenterSyncIndicator: true` returns `409 AUTHORITY_REVIEW_REQUIRED`; `false` may still disable PCO authority after explicit confirmation. Add a route test proving activation must use `/people-sync/authority/preview` and `/apply`.

- [ ] **Step 8: Remove PCO-only client lock compatibility**

Replace remaining `pcoLock` imports with `authorityLock`, then delete `client/src/utils/pcoLock.ts`. Confirm `rg -n "isPcoLocked|countPcoLocked|PCO_MODE_LOCKED" client/src` returns no matches.

- [ ] **Step 9: Run onboarding/full client tests and build**

Run: `cd client && npm test && npm run build`

Expected: PASS.

- [ ] **Step 10: Run focused server route tests**

Run: `cd server && node --test routes/integrations/elvanto.test.js services/elvanto/*.test.js`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add client/src/components/elvanto/ElvantoOnboarding.tsx client/src/components/elvanto/ElvantoOnboarding.test.tsx client/src/pages/OnboardingPage.tsx client/src/pages/OnboardingPage.integrations.test.tsx server/routes/integrations.js server/routes/settings.js server/routes/settings.integrations.dbintegration.test.js client/src/services/api.ts client/src/utils/pcoLock.ts
git commit -m "feat(elvanto): add reviewed onboarding import"
```

### Task 22: Security, Migration, Regression, and Operator Verification

**Files:**
- Modify: `README.md`
- Modify: `docker-compose.dev.yml`
- Modify: `docker-compose.yml`
- Modify: `server/config/database.test.js`
- Modify: tests identified by the commands below only when an assertion legitimately changes to the generic contract

**Interfaces:**
- Documents `INTEGRATION_CREDENTIALS_KEY` and rollout/rollback order.
- Produces the release verification record in the final implementation handoff; no new runtime interface.

- [ ] **Step 1: Document credential-key generation and rollout**

Add to `README.md`:

```bash
openssl rand -base64 32
```

Document that the output becomes `INTEGRATION_CREDENTIALS_KEY`, must remain stable across restarts/replicas, must be backed up separately, and must be configured before migrating existing credentials. Add variable pass-through to both compose server services without committing a real value:

```yaml
- INTEGRATION_CREDENTIALS_KEY=${INTEGRATION_CREDENTIALS_KEY}
```

- [ ] **Step 2: Add final migration/restart tests**

Extend `database.test.js` to initialize the same legacy church database twice and assert no duplicate links/batches/settings, valid generic foreign keys, and preserved legacy PCO values. Add a missing-encryption-key production test asserting Elvanto/PCO connection save fails closed without disrupting existing non-integration startup.

- [ ] **Step 3: Run whitespace and secret scans**

Run:

```bash
git diff --check
rg -n "apiKeyPrefix|authHeaderPrefix|debug-dump|credential_ciphertext.*res\.json|planning_center_tokens.*res\.json" server client/src
```

Expected: `git diff --check` is clean. The secret scan returns no unsafe logging/response/debug route; schema/repository SQL references are acceptable only after manual inspection.

- [ ] **Step 4: Run all server tests serially**

The DB test harness is process-global, so avoid parallel test processes:

```bash
cd server
node --test --test-concurrency=1 \
  config/*.test.js \
  routes/*.test.js \
  routes/*.dbintegration.test.js \
  services/*.test.js \
  services/*.dbintegration.test.js \
  services/planningCenter/*.test.js \
  services/peopleSync/*.test.js \
  services/elvanto/*.test.js \
  test-helpers/*.test.js \
  utils/*.test.js \
  utils/*.dbintegration.test.js
```

Expected: PASS with zero failures.

- [ ] **Step 5: Run full client tests and production build**

Run:

```bash
cd client
npm test
npm run build
```

Expected: PASS; Vite build and service-worker generation complete.

- [ ] **Step 6: Perform manual Docker smoke test**

Run:

```bash
docker-compose -f docker-compose.dev.yml build server client
docker-compose -f docker-compose.dev.yml up -d server client
docker-compose -f docker-compose.dev.yml logs --tail=200 server client
```

Verify manually with a disposable/test church and Elvanto key:

1. connect Elvanto and confirm the key is never shown again;
2. create overlapping group batches using any/all;
3. review/import Active and Contact people;
4. re-review and confirm no duplicate people/families;
5. enable Elvanto authority through reviewed reconciliation;
6. confirm linked Elvanto people are locked and PCO-only links are not;
7. confirm visitors remain creatable;
8. change an Elvanto person Active -> Contact -> Archived -> Active and verify type/archive/reactivate transitions;
9. remove a group member and confirm only batch-owned gathering membership is removed;
10. disconnect Elvanto and confirm authority becomes None while people/links remain;
11. reconnect and confirm durable links prevent duplicates; and
12. run existing PCO review, scheduled sync, background-check, and check-in flows.

- [ ] **Step 7: Stop the smoke-test containers**

Run: `docker-compose -f docker-compose.dev.yml down`

Expected: development services stop cleanly; named data volumes are preserved unless the tester explicitly chose a disposable volume.

- [ ] **Step 8: Commit documentation and verification-only changes**

```bash
git add README.md docker-compose.dev.yml docker-compose.yml server/config/database.test.js
git commit -m "docs(sync): document secure integration rollout"
```

## Requirement Coverage Map

- **Both connected, one authority:** Tasks 1, 4, 10, 16, 17, and 20.
- **API-key Elvanto connection with secure church ownership:** Tasks 2, 11, 14, 16, and 22.
- **One-time onboarding import and ongoing source-of-truth mode:** Tasks 6-7, 15-16, and 18-21.
- **Matching and review on every import path:** Tasks 5-7, 9, 15-16, 18, and 21.
- **Strict provider-aware locks with local visitors still available:** Tasks 4, 6-7, 17, 20, and 22.
- **Contacts included by default as local visitors, with optional type alignment:** Tasks 1, 6, 12-13, 16, and 19-20.
- **Elvanto status/category/group/demographic/department/service/location/custom-field filters:** Tasks 12-14 and 19.
- **Safe full/incremental reconciliation, two-full-run disappearance rule, and roster provenance:** Tasks 1, 3, 6-7, 14-16, and 22.
- **PCO compatibility and regression protection:** Tasks 4, 8-10, 17-18, 20-22.

## Completion Gate

Implementation is complete only when:

- all 22 task commits exist in order;
- the full server and client commands in Task 22 pass from a clean checkout;
- PCO connection, review/apply, scheduling, check-ins, background checks, and strict locks still behave as before;
- Elvanto onboarding and Settings imports use the same matching/review pipeline;
- both providers can remain connected while exactly one is authoritative;
- no API key/token or raw provider payload appears in logs, exports, admin output, audit data, or HTTP responses; and
- the manual smoke test records no duplicate people, cross-church access, unsafe archive, or roster provenance loss.
