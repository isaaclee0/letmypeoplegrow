const https = require('https');
const cron = require('node-cron');
const Database = require('../config/database');
const logger = require('../config/logger');
const { projectPerson } = require('./planningCenter/projection');
const { computePlan } = require('./planningCenter/diffEngine');
const { applyPlan } = require('./planningCenter/apply');

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
  const people = await fetchAllPcoPeople(accessToken);
  const entry = { people, fetchedAt: Date.now() };
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

async function refreshToken(refreshTokenValue) {
  const response = await httpsPost('https://api.planningcenteronline.com/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: process.env.PLANNING_CENTER_CLIENT_ID,
    client_secret: process.env.PLANNING_CENTER_CLIENT_SECRET,
  });
  return response.status === 200 ? response.data : null;
}

async function getValidAccessToken(churchId, userId, tokens) {
  let accessToken = tokens.access_token;
  if (tokens.expires_at && Date.now() >= tokens.expires_at) {
    const newTokens = await refreshToken(tokens.refresh_token);
    if (!newTokens) return null;
    accessToken = newTokens.access_token;
    newTokens.expires_at = Date.now() + newTokens.expires_in * 1000;
    newTokens.refresh_token = tokens.refresh_token;
    await Database.query(
      `UPDATE user_preferences SET preference_value = ?
       WHERE user_id = ? AND preference_key = 'planning_center_tokens' AND church_id = ?`,
      [JSON.stringify(newTokens), userId, churchId]
    );
  }
  return accessToken;
}

// ─── Reconcile pipeline helpers ──────────────────────────────────────────────

// Token accessor for endpoints/cron (wraps existing helpers).
async function getAccessTokenForChurch(churchId) {
  const tokenData = await getTokensForChurch(churchId);
  if (!tokenData) return null;
  return getValidAccessToken(churchId, tokenData.userId, tokenData.tokens);
}

// Memory-efficient: project each page, discard raw JSON + included resources.
async function fetchAllPcoPeople(accessToken) {
  const people = [];
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
    }
    for (const raw of data.data || []) people.push(projectPerson(raw, fieldDataById));
    next = (data.links && data.links.next) || null;
  }
  return people;
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
    `SELECT id, planning_center_id AS planningCenterId FROM families WHERE church_id = ?`,
    [churchId]
  );
  for (const i of individuals) { i.isChild = !!i.isChild; i.isActive = !!i.isActive; }
  return { individuals, families };
}

// Compute a plan for a church (current church context must be set by caller).
async function computePlanForChurch(churchId, accessToken, { force = false } = {}) {
  const { people: pcoPeople, fetchedAt } = await getCachedPcoPeople(churchId, accessToken, { force });
  const { individuals, families } = await loadChurchState(churchId);
  const settings = await Database.query(
    `SELECT planning_center_membership_filter_enabled AS membershipFilterEnabled,
            planning_center_membership_allowlist AS membershipAllowlistRaw,
            planning_center_field_filter_enabled AS fieldFilterEnabled,
            planning_center_field_filters AS fieldFiltersRaw
       FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  let membershipFilterEnabled = true;
  let fieldFilterEnabled = false;
  let membershipAllowlist = [];
  let fieldFilters = [];
  if (settings.length) {
    membershipFilterEnabled = !!settings[0].membershipFilterEnabled;
    fieldFilterEnabled = !!settings[0].fieldFilterEnabled;
    if (settings[0].membershipAllowlistRaw) {
      try { membershipAllowlist = JSON.parse(settings[0].membershipAllowlistRaw); } catch (_) { membershipAllowlist = []; }
    }
    if (settings[0].fieldFiltersRaw) {
      try { fieldFilters = JSON.parse(settings[0].fieldFiltersRaw); } catch (_) { fieldFilters = []; }
    }
  }
  const filterConfig = { membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters };
  const plan = computePlan({ pcoPeople, individuals, families, filterConfig });
  plan.pcoFetchedAt = new Date(fetchedAt).toISOString();
  return plan;
}

// Apply a plan for a church (current church context must be set by caller).
async function applyForChurch(churchId, plan, userId, selections) {
  return applyPlan(churchId, plan, userId, selections);
}

// ─── Per-church sync ─────────────────────────────────────────────────────────

async function syncChurch(church) {
  const churchId = church.church_id;
  await Database.setChurchContext(churchId, async () => {
    try {
      const settings = await Database.query(
        `SELECT planning_center_sync_enabled, planning_center_auto_archive,
                (SELECT user_id FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens' LIMIT 1) AS token_user
           FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId, churchId]
      );
      const enabled = settings.length && (settings[0].planning_center_sync_enabled || settings[0].planning_center_auto_archive);
      if (!enabled) return;

      const accessToken = await getAccessTokenForChurch(churchId);
      if (!accessToken) { logger.warn(`PCO sync: no valid token for church ${churchId}`); return; }

      const userId = settings[0].token_user || null;
      // Scheduled run: always pull fresh from PCO so we never auto-apply a stale diff.
      const plan = await computePlanForChurch(churchId, accessToken, { force: true });
      const result = await applyForChurch(churchId, plan, userId, {});

      const summary = {
        at: new Date().toISOString(),
        added: result.added, updated: result.updated, archived: result.archived,
        reactivated: result.reactivated, linked: result.linked,
        ambiguous: plan.ambiguous.length,
        visitorMatches: (plan.visitorMatches || []).length,
        archiveExtras: (plan.archiveExtras || []).length,
        unmatchedVisitors: (plan.unmatchedVisitors || []).length,
        errors: result.errors.length,
      };
      await Database.query(
        `UPDATE church_settings
            SET planning_center_last_sync = datetime('now'),
                planning_center_last_sync_archived = ?,
                planning_center_last_sync_result = ?
          WHERE church_id = ?`,
        [result.archived, JSON.stringify(summary), churchId]
      );
      logger.info(`PCO sync: church ${churchId} done — ${JSON.stringify(summary)}`);
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

// Allow manual trigger for testing
async function runNow() {
  const churches = Database.listChurches();
  for (const church of churches) {
    await syncChurch(church);
  }
}

module.exports = {
  start, stop, runNow, syncChurch,
  getAccessTokenForChurch, computePlanForChurch, applyForChurch, fetchAllPcoPeople,
  getCachedPcoPeople, invalidatePcoPeopleCache, httpsGet,
};
