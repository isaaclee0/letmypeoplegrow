const https = require('https');
const Database = require('../config/database');
const logger = require('../config/logger');
const { projectPerson } = require('./planningCenter/projection');
const batchRepository = require('./peopleSync/batchRepository');

// ─── PCO people cache ─────────────────────────────────────────────────────────
// Fetching every person from Planning Center is the slow part of a sync — several
// seconds of paginated HTTPS. That data only changes when PCO itself changes, so we
// cache the projected people per church for a short TTL. Plan computation and the
// membership summary both reuse it. Callers pass { force: true } to bypass the cache
// (the "Refresh from Planning Center" button and the scheduled daily sync).
//
// We deliberately do NOT invalidate after an apply: applying mutates local LMPG data,
// not PCO, so recomputing the plan against the same snapshot is both cheaper and more
// correct (you diff against exactly what was reviewed). Local state is always read
// fresh from the DB in computePlanForChurch.
const PCO_PEOPLE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const pcoPeopleCache = new Map(); // churchId -> { people, fetchedAt }

async function getCachedPcoPeople(churchId, accessToken, { force = false } = {}) {
  const cached = pcoPeopleCache.get(churchId);
  if (!force && cached && (Date.now() - cached.fetchedAt) < PCO_PEOPLE_TTL_MS) {
    return cached;
  }
  const { people, householdPrimaryContacts } = await fetchAllPcoPeople(accessToken);
  const entry = { people, householdPrimaryContacts, fetchedAt: Date.now() };
  pcoPeopleCache.set(churchId, entry);
  return entry;
}

function invalidatePcoPeopleCache(churchId) {
  if (churchId) pcoPeopleCache.delete(churchId);
  else pcoPeopleCache.clear();
}

// ─── HTTP helper ────────────────────────────────────────────────────────────

function httpsGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = new URLSearchParams(body).toString();
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Token helpers ───────────────────────────────────────────────────────────
//
// Task 10: token persistence and refresh now live on the encrypted,
// church-scoped integration_connections table (see peopleSync/connectionStore.js),
// via peopleSync/pcoCredentialMigration.js — not the legacy per-admin
// user_preferences row this module used before. That module is also the
// single implementation of PCO OAuth token refresh (with its own per-church
// mutex); this file's job is only to supply the actual HTTPS call it injects,
// and to keep the same snake_case token shape (`access_token`/`refresh_token`/
// `expires_at`) every existing caller in this file and in routes/integrations.js
// already expects, so nothing downstream needs to change.
//
// pcoCredentialMigration.getOrMigrateCredentials transparently migrates any
// pre-existing legacy user_preferences tokens the first time they're read,
// and throws a PcoReconnectRequiredError (code PCO_RECONNECT_REQUIRED) if two
// different admins' legacy tokens disagree — this module does not catch that
// error, so callers that want to handle it specially (e.g. surfacing a
// "reconnect required" status) can check `err.code`.
const pcoCredentialMigration = require('./peopleSync/pcoCredentialMigration');
const { PCO_RECONNECT_REQUIRED } = pcoCredentialMigration;

function toLegacyTokenShape(credentials) {
  if (!credentials) return null;
  return {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expires_at: credentials.expiresAt,
  };
}

function toStoredCredentials(tokens) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at,
  };
}

// Church-wide PCO connection — integration_connections has exactly one row
// per church+provider, so there is no "which user's tokens" ambiguity any
// more. `userId` is returned as null and exists only so callers destructuring
// `{ userId, tokens }` (unchanged since before this task) keep working.
async function getTokensForChurch(churchId) {
  const credentials = await pcoCredentialMigration.getOrMigrateCredentials(churchId);
  if (!credentials) return null;
  return { userId: null, tokens: toLegacyTokenShape(credentials) };
}

// Retained for any caller still asking for "a specific user's" PCO tokens;
// since connections are church-scoped, this simply ignores userId and
// returns the same church connection getTokensForChurch does.
async function getPlanningCenterTokens(userId, churchId) {
  const owned = await getTokensForChurch(churchId);
  return owned ? owned.tokens : null;
}

