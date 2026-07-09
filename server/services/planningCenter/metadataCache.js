const Database = require('../../config/database');
const logger = require('../../config/logger');
const { getCachedPcoPeople } = require('../planningCenterSync');
const { tallyMembership } = require('./summary');
const { fetchFieldDefinitions } = require('./fieldDefinitions');

// How old the persisted membership/field-definitions snapshot can get before a read
// triggers a background refresh. Independent of the 10-minute in-memory PCO-people
// cache in planningCenterSync.js — this one only gates the batch editor's metadata
// display, not sync correctness.
const STALE_MS = 60 * 60 * 1000; // 1 hour

function isStale(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return true;
  return (now - fetchedAt) > STALE_MS;
}

async function getMembershipCache(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    'SELECT planning_center_membership_cache AS raw FROM church_settings WHERE church_id = ?',
    [churchId]
  );
  const raw = rows[0] && rows[0].raw;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function getFieldDefinitionsCache(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    'SELECT planning_center_field_definitions_cache AS raw FROM church_settings WHERE church_id = ?',
    [churchId]
  );
  const raw = rows[0] && rows[0].raw;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Dedup concurrent refreshes for the same church — two admins opening the batch
// editor at once (or an on-demand refresh overlapping the connect-time one) share one
// underlying PCO fetch instead of triggering it twice.
const refreshInFlight = new Map(); // churchId -> Promise<{ membership, fieldDefinitions }>

async function refreshMetadataForChurch(churchId, accessToken) {
  const existing = refreshInFlight.get(churchId);
  if (existing) return existing;

  const promise = (async () => {
    const [{ people }, definitions] = await Promise.all([
      getCachedPcoPeople(churchId, accessToken),
      fetchFieldDefinitions(accessToken),
    ]);
    const membership = { ...tallyMembership(people), fetchedAt: Date.now() };
    const fieldDefinitions = { definitions, fetchedAt: Date.now() };
    await Database.queryForChurch(
      churchId,
      `UPDATE church_settings
          SET planning_center_membership_cache = ?, planning_center_field_definitions_cache = ?
        WHERE church_id = ?`,
      [JSON.stringify(membership), JSON.stringify(fieldDefinitions), churchId]
    );
    return { membership, fieldDefinitions };
  })();

  refreshInFlight.set(churchId, promise);
  try {
    return await promise;
  } finally {
    refreshInFlight.delete(churchId);
  }
}

// Cache-first read, shared by membership-summary, field-definitions, and field-summary
// below — previously each route reimplemented (or in field-summary's case, skipped
// entirely) this same "cold cache blocks on a live fetch, stale cache returns
// immediately and refreshes in the background" policy. A cold cache blocks because
// there's nothing to show yet; once a snapshot exists, staleness is handled by the
// background refresh instead of ever blocking a request on it.
async function readCacheFirst(churchId, accessToken, getCachedFn, pickFreshFn) {
  const cached = await getCachedFn(churchId);
  if (!cached) {
    const fresh = await refreshMetadataForChurch(churchId, accessToken);
    return { ...pickFreshFn(fresh), refreshing: false };
  }
  const stale = isStale(cached.fetchedAt);
  if (stale) {
    refreshMetadataForChurch(churchId, accessToken)
      .catch((e) => logger.error('PCO metadata cache refresh error:', e));
  }
  return { ...cached, refreshing: stale };
}

function readMembershipSummary(churchId, accessToken) {
  return readCacheFirst(churchId, accessToken, getMembershipCache, (fresh) => fresh.membership);
}

function readFieldDefinitionsSummary(churchId, accessToken) {
  return readCacheFirst(churchId, accessToken, getFieldDefinitionsCache, (fresh) => fresh.fieldDefinitions);
}

module.exports = {
  STALE_MS, isStale, getMembershipCache, getFieldDefinitionsCache, refreshMetadataForChurch,
  readMembershipSummary, readFieldDefinitionsSummary,
};
