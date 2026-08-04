const Database = require('../../config/database');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const TRIGGERS = new Set(['onboarding', 'manual', 'run_now', 'scheduled', 'authority_switch', 'full_reconciliation', 'people_import']);
const FETCH_MODES = new Set(['full', 'incremental']);
const FINISHED_STATUSES = new Set(['review_required', 'applied', 'cancelled']);
const COUNT_KEYS = new Set([
  'linkPeople', 'linkFamilies', 'addPeople', 'addFamilies', 'updateManagedFields', 'promoteToRegular',
  'demoteToLocalVisitor', 'archive', 'reactivate', 'moveFamily', 'renameFamily', 'addToGathering',
  'removeFromGathering', 'ambiguousPeople', 'familyConflicts', 'unmatchedLocalRegulars', 'skipped',
  'familyNamesUpdated', 'gatheringAssigned', 'gatheringRemoved',
  'backgroundCheckSynced', 'backgroundCheckSyncFailed',
]);
const CREDENTIAL_KEYS = new Set(['apikey', 'accesstoken', 'refreshtoken', 'credential', 'authorization', 'password', 'secret', 'token']);
const SOURCE_PROVENANCE_KEYS = Object.freeze([
  'batchId', 'sourceKind', 'sourceExternalId', 'sourceName', 'memberCount',
  'providerRefreshedAt', 'fetchedAt', 'snapshotDigest',
]);
const MAX_SOURCE_PROVENANCE_ENTRIES = 100;
const MAX_SOURCE_PROVENANCE_BYTES = 32 * 1024;
const SOURCE_KINDS = Object.freeze({
  planning_center: new Set(['planning_center_list']),
  elvanto: new Set(['elvanto_category', 'elvanto_group']),
});

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported people-sync provider: ${provider}`);
}

function assertNoCredentialShape(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialShape(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(key.replace(/[_-]/g, '').toLowerCase()) || /payload/i.test(key)) {
      throw new Error(`Audit input cannot contain credential or raw payload key "${key}"`);
    }
    assertNoCredentialShape(nested);
  }
}

function assertAllowlistedInput(input, allowed, label) {
  assertNoCredentialShape(input);
  for (const key of Object.keys(input || {})) {
    if (!allowed.has(key)) throw new Error(`${label} input field is not allowlisted: ${key}`);
  }
}

function normaliseSafeAuditText(value, label, { allowNull = true, maxLength = 500 } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalised = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!normalised) {
    if (allowNull) return null;
    throw new Error(`${label} is required`);
  }
  if (normalised.length > maxLength) throw new Error(`${label} is too long`);
  if (/^[{[]/.test(normalised)) {
    try {
      const parsed = JSON.parse(normalised);
      if (parsed && typeof parsed === 'object') throw new Error(`${label} cannot contain a serialized payload`);
    } catch (error) {
      if (/serialized payload/.test(error.message)) throw error;
    }
  }
  if (/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/i.test(normalised) ||
      /\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|password|secret|token)\b\s*(?:[:=]\s*|\s+)[^\s,;]+/i.test(normalised)) {
    throw new Error(`${label} cannot contain credential-shaped content`);
  }
  return normalised;
}

function normaliseErrorCode(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) {
    throw new Error('Run error code must use the safe UPPER_SNAKE_CASE format');
  }
  return value;
}

function sanitiseCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Run counts must be an object');
  assertNoCredentialShape(counts);
  const safe = {};
  for (const [key, value] of Object.entries(counts)) {
    if (!COUNT_KEYS.has(key)) throw new Error(`Run count is not allowlisted: ${key}`);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Run count must be a non-negative integer: ${key}`);
    safe[key] = value;
  }
  return safe;
}

function parseCounts(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? sanitiseCounts(parsed) : {};
  } catch (_) {
    return {};
  }
}

