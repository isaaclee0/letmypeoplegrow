const https = require('https');
const cron = require('node-cron');
const Database = require('../config/database');
const logger = require('../config/logger');
const { projectPerson } = require('./planningCenter/projection');
const { computePlan } = require('./planningCenter/diffEngine');
const { applyPlan, applyArchiveExtras } = require('./planningCenter/apply');

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

// ─── Reconcile pipeline helpers ──────────────────────────────────────────────

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

// Row shape from planning_center_sync_batches -> the shape everything else expects.
function rowToBatch(row) {
  let membershipAllowlist = [];
  let fieldFilters = [];
  let lastSyncResult = null;
  if (row.membershipAllowlistRaw) { try { membershipAllowlist = JSON.parse(row.membershipAllowlistRaw); } catch (_) {} }
  if (row.fieldFiltersRaw) { try { fieldFilters = JSON.parse(row.fieldFiltersRaw); } catch (_) {} }
  if (row.lastSyncResultRaw) { try { lastSyncResult = JSON.parse(row.lastSyncResultRaw); } catch (_) {} }
  return {
    id: row.id,
    name: row.name,
    membershipFilterEnabled: !!row.membershipFilterEnabled,
    membershipAllowlist,
    fieldFilterEnabled: !!row.fieldFilterEnabled,
    fieldFilters,
    defaultPeopleType: row.defaultPeopleType || 'regular',
    gatheringTypeId: row.gatheringTypeId || null,
    scheduleEnabled: !!row.scheduleEnabled,
    scheduleFrequency: row.scheduleFrequency || 'weekly',
    scheduleDay: typeof row.scheduleDay === 'number' ? row.scheduleDay : 1,
    lastSyncAt: row.lastSyncAt || null,
    lastSyncResult,
  };
}

const BATCH_SELECT = `SELECT id, name, membership_filter_enabled AS membershipFilterEnabled,
         membership_allowlist AS membershipAllowlistRaw,
         field_filter_enabled AS fieldFilterEnabled,
         field_filters AS fieldFiltersRaw,
         default_people_type AS defaultPeopleType,
         gathering_type_id AS gatheringTypeId,
         schedule_enabled AS scheduleEnabled,
         schedule_frequency AS scheduleFrequency,
         schedule_day AS scheduleDay,
         last_sync_at AS lastSyncAt,
         last_sync_result AS lastSyncResultRaw
    FROM planning_center_sync_batches`;

async function listBatches(churchId) {
  const rows = await Database.query(`${BATCH_SELECT} WHERE church_id = ? ORDER BY id`, [churchId]);
  return rows.map(rowToBatch);
}

async function getBatch(churchId, batchId) {
  const rows = await Database.query(`${BATCH_SELECT} WHERE id = ? AND church_id = ? LIMIT 1`, [batchId, churchId]);
  return rows.length ? rowToBatch(rows[0]) : null;
}

// Compute a plan for a church against an explicit filterConfig (current church
// context must be set by caller). filterConfig shape:
//   { membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters }
async function computePlanForChurch(churchId, accessToken, filterConfig, { force = false } = {}) {
  const { people: pcoPeople, householdPrimaryContacts, fetchedAt } = await getCachedPcoPeople(churchId, accessToken, { force });
  const { individuals, families } = await loadChurchState(churchId);
  const plan = computePlan({ pcoPeople, individuals, families, filterConfig, householdPrimaryContacts });
  plan.pcoFetchedAt = new Date(fetchedAt).toISOString();
  return plan;
}

// filterConfig for a saved batch.
function batchFilterConfig(batch) {
  return {
    membershipFilterEnabled: batch.membershipFilterEnabled,
    membershipAllowlist: batch.membershipAllowlist,
    fieldFilterEnabled: batch.fieldFilterEnabled,
    fieldFilters: batch.fieldFilters,
  };
}

async function computePlanForBatch(churchId, accessToken, batch, opts) {
  return computePlanForChurch(churchId, accessToken, batchFilterConfig(batch), opts);
}

// archiveExtras/unmatchedVisitors never consult filterConfig (they're name-matched
// against PCO's full unfiltered people export — see diffEngine.js), so any
// filterConfig works here; a neutral empty one keeps intent clear.
const NEUTRAL_FILTER_CONFIG = { membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [] };