// Tolerate the British "CENTRE" spelling so a .env typo can't break token refresh.
function pcoEnv(suffix) {
  return process.env[`PLANNING_CENTER_${suffix}`] || process.env[`PLANNING_CENTRE_${suffix}`];
}

// The one place this codebase calls PCO's token-refresh endpoint. Injected
// into pcoCredentialMigration's refresh manager (which owns the per-church
// mutex and the encrypted persistence) rather than that module reaching back
// into HTTPS itself — keeps all HTTP/PCO-wire-format concerns in this file,
// and avoids a circular require between the two modules.
async function requestPcoTokenRefresh(refreshTokenValue) {
  const response = await httpsPost('https://api.planningcenteronline.com/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: pcoEnv('CLIENT_ID'),
    client_secret: pcoEnv('CLIENT_SECRET'),
  });
  if (response.status !== 200 || !response.data || !response.data.access_token) return null;
  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token || null,
    expiresAt: Date.now() + ((response.data.expires_in || 7200) * 1000),
  };
}

// Refreshes `tokens` if expiring soon (via pcoCredentialMigration's per-church
// single-flight manager) and returns the (possibly unchanged) result in the
// same snake_case shape callers already use. `userId` is accepted only for
// call-site compatibility with every existing caller (makePlanningCenterRequest,
// fetchAllCheckinsUncached, getAccessTokenForChurch below) — PCO connections
// are church-scoped, so it is otherwise unused.
async function ensureValidPlanningCenterTokens(userId, churchId, tokens) {
  if (!tokens) return null;
  const fresh = await pcoCredentialMigration.ensureFreshCredentials(
    churchId, toStoredCredentials(tokens), requestPcoTokenRefresh
  );
  return toLegacyTokenShape(fresh);
}

async function getValidAccessToken(churchId, userId, tokens) {
  const fresh = await ensureValidPlanningCenterTokens(userId, churchId, tokens);
  return fresh ? fresh.access_token : null;
}

// Validate that an access token actually works against PCO, by hitting the
// (cheap, single-record) "me" endpoint. This is additive — routes/integrations.js's
// existing '/planning-center/status' route has its own inline connection check via
// makePlanningCenterRequest() there, and is left untouched. This export exists so the
// provider-neutral PCO adapter (peopleSync/pcoAdapter.js) has a dependency-injectable
// token validator built on the same httpsGet() helper as everything else in this file,
// without duplicating the HTTPS plumbing or reaching into routes/integrations.js.
async function validatePlanningCenterToken(accessToken) {
  if (!accessToken) return { connected: false, accountName: null };
  const response = await httpsGet('https://api.planningcenteronline.com/people/v2/me', accessToken);
  if (response.status !== 200) return { connected: false, accountName: null, status: response.status };
  const accountName = (response.data && response.data.data && response.data.data.attributes && response.data.data.attributes.name) || null;
  return { connected: true, accountName };
}

// ─── Sync pipeline helpers ───────────────────────────────────────────────────

// Token accessor for endpoints/cron (wraps existing helpers).
async function getAccessTokenForChurch(churchId) {
  const tokenData = await getTokensForChurch(churchId);
  if (!tokenData) return null;
  return getValidAccessToken(churchId, tokenData.userId, tokenData.tokens);
}

// Memory-efficient: project each page, discard raw JSON + included resources.
// Also collects each PCO Household's designated head-of-household
// (Household.attributes.primary_contact_id) into a Map<householdId, pcoPersonId>,
// used to propose LMPG family-name updates.
async function fetchAllPcoPeople(accessToken) {
  const people = [];
  const householdPrimaryContacts = new Map();
  let next = 'https://api.planningcenteronline.com/people/v2/people?per_page=100&include=households,field_data';
  let pages = 0;
  while (next) {
    if (++pages > 1000) {
      throw new Error('PCO people fetch exceeded 1000 pages — aborting to avoid an unbounded loop');
    }
    const resp = await httpsGet(next, accessToken);
    if (resp.status !== 200) {
      throw new Error(`PCO people fetch failed (status ${resp.status})`);
    }
    const data = resp.data;
    const fieldDataById = new Map();
    for (const inc of data.included || []) {
      if (inc.type === 'FieldDatum') fieldDataById.set(inc.id, inc);
      else if (inc.type === 'Household' && inc.attributes && inc.attributes.primary_contact_id) {
        householdPrimaryContacts.set(inc.id, inc.attributes.primary_contact_id);
      }
    }
    for (const raw of data.data || []) people.push(projectPerson(raw, fieldDataById));
    next = (data.links && data.links.next) || null;
  }
  return { people, householdPrimaryContacts };
}

