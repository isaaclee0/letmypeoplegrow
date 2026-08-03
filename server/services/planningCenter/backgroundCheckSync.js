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
const accountCoordinator = require('./accountCoordinator');

const API = 'https://api.planningcenteronline.com/people/v2';
const SUCCESS_CACHE_TTL_MS = 60 * 1000;
const MAX_STALE_CREDENTIAL_RETRIES = 1;
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
  if (churchId) {
    successfulSnapshots.delete(churchId);
  } else {
    successfulSnapshots.clear();
  }
  accountCoordinator.invalidateCredentialEpoch(churchId);
}

async function defaultWithToken(churchId, operation) {
  return require('../planningCenterSync').withPlanningCenterSourceToken(churchId, operation);
}

function staleCredentialError() {
  const error = new Error(
    'Planning Center credentials changed repeatedly during background-check refresh; retry later'
  );
  error.code = 'PCO_BACKGROUND_CHECK_CREDENTIAL_CHANGED';
  return error;
}

async function refreshBackgroundCheckStatusesAttempt(
  churchId,
  overrides,
  staleCredentialRetriesRemaining
) {
  const isTrackingEnabled = overrides.isTrackingEnabled || isBackgroundCheckTrackingEnabled;
  if (!(await isTrackingEnabled(churchId))) {
    return { skipped: 'tracking_disabled', updated: 0 };
  }

  const now = overrides.now || Date.now;
  const applySnapshot = overrides.applySnapshot || applyBackgroundCheckSnapshot;
  const observedEpoch = accountCoordinator.getCredentialEpoch(churchId);
  let activeRefresh = refreshInFlight.get(churchId);
  if (
    activeRefresh
    && accountCoordinator.sameCredentialEpoch(activeRefresh.credentialEpoch, observedEpoch)
  ) {
    return activeRefresh.promise;
  }
  const credentialEpoch = await accountCoordinator.captureCredentialEpoch(churchId);
  activeRefresh = refreshInFlight.get(churchId);
  if (
    activeRefresh
    && accountCoordinator.sameCredentialEpoch(activeRefresh.credentialEpoch, credentialEpoch)
  ) {
    return activeRefresh.promise;
  }
  const cached = successfulSnapshots.get(churchId);
  if (
    cached
    && accountCoordinator.sameCredentialEpoch(cached.credentialEpoch, credentialEpoch)
    && now() - cached.cachedAt < SUCCESS_CACHE_TTL_MS
  ) {
    const application = await accountCoordinator.withSnapshotApplication(
      churchId,
      credentialEpoch,
      () => applySnapshot(churchId, cached.snapshot)
    );
    if (!application.stale) return application.value;
    if (staleCredentialRetriesRemaining <= 0) throw staleCredentialError();
    return refreshBackgroundCheckStatusesAttempt(
      churchId,
      overrides,
      staleCredentialRetriesRemaining - 1
    );
  }

  const withToken = overrides.withToken || defaultWithToken;
  const fetchSnapshot = overrides.fetchSnapshot || fetchBackgroundCheckSnapshot;
  const refreshPromise = (async () => {
    const snapshot = await withToken(
      churchId,
      (accessToken) => fetchSnapshot({ accessToken })
    );
    const application = await accountCoordinator.withSnapshotApplication(
      churchId,
      credentialEpoch,
      async () => {
        const result = await applySnapshot(churchId, snapshot);
        successfulSnapshots.set(churchId, {
          snapshot,
          cachedAt: now(),
          credentialEpoch,
        });
        return result;
      }
    );
    if (!application.stale) return application.value;
    if (staleCredentialRetriesRemaining <= 0) throw staleCredentialError();
    return refreshBackgroundCheckStatusesAttempt(
      churchId,
      overrides,
      staleCredentialRetriesRemaining - 1
    );
  })();
  const refreshEntry = { credentialEpoch, promise: refreshPromise };
  refreshInFlight.set(churchId, refreshEntry);
  try {
    return await refreshPromise;
  } finally {
    if (refreshInFlight.get(churchId) === refreshEntry) {
      refreshInFlight.delete(churchId);
    }
  }
}

async function refreshBackgroundCheckStatuses(churchId, overrides = {}) {
  return refreshBackgroundCheckStatusesAttempt(
    churchId,
    overrides,
    MAX_STALE_CREDENTIAL_RETRIES
  );
}

module.exports = {
  fetchBackgroundCheckSnapshot,
  applyBackgroundCheckSnapshot,
  refreshBackgroundCheckStatuses,
  invalidateBackgroundCheckStatusCache,
};