function isoTimestamp(value, label, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp${allowNull ? ' or null' : ''}`);
  }
  return value;
}

function sanitiseSourceProvenance(value, provider, { allowNull = true, operationKind = 'people_sync' } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error('Source provenance must be an array');
  }
  if (!Array.isArray(value) || value.length > MAX_SOURCE_PROVENANCE_ENTRIES) {
    throw new Error('Source provenance must be a size-bounded array');
  }
  assertNoCredentialShape(value);
  const isPeopleImport = operationKind === 'people_import';
  const providerKinds = SOURCE_KINDS[provider] || new Set();
  const allowedKinds = isPeopleImport ? new Set(['all', ...providerKinds]) : providerKinds;
  const safe = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).sort().join(',') !== [...SOURCE_PROVENANCE_KEYS].sort().join(',')) {
      throw new Error('Source provenance entry fields are not allowlisted');
    }
    const validBatchId = isPeopleImport
      ? entry.batchId === null
      : Number.isSafeInteger(entry.batchId) && entry.batchId > 0;
    if (!validBatchId ||
        typeof entry.sourceKind !== 'string' || !allowedKinds.has(entry.sourceKind) ||
        !Number.isSafeInteger(entry.memberCount) || entry.memberCount < 0 ||
        typeof entry.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.snapshotDigest)) {
      throw new Error('Source provenance entry is invalid');
    }
    return {
      batchId: entry.batchId,
      sourceKind: entry.sourceKind,
      sourceExternalId: normaliseSafeAuditText(entry.sourceExternalId, 'Source provenance external ID', { allowNull: false }),
      sourceName: normaliseSafeAuditText(entry.sourceName, 'Source provenance name', { allowNull: false }),
      memberCount: entry.memberCount,
      providerRefreshedAt: isoTimestamp(entry.providerRefreshedAt, 'Source provenance provider refresh time', { allowNull: true }),
      fetchedAt: isoTimestamp(entry.fetchedAt, 'Source provenance fetch time'),
      snapshotDigest: entry.snapshotDigest,
    };
  });
  if (Buffer.byteLength(JSON.stringify(safe), 'utf8') > MAX_SOURCE_PROVENANCE_BYTES) {
    throw new Error('Source provenance is too large');
  }
  return safe;
}

function parseSourceProvenance(value, provider, operationKind) {
  try {
    if (value === null || value === undefined) return [];
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return sanitiseSourceProvenance(parsed, provider, { allowNull: false, operationKind });
  } catch (_) {
    return [];
  }
}

function validateSourceProvenance(value, provider, operationKind = 'people_sync') {
  assertProvider(provider);
  return sanitiseSourceProvenance(value, provider, { allowNull: false, operationKind });
}

function toRun(row) {
  if (!row) return null;
  return {
    id: row.id, provider: row.provider, batchId: row.batch_id, trigger: row.trigger, fetchMode: row.fetch_mode,
    status: row.status, counts: parseCounts(row.counts), reviewNotificationFingerprint: row.review_notification_fingerprint,
    errorCode: row.error_code, errorMessage: row.error_message, externalWatermark: row.external_watermark,
    sourceProvenance: parseSourceProvenance(row.source_provenance, row.provider, row.trigger),
    startedAt: row.started_at, completedAt: row.completed_at,
  };
}

async function getRunForChurch(runId, churchId, provider) {
  assertProvider(provider);
  const rows = await Database.queryForChurch(churchId,
    'SELECT * FROM people_sync_runs WHERE id = ? AND church_id = ? AND provider = ?', [runId, churchId, provider]);
  return rows[0] || null;
}

async function getRunningRun(runId, churchId, provider) {
  const run = await getRunForChurch(runId, churchId, provider);
  if (!run) throw new Error('Run is not available for this church and provider');
  if (run.status !== 'running') throw new Error('Only running runs can be finalized');
  return run;
}

async function startRun(input) {
  const allowed = new Set(['churchId', 'provider', 'batchId', 'trigger', 'fetchMode']);
  assertAllowlistedInput(input, allowed, 'Run start');
  const { churchId, provider, batchId = null, trigger, fetchMode } = input;
  assertProvider(provider);
  if (!churchId || !TRIGGERS.has(trigger) || !FETCH_MODES.has(fetchMode)) throw new Error('Invalid run start input');
  if (trigger === 'people_import' && batchId !== null) throw new Error('People import runs must be batchless');
  if (batchId !== null) {
    const batches = await Database.queryForChurch(churchId,
      'SELECT id FROM people_sync_batches WHERE id = ? AND church_id = ? AND provider = ?', [batchId, churchId, provider]);
    if (!batches[0]) throw new Error('Run batch is not available for this church and provider');
  }
  const result = await Database.queryForChurch(churchId, `INSERT INTO people_sync_runs
    (church_id, provider, batch_id, trigger, fetch_mode, status) VALUES (?, ?, ?, ?, ?, 'running')`,
  [churchId, provider, batchId, trigger, fetchMode]);
  return toRun(await getRunForChurch(result.insertId, churchId, provider));
}

async function finishRun(input) {
  const allowed = new Set(['churchId', 'provider', 'runId', 'status', 'counts', 'externalWatermark', 'sourceProvenance']);
  assertAllowlistedInput(input, allowed, 'Run finish');
  const { churchId, provider, runId, status, counts, externalWatermark = null, sourceProvenance = null } = input;
  assertProvider(provider);
  if (!FINISHED_STATUSES.has(status)) throw new Error('Invalid completed run status');
  const safeCounts = sanitiseCounts(counts);
  const safeWatermark = normaliseSafeAuditText(externalWatermark, 'External watermark');
  const run = await getRunningRun(runId, churchId, provider);
  const safeSourceProvenance = sanitiseSourceProvenance(sourceProvenance, provider, {
    operationKind: run.trigger,
  });
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_runs SET status = ?, counts = ?, external_watermark = ?, source_provenance = ?,
      error_code = NULL, error_message = NULL, completed_at = datetime('now')
      WHERE id = ? AND church_id = ? AND provider = ? AND status = 'running'`,
  [status, JSON.stringify(safeCounts), safeWatermark,
    safeSourceProvenance === null ? null : JSON.stringify(safeSourceProvenance), runId, churchId, provider]);
  if (result.affectedRows !== 1) throw new Error('Only running runs can be finalized');
  return toRun(await getRunForChurch(runId, churchId, provider));
}