async function computeReconciliationForChurch(churchId, accessToken, opts) {
  const plan = await computePlanForChurch(churchId, accessToken, NEUTRAL_FILTER_CONFIG, opts);
  return { archiveExtras: plan.archiveExtras, unmatchedVisitors: plan.unmatchedVisitors, pcoFetchedAt: plan.pcoFetchedAt };
}

async function applyReconciliation(churchId, plan, selections = {}) {
  return applyArchiveExtras(churchId, plan.archiveExtras, {
    skipArchiveExtraIds: selections.skipArchiveExtraIds || [],
    manualLinks: selections.manualLinks || {},
  });
}

// Apply a plan for a church (current church context must be set by caller).
async function applyForChurch(churchId, plan, userId, selections, batchConfig = {}) {
  return applyPlan(churchId, plan, userId, selections, batchConfig);
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

// Decides whether a church's sync is due to run "tonight" given its configured
// frequency/day. Weekly day-of-week: 0=Sunday..6=Saturday (JS Date convention).
function isDueToday(frequency, day, now = new Date()) {
  if (frequency === 'daily') return true;
  if (frequency === 'monthly') return now.getDate() === 1;
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
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
    });
    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      gatheringAssigned: result.gatheringAssigned,
      familyNamesUpdated: result.familyNamesUpdated,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      // How many family-name proposals this run *skipped* (as opposed to
      // familyNamesUpdated above, which is how many were actually applied —
      // always 0 here, since they're always skipped on an unattended run).
      familyNameUpdatesPending: skipFamilyNameUpdateIds.length,
      errors: result.errors.length,
    };
    await Database.query(
      `UPDATE planning_center_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(summary), batch.id]
    );
    logger.info(`PCO batch sync: church ${churchId} batch ${batch.id} (${batch.name}) done — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    logger.error(`PCO batch sync: error for church ${churchId} batch ${batch.id}: ${err.message}`);
    return null;
  }
}

async function runReconciliationSync(churchId, accessToken, userId) {
  try {
    const plan = await computeReconciliationForChurch(churchId, accessToken, { force: false });
    const result = await applyReconciliation(churchId, plan, {});
    const summary = { at: new Date().toISOString(), archived: result.archived, errors: result.errors.length };
    await Database.query(
      `UPDATE church_settings
          SET planning_center_reconciliation_last_run_at = datetime('now'),
              planning_center_reconciliation_last_result = ?
        WHERE church_id = ?`,
      [JSON.stringify(summary), churchId]
    );
    logger.info(`PCO reconciliation: church ${churchId} done — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    logger.error(`PCO reconciliation: error for church ${churchId}: ${err.message}`);
    return null;
  }
}

async function syncChurch(church, { skipScheduleCheck = false } = {}) {
  const churchId = church.church_id;
  await Database.setChurchContext(churchId, async () => {
    try {
      const settings = await Database.query(
        `SELECT planning_center_sync_enabled AS enabled,
                planning_center_reconciliation_schedule_enabled AS reconciliationScheduleEnabled,
                planning_center_reconciliation_frequency AS reconciliationFrequency,
                planning_center_reconciliation_day AS reconciliationDay,
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
      const reconciliationDue = !!(settings[0].reconciliationScheduleEnabled &&
        (skipScheduleCheck || isDueToday(settings[0].reconciliationFrequency, settings[0].reconciliationDay)));

      if (!dueBatches.length && !reconciliationDue) return;

      const accessToken = await getAccessTokenForChurch(churchId);
      if (!accessToken) { logger.warn(`PCO sync: no valid token for church ${churchId}`); return; }

      // Warm the PCO people cache once for this whole run — each due batch and
      // reconciliation below reuse it (force: false) rather than each re-fetching.
      await getCachedPcoPeople(churchId, accessToken, { force: true });

      for (const batch of dueBatches) {
        await runBatchSync(churchId, accessToken, batch, userId);
      }

      if (reconciliationDue) await runReconciliationSync(churchId, accessToken, userId);
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
  listBatches, getBatch, batchFilterConfig, computePlanForBatch,
  computeReconciliationForChurch, applyReconciliation,
  getPlanningCenterTokens, savePlanningCenterTokens, ensureValidPlanningCenterTokens,
};
