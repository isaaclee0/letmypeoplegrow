const https = require('https');
const cron = require('node-cron');
const Database = require('../config/database');
const logger = require('../config/logger');
const { projectPerson } = require('./planningCenter/projection');
const { computePlan } = require('./planningCenter/diffEngine');
const { applyPlan } = require('./planningCenter/apply');
const { reviewNotificationDecision, buildPcoReviewMessage } = require('./planningCenter/reviewNotification');
const batchRepository = require('./peopleSync/batchRepository');

let cronJob = null;

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
// This module is the single implementation of PCO OAuth token persistence and
// refresh. server/routes/integrations.js delegates to these rather than keeping
// its own copies — PCO rotates the refresh token on every use, so more than one
// independent refresh path risks two callers racing to refresh at once, with
// the loser persisting a token PCO has already rotated away from and silently
// breaking the connection.

async function getTokensForChurch(churchId) {
  // Find any user in this church who has PCO tokens stored
  const rows = await Database.query(
    `SELECT up.user_id, up.preference_value
     FROM user_preferences up
     WHERE up.church_id = ? AND up.preference_key = 'planning_center_tokens'
     LIMIT 1`,
    [churchId]
  );
  if (!rows.length) return null;
  const pref = rows[0].preference_value;
  return {
    userId: rows[0].user_id,
    tokens: typeof pref === 'string' ? JSON.parse(pref) : pref,
  };
}

// Load a specific user's PCO tokens — as opposed to getTokensForChurch, which
// grabs whichever user in the church happens to have tokens. Used by
// request-scoped routes that already know which user is asking.
async function getPlanningCenterTokens(userId, churchId) {
  const rows = await Database.query(
    `SELECT preference_value FROM user_preferences
      WHERE user_id = ? AND preference_key = 'planning_center_tokens' AND church_id = ?
      LIMIT 1`,
    [userId, churchId]
  );
  if (!rows.length) return null;
  const pref = rows[0].preference_value;
  return typeof pref === 'string' ? JSON.parse(pref) : pref;
}

async function savePlanningCenterTokens(userId, churchId, tokens) {
  await Database.query(
    `DELETE FROM user_preferences WHERE user_id = ? AND preference_key = 'planning_center_tokens' AND church_id = ?`,
    [userId, churchId]
  );
  await Database.query(
    `INSERT INTO user_preferences (user_id, preference_key, preference_value, church_id)
     VALUES (?, 'planning_center_tokens', ?, ?)`,
    [userId, JSON.stringify(tokens), churchId]
  );
}

// Tolerate the British "CENTRE" spelling so a .env typo can't break token refresh.
function pcoEnv(suffix) {
  return process.env[`PLANNING_CENTER_${suffix}`] || process.env[`PLANNING_CENTRE_${suffix}`];
}

async function refreshToken(refreshTokenValue) {
  const response = await httpsPost('https://api.planningcenteronline.com/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: pcoEnv('CLIENT_ID'),
    client_secret: pcoEnv('CLIENT_SECRET'),
  });
  return response.status === 200 ? response.data : null;
}

// Refresh proactively if the token is expired or expiring soon, ONCE, coalescing
// concurrent callers (e.g. a scheduled batch sync and a concurrent check-in
// import for the same church) onto a single in-flight refresh via a per
// user+church single-flight guard. Without this, two independent refreshes can
// race and the second one persists a token PCO already rotated away from.
const PCO_TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh if <10 min of life left
const pcoRefreshInFlight = new Map(); // `${userId}|${churchId}` -> Promise<tokens|null>