// ─── PCO sync batches ─────────────────────────────────────────────────────────
//
// Task 9: people_sync_batches (via batchRepository) is now the canonical store
// for PCO batches. planning_center_sync_batches (the legacy table) is dual-
// written during the compatibility window — every generic PCO batch row keeps
// a matching legacy row, whose id is recorded on the generic row as
// legacy_provider_batch_id (see backfillProviderNeutralSync in
// config/database.js, which already produces exactly this shape for
// pre-existing batches). This lets gathering_lists keep populating its legacy
// added_by_pco_batch_id FK column (still referencing planning_center_sync_batches)
// alongside the new added_by_sync_batch_id column, and lets the legacy table's
// last_sync_at/last_sync_result stay populated for anything not yet migrated
// off it.
//
// The DTO shape returned to callers (routes/integrations.js, and from there
// the PCO batch UI) is UNCHANGED from before this refactor — same field names,
// same types — plus one additive field, legacyProviderBatchId, used internally
// by routes/integrations.js to populate added_by_pco_batch_id when applying.

function safeJsonParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

// Generic batch -> the source-era PCO DTO. Provider-owned source identity is
// returned explicitly; legacy client-side filter fields are intentionally not
// flattened or accepted by the CRUD API.
function toLegacyPcoBatchDto(batch) {
  return {
    id: batch.id,
    provider: batch.provider || 'planning_center',
    name: batch.name,
    enabled: batch.enabled !== false,
    source: batch.source || null,
    sourceRevision: batch.sourceRevision,
    draftSource: batch.draftSource || null,
    draftSourceBaseRevision: batch.draftSourceBaseRevision ?? null,
    draftSourceUpdatedAt: batch.draftSourceUpdatedAt ?? null,
    needsSourceReview: Boolean(batch.needsSourceReview),
    initialSourceReviewPending: Boolean(batch.initialSourceReviewPending),
    sourceStatus: batch.sourceStatus || 'unknown',
    sourceStatusCheckedAt: batch.sourceStatusCheckedAt || null,
    sourceStatusErrorCode: batch.sourceStatusErrorCode || null,
    defaultPeopleType: batch.defaultPeopleType || 'regular',
    gatheringTypeId: batch.gatheringTypeId ?? null,
    gatheringAutoRemoveEnabled: !!batch.gatheringAutoRemoveEnabled,
    scheduleEnabled: !!batch.scheduleEnabled,
    scheduleFrequency: batch.scheduleFrequency || 'weekly',
    scheduleDay: typeof batch.scheduleDay === 'number' ? batch.scheduleDay : 1,
    lastSyncAt: batch.lastSyncAt || null,
    lastSyncResult: safeJsonParse(batch.lastSyncResult, null),
    legacyProviderBatchId: batch.legacyProviderBatchId ?? null,
  };
}

async function listBatches(churchId) {
  const batches = await batchRepository.listBatches(churchId, 'planning_center');
  return batches.map(toLegacyPcoBatchDto);
}

async function getBatch(churchId, batchId) {
  const batch = await batchRepository.getBatch(churchId, 'planning_center', batchId);
  return batch ? toLegacyPcoBatchDto(batch) : null;
}

// Create a PCO source draft in the canonical generic batch table. The source
// is resolved by the route before it reaches this service; no client-provided
// display name or legacy filter semantics are persisted here.
async function createBatch(churchId, input) {
  const generic = await batchRepository.createBatch({
    churchId,
    provider: 'planning_center',
    name: input.name,
    enabled: true,
    defaultPeopleType: input.defaultPeopleType,
    gatheringTypeId: input.gatheringTypeId || null,
    gatheringAutoRemoveEnabled: !!input.gatheringAutoRemoveEnabled,
    scheduleEnabled: !!input.scheduleEnabled,
    scheduleFrequency: input.scheduleFrequency,
    scheduleDay: input.scheduleDay,
    initialDraftSource: input.initialDraftSource,
  });
  return getBatch(churchId, generic.id);
}

