// Privacy boundary: this module is the only application code allowed to read
// PCO Person.medical_notes. Raw values are projected to booleans immediately.
const Database = require('../../config/database');
const { createPcoReadClient, PcoSourceError } = require('./readClient');
const { isMedicalNotesRefreshEnabled } = require('./medicalNotesPolicy');
const accountCoordinator = require('./accountCoordinator');

const API = 'https://api.planningcenteronline.com/people/v2';
const SUCCESS_CACHE_TTL_MS = 60_000;
const MAX_STALE_CREDENTIAL_RETRIES = 1;
const successfulSnapshots = new Map();
const refreshInFlight = new Map();

function projectMedicalNotePerson(resource) {
  const id = resource?.id == null ? '' : String(resource.id).trim();
  if (resource?.type !== 'Person' || !id) {
    throw new PcoSourceError(
      'Planning Center People contains a malformed Person resource',
      'SYNC_SOURCE_INCOMPLETE',
      {}
    );
  }
  const value = resource.attributes?.medical_notes;
  return { id, hasMedicalNotes: typeof value === 'string' && value.trim().length > 0 };
}

async function fetchMedicalNoteSnapshot(options = {}) {
  const client = options.client || createPcoReadClient({
    accessToken: options.accessToken,
    request: options.request,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
    requestScope: 'account',
  });
  const people = [];
  await client.getAll(`${API}/people?per_page=100&fields%5BPerson%5D=medical_notes`, async (envelope) => {
    for (const resource of envelope.data) people.push(projectMedicalNotePerson(resource));
  });
  people.sort((left, right) => left.id.localeCompare(right.id));
  const now = options.now || (() => new Date());
  return { fetchedAt: now().toISOString(), complete: true, people };
}

async function applyMedicalNoteSnapshot(churchId, snapshot) {
  if (!churchId || snapshot?.complete !== true || !Array.isArray(snapshot.people)) {
    throw new Error('A complete Planning Center medical-note snapshot is required');
  }
  const statuses = new Map();
  for (const person of snapshot.people) {
    const id = person?.id == null ? '' : String(person.id).trim();
    if (!id || typeof person.hasMedicalNotes !== 'boolean') {
      throw new Error('A complete Planning Center medical-note snapshot is required');
    }
    statuses.set(id, person.hasMedicalNotes);
  }

  return Database.transactionForChurch(churchId, async (conn) => {
    const stale = await conn.query(
      `UPDATE individuals SET pco_has_medical_notes = 0
        WHERE church_id = ? AND pco_has_medical_notes <> 0
          AND (is_active <> 1 OR planning_center_id IS NULL OR planning_center_id = '')`,
      [churchId]
    );
    const rows = await conn.query(
      `SELECT id, planning_center_id FROM individuals
        WHERE church_id = ? AND is_active = 1
          AND planning_center_id IS NOT NULL AND planning_center_id <> ''
        ORDER BY id`, [churchId]
    );
    const counts = {
      fetchedAt: snapshot.fetchedAt,
      updated: 0,
      present: 0,
      absent: 0,
      clearedStale: Number(stale.affectedRows || 0),
    };
    for (const row of rows) {
      const hasMedicalNotes = statuses.get(String(row.planning_center_id)) === true;
      await conn.query(
        `UPDATE individuals SET pco_has_medical_notes = ?
          WHERE id = ? AND church_id = ? AND planning_center_id = ?`,
        [hasMedicalNotes ? 1 : 0, row.id, churchId, row.planning_center_id]
      );
      counts.updated += 1;
      if (hasMedicalNotes) counts.present += 1;
      else counts.absent += 1;
    }
    await conn.query(
      `UPDATE church_settings SET
         planning_center_medical_notes_last_refreshed_at = ?,
         planning_center_medical_notes_last_refresh_result = ?
       WHERE church_id = ?`,
      [snapshot.fetchedAt, JSON.stringify(counts), churchId]
    );
    return counts;
  });
}

function invalidateMedicalNoteStatusCache(churchId) {
  if (churchId) successfulSnapshots.delete(churchId);
  else successfulSnapshots.clear();
  accountCoordinator.invalidateCredentialEpoch(churchId);
}

async function defaultWithToken(churchId, operation) {
  return require('../planningCenterSync').withPlanningCenterSourceToken(churchId, operation);
}

function staleCredentialError() {
  const error = new Error('Planning Center credentials changed repeatedly during medical-note refresh; retry later');
  error.code = 'PCO_MEDICAL_NOTES_CREDENTIAL_CHANGED';
  return error;
}

async function refreshEpochAttempt(churchId, overrides) {
  const isTrackingEnabled = overrides.isTrackingEnabled || isMedicalNotesRefreshEnabled;
  if (!(await isTrackingEnabled(churchId))) {
    return { stale: false, value: { skipped: 'tracking_disabled', updated: 0 } };
  }
  const now = overrides.now || Date.now;
  const applySnapshot = overrides.applySnapshot || applyMedicalNoteSnapshot;
  const observedEpoch = accountCoordinator.getCredentialEpoch(churchId);
  let active = refreshInFlight.get(churchId);
  if (active && accountCoordinator.sameCredentialEpoch(active.credentialEpoch, observedEpoch)) return active.promise;
  const credentialEpoch = await accountCoordinator.captureCredentialEpoch(churchId);
  active = refreshInFlight.get(churchId);
  if (active && accountCoordinator.sameCredentialEpoch(active.credentialEpoch, credentialEpoch)) return active.promise;
  const cached = successfulSnapshots.get(churchId);
  if (cached && accountCoordinator.sameCredentialEpoch(cached.credentialEpoch, credentialEpoch)
      && now() - cached.cachedAt < SUCCESS_CACHE_TTL_MS) {
    return accountCoordinator.withSnapshotApplication(churchId, credentialEpoch,
      () => applySnapshot(churchId, cached.snapshot));
  }
  const withToken = overrides.withToken || defaultWithToken;
  const fetchSnapshot = overrides.fetchSnapshot || fetchMedicalNoteSnapshot;
  const promise = (async () => {
    const snapshot = await withToken(churchId, (accessToken) => fetchSnapshot({ accessToken }));
    return accountCoordinator.withSnapshotApplication(churchId, credentialEpoch, async () => {
      const result = await applySnapshot(churchId, snapshot);
      successfulSnapshots.set(churchId, { snapshot, cachedAt: now(), credentialEpoch });
      return result;
    });
  })();
  const entry = { credentialEpoch, promise };
  refreshInFlight.set(churchId, entry);
  try { return await promise; } finally {
    if (refreshInFlight.get(churchId) === entry) refreshInFlight.delete(churchId);
  }
}

async function refreshMedicalNoteStatuses(churchId, overrides = {}) {
  let retries = MAX_STALE_CREDENTIAL_RETRIES;
  while (true) {
    const attempt = await refreshEpochAttempt(churchId, overrides);
    if (!attempt.stale) return attempt.value;
    if (retries <= 0) throw staleCredentialError();
    retries -= 1;
  }
}

module.exports = {
  projectMedicalNotePerson,
  fetchMedicalNoteSnapshot,
  applyMedicalNoteSnapshot,
  refreshMedicalNoteStatuses,
  invalidateMedicalNoteStatusCache,
};