async function ensureValidPlanningCenterTokens(userId, churchId, tokens) {
  if (!tokens || !tokens.refresh_token) return tokens || null;
  const expiringSoon = tokens.expires_at && Date.now() >= (tokens.expires_at - PCO_TOKEN_REFRESH_MARGIN_MS);
  if (!expiringSoon) return tokens;

  const key = `${userId}|${churchId}`;
  if (pcoRefreshInFlight.has(key)) return pcoRefreshInFlight.get(key);

  const refreshPromise = (async () => {
    const fresh = await refreshToken(tokens.refresh_token);
    if (!fresh || !fresh.access_token) {
      // Refresh failed (e.g. refresh token revoked). If the token is already past
      // its actual expiry there's nothing usable left, so signal that clearly.
      // If it's merely expiring soon, hand back what we have so a caller mid-flight
      // can still use it before it's actually rejected.
      const trulyExpired = tokens.expires_at && Date.now() >= tokens.expires_at;
      return trulyExpired ? null : tokens;
    }
    const saved = {
      ...tokens,
      ...fresh, // new access_token AND (usually) rotated refresh_token
      expires_at: Date.now() + ((fresh.expires_in || 7200) * 1000),
    };
    if (!saved.refresh_token) saved.refresh_token = tokens.refresh_token;
    await savePlanningCenterTokens(userId, churchId, saved);
    return saved;
  })();

  pcoRefreshInFlight.set(key, refreshPromise);
  try { return await refreshPromise; }
  finally { pcoRefreshInFlight.delete(key); }
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
// (routes/integrations.js) and the unattended scheduled path (runBatchSync
// below) so the two never drift.
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

// ─── Scheduling ──────────────────────────────────────────────────────────────

// Decides whether a church's sync is due to run "tonight" given its configured
// frequency/day. Weekly day-of-week: 0=Sunday..6=Saturday (JS Date convention).
// Monthly day-of-month: 1-31, clamped to the last day of shorter months (e.g.
// day 31 runs on April 30th; day 29 runs on Feb 28th outside leap years).
function isDueToday(frequency, day, now = new Date()) {
  if (frequency === 'daily') return true;
  if (frequency === 'monthly') {
    // A stored day < 1 (e.g. a legacy row saved as day=0 back when this
    // column meant "day of week" for every frequency, before monthly got
    // its own 1-31 validation) must fall back to a safe default rather
    // than resolve to Math.min(0, lastDayOfMonth) === 0, which would never
    // match any date and silently stop the schedule from ever firing again.
    const targetDay = typeof day === 'number' && day >= 1 ? day : 1;
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return now.getDate() === Math.min(targetDay, lastDayOfMonth);
  }
  // weekly (default, and fallback for unrecognized frequencies)
  const targetDay = typeof day === 'number' ? day : 1;
  return now.getDay() === targetDay;
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

// ─── Review-needed notifications ─────────────────────────────────────────────

async function maybeNotifyPcoReviewNeeded(churchId, totals) {
  const rows = await Database.query(
    `SELECT planning_center_last_notified_review AS last FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  const prev = rows.length && rows[0].last ? JSON.parse(rows[0].last) : null;
  const decision = reviewNotificationDecision(prev, totals);

  if (decision.clear) {
    await Database.query(
      `UPDATE church_settings SET planning_center_last_notified_review = NULL WHERE church_id = ?`,
      [churchId]
    );
  }
  if (!decision.notify) return;

  const message = buildPcoReviewMessage(totals);
  const admins = await Database.query(
    `SELECT id FROM users WHERE role IN ('admin', 'coordinator') AND is_active = 1 AND church_id = ?`,
    [churchId]
  );
  for (const admin of admins) {
    await Database.query(
      `INSERT INTO notifications (user_id, title, message, notification_type, church_id)
       VALUES (?, ?, ?, 'system', ?)`,
      [admin.id, 'Planning Center sync needs your review', message, churchId]
    );
  }
  await Database.query(
    `UPDATE church_settings SET planning_center_last_notified_review = ? WHERE church_id = ?`,
    [JSON.stringify(totals), churchId]
  );
  logger.info(`PCO review notification: church ${churchId} notified ${admins.length} admin(s) — ${JSON.stringify(totals)}`);
}

async function syncChurch(church, { skipScheduleCheck = false } = {}) {
  const churchId = church.church_id;
  await Database.setChurchContext(churchId, async () => {
    try {
      const settings = await Database.query(
        `SELECT planning_center_sync_enabled AS enabled,
                (SELECT user_id FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens' LIMIT 1) AS token_user
           FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId, churchId]
      );
      if (!settings.length || !settings[0].enabled) return;
      const userId = settings[0].token_user || null;

      const batches = await listBatches(churchId);
      const dueBatches = batches.filter((batch) => {
        if (!batch.scheduleEnabled) return false;
        return skipScheduleCheck || isDueToday(batch.scheduleFrequency, batch.scheduleDay);
      });

      if (!dueBatches.length) return;

      const accessToken = await getAccessTokenForChurch(churchId);
      if (!accessToken) { logger.warn(`PCO sync: no valid token for church ${churchId}`); return; }

      // Warm the PCO people cache once for this whole run — every due batch below
      // reuses it (force: false) rather than each re-fetching.
      await getCachedPcoPeople(churchId, accessToken, { force: true });

      const totals = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 };
      for (const batch of dueBatches) {
        const summary = await runBatchSync(churchId, accessToken, batch, userId);
        if (summary) {
          totals.ambiguous += summary.ambiguous;
          totals.visitorMatches += summary.visitorMatches;
          totals.familyNameUpdatesPending += summary.familyNameUpdatesPending;
        }
      }

      await maybeNotifyPcoReviewNeeded(churchId, totals);
    } catch (err) {
      logger.error(`PCO sync: error for church ${churchId}: ${err.message}`);
    }
  });
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

function start() {
  if (cronJob) cronJob.stop();

  // Run daily at 2 AM server time
  cronJob = cron.schedule('0 2 * * *', async () => {
    try {
      const churches = Database.listChurches();
      for (const church of churches) {
        await syncChurch(church);
      }
    } catch (err) {
      logger.error(`PCO sync scheduler error: ${err.message}`);
    }
  });

  logger.info('PCO sync scheduler started (daily at 2 AM)');
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

// Allow manual trigger for testing — runs unconditionally, bypassing the
// frequency/day schedule gate (the user explicitly asked for it right now).
async function runNow() {
  const churches = Database.listChurches();
  for (const church of churches) {
    await syncChurch(church, { skipScheduleCheck: true });
  }
}

module.exports = {
  start, stop, runNow, syncChurch, isDueToday,
  getAccessTokenForChurch, computePlanForChurch, applyForChurch, fetchAllPcoPeople,
  getCachedPcoPeople, invalidatePcoPeopleCache, httpsGet,
  listBatches, getBatch, createBatch, updateBatch, deleteBatch,
  batchFilterConfig, computePlanForBatch, recordBatchSyncResult, toLegacyPcoBatchDto,
  getPlanningCenterTokens, savePlanningCenterTokens, ensureValidPlanningCenterTokens,
  getTokensForChurch, validatePlanningCenterToken,
};