// Update an existing PCO sync batch (batchId is the canonical people_sync_batches
// id, as returned by listBatches/getBatch/createBatch). Dual-writes the legacy
// row when one is linked (always true for a batch created during/after Task 9,
// and for anything backfillProviderNeutralSync has already backfilled).
async function updateBatch(churchId, batchId, input) {
  const current = await batchRepository.getBatch(churchId, 'planning_center', batchId);
  if (!current) return null;
  const genericUpdate = {
    churchId,
    provider: 'planning_center',
    batchId,
    name: input.name,
    defaultPeopleType: input.defaultPeopleType,
    gatheringTypeId: input.gatheringTypeId || null,
    gatheringAutoRemoveEnabled: !!input.gatheringAutoRemoveEnabled,
    scheduleEnabled: !!input.scheduleEnabled,
    scheduleFrequency: input.scheduleFrequency,
    scheduleDay: input.scheduleDay,
  };
  await batchRepository.updateBatch(genericUpdate);
  return getBatch(churchId, batchId);
}

// Delete a PCO sync batch (both the generic row and its dual-written legacy
// row, when one exists). Neither row's FK from gathering_lists is RESTRICT —
// both added_by_sync_batch_id and added_by_pco_batch_id are ON DELETE SET
// NULL, so existing roster rows this batch created are left in place, just
// un-owned — same "does not unlink or archive anyone" behavior as before.
async function deleteBatch(churchId, batchId) {
  const current = await batchRepository.getBatch(churchId, 'planning_center', batchId);
  if (!current) return false;
  await batchRepository.deleteBatch(churchId, 'planning_center', batchId);
  return true;
}

// Persist a batch's sync summary to both the canonical generic row and (while
// legacy_provider_batch_id is present) the legacy table — same dual-write
// posture as createBatch/updateBatch. Shared by the interactive apply route
// (routes/integrations.js) and runBatchSync (below) so the two never drift.
// runBatchSync itself is no longer the unattended scheduled path as of
// Task 15 — see the header note above start()/stop()/runNow() — it is kept
// here, and still exported, purely for any caller outside the cron path.
async function recordBatchSyncResult(churchId, batch, summary) {
  const summaryJson = JSON.stringify(summary);
  if (batch.legacyProviderBatchId) {
    await Database.query(
      `UPDATE planning_center_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
      [summaryJson, batch.legacyProviderBatchId, churchId]
    );
  }
  await Database.query(
    `UPDATE people_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ? AND provider = 'planning_center'`,
    [summaryJson, batch.id, churchId]
  );
}

// ─── Scheduling ──────────────────────────────────────────────────────────────
//
// Task 10: the actual scheduler (cron wiring, per-church/per-batch iteration,
// authority gating, review notification, audit trail) now lives in
// peopleSync/scheduler.js — provider-neutral, and the only cron job that gets
// started (see server/index.js). start/stop/runNow/isDueToday are kept here,
// delegating, purely for compatibility with existing callers of this module.
// Scheduler execution delegates to orchestrator.runUnattended, which reads
// each batch's provider-owned source snapshot.
const scheduler = require('./peopleSync/scheduler');

const isDueToday = scheduler.isDueToday;
function start() { return scheduler.start(); }
function stop() { return scheduler.stop(); }
function runNow() { return scheduler.runNow(); }

module.exports = {
  start, stop, runNow, isDueToday,
  getAccessTokenForChurch, fetchAllPcoPeople,
  getCachedPcoPeople, invalidatePcoPeopleCache, httpsGet,
  listBatches, getBatch, createBatch, updateBatch, deleteBatch,
  recordBatchSyncResult, toLegacyPcoBatchDto,
  getPlanningCenterTokens, ensureValidPlanningCenterTokens,
  getTokensForChurch, validatePlanningCenterToken,
  PCO_RECONNECT_REQUIRED,
};
