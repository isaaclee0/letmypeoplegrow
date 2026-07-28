const https = require('https');
const Database = require('../config/database');
const logger = require('../config/logger');
const { projectPerson } = require('./planningCenter/projection');
const { computePlan } = require('./planningCenter/diffEngine');
const { applyPlan } = require('./planningCenter/apply');
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

// Read-only cache probe for filter-metadata construction. Unlike
// getCachedPcoPeople this must never fetch or refresh: preview and metadata
// requests are allowed to reuse a warm full roster, but only an explicit
// refresh/reconciliation may make a provider call.
function peekCachedPcoPeople(churchId) {
  const cached = pcoPeopleCache.get(churchId);
  if (!cached || !Array.isArray(cached.people) || (Date.now() - cached.fetchedAt) >= PCO_PEOPLE_TTL_MS) return null;
  return cached;
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

// Load the minimal LMPG state for the current church context.
// Includes archived (is_active = 0) rows so the diff engine can detect "restore"
// candidates (previously archived individuals whose name now matches a PCO person).
async function loadChurchState(churchId) {
  const individuals = await Database.query(
    `SELECT id, first_name AS firstName, last_name AS lastName, is_child AS isChild,
            family_id AS familyId, is_active AS isActive, planning_center_id AS planningCenterId,
            people_type AS peopleType, pco_link_declined AS pcoLinkDeclined
       FROM individuals WHERE church_id = ?`,
    [churchId]
  );
  const families = await Database.query(
    `SELECT id, family_name AS familyName, planning_center_id AS planningCenterId FROM families WHERE church_id = ?`,
    [churchId]
  );
  for (const i of individuals) { i.isChild = !!i.isChild; i.isActive = !!i.isActive; }
  return { individuals, families };
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

// filterConfig for a saved batch. Accepts either a generic batch object
// (people_sync_batches shape, via batchRepository, with `.filterConfig`
// already parsed) or the legacy-shaped object every existing caller in this
// file and in routes/integrations.js has always passed (membershipFilterEnabled
// etc. as direct fields) — this must keep resolving the legacy shape exactly
// as it did before Task 9.
function batchFilterConfig(batch) {
  return batch.filterConfig || {
    membershipFilterEnabled: batch.membershipFilterEnabled,
    membershipAllowlist: batch.membershipAllowlist,
    fieldFilterEnabled: batch.fieldFilterEnabled,
    fieldFilters: batch.fieldFilters,
  };
}

// Generic batch (batchRepository shape) -> the legacy PCO batch DTO shape
// /planning-center/sync-batches has always returned.
function toLegacyPcoBatchDto(batch) {
  const filterConfig = batchFilterConfig(batch);
  return {
    id: batch.id,
    name: batch.name,
    membershipFilterEnabled: !!filterConfig.membershipFilterEnabled,
    membershipAllowlist: filterConfig.membershipAllowlist || [],
    fieldFilterEnabled: !!filterConfig.fieldFilterEnabled,
    fieldFilters: filterConfig.fieldFilters || [],
    defaultPeopleType: batch.defaultPeopleType || 'regular',
    gatheringTypeId: batch.gatheringTypeId ?? null,
    gatheringAutoRemoveEnabled: !!batch.gatheringAutoRemoveEnabled,
    scheduleEnabled: !!batch.scheduleEnabled,
    scheduleFrequency: batch.scheduleFrequency || 'weekly',
    scheduleDay: typeof batch.scheduleDay === 'number' ? batch.scheduleDay : 1,
    lastSyncAt: batch.lastSyncAt || null,
    lastSyncResult: safeJsonParse(batch.lastSyncResult, null),
    // Additive (not part of the pre-Task-9 contract): the legacy
    // planning_center_sync_batches id this generic batch is dual-written to,
    // if any. routes/integrations.js reads this to keep tagging
    // gathering_lists.added_by_pco_batch_id alongside the now-canonical
    // added_by_sync_batch_id. Existing clients simply ignore fields they don't
    // recognize, so this does not change the response shape they depend on.
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

// Legacy-shaped filter fields (as every PCO batch caller has always passed
// them) -> the filterConfig blob people_sync_batches stores, matching the
// exact shape backfillProviderNeutralSync produces from the legacy table.
function buildFilterConfigInput(input) {
  return {
    membershipFilterEnabled: !!input.membershipFilterEnabled,
    membershipAllowlist: input.membershipAllowlist || [],
    fieldFilterEnabled: !!input.fieldFilterEnabled,
    fieldFilters: input.fieldFilters || [],
  };
}

// Create a new PCO sync batch. Canonical storage is people_sync_batches (via
// batchRepository); during the compatibility window we also create a matching
// planning_center_sync_batches row (legacy schema — never dropped, see
// CLAUDE.md's additive-only migration convention) and record its id back onto
// the generic row as legacy_provider_batch_id.
async function createBatch(churchId, input) {
  const filterConfig = buildFilterConfigInput(input);
  const generic = await batchRepository.createBatch({
    churchId,
    provider: 'planning_center',
    name: input.name,
    enabled: true,
    filterSchemaVersion: 1,
    filterConfig,
    defaultPeopleType: input.defaultPeopleType,
    gatheringTypeId: input.gatheringTypeId || null,
    gatheringAutoRemoveEnabled: !!input.gatheringAutoRemoveEnabled,
    scheduleEnabled: !!input.scheduleEnabled,
    scheduleFrequency: input.scheduleFrequency,
    scheduleDay: input.scheduleDay,
    legacyProviderBatchId: null,
  });

  const legacyRes = await Database.query(
    `INSERT INTO planning_center_sync_batches
       (church_id, name, membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters,
        default_people_type, gathering_type_id, gathering_auto_remove_enabled, schedule_enabled, schedule_frequency, schedule_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [churchId, generic.name, filterConfig.membershipFilterEnabled ? 1 : 0, JSON.stringify(filterConfig.membershipAllowlist),
     filterConfig.fieldFilterEnabled ? 1 : 0, JSON.stringify(filterConfig.fieldFilters), generic.defaultPeopleType,
     generic.gatheringTypeId, generic.gatheringAutoRemoveEnabled ? 1 : 0, generic.scheduleEnabled ? 1 : 0,
     generic.scheduleFrequency, generic.scheduleDay]
  );

  await batchRepository.updateBatch({
    churchId, provider: 'planning_center', batchId: generic.id, legacyProviderBatchId: legacyRes.insertId,
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
  const filterConfig = buildFilterConfigInput(input);

  await batchRepository.updateBatch({
    churchId,
    provider: 'planning_center',
    batchId,
    name: input.name,
    filterConfig,
    defaultPeopleType: input.defaultPeopleType,
    gatheringTypeId: input.gatheringTypeId || null,
    gatheringAutoRemoveEnabled: !!input.gatheringAutoRemoveEnabled,
    scheduleEnabled: !!input.scheduleEnabled,
    scheduleFrequency: input.scheduleFrequency,
    scheduleDay: input.scheduleDay,
  });

  if (current.legacyProviderBatchId) {
    await Database.query(
      `UPDATE planning_center_sync_batches
          SET name = ?, membership_filter_enabled = ?, membership_allowlist = ?,
              field_filter_enabled = ?, field_filters = ?, default_people_type = ?,
              gathering_type_id = ?, gathering_auto_remove_enabled = ?, schedule_enabled = ?, schedule_frequency = ?, schedule_day = ?,
              updated_at = datetime('now')
        WHERE id = ? AND church_id = ?`,
      [input.name, filterConfig.membershipFilterEnabled ? 1 : 0, JSON.stringify(filterConfig.membershipAllowlist),
       filterConfig.fieldFilterEnabled ? 1 : 0, JSON.stringify(filterConfig.fieldFilters), input.defaultPeopleType,
       input.gatheringTypeId || null, input.gatheringAutoRemoveEnabled ? 1 : 0, input.scheduleEnabled ? 1 : 0,
       input.scheduleFrequency, input.scheduleDay, current.legacyProviderBatchId, churchId]
    );
  }

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
  if (current.legacyProviderBatchId) {
    await Database.query(
      `DELETE FROM planning_center_sync_batches WHERE id = ? AND church_id = ?`,
      [current.legacyProviderBatchId, churchId]
    );
  }
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

// Compute a plan for a church against an explicit filterConfig (current church
// context must be set by caller). filterConfig shape:
//   { membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters }
async function computePlanForChurch(churchId, accessToken, filterConfig, { force = false } = {}) {
  const { people: pcoPeople, householdPrimaryContacts, fetchedAt } = await getCachedPcoPeople(churchId, accessToken, { force });
  const { individuals, families } = await loadChurchState(churchId);
  const plan = computePlan({ pcoPeople, individuals, families, filterConfig, householdPrimaryContacts });
  plan.pcoFetchedAt = new Date(fetchedAt).toISOString();
  plan.pcoPeople = pcoPeople;
  return plan;
}

async function computePlanForBatch(churchId, accessToken, batch, opts) {
  return computePlanForChurch(churchId, accessToken, batchFilterConfig(batch), opts);
}

// Apply a plan for a church (current church context must be set by caller).
async function applyForChurch(churchId, plan, userId, selections, batchConfig = {}) {
  return applyPlan(churchId, plan, userId, selections, batchConfig);
}

// ─── Per-church sync ─────────────────────────────────────────────────────────

async function runBatchSync(churchId, accessToken, batch, userId) {
  try {
    const plan = await computePlanForBatch(churchId, accessToken, batch, { force: false });
    // Family name updates are a reviewable, not automatic, step (per design) — scheduled/
    // unattended runs never have a human to review them, so skip all proposed renames here.
    // computePlan recomputes this bucket fresh every run, so a skipped proposal simply
    // reappears next time someone opens the interactive Sync Review screen.
    const skipFamilyNameUpdateIds = (plan.familyNameUpdates || []).map((f) => f.familyId);
    const result = await applyForChurch(churchId, plan, userId, { skipFamilyNameUpdateIds }, {
      // batch.id is the canonical people_sync_batches id (added_by_sync_batch_id);
      // batch.legacyProviderBatchId is the dual-written planning_center_sync_batches
      // id (added_by_pco_batch_id) — see toLegacyPcoBatchDto above.
      batchId: batch.legacyProviderBatchId,
      syncBatchId: batch.id,
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
      gatheringAutoRemoveEnabled: batch.gatheringAutoRemoveEnabled,
    });
    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      gatheringAssigned: result.gatheringAssigned,
      gatheringRemoved: result.gatheringRemoved,
      familyNamesUpdated: result.familyNamesUpdated,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      // How many family-name proposals this run *skipped* (as opposed to
      // familyNamesUpdated above, which is how many were actually applied —
      // always 0 here, since they're always skipped on an unattended run).
      familyNameUpdatesPending: skipFamilyNameUpdateIds.length,
      errors: result.errors.length,
    };
    await recordBatchSyncResult(churchId, batch, summary);
    logger.info(`PCO batch sync: church ${churchId} batch ${batch.id} (${batch.name}) done — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    logger.error(`PCO batch sync: error for church ${churchId} batch ${batch.id}: ${err.message}`);
    return null;
  }
}

// ─── Scheduling ──────────────────────────────────────────────────────────────
//
// Task 10: the actual scheduler (cron wiring, per-church/per-batch iteration,
// authority gating, review notification, audit trail) now lives in
// peopleSync/scheduler.js — provider-neutral, and the only cron job that gets
// started (see server/index.js). start/stop/runNow/isDueToday are kept here,
// delegating, purely for compatibility with existing callers of this module.
// As of Task 15, scheduler.js's per-batch execution delegates to
// orchestrator.runUnattended (provider-neutral) instead of calling
// runBatchSync (below) — runBatchSync is no longer on the unattended cron
// path for any provider. It stays exported unchanged since nothing in this
// task removes it; it is simply unused by the scheduler now.
const scheduler = require('./peopleSync/scheduler');

const isDueToday = scheduler.isDueToday;
function start() { return scheduler.start(); }
function stop() { return scheduler.stop(); }
function runNow() { return scheduler.runNow(); }

module.exports = {
  start, stop, runNow, isDueToday,
  getAccessTokenForChurch, computePlanForChurch, applyForChurch, fetchAllPcoPeople,
  getCachedPcoPeople, peekCachedPcoPeople, invalidatePcoPeopleCache, httpsGet,
  listBatches, getBatch, createBatch, updateBatch, deleteBatch,
  batchFilterConfig, computePlanForBatch, recordBatchSyncResult, toLegacyPcoBatchDto,
  getPlanningCenterTokens, ensureValidPlanningCenterTokens,
  getTokensForChurch, validatePlanningCenterToken,
  runBatchSync, PCO_RECONNECT_REQUIRED,
};
