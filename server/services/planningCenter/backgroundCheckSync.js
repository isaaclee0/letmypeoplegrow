// Writes PCO's Person.passed_background_check attribute down to
// individuals.pco_background_check_cleared for every already-linked person.
//
// Deliberately separate from diffEngine/apply.js: this is supplementary
// status data, not an identity change, so it doesn't go through the
// review pipeline (ambiguous-match resolution, family-name confirmation,
// etc.) — it's just written on every real sync run, unconditionally, for
// whichever people are already linked. PCO people with no matching
// individual (planning_center_id) in this church are silently skipped —
// there's no row to write it to yet.

const Database = require('../../config/database');
const { createPcoReadClient, PcoSourceError } = require('./readClient');
const { isBackgroundCheckTrackingEnabled } = require('./mode');

const API = 'https://api.planningcenteronline.com/people/v2';
const SUCCESS_CACHE_TTL_MS = 60 * 1000;
const successfulSnapshots = new Map();
const refreshInFlight = new Map();

function projectBackgroundCheckPerson(resource) {
  const id = resource?.id === null || resource?.id === undefined
    ? '' : String(resource.id).trim();
  if (!resource || resource.type !== 'Person' || !id) {
    throw new PcoSourceError(
      'Planning Center People contains a malformed Person resource',
      'SYNC_SOURCE_INCOMPLETE',
      {}
    );
  }
  const raw = resource.attributes?.passed_background_check;
  return {
    id,
    passedBackgroundCheck: typeof raw === 'boolean' ? raw : null,
  };
}

async function fetchBackgroundCheckSnapshot(options = {}) {
  const client = options.client || createPcoReadClient({
    accessToken: options.accessToken,
    request: options.request,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
    requestScope: 'account',
  });
  const people = [];
  await client.getAll(`${API}/people?per_page=100`, async (envelope) => {
    for (const resource of envelope.data) people.push(projectBackgroundCheckPerson(resource));
  });
  people.sort((left, right) => left.id.localeCompare(right.id));
  const now = options.now || (() => new Date());
  return { fetchedAt: now().toISOString(), complete: true, people };
}

async function applyBackgroundCheckSnapshot(churchId, snapshot) {
  if (!churchId || snapshot?.complete !== true || !Array.isArray(snapshot.people)) {
    throw new Error('A complete Planning Center background-check snapshot is required');
  }
  const statuses = new Map(snapshot.people.map((person) => [
    String(person.id),
    typeof person.passedBackgroundCheck === 'boolean' ? person.passedBackgroundCheck : null,
  ]));

  return Database.transactionForChurch(churchId, async (conn) => {
    const rows = await conn.query(
      `SELECT id, planning_center_id
         FROM individuals
        WHERE church_id = ?
          AND planning_center_id IS NOT NULL
          AND planning_center_id <> ''
        ORDER BY id`,
      [churchId]
    );
    const counts = {
      fetchedAt: snapshot.fetchedAt,
      updated: 0, cleared: 0, notCleared: 0, unknown: 0,
    };
    for (const row of rows) {
      const status = statuses.has(String(row.planning_center_id))
        ? statuses.get(String(row.planning_center_id)) : null;
      await conn.query(
        `UPDATE individuals
            SET pco_background_check_cleared = ?
          WHERE id = ? AND church_id = ? AND planning_center_id = ?`,
        [status === null ? null : status ? 1 : 0,
          row.id, churchId, row.planning_center_id]
      );
      counts.updated += 1;
      if (status === true) counts.cleared += 1;
      else if (status === false) counts.notCleared += 1;
      else counts.unknown += 1;
    }
    return counts;
  });
}

function invalidateBackgroundCheckStatusCache(churchId) {
  if (churchId) successfulSnapshots.delete(churchId);
  else successfulSnapshots.clear();
}

async function defaultWithToken(churchId, operation) {
  return require('../planningCenterSync').withPlanningCenterSourceToken(churchId, operation);
}

async function refreshBackgroundCheckStatuses(churchId, overrides = {}) {
  const isTrackingEnabled = overrides.isTrackingEnabled || isBackgroundCheckTrackingEnabled;
  if (!(await isTrackingEnabled(churchId))) {
    return { skipped: 'tracking_disabled', updated: 0 };
  }

  const now = overrides.now || Date.now;
  const applySnapshot = overrides.applySnapshot || applyBackgroundCheckSnapshot;
  const cached = successfulSnapshots.get(churchId);
  if (cached && now() - cached.cachedAt < SUCCESS_CACHE_TTL_MS) {
    return applySnapshot(churchId, cached.snapshot);
  }
  if (refreshInFlight.has(churchId)) {
    return refreshInFlight.get(churchId);
  }

  const withToken = overrides.withToken || defaultWithToken;
  const fetchSnapshot = overrides.fetchSnapshot || fetchBackgroundCheckSnapshot;
  const refreshPromise = (async () => {
    const snapshot = await withToken(
      churchId,
      (accessToken) => fetchSnapshot({ accessToken })
    );
    successfulSnapshots.set(churchId, { snapshot, cachedAt: now() });
    return applySnapshot(churchId, snapshot);
  })();
  refreshInFlight.set(churchId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    refreshInFlight.delete(churchId);
  }
}

module.exports = {
  fetchBackgroundCheckSnapshot,
  applyBackgroundCheckSnapshot,
  refreshBackgroundCheckStatuses,
  invalidateBackgroundCheckStatusCache,
};