async function failRun(input) {
  const allowed = new Set(['churchId', 'provider', 'runId', 'errorCode', 'errorMessage']);
  assertAllowlistedInput(input, allowed, 'Run failure');
  const { churchId, provider, runId, errorCode = null, errorMessage = null } = input;
  assertProvider(provider);
  const safeErrorCode = normaliseErrorCode(errorCode);
  const safeErrorMessage = normaliseSafeAuditText(errorMessage, 'Run error message');
  await getRunningRun(runId, churchId, provider);
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_runs SET status = 'failed', error_code = ?, error_message = ?,
      counts = '{}', external_watermark = NULL, source_provenance = NULL, review_notification_fingerprint = NULL, completed_at = datetime('now')
      WHERE id = ? AND church_id = ? AND provider = ? AND status = 'running'`,
  [safeErrorCode, safeErrorMessage, runId, churchId, provider]);
  if (result.affectedRows !== 1) throw new Error('Only running runs can be finalized');
  return toRun(await getRunForChurch(runId, churchId, provider));
}

async function setReviewNotificationFingerprint(runId, churchId, provider, fingerprint) {
  assertProvider(provider);
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('Review notification fingerprint must be a lowercase SHA-256 digest');
  }
  const existing = await getRunForChurch(runId, churchId, provider);
  if (!existing) throw new Error('Run is not available for this church and provider');
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_runs
    SET review_notification_fingerprint = ? WHERE id = ? AND church_id = ? AND provider = ?`,
  [fingerprint, runId, churchId, provider]);
  return result.affectedRows > 0;
}

async function findLatestReviewNotificationFingerprint(churchId, provider) {
  assertProvider(provider);
  const rows = await Database.queryForChurch(churchId, `SELECT review_notification_fingerprint
    FROM people_sync_runs WHERE church_id = ? AND provider = ? AND review_notification_fingerprint IS NOT NULL
    ORDER BY id DESC LIMIT 1`, [churchId, provider]);
  return rows[0] ? rows[0].review_notification_fingerprint : null;
}

async function listRecentRuns(churchId, provider, limit = 20) {
  assertProvider(provider);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid recent-runs limit');
  const rows = await Database.queryForChurch(churchId, `SELECT * FROM people_sync_runs
    WHERE church_id = ? AND provider = ? ORDER BY id DESC LIMIT ?`, [churchId, provider, limit]);
  return rows.map(toRun);
}

module.exports = {
  startRun,
  finishRun,
  failRun,
  setReviewNotificationFingerprint,
  findLatestReviewNotificationFingerprint,
  listRecentRuns,
  validateSourceProvenance,
  COUNT_KEYS,
};
